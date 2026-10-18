// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, stat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { artifactDirectory, artifactEnvironment } from './artifact-paths.mjs';
import { fileURLToPath } from 'node:url';
import { FORMAT_VERSION, encodeImage, fitImage, flattenImage, imageSimilarity, presetSimilarity, restoreImage } from '../core.mjs';
import { decode, jpeg } from './image-io.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const list = (name, fallback) => option(name, fallback).split(',').map(Number);
const count = Math.max(1, Number(option('count', 3)));
const qualities = list('qualities', '95,85,75,65,55');
const tiles = list('tiles', '8');
const scales = list('scales', '2');
const steps = list('steps', option('step', '16'));
const presetIds = list('presets', option('preset', '0'));
const threshold = Number(option('threshold', '0.5'));
const maxSide = Number(option('max-side', '0'));
const fit = option('fit', 'contain');
const colorAdapt = option('color-adapt', 'yes') !== 'no';
const colorGain = Number(option('color-gain', '0.75'));
const gains = list('gains', String(colorGain));
const reportName = option('report', 'latest');
if (!/^[\w-]+$/.test(reportName)) throw new Error('Invalid report name');
if (args.includes('--background')) {
  const temporaryRoot = await artifactDirectory('benchmark');
  const log = await open(join(temporaryRoot, `${reportName}.log`), 'w');
  const errors = await open(join(temporaryRoot, `${reportName}-error.log`), 'w');
  const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), ...args.filter((arg) => arg !== '--background')], {
    detached: true, stdio: ['ignore', log.fd, errors.fd], windowsHide: true, env: artifactEnvironment(temporaryRoot),
  });
  child.unref();
  await log.close(); await errors.close();
  console.log(`Started batch PID ${child.pid}; report=${reportName}`);
  process.exit(0);
}
const manifest = JSON.parse(await readFile(new URL('../test/manifest.json', import.meta.url), 'utf8'));
const entries = manifest.slice().sort((a, b) => a.width * a.height - b.width * b.height).slice(0, count);
const presetNames = ['奶蛙', 'naishu', 'naigou', 'naidan'];
const presets = await Promise.all(presetIds.map(async (id) => ({ id, image: await decode(fileURLToPath(new URL(`../images/static/${presetNames[id]}.png`, import.meta.url)), 512, 512) })));
const profiles = option('profiles', '');
const configs = profiles ? profiles.split(',').map((profile) => {
  const [scale, step, gain] = profile.split(':').map(Number);
  return { tileSize: 8, scale, step, colorAdapt, colorGain: gain, id: `8px-${scale}x-s${step}-color${gain}` };
}) : tiles.flatMap((tileSize) => scales.flatMap((scale) => steps.flatMap((step) => (colorAdapt ? gains : [1]).map((gain) => ({ tileSize, scale, step, colorAdapt, colorGain: gain, id: `${tileSize}px-${scale}x-s${step}${colorAdapt ? `-color${gain}` : ''}` })))));
const records = [];
const rawRecords = [];
const failures = [];
const started = new Date().toISOString();
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

console.log(`Batch: ${configs.length} configurations × ${entries.length} images × ${presets.length} presets × ${qualities.length} JPEG levels; threshold=${threshold}; maxSide=${maxSide || 'native'}`);
for (let imageIndex = 0; imageIndex < entries.length; imageIndex += 1) {
  const entry = entries[imageIndex];
  const path = fileURLToPath(new URL(`../test/static/${encodeURIComponent(entry.name)}`, import.meta.url));
  const factor = maxSide ? Math.min(1, maxSide / Math.max(entry.width, entry.height)) : 1;
  const width = Math.max(1, Math.round(entry.width * factor));
  const height = Math.max(1, Math.round(entry.height * factor));
  const source = flattenImage(await decode(path, width, height, factor < 1 ? `scale=${width}:${height}:flags=area` : undefined));
  // Resized screening runs use a JPEG-95 of the resized input as their size reference.
  const inputBytes = factor < 1 ? (await jpeg(source, 95)).length : (await stat(path)).size;
  const baseline = new Map(await Promise.all(qualities.map(async (quality) => {
    const bytes = await jpeg(source, quality);
    const decoded = await decode(bytes, width, height);
    return [quality, { size: bytes.length / inputBytes, ssim: imageSimilarity(source.data, decoded.data, width, height) }];
  })));
  for (const { id: presetId, image: preset } of presets) {
    for (const config of configs) {
      const key = `${imageIndex + 1}/${entries.length} · preset ${presetId} · ${config.id}`;
      console.log(`START ${key}`);
      let encoded;
      try { encoded = await encodeImage(source, preset, { ...config, fit }); }
      catch (error) { failures.push({ image: entry.name, presetId, config: config.id, stage: 'encode', error: error.message }); continue; }
      const output = { width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data };
      const target = fitImage(preset, output.width, output.height, fit);
      const raw = { config: config.id, image: entry.name, width, height, presetId, outline: encoded.resemblance.outline, detail: encoded.resemblance.detail };
      try {
        const restored = await restoreImage(output);
        raw.restoredSSIM = imageSimilarity(source.data, restored.data, width, height);
        raw.decoded = 1;
      } catch (error) { raw.restoredSSIM = 0; raw.decoded = 0; raw.error = error.message; }
      rawRecords.push(raw);
      for (const quality of qualities) {
        const bytes = await jpeg(output, quality);
        const compressed = await decode(bytes, output.width, output.height);
        const resemblance = presetSimilarity(compressed.data, target.data, output.width, output.height);
        const row = { config: config.id, ...config, image: entry.name, width, height, presetId, quality,
          mixedSize: bytes.length / inputBytes, mixedBytes: bytes.length, baseSize: baseline.get(quality).size, baseSSIM: baseline.get(quality).ssim,
          presetSSIM: resemblance.outline, presetDetail: resemblance.detail, eligible: resemblance.outline >= threshold,
          restoredSSIM: 0, decoded: 0 };
        try {
          const restored = await restoreImage(compressed);
          row.restoredSSIM = imageSimilarity(source.data, restored.data, width, height);
          row.decoded = 1;
          row.correctedBytes = restored.plan.corrected;
        } catch (error) { row.error = error.message; }
        records.push(row);
      }
      console.log(`DONE ${key}`);
      globalThis.gc?.();
    }
  }
}

