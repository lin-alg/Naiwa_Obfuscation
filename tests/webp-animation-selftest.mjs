// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { assembleAnimatedWebP } from '../src/webp-animation.mjs';

function chunk(type, payload) {
  const bytes = new Uint8Array(8 + payload.length + (payload.length & 1));
  bytes.set(new TextEncoder().encode(type));
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

function chunks(bytes, offset = 12, end = bytes.length) {
  const result = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= end) {
    const type = new TextDecoder('ascii').decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    result.push({ type, offset, size, payload: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + size + (size & 1);
  }
  return result;
}

const image = chunk('VP8 ', Uint8Array.of(1, 2, 3, 4));
const webp = assembleAnimatedWebP(400, 225, [
  { chunks: [image], duration: 80 },
  { chunks: [image], duration: 100 },
  { chunks: [image], x: 6, y: 8, width: 10, height: 9, duration: 120 },
]);
assert.equal(webp.type, 'image/webp');
const bytes = new Uint8Array(await webp.arrayBuffer());
assert.equal(new TextDecoder('ascii').decode(bytes.subarray(0, 4)), 'RIFF');
assert.equal(new TextDecoder('ascii').decode(bytes.subarray(8, 12)), 'WEBP');
assert.equal(new DataView(bytes.buffer).getUint32(4, true), bytes.length - 8);
const outer = chunks(bytes);
assert.deepEqual(outer.map(item => item.type), ['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF']);
assert.equal(outer[0].payload[0], 0x02, 'VP8X advertises animation');
assert.equal(outer[0].payload[4] | outer[0].payload[5] << 8 | outer[0].payload[6] << 16, 399);
assert.equal(outer[0].payload[7] | outer[0].payload[8] << 8 | outer[0].payload[9] << 16, 224);
assert.equal(new DataView(outer[1].payload.buffer, outer[1].payload.byteOffset).getUint16(4, true), 0, 'animation loops forever');
for (const [index, expectedDuration] of [[2, 80], [3, 100]]) {
  const frame = outer[index];
  assert.equal(frame.payload[15], 0x02, 'full-frame animation does not blend with previous frames');
  assert.equal(frame.payload[12] | frame.payload[13] << 8 | frame.payload[14] << 16, expectedDuration);
  assert.deepEqual(chunks(frame.payload, 16, frame.payload.length).map(item => item.type), ['VP8 ']);
}
const crop = outer[4].payload;
assert.equal(crop[0] | crop[1] << 8 | crop[2] << 16, 3, 'ANMF stores even x offsets in two-pixel units');
assert.equal(crop[3] | crop[4] << 8 | crop[5] << 16, 4, 'ANMF stores even y offsets in two-pixel units');
assert.equal(crop[6] | crop[7] << 8 | crop[8] << 16, 9, 'cropped frames retain their own width');
assert.equal(crop[9] | crop[10] << 8 | crop[11] << 16, 8, 'cropped frames retain their own height');

console.log('animated WebP mux passed: RIFF layout, dimensions, frame timing and infinite loop');
