// SPDX-License-Identifier: GPL-3.0-or-later
import { createPlan } from './core.mjs';
import { sourceSizing } from './image-sizing.mjs';
import { listPresets, savePreset, deletePreset, selectedPreset } from './preset-store.mjs';

const PRESETS = [
  { name: '奶蛙', src: './images/static/%E5%A5%B6%E8%9B%99.png' },
  { name: '鼠蛙', src: './images/static/naishu.png' },
  { name: '蛙狗', src: './images/static/naigou.png' },
  { name: '蛙蛋', src: './images/static/naidan.png' },
];
const state = {
  presetIndex: 0,
  presetKey: null,
  presetBitmaps: [],
  presetImages: [],
  source: null,
  original: null,
  sourceRequest: 0,
  encoded: null,
  output: null,
  encoding: false,
  generationVersion: 0,
  exportVersion: 0,
  pendingGeneration: false,
  recoveryBoost: false,
  encodedFile: null,
  restoredDownload: null,
  preview: 'compare',
  hasPreview: false,
  activePreviewViewport: null,
  zoomByViewport: new WeakMap(),
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
  requestAnimationFrame(() => applyPreviewZoom(canvas.closest('.canvas-viewport')));
}

function canvasPixels(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function showToast(message, isError = false, action) {
  const toast = $('#toast');
  toast.textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'toast-action'; button.textContent = action.label;
    button.addEventListener('click', async () => {
      button.disabled = true; clearTimeout(showToast.timer);
      try { await action.run(); toast.classList.remove('is-visible'); }
      catch (error) { showToast(error.message, true); }
    });
    toast.append(button);
  }
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), action ? 8000 : 3800);
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
    for (const key of ['source', 'target', 'original']) {
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

function carrierScaleForTile(tileSize) {
  return Math.max(1, Math.min(8, Math.round((16 / tileSize) * 2) / 2));
}

function currentCarrierScale() {
  return $('#auto-carrier').checked
    ? carrierScaleForTile(Number($('#tile-size').value))
    : Number($('#carrier-scale').value);
}

function syncCarrierControls() {
  const automatic = $('#auto-carrier').checked;
  const tileSize = Number($('#tile-size').value);
  const scale = carrierScaleForTile(tileSize);
  if (automatic) $('#carrier-scale').value = String(scale);
  $('#carrier-scale').disabled = automatic;
  $('#tile-size-hint').textContent = automatic
    ? `${tileSize} px 分块 · 自动匹配 ${scale} 倍载体；分块越细，倍率越高、输出也越大。`
    : `${tileSize} px 分块 · 手动使用 ${Number($('#carrier-scale').value)} 倍载体；分块越细，预设轮廓越细。`;
  $('#tile-size-value').value = `${tileSize} px · ${scale}×`;
  $('#carrier-scale-hint').textContent = automatic
    ? `当前 ${tileSize} px 分块自动配 ${scale} 倍载体。分块越细，载体越大；高倍率会增加输出尺寸。`
    : '自动配对已关闭，可手动选择 1–8 倍。细分块搭配低倍率可能无法容纳坐标；高倍率会增加输出尺寸并可能缩小处理原图。';
}

function automaticOptions(quality = Number($('#jpg-quality').value), balance = Number($('#balance').value), recoveryBoost = state.recoveryBoost) {
  const preference = Math.max(0, Math.min(100, balance)) / 100;
  const preferenceStep = 16 + Math.max(0, preference - 0.5) * 8;
  const compressionStep = quality < 60 ? 28 : quality < 65 ? 24 : 12;
  const colorGain = preference < 0.4 ? 1 : preference < 0.65 ? 0.75 : preference < 0.875 ? 0.5 : 0.25;
  return {
    tileSize: Number($('#tile-size').value),
    scale: currentCarrierScale(),
    step: Math.round(Math.max(preferenceStep, compressionStep, recoveryBoost ? 24 : 0) / 2) * 2,
    fit: 'contain', colorAdapt: true,
    colorGain,
  };
}

function currentOptions() {
  const options = automaticOptions();
  if (!$('#manual-parameters').checked) return options;
  return { ...options, step: Number($('#strength').value), fit: $('#preset-fit').value, colorAdapt: $('#color-adapt').value === 'yes', colorGain: Number($('#color-gain').value) };
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
  $('#result-strip').dataset.status = 'pending';
  syncWorkflow();
}

function syncWorkflow() {
  if (!$('#encode-button').classList.contains('is-busy')) $('#encode-button').textContent = state.encoded ? '重新生成混淆图' : '生成混淆图';
}

function syncDesktopLayout() {
  const showPreview = state.hasPreview && $('#encode-view').classList.contains('is-visible');
  document.body.classList.toggle('has-preview', showPreview);
  document.documentElement.classList.toggle('has-preview', showPreview);
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
  syncCarrierControls();
  $('#advanced-mode-label').textContent = manual ? '手动算法参数' : '尺寸与自动配对';
  $('#balance-hint').textContent = manual
    ? '手动算法参数已接管细节保留和水印强度；关闭后由此滑条自动决定。'
    : '左侧保留更多原图细节；向右会逐级加强预设适配，同时提高水印强度。';
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
  $('#result-strip').dataset.status = 'checking';
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
    syncWorkflow();
    $('#result-summary').textContent = '正在验证 JPG 预览…';
    const pixels = await bitmapPixels(blob);
    if (!current()) return;
    const { outputWidth: width, outputHeight: height } = encoded.plan;
    setCanvas(canvases.mosaic, pixels, width, height);
    $('#mosaic-empty').hidden = true;
    $('#result-strip').classList.add('is-ready');
    try {
      const verification = await runWorker('verify', {
        source: { width, height, data: pixels },
        target: { width, height, data: canvasPixels(canvases.target) },
        original: { width: source.width, height: source.height, data: source.data.slice() },
      });
      if (!current()) return;
      const resemblance = verification.preset;
      $('#preset-score').textContent = `最终 JPG 预设轮廓 SSIM ${resemblance.outline.toFixed(4)} · 细节 ${resemblance.detail.toFixed(4)}`;
      const restored = verification.restored;
      setCanvas(canvases.restored, restored.data, source.width, source.height);
      $('#restore-metrics').textContent = `JPG 还原 SSIM ${verification.restoredSSIM.toFixed(4)} · 纠正 ${restored.plan.corrected} 字节`;
      $('#restored-empty').hidden = true;
      $('#restored-score').textContent = `来自 JPG ${quality}%`;
      state.output.verified = true;
      $('#result-strip').dataset.status = 'ready';
      $('#result-summary').textContent = `还原验证通过 · JPG ${quality}%`;
    } catch (error) {
      if (!current()) return;
      if (!$('#manual-parameters').checked && !state.recoveryBoost && encoded.plan.step < 24) {
        state.recoveryBoost = true;
        requestGeneration(0);
        return;
      }
      $('#restored-score').textContent = '当前 JPG 未能还原';
      $('#result-strip').dataset.status = 'warning';
      $('#restored-empty').textContent = '可提高 JPG 质量后再次查看还原效果';
      $('#restore-metrics').textContent = error.message;
      $('#result-summary').textContent = '当前 JPG 未能还原，可提高质量后重试';
    }
  } catch (error) {
    if (!current()) return;
    state.output = null;
    $('#download-button').disabled = true;
    $('#output-size').textContent = '导出失败';
    $('#result-strip').dataset.status = 'error';
    $('#result-summary').textContent = 'JPG 导出未完成';
    showToast(error.message, true);
  }
}

