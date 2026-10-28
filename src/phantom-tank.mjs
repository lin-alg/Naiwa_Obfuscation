// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from TankFactory/Mirage_Cloak Encoder_v4/v5 (GPL-3.0), modified 2026-10-28.
import { imageSimilarity } from './core.mjs';

const MAX_EDGE = 1600;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const grayscale = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;

export function adjustPhantomImage(image, { contrast = 50, brightness = 50 } = {}, mode = 'color') {
  if (!image?.data || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new TypeError('图片必须是有效的 RGBA 图像数据。');
  }
  if (!['color', 'mono'].includes(mode)) throw new TypeError('未知的幻影坦克成像模式。');
  const output = new Uint8ClampedArray(image.data.length);
  const contrastValue = Number.isFinite(Number(contrast)) ? clamp(Number(contrast), 0, 100) : 50;
  const brightnessValue = Number.isFinite(Number(brightness)) ? clamp(Number(brightness), 0, 100) : 50;
  const contrastOffset = (contrastValue - 50) * 5.1;
  const factor = (259 * (contrastOffset + 255)) / (255 * (259 - contrastOffset));
  const brightnessOffset = (brightnessValue - 50) * 3;
  for (let offset = 0; offset < output.length; offset += 4) {
    const alpha = image.data[offset + 3] / 255;
    const matte = 255 * (1 - alpha);
    let red = image.data[offset] * alpha + matte;
    let green = image.data[offset + 1] * alpha + matte;
    let blue = image.data[offset + 2] * alpha + matte;
    if (mode === 'mono') red = green = blue = grayscale(red, green, blue);
    output[offset] = clamp(factor * (red - 128) + 128 + brightnessOffset, 0, 255);
    output[offset + 1] = clamp(factor * (green - 128) + 128 + brightnessOffset, 0, 255);
    output[offset + 2] = clamp(factor * (blue - 128) + 128 + brightnessOffset, 0, 255);
    output[offset + 3] = 255;
  }
  return { width: image.width, height: image.height, data: output };
}

export function composePhantomTank(darkImage, lightImage, mode = 'color') {
  if (!darkImage?.data || !lightImage?.data || !Number.isInteger(darkImage.width) || !Number.isInteger(darkImage.height)
    || darkImage.width < 1 || darkImage.height < 1 || darkImage.width !== lightImage.width || darkImage.height !== lightImage.height
    || darkImage.data.length !== lightImage.data.length || darkImage.data.length !== darkImage.width * darkImage.height * 4) {
    throw new TypeError('外图和内图必须是尺寸相同的 RGBA 图像数据。');
  }
  if (!['color', 'mono'].includes(mode)) throw new TypeError('未知的幻影坦克成像模式。');

  const output = new Uint8ClampedArray(darkImage.data.length);
  if (mode === 'mono') output.set([114, 114, 114, 255], 0);
  else output.set([51, 51, 51, 255], 0);
  for (let offset = 4; offset < output.length; offset += 4) {
    if (mode === 'mono') {
      const dark = Math.floor(grayscale(darkImage.data[offset], darkImage.data[offset + 1], darkImage.data[offset + 2]) * 0.5);
      const lightValue = grayscale(lightImage.data[offset], lightImage.data[offset + 1], lightImage.data[offset + 2]);
      const light = Math.floor(255 - (255 - lightValue) * 0.5);
      const alpha = clamp(255 - light + dark, 1, 255);
      const gray = clamp((dark * 255) / alpha, 0, 255);
      output[offset] = output[offset + 1] = output[offset + 2] = gray;
      output[offset + 3] = alpha;
      continue;
    }

    const ir = Math.floor(darkImage.data[offset] * 0.3);
    const ig = Math.floor(darkImage.data[offset + 1] * 0.3);
    const ib = Math.floor(darkImage.data[offset + 2] * 0.3);
    const cr = Math.floor(255 - (255 - lightImage.data[offset]) * 0.6);
    const cg = Math.floor(255 - (255 - lightImage.data[offset + 1]) * 0.6);
    const cb = Math.floor(255 - (255 - lightImage.data[offset + 2]) * 0.6);
    const dr = ir - cr;
    const dg = ig - cg;
    const db = ib - cb;
    const alpha = Math.max(0, 1 + (((2048 | (dr + ((ir + cr) * 2))) * dr
      - (db + ((ir + cr) * 2) - 3068) * db + dg * 4096)
      / (1020 * (dr - db) + 2349060)));
    output[offset] = clamp((ir / alpha) * 0.5 + (255 - (255 - cr) / alpha) * 0.5, 0, 255);
    output[offset + 1] = clamp((ig / alpha) * 0.5 + (255 - (255 - cg) / alpha) * 0.5, 0, 255);
    output[offset + 2] = clamp((ib / alpha) * 0.5 + (255 - (255 - cb) / alpha) * 0.5, 0, 255);
    output[offset + 3] = alpha * 255;
  }
  return { width: darkImage.width, height: darkImage.height, data: output };
}

