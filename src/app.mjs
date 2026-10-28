// SPDX-License-Identifier: GPL-3.0-or-later
import { createPlan } from './core.mjs';
import { carrierScale, conversionDefaults, processingSize, processingOptions } from './processing-settings.mjs';
import { listPresets, savePreset, deletePreset, selectedPreset, loadBuiltinPreset } from './preset-store.mjs';
import { WorkerPool } from './worker-pool.mjs';
import { initializePreviews } from './preview-controller.mjs';
import { zipFiles } from './zip-store.mjs';
import { isGif } from './gif-codec.mjs';
import { initializeTutorial } from './guided-tour.mjs';
import { initializeAnalytics } from './analytics.mjs';
import { initializePhantomTank } from './phantom-tank.mjs';

const $ = selector => document.querySelector(selector);
const PRESETS = [
  { name: '奶蛙', src: './assets/images/static/%E5%A5%B6%E8%9B%99.png' },
  { name: '奶鼠', src: './assets/images/static/naishu.png' },
  { name: '奶狗', src: './assets/images/static/naigou.png' },
  { name: '奶蛋', src: './assets/images/static/naidan.png' },
  { name: '奶蛙翻滚笑', src: './assets/images/animated/1.gif', animated: true },
  { name: '奶蛙的救赎', src: './assets/images/animated/2.gif', animated: true },
];
const state = { encode: [], decode: [], activeEncode: null, activeDecode: null, presetIndex: 0, presetImages: [], presetGifBytes: [], presetsReady: false, settingsTouched: new Set(), encodePaint: 0, decodePaint: 0 };
const pool = new WorkerPool();
const previews = initializePreviews();
const activeEntry = kind => state[kind].find(entry => entry.id === state[kind === 'encode' ? 'activeEncode' : 'activeDecode']);
const presetKey = preset => preset.id ?? preset.src;
const animatedPreset = key => PRESETS.find(preset => presetKey(preset) === key)?.animated === true;
const gifOutput = entry => Boolean(entry?.isGif || animatedPreset(entry?.settings?.preset));
const outputIsGif = entry => entry?.result?.isGif ?? gifOutput(entry);
const isReady = entry => entry?.result && ['done', 'warning'].includes(entry.status);
const isProcessing = entry => ['queued', 'processing'].includes(entry.status);
const fields = {
  quality: ['jpg-quality', 'number'], balance: ['balance', 'number'], tileSize: ['tile-size', 'number'],
  autoResize: ['auto-resize', 'checkbox'], sourceScale: ['source-scale', 'number'],
  autoCarrier: ['auto-carrier', 'checkbox'], carrierScale: ['carrier-scale', 'number'],
  manual: ['manual-parameters', 'checkbox'], colorAdapt: ['color-adapt', 'yes'],
  colorGain: ['color-gain', 'number'], fit: ['preset-fit', 'string'], strength: ['strength', 'number'],
};

function readSettings() {
  const settings = { preset: presetKey(PRESETS[state.presetIndex]) };
  for (const [key, [id, type]] of Object.entries(fields)) {
    const input = $(`#${id}`);
    settings[key] = type === 'checkbox' ? input.checked : type === 'yes' ? input.value === 'yes' : type === 'number' ? Number(input.value) : input.value;
  }
  return settings;
}

function writeSettings(settings) {
  for (const [key, [id, type]] of Object.entries(fields)) {
    const input = $(`#${id}`);
    if (type === 'checkbox') input.checked = settings[key];
    else input.value = type === 'yes' ? settings[key] ? 'yes' : 'no' : String(settings[key]);
  }
  const index = PRESETS.findIndex(preset => presetKey(preset) === settings.preset);
  setPreset(index < 0 ? 0 : index, false);
  syncSettings();
}

function settingsForConversion(settings, sourceIsGif, preset = settings.preset, touched = activeEntry('encode')?.settingsTouched ?? state.settingsTouched) {
  const animatedOutput = sourceIsGif || animatedPreset(preset);
  const defaults = conversionDefaults(settings, animatedOutput);
  return {
    ...settings,
    balance: touched.has('balance') ? settings.balance : defaults.balance,
    tileSize: touched.has('tileSize') ? settings.tileSize : defaults.tileSize,
  };
}

function applyConversionDefaults(sourceIsGif = activeEntry('encode')?.isGif ?? false) {
  const settings = settingsForConversion(readSettings(), sourceIsGif);
  $('#balance').value = String(settings.balance);
  $('#tile-size').value = String(settings.tileSize);
  syncSettings();
  return settings;
}

function showToast(message, isError = false, action) {
  const toast = $('#toast'); toast.textContent = message;
  if (action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'toast-action'; button.textContent = action.label;
    button.addEventListener('click', async () => {
      button.disabled = true; clearTimeout(showToast.timer);
      try { await action.run(); toast.classList.remove('is-visible'); } catch (error) { showToast(error.message, true); }
    });
    toast.append(button);
  }
  toast.classList.toggle('is-error', isError); toast.classList.add('is-visible'); clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), action ? 8000 : 3800);
}

const phantomTank = initializePhantomTank({
  getPresets: () => PRESETS.map((preset, index) => ({ key: presetKey(preset), name: preset.name, src: preset.displaySrc ?? preset.src,
    image: state.presetImages[index], remove: preset.filename ? () => removeCustomPreset(preset) : null })).filter(choice => choice.image),
  onError: error => showToast(error.message, true),
  onPreviewChange: action => requestAnimationFrame(() => action === 'create' ? previews.fit('#phantom-create-view .phantom-stage')
    : action === 'reveal' ? previews.fit('#phantom-reveal-view .phantom-stage') : previews.apply()),
});

const formatBytes = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
const stem = entry => entry.file.name.replace(/\.[^.]+$/, '') || 'image';
function filename(entry, kind, raw = false) {
  if (kind === 'decode') {
    const extension = ({ 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' })[entry.result?.mime] ?? (entry.isGif ? 'gif' : 'png');
    return `${stem(entry)}-restored.${extension}`;
  }
  if (outputIsGif(entry)) return `${stem(entry)}-obfuscated.gif`;
  return raw ? `${stem(entry)}-obfuscated.png` : `${stem(entry)}-obfuscated-q${entry.result.quality}.jpg`;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const imageBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('浏览器无法导出图像。'))));