function setPreset(index) {
  const preset = PRESETS[index];
  const key = preset.id ?? preset.src;
  const changed = state.presetKey !== key;
  state.presetIndex = index;
  state.presetKey = key;
  selectedPreset(key);
  document.querySelectorAll('.preset-option').forEach((button) => {
    const active = Number(button.dataset.index) === index;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const image = state.presetImages[index];
  $('#custom-preset-hint').textContent = preset.filename
    ? `${preset.saved ? '已保存在此浏览器' : '仅本次可用'} · ${image.width} × ${image.height}`
    : '自定义预设会自动保存在此浏览器，下次直接选择。';
  $('#selected-preset-name').textContent = preset.name;
  if (changed && (state.encoded || state.encoding)) {
    state.recoveryBoost = false;
    requestGeneration();
  }
}

async function initializePresets() {
  const lastSelected = selectedPreset();
  state.presetBitmaps = await Promise.all(PRESETS.map(async (preset) => {
    const response = await fetch(preset.src);
    if (!response.ok) throw new Error(`无法加载预设图：${preset.name}`);
    return loadBitmap(await response.blob());
  }));
  state.presetImages = state.presetBitmaps.map((bitmap) => {
    const canvas = bitmapToCanvas(bitmap);
    const image = { width: canvas.width, height: canvas.height, data: canvasPixels(canvas) };
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
    return image;
  });

  try {
    for (const record of await listPresets()) {
      const bitmap = await loadBitmap(record.blob);
      const canvas = bitmapToCanvas(bitmap); bitmap.close();
      PRESETS.push({ id: record.id, name: record.name, filename: record.filename, src: URL.createObjectURL(record.blob), saved: true, record });
      state.presetImages.push({ width: canvas.width, height: canvas.height, data: canvasPixels(canvas) });
      canvas.width = canvas.height = 0;
    }
  } catch { showToast('浏览器本地存储暂不可用，自定义预设仍可在本次使用。'); }
  const selected = PRESETS.findIndex(preset => (preset.id ?? preset.src) === lastSelected);
  renderPresets(selected < 0 ? 0 : selected);
  $('#custom-preset-picker').disabled = false;
}

function renderPresets(index = state.presetIndex) {
  $('#preset-list').replaceChildren();
  PRESETS.forEach((preset, i) => appendPreset(preset, i));
  setPreset(index);
}

function appendPreset(preset, index, list = $('#preset-list')) {
  const card = document.createElement('div');
  card.className = 'preset-card';
  const option = document.createElement('button');
  option.className = 'preset-option';
  option.type = 'button';
  option.dataset.index = String(index);
  option.setAttribute('role', 'radio');
  option.setAttribute('aria-checked', 'false');
  option.setAttribute('aria-label', `${preset.name}${preset.filename ? preset.saved ? '，已保存的自定义预设' : '，本次自定义预设' : ''}`);
  const thumbnail = document.createElement('img');
  thumbnail.src = preset.src;
  thumbnail.alt = '';
  const label = document.createElement('span');
  label.textContent = preset.name;
  option.title = preset.name;
  option.append(thumbnail, label);
  option.addEventListener('click', () => setPreset(index));
  card.append(option);
  if (preset.filename) {
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'preset-remove'; remove.textContent = '×';
    remove.title = `删除 ${preset.name}`; remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await removeCustomPreset(preset); }
      catch (error) { remove.disabled = false; showToast(`未能删除预设：${error.message}`, true); }
    });
    card.append(remove);
  }
  list.append(card);

}

