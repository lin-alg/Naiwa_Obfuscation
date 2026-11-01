// SPDX-License-Identifier: GPL-3.0-or-later
import { concatBytes, gifFrameBlock, gifHeader } from './gif-codec.mjs';
import { createId } from './id.mjs';
import { createAnimatedWebP } from './webp-animation.mjs';
import { loadBuiltinPreset } from './preset-store.mjs';
import { zipFiles } from './zip-store.mjs';

const $ = selector => document.querySelector(selector);
const FRAMES = 100;
const FRAME_DELAY = 8;
const GRID_SIZE = 128;
const DEFAULT_PROXIMITY_IMPORTANCE = 13;
const OUTPUT_SIZE = 400;
const PERSONAL_SPACE = 0.95;
const PERSONAL_SPACE_SQUARED = PERSONAL_SPACE * PERSONAL_SPACE;
const ALIGNMENT_FACTOR = 0.8;
const asText = bytes => new TextDecoder('ascii').decode(bytes);
export const displayProgress = (fraction, elapsedMs = 0) => {
  const actual = fraction < 0.6
    ? 0.6 * Math.sqrt(fraction / 0.6)
    : 0.6 + 0.4 * ((fraction - 0.6) / 0.4) ** 1.6;
  const elapsed = Math.max(0, elapsedMs);
  // Keep the estimate moving while the worker is busy. It reaches 60% at
  // five seconds, then advances by at least one point per second, stopping at 99%.
  const timed = elapsed < 5000
    ? 0.6 * elapsed / 5000
    : Math.min(0.99, 0.6 + Math.floor((elapsed - 5000) / 1000) / 100);
  // Do not let a late worker message jump the visual ramp; it may lead the
  // timed estimate by only one point and is then caught up smoothly.
  const smoothedActual = elapsed > 0 ? Math.min(actual, timed + 0.01) : actual;
  return Math.min(1, Math.max(smoothedActual, timed));
};

export function isAnimatedRaster(bytes) {
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(asText(bytes.subarray(0, 6)))) return true;
  if (bytes.length >= 24 && bytes[0] === 137 && asText(bytes.subarray(1, 4)) === 'PNG') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
      const type = asText(bytes.subarray(offset + 4, offset + 8));
      if (type === 'acTL') return true;
      if (type === 'IDAT' || size > bytes.length - offset - 12) break;
      offset += size + 12;
    }
  }
  if (bytes.length >= 16 && asText(bytes.subarray(0, 4)) === 'RIFF' && asText(bytes.subarray(8, 12)) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = asText(bytes.subarray(offset, offset + 4));
      if (type === 'ANIM' || type === 'ANMF') return true;
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
      if (size > bytes.length - offset - 8) break;
      offset += 8 + size + (size & 1);
    }
  }
  if (bytes.length >= 16 && asText(bytes.subarray(4, 8)) === 'ftyp') {
    const brands = asText(bytes.subarray(8, Math.min(bytes.length, 128)));
    if (brands.includes('avis')) return true;
  }
  return false;
}

async function inspectImage(file) {
  if (!file || (file.type && !file.type.startsWith('image/'))) throw new Error('请选择有效的图片文件。');
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) throw new Error('不支持 SVG，请使用静态位图图片。');
  const header = new Uint8Array(await file.slice(0, Math.min(file.size, 4 * 1048576)).arrayBuffer());
  return isAnimatedRaster(header);
}

export async function assertStaticImage(file) {
  if (await inspectImage(file)) throw new Error(`「${file.name}」是动图；参考图只能使用静态图片。`);
}

function frameRect(side, aspect) {
  const value = Number(aspect);
  const safeAspect = Number.isFinite(value) && value > 0 ? value : 1;
  if (safeAspect >= 1) {
    const height = side / safeAspect;
    return { x: 0, y: (side - height) / 2, width: side, height };
  }
  const width = side * safeAspect;
  return { x: (side - width) / 2, y: 0, width, height: side };
}

function drawContained(source, context, rect, crop = {}, extendEdges = false) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const zoom = Math.max(1, Number(crop.zoom) || 1);
  const horizontal = Math.max(-1, Math.min(1, Number(crop.x) || 0));
  const vertical = Math.max(-1, Math.min(1, Number(crop.y) || 0));
  const scale = Math.min(rect.width / width, rect.height / height) * zoom;
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const x = rect.x + (rect.width - drawWidth) * (1 + horizontal) / 2;
  const y = rect.y + (rect.height - drawHeight) * (1 + vertical) / 2;
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.clip();
  context.drawImage(source, x, y, drawWidth, drawHeight);
  if (extendEdges) {
    const leftGap = Math.max(0, x - rect.x);
    const rightGap = Math.max(0, rect.x + rect.width - x - drawWidth);
    const topGap = Math.max(0, y - rect.y);
    const bottomGap = Math.max(0, rect.y + rect.height - y - drawHeight);
    if (leftGap) context.drawImage(source, 0, 0, 1, height, rect.x, y, leftGap, drawHeight);
    if (rightGap) context.drawImage(source, width - 1, 0, 1, height, x + drawWidth, y, rightGap, drawHeight);
    if (topGap) context.drawImage(source, 0, 0, width, 1, x, rect.y, drawWidth, topGap);
    if (bottomGap) context.drawImage(source, 0, height - 1, width, 1, x, y + drawHeight, drawWidth, bottomGap);
  }
  context.restore();
}

export function outputDimensions(width, height, maxSide = OUTPUT_SIZE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || !Number.isFinite(maxSide) || maxSide < 1) {
    throw new RangeError('图像尺寸无效。');
  }
  const scale = maxSide / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function squarePixels(source, side, crop = {}, aspect = undefined, extendEdges = false) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  if (!width || !height) throw new Error('无法读取图像尺寸。');
  const ratio = aspect ?? width / height;
  let drawable = source;
  let input;
  if (source.data) {
    input = document.createElement('canvas');
    input.width = width;
    input.height = height;
    input.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(source.data, width, height), 0, 0);
    drawable = input;
  }
  const output = document.createElement('canvas');
  output.width = output.height = side;
  const context = output.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, side, side);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  drawContained(drawable, context, frameRect(side, ratio), crop, extendEdges);
  const pixels = context.getImageData(0, 0, side, side);
  if (input) input.width = input.height = 0;
  output.width = output.height = 0;
  return pixels;
}