function bitmapCanvas(bitmap, width = bitmap.width, height = bitmap.height) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.imageSmoothingQuality = 'high'; context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}
const canvasPixels = canvas => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;

async function paintBlob(canvas, blob, width, height, current) {
  if (blob.type === 'application/x-naiwa-rgba') {
    const pixels = new Uint8ClampedArray(await blob.arrayBuffer());
    if (!current()) return;
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(pixels, width, height), 0, 0);
    requestAnimationFrame(() => previews.apply(canvas.closest('.canvas-viewport'))); return;
  }
  const viewport = canvas.closest('.canvas-viewport'); let animated = viewport.querySelector('.preview-animation');
  if (blob.type === 'image/gif') {
    if (!animated) { animated = document.createElement('img'); animated.className = 'preview-animation'; animated.alt = ''; canvas.parentElement.append(animated); }
    const previous = animated.dataset.objectUrl;
    const url = URL.createObjectURL(blob); animated.dataset.objectUrl = url; animated.src = url;
    animated.width = width; animated.height = height; animated.hidden = false; canvas.hidden = true;
    canvas.width = width; canvas.height = height;
    try { await animated.decode(); } catch (error) { if (current()) throw error; }
    if (previous) URL.revokeObjectURL(previous);
    if (!current()) { URL.revokeObjectURL(url); return; }
    requestAnimationFrame(() => previews.apply(viewport)); return;
  }
  if (animated) { animated.hidden = true; const previous = animated.dataset.objectUrl; delete animated.dataset.objectUrl; animated.removeAttribute('src'); if (previous) URL.revokeObjectURL(previous); }
  canvas.hidden = false;
  const bitmap = await createImageBitmap(blob);
  if (!current()) { bitmap.close(); return; }
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.imageSmoothingQuality = 'high'; context.drawImage(bitmap, 0, 0, width, height); bitmap.close();
  requestAnimationFrame(() => previews.apply(canvas.closest('.canvas-viewport')));
}

function syncDesktopLayout() {
  const shown = !$('#preview-area').hidden && $('#encode-view').classList.contains('is-visible');
  document.body.classList.toggle('has-preview', shown); document.documentElement.classList.toggle('has-preview', shown);
}

function syncSettings() {
  const settings = readSettings(); const scale = carrierScale(settings);
  document.body.classList.toggle('has-advanced-settings', $('#advanced-settings').open);
  const gifActive = Boolean(activeEntry('encode')?.isGif || animatedPreset(settings.preset));
  $('#jpg-quality').disabled = gifActive;
  $('#jpg-quality-hint').textContent = gifActive ? 'GIF 保留动画，此设置只影响静态图片。' : '生成后还可继续调节，文件大小会实时更新。';
  if (settings.autoCarrier) $('#carrier-scale').value = String(scale);
  $('#carrier-scale').disabled = gifActive || settings.autoCarrier; $('#auto-carrier').disabled = gifActive;
  $('#source-scale').disabled = gifActive || settings.autoResize; $('#auto-resize').disabled = gifActive;
  $('#tile-size-value').value = `${settings.tileSize} px`;
  $('#tile-size-hint').textContent = gifActive ? '调小后，GIF 画面里的参考图案会更清楚。' : '调小后，混淆图里的参考图案会更清楚；文件也会更大。';
  $('#carrier-scale-hint').textContent = gifActive ? 'GIF 会保留动画，不使用放大载体。' : settings.autoCarrier ? `当前自动放大 ${scale} 倍。倍数越高，混淆图文件越大。` : '可选 1–8 倍。倍数越高，混淆图文件越大；太低可能无法还原。';
  $('#jpg-quality-value').value = `${settings.quality}%`; $('#strength-value').value = String(settings.strength);
  $('#balance-value').value = settings.balance < 42 ? '还原图更清晰' : settings.balance > 58 ? '混淆图更像参考图' : '两边兼顾';
  $('#manual-fields').disabled = !settings.manual; $('#balance').disabled = settings.manual;
  $('#advanced-mode-label').textContent = gifActive ? 'GIF 动画设置' : settings.manual ? '自定义效果' : '尺寸与效果微调';
  $('#balance-hint').textContent = gifActive ? '往右调，GIF 画面会更接近所选参考图。' : settings.manual ? '当前使用下方的自定义选项调整效果。' : '往左调，还原图会保留更多原图细节；往右调，混淆图会更接近所选参考图。';
  $('.advanced-preview').hidden = !$('#advanced-settings').open;
  $('#preview-grid').classList.toggle('has-target', $('#advanced-settings').open);
  $('#batch-settings-hint').textContent = $('#unify-preset').checked ? '只同步参考图，处理参数各自独立。' : '参考图与处理参数均独立。';
}

function syncSourceMeta(entry) {
  if (!entry?.width) return;
  try {
    const animatedOutput = gifOutput(entry);
    const gifScale = Math.min(1, 384 / Math.max(entry.width, entry.height));
    const size = animatedOutput
      ? { width: Math.max(1, Math.round(entry.width * gifScale)), height: Math.max(1, Math.round(entry.height * gifScale)), scale: gifScale, automatic: true }
      : processingSize(entry.width, entry.height, entry.settings);
    entry.size = size;
    $('#source-meta').textContent = `${entry.file.name} · 上传 ${entry.width} × ${entry.height} → 处理 ${size.width} × ${size.height}`;
    $('#source-meta').title = $('#source-meta').textContent;
    $('#source-dimensions').textContent = `${size.width} × ${size.height}`;
    $('#source-sizing-summary').textContent = `${entry.width} × ${entry.height} → ${size.width} × ${size.height} px${size.scale === 1 ? ' · 保持尺寸' : size.scale > 1 ? ' · 已放大' : ' · 已缩小'}`;
    $('#source-scale-value').value = `${size.automatic ? '自动 ' : ''}${(size.scale * 100).toFixed(1)}%`;
    // The automatic readout is separate from the stored manual scale.
    $('#source-size-hint').textContent = animatedOutput
      ? entry.isGif ? `上传 ${entry.width} × ${entry.height} → GIF 帧适配 ${size.width} × ${size.height}。GIF 按帧数与处理预算自动缩放，原始 GIF 可无损还原。`
        : `静态原图将逐帧适配 GIF 参考图；输出最多 ${size.width} × ${size.height}，还原时取回原静态文件。`
      : `上传 ${entry.width} × ${entry.height} → 处理及还原 ${size.width} × ${size.height}。${size.automatic ? '短边目标 1024、长边上限 2960 px，长图及大倍率优先限制输出像素量。' : '使用手动比例，保留原图长宽比。'}`;
  } catch (error) { $('#source-sizing-summary').textContent = error.message; }
}

