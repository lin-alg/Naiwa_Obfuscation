// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createPlan, encodeImage, fitImage, flattenImage, imageSimilarity, restoreImage } from '../core.mjs';
import { encodeRS, decodeRS } from '../reed-solomon.mjs';

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
const preset = image(97, 61, true);
const fitted = fitImage(preset, 512, 256, 'contain');
assert.equal(fitted.data[0], 255, 'contain preserves the full preset with white letterboxing');
assert.equal(fitted.data[3], 255);
const alphaPixel = flattenImage({ width: 1, height: 1, data: new Uint8ClampedArray([0, 40, 80, 0]) });
assert.deepEqual([...alphaPixel.data], [255, 255, 255, 255], 'fully transparent RGB must not influence the white matte');
await assert.rejects(restoreImage({ width: 512, height: 512, data: new Uint8ClampedArray(512 * 512 * 4).fill(255) }), /没有找到/);
for (const [width, height, tileSize, transparent] of [[512, 512, 8, false], [319, 173, 16, true], [17, 129, 8, true]]) {
  const source = image(width, height, transparent);
  const encoded = await encodeImage(source, preset, { tileSize, step: 16 });
  const restored = await restoreImage({ width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data });
  assert.equal(restored.plan.width, width);
  assert.equal(restored.plan.height, height);
  assert.equal(restored.data.length, source.data.length);
  assert.ok(Number.isFinite(encoded.resemblance.outline));
  const score = imageSimilarity(flattenImage(source).data, restored.data, width, height);
  assert.ok(score > 0.65, `unexpectedly low restored SSIM ${score}`);
  console.log(`roundtrip ${width}x${height}, tile=${tileSize}, alpha=${transparent}, SSIM=${score.toFixed(4)}, corrected=${restored.plan.corrected}`);
}
const plain = image(128, 128);
const shuffled = await encodeImage(plain, preset, { tileSize: 8, scale: 2, step: 8, colorAdapt: false });
const plainRestore = await restoreImage({ width: shuffled.plan.outputWidth, height: shuffled.plan.outputHeight, data: shuffled.data });
assert.equal(plainRestore.plan.colorAdapt, false);
assert.ok(imageSimilarity(plain.data, plainRestore.data, 128, 128) > 0.85);
const same = image(257, 119, true);
assert.ok(imageSimilarity(same.data, same.data, 257, 119) > 0.999999);
console.log('selftest passed: fine tiles, RS correction, mismatched preset dimensions, alpha matte, padded edges and narrow images');