export async function assignTargetPixels(source, target, side = GRID_SIZE, { weights, proximityImportance = DEFAULT_PROXIMITY_IMPORTANCE, attemptsPerPixel = 32, onProgress, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  const count = side * side;
  if (!Number.isInteger(side) || side < 1 || source?.data?.length !== count * 4 || target?.data?.length !== count * 4 || (weights && weights.length !== count)) {
    throw new TypeError('像素匹配需要尺寸相同的正方形 RGBA 图像。');
  }
  if (!Number.isInteger(attemptsPerPixel) || attemptsPerPixel < 1) throw new RangeError('匹配搜索次数必须是正整数。');
  if (!Number.isFinite(proximityImportance) || proximityImportance < 0) throw new RangeError('邻近权重必须是非负有限数值。');
  const targetSources = Uint32Array.from({ length: count }, (_, index) => index);
  const mapping = new Uint32Array(count);
  const columns = Uint16Array.from({ length: count }, (_, index) => index % side);
  const rows = Uint16Array.from({ length: count }, (_, index) => Math.floor(index / side));
  let uniformWeight = weights ? weights[0] : 255;
  let hasUniformWeight = true;
  if (weights) {
    for (let index = 1; index < count; index += 1) {
      if (weights[index] !== uniformWeight) { hasUniformWeight = false; break; }
    }
  }
  let seed = 0;
  for (let offset = 0; offset < Math.min(source.data.length, 512); offset += 7) seed = Math.imul(seed ^ source.data[offset], 16777619);
  for (let offset = 0; offset < Math.min(target.data.length, 512); offset += 11) seed = Math.imul(seed ^ target.data[offset], 16777619);
  const assignmentCost = (sourceIndex, targetIndex) => {
    const sourceOffset = sourceIndex * 4;
    const targetOffset = targetIndex * 4;
    const red = source.data[sourceOffset] - target.data[targetOffset];
    const green = source.data[sourceOffset + 1] - target.data[targetOffset + 1];
    const blue = source.data[sourceOffset + 2] - target.data[targetOffset + 2];
    // Obamify assigns custom references a uniform target weight of 255.
    const colorWeight = weights?.[targetIndex] ?? 255;
    const colorCost = (red * red + green * green + blue * blue) * colorWeight;
    const dx = sourceIndex % side - targetIndex % side;
    const dy = Math.floor(sourceIndex / side) - Math.floor(targetIndex / side);
    const spatialCost = ((dx * dx + dy * dy) * proximityImportance) ** 2;
    return colorCost + spatialCost;
  };
  const trySwap = (targetA, targetB) => {
    if (targetA === targetB) return false;
    const sourceA = targetSources[targetA];
    const sourceB = targetSources[targetB];
    let improves;
    if (hasUniformWeight) {
      const dxAA = columns[sourceA] - columns[targetA];
      const dyAA = rows[sourceA] - rows[targetA];
      const dxBB = columns[sourceB] - columns[targetB];
      const dyBB = rows[sourceB] - rows[targetB];
      const dxAB = columns[sourceA] - columns[targetB];
      const dyAB = rows[sourceA] - rows[targetB];
      const dxBA = columns[sourceB] - columns[targetA];
      const dyBA = rows[sourceB] - rows[targetA];
      const beforeSpatial = ((dxAA * dxAA + dyAA * dyAA) * proximityImportance) ** 2
        + ((dxBB * dxBB + dyBB * dyBB) * proximityImportance) ** 2;
      const afterSpatial = ((dxAB * dxAB + dyAB * dyAB) * proximityImportance) ** 2
        + ((dxBA * dxBA + dyBA * dyBA) * proximityImportance) ** 2;
      const sourceOffsetA = sourceA * 4;
      const sourceOffsetB = sourceB * 4;
      const targetOffsetA = targetA * 4;
      const targetOffsetB = targetB * 4;
      const colorDelta = 2 * uniformWeight * (
        (source.data[sourceOffsetA] - source.data[sourceOffsetB]) * (target.data[targetOffsetA] - target.data[targetOffsetB])
        + (source.data[sourceOffsetA + 1] - source.data[sourceOffsetB + 1]) * (target.data[targetOffsetA + 1] - target.data[targetOffsetB + 1])
        + (source.data[sourceOffsetA + 2] - source.data[sourceOffsetB + 2]) * (target.data[targetOffsetA + 2] - target.data[targetOffsetB + 2])
      );
      improves = colorDelta + afterSpatial - beforeSpatial < 0;
    } else {
      const before = assignmentCost(sourceA, targetA) + assignmentCost(sourceB, targetB);
      const after = assignmentCost(sourceA, targetB) + assignmentCost(sourceB, targetA);
      improves = after < before;
    }
    if (!improves) return false;
    targetSources[targetA] = sourceB;
    targetSources[targetB] = sourceA;
    return true;
  };

  let randomState = seed >>> 0 || 0x6d2b79f5;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
  const attempts = count * attemptsPerPixel;
  const radii = [];
  for (let radius = Math.max(2, Math.round(side / 4)); ; radius = Math.max(2, Math.floor(radius / 2))) {
    radii.push(radius);
    if (radius === 2) break;
  }
  const generationsPerRadius = 6;
  const totalGenerations = radii.length * generationsPerRadius;
  for (let generation = 0; generation < totalGenerations; generation += 1) {
    const radius = radii[Math.floor(generation / generationsPerRadius)];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const targetA = random() % count;
      const ax = columns[targetA];
      const ay = rows[targetA];
      const bx = Math.max(0, Math.min(side - 1, ax + random() % (radius * 2 + 1) - radius));
      const by = Math.max(0, Math.min(side - 1, ay + random() % (radius * 2 + 1) - radius));
      trySwap(targetA, by * side + bx);
    }
    onProgress?.((generation + 1) / totalGenerations);
    await yieldControl();
  }

  for (let targetIndex = 0; targetIndex < count; targetIndex += 1) mapping[targetSources[targetIndex]] = targetIndex;
  return mapping;
}

export function buildSourcePalette(imageData, limit = 256) {
  if (!Number.isInteger(limit) || limit < 2 || limit > 256 || imageData.data.length % 4) {
    throw new TypeError('NeuQuant 调色板需要 2 到 256 色的 RGBA 图像。');
  }
  const count = imageData.data.length / 4;
  if (!count) throw new TypeError('NeuQuant 调色板需要至少一个像素。');

  // NeuQuant training follows color_quant 1.1.0 (MIT), used by Obamify.
  const network = new Float64Array(limit * 4);
  const frequency = new Float64Array(limit);
  const bias = new Float64Array(limit);
  for (let index = 0; index < limit; index += 1) {
    const offset = index * 4;
    const value = index * 256 / limit;
    network[offset] = value;
    network[offset + 1] = value;
    network[offset + 2] = value;
    network[offset + 3] = index < 16 ? index * 16 : 255;
    frequency[index] = 1 / limit;
  }

  const beta = 1 / 1024;
  const betaGamma = 1;
  const gamma = 1024;
  const alphaDecay = 30;
  const cycles = Math.max(1, limit >> 1);
  const delta = Math.max(1, Math.floor(count / cycles));
  const radiusBiasShift = 6;
  const radiusDecrease = 30;
  let radiusBias = (limit >> 3) << radiusBiasShift;
  let radius = radiusBias >> radiusBiasShift;
  if (radius <= 1) radius = 0;
  let alpha = 1024;

  const learn = (red, green, blue) => {
    let best = 0;
    let bestBiasedDistance = Infinity;
    for (let index = 0; index < limit; index += 1) {
      const offset = index * 4;
      const distance = Math.abs(network[offset] - red)
        + Math.abs(network[offset + 1] - green)
        + Math.abs(network[offset + 2] - blue)
        + Math.abs(network[offset + 3] - 255);
      const biasedDistance = distance - bias[index];
      if (biasedDistance < bestBiasedDistance) {
        bestBiasedDistance = biasedDistance;
        best = index;
      }
      frequency[index] -= beta * frequency[index];
      bias[index] += betaGamma * frequency[index];
    }
    frequency[best] += beta;
    bias[best] -= betaGamma;

    const winner = best * 4;
    const factor = alpha / gamma;
    network[winner] -= factor * (network[winner] - red);
    network[winner + 1] -= factor * (network[winner + 1] - green);
    network[winner + 2] -= factor * (network[winner + 2] - blue);
    network[winner + 3] -= factor * (network[winner + 3] - 255);

    if (radius > 0) {
      const radiusSquared = radius * radius;
      for (let distance = 1; distance <= radius; distance += 1) {
        const adjustment = factor * (radiusSquared - distance * distance) / radiusSquared;
        const low = best - distance;
        const high = best + distance;
        if (low >= 0) {
          const offset = low * 4;
          network[offset] -= adjustment * (network[offset] - red);
          network[offset + 1] -= adjustment * (network[offset + 1] - green);
          network[offset + 2] -= adjustment * (network[offset + 2] - blue);
          network[offset + 3] -= adjustment * (network[offset + 3] - 255);
        }
        if (high < limit) {
          const offset = high * 4;
          network[offset] -= adjustment * (network[offset] - red);
          network[offset + 1] -= adjustment * (network[offset + 1] - green);
          network[offset + 2] -= adjustment * (network[offset + 2] - blue);
          network[offset + 3] -= adjustment * (network[offset + 3] - 255);
        }
      }
    }
  };

  const steps = [499, 491, 487, 503];
  const step = steps.find(candidate => count % candidate !== 0) ?? steps.at(-1);
  let position = 0;
  for (let sample = 0; sample < count; sample += 1) {
    const offset = position * 4;
    const scaleChannel = value => value === 255 ? 255 : Math.floor(value * 256 / 255);
    learn(scaleChannel(imageData.data[offset]), scaleChannel(imageData.data[offset + 1]), scaleChannel(imageData.data[offset + 2]));
    position += step;
    if (position >= count) position -= count;
    if ((sample + 1) % delta === 0) {
      alpha -= alpha / alphaDecay;
      radiusBias -= radiusBias / radiusDecrease;
      radius = radiusBias >> radiusBiasShift;
      if (radius <= 1) radius = 0;
    }
  }

  const palette = new Uint8Array(256 * 3);
  for (let index = 0; index < limit; index += 1) {
    const colorOffset = index * 3;
    const networkOffset = index * 4;
    palette[colorOffset] = Math.max(0, Math.min(255, Math.round(network[networkOffset])));
    palette[colorOffset + 1] = Math.max(0, Math.min(255, Math.round(network[networkOffset + 1])));
    palette[colorOffset + 2] = Math.max(0, Math.min(255, Math.round(network[networkOffset + 2])));
  }

  const indices = new Uint8Array(count);
  const colorIndices = new Map();
  for (let pixel = 0, offset = 0; pixel < count; pixel += 1, offset += 4) {
    const red = imageData.data[offset];
    const green = imageData.data[offset + 1];
    const blue = imageData.data[offset + 2];
    const key = red << 16 | green << 8 | blue;
    let index = colorIndices.get(key);
    if (index === undefined) {
      let bestDistance = Infinity;
      index = 0;
      for (let candidate = 0; candidate < limit; candidate += 1) {
        const paletteOffset = candidate * 3;
        const distance = Math.abs(red - palette[paletteOffset])
          + Math.abs(green - palette[paletteOffset + 1])
          + Math.abs(blue - palette[paletteOffset + 2]);
        if (distance < bestDistance) { bestDistance = distance; index = candidate; }
      }
      colorIndices.set(key, index);
    }
    indices[pixel] = index;
  }
  return { palette, indices };
}