function createRow(entry, kind) {
  const row = document.createElement('div'); row.className = 'batch-item'; row.setAttribute('role', 'listitem'); row.dataset.id = entry.id;
  const select = document.createElement('button'); select.type = 'button'; select.className = 'batch-select';
  const image = document.createElement('img'); image.alt = ''; image.width = 44; image.height = 44;
  const text = document.createElement('span'); text.className = 'batch-copy';
  const name = document.createElement('strong'); name.textContent = entry.file.name;
  const detail = document.createElement('small'); text.append(name, detail);
  const ring = document.createElement('button'); ring.type = 'button'; ring.className = 'progress-ring';
  const progress = document.createElement('span'); progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100'); ring.append(progress);
  ring.addEventListener('click', () => processSingle(entry, kind));
  select.append(image, text); select.addEventListener('click', () => selectEntry(entry, kind));
  const actions = document.createElement('span'); actions.className = 'batch-item-actions';
  const download = document.createElement('button'); download.type = 'button'; download.className = 'batch-download'; download.title = '下载此条目';
  const downloadIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  downloadIcon.setAttribute('viewBox', '0 0 24 24'); downloadIcon.setAttribute('fill', 'none'); downloadIcon.setAttribute('stroke', 'currentColor');
  downloadIcon.setAttribute('stroke-width', '2'); downloadIcon.setAttribute('stroke-linecap', 'round'); downloadIcon.setAttribute('stroke-linejoin', 'round');
  downloadIcon.setAttribute('aria-hidden', 'true'); downloadIcon.setAttribute('focusable', 'false');
  const downloadArrow = document.createElementNS('http://www.w3.org/2000/svg', 'path'); downloadArrow.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
  const downloadStem = document.createElementNS('http://www.w3.org/2000/svg', 'path'); downloadStem.setAttribute('d', 'm7 10 5 5 5-5');
  const downloadShaft = document.createElementNS('http://www.w3.org/2000/svg', 'path'); downloadShaft.setAttribute('d', 'M12 15V3');
  downloadIcon.append(downloadArrow, downloadStem, downloadShaft); download.append(downloadIcon);
  download.setAttribute('aria-label', `下载 ${entry.file.name}`); download.addEventListener('click', () => { if (isReady(entry)) downloadBlob(kind === 'encode' ? entry.result.jpg : entry.result.blob, filename(entry, kind)); });
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'batch-remove'; remove.textContent = '×'; remove.title = `移除 ${entry.file.name}`;
  remove.setAttribute('aria-label', remove.title); remove.addEventListener('click', () => removeEntry(entry, kind));
  actions.append(download, remove); row.append(select, ring, actions);
  entry.ui = { row, select, image, detail, ring, progress, download }; $(`#${kind === 'encode' ? 'source' : 'decode'}-list`).append(row);
}

function renderRow(entry, kind) {
  const { row, select, image, detail, ring, progress, download } = entry.ui;
  const active = activeEntry(kind) === entry; const percent = Math.round((entry.progress ?? 0) * 100);
  row.dataset.status = entry.status; row.classList.toggle('is-active', active); select.setAttribute('aria-pressed', String(active));
  select.title = `${entry.file.name} · ${entry.label}`;
  if (entry.thumbnail && image.getAttribute('src') !== entry.thumbnail) image.src = entry.thumbnail;
  image.hidden = !entry.thumbnail;
  detail.textContent = kind === 'decode' && entry.status === 'done' ? `${entry.result.plan.width} × ${entry.result.plan.height} · 还原完成` : entry.label;
  ring.style.setProperty('--progress', `${percent * 3.6}deg`);
  progress.textContent = entry.status === 'done' ? '✓' : entry.status === 'error' || entry.status === 'warning' ? '!' : isProcessing(entry) ? `${percent}%` : '▶';
  progress.setAttribute('aria-valuenow', String(percent)); progress.setAttribute('aria-label', `${entry.file.name}：${entry.label}`);
  ring.disabled = !entry.width || entry.status === 'loading' || isProcessing(entry) || (kind === 'encode' && !state.presetsReady);
  ring.title = isProcessing(entry) ? `${entry.file.name}：${entry.label}` : `${entry.started ? '重新' : '单独'}${kind === 'encode' ? '生成' : '还原'}此图：${entry.file.name}`;
  ring.setAttribute('aria-label', ring.title);
  download.disabled = !isReady(entry);
}

function syncBatch(kind) {
  const entries = state[kind]; entries.forEach(entry => renderRow(entry, kind));
  const running = entries.filter(isProcessing).length; const ready = entries.filter(isReady).length;
  const loading = entries.filter(entry => entry.status === 'loading').length;
  const processableItems = entries.filter(entry => entry.width && entry.status !== 'loading');
  const processable = entries.filter(entry => entry.width && entry.status !== 'loading' && !isProcessing(entry));
  const pending = processable.filter(entry => !isReady(entry)).length;
  const allReady = processableItems.length > 0 && processableItems.every(isReady);
  const button = $(`#${kind === 'encode' ? 'encode' : 'decode'}-button`);
  button.disabled = kind === 'encode'
    ? !state.presetsReady || entries.length === 0 || loading > 0 || running > 0 || (pending === 0 && !allReady)
    : !entries.some(entry => entry.width && !isProcessing(entry) && entry.status !== 'loading');
  button.classList.toggle('is-busy', running > 0);
  button.textContent = kind === 'encode'
    ? !entries.length ? '请选择图片'
      : !state.presetsReady ? '正在准备参考图…'
        : loading ? '正在读取图片…'
          : running ? `正在处理 ${entries.filter(entry => isProcessing(entry)).length}/${entries.length} 张`
            : allReady ? `重新生成全部混淆图（${processableItems.length}）`
              : pending ? ready ? `继续处理剩余图片（${pending}）` : `生成全部混淆图（${pending}）`
                : '没有可处理的图片'
    : entries.length > 1 ? `还原全部图像（${entries.length}）` : '还原图像';
  const all = $(`#download-all-${kind === 'encode' ? 'encoded' : 'restored'}`);
  all.hidden = entries.length < 2; all.disabled = !ready || all.dataset.packing === 'true';
  if (all.dataset.packing !== 'true') all.textContent = `下载全部${kind === 'encode' ? '混淆图' : '还原图'}（${ready}张，打包为ZIP）`;
  const failed = entries.filter(entry => entry.status === 'error').length;
  $(`#${kind}-batch-summary`).textContent = entries.length ? `${ready}/${entries.length} 已完成${running ? ` · ${running} 项处理中或等待中` : ''}${failed ? ` · ${failed} 项失败，可重试` : ''}` : '';
  document.body.classList.toggle('has-source', state.encode.length > 0);
  $('#source-file-name').textContent = state.encode.length ? `继续添加图片（已有 ${state.encode.length} 张）` : '选择图片';
  $('#encoded-file-name').textContent = state.decode.length ? `继续添加混淆图（已有 ${state.decode.length} 张）` : '选择混淆图';
}

