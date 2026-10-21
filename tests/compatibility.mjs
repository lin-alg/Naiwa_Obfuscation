// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeImage, restoreImage, imageSimilarity } from '../core.mjs';
import { artifactDirectory } from './artifact-paths.mjs';

const directory = await artifactDirectory('compatibility');
for (const name of ['core.mjs', 'reed-solomon.mjs']) await writeFile(join(directory, name), execFileSync('git', ['show', `b5d2b4f:${name}`]));
const old = await import(pathToFileURL(join(directory, 'core.mjs')));
function image(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set([x * 7 % 256, y * 5 % 256, (x + y) * 3 % 256, 255], (y * width + x) * 4);
  return { width, height, data };
}
const preset = image(97, 61);
for (const [width, height, tileSize, scale] of [[192,128,8,2], [319,173,16,1.5], [17,129,8,3], [128,1024,16,1.5], [192,128,3,5.5], [192,128,7,2.5], [192,128,4,3], [192,128,32,2]]) {
  const source = image(width, height); const options = { tileSize, scale, step: 16 };
  const encoded = await old.encodeImage(source, preset, options);
  const carrier = { width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data };
  const previous = await old.restoreImage(carrier);
  const current = await restoreImage(carrier);
  let different = 0;
  for (let i = 0; i < current.data.length; i += 1) if (current.data[i] !== previous.data[i]) different += 1;
  assert.equal(different, 0, 'old v6 carrier must restore to identical pixels');
  const fresh = await encodeImage(source, preset, options);
  const restored = await restoreImage({ width: fresh.plan.outputWidth, height: fresh.plan.outputHeight, data: fresh.data });
  const oldScore = imageSimilarity(source.data, previous.data, width, height);
  const newScore = imageSimilarity(source.data, restored.data, width, height);
  assert.ok(newScore >= oldScore - 0.01, `quality regression at tile ${tileSize}: ${oldScore} -> ${newScore}`);
  console.log(`compatibility ${width}x${height} tile=${tileSize} scale=${scale}: identical legacy restoration; SSIM delta=${(newScore - oldScore).toFixed(6)}`);
}
