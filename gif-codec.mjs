// SPDX-License-Identifier: GPL-3.0-or-later
// GIF parsing and LZW operate on local palette indices, never expanded RGB data.
const text = new TextDecoder('ascii');
export const GIF_LIMITS = { pixels: 16000000, frames: 300, decodedIndices: 64 * 1048576 };
export const isGif = bytes => bytes.length >= 6 && /^GIF8[79]a$/.test(text.decode(bytes.subarray(0, 6)));
export function concatBytes(parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function u32(value) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
export function subBlocks(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 255) { const part = bytes.subarray(offset, offset + 255); parts.push(Uint8Array.of(part.length), part); }
  return concatBytes([...parts, Uint8Array.of(0)]);
}

export function parseGif(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isGif(bytes) || bytes.length < 14) throw new Error('不是有效的 GIF 文件。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = offset => view.getUint16(offset, true);
  const width = word(6); const height = word(8);
  if (!width || !height || width * height > GIF_LIMITS.pixels) throw new Error('GIF 单帧尺寸过大（最多 1600 万像素）。');
  let offset = 13; let totalPixels = 0; let control = null; let loop = null;
  const take = length => { if (length < 0 || offset + length > bytes.length) throw new Error('GIF 数据不完整。'); const part = bytes.subarray(offset, offset + length); offset += length; return part; };
  const readBlocks = () => { const parts = []; for (;;) { const size = take(1)[0]; if (!size) break; parts.push(take(size)); } return concatBytes(parts); };
  const palette = bytes[10] & 128 ? take(3 * (2 << (bytes[10] & 7))) : null;
  const prefix = bytes.subarray(0, offset); const blocks = []; const frames = [];
  let trailer = false;
  while (offset < bytes.length) {
    const start = offset; const marker = take(1)[0];
    if (marker === 0x3b) { trailer = true; break; }
    if (marker === 0x21) {
      const label = take(1)[0]; const payload = readBlocks();
      if (label === 0xf9) {
        if (payload.length !== 4) throw new Error('GIF 帧控制信息无效。');
        control = { disposal: (payload[0] >> 2) & 7, delay: payload[1] | (payload[2] << 8), transparent: payload[0] & 1 ? payload[3] : -1 };
      }
      if (label === 0xff && payload.length >= 14 && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(text.decode(payload.subarray(0, 11))) && payload[11] === 1) loop = payload[12] | (payload[13] << 8);
      blocks.push({ type: 'extension', label, payload, raw: bytes.subarray(start, offset) });
      if (label === 0x01) control = null;
    } else if (marker === 0x2c) {
      const descriptor = take(9); const x = word(start + 1); const y = word(start + 3); const fw = word(start + 5); const fh = word(start + 7);
      if (!fw || !fh || x + fw > width || y + fh > height) throw new Error('GIF 帧超出画布范围。');
      const localPalette = descriptor[8] & 128 ? take(3 * (2 << (descriptor[8] & 7))) : palette;
      if (!localPalette) throw new Error('GIF 缺少调色板。');
      const headerEnd = offset; const minimum = take(1)[0]; const compressed = readBlocks();
      if (minimum < 2 || minimum > 8) throw new Error('GIF LZW 位数无效。');
      totalPixels += fw * fh;
      if (totalPixels > GIF_LIMITS.decodedIndices || frames.length >= GIF_LIMITS.frames) throw new Error('GIF 帧数或累计像素过多，请先缩短动画。');
      const frame = { type: 'frame', x, y, width: fw, height: fh, palette: localPalette, minimum, compressed,
        interlaced: Boolean(descriptor[8] & 64), ...control ?? { disposal: 0, delay: 0, transparent: -1 },
        header: bytes.subarray(start, headerEnd), raw: bytes.subarray(start, offset) };
      // Match browsers: zero and one centisecond delays play at 100 ms.
      frame.duration = frame.delay < 2 ? 10 : frame.delay;
      frames.push(frame); blocks.push(frame); control = null;
    } else throw new Error('GIF 包含无效的数据块。');
  }
  if (!trailer || !frames.length) throw new Error('GIF 缺少完整的动画帧或结束标记。');
  return { bytes, width, height, palette, background: bytes[11], prefix, blocks, frames, loop, duration: frames.reduce((sum, frame) => sum + frame.duration, 0) };
}

export function alignedFrameDelays(source, target) {
  let elapsed = 0; let previousBoundary = 0;
  return source.frames.map(frame => {
    elapsed += frame.duration;
    const boundary = Math.round(elapsed * target.duration / source.duration);
    const delay = Math.max(1, boundary - previousBoundary);
    previousBoundary = boundary;
    return delay;
  });
}