function renderStatus(entry, kind) {
  if (activeEntry(kind) !== entry) return;
  if (kind === 'decode') {
    $('#decode-message').textContent = entry.label;
    $('#decode-message').classList.toggle('is-success', entry.status === 'done');
    $('#download-restored').disabled = !isReady(entry);
  } else {
    const ready = isReady(entry);
    const animatedOutput = outputIsGif(entry);
    $('#download-button').disabled = !ready; $('#download-png').disabled = !ready || animatedOutput;
    $('#download-png').textContent = animatedOutput ? 'GIF 含可还原原图数据' : '另存压缩前 PNG';
    $('#download-button').textContent = animatedOutput ? '下载 GIF' : '下载 JPG';
    $('#result-summary').textContent = entry.status === 'done' ? animatedOutput ? `GIF ${entry.result.gifFrames} 帧 · 原图可完整还原` : `生成完成 · JPG ${entry.result.quality}%，还原验证通过` : entry.status === 'warning' ? '这份 JPG 暂时无法还原，可提高 JPG 质量后重试' : entry.label;
    $('#result-strip').dataset.status = entry.status === 'done' ? 'ready' : entry.status === 'warning' ? 'warning' : entry.status === 'error' ? 'error' : isProcessing(entry) ? 'checking' : 'pending';
    $('#result-strip').classList.toggle('is-ready', ready);
    $('#output-size').textContent = ready ? formatBytes(entry.result.jpg.size) : isProcessing(entry) ? '正在计算…' : '生成后显示';
    for (const element of [$('#output-size'), $('#download-button')]) {
      if (ready) element.dataset.bytes = String(entry.result.jpg.size); else element.removeAttribute('data-bytes');
    }
    if (ready) $('#output-size').dataset.quality = String(entry.result.quality); else $('#output-size').removeAttribute('data-quality');
  }
}

async function renderEncode(entry) {
  const token = ++state.encodePaint; const current = () => activeEntry('encode') === entry && token === state.encodePaint;
  if (!entry) {
    $('#preview-area').hidden = true; $('#source-meta').textContent = '尚未选择图像';
    $('#source-sizing-summary').textContent = '小图会放大，大图会缩小；可在高级设置中调整。';
    $('#download-button').disabled = $('#download-png').disabled = true; syncDesktopLayout(); return;
  }
  syncSourceMeta(entry); renderStatus(entry, 'encode');
  syncSettings();
  const result = isReady(entry) ? entry.result : null;
  const animatedOutput = result?.isGif ?? gifOutput(entry);
  if (result) { $('#result-summary').textContent = '正在更新预览…'; $('#result-strip').dataset.status = 'checking'; }
  $('#preview-area').hidden = !result && !entry.started; syncDesktopLayout();
  for (const name of ['mosaic', 'restored', 'target']) $(`#${name}-empty`).hidden = !entry.started ? false : Boolean(result && (name !== 'restored' || result.restoredPreview));
  $('#mosaic-empty').textContent = entry.status === 'error' ? '生成失败，可调整设置后重试' : entry.label;
  $('#restored-title').textContent = result?.isGif ? '还原后的图片效果' : 'JPG 还原效果';
  $('#restored-empty').textContent = result?.warning ? '可提高 JPG 质量后再次尝试' : result?.isGif ? result.originalMime === 'image/gif' ? '这里会显示还原后的原动画' : '这里会显示还原后的原图' : '生成后显示 JPG 还原效果';
  $('#mosaic-dimensions').textContent = result ? `${result.plan.outputWidth} × ${result.plan.outputHeight}` : '等待生成';
  $('#target-dimensions').textContent = result ? `${result.targetWidth ?? result.plan.outputWidth} × ${result.targetHeight ?? result.plan.outputHeight}` : '与混淆图同尺寸';
  $('#restored-score').textContent = result ? result.warning ? '当前 JPG 无法还原' : result.isGif ? result.originalMime === 'image/gif' ? '原 GIF 已完整还原' : '原静态图已完整还原' : `来自 JPG ${result.quality}%` : '等待生成';
  $('#preset-score').textContent = result ? result.isGif ? `与参考图的相似度评分（逐帧平均）· 轮廓 ${result.resemblance.outline.toFixed(4)} · 细节 ${result.resemblance.detail.toFixed(4)} · 共 ${result.targetFrames} 帧` : `JPG 与参考图的相似度评分 · 轮廓 ${result.resemblance.outline.toFixed(4)} · 细节 ${result.resemblance.detail.toFixed(4)}` : '混淆图与参考图的相似度评分（越高越像）';
  $('#restore-metrics').textContent = result ? result.warning ?? (result.isGif ? `原图保存在 GIF 中 · ${formatBytes(result.originalBytes)}` : `JPG 还原效果评分 · ${result.restoredSSIM.toFixed(4)}`) : '生成后显示还原效果评分';
  const plan = result?.plan;
  $('#applied-options').textContent = plan ? animatedOutput ? `GIF 动画 · ${result.gifFrames} 帧 · ${plan.width} × ${plan.height} · 保留 ${Math.round(plan.colorGain * 100)}% 原图细节` : `${entry.settings.manual ? '自定义' : '自动'}设置 · ${plan.tileSize} px 图块 · 混淆图放大 ${plan.scale} 倍 · ${plan.panels} 段处理 · 保留 ${Math.round(plan.colorGain * 100)}% 原图细节${plan.transparentPixels ? ' · 透明部分已铺白底' : ''}` : '生成后显示实际使用的设置';
  const size = entry.size;
  if (!size) return;
  const paints = [paintBlob($('#source-preview'), result?.sourcePreview ?? entry.file, size.width, size.height, current)];
  if (result) {
    paints.push(paintBlob($('#mosaic-preview'), result.jpg, plan.outputWidth, plan.outputHeight, current));
    paints.push(paintBlob($('#target-preview'), result.targetPreview, result.targetWidth ?? plan.outputWidth, result.targetHeight ?? plan.outputHeight, current));
    if (result.restoredPreview) paints.push(paintBlob($('#restored-preview'), result.restoredPreview, result.restoreWidth ?? plan.width, result.restoreHeight ?? plan.height, current));
  }
  await Promise.all(paints);
  if (current()) { $('#source-empty').hidden = true; renderStatus(entry, 'encode'); }
}

