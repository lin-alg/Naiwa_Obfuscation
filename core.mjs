// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeRS, decodeRS, crc32 } from './reed-solomon.mjs';

export const FORMAT_VERSION = 6;
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
const DCT_COS = Array.from({ length: 8 }, (_, frequency) => Float64Array.from({ length: 8 }, (_, position) =>
  Math.cos(((2 * position + 1) * frequency * Math.PI) / 16)));
const DCT_NORM = Float64Array.from({ length: 8 }, (_, frequency) => frequency ? 1 : Math.SQRT1_2);
function transformRow(input, offset, output, mask) {
  // Symmetric sample pairs share work across the requested DCT frequencies.
  // DC needs no multiplies, frequencies 2/6 need two, and 4 needs one.
  const a = input[offset]; const b = input[offset + 1]; const c = input[offset + 2]; const d = input[offset + 3];
  const e = input[offset + 4]; const f = input[offset + 5]; const g = input[offset + 6]; const h = input[offset + 7];
  const s0 = a + h; const s1 = b + g; const s2 = c + f; const s3 = d + e;
  const d0 = a - h; const d1 = b - g; const d2 = c - f; const d3 = d - e;
  if (mask & 1) output[offset] = s0 + s1 + s2 + s3;
  if (mask & 2) output[offset + 1] = d0 * DCT_COS[1][0] + d1 * DCT_COS[1][1] + d2 * DCT_COS[1][2] + d3 * DCT_COS[1][3];
  if (mask & 4) output[offset + 2] = (s0 - s3) * DCT_COS[2][0] + (s1 - s2) * DCT_COS[2][1];
  if (mask & 8) output[offset + 3] = d0 * DCT_COS[3][0] + d1 * DCT_COS[3][1] + d2 * DCT_COS[3][2] + d3 * DCT_COS[3][3];
  if (mask & 16) output[offset + 4] = (s0 - s1 - s2 + s3) * DCT_COS[4][0];
  if (mask & 32) output[offset + 5] = d0 * DCT_COS[5][0] + d1 * DCT_COS[5][1] + d2 * DCT_COS[5][2] + d3 * DCT_COS[5][3];
  if (mask & 64) output[offset + 6] = (s0 - s3) * DCT_COS[6][0] + (s1 - s2) * DCT_COS[6][1];
  if (mask & 128) output[offset + 7] = d0 * DCT_COS[7][0] + d1 * DCT_COS[7][1] + d2 * DCT_COS[7][2] + d3 * DCT_COS[7][3];
}

