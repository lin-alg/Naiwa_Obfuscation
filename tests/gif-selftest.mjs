// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { alignedFrameDelays, decodeIndices, embeddedImagePayload, encodeIndices, gifFrameBlock, gifFrames, gifHeader, gifPayload, gifPayloadBlock, parseGif, concatBytes } from '../src/gif-codec.mjs';

const asset = (name) => fileURLToPath(new URL(`../assets/images/animated/${name}`, import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/animated/${name}`, import.meta.url));
const samples = [asset('1.gif'), asset('2.gif'), fixture('1.gif'), fixture('2.gif'), fixture('3.gif')];
let frameTotal = 0;
for (const path of samples) {
  const bytes = new Uint8Array(await readFile(path)); const gif = parseGif(bytes); let count = 0;
  for (const frame of gif.frames) {
    const indices = decodeIndices(frame); const encoded = encodeIndices(indices, frame.minimum);
    assert.deepEqual(decodeIndices({ ...frame, compressed: encoded }), indices, `${path} LZW round trip`);
    count += 1;
  }
  for (const frame of gifFrames(gif)) assert.equal(frame.data.length, gif.width * gif.height * 4);
  assert.equal(count, gif.frames.length); frameTotal += count;
}

const palette4 = new Uint8Array(12);
const completeWithoutEndCode = { width: 1, height: 1, palette: palette4, minimum: 2, compressed: Uint8Array.of(0x04) };
assert.deepEqual([...decodeIndices(completeWithoutEndCode)], [0], 'a complete pixel may be followed by a missing LZW end code');
assert.throws(() => decodeIndices({ ...completeWithoutEndCode, width: 2 }), /像素数据不完整/, 'missing pixel indices must still be rejected');

const original = new Uint8Array(await readFile(samples[2])); const compressed = gzipSync(original);
const palette = new Uint8Array(256 * 3);
const container = concatBytes([
  gifHeader(1, 1, palette),
  gifPayloadBlock(original.length, compressed),
  gifFrameBlock(Uint8Array.of(0), { width: 1, height: 1, delay: 10, minimum: 8 }),
  Uint8Array.of(0x3b),
]);
const parsed = parseGif(container); const payload = gifPayload(parsed);
assert.ok(payload); assert.equal(payload.raw, false);
assert.ok(gunzipSync(payload.compressed).equals(Buffer.from(original)), 'embedded original GIF is lossless');
const rawContainer = concatBytes([gifHeader(1, 1, palette), gifPayloadBlock(original.length, original, false), gifFrameBlock(Uint8Array.of(0), { width: 1, height: 1, delay: 10, minimum: 8 }), Uint8Array.of(0x3b)]);
const rawPayload = gifPayload(parseGif(rawContainer));
assert.equal(rawPayload.raw, true); assert.ok(rawPayload.compressed.every((byte, index) => byte === original[index]));
const stillBytes = new TextEncoder().encode('lossless static image payload');
const stillContainer = concatBytes([gifHeader(1, 1, palette), gifPayloadBlock(stillBytes.length, stillBytes, false, 'image/png'), gifFrameBlock(Uint8Array.of(0), { width: 1, height: 1, delay: 10, minimum: 8 }), Uint8Array.of(0x3b)]);
const stillPayload = embeddedImagePayload(parseGif(stillContainer));
assert.equal(stillPayload.mime, 'image/png'); assert.equal(stillPayload.raw, true);
assert.ok(stillPayload.compressed.every((byte, index) => byte === stillBytes[index]), 'embedded static image bytes are lossless');

for (const [sourcePath, targetPath] of [
  [fixture('1.gif'), asset('2.gif')],
  [fixture('2.gif'), asset('1.gif')],
  [fixture('3.gif'), asset('1.gif')],
]) {
  const source = parseGif(await readFile(sourcePath)); const target = parseGif(await readFile(targetPath));
  const delays = alignedFrameDelays(source, target);
  assert.equal(delays.length, source.frames.length);
  assert.equal(delays.reduce((sum, delay) => sum + delay, 0), target.duration, `${sourcePath} follows preset duration`);
  assert.ok(delays.every(delay => Number.isInteger(delay) && delay >= 1));
}

console.log(`GIF codec passed: ${samples.length} files, ${frameTotal} frames, lossless index and payload round trips.`);