async function renderDecode(entry) {
  const token = ++state.decodePaint; const current = () => activeEntry('decode') === entry && token === state.decodePaint;
  $('#download-restored').disabled = !isReady(entry);
  $('#download-restored').hidden = !isReady(entry);
  const restoredMime = entry?.result?.mime;
  $('#download-restored').textContent = restoredMime === 'image/gif' || (!restoredMime && entry?.isGif) ? '下载本条还原 GIF' : '下载本条还原图像';
  $('#decode-empty').hidden = Boolean(isReady(entry));
  $('#decode-empty').textContent = entry?.label ?? '选择混淆图文件';
  $('#encoded-meta').textContent = entry?.width ? `${entry.file.name} · ${entry.width} × ${entry.height}` : '选择要还原的混淆图';
  $('#decode-dimensions').textContent = isReady(entry) ? `${entry.result.plan.width} × ${entry.result.plan.height}` : '等待解码';
   $('#decode-message').textContent = isReady(entry) ? '正在更新还原预览…' : entry?.label ?? '请选择混淆图'; $('#decode-message').classList.toggle('is-success', entry?.status === 'done');
  if (isReady(entry)) {
    await paintBlob($('#decode-preview'), entry.result.blob, entry.result.plan.width, entry.result.plan.height, current);
    if (current()) renderStatus(entry, 'decode');
  }
}

function refreshPreview(kind) { (kind === 'encode' ? renderEncode(activeEntry(kind)) : renderDecode(activeEntry(kind))).catch(error => showToast(error.message, true)); }
function selectEntry(entry, kind) {
  state[kind === 'encode' ? 'activeEncode' : 'activeDecode'] = entry?.id ?? null;
  if (kind === 'encode' && entry) writeSettings(entry.settings);
  previews.reset(); syncBatch(kind); refreshPreview(kind);
}

function cancelEntry(entry) { clearTimeout(entry.timer); entry.version += 1; entry.controller?.abort(); entry.controller = null; }
function removeEntry(entry, kind) {
  const index = state[kind].indexOf(entry); const active = activeEntry(kind) === entry;
  cancelEntry(entry); state[kind].splice(index, 1); entry.ui.row.remove(); if (entry.thumbnail) URL.revokeObjectURL(entry.thumbnail);
  entry.result = entry.cached = null;
  if (active) selectEntry(state[kind][Math.min(index, state[kind].length - 1)], kind); else syncBatch(kind);
}

async function importFiles(files, kind) {
  const images = [...files].filter(file => file.type.startsWith('image/'));
  if (!images.length) throw new Error('请选择有效的图像文件。');
  const settings = readSettings();
  const typedImages = await Promise.all(images.map(async file => ({ file, isGif: isGif(new Uint8Array(await file.slice(0, 6).arrayBuffer())) })));
  const entries = typedImages.map(({ file, isGif: animatedSource }) => ({
    id: crypto.randomUUID(), file, isGif: animatedSource,
    settings: settingsForConversion(settings, animatedSource, settings.preset, state.settingsTouched), settingsTouched: new Set(state.settingsTouched),
    version: 0, status: 'loading', label: '读取图像…', progress: 0, result: null, started: false,
  }));
  for (const entry of entries) { state[kind].push(entry); createRow(entry, kind); }
  selectEntry(entries[0], kind);
  for (const entry of entries) {
    try {
      const bitmap = await createImageBitmap(entry.file);
      if (!state[kind].includes(entry)) { bitmap.close(); continue; }
      entry.width = bitmap.width; entry.height = bitmap.height;
      const scale = Math.min(1, 88 / Math.max(bitmap.width, bitmap.height));
      const canvas = bitmapCanvas(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale))); bitmap.close();
      const thumbnail = await imageBlob(canvas); canvas.width = canvas.height = 0;
      if (!state[kind].includes(entry)) continue;
      entry.thumbnail = URL.createObjectURL(thumbnail); entry.status = 'idle'; entry.label = '已载入，等待处理';
    } catch (error) { entry.status = 'error'; entry.label = `读取失败：${error.message}`; }
    syncBatch(kind); if (activeEntry(kind) === entry) refreshPreview(kind);
  }
}

function settingsChanged({ qualityOnly = false, presetOnly = false } = {}) {
  syncSettings(); const settings = readSettings();
  const entries = presetOnly && $('#unify-preset').checked ? state.encode : [activeEntry('encode')].filter(Boolean);
  for (const entry of entries) {
    const next = presetOnly ? entry.settings.preset === settings.preset ? entry.settings
      : settingsForConversion({ ...entry.settings, preset: settings.preset }, entry.isGif, settings.preset, entry.settingsTouched) : settings;
    if (qualityOnly && (entry.isGif || animatedPreset(next.preset))) { entry.settings = { ...next }; continue; }
    if (JSON.stringify(entry.settings) === JSON.stringify(next)) continue;
    const started = entry.started;
    let cache = qualityOnly ? entry.result ?? entry.cached : null;
    if (cache && !next.manual && cache.plan.step !== processingOptions(next).step) cache = null;
    cancelEntry(entry); entry.settings = { ...next }; entry.cached = cache; entry.result = null;
    if (entry.status === 'loading') continue;
    entry.status = 'idle'; entry.progress = 0; entry.label = started ? '设置已更新，等待重新生成' : '已载入，等待处理';
    if (started) scheduleEntry(entry, 'encode', 350);
  }
  if (presetOnly) {
    const active = activeEntry('encode');
    if (active) writeSettings(active.settings); else applyConversionDefaults();
  }
  syncSourceMeta(activeEntry('encode')); syncBatch('encode'); refreshPreview('encode');
}