export function destinationForce(age, destinationForce = 0.13) {
  if (destinationForce === 0) return 0.1;
  return Math.min(1000, (age / 60 * destinationForce) ** 3);
}

export function createSimulationBins(count) {
  return { heads: new Int32Array(count), next: new Int32Array(count) };
}

export function updateMorphSimulation(positions, velocities, destinations, ages, side, bins, acceleration) {
  const count = ages.length;
  const pixelScale = OUTPUT_SIZE / side;
  acceleration.fill(0);
  bins.heads.fill(-1);
  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 2];
    const y = positions[index * 2 + 1];
    const column = Math.min(side - 1, Math.max(0, Math.floor(x)));
    const row = Math.min(side - 1, Math.max(0, Math.floor(y)));
    const cell = row * side + column;
    bins.next[index] = bins.heads[cell];
    bins.heads[cell] = index;

    const wallSpace = PERSONAL_SPACE * 0.5;
    if (x < wallSpace) acceleration[index * 2] += (wallSpace - x) / wallSpace / pixelScale;
    else if (x > side - wallSpace) acceleration[index * 2] -= (x - (side - wallSpace)) / wallSpace / pixelScale;
    if (y < wallSpace) acceleration[index * 2 + 1] += (wallSpace - y) / wallSpace / pixelScale;
    else if (y > side - wallSpace) acceleration[index * 2 + 1] -= (y - (side - wallSpace)) / wallSpace / pixelScale;

    const dx = destinations[index * 2] - x;
    const dy = destinations[index * 2 + 1] - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const force = destinationForce(ages[index]);
    acceleration[index * 2] += dx * distance * force / side;
    acceleration[index * 2 + 1] += dy * distance * force / side;
  }

  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 2];
    const y = positions[index * 2 + 1];
    const column = Math.min(side - 1, Math.max(0, Math.floor(x)));
    const row = Math.min(side - 1, Math.max(0, Math.floor(y)));
    let averageX = 0;
    let averageY = 0;
    let totalWeight = 0;
    for (let neighborY = Math.max(0, row - 1); neighborY <= Math.min(side - 1, row + 1); neighborY += 1) {
      for (let neighborX = Math.max(0, column - 1); neighborX <= Math.min(side - 1, column + 1); neighborX += 1) {
        for (let other = bins.heads[neighborY * side + neighborX]; other !== -1; other = bins.next[other]) {
          if (other === index) continue;
          const dx = positions[other * 2] - x;
          const dy = positions[other * 2 + 1] - y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < 1e-12) {
            const low = Math.min(index, other);
            const high = Math.max(index, other);
            let hash = Math.imul(low + 1, 0x9e3779b1) ^ Math.imul(high + 1, 0x85ebca6b);
            hash ^= hash >>> 16;
            const angle = (hash >>> 0) / 4294967296 * Math.PI * 2;
            const direction = index === low ? 1 : -1;
            acceleration[index * 2] += Math.cos(angle) * direction * 0.1 / pixelScale;
            acceleration[index * 2 + 1] += Math.sin(angle) * direction * 0.1 / pixelScale;
            continue;
          }
          if (distanceSquared >= PERSONAL_SPACE_SQUARED) continue;
          const distance = Math.sqrt(distanceSquared);
          const weight = (PERSONAL_SPACE - distance) / (PERSONAL_SPACE * distance);
          acceleration[index * 2] -= dx * weight * 0.2 / pixelScale;
          acceleration[index * 2 + 1] -= dy * weight * 0.2 / pixelScale;
          averageX += velocities[other * 2] * weight;
          averageY += velocities[other * 2 + 1] * weight;
          totalWeight += weight;
        }
      }
    }
    if (totalWeight > 0) {
      acceleration[index * 2] += (averageX / totalWeight - velocities[index * 2]) * ALIGNMENT_FACTOR;
      acceleration[index * 2 + 1] += (averageY / totalWeight - velocities[index * 2 + 1]) * ALIGNMENT_FACTOR;
    }
  }

  for (let index = 0; index < count; index += 1) {
    const xOffset = index * 2;
    velocities[xOffset] = (velocities[xOffset] + acceleration[xOffset]) * 0.97;
    velocities[xOffset + 1] = (velocities[xOffset + 1] + acceleration[xOffset + 1]) * 0.97;
    positions[xOffset] += velocities[xOffset];
    positions[xOffset + 1] += velocities[xOffset + 1];
    ages[index] += 1;
  }
}

function createMorphFrameRenderer(colors, side, rasterSide = side * 2, outputWidth = side * 4, outputHeight = outputWidth, aspect = 1) {
  if (!Number.isInteger(rasterSide) || !Number.isInteger(outputWidth) || !Number.isInteger(outputHeight) || rasterSide < side || outputWidth < 1 || outputHeight < 1) {
    throw new RangeError('Voronoi 栅格与输出尺寸无效。');
  }
  const pixelCount = rasterSide * rasterSide;
  const owners = [new Int32Array(pixelCount), new Int32Array(pixelCount)];
  const output = new Uint8Array(outputWidth * outputHeight);
  const samplePosition = Float32Array.from({ length: rasterSide }, (_, index) => (index + 0.5) * side / rasterSide);
  // Dense particle grids need only local jumps; sparse render calls need global propagation.
  const seedSpacing = rasterSide / side;
  const maxJump = colors.length >= side * side ? Math.ceil(seedSpacing) : rasterSide - 1;
  const initialStep = Math.max(1, 2 ** Math.floor(Math.log2(maxJump)));
  const steps = [];
  for (let step = initialStep; step >= 1; step = Math.floor(step / 2)) steps.push(step);
  const initialHalo = steps.slice(1).reduce((sum, step) => sum + step, 0);
  const visibleFrame = frameRect(side, aspect);
  const outputRange = (start, extent, count) => [
    Math.max(0, Math.floor((start + 0.5 * extent / count) * rasterSide / side)),
    Math.min(rasterSide - 1, Math.floor((start + (count - 0.5) * extent / count) * rasterSide / side)),
  ];
  const [visibleLeft, visibleRight] = outputRange(visibleFrame.x, visibleFrame.width, outputWidth);
  const [visibleTop, visibleBottom] = outputRange(visibleFrame.y, visibleFrame.height, outputHeight);

  return positions => {
    let current = owners[0];
    let next = owners[1];
    current.fill(-1);
    next.fill(-1);
    for (let index = 0; index < colors.length; index += 1) {
      const x = Math.max(0, Math.min(rasterSide - 1, Math.round(positions[index * 2] * rasterSide / side)));
      const y = Math.max(0, Math.min(rasterSide - 1, Math.round(positions[index * 2 + 1] * rasterSide / side)));
      current[y * rasterSide + x] = index;
    }

    let remainingHalo = initialHalo;
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      const left = Math.max(0, visibleLeft - remainingHalo);
      const right = Math.min(rasterSide - 1, visibleRight + remainingHalo);
      const top = Math.max(0, visibleTop - remainingHalo);
      const bottom = Math.min(rasterSide - 1, visibleBottom + remainingHalo);
      for (let y = top; y <= bottom; y += 1) {
        const py = samplePosition[y];
        for (let x = left; x <= right; x += 1) {
          const pixel = y * rasterSide + x;
          const px = samplePosition[x];
          let best = current[pixel];
          let bestDistance = best < 0 ? Infinity : (positions[best * 2] - px) ** 2 + (positions[best * 2 + 1] - py) ** 2;
          for (let offsetY = -step; offsetY <= step; offsetY += step) {
            const neighborY = y + offsetY;
            if (neighborY < 0 || neighborY >= rasterSide) continue;
            const row = neighborY * rasterSide;
            for (let offsetX = -step; offsetX <= step; offsetX += step) {
              const neighborX = x + offsetX;
              if (neighborX < 0 || neighborX >= rasterSide) continue;
              const candidate = current[row + neighborX];
              if (candidate < 0) continue;
              const dx = positions[candidate * 2] - px;
              const dy = positions[candidate * 2 + 1] - py;
              const distance = dx * dx + dy * dy;
              if (distance < bestDistance) { best = candidate; bestDistance = distance; }
            }
          }
          next[pixel] = best;
        }
      }
      [current, next] = [next, current];
      remainingHalo -= steps[stepIndex + 1] ?? 0;
    }

    for (let y = 0; y < outputHeight; y += 1) {
      const rasterY = Math.min(rasterSide - 1, Math.floor((visibleFrame.y + (y + 0.5) * visibleFrame.height / outputHeight) * rasterSide / side));
      for (let x = 0; x < outputWidth; x += 1) {
        const rasterX = Math.min(rasterSide - 1, Math.floor((visibleFrame.x + (x + 0.5) * visibleFrame.width / outputWidth) * rasterSide / side));
        const owner = current[rasterY * rasterSide + rasterX];
        output[y * outputWidth + x] = owner < 0 ? colors[0] : colors[owner];
      }
    }
    return output;
  };
}