function projectColumn(input, u, v) {
  const a = input[u]; const b = input[8 + u]; const c = input[16 + u]; const d = input[24 + u];
  const e = input[32 + u]; const f = input[40 + u]; const g = input[48 + u]; const h = input[56 + u];
  if (v & 1) return (a - h) * DCT_COS[v][0] + (b - g) * DCT_COS[v][1] + (c - f) * DCT_COS[v][2] + (d - e) * DCT_COS[v][3];
  if (!v) return a + h + b + g + c + f + d + e;
  if (v === 4) return (a + h - b - g - c - f + d + e) * DCT_COS[4][0];
  return (a + h - d - e) * DCT_COS[v][0] + (b + g - c - f) * DCT_COS[v][1];
}
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
// Workers can post progress without yielding their CPU thread. Browser timer
// clamping otherwise adds hundreds of milliseconds to each large image pass.
const pause = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope
  ? () => Promise.resolve()
  : () => new Promise((resolve) => setTimeout(resolve, 0));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function createPlan(width, height, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new Error('图像尺寸无效。');
  }
  const version = options.version ?? VERSION;
  const tileSize = Number(options.tileSize ?? 8);
  const requestedScale = Number(options.scale ?? 2);
  const scale = Math.min(width, height) < 64 ? Math.max(3, requestedScale) : requestedScale;
  const colorAdapt = options.colorAdapt !== false;
  const colorGain = colorAdapt ? Number(options.colorGain ?? 0.75) : 1;
  if (![1, 0.75, 0.5, 0.25].includes(colorGain)) throw new Error('块内细节保留系数应为 100%、75%、50% 或 25%。');
  if (version === 5 ? ![4, 8, 16, 32].includes(tileSize) : !Number.isInteger(tileSize) || tileSize < 2 || (tileSize > 16 && tileSize !== 32)) {
    throw new Error(version === 5 ? '旧版分块边长应为 4、8、16 或 32 像素。' : '分块边长应为 2 到 16 像素的整数。');
  }
  const validScale = version === 5
    ? [1, 2, 3]
    : Array.from({ length: 15 }, (_, index) => (index + 2) / 2);
  if (!validScale.includes(requestedScale)) throw new Error(version === 5 ? '旧版载体倍率应为 1、2 或 3。' : '载体倍率应为 1 到 8 倍、每次 0.5 倍。');
  // Small/narrow images are padded, never silently cropped or resampled.
  // A half-step carrier can produce a fractional tile for odd-sized source
  // blocks. Round the actual pixel tile and use the derived ratio everywhere
  // else so every integer tile size remains selectable.
  const outputTileSize = Math.max(1, Math.round(tileSize * scale));
  const pixelScale = outputTileSize / tileSize;
  let divisor = outputTileSize; let remainder = 8;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  const alignment = 8 / divisor;
  const outputWidth = Math.ceil(Math.max(width, 64) / tileSize / alignment) * alignment * outputTileSize;
  const outputHeight = Math.ceil(Math.max(height, 64) / tileSize / alignment) * alignment * outputTileSize;
  const columns = outputWidth / outputTileSize;
  const rows = outputHeight / outputTileSize;
  const tileCount = columns * rows;
  const aspect = Math.max(columns, rows) / Math.min(columns, rows);
  const panels = version === 5 ? 1 : Number(options.panels ?? (aspect > 3 ? Math.min(32, Math.round(aspect)) : 1));
  if (!Number.isInteger(panels) || panels < 1 || panels > Math.min(32, Math.max(columns, rows))) throw new Error('分段数量无效。');
  const coordinateBits = Math.ceil(Math.log2(tileCount));
  const payloadBits = coordinateBits + (colorAdapt ? 18 : 0);
  const payloadBytes = Math.ceil(tileCount * payloadBits / 8);
  const codeBlocks = Math.ceil(payloadBytes / RS_DATA);
  const encodedBytes = codeBlocks * (RS_DATA + RS_PARITY);
  const blockCount = outputWidth * outputHeight / 64;
  const frequencyCount = [8, 16, 24, 32, 40, 48, 56, 63].find((count) => count * blockCount >= encodedBytes * 8 + HEADER_CARRIERS);
  if (!frequencyCount) throw new Error('图片太小，无法容纳细分块坐标与纠错信息；请换用更大图片。');
  return { version, width, height, outputWidth, outputHeight, tileSize, outputTileSize, scale, pixelScale, colorAdapt, colorGain, panels, columns, rows, tileCount, coordinateBits, payloadBits, payloadBytes, codeBlocks, encodedBytes, blockCount, frequencyCount };
}

export function flattenImage(image, background = [255, 255, 255]) {
  const data = new Uint8ClampedArray(image.data.length);
  let transparentPixels = 0;
  for (let pixel = 0; pixel < data.length; pixel += 4) {
    const opacity = image.data[pixel + 3];
    if (opacity === 255) {
      data[pixel] = image.data[pixel]; data[pixel + 1] = image.data[pixel + 1]; data[pixel + 2] = image.data[pixel + 2];
    } else {
      transparentPixels += 1;
      const alpha = opacity / 255; const matte = 1 - alpha;
      data[pixel] = image.data[pixel] * alpha + background[0] * matte;
      data[pixel + 1] = image.data[pixel + 1] * alpha + background[1] * matte;
      data[pixel + 2] = image.data[pixel + 2] * alpha + background[2] * matte;
    }
    data[pixel + 3] = 255;
  }
  return { width: image.width, height: image.height, data, transparentPixels };
}