function canvasFor(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas;
}

function flattenFile(file) {
  if (!file?.type.startsWith('image/')) throw new Error('请选择有效的图片文件。');
  return createImageBitmap(file).then(bitmap => {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;
    return image;
  });
}

function loadTransparentFile(file) {
  if (!file?.type.startsWith('image/')) throw new Error('请选择有效的图片文件。');
  return createImageBitmap(file).then(bitmap => {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;
    return image;
  });
}

function fitInner(image, width, height) {
  const source = canvasFor(image);
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const context = output.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  const scale = Math.min(width / image.width, height / image.height);
  const fittedWidth = image.width * scale;
  const fittedHeight = image.height * scale;
  context.drawImage(source, (width - fittedWidth) / 2, (height - fittedHeight) / 2, fittedWidth, fittedHeight);
  const fitted = context.getImageData(0, 0, width, height);
  source.width = source.height = output.width = output.height = 0;
  return fitted;
}

export function fitPhantomInner(image, width, height) {
  return fitInner(image, width, height);
}

function compositeOn(image, background) {
  const data = new Uint8ClampedArray(image.length);
  for (let offset = 0; offset < image.length; offset += 4) {
    const alpha = image[offset + 3] / 255;
    data[offset] = image[offset] * alpha + background * (1 - alpha);
    data[offset + 1] = image[offset + 1] * alpha + background * (1 - alpha);
    data[offset + 2] = image[offset + 2] * alpha + background * (1 - alpha);
    data[offset + 3] = 255;
  }
  return data;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function initializePhantomTank({ getPresets, onError = () => {}, onPreviewChange = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const elements = {
    outerFile: $('#phantom-outer-file'), outerPicker: $('#phantom-outer-picker'), outerName: $('#phantom-outer-name'),
    outerChip: $('#phantom-outer-chip'), outerThumb: $('#phantom-outer-thumb'), outerMeta: $('#phantom-outer-meta'),
    innerFile: $('#phantom-inner-file'), innerPicker: $('#phantom-inner-picker'), presets: $('#phantom-presets'),
    generate: $('#phantom-generate'), download: $('#phantom-download'), status: $('#phantom-status'),
    outputMeta: $('#phantom-output-meta'), resultMessage: $('#phantom-result-message'), resultFooter: $('.phantom-result-footer'),
    light: $('#phantom-light'), lightState: $('#phantom-light-state'), stage: $('#phantom-stage'),
    canvas: $('#phantom-canvas'), empty: $('#phantom-empty'),
    outputZoom: $('#phantom-zoom-value'),
    createView: $('#phantom-create-view'), revealView: $('#phantom-reveal-view'), revealFile: $('#phantom-reveal-file'),
    revealPicker: $('#phantom-reveal-picker'), revealName: $('#phantom-reveal-name'), revealLight: $('#phantom-reveal-light'),
    revealLightState: $('#phantom-reveal-light-state'), revealStage: $('#phantom-reveal-stage'), revealCanvas: $('#phantom-reveal-canvas'),
    revealEmpty: $('#phantom-reveal-empty'), revealStatus: $('#phantom-reveal-status'), revealZoom: $('#phantom-reveal-zoom-value'),
  };
  const state = {
    outer: null, outerName: '', outerUrl: '', outerRequest: 0, inner: null, innerKey: '', customInner: null, innerRequest: 0,
    mode: 'mono', output: null, revision: 0, generating: false, runningRevision: -1,
    adjustments: { outerContrast: 50, outerBrightness: 50, innerContrast: 50, innerBrightness: 50 },
    revealRequest: 0,
  };

  function refreshPresets() {
    const choices = getPresets();
    const previousKey = state.innerKey;
    elements.presets.replaceChildren();
    const all = choices.map(choice => ({ ...choice, key: `preset:${choice.key}` }));
    if (state.customInner) all.push({ ...state.customInner, key: 'custom', remove: removeCustomInner });
    for (const choice of all) {
      const card = document.createElement('div');
      card.className = 'preset-card phantom-preset-card';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'phantom-preset';
      button.dataset.key = choice.key;
      button.setAttribute('aria-pressed', String(choice.key === previousKey));
      button.title = choice.name;
      const image = document.createElement('img');
      image.src = choice.src;
      image.alt = '';
      const label = document.createElement('span');
      label.textContent = choice.name;
      button.append(image, label);
      button.addEventListener('click', () => selectInner(choice));
      card.append(button);
      if (choice.remove) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'preset-remove phantom-preset-remove';
        remove.textContent = '×';
        remove.title = `删除 ${choice.name}`;
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { await choice.remove(); } catch (error) { remove.disabled = false; onError(error); }
        });
        card.append(remove);
      }
      elements.presets.append(card);
    }
    const selected = all.find(choice => choice.key === previousKey) ?? all[0];
    if (selected) selectInner(selected, Boolean(state.output || state.generating));
  }

  function removeCustomInner() {
    if (!state.customInner) return;
    ++state.innerRequest;
    URL.revokeObjectURL(state.customInner.src);
    state.customInner = null;
    refreshPresets();
  }

  function selectInner(choice, regenerate = true) {
    const changed = state.innerKey !== choice.key || state.inner !== choice.image;
    const hadOutput = Boolean(state.output || state.generating);
    if (changed) resetAdjustments();
    state.inner = choice.image;
    state.innerKey = choice.key;
    elements.presets.querySelectorAll('.phantom-preset').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.key === choice.key)));
    if (changed) invalidate(regenerate && hadOutput, `内图：${choice.name}`);
  }

  function invalidate(regenerate = false, message = '设置已更新。') {
    const revision = ++state.revision;
    state.output = null;
    elements.canvas.width = elements.canvas.height = 0;
    elements.empty.hidden = false;
    elements.download.disabled = true;
    elements.outputMeta.textContent = '等待生成';
    elements.generate.disabled = !state.outer || !state.inner;
    elements.generate.textContent = '生成幻影坦克图';
    elements.resultFooter.classList.remove('is-ready');
    elements.resultMessage.textContent = message;
    elements.status.textContent = state.outer && state.inner ? '点击生成，预览并下载透明 PNG。' : '选择外图和内图后即可生成。';
    if (regenerate && state.outer && state.inner) requestAnimationFrame(() => { if (revision === state.revision) generate(); });
  }

  async function generate() {
    if (!state.outer || !state.inner || (state.generating && state.runningRevision === state.revision)) return;
    const revision = state.revision;
    state.generating = true;
    state.runningRevision = revision;
    elements.generate.disabled = true;
    elements.download.disabled = true;
    elements.generate.textContent = '正在合成…';
    elements.status.textContent = '正在按 Mirage_Cloak 映射合成透明图像…';
    await new Promise(resolve => requestAnimationFrame(resolve));
    try {
      const inner = fitInner(state.inner, state.outer.width, state.outer.height);
      const outerAdjusted = adjustPhantomImage(state.outer, {
        contrast: state.adjustments.outerContrast, brightness: state.adjustments.outerBrightness,
      }, state.mode);
      const innerAdjusted = adjustPhantomImage(inner, {
        contrast: state.adjustments.innerContrast, brightness: state.adjustments.innerBrightness,
      }, state.mode);
      const result = composePhantomTank(innerAdjusted, outerAdjusted, state.mode);
      const colorChannels = state.mode === 'color';
      const originalOuter = adjustPhantomImage(state.outer, {}, state.mode);
      const originalInner = adjustPhantomImage(inner, {}, state.mode);
      const outerSSIM = imageSimilarity(compositeOn(result.data, 255), originalOuter.data, result.width, result.height, 512, colorChannels);
      const innerSSIM = imageSimilarity(compositeOn(result.data, 0), originalInner.data, result.width, result.height, 512, colorChannels);
      if (revision !== state.revision) return;
      elements.canvas.width = result.width;
      elements.canvas.height = result.height;
      elements.canvas.getContext('2d').putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
      onPreviewChange('create');
      const blob = await new Promise(resolve => elements.canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('浏览器无法导出 PNG。');
      if (revision !== state.revision) return;
      state.output = blob;
      elements.empty.hidden = true;
      elements.download.disabled = false;
      elements.outputMeta.textContent = `${result.width} × ${result.height} · PNG`;
      elements.status.textContent = `生成完成 · ${result.width} × ${result.height} · ${(blob.size / 1024).toFixed(0)} KB`;
      elements.resultFooter.classList.add('is-ready');
      elements.resultMessage.textContent = `原图保真度 · 白底外图 ${outerSSIM.toFixed(3)} · 黑底内图 ${innerSSIM.toFixed(3)}`;
    } catch (error) {
      onError(error);
      elements.status.textContent = error.message;
    } finally {
      if (revision === state.revision) {
        state.generating = false;
        elements.generate.disabled = !state.outer || !state.inner;
        elements.generate.textContent = '生成幻影坦克图';
      }
    }
  }

  async function loadOuter(file, request) {
    const image = await flattenFile(file);
    if (request !== state.outerRequest) return;
    if (state.outerUrl) URL.revokeObjectURL(state.outerUrl);
    state.outer = image;
    resetAdjustments();
    state.outerName = file.name;
    state.outerUrl = URL.createObjectURL(file);
    elements.outerName.textContent = file.name;
    elements.outerThumb.src = state.outerUrl;
    elements.outerMeta.textContent = `${image.width} × ${image.height} · PNG 输出上限 1600 px`;
    elements.outerChip.hidden = false;
    invalidate(Boolean(state.output || state.generating), `外图：${file.name}`);
  }

  async function loadCustomInner(file, request) {
    const image = await loadTransparentFile(file);
    if (request !== state.innerRequest) return;
    if (state.customInner?.src) URL.revokeObjectURL(state.customInner.src);
    state.customInner = { key: 'custom', name: file.name, image, src: URL.createObjectURL(file) };
    refreshPresets();
    selectInner(state.customInner);
  }

  elements.outerPicker.addEventListener('click', () => elements.outerFile.click());
  elements.outerFile.addEventListener('change', async () => {
    const file = elements.outerFile.files[0];
    elements.outerFile.value = '';
    const request = ++state.outerRequest;
    try { if (file) await loadOuter(file, request); } catch (error) { onError(error); }
  });
  elements.outerPicker.addEventListener('dragover', event => { event.preventDefault(); elements.outerPicker.classList.add('is-dragging'); });
  elements.outerPicker.addEventListener('dragleave', () => elements.outerPicker.classList.remove('is-dragging'));
  elements.outerPicker.addEventListener('drop', async event => {
    event.preventDefault();
    elements.outerPicker.classList.remove('is-dragging');
    const file = event.dataTransfer.files[0];
    const request = ++state.outerRequest;
    try { if (file) await loadOuter(file, request); } catch (error) { onError(error); }
  });
  elements.innerPicker.addEventListener('click', () => elements.innerFile.click());
  elements.innerFile.addEventListener('change', async () => {
    const file = elements.innerFile.files[0];
    elements.innerFile.value = '';
    const request = ++state.innerRequest;
    try { if (file) await loadCustomInner(file, request); } catch (error) { onError(error); }
  });
  elements.generate.addEventListener('click', generate);
  elements.download.addEventListener('click', () => {
    if (state.output) downloadBlob(state.output, `${state.outerName.replace(/\.[^.]+$/, '') || 'phantom'}-幻影坦克.png`);
  });
  elements.light.addEventListener('change', () => {
    const on = elements.light.checked;
    elements.stage.dataset.light = on ? 'on' : 'off';
    elements.lightState.textContent = on ? '开灯' : '关灯';
  });
  function showReveal(image, filename) {
    elements.revealCanvas.width = image.width;
    elements.revealCanvas.height = image.height;
    elements.revealCanvas.getContext('2d').putImageData(image, 0, 0);
    onPreviewChange('reveal');
    elements.revealEmpty.hidden = true;
    elements.revealName.textContent = filename;
    let hasTransparency = false;
    for (let offset = 3; offset < image.data.length; offset += 4) {
      if (image.data[offset] < 255) { hasTransparency = true; break; }
    }
    elements.revealStatus.textContent = hasTransparency
      ? `检测到透明区域 · ${image.width} × ${image.height}`
      : `未检测到透明像素，开关灯不会切换图像 · ${image.width} × ${image.height}`;
  }
  elements.revealPicker.addEventListener('click', () => elements.revealFile.click());
  elements.revealFile.addEventListener('change', async () => {
    const file = elements.revealFile.files[0];
    elements.revealFile.value = '';
    const request = ++state.revealRequest;
    try {
      if (!file) return;
      const image = await loadTransparentFile(file);
      if (request !== state.revealRequest) return;
      showReveal(image, file.name);
    } catch (error) {
      onError(error);
      elements.revealStatus.textContent = error.message;
    }
  });
  elements.revealLight.addEventListener('change', () => {
    const on = elements.revealLight.checked;
    elements.revealStage.dataset.light = on ? 'on' : 'off';
    elements.revealLightState.textContent = on ? '开灯' : '关灯';
  });
  elements.revealStage.addEventListener('dragover', event => { event.preventDefault(); elements.revealStage.classList.add('is-dragging'); });
  elements.revealStage.addEventListener('dragleave', () => elements.revealStage.classList.remove('is-dragging'));
  elements.revealStage.addEventListener('drop', async event => {
    event.preventDefault();
    elements.revealStage.classList.remove('is-dragging');
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const request = ++state.revealRequest;
    try {
      const image = await loadTransparentFile(file);
      if (request !== state.revealRequest) return;
      showReveal(image, file.name);
    } catch (error) {
      onError(error);
      elements.revealStatus.textContent = error.message;
    }
  });
  const adjustmentInputs = {
    outerContrast: $('#phantom-outer-contrast'), outerBrightness: $('#phantom-outer-brightness'),
    innerContrast: $('#phantom-inner-contrast'), innerBrightness: $('#phantom-inner-brightness'),
  };
  function resetAdjustments() {
    state.adjustments = { outerContrast: 50, outerBrightness: 50, innerContrast: 50, innerBrightness: 50 };
    for (const [key, input] of Object.entries(adjustmentInputs)) {
      input.value = 50;
      const output = $(`#phantom-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}-value`);
      output.value = output.textContent = 50;
    }
  }
  let adjustmentTimer;
  function updateAdjustment(key, value) {
    const shouldRegenerate = Boolean(state.output || state.generating);
    state.adjustments[key] = value;
    adjustmentInputs[key].value = value;
    $(`#phantom-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}-value`).value = value;
    $(`#phantom-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}-value`).textContent = value;
    invalidate(false, '图像参数已更新。');
    clearTimeout(adjustmentTimer);
    if (shouldRegenerate) adjustmentTimer = setTimeout(generate, 140);
  }
  for (const [key, input] of Object.entries(adjustmentInputs)) {
    input.addEventListener('input', () => updateAdjustment(key, Number(input.value)));
  }
  document.querySelectorAll('[data-phantom-reset]').forEach(button => button.addEventListener('click', () => {
    updateAdjustment(button.dataset.phantomReset, 50);
  }));
  document.querySelectorAll('[data-phantom-page]').forEach(button => button.addEventListener('click', () => {
    const reveal = button.dataset.phantomPage === 'reveal';
    elements.createView.hidden = reveal;
    elements.revealView.hidden = !reveal;
    document.querySelectorAll('[data-phantom-page]').forEach(option => {
      const active = option === button;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-pressed', String(active));
    });
    requestAnimationFrame(onPreviewChange);
  }));
  document.querySelectorAll('[data-phantom-mode]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.phantomMode === state.mode) return;
    const hadOutput = Boolean(state.output || state.generating);
    state.mode = button.dataset.phantomMode;
    resetAdjustments();
    document.querySelectorAll('[data-phantom-mode]').forEach(option => {
      const active = option === button;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-pressed', String(active));
    });
    invalidate(hadOutput, `已切换为${state.mode === 'color' ? '彩色' : '黑白'}模式。`);
  }));

  return { refreshPresets };
}
