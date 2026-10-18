// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeRS, decodeRS, crc32 } from './reed-solomon.mjs';

export const FORMAT_VERSION = 5;
const VERSION = FORMAT_VERSION;
const HEADER_BYTES = 24;
const HEADER_REPEATS = 7;
const HEADER_CARRIERS = HEADER_BYTES * 8 * HEADER_REPEATS;
const HEADER_STEP = 72;
const RS_DATA = 159;
const RS_PARITY = 96;
const FREQUENCIES = [];
for (let sum = 1; sum <= 14; sum += 1) {
  for (let u = 0; u < 8; u += 1) {
    const v = sum - u;
    if (v >= 0 && v < 8) FREQUENCIES.push([u, v]);
  }
}
const BASIS = FREQUENCIES.map(([u, v]) => Float64Array.from({ length: 64 }, (_, index) =>
  ((u ? 1 : Math.SQRT1_2) * (v ? 1 : Math.SQRT1_2) / 4) *
  Math.cos(((2 * (index & 7) + 1) * u * Math.PI) / 16) *
  Math.cos(((2 * (index >> 3) + 1) * v * Math.PI) / 16)));
const JPEG_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function createPlan(width, height, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new Error('图像尺寸无效。');
  }
  const tileSize = Number(options.tileSize ?? 8);
  const requestedScale = Number(options.scale ?? 2);
  const scale = Math.min(width, height) < 64 ? Math.max(3, requestedScale) : requestedScale;
  const colorAdapt = options.colorAdapt !== false;
  const colorGain = colorAdapt ? Number(options.colorGain ?? 0.75) : 1;
  if (![1, 0.75, 0.5].includes(colorGain)) throw new Error('块内细节保留系数应为 1、0.75 或 0.5。');
  if (![8, 16, 32].includes(tileSize)) throw new Error('分块边长应为 8、16 或 32 像素。');
  if (![1, 2, 3].includes(requestedScale)) throw new Error('载体倍率应为 1、2 或 3。');
  // Small/narrow images are padded, never silently cropped or resampled.
  const outputTileSize = tileSize * scale;
  const outputWidth = Math.ceil(Math.max(width, 64) / tileSize) * outputTileSize;
  const outputHeight = Math.ceil(Math.max(height, 64) / tileSize) * outputTileSize;
  const columns = outputWidth / outputTileSize;
  const rows = outputHeight / outputTileSize;
  const tileCount = columns * rows;
  const coordinateBits = Math.ceil(Math.log2(tileCount));
  const payloadBits = coordinateBits + (colorAdapt ? 18 : 0);
  const payloadBytes = Math.ceil(tileCount * payloadBits / 8);
  const codeBlocks = Math.ceil(payloadBytes / RS_DATA);
  const encodedBytes = codeBlocks * (RS_DATA + RS_PARITY);
  const blockCount = outputWidth * outputHeight / 64;
  const frequencyCount = [8, 16, 24, 32, 40, 48, 56, 63].find((count) => count * blockCount >= encodedBytes * 8 + HEADER_CARRIERS);
  if (!frequencyCount) throw new Error('图片太小，无法容纳细分块坐标与纠错信息；请换用更大图片。');
  return { width, height, outputWidth, outputHeight, tileSize, outputTileSize, scale, colorAdapt, colorGain, columns, rows, tileCount, coordinateBits, payloadBits, payloadBytes, codeBlocks, encodedBytes, blockCount, frequencyCount };
}

export function flattenImage(image, background = [255, 255, 255]) {
  const data = new Uint8ClampedArray(image.data.length);
  let transparentPixels = 0;
  for (let pixel = 0; pixel < data.length; pixel += 4) {
    const alpha = image.data[pixel + 3] / 255;
    if (alpha < 1) transparentPixels += 1;
    for (let channel = 0; channel < 3; channel += 1) data[pixel + channel] = image.data[pixel + channel] * alpha + background[channel] * (1 - alpha);
    data[pixel + 3] = 255;
  }
  return { width: image.width, height: image.height, data, transparentPixels };
}

