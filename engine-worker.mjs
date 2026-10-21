// SPDX-License-Identifier: GPL-3.0-or-later
import { createPlan, encodeImage, imageSimilarity, presetSimilarity, restoreImage } from './core.mjs';
import { processingOptions, processingSize } from './processing-settings.mjs';
import { alignedFrameDelays, concatBytes, embeddedImagePayload, gifFrameBlock, gifFrames, gifHeader, gifPayloadBlock, isGif, parseGif } from './gif-codec.mjs';

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

async function compressGifBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressGifBytes(bytes, size, raw = false) {
  if (size < 8 || size > 512 * 1048576) throw new Error('内嵌原图尺寸无效。');
  const stream = raw ? null : new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const result = raw ? bytes : new Uint8Array(await new Response(stream).arrayBuffer());
  if (result.length !== size) throw new Error('内嵌原图校验失败。');
  return result;
}

function gifPalette(gif) {
  const colors = []; const seen = new Set(); const primary = gif.palette ?? gif.frames[0].palette;
  const append = (palette, limit = palette.length) => {
    for (let i = 0; i < limit; i += 3) {
      const color = (palette[i] << 16) | (palette[i + 1] << 8) | palette[i + 2];
      if (!seen.has(color)) { seen.add(color); colors.push(color); }
    }
  };
  append(primary, Math.min(primary.length, 256 * 3));
  const extra = []; const extraSeen = new Set(seen);
  for (const frame of gif.frames) for (let i = 0; i < frame.palette.length; i += 3) {
    const color = (frame.palette[i] << 16) | (frame.palette[i + 1] << 8) | frame.palette[i + 2];
    if (!extraSeen.has(color)) { extraSeen.add(color); extra.push(color); }
  }
  const slots = Math.max(0, 256 - colors.length); const stride = slots ? Math.max(1, Math.ceil(extra.length / slots)) : 1;
  if (slots) for (let i = 0; i < extra.length && colors.length < 256; i += stride) colors.push(extra[i]);
  const primaryPalette = gif.palette ?? gif.frames[0].palette;
  for (let i = 0; i < primaryPalette.length && colors.length < 256; i += 3) {
    const color = (primaryPalette[i] << 16) | (primaryPalette[i + 1] << 8) | primaryPalette[i + 2];
    if (!seen.has(color)) { seen.add(color); colors.push(color); }
  }
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const color = colors[i % Math.max(1, colors.length)] ?? 0;
    palette[i * 3] = color >>> 16; palette[i * 3 + 1] = color >>> 8; palette[i * 3 + 2] = color;
  }
  return palette;
}

function imagePalette(image) {
  const histogram = new Map();
  for (let p = 0; p < image.data.length; p += 4) {
    const alpha = image.data[p + 3] / 255; const matte = 255 * (1 - alpha);
    const r = Math.min(31, Math.floor((image.data[p] * alpha + matte) / 8));
    const g = Math.min(31, Math.floor((image.data[p + 1] * alpha + matte) / 8));
    const b = Math.min(31, Math.floor((image.data[p + 2] * alpha + matte) / 8));
    const key = (r << 10) | (g << 5) | b; histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const colors = [...histogram].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([key]) => [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4]);
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) palette.set(colors[Math.min(i, colors.length - 1)] ?? [255, 255, 255], i * 3);
  return palette;
}

function makePaletteLookup(palette) {
  const lookup = new Uint8Array(32 * 32 * 32);
  for (let r = 0; r < 32; r += 1) for (let g = 0; g < 32; g += 1) for (let b = 0; b < 32; b += 1) {
    const red = r * 8 + 4; const green = g * 8 + 4; const blue = b * 8 + 4;
    let best = Infinity; let selected = 0;
    for (let i = 0; i < 256; i += 1) {
      const dr = red - palette[i * 3]; const dg = green - palette[i * 3 + 1]; const db = blue - palette[i * 3 + 2];
      const distance = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
      if (distance < best) { best = distance; selected = i; }
    }
    lookup[(r << 10) | (g << 5) | b] = selected;
  }
  return lookup;
}