function scheduleEntry(entry, kind, delay = 0) {
  cancelEntry(entry); entry.started = true; entry.status = 'queued'; entry.progress = 0; entry.label = '等待处理';
  entry.timer = setTimeout(() => processEntry(entry, kind), delay);
}

async function processEntry(entry, kind) {
  if (!state[kind].includes(entry) || !entry.width) return;
  const version = entry.version; const controller = new AbortController(); entry.controller = controller;
  const current = () => state[kind].includes(entry) && entry.version === version;
  const settings = { ...entry.settings };
  let payload; let memory;
  try {
    if (kind === 'encode') {
      const index = PRESETS.findIndex(preset => presetKey(preset) === settings.preset);
      if (index < 0) throw new Error('所选参考图已删除，请重新选择。');
      const targetGif = state.presetGifBytes[index];
      if (entry.isGif || targetGif) {
        memory = Math.min(pool.memoryBudget, Math.max(128 * 1048576, entry.file.size * 24 + 64 * 1048576));
        payload = { action: 'encode-file', file: entry.file, settings, target: state.presetImages[index], targetGif };
      } else {
        const size = processingSize(entry.width, entry.height, settings); const plan = createPlan(size.width, size.height, processingOptions(settings));
        memory = plan.outputWidth * plan.outputHeight * 24 + size.width * size.height * 12;
        payload = { action: 'encode-file', file: entry.file, settings, target: state.presetImages[index], compactPreview: state.encode.length > 1, cached: entry.cached ? { raw: entry.cached.raw, plan: entry.cached.plan, boosted: entry.cached.boosted } : null };
      }
    } else { payload = { action: 'restore-file', file: entry.file }; memory = entry.width * entry.height * 12; }
    const result = await pool.run(payload, { signal: controller.signal, memory, onProgress: progress => {
      if (!current()) return;
      entry.status = 'processing'; entry.progress = progress.fraction; entry.label = progress.label;
      renderRow(entry, kind); renderStatus(entry, kind);
    } });
    if (!current()) return;
    if (kind === 'encode' && result.isGif) {
      entry.size = { width: result.sourceWidth, height: result.sourceHeight, scale: Math.min(result.sourceWidth / entry.width, result.sourceHeight / entry.height), automatic: true };
    }
    entry.result = result; entry.cached = null; entry.completedAt = Date.now(); entry.status = result.warning ? 'warning' : 'done'; entry.progress = 1;
    analytics.recordConversion();
    // Keep recent carriers for instant quality edits, with a fixed byte budget
    // so a long batch does not retain every enlarged, uncompressed image.
    let retained = 0;
    for (const item of [...state.encode].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))) {
      const cache = item.result ?? item.cached;
      if (!cache?.raw) continue;
      retained += cache.raw.size;
      if (retained > Math.min(pool.memoryBudget / 2, 128 * 1048576)) cache.raw = null;
    }
    entry.label = kind === 'encode' ? result.warning ? '已生成 · 这份 JPG 暂时无法还原' : result.isGif ? `完成 · ${result.gifFrames} 帧 · 原图可完整还原` : '完成 · JPG 还原验证通过'
      : result.isGif ? `GIF 原图已完整还原 · ${result.plan.width} × ${result.plan.height}` : result.mime ? `原图已完整还原 · ${result.plan.width} × ${result.plan.height}` : `还原完成 · ${result.plan.width} × ${result.plan.height}`;
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    entry.status = 'error'; entry.label = error.message; entry.result = null;
    if (activeEntry(kind) === entry) showToast(error.message, true);
  } finally {
    if (current()) { entry.controller = null; syncBatch(kind); if (activeEntry(kind) === entry) refreshPreview(kind); }
  }
}

