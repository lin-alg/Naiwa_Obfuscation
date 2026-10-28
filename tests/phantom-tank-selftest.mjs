// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { imageSimilarity } from '../src/core.mjs';
import { adjustPhantomImage, composePhantomTank } from '../src/phantom-tank.mjs';

const makeImage = (width, height, pixel) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    data.set([...pixel(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
};
const outer = makeImage(96, 80, (x, y) => [(x * 13 + y * 7) % 256, (x * 3 + y * 17) % 256, (x * 19 + y * 5) % 256]);
const inner = makeImage(96, 80, (x, y) => [(255 - x * 11 + y * 3) % 256, (y * 9 + x * 5) % 256, (x * 7 + 255 - y * 13) % 256]);
const composite = (rgba, background) => {
  const data = new Uint8ClampedArray(rgba.length);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) data[offset + channel] = rgba[offset + channel] * alpha + background * (1 - alpha);
    data[offset + 3] = 255;
  }
  return data;
};
const scaled = (image, transform) => ({
  width: image.width,
  height: image.height,
  data: Uint8ClampedArray.from(image.data, (value, index) => index % 4 === 3 ? 255 : transform(value, index % 4)),
});
const outerAdjusted = adjustPhantomImage(outer);
const innerAdjusted = adjustPhantomImage(inner);
const color = composePhantomTank(innerAdjusted, outerAdjusted, 'color');
const darkColorTarget = scaled(innerAdjusted, value => Math.floor(value * 0.3));
const lightColorTarget = scaled(outerAdjusted, value => Math.floor(255 - (255 - value) * 0.6));
const colorDarkSSIM = imageSimilarity(composite(color.data, 0), darkColorTarget.data, color.width, color.height, 96, true);
const colorLightSSIM = imageSimilarity(composite(color.data, 255), lightColorTarget.data, color.width, color.height, 96, true);
assert.ok(Number.isFinite(colorDarkSSIM) && colorDarkSSIM >= 0 && colorDarkSSIM <= 1);
assert.ok(Number.isFinite(colorLightSSIM) && colorLightSSIM >= 0 && colorLightSSIM <= 1);
for (let offset = 0; offset < color.data.length; offset += 4) {
  assert.ok(color.data[offset] <= 255 && color.data[offset + 1] <= 255 && color.data[offset + 2] <= 255);
  assert.ok(color.data[offset + 3] <= 255);
}

const monoOuter = adjustPhantomImage(outer, {}, 'mono');
const monoInner = adjustPhantomImage(inner, {}, 'mono');
const mono = composePhantomTank(monoInner, monoOuter, 'mono');
const darkMonoTarget = scaled(monoInner, value => Math.floor(value * 0.5));
const lightMonoTarget = scaled(monoOuter, value => Math.floor(255 - (255 - value) * 0.5));
const monoDarkSSIM = imageSimilarity(composite(mono.data, 0), darkMonoTarget.data, mono.width, mono.height, 96);
const monoLightSSIM = imageSimilarity(composite(mono.data, 255), lightMonoTarget.data, mono.width, mono.height, 96);
assert.ok(monoDarkSSIM > 0.99, `monochrome dark-side SSIM too low: ${monoDarkSSIM}`);
assert.ok(monoLightSSIM > 0.99, `monochrome light-side SSIM too low: ${monoLightSSIM}`);
for (let offset = 0; offset < mono.data.length; offset += 4) {
  assert.equal(mono.data[offset], mono.data[offset + 1]);
  assert.equal(mono.data[offset + 1], mono.data[offset + 2]);
}
const cloakColor = composePhantomTank(makeImage(2, 1, () => [120, 90, 30]), makeImage(2, 1, () => [40, 220, 160]), 'color').data;
assert.deepEqual(Array.from(cloakColor), [51, 51, 51, 255, 0, 136, 58, 88]);

const adjusted = adjustPhantomImage(makeImage(1, 1, () => [100, 150, 200]), { contrast: 50, brightness: 60 });
assert.deepEqual(Array.from(adjusted.data), [130, 180, 230, 255]);
assert.throws(() => composePhantomTank(outer, makeImage(1, 1, () => [1, 2, 3]), 'color'), /尺寸相同/);
assert.throws(() => composePhantomTank(outer, inner, 'sepia'), /未知/);

console.log(`phantom tank SSIM passed: color black=${colorDarkSSIM.toFixed(4)}, white=${colorLightSSIM.toFixed(4)}; mono black=${monoDarkSSIM.toFixed(4)}, white=${monoLightSSIM.toFixed(4)}`);
