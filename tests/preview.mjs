// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encodeImage, fitImage, imageSimilarity, restoreImage } from '../core.mjs';
import { decode, jpeg, png } from './image-io.mjs';

const option = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const options = { tileSize: 8, scale: Number(option('scale', '2')), step: Number(option('step', '16')), colorGain: Number(option('gain', '0.5')), fit: 'contain' };
const source = await decode(fileURLToPath(new URL('../test/static/1.jpg', import.meta.url)), 1920, 1080, 'scale=1920:1080:flags=area');
const preset = await decode(fileURLToPath(new URL('../images/static/奶蛙.png', import.meta.url)), 512, 512);
const encoded = await encodeImage(source, preset, options);
const image = { width: encoded.plan.outputWidth, height: encoded.plan.outputHeight, data: encoded.data };
const bytes = await jpeg(image, 75);
const compressed = await decode(bytes, image.width, image.height);
let restored;
let restoredFrom = 'JPEG 75';
try { restored = await restoreImage(compressed); }
catch { restored = await restoreImage(image); restoredFrom = 'PNG（JPEG 75 坐标读取失败）'; }
const score = imageSimilarity(source.data, restored.data, source.width, source.height);
const panels = [source, compressed, fitImage(preset, image.width, image.height), { ...source, data: restored.data }];
const labels = ['原图', '混淆图（JPEG 75）', '适配后的预设', `还原图 · ${restoredFrom}`];
const root = new URL('../reports/', import.meta.url);
await Promise.all(panels.map(async (panel, i) => writeFile(new URL(`example-${i}.png`, root), await png(panel))));
await writeFile(new URL('example.html', root), `<!doctype html><meta charset="utf-8"><title>Naiwa example</title><style>body{font:16px system-ui;margin:32px;color:#243d2d}main{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:1400px}figure{margin:0}img{width:100%;background:#fff;border:1px solid #ddd}p{line-height:1.6}</style><h1>8×8 原图分块的实际效果</h1><p>原图 1920×1200，预设 512×512；载体 ${options.scale} 倍，强度 ${options.step}，细节保留 ${options.colorGain}。PNG 轮廓 RGB SSIM ${encoded.resemblance.outline.toFixed(4)}，细节 RGB SSIM ${encoded.resemblance.detail.toFixed(4)}，恢复 SSIM ${score.toFixed(4)}。透明预设用白底，完整显示并留白。预览图为面积缩小后的展示图，不能用于坐标还原。</p><main>${panels.map((_, i) => `<figure><figcaption>${labels[i]}</figcaption><img src="example-${i}.png"></figure>`).join('')}</main>`);
console.log(`reports/example.html: ${JSON.stringify(options)}, preset=${encoded.resemblance.outline.toFixed(4)}, restored=${score.toFixed(4)}`);
