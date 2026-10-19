// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeImage, restoreImage, imageSimilarity } from '../core.mjs';
import { decode, jpeg, png } from './image-io.mjs';
import { artifactDirectory, artifactEnvironment } from './artifact-paths.mjs';

const directory = await artifactDirectory('compact');
if (process.argv.includes('--background')) {
  const log = await open(join(directory, 'benchmark.log'), 'w');
  const errors = await open(join(directory, 'errors.log'), 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: ['ignore', log.fd, errors.fd], windowsHide: true, env: artifactEnvironment(directory) });
  child.unref(); await log.close(); await errors.close();
  console.log(`Compact benchmark PID ${child.pid}`);
  process.exit(0);
}
const presets = ['奶蛙.png', 'naishu.png', 'naigou.png', 'naidan.png'];
const photos = [
  ['1.jpg', 5263, 2961],
  ['2.jpg', 3840, 2160],
  ['3.jpg', 3840, 2160],
  ['4.jpg', 3840, 2160],
];
const results = [];
for (const [filename, width, height] of photos) {
  const factor = Math.min(1, 1024 / Math.max(width, height));
  const sampleWidth = Math.round(width * factor); const sampleHeight = Math.round(height * factor);
  const source = await decode(fileURLToPath(new URL(`../test/static/${filename}`, import.meta.url)), sampleWidth, sampleHeight,
    factor < 1 ? `scale=${sampleWidth}:${sampleHeight}:flags=area` : undefined);
  for (const presetName of presets) {
    const preset = await decode(fileURLToPath(new URL(`../images/static/${presetName}`, import.meta.url)), 512, 512);
    for (const [tileSize, scale] of [[8, 2], [8, 1.5], [16, 1.5]]) {
      const encoded = await encodeImage(source, preset, { tileSize, scale, step: 16 });
      const image = { width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data };
      for (const quality of [75, 65]) {
        const bytes = await jpeg(image, quality);
        let restoredSSIM = 0; let error = null;
        try {
          const restored = await restoreImage(await decode(bytes, image.width, image.height));
          restoredSSIM = imageSimilarity(source.data, restored.data, width, height);
        } catch (failure) { error = failure.message; }
        const row = { filename, width: sampleWidth, height: sampleHeight, preset: presetName, tileSize, scale, quality, bytes: bytes.length, restoredSSIM, presetSSIM: encoded.resemblance.outline, error };
        results.push(row);
        console.log(JSON.stringify(row));
      }
      if (filename === photos[0][0] && presetName === 'naigou.png') await writeFile(join(directory, `dog-${tileSize}px-${scale}x.png`), await png(image));
    }
  }
}
const averages = [2, 1.5].flatMap(scale => [8, 16].flatMap(tileSize => [75, 65].flatMap(quality => {
  const rows = results.filter(row => row.scale === scale && row.tileSize === tileSize && row.quality === quality);
  if (!rows.length) return [];
  return [{ scale, tileSize, quality, count: rows.length, restored: rows.filter(row => !row.error).length, bytes: rows.reduce((s, r) => s + r.bytes, 0) / rows.length, ssim: rows.reduce((s, r) => s + r.restoredSSIM, 0) / rows.length, presetSSIM: rows.reduce((s, r) => s + r.presetSSIM, 0) / rows.length }];
})));
await writeFile(join(directory, 'results.json'), JSON.stringify({ results, averages }, null, 2));
console.log(JSON.stringify(averages, null, 2));