async function removeCustomPreset(preset) {
  if (preset.saved) await deletePreset(preset.id);
  const index = PRESETS.indexOf(preset);
  if (index < 0) return;
  const wasSelected = state.presetKey === preset.id;
  const active = PRESETS[state.presetIndex];
  const [image] = state.presetImages.splice(index, 1);
  PRESETS.splice(index, 1);
  renderPresets(wasSelected ? 0 : PRESETS.indexOf(active));
  URL.revokeObjectURL(preset.src);
  showToast(`已删除「${preset.name}」`, false, { label: '撤销', run: async () => {
    if (preset.saved) await savePreset(preset.record);
    if (PRESETS.some(item => item.id === preset.id)) return;
    preset.src = URL.createObjectURL(preset.record.blob);
    PRESETS.push(preset); state.presetImages.push(image);
    renderPresets(wasSelected ? PRESETS.length - 1 : state.presetIndex);
  } });
}

async function loadCustomPreset(file) {
  if (!file?.type.startsWith('image/')) throw new Error('请选择有效的预设图片。');
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const image = { width: canvas.width, height: canvas.height, data: canvasPixels(canvas) };
  const blob = await imageBlob(canvas);
  canvas.width = canvas.height = 0;
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const existing = PRESETS.findIndex(preset => preset.id === id);
  if (existing >= 0) { setPreset(existing); showToast('这张图片已经在你的预设中。'); return; }
  const record = { id, name: file.name.replace(/\.[^.]+$/, '') || '自定义预设', filename: file.name, blob, createdAt: Date.now() };
  let saved = true;
  try { await savePreset(record); }
  catch { saved = false; showToast('本地保存未成功，这张预设仍可在本次使用。', true); }
  const preset = { id, name: record.name, filename: file.name, src: URL.createObjectURL(blob), saved, record };
  const index = PRESETS.length;
  PRESETS.push(preset);
  state.presetImages.push(image);
  appendPreset(preset, index);
  setPreset(index);
}

