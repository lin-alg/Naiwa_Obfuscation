// SPDX-License-Identifier: GPL-3.0-or-later
import { fitImage, flattenImage, imageSimilarity, presetSimilarity } from './core.mjs';

const PRESETS = [
  { name: '奶蛙', src: './images/static/%E5%A5%B6%E8%9B%99.png' },
  { name: '鼠蛙', src: './images/static/naishu.png' },
  { name: '蛙狗', src: './images/static/naigou.png' },
  { name: '蛙蛋', src: './images/static/naidan.png' },
];
const QUALITIES = [95, 85, 75, 65, 55];
const state = {
  presetIndex: 0,
  presetBitmaps: [],
  presetImages: [],
  source: null,
  encoded: null,
  output: null,
  encoding: false,
  generationVersion: 0,
  exportVersion: 0,
  pendingGeneration: false,
  recoveryBoost: false,
  encodedFile: null,
  restoredDownload: null,
  benchmarkRows: [],
  benchmarkThreshold: 0.5,
  preview: 'compare',
};

const $ = (selector) => document.querySelector(selector);
const canvases = {
  source: $('#source-preview'),
  mosaic: $('#mosaic-preview'),
  target: $('#target-preview'),
  restored: $('#restored-preview'),
  decode: $('#decode-preview'),
};
const workingCanvas = document.createElement('canvas');
let generationTimer;
let exportTimer;

function setCanvas(canvas, pixels, width, height) {
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(pixels, width, height), 0, 0);
}

