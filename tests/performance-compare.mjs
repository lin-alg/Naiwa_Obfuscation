// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactDirectory } from './artifact-paths.mjs';
import { decode, jpeg } from './image-io.mjs';
import * as current from '../src/core.mjs';

const directory = await artifactDirectory('performance');
const root = fileURLToPath(new URL('../', import.meta.url));
const revision = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11) ?? 'b5d2b4f';
for (const name of ['core.mjs', 'reed-solomon.mjs']) {
  await writeFile(join(directory, name), execFileSync('git', ['show', `${revision}:${name}`], { cwd: root }));
}
const baseline = await import(pathToFileURL(join(directory, 'core.mjs')));
const maxSide = Number(process.argv.find(arg => arg.startsWith('--max-side='))?.slice(11) ?? 1024);
const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url)));
const preset = await decode(fileURLToPath(new URL('../assets/images/static/奶蛙.png', import.meta.url)), 512, 512);
const rows = [];
for (const entry of manifest) {
  const ratio = Math.min(1, maxSide / Math.max(entry.width, entry.height));
  const width = Math.round(entry.width * ratio); const height = Math.round(entry.height * ratio);
  const source = await decode(join(root, 'tests/fixtures/static', entry.name), width, height, `scale=${width}:${height}:flags=area`);
  const row = { image: entry.name, size: `${width}x${height}`, stages: {} };
  let oldEncoded;
  for (const [name, implementation] of [['baseline', baseline], ['optimized', current]]) {
    global.gc?.();
    const start = performance.now();
    const encoded = await implementation.encodeImage(source, preset, {
      tileSize: 8, scale: 2, step: 16,
      onTiming: (stage, ms) => { row.stages[`encode:${stage}`] = Math.round(ms); },
    });
    row[`${name}EncodeMs`] = Math.round(performance.now() - start);
    if (name === 'baseline') oldEncoded = encoded;
    else {
      let different = 0; let maxDelta = 0;
      for (let i = 0; i < encoded.data.length; i += 1) {
        const delta = Math.abs(encoded.data[i] - oldEncoded.data[i]);
        if (delta) different += 1;
        maxDelta = Math.max(maxDelta, delta);
      }
      row.changedChannels = different; row.maxChannelDelta = maxDelta;
    }
    // Both decoders read the exact same compressed baseline carrier.
    const carrier = { width: oldEncoded.plan.outputWidth, height: oldEncoded.plan.outputHeight, data: oldEncoded.data };
    const compressed = await decode(await jpeg(carrier, 75), carrier.width, carrier.height);
    const restoreStart = performance.now();
    const restored = await implementation.restoreImage(compressed, {
      onTiming: (stage, ms) => { row.stages[`restore:${stage}`] = Math.round(ms); },
    });
    row[`${name}RestoreMs`] = Math.round(performance.now() - restoreStart);
    row[`${name}SSIM`] = current.imageSimilarity(source.data, restored.data, width, height);
    if (name === 'baseline') row.restored = restored.data;
    else {
      let different = 0;
      for (let i = 0; i < restored.data.length; i += 1) if (restored.data[i] !== row.restored[i]) different += 1;
      row.changedRestoredChannels = different;
      assert.ok(row.optimizedSSIM >= row.baselineSSIM - 0.001, 'restoration quality must be preserved');
      const ownCarrier = { width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data };
      const ownCompressed = await decode(await jpeg(ownCarrier, 75), ownCarrier.width, ownCarrier.height);
      const ownRestored = await current.restoreImage(ownCompressed);
      row.optimizedOwnSSIM = current.imageSimilarity(source.data, ownRestored.data, width, height);
      row.restoredSSIMDelta = row.optimizedOwnSSIM - row.baselineSSIM;
      assert.ok(Math.abs(row.restoredSSIMDelta) < 0.01, 'optimized encoding must preserve JPEG restoration quality');
    }
  }
  delete row.restored;
  row.encodeSpeedup = Number((row.baselineEncodeMs / row.optimizedEncodeMs).toFixed(2));
  row.restoreSpeedup = Number((row.baselineRestoreMs / row.optimizedRestoreMs).toFixed(2));
  rows.push(row); console.log(JSON.stringify(row));
}
await writeFile(join(directory, 'comparison.json'), JSON.stringify({ revision, maxSide, rows }, null, 2));