export function decodeIndices(frame) {
  const { minimum, compressed } = frame; const clear = 1 << minimum; const end = clear + 1;
  const prefix = new Uint16Array(4096); const suffix = new Uint8Array(4096); const stack = new Uint8Array(4097);
  const output = new Uint8Array(frame.width * frame.height);
  let bits = minimum + 1; let next = end + 1; let previous = -1; let first = 0; let bit = 0; let written = 0; let ended = false;
  for (let i = 0; i < clear; i += 1) suffix[i] = i;
  while (bit + bits <= compressed.length * 8) {
    let code = 0;
    for (let b = 0; b < bits; b += 1) code |= ((compressed[(bit + b) >> 3] >> ((bit + b) & 7)) & 1) << b;
    bit += bits;
    if (code === clear) { bits = minimum + 1; next = end + 1; previous = -1; continue; }
    if (code === end) { ended = true; break; }
    if (code > next || (code === next && previous < 0)) throw new Error(`GIF LZW 索引损坏（码字 ${code}，字典 ${next}，位数 ${bits}，偏移 ${bit}）。`);
    const original = code; let count = 0;
    if (code === next) { stack[count++] = first; code = previous; }
    while (code >= clear) {
      if (code >= next || count >= 4096) throw new Error('GIF LZW 字典损坏。');
      stack[count++] = suffix[code]; code = prefix[code];
    }
    first = suffix[code]; stack[count++] = first;
    if (written + count > output.length) throw new Error('GIF 解码像素数量超出帧尺寸。');
    while (count) output[written++] = stack[--count];
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous; suffix[next++] = first;
      if (next === 1 << bits && bits < 12) bits += 1;
    }
    previous = original;
  }
  if (!ended || written !== output.length) throw new Error('GIF 帧像素数据不完整。');
  for (const value of output) if (value >= frame.palette.length / 3) throw new Error('GIF 调色板索引无效。');
  return output;
}

export function encodeIndices(indices, minimum = 8) {
  const clear = 1 << minimum; const end = clear + 1;
  let bits = minimum + 1; let next = end + 1; let dictionary = new Map();
  const bytes = []; let accumulator = 0; let occupied = 0;
  const write = code => {
    accumulator |= code << occupied; occupied += bits;
    while (occupied >= 8) { bytes.push(accumulator & 255); accumulator >>>= 8; occupied -= 8; }
  };
  write(clear);
  if (indices.length) {
    let word = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      const value = indices[i]; const key = word * 256 + value; const match = dictionary.get(key);
      if (match !== undefined) { word = match; continue; }
      write(word);
      if (next < 4096) {
        dictionary.set(key, next++);
        if (next > 1 << bits && bits < 12) bits += 1;
      }
      else { write(clear); dictionary = new Map(); bits = minimum + 1; next = end + 1; }
      word = value;
    }
    write(word);
  }
  write(end);
  if (occupied) bytes.push(accumulator & 255);
  return Uint8Array.from(bytes);
}

// Yields one composited frame at a time. Disposal 2/3 and interlacing are
// applied before advancing; consumers must copy a frame they want to retain.
export function* gifFrames(gif) {
  const data = new Uint8ClampedArray(gif.width * gif.height * 4);
  let previous = null; let saved = null;
  const background = gif.palette?.subarray(gif.background * 3, gif.background * 3 + 3);
  const clearRect = (frame, transparent) => {
    for (let y = frame.y; y < frame.y + frame.height; y += 1) for (let x = frame.x; x < frame.x + frame.width; x += 1) {
      const p = (y * gif.width + x) * 4;
      data[p] = transparent ? 0 : background?.[0] ?? 0; data[p + 1] = transparent ? 0 : background?.[1] ?? 0;
      data[p + 2] = transparent ? 0 : background?.[2] ?? 0; data[p + 3] = transparent ? 0 : 255;
    }
  };
  if (gif.frames[0].transparent < 0 && background?.length === 3) clearRect({ x: 0, y: 0, width: gif.width, height: gif.height }, false);
  for (const frame of gif.frames) {
    if (previous?.disposal === 2) clearRect(previous, previous.transparent >= 0);
    else if (previous?.disposal === 3 && saved) data.set(saved);
    saved = frame.disposal === 3 ? data.slice() : null;
    const indices = decodeIndices(frame); const rows = [];
    if (frame.interlaced) for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < frame.height; y += step) rows.push(y);
    for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) {
      const index = indices[y * frame.width + x]; if (index === frame.transparent) continue;
      const p = ((frame.y + (frame.interlaced ? rows[y] : y)) * gif.width + frame.x + x) * 4;
      data[p] = frame.palette[index * 3]; data[p + 1] = frame.palette[index * 3 + 1]; data[p + 2] = frame.palette[index * 3 + 2]; data[p + 3] = 255;
    }
    yield { width: gif.width, height: gif.height, data, duration: frame.duration, delay: frame.delay };
    previous = frame;
  }
}