export function fitImage(image, width, height, mode = 'contain') {
  if (!['contain', 'cover', 'stretch'].includes(mode)) throw new Error('未知的预设适配模式。');
  const input = flattenImage(image);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const scale = mode === 'cover' ? Math.max(width / image.width, height / image.height) : Math.min(width / image.width, height / image.height);
  const drawWidth = mode === 'stretch' ? width : image.width * scale;
  const drawHeight = mode === 'stretch' ? height : image.height * scale;
  const left = (width - drawWidth) / 2;
  const top = (height - drawHeight) / 2;
  for (let y = 0; y < height; y += 1) {
    if (y + 0.5 < top || y + 0.5 >= top + drawHeight) continue;
    const sy = clamp((y + 0.5 - top) * image.height / drawHeight - 0.5, 0, image.height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    for (let x = 0; x < width; x += 1) {
      if (x + 0.5 < left || x + 0.5 >= left + drawWidth) continue;
      const sx = clamp((x + 0.5 - left) * image.width / drawWidth - 0.5, 0, image.width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const pixel = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const a = input.data[(y0 * image.width + x0) * 4 + c] * (1 - fx) + input.data[(y0 * image.width + x1) * 4 + c] * fx;
        const b = input.data[(y1 * image.width + x0) * 4 + c] * (1 - fx) + input.data[(y1 * image.width + x1) * 4 + c] * fx;
        data[pixel + c] = a * (1 - fy) + b * fy;
      }
    }
  }
  return { width, height, data };
}

function padSource(source, plan) {
  const output = new Uint8ClampedArray(plan.outputWidth * plan.outputHeight * 4);
  for (let y = 0; y < plan.outputHeight; y += 1) {
    for (let x = 0; x < plan.outputWidth; x += 1) {
      const from = (Math.min(Math.floor(y / plan.scale), source.height - 1) * source.width + Math.min(Math.floor(x / plan.scale), source.width - 1)) * 4;
      output.set(source.data.subarray(from, from + 4), (y * plan.outputWidth + x) * 4);
    }
  }
  return output;
}

function tileFeatures(data, plan) {
  const features = new Float32Array(plan.tileCount * 3);
  const { outputWidth: width, outputTileSize: tileSize, columns } = plan;
  for (let tile = 0; tile < plan.tileCount; tile += 1) {
    const tx = tile % columns * tileSize;
    const ty = Math.floor(tile / columns) * tileSize;
    let r = 0; let g = 0; let b = 0;
    for (let y = 0; y < tileSize; y += 1) {
      let pixel = ((ty + y) * width + tx) * 4;
      for (let x = 0; x < tileSize; x += 1, pixel += 4) { r += data[pixel]; g += data[pixel + 1]; b += data[pixel + 2]; }
    }
    const count = tileSize ** 2;
    // Opponent coordinates: emphasize luminance while retaining actual color.
    features[tile * 3] = (0.299 * r + 0.587 * g + 0.114 * b) / count;
    features[tile * 3 + 1] = (r - g) * 0.55 / count;
    features[tile * 3 + 2] = (b - g) * 0.55 / count;
  }
  return features;
}

function matchTiles(source, target, plan) {
  const a = tileFeatures(source, plan);
  const b = tileFeatures(target, plan);
  const mapping = new Uint32Array(plan.tileCount);
  // Balanced recursive color partition avoids discontinuities of Morton ordering.
  function partition(sourceIds, targetIds) {
    if (sourceIds.length === 1) { mapping[targetIds[0]] = sourceIds[0]; return; }
    let axis = 0; let best = -1;
    for (let c = 0; c < 3; c += 1) {
      let lowA = Infinity; let highA = -Infinity; let lowB = Infinity; let highB = -Infinity;
      for (let i = 0; i < sourceIds.length; i += 1) {
        const va = a[sourceIds[i] * 3 + c]; const vb = b[targetIds[i] * 3 + c];
        lowA = Math.min(lowA, va); highA = Math.max(highA, va); lowB = Math.min(lowB, vb); highB = Math.max(highB, vb);
      }
      const range = (highA - lowA) * (highB - lowB);
      if (range > best) { axis = c; best = range; }
    }
    sourceIds.sort((i, j) => a[i * 3 + axis] - a[j * 3 + axis] || i - j);
    targetIds.sort((i, j) => b[i * 3 + axis] - b[j * 3 + axis] || i - j);
    const middle = Math.floor(sourceIds.length / 2);
    partition(sourceIds.slice(0, middle), targetIds.slice(0, middle));
    partition(sourceIds.slice(middle), targetIds.slice(middle));
  }
  const ids = Array.from({ length: plan.tileCount }, (_, i) => i);
  partition(ids.slice(), ids);
  return mapping;
}

function writeTile(source, output, from, to, plan) {
  const { outputWidth: width, columns, outputTileSize: tileSize } = plan;
  for (let y = 0; y < tileSize; y += 1) {
    const start = ((Math.floor(from / columns) * tileSize + y) * width + from % columns * tileSize) * 4;
    const destination = ((Math.floor(to / columns) * tileSize + y) * width + to % columns * tileSize) * 4;
    output.set(source.subarray(start, start + tileSize * 4), destination);
  }
}

function adaptTile(data, target, tile, plan) {
  const { outputWidth: width, outputTileSize: size, columns } = plan;
  const tx = tile % columns * size;
  const ty = Math.floor(tile / columns) * size;
  const sum = [0, 0, 0]; const desired = [0, 0, 0];
  const low = [255, 255, 255]; const high = [0, 0, 0];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const p = ((ty + y) * width + tx + x) * 4;
    for (let c = 0; c < 3; c += 1) {
      sum[c] += data[p + c]; desired[c] += target[p + c];
      low[c] = Math.min(low[c], data[p + c]); high[c] = Math.max(high[c], data[p + c]);
    }
  }
  // Six bits per source channel also remove DC drift on restoration. A compact
  // mean is preferable to six more dense watermark coefficients in every tile.
  const means = sum.map((value) => Math.round(value / (size * size) * 63 / 255));
  const offsets = sum.map((value, c) => clamp((desired[c] - plan.colorGain * value) / (size * size), -low[c] * plan.colorGain, 255 - high[c] * plan.colorGain));
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const p = ((ty + y) * width + tx + x) * 4;
    for (let c = 0; c < 3; c += 1) data[p + c] = data[p + c] * plan.colorGain + offsets[c];
  }
  return means;
}

