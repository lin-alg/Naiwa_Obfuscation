// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encodeImage, imageSimilarity, restoreImage } from '../src/core.mjs';
import { decode, jpeg } from './image-io.mjs';

const maxSide = Number(process.argv.find((value) => value.startsWith('--max-side='))?.slice(11) ?? 768);
const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'));
const preset = await decode(fileURLToPath(new URL('../assets/images/static/奶蛙.png', import.meta.url)), 512, 512);
const results = [];

for (const entry of manifest) {
  const scale = Math.min(1, maxSide / Math.max(entry.width, entry.height));
  const width = Math.max(1, Math.round(entry.width * scale));
  const height = Math.max(1, Math.round(entry.height * scale));
  const source = await decode(fileURLToPath(new URL(`./fixtures/static/${entry.name}`, import.meta.url)), width, height,
    scale < 1 ? `scale=${width}:${height}:flags=area` : undefined);
  const started = performance.now();
  const encoded = await encodeImage(source, preset, { tileSize: 8, scale: 2, step: 16 });
  const encodeMs = performance.now() - started;
  const carrier = { width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data };
  const compressed = await decode(await jpeg(carrier, 75), carrier.width, carrier.height);
  let restoredSSIM = 0;
  let decoded = true;
  try {
    const restored = await restoreImage(compressed);
    restoredSSIM = imageSimilarity(source.data, restored.data, width, height);
  } catch {
    decoded = false;
  }
  const row = {
    image: entry.name,
    source: `${width}x${height}`,
    carrier: `${carrier.width}x${carrier.height}`,
    encodeMs: Math.round(encodeMs),
    decoded,
    restoredSSIM: Number(restoredSSIM.toFixed(5)),
    presetOutline: Number(encoded.resemblance.outline.toFixed(5)),
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

console.log(JSON.stringify({ maxSide, meanEncodeMs: Math.round(results.reduce((sum, row) => sum + row.encodeMs, 0) / results.length), results }, null, 2));
