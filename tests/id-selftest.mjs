// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createId } from '../src/id.mjs';

const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
try {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => 'native-id' } });
  assert.equal(createId(), 'native-id', 'native UUID generation is preferred when available');

  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: bytes => { bytes.fill(0xab); return bytes; } },
  });
  assert.match(createId(), /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, 'random values provide UUIDs when randomUUID is unavailable');

  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  assert.notEqual(createId(), createId(), 'the local fallback returns distinct IDs without the crypto API');
} finally {
  if (original) Object.defineProperty(globalThis, 'crypto', original);
  else delete globalThis.crypto;
}

console.log('ID generation passed: native UUID, random bytes and insecure-context fallback.');