function makeHeader(plan, step, checksum) {
  const bytes = new Uint8Array(HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4e, 0x57, VERSION, plan.tileSize, step, plan.frequencyCount]);
  view.setUint16(6, plan.width, true);
  view.setUint16(8, plan.height, true);
  view.setUint32(10, checksum, true);
  view.setUint32(14, plan.payloadBytes, true);
  bytes[18] = plan.scale;
  bytes[19] = plan.colorAdapt ? 1 + [1, 0.75, 0.5].indexOf(plan.colorGain) * 2 : 0;
  view.setUint32(20, crc32(bytes.subarray(0, 20)), true);
  return bytes;
}

function parseHeader(bytes, width, height) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x4e || bytes[1] !== 0x57 || bytes[2] !== VERSION || view.getUint32(20, true) !== crc32(bytes.subarray(0, 20))) {
    throw new Error('没有找到有效的新版 Naiwa 坐标信息；文件可能被缩放、裁切或过度压缩。');
  }
  const plan = createPlan(view.getUint16(6, true), view.getUint16(8, true), { tileSize: bytes[3], scale: bytes[18], colorAdapt: Boolean(bytes[19] & 1), colorGain: [1, 0.75, 0.5][bytes[19] >> 1] });
  if (plan.outputWidth !== width || plan.outputHeight !== height || plan.frequencyCount !== bytes[5] || plan.payloadBytes !== view.getUint32(14, true) || bytes[4] < 4 || bytes[4] > 96) {
    throw new Error('图像尺寸或坐标参数校验失败。');
  }
  return { plan, step: bytes[4], checksum: view.getUint32(10, true) };
}

function coordinateBytes(mapping, colorMeans, plan) {
  const bytes = new Uint8Array(plan.payloadBytes);
  for (let i = 0; i < mapping.length; i += 1) {
    for (let bit = 0; bit < plan.coordinateBits; bit += 1) {
      const offset = i * plan.payloadBits + bit;
      bytes[offset >> 3] |= ((mapping[i] >>> bit) & 1) << (offset & 7);
    }
    if (plan.colorAdapt) for (let c = 0; c < 3; c += 1) for (let bit = 0; bit < 6; bit += 1) {
      const offset = i * plan.payloadBits + plan.coordinateBits + c * 6 + bit;
      bytes[offset >> 3] |= ((colorMeans[i * 3 + c] >>> bit) & 1) << (offset & 7);
    }
  }
  return bytes;
}

