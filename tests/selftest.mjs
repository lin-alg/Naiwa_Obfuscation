// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createPlan, encodeImage, fitImage, flattenImage, imageSimilarity, restoreImage } from '../core.mjs';
import { encodeRS, decodeRS } from '../reed-solomon.mjs';
import { sourceSizing } from '../image-sizing.mjs';

const message = Uint8Array.from({ length: 159 }, (_, i) => (i * 37 + 19) % 256);
const corrupted = encodeRS(message);
for (let i = 0; i < 48; i += 1) corrupted[i * 5] ^= 17 + i;
assert.deepEqual(decodeRS(corrupted).data, message, 'RS must recover 48 corrupted bytes');
for (let i = 0; i < 20; i += 1) corrupted[240 + i % 15] ^= i + 1;
assert.throws(() => decodeRS(corrupted), /纠错/);

function image(width, height, transparent = false) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    data[offset] = (x * 3 + y) % 256;
    data[offset + 1] = (y * 2 + 50) % 256;
    data[offset + 2] = (x + 70) % 256;
    data[offset + 3] = transparent ? (x * 7) % 256 : 255;
  }
  return { width, height, data };
}

assert.equal(createPlan(1920, 1200).tileSize, 8);
assert.equal(createPlan(1920, 1200).tileCount, 36000);
assert.equal(createPlan(192, 128, { tileSize: 32 }).tileSize, 32, 'previous v6 outputs with 32px tiles remain readable');
for (let tileSize = 2; tileSize <= 16; tileSize += 1) {
  const scale = Math.max(1, Math.min(8, Math.round((16 / tileSize) * 2) / 2));
  const plan = createPlan(192, 128, { tileSize, scale });
  assert.equal(plan.tileSize, tileSize);
  assert.equal(plan.scale, scale);
  assert.equal(plan.outputWidth % 8, 0);
  assert.equal(plan.outputHeight % 8, 0);
}
for (let halfSteps = 2; halfSteps <= 16; halfSteps += 1) {
  const plan = createPlan(192, 128, { tileSize: 8, scale: halfSteps / 2 });
  assert.equal(plan.scale, halfSteps / 2);
}
assert.throws(() => createPlan(192, 128, { tileSize: 17 }), /2 到 16/);
assert.throws(() => createPlan(192, 128, { scale: 8.5 }), /1 到 8/);
for (const scale of [1, 1.5, 2, 3, 4]) {
  try {
    const plan = createPlan(319, 173, { tileSize: 4, scale });
    assert.equal(plan.outputWidth % 8, 0); assert.equal(plan.outputHeight % 8, 0);
  } catch (error) { assert.match(error.message, /无法生成可还原/); }
}
const preset = image(97, 61, true);
const fitted = fitImage(preset, 512, 256, 'contain');
assert.equal(fitted.data[3], 0, 'contain pads the preset with transparent pixels');
const alphaEdge = fitImage({ width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255]) }, 3, 1, 'stretch');
assert.deepEqual([...alphaEdge.data.subarray(4, 8)], [0, 0, 255, 128], 'resampling must not blend invisible RGB into the preset edge');
const alphaPixel = flattenImage({ width: 1, height: 1, data: new Uint8ClampedArray([0, 40, 80, 0]) });
assert.deepEqual([...alphaPixel.data], [255, 255, 255, 255], 'fully transparent RGB must not influence the white matte');
await assert.rejects(restoreImage({ width: 512, height: 512, data: new Uint8ClampedArray(512 * 512 * 4).fill(255) }), /没有找到/);
for (const [width, height, tileSize, transparent, scale = 2] of [[512, 512, 8, false], [319, 173, 16, true], [17, 129, 8, true], [319, 173, 16, false, 1.5], [1024, 128, 16, false, 1.5], [128, 1024, 16, true, 1.5], [512, 512, 4, false, 3], [319, 173, 4, false, 4]]) {
  const source = image(width, height, transparent);
  const encoded = await encodeImage(source, preset, { tileSize, scale, step: 16 });
  const restored = await restoreImage({ width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data });
  assert.equal(restored.plan.width, width);
  assert.equal(restored.plan.height, height);
  assert.equal(restored.data.length, source.data.length);
  assert.equal(restored.plan.panels, encoded.plan.panels);
  assert.ok(Number.isFinite(encoded.resemblance.outline));
  const score = imageSimilarity(flattenImage(source).data, restored.data, width, height);
  assert.ok(score > 0.65, `unexpectedly low restored SSIM ${score}`);
  console.log(`roundtrip ${width}x${height}, tile=${tileSize}, scale=${encoded.plan.scale}, panels=${encoded.plan.panels}, alpha=${transparent}, SSIM=${score.toFixed(4)}, corrected=${restored.plan.corrected}`);
}
for (const colorGain of [1, 0.75, 0.5, 0.25]) {
  const source = image(128, 128);
  const encoded = await encodeImage(source, preset, { tileSize: 8, scale: 2, step: 18, colorGain });
  const restored = await restoreImage({ width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data });
  assert.equal(restored.plan.colorGain, colorGain, `header must preserve ${colorGain} color-adaptation gain for restoration`);
}
assert.throws(() => createPlan(192, 128, { tileSize: 3, scale: 1.5 }), /无法生成可还原/);
for (const [tileSize, scale] of [[3, 5.5], [7, 2.5]]) {
  const source = image(192, 128);
  const encoded = await encodeImage(source, preset, { tileSize, scale, step: 16 });
  const restored = await restoreImage({ width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data });
  assert.equal(restored.plan.tileSize, tileSize);
  assert.equal(restored.plan.scale, scale);
  assert.equal(restored.plan.width, source.width);
  assert.equal(restored.plan.height, source.height);
}
const plain = image(128, 128);
const shuffled = await encodeImage(plain, preset, { tileSize: 8, scale: 2, step: 8, colorAdapt: false });
const plainRestore = await restoreImage({ width: shuffled.plan.outputWidth, height: shuffled.plan.outputHeight, data: shuffled.data });
assert.equal(plainRestore.plan.colorAdapt, false);
const plainScore = imageSimilarity(plain.data, plainRestore.data, 128, 128);
assert.ok(plainScore > 0.85, `unadapted roundtrip SSIM ${plainScore}`);
const same = image(257, 119, true);
assert.ok(imageSimilarity(same.data, same.data, 257, 119) > 0.999999);
assert.deepEqual(sourceSizing(500, 800), { width: 1024, height: 1638, scale: 2.048, automatic: true });
assert.equal(sourceSizing(8000, 4000).width, 2960);
assert.equal(sourceSizing(8000, 4000).height, 1480);
assert.equal(sourceSizing(1600, 1200).scale, 1);
assert.equal(sourceSizing(9000, 300).width, 2960, 'extreme aspect ratios prioritize the long-edge limit');
assert.equal(sourceSizing(1600, 1200, 50).height, 600);
assert.throws(() => sourceSizing(8000, 4000, 100), /过大/);
const limited = sourceSizing(2560, 1440, null, 31000000 / 16);
const largeCarrier = createPlan(limited.width, limited.height, { tileSize: 4, scale: 4 });
assert.ok(largeCarrier.outputWidth * largeCarrier.outputHeight <= 32000000, 'automatic source sizing must leave room for a 4x carrier');
const solid = { width: 512, height: 512, data: new Uint8ClampedArray(512 * 512 * 4) };
for (let p = 0; p < solid.data.length; p += 4) { solid.data.fill(128, p, p + 3); solid.data[p + 3] = 255; }
const uniform = await encodeImage(solid, solid, { tileSize: 16, scale: 1.5, colorAdapt: false });
const bandEnergy = (top, bottom) => {
  let energy = 0;
  for (let y = top; y < bottom; y += 1) for (let x = 0; x < uniform.plan.outputWidth; x += 1) energy += (uniform.data[(y * uniform.plan.outputWidth + x) * 4] - 128) ** 2;
  return energy / ((bottom - top) * uniform.plan.outputWidth);
};
const topEnergy = bandEnergy(0, 192); const bottomEnergy = bandEnergy(576, 768);
assert.ok(bottomEnergy > topEnergy * 0.5 && bottomEnergy < topEnergy * 2, `watermark must reach the bottom uniformly: ${topEnergy} / ${bottomEnergy}`);
const white = { ...solid, data: new Uint8ClampedArray(solid.data.length).fill(255) };
const mixedBackground = await encodeImage(image(512, 512), white, { tileSize: 16, scale: 1.5 });
const backgroundError = (top, bottom) => {
  let error = 0;
  for (let y = top; y < bottom; y += 1) for (let x = 0; x < mixedBackground.plan.outputWidth; x += 1) error += 255 - mixedBackground.data[(y * mixedBackground.plan.outputWidth + x) * 4];
  return error / ((bottom - top) * mixedBackground.plan.outputWidth);
};
const upperError = backgroundError(0, 192); const lowerError = backgroundError(576, 768);
assert.ok(lowerError > upperError * 0.8 && lowerError < upperError * 1.25, `flat preset tiles must mix source blocks across the whole image: ${upperError} / ${lowerError}`);
const halves = (reverse = false) => {
  const width = 256; const height = 128; const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = (x < width / 2) !== reverse ? 32 : 224;
    data.set([value, value, value, 255], (y * width + x) * 4);
  }
  return { width, height, data };
};
const crossed = await encodeImage(halves(), halves(true), { scale: 2, tileSize: 8, colorAdapt: false, fit: 'stretch', step: 8 });
let leftTotal = 0; let rightTotal = 0;
for (let y = 0; y < crossed.plan.outputHeight; y += 1) for (let x = 0; x < crossed.plan.outputWidth; x += 1) {
  const value = crossed.data[(y * crossed.plan.outputWidth + x) * 4];
  if (x < crossed.plan.outputWidth / 2) leftTotal += value;
  else rightTotal += value;
}
assert.ok((leftTotal - rightTotal) / (crossed.plan.outputWidth * crossed.plan.outputHeight / 2) > 150, 'matching must move blocks across the image center to follow the preset');
console.log('selftest passed: fractional carriers, transparent preset padding, automatic sizing, segmented panoramas and evenly distributed watermark');