export function fitImage(image, width, height, mode = 'contain', panels = 1) {
  if (!['contain', 'cover', 'stretch'].includes(mode)) throw new Error('未知的预设适配模式。');
  if (panels > 1) {
    const data = new Uint8ClampedArray(width * height * 4);
    const horizontal = width >= height;
    const length = horizontal ? width : height;
    for (let part = 0; part < panels; part += 1) {
      const start = Math.round(part * length / panels);
      const end = Math.round((part + 1) * length / panels);
      const fitted = fitImage(image, horizontal ? end - start : width, horizontal ? height : end - start, mode);
      for (let y = 0; y < fitted.height; y += 1) {
        const destination = ((horizontal ? y : y + start) * width + (horizontal ? start : 0)) * 4;
        data.set(fitted.data.subarray(y * fitted.width * 4, (y + 1) * fitted.width * 4), destination);
      }
    }
    return { width, height, data };
  }
  const input = image;
  const data = new Uint8ClampedArray(width * height * 4);
  const scale = mode === 'cover' ? Math.max(width / image.width, height / image.height) : Math.min(width / image.width, height / image.height);
  const drawWidth = mode === 'stretch' ? width : image.width * scale;
  const drawHeight = mode === 'stretch' ? height : image.height * scale;
  const left = (width - drawWidth) / 2;
  const top = (height - drawHeight) / 2;
  const x0s = new Int32Array(width).fill(-1); const x1s = new Int32Array(width); const fractions = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    if (x + 0.5 < left || x + 0.5 >= left + drawWidth) continue;
    const sx = clamp((x + 0.5 - left) * image.width / drawWidth - 0.5, 0, image.width - 1);
    const x0 = Math.floor(sx);
    x0s[x] = x0; x1s[x] = Math.min(image.width - 1, x0 + 1); fractions[x] = sx - x0;
  }
  for (let y = 0; y < height; y += 1) {
    if (y + 0.5 < top || y + 0.5 >= top + drawHeight) continue;
    const sy = clamp((y + 0.5 - top) * image.height / drawHeight - 0.5, 0, image.height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = x0s[x]; if (x0 < 0) continue;
      const x1 = x1s[x]; const fx = fractions[x];
      const fy = sy - y0;
      const pixel = (y * width + x) * 4;
      const p00 = (y0 * image.width + x0) * 4; const p10 = (y0 * image.width + x1) * 4;
      const p01 = (y1 * image.width + x0) * 4; const p11 = (y1 * image.width + x1) * 4;
      const w00 = (1 - fx) * (1 - fy); const w10 = fx * (1 - fy); const w01 = (1 - fx) * fy; const w11 = fx * fy;
      const alpha = input.data[p00 + 3] * w00 + input.data[p10 + 3] * w10 + input.data[p01 + 3] * w01 + input.data[p11 + 3] * w11;
      data[pixel + 3] = alpha;
      if (alpha > 0) for (let c = 0; c < 3; c += 1) {
        data[pixel + c] = (input.data[p00 + c] * input.data[p00 + 3] * w00 + input.data[p10 + c] * input.data[p10 + 3] * w10 + input.data[p01 + c] * input.data[p01 + 3] * w01 + input.data[p11 + c] * input.data[p11 + 3] * w11) / alpha;
      }
    }
  }
  return { width, height, data };
}