// Edge cases are independent of the photo sample; never fold them into photo means.
const edgeCases = [];
if (option('edges', 'yes') !== 'no') {
  for (const [width, height] of [[319, 173], [17, 129], [97, 211]]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data.set([x % 256, y % 256, (x + y) % 256, (x * 11 + y * 3) % 256], i);
    }
    const source = { width, height, data };
    for (const config of configs.filter((item) => item.tileSize === 8)) {
      const row = { width, height, config: config.id, transparent: true };
      try {
        const encoded = await encodeImage(source, presets[0].image, { ...config, fit });
        row.actualScale = encoded.plan.scale;
        row.outputWidth = encoded.plan.outputWidth;
        row.outputHeight = encoded.plan.outputHeight;
        const restored = await restoreImage({ width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data });
        row.restoredSSIM = imageSimilarity(flattenImage(source).data, restored.data, width, height);
        row.decoded = 1;
        row.presetSSIM = encoded.resemblance.outline;
      } catch (error) { row.decoded = 0; row.error = error.message; }
      edgeCases.push(row);
    }
  }
}

const summary = configs.flatMap((config) => qualities.map((quality) => {
  const rows = records.filter((row) => row.config === config.id && row.quality === quality);
  if (!rows.length) return null;
  const result = { config: config.id, quality, samples: rows.length };
  for (const key of ['mixedSize', 'restoredSSIM', 'baseSize', 'baseSSIM', 'presetSSIM', 'presetDetail', 'decoded']) result[key] = mean(rows.map((row) => row[key]));
  result.minPresetSSIM = Math.min(...rows.map((row) => row.presetSSIM));
  result.eligible = result.minPresetSSIM >= threshold && result.decoded === 1 && rows.length === entries.length * presets.length;
  return result;
}).filter(Boolean));
for (const row of summary) {
  row.pareto = row.eligible && !summary.some((other) => other.eligible && other.mixedSize <= row.mixedSize && other.restoredSSIM >= row.restoredSSIM && other.minPresetSSIM >= row.minPresetSSIM && (other.mixedSize < row.mixedSize || other.restoredSSIM > row.restoredSSIM || other.minPresetSSIM > row.minPresetSSIM));
}
const report = { version: FORMAT_VERSION, started, finished: new Date().toISOString(), threshold, fit, colorAdapt, gains, maxSide, sizeReference: maxSide ? 'JPEG95 of resized input (native images retain original file bytes)' : 'original input file bytes',
  sampling: 'area average; restored luminance SSIM at 512px; preset RGB SSIM at 64px and 512px; non-overlapping 8x8 windows',
  jpegEncoder: 'FFmpeg mjpeg yuvj420p; nominal 95/85/75/65/55 => q:v 2/3/5/7/10, distinct from browser JPEG quality',
  entries, presetIds, configs, summary, rawRecords, records, edgeCases, failures };
const columns = ['config', 'quality', 'samples', 'mixedSize', 'restoredSSIM', 'presetSSIM', 'minPresetSSIM', 'presetDetail', 'decoded', 'baseSize', 'baseSSIM', 'eligible', 'pareto'];
const csv = [columns.join(','), ...summary.map((row) => columns.map((key) => row[key]).join(','))].join('\n');
const root = new URL('../reports/', import.meta.url);
await writeFile(new URL(`${reportName}.json`, root), JSON.stringify(report, null, 2));
await writeFile(new URL(`${reportName}.csv`, root), csv);

