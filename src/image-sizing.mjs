// SPDX-License-Identifier: GPL-3.0-or-later
export function sourceSizing(width, height, percent = null, pixelBudget = 16000000) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('图像尺寸无效。');
  let scale;
  if (percent === null) {
    scale = Math.max(1, 1024 / Math.min(width, height));
    scale = Math.min(scale, 2960 / Math.max(width, height));
    scale = Math.min(scale, Math.sqrt(pixelBudget / (width * height)));
  } else {
    if (!Number.isFinite(percent) || percent < 1 || percent > 1600) throw new Error('缩放比例应为 1% 到 1600%。');
    scale = percent / 100;
  }
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  if (outputWidth > 16384 || outputHeight > 16384 || outputWidth * outputHeight > 16000000) {
    throw new Error('处理图像过大，请降低高级模式中的缩放比例（最多 1600 万像素、单边 16384 px）。');
  }
  return { width: outputWidth, height: outputHeight, scale, automatic: percent === null };
}