function padSource(source, plan) {
  const output = new Uint8ClampedArray(plan.outputWidth * plan.outputHeight * 4);
  const input = new Uint32Array(source.data.buffer, source.data.byteOffset, source.data.length / 4);
  const pixels = new Uint32Array(output.buffer);
  const xs = Uint32Array.from({ length: plan.outputWidth }, (_, x) => Math.min(Math.floor(x / plan.pixelScale), source.width - 1));
  for (let y = 0; y < plan.outputHeight; y += 1) {
    const row = Math.min(Math.floor(y / plan.pixelScale), source.height - 1) * source.width;
    for (let x = 0; x < plan.outputWidth; x += 1) {
      pixels[y * plan.outputWidth + x] = input[row + xs[x]];
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
  const tieBreakers = Uint32Array.from({ length: plan.tileCount }, (_, id) => {
    let value = Math.imul(id ^ (id >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return (value ^ (value >>> 16)) >>> 0;
  });
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
    // Flat preset backgrounds must not assign the palest source blocks only
    // to the bottom/right edge. Stable spatial mixing avoids visible bands.
    sourceIds.sort((i, j) => a[i * 3 + axis] - a[j * 3 + axis] || tieBreakers[i] - tieBreakers[j] || i - j);
    targetIds.sort((i, j) => b[i * 3 + axis] - b[j * 3 + axis] || tieBreakers[i] - tieBreakers[j] || i - j);
    const middle = Math.floor(sourceIds.length / 2);
    partition(sourceIds.slice(0, middle), targetIds.slice(0, middle));
    partition(sourceIds.slice(middle), targetIds.slice(middle));
  }
  const horizontal = plan.columns >= plan.rows;
  for (let part = 0; part < plan.panels; part += 1) {
    const length = horizontal ? plan.columns : plan.rows;
    const start = Math.round(part * length / plan.panels);
    const end = Math.round((part + 1) * length / plan.panels);
    const ids = [];
    for (let y = horizontal ? 0 : start; y < (horizontal ? plan.rows : end); y += 1) {
      for (let x = horizontal ? start : 0; x < (horizontal ? end : plan.columns); x += 1) ids.push(y * plan.columns + x);
    }
    partition(ids.slice(), ids);
  }
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
  bytes[18] = plan.scale * 2;
  bytes[19] = (plan.colorAdapt ? 1 + [1, 0.75, 0.5, 0.25].indexOf(plan.colorGain) * 2 : 0) | ((plan.panels - 1) << 3);
  view.setUint32(20, crc32(bytes.subarray(0, 20)), true);
  return bytes;
}

function parseHeader(bytes, width, height) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x4e || bytes[1] !== 0x57 || ![5, VERSION].includes(bytes[2]) || view.getUint32(20, true) !== crc32(bytes.subarray(0, 20))) {
    throw new Error('没有找到有效的新版 Naiwa 坐标信息；文件可能被缩放、裁切或过度压缩。');
  }
  const plan = createPlan(view.getUint16(6, true), view.getUint16(8, true), { version: bytes[2], tileSize: bytes[3], scale: bytes[18] / (bytes[2] >= 6 ? 2 : 1), panels: (bytes[19] >> 3) + 1, colorAdapt: Boolean(bytes[19] & 1), colorGain: [1, 0.75, 0.5, 0.25][(bytes[19] >> 1) & 3] });
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
function headerSlot(block, frequency, blockCount, version) {
  if (version >= 6) {
    const count = Math.min(blockCount, HEADER_CARRIERS - frequency * blockCount);
    if (count <= 0) return -1;
    const rank = Math.ceil(block * count / blockCount);
    return rank < count && Math.floor(rank * blockCount / count) === block ? frequency * blockCount + rank : -1;
  }
  const slot = frequency * blockCount + block;
  return slot < HEADER_CARRIERS ? slot : -1;
}

function frequencyStep(frequency, strength) {
  const [u, v] = FREQUENCIES[frequency];
  return strength * Math.max(1, JPEG_LUMA[v * 8 + u] / 16);
}

function bootstrapStep(blockCount, version) {
  return version >= 6 && blockCount < HEADER_CARRIERS ? 64 : HEADER_STEP;
}

async function watermark(data, plan, step, header, payload, read, onProgress) {
  const headerVotes = new Uint8Array(HEADER_BYTES * 8);
  const extracted = read ? new Uint8Array(plan.encodedBytes) : null;
  const block = new Float64Array(64);
  const changes = new Float64Array(64);
  const rowTransform = new Float64Array(64);
  const deltas = new Float64Array(64);
  const inverseRows = new Float64Array(64);
  const selected = new Int8Array(plan.frequencyCount);
  const bitIndices = new Int32Array(plan.frequencyCount);
  const slots = new Int32Array(plan.frequencyCount);
  const steps = Float64Array.from({ length: plan.frequencyCount }, (_, f) => frequencyStep(f, step));
  const width = plan.outputWidth;
  const blocksAcross = width / 8;
  let payloadBit = 0;
  const totalBits = plan.encodedBytes * 8;
  const payloadCapacity = plan.blockCount * plan.frequencyCount - HEADER_CARRIERS;
  let availableSlot = 0;
  for (let index = 0; index < plan.blockCount; index += 1) {
    let count = 0;
    let uMask = 0;
    let maxU = 0; let maxV = 0;
    for (let f = 0; f < plan.frequencyCount; f += 1) {
      const slot = headerSlot(index, f, plan.blockCount, plan.version);
      let bitIndex;
      if (read && slot >= 0) continue; // The bootstrap has already passed CRC.
      if (slot >= 0) bitIndex = Math.floor(slot / HEADER_REPEATS);
      else if (plan.version >= 6) {
        bitIndex = Math.ceil(availableSlot * totalBits / payloadCapacity);
        const used = bitIndex < totalBits && Math.floor(bitIndex * payloadCapacity / totalBits) === availableSlot;
        availableSlot += 1;
        if (!used) continue;
      } else {
        if (payloadBit >= totalBits) continue;
        bitIndex = payloadBit;
      }
      selected[count] = f; bitIndices[count] = bitIndex; slots[count] = slot;
      count += 1;
      uMask |= 1 << FREQUENCIES[f][0];
      maxU = Math.max(maxU, FREQUENCIES[f][0]); maxV = Math.max(maxV, FREQUENCIES[f][1]);
      if (slot < 0) payloadBit += 1;
    }
    if (!count) continue;
    const x = index % blocksAcross * 8;
    const y = Math.floor(index / blocksAcross) * 8;
    for (let p = 0; p < 64; p += 1) {
      const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
      block[p] = 0.299 * data[pixel] + 0.587 * data[pixel + 1] + 0.114 * data[pixel + 2];
    }
    // Sparse reading needs only the coefficients that actually carry bits.
    if (read) {
      for (let row = 0; row < 8; row += 1) transformRow(block, row * 8, rowTransform, uMask);
    } else {
      // Keep embedding's rounding at QIM boundaries compatible with v6.
      for (let row = 0; row < 8; row += 1) for (let u = 0; u < 8; u += 1) {
        if (!(uMask & (1 << u))) continue;
        let sum = 0; const offset = row * 8;
        for (let column = 0; column < 8; column += 1) sum += block[offset + column] * DCT_COS[u][column];
        rowTransform[offset + u] = sum;
      }
    }
    if (!read) { changes.fill(0); deltas.fill(0); }
    for (let i = 0; i < count; i += 1) {
      const f = selected[i]; const slot = slots[i]; const bitIndex = bitIndices[i];
      const [u, v] = FREQUENCIES[f];
      let sum = 0;
      if (read) sum = projectColumn(rowTransform, u, v);
      else for (let row = 0; row < 8; row += 1) sum += rowTransform[row * 8 + u] * DCT_COS[v][row];
      const coefficient = sum * DCT_NORM[u] * DCT_NORM[v] / 4;
      const quantization = slot >= 0 ? bootstrapStep(plan.blockCount, plan.version) : steps[f];
      if (read) {
        const bit = ((Math.round(coefficient / quantization) % 2) + 2) % 2;
        if (slot >= 0) headerVotes[bitIndex] += bit;
        else extracted[bitIndex >> 3] |= bit << (bitIndex & 7);
      } else {
        const bytes = slot >= 0 ? header : payload;
        const bit = (bytes[bitIndex >> 3] >> (bitIndex & 7)) & 1;
        const target = Math.round((coefficient - bit * quantization) / (2 * quantization)) * 2 * quantization + bit * quantization;
        const delta = target - coefficient;
        if (count <= 12) {
          const basis = BASIS[f];
          for (let p = 0; p < 64; p += 1) changes[p] += delta * basis[p];
        } else deltas[v * 8 + u] = delta * DCT_NORM[u] * DCT_NORM[v] / 4;
      }
    }
    if (!read) {
      // Dense blocks benefit from the separable inverse DCT; sparse blocks
      // above use direct projections to avoid doing more work than necessary.
      if (count > 12) {
        for (let v = 0; v <= maxV; v += 1) for (let px = 0; px < 8; px += 1) {
          let sum = 0;
          for (let u = 0; u <= maxU; u += 1) sum += deltas[v * 8 + u] * DCT_COS[u][px];
          inverseRows[v * 8 + px] = sum;
        }
        for (let py = 0; py < 8; py += 1) for (let px = 0; px < 8; px += 1) {
          let sum = 0;
          for (let v = 0; v <= maxV; v += 1) sum += inverseRows[v * 8 + px] * DCT_COS[v][py];
          changes[py * 8 + px] = sum;
        }
      }
      // Shift the whole block only as much as required to avoid RGB clipping.
      let lower = -Infinity; let upper = Infinity;
      for (let p = 0; p < 64; p += 1) {
        const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
        const r = data[pixel]; const g = data[pixel + 1]; const b = data[pixel + 2]; const change = changes[p];
        lower = Math.max(lower, -Math.min(r, g, b) - change);
        upper = Math.min(upper, 255 - Math.max(r, g, b) - change);
      }
      const shift = lower <= upper ? clamp(0, lower, upper) : (lower + upper) / 2;
      for (let p = 0; p < 64; p += 1) {
        const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
        const change = changes[p] + shift;
        data[pixel] += change; data[pixel + 1] += change; data[pixel + 2] += change;
      }
    }
    if ((index & 4095) === 4095) {
      onProgress?.({ label: read ? '读取纠错坐标' : '写入纠错坐标', fraction: read ? 0.05 + 0.5 * (index + 1) / plan.blockCount : 0.45 + 0.45 * (index + 1) / plan.blockCount });
      await pause();
    }
  }
  const headerBytes = new Uint8Array(HEADER_BYTES);
  for (let bit = 0; bit < headerVotes.length; bit += 1) if (headerVotes[bit] > HEADER_REPEATS / 2) headerBytes[bit >> 3] |= 1 << (bit & 7);
  return { header: headerBytes, payload: extracted };
}

function readHeaderVersion(image, version) {
  const { width, height, data } = image;
  if (width % 8 || height % 8) throw new Error('混淆图尺寸必须保持完整的 8 像素网格。');
  const blockCount = width * height / 64;
  const votes = new Uint8Array(HEADER_BYTES * 8);
  for (let slot = 0; slot < HEADER_CARRIERS; slot += 1) {
    const count = Math.min(blockCount, HEADER_CARRIERS - Math.floor(slot / blockCount) * blockCount);
    const block = version >= 6 ? Math.floor((slot % blockCount) * blockCount / count) : slot % blockCount;
    const frequency = Math.floor(slot / blockCount);
    if (!BASIS[frequency]) throw new Error('图像过小，无法读取坐标。');
    const x = block % (width / 8) * 8;
    const y = Math.floor(block / (width / 8)) * 8;
    let coefficient = 0;
    for (let p = 0; p < 64; p += 1) {
      const pixel = ((y + (p >> 3)) * width + x + (p & 7)) * 4;
      coefficient += (0.299 * data[pixel] + 0.587 * data[pixel + 1] + 0.114 * data[pixel + 2]) * BASIS[frequency][p];
    }
    votes[Math.floor(slot / HEADER_REPEATS)] += ((Math.round(coefficient / bootstrapStep(blockCount, version)) % 2) + 2) % 2;
  }
  const bytes = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < votes.length; i += 1) if (votes[i] > HEADER_REPEATS / 2) bytes[i >> 3] |= 1 << (i & 7);
  return parseHeader(bytes, width, height);
}

function readHeader(image) {
  try { return readHeaderVersion(image, VERSION); }
  catch { return readHeaderVersion(image, 5); }
}

export async function encodeImage(source, preset, options = {}) {
  let clock = performance.now();
  const timing = (label) => { const now = performance.now(); options.onTiming?.(label, now - clock); clock = now; };
  options.onProgress?.({ label: '准备图像与预设', fraction: 0 });
  const plan = createPlan(source.width, source.height, options);
  const step = clamp(Math.round(options.step ?? 16), 4, 96);
  const flattened = flattenImage(source);
  const padded = padSource(flattened, plan);
  const targetImage = fitImage(preset, plan.outputWidth, plan.outputHeight, options.fit ?? 'contain', plan.panels);
  const target = flattenImage(targetImage);
  timing('prepare');
  options.onProgress?.({ label: '按颜色与轮廓匹配细分块', fraction: 0.15 });
  await pause();
  const mapping = matchTiles(padded, target.data, plan);
  timing('match');
  options.onProgress?.({ label: '重排分块并适配颜色', fraction: 0.3 });
  const output = new Uint8ClampedArray(padded.length);
  const colorMeans = new Uint8Array(plan.tileCount * 3);
  for (let i = 0; i < plan.tileCount; i += 1) {
    writeTile(padded, output, mapping[i], i, plan);
    if (plan.colorAdapt) colorMeans.set(adaptTile(output, target.data, i, plan), i * 3);
  }
  const payload = coordinateBytes(mapping, colorMeans, plan);
  const header = makeHeader(plan, step, crc32(payload));
  timing('adapt');
  await watermark(output, plan, step, header, protectPayload(payload, plan), false, options.onProgress);
  timing('watermark');
  options.onProgress?.({ label: '计算图像相似度', fraction: 0.92 });
  const resemblance = options.skipSimilarity ? null : presetSimilarity(output, target.data, plan.outputWidth, plan.outputHeight);
  timing('similarity');
  options.onProgress?.({ label: '混淆完成', fraction: 1 });
  return { data: output, targetImage, plan: { ...plan, step, fit: options.fit ?? 'contain', transparentPixels: flattened.transparentPixels }, resemblance };
}

export async function restoreImage(image, options = {}) {
  let clock = performance.now();
  const timing = (label) => { const now = performance.now(); options.onTiming?.(label, now - clock); clock = now; };
  options.onProgress?.({ label: '读取图像参数', fraction: 0 });
  const { plan, step, checksum } = readHeader(image);
  timing('header');
  const extracted = await watermark(image.data, plan, step, null, null, true, options.onProgress);
  timing('watermark');
  options.onProgress?.({ label: '校验并纠正坐标', fraction: 0.56 });
  const { payload, corrected } = unprotectPayload(extracted.payload, plan);
  if (crc32(payload) !== checksum) throw new Error('坐标校验失败，无法可靠还原。');
  timing('ecc');
  const seen = new Uint8Array(plan.tileCount);
  const cropped = new Uint8ClampedArray(plan.width * plan.height * 4);
  const size = plan.outputTileSize;
  // Restore one carrier tile at a time directly into source resolution. This
  // preserves per-pixel clamping while avoiding a full enlarged intermediate.
  const scratch = new Uint8ClampedArray(size * size * 4);
  // Rare odd tile / half-step combinations have legacy sampling windows
  // crossing a tile boundary due to floating point ceil. Keep their original
  // full-grid sampling; integer and half-integer ratios use the fast path.
  const fullGrid = Number.isInteger(plan.pixelScale * 2) ? null : new Uint8ClampedArray(image.data.length);
  // Use global source coordinates when rounding. At non-binary ratios such
  // as 18/7, ceil((tileStart + x) * ratio) can differ by one pixel from
  // tileStart * ratio + ceil(x * ratio), matching the original decoder.
  const xRanges = Uint32Array.from({ length: plan.width + 1 }, (_, x) => Math.ceil(x * plan.pixelScale));
  const yRanges = Uint32Array.from({ length: plan.height + 1 }, (_, y) => Math.ceil(y * plan.pixelScale));
  options.onProgress?.({ label: '拼回分块并恢复颜色', fraction: 0.65 });
  for (let tile = 0; tile < plan.tileCount; tile += 1) {
    let original = 0;
    for (let bit = 0; bit < plan.coordinateBits; bit += 1) {
      const offset = tile * plan.payloadBits + bit;
      original |= ((payload[offset >> 3] >>> (offset & 7)) & 1) << bit;
    }
    if (original >= plan.tileCount || seen[original]) throw new Error('坐标排列校验失败。');
    seen[original] = 1;
    const fromX = tile % plan.columns * size;
    const fromY = Math.floor(tile / plan.columns) * size;
    for (let y = 0; y < size; y += 1) {
      const p = ((fromY + y) * plan.outputWidth + fromX) * 4;
      scratch.set(image.data.subarray(p, p + size * 4), y * size * 4);
    }
    if (plan.colorAdapt) {
      const means = new Uint8Array(3);
      for (let c = 0; c < 3; c += 1) for (let bit = 0; bit < 6; bit += 1) {
        const offset = tile * plan.payloadBits + plan.coordinateBits + c * 6 + bit;
        means[c] |= ((payload[offset >> 3] >>> (offset & 7)) & 1) << bit;
      }
      let actualR = 0; let actualG = 0; let actualB = 0;
      const area = size * size;
      for (let p = 0; p < scratch.length; p += 4) {
        actualR += scratch[p] / area; actualG += scratch[p + 1] / area; actualB += scratch[p + 2] / area;
      }
      const meanR = means[0] * 255 / 63; const meanG = means[1] * 255 / 63; const meanB = means[2] * 255 / 63;
      const gain = plan.colorGain;
      for (let p = 0; p < scratch.length; p += 4) {
        scratch[p] = (scratch[p] - actualR) / gain + meanR;
        scratch[p + 1] = (scratch[p + 1] - actualG) / gain + meanG;
        scratch[p + 2] = (scratch[p + 2] - actualB) / gain + meanB;
      }
    }
    const tx = original % plan.columns * plan.tileSize;
    const ty = Math.floor(original / plan.columns) * plan.tileSize;
    const carrierX = original % plan.columns * size;
    const carrierY = Math.floor(original / plan.columns) * size;
    if (fullGrid) {
      for (let y = 0; y < size; y += 1) fullGrid.set(scratch.subarray(y * size * 4, (y + 1) * size * 4), ((carrierY + y) * plan.outputWidth + carrierX) * 4);
    } else for (let y = 0; y < Math.min(plan.tileSize, plan.height - ty); y += 1) for (let x = 0; x < Math.min(plan.tileSize, plan.width - tx); x += 1) {
      const destination = ((ty + y) * plan.width + tx + x) * 4;
      const left = xRanges[tx + x] - carrierX; const right = xRanges[tx + x + 1] - carrierX;
      const top = yRanges[ty + y] - carrierY; const bottom = yRanges[ty + y + 1] - carrierY;
      let r = 0; let g = 0; let b = 0;
      for (let sy = top; sy < bottom; sy += 1) for (let sx = left; sx < right; sx += 1) {
        const p = (sy * size + sx) * 4;
        r += scratch[p]; g += scratch[p + 1]; b += scratch[p + 2];
      }
      const count = (right - left) * (bottom - top);
      cropped[destination] = r / count; cropped[destination + 1] = g / count; cropped[destination + 2] = b / count;
      cropped[destination + 3] = 255;
    }
    if ((tile & 4095) === 4095) options.onProgress?.({ label: '拼回分块并恢复颜色', fraction: 0.65 + 0.35 * (tile + 1) / plan.tileCount });
  }
  if (fullGrid) for (let y = 0; y < plan.height; y += 1) for (let x = 0; x < plan.width; x += 1) {
    let r = 0; let g = 0; let b = 0;
    const left = xRanges[x]; const right = xRanges[x + 1]; const top = yRanges[y]; const bottom = yRanges[y + 1];
    for (let sy = top; sy < bottom; sy += 1) for (let sx = left; sx < right; sx += 1) {
      const p = (sy * plan.outputWidth + sx) * 4; r += fullGrid[p]; g += fullGrid[p + 1]; b += fullGrid[p + 2];
    }
    const count = (right - left) * (bottom - top); const p = (y * plan.width + x) * 4;
    cropped[p] = r / count; cropped[p + 1] = g / count; cropped[p + 2] = b / count; cropped[p + 3] = 255;
  }
  timing('reassemble');
  options.onProgress?.({ label: '还原完成', fraction: 1 });
  return { data: cropped, plan: { ...plan, step, corrected } };
}

function samples(data, width, height, maxDimension, rgb) {
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / maxDimension));
  const sw = Math.ceil(width / scale); const sh = Math.ceil(height / scale);
  const channels = rgb ? 3 : 1;
  const values = new Float64Array(sw * sh * channels);
  for (let sy = 0; sy < sh; sy += 1) for (let sx = 0; sx < sw; sx += 1) {
    const right = Math.min(width, (sx + 1) * scale); const bottom = Math.min(height, (sy + 1) * scale);
    let r = 0; let g = 0; let b = 0; let luma = 0;
    for (let y = sy * scale; y < bottom; y += 1) for (let x = sx * scale; x < right; x += 1) {
      const p = (y * width + x) * 4;
      const alpha = data[p + 3] / 255;
      const matte = 255 * (1 - alpha);
      if (rgb) {
        r += data[p] * alpha + matte; g += data[p + 1] * alpha + matte; b += data[p + 2] * alpha + matte;
      } else luma += (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) * alpha + matte;
    }
    const count = (right - sx * scale) * (bottom - sy * scale);
    const sample = (sy * sw + sx) * channels;
    if (rgb) { values[sample] = r / count; values[sample + 1] = g / count; values[sample + 2] = b / count; }
    else values[sample] = luma / count;
  }
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