function quantizeFrame(data, lookup) {
  const indices = new Uint8Array(data.length / 4);
  for (let pixel = 0, out = 0; pixel < data.length; pixel += 4, out += 1) {
    indices[out] = lookup[((data[pixel] >> 3) << 10) | ((data[pixel + 1] >> 3) << 5) | (data[pixel + 2] >> 3)];
  }
  return indices;
}

function targetFrameIndices(source, target) {
  const selected = new Set(); const indices = [];
  let elapsed = 0; let targetElapsed = 0; let targetIndex = 0;
  const targetStarts = [];
  for (const frame of target.frames) { targetStarts.push(targetElapsed); targetElapsed += frame.duration; }
  for (const frame of source.frames) {
    const midpoint = elapsed + frame.duration / 2;
    const sample = midpoint / source.duration * target.duration;
    while (targetIndex + 1 < target.frames.length && targetStarts[targetIndex + 1] <= sample) targetIndex += 1;
    indices.push(targetIndex); selected.add(targetIndex); elapsed += frame.duration;
  }
  return { indices, selected };
}

async function resizeFrame(frame, width, height) {
  if (frame.width === width && frame.height === height) return frame.data;
  const input = new OffscreenCanvas(frame.width, frame.height);
  input.getContext('2d').putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  const output = new OffscreenCanvas(width, height); const context = output.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high'; context.drawImage(input, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data; input.width = input.height = output.width = output.height = 1;
  return pixels;
}

async function encodeGifFile({ file, targetGif, target: staticTarget, settings }, progress) {
  const original = new Uint8Array(await file.arrayBuffer()); const source = parseGif(original);
  const target = targetGif ? parseGif(targetGif) : {
    width: staticTarget.width, height: staticTarget.height, duration: source.duration, loop: source.loop,
    palette: imagePalette(staticTarget), frames: [{ duration: source.duration, palette: imagePalette(staticTarget) }],
  };
  const pixelBudgetSide = Math.floor(Math.sqrt(32000000 / source.frames.length));
  const fileBudgetSide = Math.floor(Math.sqrt(original.length * 2 / (source.frames.length * 0.35)));
  const processedSide = Math.max(64, Math.min(384, pixelBudgetSide, fileBudgetSide));
  const ratio = Math.min(1, processedSide / Math.max(source.width, source.height));
  const sourceWidth = Math.max(1, Math.round(source.width * ratio)); const sourceHeight = Math.max(1, Math.round(source.height * ratio));
  const targetRatio = Math.min(1, processedSide / Math.max(target.width, target.height));
  const targetWidth = Math.max(1, Math.round(target.width * targetRatio)); const targetHeight = Math.max(1, Math.round(target.height * targetRatio));
  const { indices: targetMap } = targetFrameIndices(source, target);
  const outputDelays = alignedFrameDelays(source, target);
  const palette = gifPalette(target); const lookup = makePaletteLookup(palette);
  const options = gifProcessingOptions(settings);
  const frames = []; const sourceFrames = gifFrames(source); const targetFrames = targetGif ? gifFrames(target) : null;
  let targetProgress = -1; let currentTarget = null; let index = 0; let plan; let outline = 0; let detail = 0;
  if (!targetGif) currentTarget = { width: targetWidth, height: targetHeight, data: await resizeFrame(staticTarget, targetWidth, targetHeight) };
  for (const frame of sourceFrames) {
    const image = { width: sourceWidth, height: sourceHeight, data: await resizeFrame(frame, sourceWidth, sourceHeight) };
    while (targetFrames && targetProgress < targetMap[index]) {
      const next = targetFrames.next(); if (next.done) throw new Error('GIF 预设动画帧对齐失败。');
      targetProgress += 1;
      if (targetProgress === targetMap[index]) currentTarget = { width: targetWidth, height: targetHeight, data: await resizeFrame(next.value, targetWidth, targetHeight) };
    }
    const desired = currentTarget;
    const encoded = await encodeImage(image, desired, { ...options, skipSimilarity: true });
    plan = encoded.plan;
    const indices = quantizeFrame(encoded.data, lookup); const visible = new Uint8ClampedArray(indices.length * 4);
    for (let pixel = 0; pixel < indices.length; pixel += 1) {
      const color = indices[pixel] * 3; const destination = pixel * 4;
      visible[destination] = palette[color]; visible[destination + 1] = palette[color + 1]; visible[destination + 2] = palette[color + 2]; visible[destination + 3] = 255;
    }
    const score = presetSimilarity(visible, encoded.targetImage.data, plan.outputWidth, plan.outputHeight);
    outline += score.outline; detail += score.detail;
    frames.push(gifFrameBlock(indices, {
      width: plan.outputWidth, height: plan.outputHeight, delay: outputDelays[index], minimum: 8, palette: null, disposal: 1,
    }));
    index += 1;
    if ((index & 3) === 0 || index === source.frames.length) progress({ label: `匹配 GIF 动画帧 ${index}/${source.frames.length}`, fraction: 0.05 + index / source.frames.length * 0.82 });
  }
  const packedOriginal = await compressGifBytes(original); const useCompression = packedOriginal.length < original.length;
  const transformed = concatBytes([gifHeader(plan.outputWidth, plan.outputHeight, palette, target.loop), gifPayloadBlock(original.length, useCompression ? packedOriginal : original, useCompression), ...frames, Uint8Array.of(0x3b)]);
  const blob = new Blob([transformed], { type: 'image/gif' });
  const result = {
    jpg: blob, gif: blob, isGif: true, originalMime: 'image/gif', restoreWidth: source.width, restoreHeight: source.height,
    plan: { ...plan, panels: 1, step: 0, coordinateBits: 8 }, quality: settings.quality,
    resemblance: { outline: outline / source.frames.length, detail: detail / source.frames.length }, restoredSSIM: 1, corrected: 0, warning: null,
    sourcePreview: file, restoredPreview: file, targetPreview: targetGif ? new Blob([targetGif], { type: 'image/gif' }) : await previewBlob({ width: targetWidth, height: targetHeight, data: currentTarget.data }), targetWidth, targetHeight,
    gifFrames: source.frames.length, targetFrames: target.frames.length, originalBytes: original.length, sourceWidth, sourceHeight,
  };
  progress({ label: 'GIF 混淆完成 · 原图可精确还原', fraction: 1 });
  return result;
}

