// SPDX-License-Identifier: GPL-3.0-or-later
import { gifFrames, parseGif, concatBytes } from './gif-codec.mjs';

const ascii = value => new TextEncoder().encode(value);
const tag = bytes => new TextDecoder('ascii').decode(bytes);

function chunk(type, payload) {
  const output = new Uint8Array(8 + payload.length + (payload.length & 1));
  output.set(ascii(type));
  new DataView(output.buffer).setUint32(4, payload.length, true);
  output.set(payload, 8);
  return output;
}

function readChunks(bytes) {
  if (bytes.length < 12 || tag(bytes.subarray(0, 4)) !== 'RIFF' || tag(bytes.subarray(8, 12)) !== 'WEBP') {
    throw new Error('浏览器没有生成有效的 WebP 帧。');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.length) throw new Error('WebP 帧数据不完整。');
    const type = tag(bytes.subarray(offset, offset + 4));
    if (['ALPH', 'VP8 ', 'VP8L'].includes(type)) chunks.push(bytes.slice(offset, end + (size & 1)));
    offset = end + (size & 1);
  }
  if (!chunks.some(item => ['VP8 ', 'VP8L'].includes(tag(item.subarray(0, 4))))) {
    throw new Error('WebP 帧缺少图像数据。');
  }
  return chunks;
}

function hasAlpha(chunks) {
  return chunks.some(item => tag(item.subarray(0, 4)) === 'ALPH'
    || (tag(item.subarray(0, 4)) === 'VP8L' && (item[12] & 0x10)));
}

function write24(view, offset, value) {
  view.setUint8(offset, value & 255);
  view.setUint8(offset + 1, value >>> 8 & 255);
  view.setUint8(offset + 2, value >>> 16 & 255);
}

export function assembleAnimatedWebP(width, height, frames, loop = 0) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 0x1000000 || height > 0x1000000 || !frames.length) {
    throw new RangeError('动画 WebP 尺寸或帧数无效。');
  }
  const extended = new Uint8Array(10);
  extended[0] = 0x02 | (frames.some(frame => hasAlpha(frame.chunks)) ? 0x10 : 0);
  write24(new DataView(extended.buffer), 4, width - 1);
  write24(new DataView(extended.buffer), 7, height - 1);
  const animation = new Uint8Array(6);
  new DataView(animation.buffer).setUint16(4, loop, true);
  const outputChunks = [chunk('VP8X', extended), chunk('ANIM', animation)];

  for (const frame of frames) {
    const duration = Math.max(1, Math.min(0xffffff, Math.round(frame.duration)));
    const frameX = frame.x ?? 0;
    const frameY = frame.y ?? 0;
    const frameWidth = frame.width ?? width;
    const frameHeight = frame.height ?? height;
    if (frameX % 2 || frameY % 2 || frameX < 0 || frameY < 0 || frameX + frameWidth > width || frameY + frameHeight > height) {
      throw new RangeError('动画 WebP 帧超出画布或偏移不是偶数。');
    }
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    write24(view, 0, frameX / 2);
    write24(view, 3, frameY / 2);
    write24(view, 6, frameWidth - 1);
    write24(view, 9, frameHeight - 1);
    write24(view, 12, duration);
    header[15] = 0x02;
    outputChunks.push(chunk('ANMF', concatBytes([header, ...frame.chunks])));
  }

  const body = concatBytes([ascii('WEBP'), ...outputChunks]);
  const output = new Uint8Array(8 + body.length);
  output.set(ascii('RIFF'));
  new DataView(output.buffer).setUint32(4, body.length, true);
  output.set(body, 8);
  return new Blob([output], { type: 'image/webp' });
}

function canvasWebP(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob || blob.type !== 'image/webp') reject(new Error('此浏览器不支持 WebP 动图导出。'));
    else resolve(blob);
  }, 'image/webp', quality));
}

export async function createAnimatedWebP(gifBlob, { quality = 0.92, onProgress = () => {} } = {}) {
  if (!Number.isFinite(quality) || quality <= 0 || quality > 1) throw new RangeError('WebP 质量必须在 0 到 1 之间。');
  const gif = parseGif(new Uint8Array(await gifBlob.arrayBuffer()));
  const canvas = document.createElement('canvas');
  canvas.width = gif.width;
  canvas.height = gif.height;
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) throw new Error('无法创建 WebP 编码画布。');
  const frames = [];
  let previous = null;
  try {
    let index = 0;
    for (const frame of gifFrames(gif)) {
      let left = 0;
      let top = 0;
      let right = gif.width - 1;
      let bottom = gif.height - 1;
      if (previous) {
        left = gif.width;
        top = gif.height;
        right = -1;
        bottom = -1;
        for (let y = 0; y < gif.height; y += 1) {
          for (let x = 0; x < gif.width; x += 1) {
            const offset = (y * gif.width + x) * 4;
            if (frame.data[offset] === previous[offset] && frame.data[offset + 1] === previous[offset + 1]
              && frame.data[offset + 2] === previous[offset + 2] && frame.data[offset + 3] === previous[offset + 3]) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
        if (right < 0) {
          left = top = right = bottom = 0;
        } else {
          left -= left & 1;
          top -= top & 1;
        }
      }
      const frameWidth = right - left + 1;
      const frameHeight = bottom - top + 1;
      const pixels = new Uint8ClampedArray(frameWidth * frameHeight * 4);
      for (let y = 0; y < frameHeight; y += 1) {
        const sourceOffset = ((top + y) * gif.width + left) * 4;
        pixels.set(frame.data.subarray(sourceOffset, sourceOffset + frameWidth * 4), y * frameWidth * 4);
      }
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      const frameContext = canvas.getContext('2d', { willReadFrequently: false });
      frameContext.putImageData(new ImageData(pixels, frameWidth, frameHeight), 0, 0);
      const encoded = await canvasWebP(canvas, quality);
      frames.push({
        x: left, y: top, width: frameWidth, height: frameHeight,
        chunks: readChunks(new Uint8Array(await encoded.arrayBuffer())), duration: frame.duration * 10,
      });
      previous = frame.data.slice();
      index += 1;
      onProgress(index / gif.frames.length);
    }
    return assembleAnimatedWebP(gif.width, gif.height, frames, gif.loop ?? 0);
  } finally {
    canvas.width = canvas.height = 0;
  }
}