function canvasPixels(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 3800);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${label}`;
  } else if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
}

function runWorker(action, payload, progress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./engine-worker.mjs', { type: 'module' });
    const id = crypto.randomUUID();
    worker.onmessage = (event) => {
      if (event.data.id !== id) return;
      if (event.data.type === 'progress') {
        progress?.(event.data.progress);
      } else if (event.data.type === 'error') {
        worker.terminate();
        reject(new Error(event.data.message));
      } else {
        worker.terminate();
        resolve(event.data.result);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || '图像处理失败'));
    };
    const transfer = [];
    for (const key of ['source', 'target']) {
      if (ArrayBuffer.isView(payload[key]?.data)) transfer.push(payload[key].data.buffer);
    }
    worker.postMessage({ ...payload, id, action }, transfer);
  });
}

function loadBitmap(blob) {
  return createImageBitmap(blob);
}

function bitmapToCanvas(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
  return canvas;
}

function presetPixels(index) {
  const image = state.presetImages[index];
  return { ...image, data: image.data.slice() };
}

function automaticOptions(source, quality = Number($('#jpg-quality').value), balance = Number($('#balance').value), recoveryBoost = state.recoveryBoost) {
  const width = source?.width ?? 1920;
  const height = source?.height ?? 1200;
  const pixelCount = Math.max(width, 64) * Math.max(height, 64);
  // Keep large inputs within a practical canvas/memory budget. Narrow inputs
  // receive the minimum carrier size mandated by the core planner.
  const desiredScale = balance <= 20 || balance >= 80 ? 3 : 2;
  const scale = Math.max(1, Math.min(desiredScale, Math.floor(Math.sqrt(32000000 / pixelCount))));
  const preferenceStep = balance <= 50 ? 12 + balance * 0.08 : 16 + (balance - 50) * 0.16;
  const compressionStep = quality < 60 ? 28 : quality < 65 ? 24 : 12;
  return {
    tileSize: scale === 1 && pixelCount > 8000000 ? 16 : 8,
    scale,
    step: Math.round(Math.max(preferenceStep, compressionStep, recoveryBoost ? 24 : 0) / 2) * 2,
    fit: 'contain', colorAdapt: true, colorGain: 0.75,
  };
}

function currentOptions(source = state.source) {
  if (!$('#manual-parameters').checked) return automaticOptions(source);
  return { tileSize: Number($('#tile-size').value), scale: Number($('#carrier-scale').value), step: Number($('#strength').value), fit: $('#preset-fit').value, colorAdapt: $('#color-adapt').value === 'yes', colorGain: Number($('#color-gain').value) };
}

function currentThreshold() {
  const input = $('#preset-threshold').value;
  if (!input.trim()) throw new Error('请填写 0 到 1 之间的预设相似度门槛。');
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('相似度门槛应在 0 到 1 之间。');
  return value;
}

function formatBytes(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function invalidateOutput() {
  state.exportVersion += 1;
  clearTimeout(exportTimer);
  state.output = null;
  $('#download-button').disabled = true;
  $('#download-button').removeAttribute('data-bytes');
  $('#output-size').removeAttribute('data-bytes');
  $('#output-size').removeAttribute('data-quality');
  $('#output-size').textContent = state.source ? '正在计算…' : '生成后显示';
  $('#result-strip').classList.remove('is-ready');
}

function requestGeneration(delay = 300) {
  if (!state.source) return;
  state.generationVersion += 1;
  state.pendingGeneration = true;
  invalidateOutput();
  $('#download-png').disabled = true;
  $('#result-summary').textContent = '设置已更新，正在重新生成…';
  clearTimeout(generationTimer);
  if (!state.encoding) generationTimer = setTimeout(encodeCurrentImage, delay);
}

function requestJpegUpdate() {
  invalidateOutput();
  if (state.encoding || state.pendingGeneration || !state.encoded) return;
  $('#restored-score').textContent = '正在更新';
  exportTimer = setTimeout(updateJpegOutput, 180);
}

function syncAdvancedMode() {
  const expanded = $('#advanced-settings').open;
  const manual = $('#manual-parameters').checked;
  $('.advanced-preview').hidden = !expanded;
  $('#preview-grid').classList.toggle('has-target', expanded);
  $('#manual-fields').disabled = !manual;
  $('#balance').disabled = manual;
  $('#balance-hint').textContent = manual
    ? '正在使用高级模式中的手动参数。关闭手动调整后可使用此滑条。'
    : '自动搭配处理参数；生成后调整会自动更新结果。';
}

async function updateJpegOutput() {
  const encoded = state.encoded;
  if (!encoded) return;
  const source = encoded.source;
  const quality = Number($('#jpg-quality').value);
  const request = ++state.exportVersion;
  const current = () => state.exportVersion === request && state.encoded === encoded && state.source === source;
  $('#output-size').textContent = '正在计算…';
  $('#download-button').disabled = true;
  $('#restored-empty').hidden = false;
  $('#restored-empty').textContent = '正在验证最终 JPG 的还原效果…';
  $('#restore-metrics').textContent = '正在验证 JPG 还原…';
  try {
    const blob = await imageBlob(workingCanvas, 'image/jpeg', quality / 100);
    if (!current()) return;
    state.output = { blob, quality, verified: false };
    $('#output-size').textContent = formatBytes(blob.size);
    $('#output-size').dataset.bytes = String(blob.size);
    $('#output-size').dataset.quality = String(quality);
    $('#download-button').dataset.bytes = String(blob.size);
    $('#download-button').disabled = false;
    $('#result-summary').textContent = `JPG ${quality}% · ${formatBytes(blob.size)} · 正在更新预览…`;
    const pixels = await bitmapPixels(blob);
    if (!current()) return;
    const { outputWidth: width, outputHeight: height } = encoded.plan;
    setCanvas(canvases.mosaic, pixels, width, height);
    $('#mosaic-empty').hidden = true;
    $('#result-strip').classList.add('is-ready');
    const fitted = fitImage(state.presetImages[encoded.presetIndex], width, height, encoded.options.fit);
    const resemblance = presetSimilarity(pixels, fitted.data, width, height);
    $('#preset-score').textContent = `最终 JPG 预设轮廓 SSIM ${resemblance.outline.toFixed(4)} · 细节 ${resemblance.detail.toFixed(4)}`;
    try {
      const restored = await runWorker('restore', { source: { width, height, data: pixels } });
      if (!current()) return;
      setCanvas(canvases.restored, restored.data, source.width, source.height);
      const score = imageSimilarity(source.data, restored.data, source.width, source.height);
      $('#restore-metrics').textContent = `JPG 还原 SSIM ${score.toFixed(4)} · 纠正 ${restored.plan.corrected} 字节`;
      $('#restored-empty').hidden = true;
      $('#restored-score').textContent = `来自 JPG ${quality}%`;
      state.output.verified = true;
      $('#result-summary').textContent = `JPG ${quality}% · ${formatBytes(blob.size)} · 还原验证通过`;
    } catch (error) {
      if (!current()) return;
      if (!$('#manual-parameters').checked && !state.recoveryBoost && encoded.plan.step < 24) {
        state.recoveryBoost = true;
        requestGeneration(0);
        return;
      }
      $('#restored-score').textContent = '当前 JPG 未能还原';
      $('#restored-empty').textContent = '可提高 JPG 质量后再次查看还原效果';
      $('#restore-metrics').textContent = error.message;
      $('#result-summary').textContent = `JPG ${quality}% · ${formatBytes(blob.size)} · 当前质量下未能还原，可提高 JPG 质量重试`;
    }
  } catch (error) {
    if (!current()) return;
    state.output = null;
    $('#download-button').disabled = true;
    $('#output-size').textContent = '导出失败';
    $('#result-summary').textContent = 'JPG 导出未完成';
    showToast(error.message, true);
  }
}

function setPreset(index) {
  const changed = state.presetIndex !== index;
  state.presetIndex = index;
  document.querySelectorAll('.preset-option').forEach((button) => {
    const active = Number(button.dataset.index) === index;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
  });
  $('#benchmark-preset').value = String(index);
  if (changed && (state.encoded || state.encoding)) {
    state.recoveryBoost = false;
    requestGeneration();
  }
}

async function initializePresets() {
  const list = $('#preset-list');
  const benchmarkSelect = $('#benchmark-preset');
  state.presetBitmaps = await Promise.all(PRESETS.map(async (preset) => {
    const response = await fetch(preset.src);
    if (!response.ok) throw new Error(`无法加载预设图：${preset.name}`);
    return loadBitmap(await response.blob());
  }));
  state.presetImages = state.presetBitmaps.map((bitmap) => {
    const canvas = bitmapToCanvas(bitmap);
    const image = { width: canvas.width, height: canvas.height, data: canvasPixels(canvas) };
    canvas.width = 0;
    canvas.height = 0;
    return image;
  });

  PRESETS.forEach((preset, index) => {
    const option = document.createElement('button');
    option.className = 'preset-option';
    option.type = 'button';
    option.dataset.index = String(index);
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', 'false');
    option.innerHTML = `<img src="${preset.src}" alt=""><span>${preset.name}</span>`;
    option.addEventListener('click', () => setPreset(index));
    list.append(option);

    const selectOption = document.createElement('option');
    selectOption.value = String(index);
    selectOption.textContent = preset.name;
    benchmarkSelect.append(selectOption);
  });
  setPreset(0);
}

async function loadSource(file) {
  if (!file?.type.startsWith('image/')) throw new Error('请选择有效的图像文件。');
  const bitmap = await loadBitmap(file);
  const canvas = bitmapToCanvas(bitmap);
  const pixels = canvasPixels(canvas);
  const width = canvas.width;
  const height = canvas.height;
  bitmap.close();
  canvas.width = 0;
  canvas.height = 0;
  state.source = { data: new Uint8ClampedArray(pixels), width, height, name: file.name, bytes: file.size };
  state.generationVersion += 1;
  state.pendingGeneration = false;
  state.recoveryBoost = false;
  clearTimeout(generationTimer);
  state.encoded = null;
  invalidateOutput();
  workingCanvas.width = 0;
  workingCanvas.height = 0;
  setCanvas(canvases.source, state.source.data, state.source.width, state.source.height);
  $('#source-empty').hidden = true;
  $('#source-file-name').textContent = file.name;
  $('#source-meta').textContent = `${file.name} · ${state.source.width} × ${state.source.height}`;
  $('#source-dimensions').textContent = `${state.source.width} × ${state.source.height}`;
  $('#encode-button').disabled = $('#encode-button').classList.contains('is-busy');
  $('#download-button').disabled = true;
  $('#download-png').disabled = true;
  $('#mosaic-empty').hidden = false;
  $('#restored-empty').hidden = false;
  $('#mosaic-dimensions').textContent = '等待生成';
  $('#restored-score').textContent = '等待生成';
  $('#output-size').textContent = '生成后显示';
  $('#output-size').removeAttribute('data-bytes');
  $('#output-size').removeAttribute('data-quality');
  $('#preset-score').textContent = '生成后显示预设轮廓与细节 SSIM';
  $('#restore-metrics').textContent = '生成后显示 JPG 还原 SSIM';
  $('#applied-options').textContent = '生成后显示实际采用的参数';
  $('#target-empty').hidden = false;
  $('#result-strip').classList.remove('is-ready');
  $('#result-summary').textContent = '图像已载入';
}

async function imageBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器无法导出图像。')), type, quality);
  });
}

async function downloadCanvas(canvas, filename, type = 'image/png', quality) {
  const blob = await imageBlob(canvas, type, quality);
  downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function encodeCurrentImage() {
  if (!state.source || state.encoding) return;
  clearTimeout(generationTimer);
  state.pendingGeneration = false;
  state.encoding = true;
  const version = ++state.generationVersion;
  const source = state.source;
  const button = $('#encode-button');
  setBusy(button, true, '生成中');
  $('#result-summary').textContent = '正在分析分块特征…';
  try {
    invalidateOutput();
    $('#download-png').disabled = true;
    state.encoded = null;
    $('#result-strip').classList.remove('is-ready');
    $('#preset-score').textContent = '正在生成…';
    const options = currentOptions();
    const presetIndex = state.presetIndex;
    const encoded = await runWorker('encode', {
      source: { width: source.width, height: source.height, data: source.data.slice() },
      target: presetPixels(presetIndex),
      ...options,
    }, ({ label }) => { if (state.generationVersion === version) $('#result-summary').textContent = `${label}…`; });
    if (state.generationVersion !== version || state.source !== source) return;

    state.encoded = { plan: encoded.plan, source, presetIndex, options };
    setCanvas(workingCanvas, encoded.data, encoded.plan.outputWidth, encoded.plan.outputHeight);
    const fitted = fitImage(state.presetImages[presetIndex], encoded.plan.outputWidth, encoded.plan.outputHeight, options.fit);
    setCanvas(canvases.target, fitted.data, fitted.width, fitted.height);
    $('#target-empty').hidden = true;
    $('#mosaic-dimensions').textContent = `${encoded.plan.outputWidth} × ${encoded.plan.outputHeight}`;
    $('#applied-options').textContent = `${$('#manual-parameters').checked ? '手动' : '自动'} · 原图 ${encoded.plan.tileSize}×${encoded.plan.tileSize} px 分块 · ${encoded.plan.scale} 倍载体 · 强度 ${encoded.plan.step} · 细节 ${Math.round(encoded.plan.colorGain * 100)}%${encoded.plan.transparentPixels ? ' · 透明像素已合成白底' : ''}`;
    $('#download-png').disabled = false;
    setPreview('compare');
    await updateJpegOutput();
  } catch (error) {
    if (state.generationVersion !== version) return;
    showToast(error.message, true);
    $('#output-size').textContent = '生成未完成';
    $('#result-summary').textContent = '处理未完成';
  } finally {
    state.encoding = false;
    setBusy(button, false);
    button.disabled = !state.source;
    if (state.pendingGeneration) generationTimer = setTimeout(encodeCurrentImage, 0);
    else if (state.encoded?.source === state.source && !state.output) requestJpegUpdate();
  }
}

async function loadEncodedFile(file) {
  if (!file?.type.startsWith('image/')) throw new Error('请选择有效的图像文件。');
  const bitmap = await loadBitmap(file);
  const canvas = bitmapToCanvas(bitmap);
  const pixels = canvasPixels(canvas);
  const width = canvas.width;
  const height = canvas.height;
  bitmap.close();
  canvas.width = 0;
  canvas.height = 0;
  state.encodedFile = { data: new Uint8ClampedArray(pixels), width, height, name: file.name };
  state.restoredDownload = null;
  $('#download-restored').disabled = true;
  $('#decode-empty').hidden = false;
  $('#decode-dimensions').textContent = '等待解码';
  $('#decode-message').classList.remove('is-success');
  $('#encoded-file-name').textContent = file.name;
  $('#encoded-meta').textContent = `${file.name} · ${width} × ${height}`;
  $('#decode-button').disabled = $('#decode-button').classList.contains('is-busy');
  $('#decode-message').textContent = '图像已载入，等待坐标解码';
}

async function restoreCurrentImage() {
  if (!state.encodedFile) return;
  const input = state.encodedFile;
  const button = $('#decode-button');
  state.restoredDownload = null;
  $('#download-restored').disabled = true;
  $('#decode-empty').hidden = false;
  $('#decode-message').classList.remove('is-success');
  setBusy(button, true, '还原中');
  $('#decode-message').textContent = '读取坐标信息…';
  try {
    const restored = await runWorker('restore', {
      source: { ...input, data: input.data.slice() },
    }, ({ label }) => { if (state.encodedFile === input) $('#decode-message').textContent = `${label}…`; });
    if (state.encodedFile !== input) return;
    state.restoredDownload = restored;
    setCanvas(canvases.decode, restored.data, restored.plan.width, restored.plan.height);
    $('#decode-empty').hidden = true;
    $('#decode-dimensions').textContent = `${restored.plan.width} × ${restored.plan.height}`;
    $('#download-restored').disabled = false;
    $('#decode-message').textContent = `${restored.plan.tileCount.toLocaleString()} 块已拼回 · 坐标验证通过 · 已纠正 ${restored.plan.corrected} 字节 · 恢复原始尺寸`;
    $('#decode-message').classList.add('is-success');
  } catch (error) {
    state.restoredDownload = null;
    $('#download-restored').disabled = true;
    $('#decode-message').textContent = error.message;
    $('#decode-message').classList.remove('is-success');
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
    button.disabled = !state.encodedFile;
  }
}

function setPreview(mode) {
  state.preview = mode;
  document.querySelectorAll('.preview-choice').forEach((button) => button.classList.toggle('is-active', button.dataset.preview === mode));
  $('#preview-grid').dataset.mode = mode;
}

async function bitmapPixels(blob) {
  const bitmap = await loadBitmap(blob);
  const canvas = bitmapToCanvas(bitmap);
  const data = canvasPixels(canvas);
  bitmap.close();
  canvas.width = 0;
  canvas.height = 0;
  return data;
}

function average(values) {
  const present = values.filter((value) => Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

async function runBenchmark() {
  const button = $('#benchmark-button');
  setBusy(button, true, '评测中');
  $('#csv-button').disabled = true;
  state.benchmarkRows = [];
  $('#benchmark-selection').textContent = '整批完成后统一筛选三指标候选';
  drawChart();
  $('#benchmark-results').innerHTML = '<tr><td colspan="10" class="table-empty">整批完成后统一汇总…</td></tr>';
  try {
    const threshold = currentThreshold();
    state.benchmarkThreshold = threshold;
    const options = currentOptions();
    const useAutomatic = !$('#manual-parameters').checked && $('#benchmark-mode').value === 'current';
    const benchmarkQuality = Number($('#jpg-quality').value);
    const benchmarkBalance = Number($('#balance').value);
    const configs = $('#benchmark-mode').value === 'batch'
      ? [2, 3].flatMap((scale) => [8, 16, 24].map((step) => ({ ...options, tileSize: 8, scale, step })))
      : [options];
    configs.forEach((config) => { config.id = useAutomatic ? '自动参数' : `${config.tileSize}px-${config.scale}x-s${config.step}${config.colorAdapt ? `-color${config.colorGain}` : ''}`; });
    const response = await fetch('./test/manifest.json');
    if (!response.ok) throw new Error('无法读取测试图片清单。');
    const manifest = await response.json();
    const count = Number($('#test-count').value);
    const tests = manifest.slice().sort((a, b) => a.width * a.height - b.width * b.height).slice(0, count);
    const presetIndex = Number($('#benchmark-preset').value);
    const accumulators = configs.flatMap((config) => QUALITIES.map((quality) => ({ config: config.id, quality, baseSize: [], baseSSIM: [], mixedSize: [], restoredSSIM: [], decoded: [], presetSSIM: [], presetDetail: [] })));

    for (let imageIndex = 0; imageIndex < tests.length; imageIndex += 1) {
      const entry = tests[imageIndex];
      $('#benchmark-progress').textContent = `读取 ${imageIndex + 1}/${tests.length} · ${entry.name}`;
      const fileResponse = await fetch(`./test/static/${encodeURIComponent(entry.name)}`);
      if (!fileResponse.ok) throw new Error(`无法读取测试图：${entry.name}`);
      const fileBlob = await fileResponse.blob();
      const bitmap = await loadBitmap(fileBlob);
      const originalCanvas = bitmapToCanvas(bitmap);
      bitmap.close();
      const sourceWidth = originalCanvas.width;
      const sourceHeight = originalCanvas.height;
      const originalPixels = flattenImage({ width: sourceWidth, height: sourceHeight, data: canvasPixels(originalCanvas) }).data;
      setCanvas(originalCanvas, originalPixels, sourceWidth, sourceHeight);
      const baseline = new Map();
      for (const quality of QUALITIES) {
        const baselineBlob = await imageBlob(originalCanvas, 'image/jpeg', quality / 100);
        const baselinePixels = await bitmapPixels(baselineBlob);
        baseline.set(quality, { size: baselineBlob.size / fileBlob.size, ssim: imageSimilarity(originalPixels, baselinePixels, sourceWidth, sourceHeight) });
      }
      for (const config of configs) {
        $('#benchmark-progress').textContent = `${imageIndex + 1}/${tests.length} · ${config.id} · 匹配分块`;
        try {
          const encoded = await runWorker('encode', {
            source: { width: sourceWidth, height: sourceHeight, data: originalPixels.slice() },
            target: presetPixels(presetIndex), ...config,
            ...(useAutomatic ? automaticOptions({ width: sourceWidth, height: sourceHeight }, benchmarkQuality, benchmarkBalance, false) : {}),
          });
          const { outputWidth: width, outputHeight: height } = encoded.plan;
          const target = fitImage(state.presetImages[presetIndex], width, height, config.fit);
          const encodedCanvas = document.createElement('canvas');
          setCanvas(encodedCanvas, encoded.data, width, height);
          for (const quality of QUALITIES) {
            $('#benchmark-progress').textContent = `${imageIndex + 1}/${tests.length} · ${config.id} · JPEG ${quality}`;
            const row = accumulators.find((item) => item.config === config.id && item.quality === quality);
            const blob = await imageBlob(encodedCanvas, 'image/jpeg', quality / 100);
            const pixels = await bitmapPixels(blob);
            const resemblance = presetSimilarity(pixels, target.data, width, height);
            row.presetSSIM.push(resemblance.outline);
            row.presetDetail.push(resemblance.detail);
            row.mixedSize.push(blob.size / fileBlob.size);
            row.baseSize.push(baseline.get(quality).size);
            row.baseSSIM.push(baseline.get(quality).ssim);
            try {
              const restored = await runWorker('restore', { source: { width, height, data: pixels } });
              row.restoredSSIM.push(imageSimilarity(originalPixels, restored.data, sourceWidth, sourceHeight));
              row.decoded.push(1);
            } catch { row.restoredSSIM.push(0); row.decoded.push(0); }
          }
          encodedCanvas.width = 0;
          encodedCanvas.height = 0;
        } catch {
          for (const quality of QUALITIES) {
            const row = accumulators.find((item) => item.config === config.id && item.quality === quality);
            // Invalid combinations count as failures, never silently disappear.
            row.presetSSIM.push(0); row.presetDetail.push(0); row.mixedSize.push(0);
            row.restoredSSIM.push(0); row.decoded.push(0);
            row.baseSize.push(baseline.get(quality).size); row.baseSSIM.push(baseline.get(quality).ssim);
          }
        }
      }
      originalCanvas.width = 0;
      originalCanvas.height = 0;
    }

    state.benchmarkRows = accumulators.map((row) => ({
      config: row.config,
      quality: row.quality,
      baseSize: average(row.baseSize),
      baseSSIM: average(row.baseSSIM),
      mixedSize: average(row.mixedSize),
      restoredSSIM: average(row.restoredSSIM),
      decoded: average(row.decoded),
      presetSSIM: average(row.presetSSIM),
      minPresetSSIM: Math.min(...row.presetSSIM),
      presetDetail: average(row.presetDetail),
      eligible: row.decoded.every((value) => value === 1) && row.presetSSIM.every((value) => value >= threshold),
    }));
    for (const row of state.benchmarkRows) row.pareto = row.eligible && !state.benchmarkRows.some((other) => other.eligible && other.mixedSize <= row.mixedSize && other.restoredSSIM >= row.restoredSSIM && other.minPresetSSIM >= row.minPresetSSIM && (other.mixedSize < row.mixedSize || other.restoredSSIM > row.restoredSSIM || other.minPresetSSIM > row.minPresetSSIM));
    renderBenchmark();
    $('#csv-button').disabled = false;
    $('#benchmark-progress').textContent = `评测完成 · ${configs.length} 组参数 × ${tests.length} 张图 × ${QUALITIES.length} 档 JPEG · 轮廓门槛 ${threshold.toFixed(2)} · ${options.fit}`;
    const candidates = state.benchmarkRows.filter((row) => row.pareto);
    $('#benchmark-selection').textContent = candidates.length ? `三指标 Pareto 候选：${candidates.map((row) => `${row.config} / Q${row.quality}`).join('、')}` : '当前样本与门槛下没有同时满足预设相似度和全部恢复成功的候选。';
  } catch (error) {
    $('#benchmark-progress').textContent = error.message;
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

function renderBenchmark() {
  const tbody = $('#benchmark-results');
  tbody.replaceChildren();
  for (const row of state.benchmarkRows) {
    const tr = document.createElement('tr');
    const values = [
      row.config,
      `${row.quality}%`,
      `${(row.mixedSize * 100).toFixed(1)}%`,
      row.restoredSSIM.toFixed(4),
      `${row.presetSSIM.toFixed(4)} / ${row.minPresetSSIM.toFixed(4)}`,
      row.presetDetail.toFixed(4),
      `${(row.decoded * 100).toFixed(0)}%`,
      `${(row.baseSize * 100).toFixed(1)}%`,
      row.baseSSIM.toFixed(4),
      row.pareto ? 'Pareto 候选' : row.eligible ? '达标' : '未达标',
    ];
    values.forEach((value, index) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (index === 6) td.className = row.decoded === 1 ? 'value-good' : 'value-bad';
      if (index === 9) td.className = row.eligible ? 'value-good' : 'value-bad';
      tr.append(td);
    });
    tbody.append(tr);
  }
  drawChart();
}

function drawChart() {
  const palette = ['#47753e', '#3269a8', '#bf5e42', '#8657a3', '#b0811d', '#267f84', '#b44879', '#57618f', '#6b7853'];
  const configs = [...new Set(state.benchmarkRows.map((row) => row.config))];
  $('#chart-legend').replaceChildren();
  configs.forEach((config, index) => {
    const label = document.createElement('span');
    label.textContent = config;
    label.style.color = palette[index % palette.length];
    $('#chart-legend').append(label);
  });
  const baselineLabel = document.createElement('span');
  baselineLabel.textContent = '黑线：原图直压 · 实心点达标 / 空心点未达标';
  $('#chart-legend').append(baselineLabel);
  drawMetricChart($('#benchmark-chart'), 'restoredSSIM', palette, configs);
  drawMetricChart($('#preset-chart'), 'minPresetSSIM', palette, configs);
}

function drawMetricChart(canvas, metric, palette, configs) {
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
  canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
  const context = canvas.getContext('2d');
  context.scale(pixelRatio, pixelRatio);
  const width = bounds.width;
  const height = bounds.height;
  const left = 52;
  const right = 18;
  const top = 18;
  const bottom = 40;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  context.clearRect(0, 0, width, height);

  if (!state.benchmarkRows.length) {
    context.fillStyle = '#758078';
    context.font = '13px sans-serif';
    context.fillText('运行评测后绘制曲线', left, top + 20);
    return;
  }

  const xMax = Math.max(1, ...state.benchmarkRows.map((row) => Math.max(row.baseSize, row.mixedSize))) * 1.08;
  const yMin = 0;
  const yRange = Math.max(0.05, 1 - yMin);
  const x = (value) => left + (value / xMax) * plotWidth;
  const y = (value) => top + ((1 - value) / yRange) * plotHeight;
  context.font = '11px sans-serif';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.strokeStyle = '#e2e7e2';
  context.fillStyle = '#77817a';

  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4;
    const value = yMin + yRange * ratio;
    const py = top + plotHeight * (1 - ratio);
    context.beginPath();
    context.moveTo(left, py);
    context.lineTo(width - right, py);
    context.stroke();
    context.fillText(value.toFixed(2), left - 8, py);
  }
  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (let i = 0; i <= 4; i += 1) {
    const value = (xMax * i) / 4;
    const px = x(value);
    context.beginPath();
    context.moveTo(px, top + plotHeight);
    context.lineTo(px, top + plotHeight + 4);
    context.stroke();
    context.fillText(`${(value * 100).toFixed(0)}%`, px, top + plotHeight + 8);
  }
  context.fillStyle = '#69736b';
  context.fillText('压缩体积 / 原文件', left + plotWidth / 2, height - 12);

  if (metric === 'minPresetSSIM') {
    context.strokeStyle = '#b35135';
    context.setLineDash([5, 4]);
    context.beginPath(); context.moveTo(left, y(state.benchmarkThreshold)); context.lineTo(width - right, y(state.benchmarkThreshold)); context.stroke();
    context.setLineDash([]);
  }
  const drawLine = (rows, sizeKey, scoreKey, color, baseline = false) => {
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    rows.forEach((row, index) => {
      const px = x(row[sizeKey]);
      const py = y(row[scoreKey]);
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.stroke();
    rows.forEach((row) => {
      context.fillStyle = row.eligible || baseline ? color : '#fff';
      context.beginPath();
      context.arc(x(row[sizeKey]), y(row[scoreKey]), row.pareto ? 5 : 3.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    });
  };
  configs.forEach((config, index) => drawLine(state.benchmarkRows.filter((row) => row.config === config), 'mixedSize', metric, palette[index % palette.length]));
  if (metric === 'restoredSSIM') drawLine(state.benchmarkRows.filter((row) => row.config === configs[0]), 'baseSize', 'baseSSIM', '#252c28', true);
}

function exportCsv() {
  if (!state.benchmarkRows.length) return;
  const lines = [
    `# threshold=${state.benchmarkThreshold}; preset_rgb_ssim_area64; detail_rgb_ssim_area512; restored_luma_ssim_area512; white_matte`,
    'config,quality,mixed_size_ratio,restored_ssim,preset_ssim,min_preset_ssim,preset_detail,coordinate_decode_rate,original_size_ratio,original_ssim,eligible,pareto',
    ...state.benchmarkRows.map((row) => [row.config, row.quality, row.mixedSize, row.restoredSSIM, row.presetSSIM, row.minPresetSSIM, row.presetDetail, row.decoded, row.baseSize, row.baseSSIM, row.eligible, row.pareto].join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'naiwa-jpeg-ssim.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function setView(view) {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  document.querySelectorAll('.view').forEach((section) => {
    const active = section.id === `${view}-view`;
    section.hidden = !active;
    section.classList.toggle('is-visible', active);
  });
  if (view === 'benchmark') requestAnimationFrame(drawChart);
}