function gifProcessingOptions(settings) {
  return { ...processingOptions(settings), noWatermark: true, scale: 1 };
}

function sourceMime(file, original) {
  if (file.type?.startsWith('image/')) return file.type;
  if (original[0] === 0xff && original[1] === 0xd8) return 'image/jpeg';
  if (original[0] === 0x89 && original[1] === 0x50 && original[2] === 0x4e && original[3] === 0x47) return 'image/png';
  if (textDecoder.decode(original.subarray(0, 4)) === 'RIFF' && textDecoder.decode(original.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return 'image/png';
}

const textDecoder = new TextDecoder('ascii');

async function encodeStillAsGifFile({ file, targetGif, settings }, progress) {
  const original = new Uint8Array(await file.arrayBuffer()); const mime = sourceMime(file, original); const target = parseGif(targetGif);
  const pixelBudgetSide = Math.floor(Math.sqrt(32000000 / target.frames.length));
  const processedSide = Math.max(64, Math.min(384, pixelBudgetSide));
  const bitmap = await createImageBitmap(file);
  const restoreWidth = bitmap.width; const restoreHeight = bitmap.height;
  const ratio = Math.min(1, processedSide / Math.max(bitmap.width, bitmap.height));
  const sourceWidth = Math.max(1, Math.round(bitmap.width * ratio)); const sourceHeight = Math.max(1, Math.round(bitmap.height * ratio));
  const sourceCanvas = new OffscreenCanvas(sourceWidth, sourceHeight); const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  sourceContext.imageSmoothingQuality = 'high'; sourceContext.drawImage(bitmap, 0, 0, sourceWidth, sourceHeight); bitmap.close();
  const source = { width: sourceWidth, height: sourceHeight, data: sourceContext.getImageData(0, 0, sourceWidth, sourceHeight).data };
  sourceCanvas.width = sourceCanvas.height = 1;
  const targetRatio = Math.min(1, processedSide / Math.max(target.width, target.height));
  const targetWidth = Math.max(1, Math.round(target.width * targetRatio)); const targetHeight = Math.max(1, Math.round(target.height * targetRatio));
  const options = gifProcessingOptions(settings); const palette = gifPalette(target); const lookup = makePaletteLookup(palette);
  const frames = []; let index = 0; let plan; let outline = 0; let detail = 0;
  const targetFrames = gifFrames(target);
  for (const frame of targetFrames) {
    const desired = { width: targetWidth, height: targetHeight, data: await resizeFrame(frame, targetWidth, targetHeight) };
    const encoded = await encodeImage(source, desired, { ...options, skipSimilarity: true });
    plan = encoded.plan;
    const indices = quantizeFrame(encoded.data, lookup); const visible = new Uint8ClampedArray(indices.length * 4);
    for (let pixel = 0; pixel < indices.length; pixel += 1) {
      const color = indices[pixel] * 3; const destination = pixel * 4;
      visible[destination] = palette[color]; visible[destination + 1] = palette[color + 1]; visible[destination + 2] = palette[color + 2]; visible[destination + 3] = 255;
    }
    const score = presetSimilarity(visible, encoded.targetImage.data, plan.outputWidth, plan.outputHeight);
    outline += score.outline; detail += score.detail;
    frames.push(gifFrameBlock(indices, {
      width: plan.outputWidth, height: plan.outputHeight, delay: frame.delay < 2 ? 10 : frame.delay, minimum: 8, palette: null, disposal: 1,
    }));
    index += 1;
    if ((index & 3) === 0 || index === target.frames.length) progress({ label: `按 GIF 预设适配静态原图 ${index}/${target.frames.length}`, fraction: 0.05 + index / target.frames.length * 0.82 });
  }
  const packedOriginal = await compressGifBytes(original); const useCompression = packedOriginal.length < original.length;
  const transformed = concatBytes([gifHeader(plan.outputWidth, plan.outputHeight, palette, target.loop), gifPayloadBlock(original.length, useCompression ? packedOriginal : original, useCompression, mime), ...frames, Uint8Array.of(0x3b)]);
  const blob = new Blob([transformed], { type: 'image/gif' });
  const result = {
    jpg: blob, gif: blob, isGif: true, originalMime: mime, restoreWidth, restoreHeight,
    plan: { ...plan, panels: 1, step: 0, coordinateBits: 8 }, quality: settings.quality,
    resemblance: { outline: outline / target.frames.length, detail: detail / target.frames.length }, restoredSSIM: 1, corrected: 0, warning: null,
    sourcePreview: file, restoredPreview: file, targetPreview: new Blob([targetGif], { type: 'image/gif' }), targetWidth, targetHeight,
    gifFrames: target.frames.length, targetFrames: target.frames.length, originalBytes: original.length, sourceWidth, sourceHeight,
  };
  progress({ label: 'GIF 混淆完成 · 原图可精确还原', fraction: 1 });
  return result;
}

async function restoreEmbeddedImage(file) {
  const original = new Uint8Array(await file.arrayBuffer()); const encoded = parseGif(original); const payload = embeddedImagePayload(encoded);
  if (!payload) return null;
  const restored = await decompressGifBytes(payload.compressed, payload.size, payload.raw); const blob = new Blob([restored], { type: payload.mime });
  let dimensions;
  if (payload.mime === 'image/gif') {
    if (!isGif(restored)) throw new Error('内嵌 GIF 原图校验失败。');
    const gif = parseGif(restored); dimensions = { width: gif.width, height: gif.height };
  } else {
    const bitmap = await createImageBitmap(blob); dimensions = { width: bitmap.width, height: bitmap.height }; bitmap.close();
  }
  return { blob, mime: payload.mime, isGif: payload.mime === 'image/gif', plan: dimensions, originalBytes: restored.length };
}

async function encodeFile({ file, settings, target, targetGif, cached, compactPreview }, progress) {
  const start = performance.now();
  if (isGif(new Uint8Array(await file.slice(0, 6).arrayBuffer()))) return encodeGifFile({ file, targetGif, target, settings }, progress);
  if (targetGif) return encodeStillAsGifFile({ file, targetGif, settings }, progress);
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
      if (file.type === 'image/gif' || isGif(new Uint8Array(await file.slice(0, 6).arrayBuffer()))) {
        const restoredImage = await restoreEmbeddedImage(file);
        if (restoredImage) {
          onProgress({ label: '内嵌原图精确还原完成', fraction: 1 });
          self.postMessage({ id, type: 'result', result: restoredImage });
          return;
        }
      }
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