async function loadSource(file) {
  if (!file?.type.startsWith('image/')) throw new Error('请选择有效的图像文件。');
  const request = ++state.sourceRequest;
  const bitmap = await loadBitmap(file);
  if (request !== state.sourceRequest) { bitmap.close(); return; }
  const previous = state.original;
  state.original = { bitmap, width: bitmap.width, height: bitmap.height, name: file.name, bytes: file.size };
  try { prepareSource(true); }
  catch (error) { state.original = previous; bitmap.close(); throw error; }
  previous?.bitmap.close();
}

function prepareSource(resetPreview = false) {
  const original = state.original;
  if (!original) return;
  const carrierScale = currentCarrierScale();
  const size = sourceSizing(original.width, original.height, $('#auto-resize').checked ? null : Number($('#source-scale').value), Math.min(16000000, 31000000 / carrierScale ** 2));
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high';
  context.drawImage(original.bitmap, 0, 0, size.width, size.height);
  const pixels = canvasPixels(canvas);
  const width = canvas.width;
  const height = canvas.height;
  canvas.width = 0;
  canvas.height = 0;
  state.source = { data: new Uint8ClampedArray(pixels), width, height, name: original.name, bytes: original.bytes };
  document.body.classList.add('has-source');
  state.generationVersion += 1;
  state.pendingGeneration = false;
  state.recoveryBoost = false;
  clearTimeout(generationTimer);
  state.encoded = null;
  invalidateOutput();
  if (resetPreview) {
    state.hasPreview = false;
    $('#preview-area').hidden = true;
    state.zoomByViewport = new WeakMap();
    state.activePreviewViewport = null;
    syncDesktopLayout();
  }
  workingCanvas.width = 0;
  workingCanvas.height = 0;
  setCanvas(canvases.source, state.source.data, state.source.width, state.source.height);
  $('#source-empty').hidden = true;
  $('#source-file-name').textContent = original.name;
  $('#source-meta').textContent = `${original.name} · 上传 ${original.width} × ${original.height} → 处理 ${width} × ${height}`;
  $('#source-dimensions').textContent = `${state.source.width} × ${state.source.height}`;
  $('#source-sizing-summary').textContent = `${original.width} × ${original.height} → ${width} × ${height} px${size.scale === 1 ? ' · 保持尺寸' : size.scale > 1 ? ' · 已放大' : ' · 已缩小'}`;
  $('#source-meta').title = $('#source-meta').textContent;
  $('#source-scale-value').value = `${size.automatic ? '自动 ' : ''}${(size.scale * 100).toFixed(1)}%`;
  if (size.automatic) $('#source-scale').value = (size.scale * 100).toFixed(1);
  $('#source-size-hint').textContent = `上传 ${original.width} × ${original.height} → 处理及还原 ${width} × ${height}。${size.automatic ? '短边目标 1024、长边上限 2960 px，长图及大倍率优先限制输出像素量。' : '使用手动比例，保留原图长宽比。'}`;
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
  syncWorkflow();
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
  const revealPreview = !state.hasPreview;
  const button = $('#encode-button');
  setBusy(button, true, '生成中');
  $('#result-summary').textContent = '正在分析分块特征…';
  try {
    invalidateOutput();
    $('#download-png').disabled = true;
    state.encoded = null;
    $('#result-strip').classList.remove('is-ready');
    $('#preset-score').textContent = '正在生成…';
    $('#mosaic-empty').hidden = false;
    $('#mosaic-empty').textContent = '正在生成混淆图…';
    const options = currentOptions();
    const plan = createPlan(source.width, source.height, options);
    if (plan.outputWidth * plan.outputHeight > 32000000 || Math.max(plan.outputWidth, plan.outputHeight) > 16384) {
      throw new Error('混淆载体过大，请降低原图缩放比例或载体倍率（最多 3200 万像素、单边 16384 px）。');
    }
    const presetIndex = state.presetIndex;
    const presetImage = state.presetImages[presetIndex];
    const encoded = await runWorker('encode', {
      source: { width: source.width, height: source.height, data: source.data.slice() },
      target: presetPixels(presetIndex),
      ...options,
    }, ({ label }) => { if (state.generationVersion === version) $('#result-summary').textContent = `${label}…`; });
    if (state.generationVersion !== version || state.source !== source) return;

    state.encoded = { plan: encoded.plan, source, options };
    state.hasPreview = true;
    $('#preview-area').hidden = false;
    syncDesktopLayout();
    setCanvas(workingCanvas, encoded.data, encoded.plan.outputWidth, encoded.plan.outputHeight);
    setCanvas(canvases.target, encoded.targetImage.data, encoded.targetImage.width, encoded.targetImage.height);
    encoded.targetImage.data = null;
    $('#target-empty').hidden = true;
    $('#mosaic-dimensions').textContent = `${encoded.plan.outputWidth} × ${encoded.plan.outputHeight}`;
    $('#applied-options').textContent = `${$('#manual-parameters').checked ? '手动' : '自动'} · 处理图 ${encoded.plan.tileSize}×${encoded.plan.tileSize} px 分块 · ${encoded.plan.scale} 倍载体 · ${encoded.plan.panels} 段 · 坐标 ${encoded.plan.coordinateBits} bit/块 · 强度 ${encoded.plan.step} · 细节 ${Math.round(encoded.plan.colorGain * 100)}%${encoded.plan.transparentPixels ? ' · 原图透明像素已合成白底' : ''}`;
    $('#download-png').disabled = false;
    setPreview('compare');
    if (revealPreview) requestAnimationFrame(() => $('#preview-area').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
    await updateJpegOutput();
  } catch (error) {
    if (state.generationVersion !== version) return;
    showToast(error.message, true);
    $('#output-size').textContent = '生成未完成';
    $('#result-summary').textContent = '处理未完成';
    $('#mosaic-empty').textContent = '生成未完成，可调整设置后重试';
    $('#result-strip').dataset.status = 'error';
  } finally {
    state.encoding = false;
    setBusy(button, false);
    button.disabled = !state.source;
    syncWorkflow();
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
    $('#decode-message').textContent = `${restored.plan.tileCount.toLocaleString()} 块已拼回 · 坐标验证通过 · ${restored.plan.panels} 段自动拼接 · 已纠正 ${restored.plan.corrected} 字节 · 恢复处理尺寸`;
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
  state.activePreviewViewport = $(`[data-panel="${mode === 'restored' ? 'restored' : 'mosaic'}"] .canvas-viewport`);
  requestAnimationFrame(() => applyPreviewZoom());
}

function visiblePreviewPanels() {
  return [...document.querySelectorAll('.preview-panel')].filter((panel) => panel.getClientRects().length > 0 && !panel.hidden && getComputedStyle(panel).display !== 'none');
}

function previewFitScale(panel) {
  const canvas = panel.querySelector('canvas');
  const viewport = panel.querySelector('.canvas-viewport');
  if (!canvas?.width || !canvas?.height || !viewport?.clientWidth || !viewport?.clientHeight) return 1;
  return Math.min(viewport.clientWidth / canvas.width, viewport.clientHeight / canvas.height);
}

function zoomState(viewport) {
  if (!viewport) return { factor: null };
  let value = state.zoomByViewport.get(viewport);
  if (!value) { value = { factor: null }; state.zoomByViewport.set(viewport, value); }
  return value;
}

function modeViewport(mode = state.preview) {
  const panel = mode === 'restored' ? 'restored' : 'mosaic';
  return $(`#preview-grid [data-panel="${panel}"] .canvas-viewport`);
}

function writeZoomReadout(viewport) {
  if (!viewport) return;
  const factor = zoomState(viewport).factor ?? previewFitScale(viewport.closest('.preview-panel'));
  const text = `${Math.round(factor * 100)}%`;
  const output = viewport.closest('.decode-preview') ? $('#decode-zoom-value') : $('#zoom-value');
  if (output) output.textContent = text;
}

function captureZoomAnchor(viewport, clientX, clientY) {
  const canvas = viewport?.querySelector('canvas');
  if (!canvas?.width || !canvas?.height) return null;
  const view = viewport.getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.width;
  const x = Math.max(0, Math.min(viewport.clientWidth, clientX - view.left));
  const y = Math.max(0, Math.min(viewport.clientHeight, clientY - view.top));
  return {
    viewport, canvas, x, y,
    imageX: Math.max(0, Math.min(canvas.width, (x - (rect.left - view.left)) / scale)),
    imageY: Math.max(0, Math.min(canvas.height, (y - (rect.top - view.top)) / scale)),
  };
}

function applyPreviewZoom(targetViewport = null, anchor = null) {
  const panels = targetViewport
    ? [targetViewport.closest('.preview-panel')].filter(Boolean)
    : visiblePreviewPanels();
  for (const panel of panels) {
    const canvas = panel.querySelector('canvas');
    const viewport = panel.querySelector('.canvas-viewport');
    const stage = panel.querySelector('.canvas-stage');
    if (!canvas?.width || !canvas?.height || !viewport || !stage) continue;
    const scale = zoomState(viewport).factor ?? previewFitScale(panel);
    const width = Math.max(1, canvas.width * scale);
    const height = Math.max(1, canvas.height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    stage.style.width = `${Math.max(viewport.clientWidth, width)}px`;
    stage.style.height = `${Math.max(viewport.clientHeight, height)}px`;
  }
  if (anchor) {
    const { viewport, canvas, x, y, imageX, imageY } = anchor;
    const view = viewport.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    const contentLeft = rect.left - view.left + viewport.scrollLeft;
    const contentTop = rect.top - view.top + viewport.scrollTop;
    const scale = rect.width / canvas.width;
    viewport.scrollLeft = contentLeft + imageX * scale - x;
    viewport.scrollTop = contentTop + imageY * scale - y;
  }
  if (targetViewport) writeZoomReadout(targetViewport);
  else {
    const active = state.activePreviewViewport?.getClientRects().length ? state.activePreviewViewport : modeViewport();
    if (active?.getClientRects().length) writeZoomReadout(active);
    const decoded = $('#decode-preview').closest('.canvas-viewport');
    if (decoded.getClientRects().length) writeZoomReadout(decoded);
  }
}

function changePreviewZoom(direction, viewport = null, clientX, clientY) {
  const target = viewport ?? (state.activePreviewViewport?.getClientRects().length ? state.activePreviewViewport : modeViewport());
  const panel = target?.closest('.preview-panel');
  if (!panel || !target?.clientWidth || !target?.clientHeight) return;
  if (!target.closest('.decode-preview')) state.activePreviewViewport = target;
  const current = zoomState(target).factor ?? previewFitScale(panel);
  const anchor = captureZoomAnchor(target,
    clientX ?? target.getBoundingClientRect().left + target.clientWidth / 2,
    clientY ?? target.getBoundingClientRect().top + target.clientHeight / 2);
  zoomState(target).factor = Math.max(0.02, Math.min(8, current * (direction > 0 ? 1.15 : 1 / 1.15)));
  applyPreviewZoom(target, anchor);
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

function setView(view) {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  document.querySelectorAll('.view').forEach((section) => {
    const active = section.id === `${view}-view`;
    section.hidden = !active;
    section.classList.toggle('is-visible', active);
  });
  syncDesktopLayout();
  requestAnimationFrame(() => applyPreviewZoom());
}

$('#source-picker').addEventListener('click', () => $('#source-file').click());
$('#source-file').addEventListener('change', async (event) => {
  try { if (event.target.files[0]) await loadSource(event.target.files[0]); }
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
$('#encode-button').addEventListener('click', async () => {
  await encodeCurrentImage();
});
$('#custom-preset-picker').addEventListener('click', () => $('#custom-preset-file').click());
$('#custom-preset-file').addEventListener('change', async (event) => {
  try { if (event.target.files[0]) await loadCustomPreset(event.target.files[0]); }
  catch (error) { showToast(error.message, true); }
  event.target.value = '';
});
function resizeSource() {
  const regenerate = Boolean(state.encoded || state.encoding || state.pendingGeneration);
  try {
    prepareSource();
    if (regenerate) requestGeneration();
  } catch (error) { showToast(error.message, true); }
}
$('#auto-resize').addEventListener('change', () => {
  $('#source-scale').disabled = $('#auto-resize').checked;
  if (!$('#auto-resize').checked) $('#source-scale').value = Math.max(1, Math.min(1600, Number($('#source-scale').value)));
  resizeSource();
});
$('#source-scale').addEventListener('change', resizeSource);
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
  $('#balance-value').value = value < 34 ? '还原画质优先' : value > 66 ? '预设相似度优先' : '均衡';
  state.recoveryBoost = false;
  if (!$('#manual-parameters').checked && (state.encoded || state.encoding)) requestGeneration();
});
$('#manual-parameters').addEventListener('change', () => {
  syncAdvancedMode();
  state.recoveryBoost = false;
  if (state.encoded || state.encoding) requestGeneration();
});
$('#advanced-settings').addEventListener('toggle', syncAdvancedMode);
$('#tile-size').addEventListener('input', () => {
  const tileSize = Number($('#tile-size').value);
  $('#tile-size-value').value = `${tileSize} px`;
  syncCarrierControls();
  state.recoveryBoost = false;
  if ($('#auto-resize').checked && state.original) { resizeSource(); return; }
  if (state.encoded || state.encoding) requestGeneration();
});
for (const selector of ['#carrier-scale', '#color-adapt', '#color-gain', '#preset-fit', '#strength']) {
  $(selector).addEventListener('input', () => {
    if (selector === '#carrier-scale') syncCarrierControls();
    state.recoveryBoost = false;
    if (selector === '#carrier-scale' && $('#auto-resize').checked && state.original) { resizeSource(); return; }
    if ((selector === '#carrier-scale' || $('#manual-parameters').checked) && (state.encoded || state.encoding)) requestGeneration();
  });
}
$('#auto-carrier').addEventListener('change', () => {
  syncCarrierControls();
  if ($('#auto-resize').checked && state.original) { resizeSource(); return; }
  if (state.encoded || state.encoding) requestGeneration();
});
document.querySelectorAll('.preview-choice').forEach((button) => button.addEventListener('click', () => setPreview(button.dataset.preview)));
document.querySelectorAll('[data-zoom]').forEach((button) => button.addEventListener('click', () => {
  const viewport = button.closest('.decode-preview')
    ? $('#decode-preview').closest('.canvas-viewport')
    : (state.activePreviewViewport?.getClientRects().length ? state.activePreviewViewport : modeViewport());
  if (button.dataset.zoom === 'in' || button.dataset.zoom === 'out') {
    changePreviewZoom(button.dataset.zoom === 'in' ? 1 : -1, viewport);
    return;
  }
  zoomState(viewport).factor = button.dataset.zoom === 'fit' ? null : 1;
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
  if (!button.closest('.decode-preview')) state.activePreviewViewport = viewport;
  applyPreviewZoom(viewport);
}));
document.querySelectorAll('.canvas-viewport').forEach((viewport) => viewport.addEventListener('wheel', (event) => {
  if (!viewport.querySelector('canvas')?.width) return;
  event.preventDefault();
  if (!viewport.closest('.decode-preview')) state.activePreviewViewport = viewport;
  changePreviewZoom(event.deltaY < 0 ? 1 : -1, viewport, event.clientX, event.clientY);
}, { passive: false }));
document.querySelectorAll('.canvas-viewport').forEach((viewport) => {
  let drag = null;
  viewport.addEventListener('pointerenter', () => {
    if (!viewport.closest('.decode-preview')) {
      state.activePreviewViewport = viewport;
      writeZoomReadout(viewport);
    }
  });
  viewport.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !viewport.querySelector('canvas')?.width) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
    event.preventDefault();
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    viewport.scrollLeft = drag.left - (event.clientX - drag.x);
    viewport.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const finishPan = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    viewport.classList.remove('is-panning');
  };
  viewport.addEventListener('pointerup', finishPan);
  viewport.addEventListener('pointercancel', finishPan);
  viewport.addEventListener('lostpointercapture', finishPan);
});
$('#encoded-picker').addEventListener('click', () => $('#encoded-file').click());
$('#encoded-file').addEventListener('change', async (event) => {
  try { if (event.target.files[0]) await loadEncodedFile(event.target.files[0]); }
  catch (error) { showToast(error.message, true); }
});
$('#decode-button').addEventListener('click', restoreCurrentImage);
$('#download-restored').addEventListener('click', () => {
  if (!state.restoredDownload) return;
  setCanvas(canvases.decode, state.restoredDownload.data, state.restoredDownload.plan.width, state.restoredDownload.plan.height);
  downloadCanvas(canvases.decode, 'naiwa-restored.png');
});
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
window.addEventListener('resize', () => applyPreviewZoom());
if ('ResizeObserver' in window) {
  const previewObserver = new ResizeObserver(() => applyPreviewZoom());
  previewObserver.observe($('#preview-area'));
  previewObserver.observe($('.decode-preview'));
}

initializePresets().catch((error) => showToast(error.message, true));
syncAdvancedMode();

$('#preset-list').addEventListener('keydown', (event) => {
  if (!event.target.classList.contains('preset-option')) return;
  const index = Number(event.target.dataset.index);
  const destination = event.key === 'Home' ? 0 : event.key === 'End' ? PRESETS.length - 1
    : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % PRESETS.length
    : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + PRESETS.length - 1) % PRESETS.length : null;
  if (destination === null) return;
  event.preventDefault(); setPreset(destination);
  $(`.preset-option[data-index="${destination}"]`).focus();
});

for (const [selector, loader] of [['#encoded-picker', loadEncodedFile], ['#custom-preset-picker', loadCustomPreset]]) {
  const zone = $(selector);
  zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('is-dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', async (event) => {
    event.preventDefault(); zone.classList.remove('is-dragging');
    try { if (event.dataTransfer.files[0]) await loader(event.dataTransfer.files[0]); }
    catch (error) { showToast(error.message, true); }
  });
}