function processBatch(kind) {
  const entries = state[kind];
  const processableItems = entries.filter(entry => entry.width && entry.status !== 'loading');
  const restartAll = kind === 'encode' && processableItems.length > 0 && processableItems.every(isReady);
  if (kind === 'encode' && (entries.some(entry => entry.status === 'loading' || isProcessing(entry)) || !state.presetsReady)) return;
  for (const entry of entries) {
    if (entry.width && entry.status !== 'loading' && !isProcessing(entry) && (kind !== 'encode' || restartAll || !isReady(entry))) scheduleEntry(entry, kind);
  }
  syncBatch(kind); refreshPreview(kind);
  if (kind === 'encode' && matchMedia('(max-width: 640px)').matches) requestAnimationFrame(() => $('#preview-area').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
}

function processSingle(entry, kind) {
  if (!entry.width || entry.status === 'loading' || isProcessing(entry) || (kind === 'encode' && !state.presetsReady)) return;
  scheduleEntry(entry, kind); selectEntry(entry, kind);
}

async function downloadAll(kind) {
  const entries = state[kind].filter(isReady); if (!entries.length) return;
  const button = $(`#download-all-${kind === 'encode' ? 'encoded' : 'restored'}`); button.dataset.packing = 'true'; button.disabled = true;
  try {
    const files = entries.map(entry => ({ blob: kind === 'encode' ? entry.result.jpg : entry.result.blob, name: filename(entry, kind) }));
    const zip = await zipFiles(files, (done, total) => { button.textContent = `正在打包 ${done}/${total}`; });
    downloadBlob(zip, kind === 'encode' ? 'naiwa-obfuscated.zip' : 'naiwa-restored.zip');
  } catch (error) { showToast(error.message, true); }
  finally { delete button.dataset.packing; syncBatch(kind); }
}

async function downloadRawPng() {
  const entry = activeEntry('encode'); if (!isReady(entry)) return;
  if (outputIsGif(entry)) return;
  const result = entry.result; const button = $('#download-png');
  button.disabled = true; button.textContent = '正在导出 PNG…';
  try {
    const index = PRESETS.findIndex(preset => presetKey(preset) === entry.settings.preset);
    const exported = await pool.run({ action: 'export-png', raw: result.raw, plan: result.plan, file: entry.file, settings: entry.settings, boosted: result.boosted, target: state.presetImages[index] }, { memory: result.plan.outputWidth * result.plan.outputHeight * 12 });
    downloadBlob(exported.blob, filename(entry, 'encode', true));
  } catch (error) { showToast(error.message, true); }
  finally { button.textContent = '另存压缩前 PNG'; button.disabled = !isReady(activeEntry('encode')); }
}

function setPreset(index, notify = true) {
  const changed = state.presetIndex !== index;
  state.presetIndex = index; const preset = PRESETS[index]; if (!preset) return;
  selectedPreset(presetKey(preset));
  document.querySelectorAll('.preset-option').forEach(button => {
    const active = Number(button.dataset.index) === index;
    button.classList.toggle('is-active', active); button.setAttribute('aria-checked', String(active)); button.tabIndex = active ? 0 : -1;
  });
  const image = state.presetImages[index];
  $('#custom-preset-hint').textContent = preset.filename ? `${preset.saved ? '已保存在这台设备' : '仅本次可用'} · ${image.width} × ${image.height}` : '新加的参考图会保存在这台设备上。';
  $('#selected-preset-name').textContent = preset.name;
  if (notify && changed) {
    settingsChanged({ presetOnly: true });
  }
}

function renderPresets(index = state.presetIndex) {
  $('#preset-list').replaceChildren(); PRESETS.forEach(appendPreset); setPreset(index, false);
}
function appendPreset(preset, index) {
  const card = document.createElement('div'); card.className = 'preset-card';
  const option = document.createElement('button'); option.className = 'preset-option'; option.type = 'button'; option.dataset.index = String(index);
  option.setAttribute('role', 'radio'); option.setAttribute('aria-checked', 'false'); option.setAttribute('aria-label', preset.name); option.title = preset.name;
  const image = document.createElement('img'); image.src = preset.displaySrc ?? preset.src; image.alt = '';
  const label = document.createElement('span'); label.textContent = preset.name; option.append(image, label);
  option.addEventListener('click', () => setPreset(index)); card.append(option);
  if (preset.filename) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'preset-remove'; remove.textContent = '×'; remove.title = `删除 ${preset.name}`; remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await removeCustomPreset(preset); } catch (error) { remove.disabled = false; showToast(`未能删除参考图：${error.message}`, true); }
    }); card.append(remove);
  }
  $('#preset-list').append(card);
}

async function initializePresets() {
  const lastSelected = selectedPreset();
  const loaded = await Promise.all(PRESETS.map(async preset => {
    const blob = await loadBuiltinPreset(preset.src); const bytes = preset.animated ? new Uint8Array(await blob.arrayBuffer()) : null;
    const bitmap = await createImageBitmap(blob); const canvas = bitmapCanvas(bitmap); bitmap.close();
    preset.displaySrc = URL.createObjectURL(blob);
    const image = { width: canvas.width, height: canvas.height, data: canvasPixels(canvas) }; canvas.width = canvas.height = 0; return { image, bytes };
  }));
  state.presetImages = loaded.map(item => item.image); state.presetGifBytes = loaded.map(item => item.bytes);
  try {
    for (const record of await listPresets()) {
      const bitmap = await createImageBitmap(record.blob); const canvas = bitmapCanvas(bitmap); bitmap.close();
      PRESETS.push({ id: record.id, name: record.name, filename: record.filename, src: URL.createObjectURL(record.blob), saved: true, record, animated: record.blob.type === 'image/gif' });
      state.presetImages.push({ width: canvas.width, height: canvas.height, data: canvasPixels(canvas) });
      state.presetGifBytes.push(record.blob.type === 'image/gif' ? new Uint8Array(await record.blob.arrayBuffer()) : null); canvas.width = canvas.height = 0;
    }
  } catch { showToast('浏览器本地存储暂不可用，自定义参考图仍可在本次使用。'); }
  const index = PRESETS.findIndex(preset => presetKey(preset) === lastSelected); renderPresets(index < 0 ? 0 : index);
  phantomTank.refreshPresets();
  const key = presetKey(PRESETS[state.presetIndex]);
  for (const entry of state.encode) if (!entry.started) entry.settings = settingsForConversion({ ...entry.settings, preset: key }, entry.isGif, key, entry.settingsTouched);
  const initialEntry = activeEntry('encode');
  if (initialEntry) writeSettings(initialEntry.settings); else applyConversionDefaults(false);
  state.presetsReady = true; syncBatch('encode');
  $('#custom-preset-picker').disabled = false;
}

async function removeCustomPreset(preset) {
  if (preset.saved) await deletePreset(preset.id);
  const index = PRESETS.indexOf(preset); if (index < 0) return;
  const selected = PRESETS[state.presetIndex]; const wasSelected = selected === preset;
  const [image] = state.presetImages.splice(index, 1); state.presetGifBytes.splice(index, 1); PRESETS.splice(index, 1);
  renderPresets(wasSelected ? 0 : PRESETS.indexOf(selected));
  phantomTank.refreshPresets();
  for (const entry of state.encode) if (entry.settings.preset === preset.id) {
    cancelEntry(entry); entry.settings = settingsForConversion({ ...entry.settings, preset: presetKey(PRESETS[0]) }, entry.isGif, presetKey(PRESETS[0]), entry.settingsTouched); entry.result = entry.cached = null; entry.status = 'idle'; entry.label = '参考图已删除，已切换默认参考图';
    if (entry.started) scheduleEntry(entry, 'encode', 350);
  }
  if (activeEntry('encode')) writeSettings(activeEntry('encode').settings);
  syncBatch('encode'); refreshPreview('encode'); URL.revokeObjectURL(preset.src);
  showToast(`已删除「${preset.name}」`, false, { label: '撤销', run: async () => {
    if (preset.saved) await savePreset(preset.record);
    if (PRESETS.some(item => item.id === preset.id)) return;
    preset.src = URL.createObjectURL(preset.record.blob); PRESETS.push(preset); state.presetImages.push(image); state.presetGifBytes.push(preset.animated ? new Uint8Array(await preset.record.blob.arrayBuffer()) : null); renderPresets(wasSelected ? PRESETS.length - 1 : state.presetIndex); phantomTank.refreshPresets();
    if (wasSelected) settingsChanged({ presetOnly: true });
  } });
}