$('#source-picker').addEventListener('click', () => $('#source-file').click());
$('#source-file').addEventListener('change', async (event) => {
  try { await loadSource(event.target.files[0]); }
  catch (error) { showToast(error.message, true); }
});
$('#source-file').addEventListener('dragover', (event) => event.preventDefault());
$('#source-picker').addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('is-dragging'); });
$('#source-picker').addEventListener('dragleave', (event) => event.currentTarget.classList.remove('is-dragging'));
$('#source-picker').addEventListener('drop', async (event) => {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragging');
  try { await loadSource(event.dataTransfer.files[0]); }
  catch (error) { showToast(error.message, true); }
});
$('#encode-button').addEventListener('click', encodeCurrentImage);
$('#download-button').addEventListener('click', () => {
  if (state.output && !$('#download-button').disabled) downloadBlob(state.output.blob, `naiwa-obfuscated-q${state.output.quality}.jpg`);
});
$('#download-png').addEventListener('click', () => {
  if (state.encoded && !$('#download-png').disabled) downloadCanvas(workingCanvas, 'naiwa-obfuscated.png');
});
$('#strength').addEventListener('input', (event) => { $('#strength-value').value = event.target.value; });
$('#jpg-quality').addEventListener('input', (event) => {
  $('#jpg-quality-value').value = `${event.target.value}%`;
  if (state.recoveryBoost && Number(event.target.value) >= 65 && !$('#manual-parameters').checked) {
    state.recoveryBoost = false;
    if (state.encoded || state.encoding) requestGeneration();
    return;
  }
  if (state.encoded || state.encoding) requestJpegUpdate();
});
$('#balance').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  $('#balance-value').value = value < 35 ? '还原画质优先' : value > 65 ? '抗压鲁棒优先' : '均衡';
  state.recoveryBoost = false;
  if (!$('#manual-parameters').checked && (state.encoded || state.encoding)) requestGeneration();
});
$('#manual-parameters').addEventListener('change', () => {
  syncAdvancedMode();
  state.recoveryBoost = false;
  if (state.encoded || state.encoding) requestGeneration();
});
$('#advanced-settings').addEventListener('toggle', syncAdvancedMode);
for (const selector of ['#tile-size', '#carrier-scale', '#color-adapt', '#color-gain', '#preset-fit', '#strength']) {
  $(selector).addEventListener('input', () => {
    state.recoveryBoost = false;
    if ($('#manual-parameters').checked && (state.encoded || state.encoding)) requestGeneration();
  });
}
document.querySelectorAll('.preview-choice').forEach((button) => button.addEventListener('click', () => setPreview(button.dataset.preview)));
$('#encoded-picker').addEventListener('click', () => $('#encoded-file').click());
$('#encoded-file').addEventListener('change', async (event) => {
  try { await loadEncodedFile(event.target.files[0]); }
  catch (error) { showToast(error.message, true); }
});
$('#decode-button').addEventListener('click', restoreCurrentImage);
$('#download-restored').addEventListener('click', () => {
  if (!state.restoredDownload) return;
  setCanvas(canvases.decode, state.restoredDownload.data, state.restoredDownload.plan.width, state.restoredDownload.plan.height);
  downloadCanvas(canvases.decode, 'naiwa-restored.png');
});
$('#benchmark-button').addEventListener('click', runBenchmark);
$('#csv-button').addEventListener('click', exportCsv);
$('#benchmark-preset').addEventListener('change', (event) => setPreset(Number(event.target.value)));
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
window.addEventListener('resize', () => { if (!$('#benchmark-view').hidden) drawChart(); });
if ('ResizeObserver' in window) new ResizeObserver(() => { if (!$('#benchmark-view').hidden) drawChart(); }).observe($('#chart-panel') ?? $('.chart-panel'));

initializePresets().catch((error) => showToast(error.message, true));
