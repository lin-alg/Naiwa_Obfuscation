// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFile } from 'node:fs/promises';
import { FORMAT_VERSION, encodeImage, fitImage, flattenImage, imageSimilarity, presetSimilarity, restoreImage } from '../core.mjs';
import { decode, jpeg } from './image-io.mjs';

function makeImage(width, height, transparent) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const pixel = (y * width + x) * 4;
    data.set([40 + x * 170 / width, 35 + y * 180 / height, 150 + Math.sin(x / 11) * 60,
      transparent ? ((x + y) % 7 === 0 ? 0 : x * 255 / width) : 255], pixel);
  }
  return { width, height, data };
}
const records = [];
const preset = makeImage(43, 79, true);
for (const [width, height] of [[319, 173], [17, 129], [97, 211]]) {
  for (const fit of ['contain', 'cover', 'stretch']) {
    const source = makeImage(width, height, true);
    const reference = flattenImage(source);
    const encoded = await encodeImage(source, preset, { tileSize: 8, scale: 2, step: 16, colorGain: 0.75, fit });
    const output = { width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data };
    const target = fitImage(preset, output.width, output.height, fit, encoded.plan.panels);
    for (const quality of [null, 95, 75]) {
      const bytes = quality ? await jpeg(output, quality) : null;
      const image = quality ? await decode(bytes, output.width, output.height) : output;
      const resemblance = presetSimilarity(image.data, target.data, output.width, output.height);
      const row = { width, height, presetWidth: preset.width, presetHeight: preset.height, sourceHasAlpha: true, presetHasAlpha: true,
        fit, quality: quality ?? 'uncompressed', scale: encoded.plan.scale, outputWidth: output.width, outputHeight: output.height,
        bytes: bytes?.length ?? null, presetSSIM: resemblance.outline, presetDetail: resemblance.detail, decoded: 0, restoredSSIM: 0 };
      try {
        const restored = await restoreImage(image);
        row.decoded = 1;
        row.restoredSSIM = imageSimilarity(reference.data, restored.data, width, height);
      } catch (error) { row.error = error.message; }
      row.eligible = row.decoded === 1 && row.presetSSIM >= 0.5;
      records.push(row);
    }
  }
}
const report = { version: FORMAT_VERSION, threshold: 0.5, notes: 'Synthetic edge cases, independently reported; preset padding retains alpha and is composited over white for JPEG; these do not contribute to photo means.', records };
const root = new URL('../reports/', import.meta.url);
await writeFile(new URL('edge-cases.json', root), JSON.stringify(report, null, 2));
const columns = ['width', 'height', 'fit', 'quality', 'scale', 'outputWidth', 'outputHeight', 'presetSSIM', 'presetDetail', 'restoredSSIM', 'decoded', 'eligible'];
await writeFile(new URL('edge-cases.csv', root), [columns.join(','), ...records.map((row) => columns.map((key) => row[key]).join(','))].join('\n'));
console.log(`edge benchmark: ${records.length} cases, decoded ${records.filter((row) => row.decoded).length}, similarity eligible ${records.filter((row) => row.eligible).length}; details: reports/edge-cases.{json,csv}`);
