// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encodeImage, fitImage, imageSimilarity, restoreImage } from '../src/core.mjs';
import { decode, jpeg, png } from './image-io.mjs';

const option = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const options = { tileSize: 8, scale: Number(option('scale', '2')), step: Number(option('step', '16')), colorGain: Number(option('gain', '0.5')), fit: 'contain' };
const source = await decode(fileURLToPath(new URL('./fixtures/static/1.jpg', import.meta.url)), 1920, 1080, 'scale=1920:1080:flags=area');
const preset = await decode(fileURLToPath(new URL('../assets/images/static/奶蛙.png', import.meta.url)), 512, 512);
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
const labels = ['原图', '奶蛙混淆图（JPG 75%）', '参考图', `还原效果 · ${restoredFrom}`];
const root = new URL('../reports/', import.meta.url);
await Promise.all(panels.map(async (panel, i) => writeFile(new URL(`example-${i}.png`, root), await png(panel))));
const html = `<!doctype html><meta charset="utf-8"><title>奶蛙混淆效果示例</title><style>body{font:16px system-ui;margin:32px;color:#243d2e}main{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:1400px}figure{margin:0}img{width:100%;background:#fff;border:1px solid #ddd}p{line-height:1.6}</style><h1>奶蛙混淆效果对照</h1><p>使用一张 1920×1200 原图和 512×512 奶蛙参考图生成。参考图相似度评分：轮廓 ${encoded.resemblance.outline.toFixed(4)}、细节 ${encoded.resemblance.detail.toFixed(4)}；还原效果评分：${score.toFixed(4)}。透明区域会铺成白色。下方图片经过缩小，仅供查看，不能用于还原。</p><main>${panels.map((_, i) => `<figure><figcaption>${labels[i]}</figcaption><img src="example-${i}.png"></figure>`).join('')}</main>`;
await writeFile(new URL('example.html', root), html);
console.log(`reports/example.html: ${JSON.stringify(options)}, reference=${encoded.resemblance.outline.toFixed(4)}, restored=${score.toFixed(4)}`);