function protectPayload(payload, plan) {
  const bytes = new Uint8Array(plan.encodedBytes);
  for (let block = 0; block < plan.codeBlocks; block += 1) {
    const chunk = new Uint8Array(RS_DATA);
    chunk.set(payload.subarray(block * RS_DATA, (block + 1) * RS_DATA));
    const code = encodeRS(chunk, RS_PARITY);
    // Byte interleaving distributes local damage over independent RS blocks.
    for (let i = 0; i < 255; i += 1) bytes[i * plan.codeBlocks + block] = code[i];
  }
  return bytes;
}

function unprotectPayload(bytes, plan) {
  const payload = new Uint8Array(plan.codeBlocks * RS_DATA);
  let corrected = 0;
  for (let block = 0; block < plan.codeBlocks; block += 1) {
    const code = Uint8Array.from({ length: 255 }, (_, i) => bytes[i * plan.codeBlocks + block]);
    const decoded = decodeRS(code, RS_PARITY);
    payload.set(decoded.data, block * RS_DATA);
    corrected += decoded.corrected;
  }
  return { payload: payload.slice(0, plan.payloadBytes), corrected };
}

// Bootstrap uses one low frequency per DCT block, then another pass if needed.
function headerSlot(block, frequency, blockCount) {
  const slot = frequency * blockCount + block;
  return slot < HEADER_CARRIERS ? slot : -1;
}

function frequencyStep(frequency, strength) {
  const [u, v] = FREQUENCIES[frequency];
  return strength * Math.max(1, JPEG_LUMA[v * 8 + u] / 16);
}

async function watermark(data, plan, step, header, payload, read, onProgress) {
  const headerVotes = new Uint8Array(HEADER_BYTES * 8);
  const extracted = read ? new Uint8Array(plan.encodedBytes) : null;
  const block = new Float64Array(64);
  const changes = new Float64Array(64);
  const width = plan.outputWidth;
  const blocksAcross = width / 8;
  let payloadBit = 0;
  const totalBits = plan.encodedBytes * 8;
  for (let index = 0; index < plan.blockCount; index += 1) {
    const x = index % blocksAcross * 8;
    const y = Math.floor(index / blocksAcross) * 8;
    for (let p = 0; p < 64; p += 1) {
      const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
      block[p] = 0.299 * data[pixel] + 0.587 * data[pixel + 1] + 0.114 * data[pixel + 2];
    }
    if (!read) changes.fill(0);
    for (let f = 0; f < plan.frequencyCount; f += 1) {
      const slot = headerSlot(index, f, plan.blockCount);
      if (slot < 0 && payloadBit >= totalBits) continue;
      const basis = BASIS[f];
      let coefficient = 0;
      for (let p = 0; p < 64; p += 1) coefficient += block[p] * basis[p];
      const quantization = slot >= 0 ? HEADER_STEP : frequencyStep(f, step);
      const bitIndex = slot >= 0 ? Math.floor(slot / HEADER_REPEATS) : payloadBit;
      if (read) {
        const bit = ((Math.round(coefficient / quantization) % 2) + 2) % 2;
        if (slot >= 0) headerVotes[bitIndex] += bit;
        else extracted[bitIndex >> 3] |= bit << (bitIndex & 7);
      } else {
        const bytes = slot >= 0 ? header : payload;
        const bit = (bytes[bitIndex >> 3] >> (bitIndex & 7)) & 1;
        const target = Math.round((coefficient - bit * quantization) / (2 * quantization)) * 2 * quantization + bit * quantization;
        const delta = target - coefficient;
        for (let p = 0; p < 64; p += 1) changes[p] += delta * basis[p];
      }
      if (slot < 0) payloadBit += 1;
    }
    if (!read) {
      // Shift the whole block only as much as required to avoid RGB clipping.
      let lower = -Infinity; let upper = Infinity;
      for (let p = 0; p < 64; p += 1) {
        const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
        for (let c = 0; c < 3; c += 1) {
          lower = Math.max(lower, -data[pixel + c] - changes[p]);
          upper = Math.min(upper, 255 - data[pixel + c] - changes[p]);
        }
      }
      const shift = lower <= upper ? clamp(0, lower, upper) : (lower + upper) / 2;
      for (let p = 0; p < 64; p += 1) {
        const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
        for (let c = 0; c < 3; c += 1) data[pixel + c] += changes[p] + shift;
      }
    }
    if ((index & 4095) === 4095) {
      onProgress?.({ label: read ? '读取纠错坐标' : '写入纠错坐标', fraction: (index + 1) / plan.blockCount });
      await pause();
    }
  }
  const headerBytes = new Uint8Array(HEADER_BYTES);
  for (let bit = 0; bit < headerVotes.length; bit += 1) if (headerVotes[bit] > HEADER_REPEATS / 2) headerBytes[bit >> 3] |= 1 << (bit & 7);
  return { header: headerBytes, payload: extracted };
}