const colors = ['#47753e', '#3269a8', '#bf5e42', '#8657a3', '#b0811d', '#267f84', '#b44879', '#57618f', '#6b7853', '#a56635', '#8c4253', '#46635e'];
function plot(yKey, title) {
  const width = 960; const height = 460; const left = 70; const top = 40; const pw = 850; const ph = 350;
  const xmax = Math.max(1, ...summary.map((row) => Math.max(row.mixedSize, row.baseSize))) * 1.05;
  const x = (value) => left + value / xmax * pw;
  const y = (value) => top + (1 - value) * ph;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><style>text{font:13px sans-serif;fill:#34443c}</style><text x="70" y="23">${title}</text>`;
  for (let i = 0; i <= 5; i += 1) svg += `<path d="M${left} ${y(i / 5)}H920" stroke="#ddd"/><text x="32" y="${y(i / 5) + 4}">${(i / 5).toFixed(1)}</text><text x="${x(xmax * i / 5)}" y="415" text-anchor="middle">${(xmax * i / 5 * 100).toFixed(0)}%</text>`;
  if (yKey === 'minPresetSSIM') svg += `<path d="M${left} ${y(threshold)}H920" stroke="#bc3030" stroke-dasharray="6 4"/><text x="75" y="${y(threshold) - 5}">threshold ${threshold}</text>`;
  configs.forEach((config, index) => {
    const rows = summary.filter((row) => row.config === config.id);
    const color = colors[index % colors.length];
    svg += `<polyline points="${rows.map((row) => `${x(row.mixedSize)},${y(row[yKey])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
    for (const row of rows) svg += `<circle cx="${x(row.mixedSize)}" cy="${y(row[yKey])}" r="${row.pareto ? 6 : 4}" fill="${row.eligible ? color : 'white'}" stroke="${color}" stroke-width="2"><title>${row.config}, Q${row.quality}, size=${(row.mixedSize * 100).toFixed(1)}%, restored=${row.restoredSSIM.toFixed(4)}, preset min=${row.minPresetSSIM.toFixed(4)}, decoded=${row.decoded}</title></circle>`;
  });
  if (yKey === 'restoredSSIM') {
    const rows = summary.filter((row) => row.config === configs[0].id);
    svg += `<polyline points="${rows.map((row) => `${x(row.baseSize)},${y(row.baseSSIM)}`).join(' ')}" fill="none" stroke="#222" stroke-dasharray="6 4"/>`;
  }
  return svg + '<text x="495" y="450" text-anchor="middle">JPEG bytes / input reference bytes (includes complete image)</text></svg>';
}
const recoveryPlot = plot('restoredSSIM', 'Restoration SSIM vs JPEG size · dashed black: direct JPEG');
const resemblancePlot = plot('minPresetSSIM', 'Worst-case preset RGB SSIM (64px) vs JPEG size');
await writeFile(new URL(`${reportName}-recovery.svg`, root), recoveryPlot);
await writeFile(new URL(`${reportName}-preset.svg`, root), resemblancePlot);
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const html = `<!doctype html><meta charset="utf-8"><title>Naiwa batch report</title><style>body{font:15px system-ui;max-width:1200px;margin:32px auto;padding:16px;color:#253c2e}svg{width:100%}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #ddd;text-align:right}label{display:inline-block;padding:8px}tr[data-eligible=false]{color:#888}.legend{display:flex;flex-wrap:wrap}</style><h1>Naiwa 三指标批量评测 · v${FORMAT_VERSION}</h1><p>${escape(started)} · ${entries.length} 张图 × ${presets.length} 个预设 · 轮廓相似度门槛 ${threshold} · 最大边 ${maxSide || '原始分辨率'}。空心点未满足每个样本的门槛及 100% 恢复要求；大点为三指标 Pareto 候选。鼠标悬停查看数值。</p><p>尺寸基准：${escape(report.sizeReference)}。透明像素统一合成到白底。${escape(report.jpegEncoder)}</p><div class="legend">${configs.map((config, i) => `<label style="color:${colors[i % colors.length]}">${config.id}</label>`).join('')}</div>${recoveryPlot}${resemblancePlot}<p>恢复失败计为 SSIM 0；门槛取所有图片、预设中的最小值。达标只代表当前样本，不能推断所有图片。</p><label><input id="only" type="checkbox">仅显示达标候选</label><table><thead><tr>${columns.map((key) => `<th>${key}</th>`).join('')}</tr></thead><tbody>${summary.map((row) => `<tr data-eligible="${row.eligible}">${columns.map((key) => `<td>${typeof row[key] === 'number' && !Number.isInteger(row[key]) ? row[key].toFixed(4) : escape(row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table><script>document.querySelector('#only').onchange=e=>document.querySelectorAll('tbody tr').forEach(row=>row.hidden=e.target.checked&&row.dataset.eligible!=='true')</script>`;
await writeFile(new URL(`${reportName}.html`, root), html);
console.log('\n' + csv);
console.log(`Reports: reports/${reportName}.{json,csv,html}, reports/${reportName}-{recovery,preset}.svg; edge cases=${edgeCases.length}; failures=${failures.length}`);
