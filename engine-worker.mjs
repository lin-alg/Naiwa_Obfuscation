// SPDX-License-Identifier: GPL-3.0-or-later
import { createPlan, encodeImage, imageSimilarity, presetSimilarity, restoreImage } from './core.mjs';
import { processingOptions, processingSize } from './processing-settings.mjs';

function imageCanvas(image) {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas;
}

async function readFile(file, size) {
  const bitmap = await createImageBitmap(file);
  const dimensions = size?.(bitmap.width, bitmap.height) ?? { width: bitmap.width, height: bitmap.height };
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high'; context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const image = { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
  canvas.width = canvas.height = 1;
  return image;
}

async function previewBlob(image, maxSide = 1200) {
  const canvas = imageCanvas(image);
  if (Math.max(image.width, image.height) <= maxSide) {
    const blob = await canvas.convertToBlob(); canvas.width = canvas.height = 1; return blob;
  }
  const ratio = maxSide / Math.max(image.width, image.height);
  const small = new OffscreenCanvas(Math.round(image.width * ratio), Math.round(image.height * ratio));
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  const blob = await small.convertToBlob(); canvas.width = canvas.height = small.width = small.height = 1;
  return blob;
}

async function encodeFile({ file, settings, target, cached, compactPreview }, progress) {
  const start = performance.now();
  progress({ label: '准备原图', fraction: 0.01 });
  const source = await readFile(file, (width, height) => processingSize(width, height, settings));
  let boosted = cached?.boosted ?? false;
  let raw = cached?.raw;
  let plan = cached?.plan;
  let targetImage;
  const timings = {};
  for (;;) {
    let carrier;
    if (!raw) {
      const options = processingOptions(settings, boosted);
      plan = createPlan(source.width, source.height, options);
      if (plan.outputWidth * plan.outputHeight > 32000000 || Math.max(plan.outputWidth, plan.outputHeight) > 16384) throw new Error('混淆载体过大，请降低原图缩放比例或载体倍率（最多 3200 万像素、单边 16384 px）。');
      const encoded = await encodeImage(source, target, {
        ...options, skipSimilarity: true,
        onTiming: (stage, ms) => { timings[stage] = Math.round(ms); },
        onProgress: ({ label, fraction }) => progress({ label, fraction: 0.03 + fraction * 0.53 }),
      });
      plan = encoded.plan; targetImage = encoded.targetImage;
      carrier = { width: plan.outputWidth, height: plan.outputHeight, data: encoded.data };
      // Cache the bytes without an expensive full-size PNG compression. The
      // optional PNG is encoded only when downloaded; JPEG edits reuse this.
      raw = new Blob([carrier.data], { type: 'application/x-naiwa-rgba' });
    }
    carrier ??= { width: plan.outputWidth, height: plan.outputHeight, data: new Uint8ClampedArray(await raw.arrayBuffer()) };
    if (!targetImage) {
      const { fitImage } = await import('./core.mjs');
      targetImage = fitImage(target, carrier.width, carrier.height, plan.fit, plan.panels);
    }
    progress({ label: '导出 JPG', fraction: 0.62 });
    const canvas = imageCanvas(carrier);
    const jpg = await canvas.convertToBlob({ type: 'image/jpeg', quality: settings.quality / 100 });
    canvas.width = canvas.height = 1;
    const compressed = await readFile(jpg);
    let restored; let warning; let restoredSSIM;
    try {
      restored = await restoreImage(compressed, {
        onProgress: ({ label, fraction }) => progress({ label: `验证 JPG · ${label}`, fraction: 0.65 + fraction * 0.26 }),
      });
      restoredSSIM = imageSimilarity(source.data, restored.data, source.width, source.height);
    } catch (error) {
      if (!settings.manual && !boosted && plan.step < 24) {
        boosted = true; raw = null; targetImage = null;
        progress({ label: '增强坐标保护后重试', fraction: 0.03 }); continue;
      }
      warning = error.message;
    }
    progress({ label: '计算相似度与保存预览', fraction: 0.93 });
    const resemblance = presetSimilarity(compressed.data, targetImage.data, compressed.width, compressed.height);
    const result = {
      raw, jpg, plan, quality: settings.quality, boosted, resemblance, restoredSSIM, warning,
      targetPreview: await previewBlob(targetImage),
      restoredPreview: restored ? compactPreview
        ? await previewBlob({ width: plan.width, height: plan.height, data: restored.data }, 16384)
        : new Blob([restored.data], { type: 'application/x-naiwa-rgba' }) : null,
      corrected: restored?.plan.corrected,
    };
    result.timings = { ...timings, total: Math.round(performance.now() - start) };
    progress({ label: warning ? '已生成，JPG 还原验证未通过' : '处理完成', fraction: 1 });
    return result;
  }
}

self.onmessage = async ({ data: message }) => {
  const { id, action, source, target, original, file } = message;
  const onProgress = progress => self.postMessage({ id, type: 'progress', progress });
  try {
    let result;
    if (action === 'encode-file') result = await encodeFile(message, onProgress);
    else if (action === 'export-png') {
      let { raw, plan } = message;
      let image;
      if (raw) image = { width: plan.outputWidth, height: plan.outputHeight, data: new Uint8ClampedArray(await raw.arrayBuffer()) };
      else {
        const source = await readFile(file, (width, height) => processingSize(width, height, message.settings));
        const encoded = await encodeImage(source, target, { ...processingOptions(message.settings, message.boosted), skipSimilarity: true, onProgress });
        plan = encoded.plan; image = { width: plan.outputWidth, height: plan.outputHeight, data: encoded.data };
      }
      const canvas = imageCanvas(image); result = { blob: await canvas.convertToBlob() }; canvas.width = canvas.height = 1;
    }
    else if (action === 'restore-file') {
      onProgress({ label: '读取混淆文件', fraction: 0.01 });
      const image = await readFile(file);
      const restored = await restoreImage(image, { onProgress: ({ label, fraction }) => onProgress({ label, fraction: 0.03 + fraction * 0.9 }) });
      onProgress({ label: '保存还原 PNG', fraction: 0.95 });
      const canvas = imageCanvas({ width: restored.plan.width, height: restored.plan.height, data: restored.data });
      result = { blob: await canvas.convertToBlob(), plan: restored.plan };
      canvas.width = canvas.height = 1;
    } else if (action === 'encode') result = await encodeImage(source, target, { ...message, onProgress });
    else if (action === 'verify') {
      const restored = await restoreImage(source, { onProgress });
      result = { restored, restoredSSIM: imageSimilarity(original.data, restored.data, original.width, original.height), preset: presetSimilarity(source.data, target.data, source.width, source.height) };
    } else result = await restoreImage(source, { onProgress });
    const transfer = [];
    for (const image of [result, result.targetImage, result.restored]) if (image?.data?.buffer) transfer.push(image.data.buffer);
    self.postMessage({ id, type: 'result', result }, transfer);
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