function readHeader(image) {
  const { width, height, data } = image;
  if (width % 8 || height % 8) throw new Error('混淆图尺寸必须保持完整的 8 像素网格。');
  const blockCount = width * height / 64;
  const votes = new Uint8Array(HEADER_BYTES * 8);
  for (let slot = 0; slot < HEADER_CARRIERS; slot += 1) {
    const block = slot % blockCount;
    const frequency = Math.floor(slot / blockCount);
    if (!BASIS[frequency]) throw new Error('图像过小，无法读取坐标。');
    const x = block % (width / 8) * 8;
    const y = Math.floor(block / (width / 8)) * 8;
    let coefficient = 0;
    for (let p = 0; p < 64; p += 1) {
      const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
      coefficient += (0.299 * data[pixel] + 0.587 * data[pixel + 1] + 0.114 * data[pixel + 2]) * BASIS[frequency][p];
    }
    votes[Math.floor(slot / HEADER_REPEATS)] += ((Math.round(coefficient / HEADER_STEP) % 2) + 2) % 2;
  }
  const bytes = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < votes.length; i += 1) if (votes[i] > HEADER_REPEATS / 2) bytes[i >> 3] |= 1 << (i & 7);
  return parseHeader(bytes, width, height);
}

export async function encodeImage(source, preset, options = {}) {
  const plan = createPlan(source.width, source.height, options);
  const step = clamp(Math.round(options.step ?? 16), 4, 96);
  const flattened = flattenImage(source);
  const padded = padSource(flattened, plan);
  const target = fitImage(preset, plan.outputWidth, plan.outputHeight, options.fit ?? 'contain');
  options.onProgress?.({ label: '按颜色与轮廓匹配细分块', fraction: 0 });
  await pause();
  const mapping = matchTiles(padded, target.data, plan);
  const output = new Uint8ClampedArray(padded.length);
  const colorMeans = new Uint8Array(plan.tileCount * 3);
  for (let i = 0; i < plan.tileCount; i += 1) {
    writeTile(padded, output, mapping[i], i, plan);
    if (plan.colorAdapt) colorMeans.set(adaptTile(output, target.data, i, plan), i * 3);
  }
  const payload = coordinateBytes(mapping, colorMeans, plan);
  const header = makeHeader(plan, step, crc32(payload));
  await watermark(output, plan, step, header, protectPayload(payload, plan), false, options.onProgress);
  const resemblance = presetSimilarity(output, target.data, plan.outputWidth, plan.outputHeight);
  return { data: output, plan: { ...plan, step, fit: options.fit ?? 'contain', transparentPixels: flattened.transparentPixels }, resemblance };
}