async function loadCustomPreset(file) {
  if (!file?.type.startsWith('image/')) throw new Error('请选择有效的参考图。');
  const animated = isGif(new Uint8Array(await file.slice(0, 6).arrayBuffer()));
  const bitmap = await createImageBitmap(file); const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
  const canvas = bitmapCanvas(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale))); bitmap.close();
  const image = { width: canvas.width, height: canvas.height, data: canvasPixels(canvas) }; const blob = animated ? file : await imageBlob(canvas); canvas.width = canvas.height = 0;
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const existing = PRESETS.findIndex(preset => preset.id === id);
  if (existing >= 0) { setPreset(existing); showToast('这张图片已经在你的参考图中。'); return; }
  const record = { id, name: file.name.replace(/\.[^.]+$/, '') || '自定义参考图', filename: file.name, blob, createdAt: Date.now() };
  let saved = true;
  try { await savePreset(record); } catch { saved = false; showToast('本地保存未成功，这张参考图仍可在本次使用。', true); }
  const preset = { id, name: record.name, filename: file.name, src: URL.createObjectURL(blob), saved, record, animated };
  PRESETS.push(preset); state.presetImages.push(image); state.presetGifBytes.push(animated ? new Uint8Array(await blob.arrayBuffer()) : null); appendPreset(preset, PRESETS.length - 1); setPreset(PRESETS.length - 1); phantomTank.refreshPresets();
}

for (const [inputId, pickerId, kind] of [['source-file', 'source-picker', 'encode'], ['encoded-file', 'encoded-picker', 'decode']]) {
  const picker = $(`#${pickerId}`); const input = $(`#${inputId}`);
  picker.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files]; input.value = '';
    try { if (files.length) await importFiles(files, kind); } catch (error) { showToast(error.message, true); }
  });
  picker.addEventListener('dragover', event => { event.preventDefault(); picker.classList.add('is-dragging'); });
  picker.addEventListener('dragleave', () => picker.classList.remove('is-dragging'));
  picker.addEventListener('drop', async event => {
    event.preventDefault(); picker.classList.remove('is-dragging');
    try { await importFiles(event.dataTransfer.files, kind); } catch (error) { showToast(error.message, true); }
  });
}
$('#encode-button').addEventListener('click', () => processBatch('encode'));
$('#decode-button').addEventListener('click', () => processBatch('decode'));
$('#unify-preset').addEventListener('change', () => { if ($('#unify-preset').checked) settingsChanged({ presetOnly: true }); else syncSettings(); });
for (const [key, [id, type]] of Object.entries(fields)) {
  $(`#${id}`).addEventListener(type === 'checkbox' || id === 'source-scale' ? 'change' : 'input', () => {
    if (key === 'balance' || key === 'tileSize') (activeEntry('encode')?.settingsTouched ?? state.settingsTouched).add(key);
    settingsChanged({ qualityOnly: key === 'quality' });
  });
}
$('#advanced-settings').addEventListener('toggle', () => { syncSettings(); requestAnimationFrame(() => previews.apply()); });
$('#download-button').addEventListener('click', () => { const entry = activeEntry('encode'); if (isReady(entry)) downloadBlob(entry.result.jpg, filename(entry, 'encode')); });
$('#download-png').addEventListener('click', downloadRawPng);
$('#download-restored').addEventListener('click', () => { const entry = activeEntry('decode'); if (isReady(entry)) downloadBlob(entry.result.blob, filename(entry, 'decode')); });
$('#download-all-encoded').addEventListener('click', () => downloadAll('encode'));
$('#download-all-restored').addEventListener('click', () => downloadAll('decode'));
$('#custom-preset-picker').addEventListener('click', () => $('#custom-preset-file').click());
$('#custom-preset-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  try { if (file) await loadCustomPreset(file); } catch (error) { showToast(error.message, true); }
});
const customPicker = $('#custom-preset-picker');
customPicker.addEventListener('dragover', event => { event.preventDefault(); customPicker.classList.add('is-dragging'); });
customPicker.addEventListener('dragleave', () => customPicker.classList.remove('is-dragging'));
customPicker.addEventListener('drop', async event => {
  event.preventDefault(); customPicker.classList.remove('is-dragging');
  try { if (event.dataTransfer.files[0]) await loadCustomPreset(event.dataTransfer.files[0]); } catch (error) { showToast(error.message, true); }
});
$('#preset-list').addEventListener('keydown', event => {
  if (!event.target.classList.contains('preset-option')) return;
  const index = Number(event.target.dataset.index);
  const destination = event.key === 'Home' ? 0 : event.key === 'End' ? PRESETS.length - 1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % PRESETS.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + PRESETS.length - 1) % PRESETS.length : null;
  if (destination === null) return;
  event.preventDefault(); setPreset(destination); $(`.preset-option[data-index="${destination}"]`).focus();
});
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('is-active', tab === button));
  document.querySelectorAll('.view').forEach(section => { const active = section.id === `${button.dataset.view}-view`; section.hidden = !active; section.classList.toggle('is-visible', active); });
  document.body.classList.toggle('phantom-active', button.dataset.view === 'phantom');
  syncDesktopLayout(); requestAnimationFrame(() => previews.apply());
}));
initializePresets().catch(error => showToast(error.message, true));
syncSettings(); syncBatch('encode'); syncBatch('decode');
initializeTutorial();
const analytics = initializeAnalytics();

$('.workbench').addEventListener('wheel', event => {
  if (matchMedia('(max-width: 640px)').matches || event.ctrlKey || !event.deltaY) return;
  const advanced = event.target.closest('#advanced-settings');
  const content = $('.advanced-content');
  const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * content.clientHeight : event.deltaY;
  if (advanced?.open) content.scrollTop += delta;
  else window.scrollBy(0, delta);
  event.preventDefault();
}, { passive: false });