export function gifHeader(width, height, palette, loop = 0) {
  const colors = Math.max(2, 2 ** Math.ceil(Math.log2(palette.length / 3))); const bits = Math.log2(colors);
  const header = new Uint8Array(13 + colors * 3);
  header.set([71, 73, 70, 56, 57, 97]);
  const view = new DataView(header.buffer); view.setUint16(6, width, true); view.setUint16(8, height, true);
  header[10] = 0xf0 | (bits - 1); header.set(palette, 13);
  return loop === null ? header : concatBytes([header, Uint8Array.of(0x21, 0xff, 11), new TextEncoder().encode('NETSCAPE2.0'), Uint8Array.of(3, 1, loop & 255, loop >> 8, 0)]);
}

export function gifPayload(bytes) {
  const payload = embeddedImagePayload(bytes);
  return payload?.mime === 'image/gif' ? payload : null;
}

export function embeddedImagePayload(bytes) {
  for (const block of bytes.blocks) if (block.type === 'extension' && block.label === 0xff) {
    const identifier = text.decode(block.payload.subarray(0, 11));
    if (identifier !== 'NAIWA-GIF01' && identifier !== 'NAIWA-IMG01') continue;
    const payload = block.payload.subarray(11);
    const format = text.decode(payload.subarray(0, 4));
    if (payload.length < 8 || !['NWG1', 'NWR1'].includes(format)) throw new Error('混淆 GIF 的原图数据格式无效。');
    const size = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4, true);
    if (identifier === 'NAIWA-GIF01') return { size, compressed: payload.subarray(8), raw: format === 'NWR1', mime: 'image/gif' };
    if (payload.length < 9 || payload[8] === 0 || payload.length < 9 + payload[8]) throw new Error('混淆 GIF 的原图类型信息无效。');
    const mime = new TextDecoder().decode(payload.subarray(9, 9 + payload[8]));
    if (!mime.startsWith('image/')) throw new Error('混淆 GIF 的原图类型无效。');
    return { size, compressed: payload.subarray(9 + payload[8]), raw: format === 'NWR1', mime };
  }
  return null;
}

export function gifPayloadBlock(size, payload, compressed = true, mime = 'image/gif') {
  const image = mime !== 'image/gif';
  const identifier = new TextEncoder().encode(image ? 'NAIWA-IMG01' : 'NAIWA-GIF01');
  const mimeBytes = image ? new TextEncoder().encode(mime) : null;
  if (mimeBytes?.length > 255) throw new Error('原图 MIME 类型过长。');
  const header = [new TextEncoder().encode(compressed ? 'NWG1' : 'NWR1'), u32(size)];
  if (image) header.push(Uint8Array.of(mimeBytes.length), mimeBytes);
  return concatBytes([Uint8Array.of(0x21, 0xff, 11), identifier, subBlocks(concatBytes([...header, payload]))]);
}

export function gifFrameBlock(indices, { x = 0, y = 0, width, height, delay, minimum = 8, transparent = -1, disposal = 1, interlaced = false, palette }) {
  const control = Uint8Array.of(0x21, 0xf9, 4, (disposal << 2) | (transparent >= 0 ? 1 : 0), delay & 255, delay >> 8, Math.max(0, transparent), 0);
  const descriptor = new Uint8Array(10); descriptor[0] = 0x2c;
  const view = new DataView(descriptor.buffer);
  for (const [offset, value] of [[1, x], [3, y], [5, width], [7, height]]) view.setUint16(offset, value, true);
  const colors = palette ? Math.max(2, 2 ** Math.ceil(Math.log2(palette.length / 3))) : 0;
  descriptor[9] = (interlaced ? 64 : 0) | (palette ? 128 | (Math.log2(colors) - 1) : 0);
  const table = new Uint8Array(colors * 3); if (palette) table.set(palette);
  return concatBytes([control, descriptor, table, Uint8Array.of(minimum), subBlocks(encodeIndices(indices, minimum))]);
}