export async function restoreImage(image, options = {}) {
  const { plan, step, checksum } = readHeader(image);
  const extracted = await watermark(image.data, plan, step, null, null, true, options.onProgress);
  const { payload, corrected } = unprotectPayload(extracted.payload, plan);
  if (crc32(payload) !== checksum) throw new Error('坐标校验失败，无法可靠还原。');
  const seen = new Uint8Array(plan.tileCount);
  const output = new Uint8ClampedArray(image.data.length);
  for (let tile = 0; tile < plan.tileCount; tile += 1) {
    let original = 0;
    for (let bit = 0; bit < plan.coordinateBits; bit += 1) {
      const offset = tile * plan.payloadBits + bit;
      original |= ((payload[offset >> 3] >>> (offset & 7)) & 1) << bit;
    }
    if (original >= plan.tileCount || seen[original]) throw new Error('坐标排列校验失败。');
    seen[original] = 1;
    writeTile(image.data, output, tile, original, plan);
    if (plan.colorAdapt) {
      const means = new Uint8Array(3);
      for (let c = 0; c < 3; c += 1) for (let bit = 0; bit < 6; bit += 1) {
        const offset = tile * plan.payloadBits + plan.coordinateBits + c * 6 + bit;
        means[c] |= ((payload[offset >> 3] >>> (offset & 7)) & 1) << bit;
      }
      const size = plan.outputTileSize;
      const tx = original % plan.columns * size;
      const ty = Math.floor(original / plan.columns) * size;
      const actualMeans = [0, 0, 0];
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
        const p = ((ty + y) * plan.outputWidth + tx + x) * 4;
        for (let c = 0; c < 3; c += 1) actualMeans[c] += output[p + c] / (size * size);
      }
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
        const p = ((ty + y) * plan.outputWidth + tx + x) * 4;
        for (let c = 0; c < 3; c += 1) output[p + c] = (output[p + c] - actualMeans[c]) / plan.colorGain + means[c] * 255 / 63;
      }
    }
  }
  const cropped = new Uint8ClampedArray(plan.width * plan.height * 4);
  for (let y = 0; y < plan.height; y += 1) for (let x = 0; x < plan.width; x += 1) {
    const destination = (y * plan.width + x) * 4;
    for (let c = 0; c < 3; c += 1) {
      let total = 0;
      for (let dy = 0; dy < plan.scale; dy += 1) for (let dx = 0; dx < plan.scale; dx += 1) total += output[((y * plan.scale + dy) * plan.outputWidth + x * plan.scale + dx) * 4 + c];
      cropped[destination + c] = total / (plan.scale ** 2);
    }
    cropped[destination + 3] = 255;
  }
  return { data: cropped, plan: { ...plan, step, corrected } };
}

function samples(data, width, height, maxDimension, rgb) {
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / maxDimension));
  const sw = Math.ceil(width / scale); const sh = Math.ceil(height / scale);
  const channels = rgb ? 3 : 1;
  const values = new Float64Array(sw * sh * channels);
  const counts = new Uint32Array(sw * sh);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const sample = Math.floor(y / scale) * sw + Math.floor(x / scale);
      const alpha = data[offset + 3] / 255;
      if (rgb) {
        for (let c = 0; c < 3; c += 1) values[sample * 3 + c] += data[offset + c] * alpha + 255 * (1 - alpha);
      } else values[sample] += (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) * alpha + 255 * (1 - alpha);
      counts[sample] += 1;
    }
  }
  for (let i = 0; i < counts.length; i += 1) for (let c = 0; c < channels; c += 1) values[i * channels + c] /= counts[i];
  return { values, width: sw, height: sh, channels };
}

export function imageSimilarity(first, second, width, height, maxDimension = 512, rgb = false) {
  if (first.length !== width * height * 4 || second.length !== first.length) throw new Error('SSIM 图像尺寸不一致。');
  const a = samples(first, width, height, maxDimension, rgb);
  const b = samples(second, width, height, maxDimension, rgb);
  const c1 = (0.01 * 255) ** 2; const c2 = (0.03 * 255) ** 2;
  let score = 0; let windows = 0;
  for (let top = 0; top < a.height; top += 8) {
    for (let left = 0; left < a.width; left += 8) {
      for (let c = 0; c < a.channels; c += 1) {
        let n = 0; let sumA = 0; let sumB = 0; let aa = 0; let bb = 0; let ab = 0;
        for (let y = top; y < Math.min(top + 8, a.height); y += 1) for (let x = left; x < Math.min(left + 8, a.width); x += 1) {
          const index = (y * a.width + x) * a.channels + c;
          const va = a.values[index]; const vb = b.values[index];
          n += 1; sumA += va; sumB += vb; aa += va * va; bb += vb * vb; ab += va * vb;
        }
        const ma = sumA / n; const mb = sumB / n;
        const divisor = Math.max(1, n - 1);
        const va = Math.max(0, (aa - n * ma * ma) / divisor);
        const vb = Math.max(0, (bb - n * mb * mb) / divisor);
        const covariance = (ab - n * ma * mb) / divisor;
        score += ((2 * ma * mb + c1) * (2 * covariance + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
        windows += 1;
      }
    }
  }
  return score / windows;
}

export function presetSimilarity(image, target, width, height) {
  return {
    outline: imageSimilarity(image, target, width, height, 64, true),
    detail: imageSimilarity(image, target, width, height, 512, true),
  };
}