export function renderMorphFrame(positions, colors, side, rasterSide = side * 2, outputWidth = side * 4, outputHeight = outputWidth, aspect = 1) {
  return createMorphFrameRenderer(colors, side, rasterSide, outputWidth, outputHeight, aspect)(positions);
}

export function cropChangedFrame(frame, previous, width, height, transparentIndex = -1) {
  if (frame.length !== width * height || (previous && previous.length !== frame.length)) {
    throw new TypeError('动图帧尺寸不匹配。');
  }
  if (!Number.isInteger(transparentIndex) || transparentIndex < -1 || transparentIndex > 255) {
    throw new RangeError('透明调色板索引无效。');
  }
  if (!previous) return { x: 0, y: 0, width, height, indices: frame };

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    let offset = y * width;
    for (let x = 0; x < width; x += 1, offset += 1) {
      if (frame[offset] === previous[offset]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return { x: 0, y: 0, width: 1, height: 1, indices: frame.subarray(0, 1) };

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const indices = new Uint8Array(cropWidth * cropHeight);
  if (transparentIndex >= 0) indices.fill(transparentIndex);
  for (let y = 0; y < cropHeight; y += 1) {
    let sourceOffset = (top + y) * width + left;
    let targetOffset = y * cropWidth;
    for (let x = 0; x < cropWidth; x += 1, sourceOffset += 1, targetOffset += 1) {
      if (transparentIndex < 0 || frame[sourceOffset] !== previous[sourceOffset]) indices[targetOffset] = frame[sourceOffset];
    }
  }
  return { x: left, y: top, width: cropWidth, height: cropHeight, indices };
}

export async function createMorphGif(source, target, side, aspect, width, height, settings, onProgress, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0))) {
  const mapping = await assignTargetPixels(source, target, side, {
    proximityImportance: settings.proximityImportance * (GRID_SIZE / side) ** 2,
    onProgress: progress => onProgress?.(progress * 0.05),
    yieldControl,
  });
  const rasterSide = Math.max(side, Math.round(OUTPUT_SIZE * side / GRID_SIZE));
  const transparentIndex = 255;
  const { palette, indices: colors } = buildSourcePalette(source, transparentIndex);
  const positions = new Float32Array(mapping.length * 2);
  const velocities = new Float32Array(mapping.length * 2);
  const destinations = new Float32Array(mapping.length * 2);
  const ages = new Uint16Array(mapping.length);
  const bins = createSimulationBins(mapping.length);
  const acceleration = new Float32Array(mapping.length * 2);
  const renderFrame = createMorphFrameRenderer(colors, side, rasterSide, width, height, aspect);
  for (let sourceIndex = 0; sourceIndex < mapping.length; sourceIndex += 1) {
    positions[sourceIndex * 2] = sourceIndex % side + 0.5;
    positions[sourceIndex * 2 + 1] = Math.floor(sourceIndex / side) + 0.5;
    destinations[sourceIndex * 2] = mapping[sourceIndex] % side + 0.5;
    destinations[sourceIndex * 2 + 1] = Math.floor(mapping[sourceIndex] / side) + 0.5;
  }
  const blocks = [gifHeader(width, height, palette, 0)];
  let previousFrame = null;

  for (let step = 0; step < 20; step += 1) updateMorphSimulation(positions, velocities, destinations, ages, side, bins, acceleration);
  for (let frame = 0; frame < FRAMES; frame += 1) {
    if (frame > 0) for (let step = 0; step < 14; step += 1) updateMorphSimulation(positions, velocities, destinations, ages, side, bins, acceleration);
    const pixels = renderFrame(positions);
    const crop = cropChangedFrame(pixels, previousFrame, width, height, transparentIndex);
    blocks.push(gifFrameBlock(crop.indices, {
      x: crop.x, y: crop.y, width: crop.width, height: crop.height,
      delay: FRAME_DELAY, minimum: 8, transparent: frame > 0 ? transparentIndex : -1, disposal: 1,
    }));
    previousFrame = pixels.slice();
    onProgress?.(0.05 + 0.95 * (frame + 1) / FRAMES);
    await yieldControl();
  }
  blocks.push(Uint8Array.of(0x3b));
  return new Blob([concatBytes(blocks)], { type: 'image/gif' });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function createDownloadIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  for (const d of ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3']) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', d);
    icon.append(path);
  }
  return icon;
}

const stem = file => file.name.replace(/\.[^.]+$/, '') || 'image';
const formatBytes = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;

export function initializeMorphAnimation({ getPresets, onCustomPreset, onGenerated = () => {}, onError = () => {} }) {
  const elements = {
    sourceFile: $('#morph-source-file'), sourcePicker: $('#morph-source-picker'), sourceName: $('#morph-source-name'),
    list: $('#morph-source-list'), summary: $('#morph-batch-summary'), presets: $('#morph-presets'), characterInput: $('#morph-character-input'), characterAdd: $('#morph-character-add'), characterPresets: $('#morph-character-presets'), presetName: $('#morph-preset-name'),
    presetFile: $('#morph-preset-file'), presetPicker: $('#morph-preset-picker'), direction: $('#morph-direction'),
    resolution: $('#morph-resolution'), resolutionValue: $('#morph-resolution-value'),
    proximity: $('#morph-proximity'), proximityValue: $('#morph-proximity-value'),
    generate: $('#morph-generate'), download: $('#morph-download'), downloadWebP: $('#morph-download-webp'), downloadAll: $('#morph-download-all'), status: $('#morph-status'),
    result: document.querySelector('.morph-result'), entryNavigation: $('#morph-entry-nav'), previous: $('#morph-previous'), next: $('#morph-next'), entryPosition: $('#morph-entry-position'),
    sourcePreview: $('#morph-source-preview'), sourceEmpty: $('#morph-source-empty'), sourceMeta: $('#morph-source-meta'),
    sourceCrop: document.querySelector('[data-morph-crop="source"]'), sourceCropPreview: $('#morph-source-crop-preview'),
    outputPreview: $('#morph-output-preview'), outputEmpty: $('#morph-output-empty'), outputMeta: $('#morph-output-meta'),
    targetCrop: document.querySelector('[data-morph-crop="target"]'), targetCropPreview: $('#morph-target-crop-preview'),
    sourceViewport: $('#morph-source-viewport'), outputViewport: $('#morph-output-viewport'),
    resultFooter: $('#morph-result-footer'), resultMessage: $('#morph-result-message'),
  };
  const state = { entries: [], activeId: null, presets: [], characterPresets: [], characterLoading: false, presetKey: null, busy: false, webpBusy: false };
  let morphWorker;
  let morphRequest;
  const activeEntry = () => state.entries.find(entry => entry.id === state.activeId) ?? null;
  const activePreset = () => state.presets.find(preset => preset.key === state.presetKey) ?? null;
  const ready = entry => Boolean(entry && entry.status === 'done' && entry.result);
  const previewViews = [
    { key: 'source', viewport: elements.sourceViewport, image: elements.sourcePreview },
    { key: 'output', viewport: elements.outputViewport, image: elements.outputPreview },
  ];

  function generateInWorker(entry, source, target, side, aspect, width, height, settings, onProgress) {
    morphWorker ??= new Worker(new URL('./morph-worker.mjs', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const id = createId();
      const worker = morphWorker;
      morphRequest = { id, entry, resolve, reject, onProgress };
      worker.onmessage = ({ data }) => {
        if (data.id !== morphRequest?.id) return;
        if (data.type === 'progress') morphRequest.onProgress?.(data.fraction);
        else {
          const request = morphRequest;
          morphRequest = null;
          if (data.type === 'error') request.reject(new Error(data.message));
          else request.resolve(data.result);
        }
      };
      worker.onerror = event => {
        if (morphRequest?.id !== id) return;
        const request = morphRequest;
        morphRequest = null;
        worker.terminate();
        if (morphWorker === worker) morphWorker = null;
        request?.reject(new Error(event.message || '动图处理线程失败。'));
      };
      try {
        worker.postMessage({
          id, source: source.data.buffer, target: target.data.buffer,
          side, aspect, width, height, settings,
        }, [source.data.buffer, target.data.buffer]);
      } catch (error) {
        morphRequest = null;
        worker.terminate();
        if (morphWorker === worker) morphWorker = null;
        reject(error);
      }
    });
  }

  function cancelRunningEntry(entry) {
    if (morphRequest?.entry !== entry) return;
    const request = morphRequest;
    morphRequest = null;
    morphWorker?.terminate();
    morphWorker = null;
    const error = new Error('已移除处理中条目。');
    error.name = 'AbortError';
    request.reject(error);
  }

  function updatePreview(view) {
    const { scale } = view;
    if (!view.image.hidden) {
      const bounds = view.viewport.getBoundingClientRect();
      const maxX = Math.max(0, (view.image.offsetWidth * scale - bounds.width) / 2);
      const maxY = Math.max(0, (view.image.offsetHeight * scale - bounds.height) / 2);
      view.x = Math.max(-maxX, Math.min(maxX, view.x));
      view.y = Math.max(-maxY, Math.min(maxY, view.y));
    } else {
      view.x = 0;
      view.y = 0;
    }
    view.image.style.setProperty('--preview-scale', String(scale));
    view.image.style.setProperty('--preview-pan-x', `${view.x}px`);
    view.image.style.setProperty('--preview-pan-y', `${view.y}px`);
    view.viewport.classList.toggle('is-zoomed', scale > 1);
    view.viewport.style.touchAction = scale > 1 ? 'none' : 'pan-y';
    view.controls.querySelector('[data-preview-zoom-value]').textContent = `${Math.round(scale * 100)}%`;
    view.controls.querySelector('[data-preview-zoom="out"]').disabled = view.image.hidden || scale <= 1;
    view.controls.querySelector('[data-preview-zoom="in"]').disabled = view.image.hidden || scale >= 4;
    view.controls.querySelector('[data-preview-fit]').disabled = view.image.hidden || (scale === 1 && view.x === 0 && view.y === 0);
  }

  function resetPreview(view) {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    updatePreview(view);
  }

  function setPreviewImage(view, url) {
    const current = view.image.getAttribute('src') ?? '';
    view.image.hidden = !url;
    if (url && url !== current) {
      view.image.src = url;
      resetPreview(view);
    } else if (!url && current) {
      view.image.removeAttribute('src');
      resetPreview(view);
    }
  }

  function scrollToResultOnMobile() {
    if (!matchMedia('(max-width: 640px)').matches || !state.entries.some(ready)) return;
    requestAnimationFrame(() => elements.result.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
  }

  function cropValues(key) {
    const panel = elements[`${key}Crop`];
    return Object.fromEntries(['x', 'y', 'zoom'].map(axis => [axis, Number(panel.querySelector(`[data-crop-axis="${axis}"]`).value)]));
  }

  function updateCropPreview(key) {
    const source = key === 'source' ? elements.sourcePreview : activePreset()?.image;
    const canvas = elements[`${key}CropPreview`];
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!source || (key === 'source' && (!source.complete || !source.naturalWidth))) return;
    const entry = activeEntry();
    const aspect = key === 'target' && entry ? entry.width / entry.height
      : source.naturalWidth && source.naturalHeight ? source.naturalWidth / source.naturalHeight : 1;
    context.putImageData(squarePixels(source, canvas.width, cropValues(key), aspect, key === 'target'), 0, 0);
  }

  function updateCropPreviewValues(key) {
    const panel = elements[`${key}Crop`];
    for (const axis of ['x', 'y', 'zoom']) {
      const value = Number(panel.querySelector(`[data-crop-axis="${axis}"]`).value);
      panel.querySelector(`[data-crop-value="${axis}"]`).textContent = axis === 'zoom'
        ? `${Math.round(value * 100)}%` : value.toFixed(2).replace(/\.00$/, '').replace(/0$/, '');
    }
    updateCropPreview(key);
  }

  function zoomPreview(view, scale, clientX, clientY) {
    const nextScale = Math.max(1, Math.min(4, scale));
    if (view.image.hidden || nextScale === view.scale) return;
    const bounds = view.viewport.getBoundingClientRect();
    const pointX = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const pointY = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
    const imageX = (pointX - bounds.width / 2 - view.x) / view.scale;
    const imageY = (pointY - bounds.height / 2 - view.y) / view.scale;
    view.x = pointX - bounds.width / 2 - imageX * nextScale;
    view.y = pointY - bounds.height / 2 - imageY * nextScale;
    view.scale = nextScale;
    updatePreview(view);
  }

  for (const view of previewViews) {
    view.controls = document.querySelector(`[data-preview-controls="${view.key}"]`);
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    view.image.addEventListener('load', () => {
      updatePreview(view);
      if (view.key === 'source') {
        updateCropPreview('source');
        updateCropPreview('target');
      }
    });
    view.image.draggable = false;
    view.image.addEventListener('dragstart', event => event.preventDefault());
    view.controls.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.matches('[data-preview-fit]')) resetPreview(view);
      else if (button.dataset.previewZoom === 'in') zoomPreview(view, view.scale * 1.25);
      else if (button.dataset.previewZoom === 'out') zoomPreview(view, view.scale / 1.25);
    });
    view.viewport.addEventListener('wheel', event => {
      if (view.image.hidden) return;
      event.preventDefault();
      zoomPreview(view, view.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX, event.clientY);
    }, { passive: false });
    view.viewport.addEventListener('pointerdown', event => {
      if (view.scale <= 1 || event.button !== 0) return;
      view.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
      view.viewport.setPointerCapture(event.pointerId);
      view.viewport.classList.add('is-panning');
    });
    view.viewport.addEventListener('pointermove', event => {
      if (view.drag?.id !== event.pointerId) return;
      view.x = view.drag.originX + event.clientX - view.drag.x;
      view.y = view.drag.originY + event.clientY - view.drag.y;
      updatePreview(view);
    });
    const stopPan = event => {
      if (view.drag?.id !== event.pointerId) return;
      view.drag = null;
      view.viewport.classList.remove('is-panning');
    };
    view.viewport.addEventListener('pointerup', stopPan);
    view.viewport.addEventListener('pointercancel', stopPan);
    new ResizeObserver(() => updatePreview(view)).observe(view.viewport);
    updatePreview(view);
  }

  function setStatus(message, error = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle('is-error', error);
  }

  function revokeResult(entry) {
    if (entry.resultUrl) URL.revokeObjectURL(entry.resultUrl);
    entry.resultUrl = null;
    entry.result = null;
    entry.webpResult = null;
  }

  function renderEntry(entry) {
    const { row, select, image, detail, ring, progress, download, remove } = entry.ui;
    const active = activeEntry() === entry;
    const percent = Math.round((entry.progress ?? 0) * 100);
    row.dataset.status = entry.status;
    row.classList.toggle('is-active', active);
    select.setAttribute('aria-pressed', String(active));
    detail.textContent = entry.label;
    ring.style.setProperty('--progress', `${percent * 3.6}deg`);
    progress.textContent = entry.status === 'done' ? '✓' : entry.status === 'error' ? '!' : entry.status === 'processing' ? `${percent}%` : '▶';
    progress.setAttribute('aria-valuenow', String(percent));
    progress.setAttribute('aria-label', `${entry.file.name}：${entry.label}`);
    ring.disabled = state.busy || entry.status === 'loading';
    ring.title = entry.status === 'done' ? `重新生成：${entry.file.name}` : `生成：${entry.file.name}`;
    download.disabled = !ready(entry);
    remove.disabled = false;
    if (image.getAttribute('src') !== entry.thumbUrl) image.src = entry.thumbUrl;
  }

  function renderActive() {
    const entry = activeEntry();
    const index = state.entries.indexOf(entry);
    elements.entryNavigation.hidden = state.entries.length < 2;
    elements.entryPosition.textContent = entry ? `${index + 1} / ${state.entries.length}` : `0 / ${state.entries.length}`;
    elements.previous.disabled = state.busy || index <= 0;
    elements.next.disabled = state.busy || index < 0 || index >= state.entries.length - 1;
    elements.sourcePreview.hidden = !entry;
    elements.sourceEmpty.hidden = Boolean(entry);
    elements.outputPreview.hidden = !entry?.resultUrl;
    elements.outputEmpty.hidden = Boolean(entry?.resultUrl);
    setPreviewImage(previewViews[0], entry?.sourceUrl ?? '');
    setPreviewImage(previewViews[1], entry?.resultUrl ?? '');
    if (entry) {
      elements.sourceMeta.textContent = `${entry.width} × ${entry.height}`;
    } else {
      elements.sourceMeta.textContent = '等待上传';
    }
    if (entry?.resultUrl) {
      elements.outputMeta.textContent = `${entry.resultWidth} × ${entry.resultHeight} · ${entry.resultFrames} 帧 · ${formatBytes(entry.result.size)}`;
      elements.resultFooter.classList.add('is-ready');
      elements.resultMessage.textContent = `${entry.file.name} · ${entry.direction === 'reverse' ? '逆动画' : '原图 → 参考图'} · ${entry.resultWidth} × ${entry.resultHeight} GIF`;
    } else {
      elements.outputMeta.textContent = entry?.label ?? '等待生成';
      elements.resultFooter.classList.remove('is-ready');
      elements.resultMessage.textContent = entry?.label ?? '尚未生成';
    }
    elements.download.disabled = !ready(entry);
    elements.downloadWebP.disabled = state.busy || state.webpBusy || !ready(entry);
    elements.downloadWebP.textContent = state.webpBusy ? '正在编码 WebP…' : '下载 WebP';
    elements.downloadAll.hidden = state.entries.filter(ready).length < 2;
    elements.downloadAll.disabled = state.busy || !state.entries.some(ready);
    for (const item of state.entries) renderEntry(item);
  }

  function syncActions() {
    const entries = state.entries;
    const readyCount = entries.filter(ready).length;
    const waiting = entries.filter(entry => entry.status === 'loading').length;
    const pending = entries.filter(entry => ['idle', 'error'].includes(entry.status)).length;
    elements.generate.disabled = state.busy || state.characterLoading || waiting > 0 || !entries.length || !activePreset()?.image;
    elements.generate.textContent = state.busy ? '正在生成动图…' : waiting ? '正在读取图片…'
      : !entries.length ? '生成奶蛙动图' : readyCount === entries.length ? `重新生成全部（${entries.length}）`
        : entries.length > 1 ? `生成全部奶蛙动图（${pending}）` : '生成奶蛙动图';
    elements.sourceName.textContent = entries.length ? `继续添加图片（已有 ${entries.length} 张）` : '选择图片';
    elements.summary.textContent = entries.length ? `${readyCount}/${entries.length} 已完成${state.busy ? ' · 正在处理' : ''}${entries.some(entry => entry.status === 'error') ? ' · 失败项可重试' : ''}` : '';
    elements.presetPicker.disabled = state.busy || state.characterLoading;
    elements.direction.disabled = state.busy;
    elements.resolution.disabled = state.busy;
    elements.proximity.disabled = state.busy;
    for (const key of ['source', 'target']) {
      elements[`${key}Crop`].querySelectorAll('input, button').forEach(control => { control.disabled = state.busy; });
    }
    if (state.characterLoading) {
      setStatus('正在准备字符参考图…');
    } else if (state.busy) {
      setStatus(entries.find(entry => entry.status === 'processing')?.label ?? '正在准备动图…');
    } else if (waiting) {
      setStatus(`正在读取 ${waiting} 张图片…`);
    } else if (entries.some(entry => entry.status === 'error')) {
      setStatus('部分图片处理失败，可点击对应进度按钮重试。', true);
    } else if (entries.length && readyCount === entries.length) {
      setStatus(`已完成 ${readyCount} 张奶蛙动图，可下载或调整选项后重新生成。`);
    } else if (entries.length) {
      setStatus(activePreset()?.image ? `${entries.length} 张图片已载入，点击生成按钮开始处理。` : '请选择参考图。');
    } else {
      setStatus(activePreset()?.image ? '选择原图后即可生成。' : '选择原图和参考图后即可生成。');
    }
    elements.characterAdd.disabled = state.busy || state.characterLoading;
    elements.characterInput.disabled = state.busy || state.characterLoading;
    renderCharacterPresets();
    renderActive();
  }

  function selectEntry(entry) {
    state.activeId = entry?.id ?? null;
    syncActions();
    updateCropPreview('source');
    updateCropPreview('target');
  }

  function removeEntry(entry) {
    const index = state.entries.indexOf(entry);
    if (index < 0) return;
    cancelRunningEntry(entry);
    const wasActive = activeEntry() === entry;
    state.entries.splice(index, 1);
    entry.ui.row.remove();
    URL.revokeObjectURL(entry.thumbUrl);
    URL.revokeObjectURL(entry.sourceUrl);
    revokeResult(entry);
    if (wasActive) state.activeId = state.entries[Math.min(index, state.entries.length - 1)]?.id ?? null;
    syncActions();
    updateCropPreview('source');
  }

  function createEntryRow(entry) {
    const row = document.createElement('div');
    row.className = 'batch-item';
    row.setAttribute('role', 'listitem');
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'batch-select';
    const image = document.createElement('img');
    image.alt = '';
    image.width = 44;
    image.height = 44;
    const copy = document.createElement('span');
    copy.className = 'batch-copy';
    const name = document.createElement('strong');
    name.textContent = entry.file.name;
    const detail = document.createElement('small');
    copy.append(name, detail);
    select.append(image, copy);
    select.addEventListener('click', () => selectEntry(entry));
    const ring = document.createElement('button');
    ring.type = 'button';
    ring.className = 'progress-ring';
    const progress = document.createElement('span');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    ring.append(progress);
    ring.addEventListener('click', () => runSingle(entry));
    const actions = document.createElement('span');
    actions.className = 'batch-item-actions';
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'batch-download';
    download.append(createDownloadIcon());
    download.title = `下载 ${entry.file.name}`;
    download.setAttribute('aria-label', download.title);
    download.addEventListener('click', () => { if (ready(entry)) downloadBlob(entry.result, `${stem(entry.file)}-naiwa-morph.gif`); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'batch-remove';
    remove.textContent = '×';
    remove.title = `移除 ${entry.file.name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => removeEntry(entry));
    actions.append(download, remove);
    row.append(select, ring, actions);
    entry.ui = { row, select, image, detail, ring, progress, download, remove };
    elements.list.append(row);
  }

  async function importFiles(files) {
    const accepted = [];
    const rejected = [];
    for (const file of files) {
      try {
        const animated = await inspectImage(file);
        const bitmap = await createImageBitmap(file);
        const { width, height } = bitmap;
        let thumb;
        let firstFrameBlob = null;
        try {
          thumb = squarePixels(bitmap, 88);
          if (animated) {
            const frameCanvas = document.createElement('canvas');
            frameCanvas.width = bitmap.width;
            frameCanvas.height = bitmap.height;
            frameCanvas.getContext('2d').drawImage(bitmap, 0, 0);
            firstFrameBlob = await new Promise(resolve => frameCanvas.toBlob(resolve, 'image/png'));
            frameCanvas.width = frameCanvas.height = 0;
            if (!firstFrameBlob) throw new Error(`无法读取「${file.name}」的首帧。`);
          }
        } finally { bitmap.close(); }
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = thumbCanvas.height = 88;
        thumbCanvas.getContext('2d').putImageData(thumb, 0, 0);
        const thumbBlob = await new Promise(resolve => thumbCanvas.toBlob(resolve, 'image/png'));
        thumbCanvas.width = thumbCanvas.height = 0;
        if (!thumbBlob) throw new Error(`无法创建「${file.name}」的缩略图。`);
        const entry = {
          id: createId(), file, width, height, animated,
          thumbUrl: '', sourceBlob: firstFrameBlob, sourceUrl: URL.createObjectURL(firstFrameBlob ?? file),
          status: 'idle', label: animated ? '动图已载入，使用首帧生成' : '已载入，等待处理', progress: 0,
        };
        entry.thumbUrl = URL.createObjectURL(thumbBlob);
        accepted.push(entry);
      } catch (error) { rejected.push(error.message); }
    }
    if (!accepted.length) throw new Error(rejected[0] ?? '请选择图片。');
    for (const entry of accepted) {
      state.entries.push(entry);
      createEntryRow(entry);
    }
    selectEntry(accepted[0]);
    if (rejected.length) onError(new Error(rejected.join(' ')));
  }

  function renderCharacterPresets() {
    elements.characterPresets.replaceChildren();
    for (const choice of state.characterPresets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'morph-character-choice';
      button.dataset.key = choice.key;
      button.title = choice.emoji ? `${choice.name} · Google Noto Emoji` : choice.name;
      button.setAttribute('aria-label', `使用字符参考图 ${choice.name}`);
      button.setAttribute('aria-pressed', String(choice.key === state.presetKey));
      button.disabled = state.busy || state.characterLoading;
      const image = document.createElement('img');
      image.src = choice.displaySrc;
      image.alt = choice.name;
      button.append(image);
      button.addEventListener('click', () => setPreset(choice.key));
      elements.characterPresets.append(button);
    }
  }

  function refreshPresets() {
    const previous = state.presetKey;
    const builtins = getPresets().filter(preset => !preset.animated && preset.staticImage !== false && preset.image);
    state.presets = [...builtins, ...state.characterPresets];
    elements.presets.replaceChildren();
    for (const choice of builtins) {
      const card = document.createElement('div');
      card.className = 'preset-card';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'phantom-preset morph-preset';
      button.dataset.key = choice.key;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(choice.key === previous));
      button.title = choice.name;
      button.disabled = state.busy || state.characterLoading;
      const image = document.createElement('img');
      image.src = choice.src;
      image.alt = '';
      const label = document.createElement('span');
      label.textContent = choice.name;
      button.append(image, label);
      button.addEventListener('click', () => setPreset(choice.key));
      card.append(button);
      if (choice.remove) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'preset-remove';
        remove.textContent = '×';
        remove.title = `删除 ${choice.name}`;
        remove.setAttribute('aria-label', remove.title);
        remove.disabled = state.busy || state.characterLoading;
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { await choice.remove(); } catch (error) { remove.disabled = false; onError(error); }
        });
        card.append(remove);
      }
      elements.presets.append(card);
    }
    const selected = state.presets.find(preset => preset.key === previous) ?? state.presets[0] ?? null;
    const changed = state.presetKey !== (selected?.key ?? null);
    state.presetKey = selected?.key ?? null;
    elements.presetName.textContent = selected?.name ?? '请选择';
    elements.presets.querySelectorAll('.morph-preset').forEach(button => {
      const selected = button.dataset.key === state.presetKey;
      button.setAttribute('aria-checked', String(selected));
      button.classList.toggle('is-active', selected);
    });
    if (changed && state.entries.some(ready)) invalidateResults('参考图已更新，请重新生成。');
    syncActions();
    updateCropPreview('target');
  }

  function invalidateResults(message = '动画选项已更新，请重新生成。') {
    for (const entry of state.entries) {
      if (entry.result) {
        revokeResult(entry);
        entry.status = 'idle';
        entry.label = message;
        entry.progress = 0;
      }
    }
    syncActions();
  }

  function setPreset(key) {
    if (state.busy || state.characterLoading) return;
    if (state.presetKey === key) return;
    state.presetKey = key;
    const preset = activePreset();
    elements.presetName.textContent = preset?.name ?? '请选择';
    elements.presets.querySelectorAll('.morph-preset').forEach(button => {
      const selected = button.dataset.key === key;
      button.setAttribute('aria-checked', String(selected));
      button.classList.toggle('is-active', selected);
    });
    elements.characterPresets.querySelectorAll('.morph-character-choice').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.key === key)));
    updateCropPreview('target');
    invalidateResults('参考图已更新，请重新生成。');
  }

  async function addCharacterPreset() {
    if (state.busy || state.characterLoading) return;
    const value = elements.characterInput.value.trim().normalize('NFC');
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
    if (!value || /^\s+$/u.test(value) || segments.length !== 1) {
      onError(new Error('请输入一个字符；emoji 组合也按一个字符计算。'));
      return;
    }
    const existing = state.characterPresets.find(choice => choice.character === value);
    if (existing) {
      elements.characterInput.value = '';
      setPreset(existing.key);
      return;
    }
    state.characterLoading = true;
    syncActions();
    let bitmap;
    let decodedSourceUrl;
    let previewBlob;
    const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u.test(value);
    try {
      const codepoints = Array.from(value, character => character.codePointAt(0).toString(16)).join('_');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (emoji) {
        const source = `https://fonts.gstatic.com/s/e/notoemoji/latest/${codepoints}/emoji.svg`;
        const blob = await loadBuiltinPreset(source);
        decodedSourceUrl = URL.createObjectURL(blob);
        bitmap = new Image();
        bitmap.src = decodedSourceUrl;
        await bitmap.decode();
        drawContained(bitmap, context, { x: 0, y: 0, width: 128, height: 128 });
        previewBlob = blob;
      } else {
        let size = 100;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = '#28261c';
        do {
          context.font = `700 ${size}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
          if (context.measureText(value).width <= 112 || size <= 28) break;
          size -= 4;
        } while (size > 24);
        context.fillText(value, 64, 66, 112);
        previewBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!previewBlob) throw new Error('无法创建字符参考图。');
      }
      const pixels = context.getImageData(0, 0, 128, 128).data;
      const choice = {
        key: `character:${value}`, name: value, character: value, emoji,
        src: URL.createObjectURL(previewBlob), displaySrc: '', image: { width: 128, height: 128, data: pixels }, staticImage: true,
      };
      choice.displaySrc = choice.src;
      state.characterLoading = false;
      state.characterPresets.push(choice);
      refreshPresets();
      setPreset(choice.key);
      elements.characterInput.value = '';
    } catch (error) {
      onError(new Error(emoji ? `无法加载 Google Emoji 参考图：${error.message}` : error.message));
    } finally {
      bitmap?.close?.();
      if (decodedSourceUrl) URL.revokeObjectURL(decodedSourceUrl);
      state.characterLoading = false;
      syncActions();
    }
  }

  async function perform(entry) {
    const preset = activePreset();
    if (!preset?.image) throw new Error('请选择参考图。');
    const presetKey = state.presetKey;
    const sourceCrop = cropValues('source');
    const targetCrop = cropValues('target');
    revokeResult(entry);
    entry.status = 'processing';
    entry.label = '正在准备图片…';
    entry.progress = 0;
    syncActions();
    let sourceBitmap;
    let workerProgress = 0;
    let displayedProgress = 0;
    const startedAt = performance.now();
    const refreshProgress = () => {
      if (!state.entries.includes(entry) || entry.status !== 'processing') return;
      displayedProgress = Math.min(0.99, Math.max(displayedProgress, displayProgress(workerProgress, performance.now() - startedAt)));
      entry.progress = displayedProgress;
      entry.label = `正在生成 GIF · ${Math.round(entry.progress * 100)}%`;
      setStatus(entry.label);
      renderActive();
    };
    const progressTimer = setInterval(refreshProgress, 100);
    try {
      sourceBitmap = await createImageBitmap(entry.sourceBlob ?? entry.file);
      if (!state.entries.includes(entry)) {
        sourceBitmap.close();
        sourceBitmap = null;
        const error = new Error('已移除处理中条目。');
        error.name = 'AbortError';
        throw error;
      }
      const side = Number(elements.resolution.value);
      const aspect = entry.width / entry.height;
      const { width, height } = outputDimensions(entry.width, entry.height);
      let source = squarePixels(sourceBitmap, side, sourceCrop, aspect);
      sourceBitmap.close();
      sourceBitmap = null;
      let target = squarePixels(preset.image, side, targetCrop, aspect, true);
      const direction = elements.direction.value;
      if (direction === 'reverse') [source, target] = [target, source];
      entry.label = '正在计算网格迁移…';
      syncActions();
      const result = await generateInWorker(entry, source, target, side, aspect, width, height, {
        proximityImportance: Number(elements.proximity.value),
      }, fraction => {
        workerProgress = fraction;
        refreshProgress();
      });
      if (!state.entries.includes(entry)) return;
      if (state.presetKey !== presetKey) throw new Error('参考图已更新，结果未保存，请重新生成。');
      revokeResult(entry);
      entry.result = result;
      entry.resultUrl = URL.createObjectURL(result);
      entry.resultFrames = FRAMES;
      entry.resultWidth = width;
      entry.resultHeight = height;
      entry.direction = direction;
      entry.status = 'done';
      entry.progress = 1;
      entry.label = `完成 · ${entry.resultFrames} 帧 · ${formatBytes(result.size)}`;
      onGenerated();
    } catch (error) {
      if (sourceBitmap) sourceBitmap.close();
      if (state.entries.includes(entry)) {
        entry.status = 'error';
        entry.label = error.message;
        entry.progress = 0;
      }
      throw error;
    } finally {
      clearInterval(progressTimer);
    }
  }

  async function runSingle(entry) {
    if (state.busy || state.characterLoading || !state.entries.includes(entry)) return;
    state.busy = true;
    selectEntry(entry);
    try { await perform(entry); }
    catch (error) { if (error.name !== 'AbortError') onError(error); }
    finally { state.busy = false; syncActions(); scrollToResultOnMobile(); }
  }

  async function runBatch() {
    if (state.busy || state.characterLoading) return;
    const entries = state.entries.filter(entry => entry.status !== 'loading');
    const restart = entries.length > 0 && entries.every(ready);
    const queue = entries.filter(entry => restart || !ready(entry));
    if (!queue.length) return;
    state.busy = true;
    syncActions();
    for (const entry of queue) {
      if (!state.entries.includes(entry)) continue;
      selectEntry(entry);
      try { await perform(entry); }
      catch (error) { if (error.name !== 'AbortError') onError(error); }
    }
    state.busy = false;
    syncActions();
    scrollToResultOnMobile();
  }

  async function downloadAll() {
    const entries = state.entries.filter(ready);
    if (!entries.length) return;
    elements.downloadAll.disabled = true;
    elements.downloadAll.textContent = '正在打包…';
    try {
      const files = entries.map(entry => ({ blob: entry.result, name: `${stem(entry.file)}-naiwa-morph.gif` }));
      const zip = await zipFiles(files, (done, total) => { elements.downloadAll.textContent = `正在打包 ${done}/${total}…`; });
      downloadBlob(zip, 'naiwa-morph-animations.zip');
    } catch (error) { onError(error); }
    finally { elements.downloadAll.textContent = '下载全部 GIF（ZIP）'; syncActions(); }
  }

  async function downloadCurrentWebP() {
    const entry = activeEntry();
    if (!ready(entry) || state.busy || state.webpBusy) return;
    state.webpBusy = true;
    syncActions();
    try {
      if (!entry.webpResult) {
        entry.webpResult = await createAnimatedWebP(entry.result, {
          quality: 0.65,
          onProgress: fraction => setStatus(`正在编码 WebP · ${Math.round(fraction * 100)}%`),
        });
      }
      if (state.entries.includes(entry)) downloadBlob(entry.webpResult, `${stem(entry.file)}-naiwa-morph.webp`);
    } catch (error) {
      onError(error);
    } finally {
      state.webpBusy = false;
      syncActions();
    }
  }

  elements.sourcePicker.addEventListener('click', () => elements.sourceFile.click());
  elements.sourceFile.addEventListener('change', async () => {
    const files = [...elements.sourceFile.files];
    elements.sourceFile.value = '';
    try { if (files.length) await importFiles(files); } catch (error) { onError(error); }
  });
  elements.characterAdd.addEventListener('click', addCharacterPreset);
  elements.characterInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCharacterPreset();
  });
  const sourceSection = elements.sourcePicker.closest('.control-section');
  sourceSection.addEventListener('dragenter', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    sourceSection.classList.add('is-drop-active');
  });
  sourceSection.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  sourceSection.addEventListener('dragleave', event => {
    if (!sourceSection.contains(event.relatedTarget)) sourceSection.classList.remove('is-drop-active');
  });
  sourceSection.addEventListener('drop', async event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    sourceSection.classList.remove('is-drop-active');
    try { await importFiles([...event.dataTransfer.files]); } catch (error) { onError(error); }
  });
  elements.presetPicker.addEventListener('click', () => elements.presetFile.click());
  elements.presetFile.addEventListener('change', async () => {
    const file = elements.presetFile.files[0];
    elements.presetFile.value = '';
    try {
      if (!file) return;
      await assertStaticImage(file);
      const key = await onCustomPreset(file);
      refreshPresets();
      if (key) setPreset(key);
    } catch (error) { onError(error); }
  });
  elements.presetPicker.addEventListener('dragover', event => { event.preventDefault(); elements.presetPicker.classList.add('is-dragging'); });
  elements.presetPicker.addEventListener('dragleave', () => elements.presetPicker.classList.remove('is-dragging'));
  elements.presetPicker.addEventListener('drop', async event => {
    event.preventDefault();
    elements.presetPicker.classList.remove('is-dragging');
    try {
      const file = event.dataTransfer.files[0];
      if (!file) return;
      await assertStaticImage(file);
      const key = await onCustomPreset(file);
      refreshPresets();
      if (key) setPreset(key);
    } catch (error) { onError(error); }
  });
  elements.generate.addEventListener('click', runBatch);
  elements.previous.addEventListener('click', () => {
    if (state.busy) return;
    const index = state.entries.indexOf(activeEntry());
    if (index > 0) selectEntry(state.entries[index - 1]);
  });
  elements.next.addEventListener('click', () => {
    if (state.busy) return;
    const index = state.entries.indexOf(activeEntry());
    if (index >= 0 && index < state.entries.length - 1) selectEntry(state.entries[index + 1]);
  });
  elements.download.addEventListener('click', () => {
    const entry = activeEntry();
    if (ready(entry)) downloadBlob(entry.result, `${stem(entry.file)}-naiwa-morph.gif`);
  });
  elements.downloadWebP.addEventListener('click', downloadCurrentWebP);
  elements.downloadAll.addEventListener('click', downloadAll);
  elements.direction.addEventListener('change', () => invalidateResults());
  for (const key of ['source', 'target']) {
    const panel = elements[`${key}Crop`];
    panel.querySelectorAll('[data-crop-axis]').forEach(input => input.addEventListener('input', () => {
      updateCropPreviewValues(key);
      if (state.entries.some(ready)) invalidateResults('取景已更新，请重新生成。');
    }));
    panel.querySelector('[data-crop-reset]').addEventListener('click', () => {
      if (state.busy) return;
      panel.querySelector('[data-crop-axis="x"]').value = '0';
      panel.querySelector('[data-crop-axis="y"]').value = '0';
      panel.querySelector('[data-crop-axis="zoom"]').value = '1';
      updateCropPreviewValues(key);
      if (state.entries.some(ready)) invalidateResults('取景已更新，请重新生成。');
    });
  }
  elements.resolution.addEventListener('input', () => {
    elements.resolutionValue.textContent = `${elements.resolution.value} × ${elements.resolution.value}`;
    if (state.entries.some(ready)) invalidateResults('细度已更新，请重新生成。');
  });
  elements.proximity.addEventListener('input', () => {
    elements.proximityValue.textContent = elements.proximity.value;
    if (state.entries.some(ready)) invalidateResults('邻近权重已更新，请重新生成。');
  });
  elements.presets.addEventListener('keydown', event => {
    if (!event.target.classList.contains('morph-preset')) return;
    const choices = [...elements.presets.querySelectorAll('.morph-preset')];
    const index = choices.indexOf(event.target);
    const destination = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % choices.length
        : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + choices.length - 1) % choices.length : -1;
    if (destination < 0 || !choices.length) return;
    event.preventDefault();
    setPreset(choices[destination].dataset.key);
    choices[destination].focus();
  });

  refreshPresets();
  return { refreshPresets, setPreset };
}
