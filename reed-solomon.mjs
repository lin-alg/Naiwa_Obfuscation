// SPDX-License-Identifier: GPL-3.0-or-later
// Systematic shortened RS codes over GF(256), primitive polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
let field = 1;
for (let i = 0; i < 255; i += 1) {
  EXP[i] = field;
  LOG[field] = i;
  field <<= 1;
  if (field & 256) field ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
const div = (a, b) => {
  if (!b) throw new Error('Invalid Reed–Solomon divisor');
  return a ? EXP[(LOG[a] - LOG[b] + 255) % 255] : 0;
};
const generators = new Map();
// Multiplication by a fixed field element is a byte lookup in hot RS loops.
const PRODUCTS = Array.from({ length: 256 }, (_, a) => Uint8Array.from({ length: 256 }, (_, b) => mul(a, b)));

function generator(parity) {
  if (generators.has(parity)) return generators.get(parity);
  let polynomial = [1];
  for (let i = 0; i < parity; i += 1) {
    const next = new Uint8Array(polynomial.length + 1);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= mul(polynomial[j], EXP[i]);
    }
    polynomial = next;
  }
  generators.set(parity, polynomial);
  return polynomial;
}

export function encodeRS(data, parity = 96) {
  if (data.length + parity > 255) throw new Error('RS block exceeds 255 bytes');
  const result = new Uint8Array(data.length + parity);
  result.set(data);
  const polynomial = generator(parity);
  for (let i = 0; i < data.length; i += 1) {
    const coefficient = result[i];
    if (!coefficient) continue;
    const products = PRODUCTS[coefficient];
    for (let j = 1; j < polynomial.length; j += 1) result[i + j] ^= products[polynomial[j]];
  }
  result.set(data);
  return result;
}

function syndromes(bytes, parity) {
  const result = new Uint8Array(parity);
  for (let power = 0; power < parity; power += 1) {
    let value = 0;
    const products = PRODUCTS[EXP[power]];
    for (let i = 0; i < bytes.length; i += 1) value = products[value] ^ bytes[i];
    result[power] = value;
  }
  return result;
}

export function decodeRS(bytes, parity = 96) {
  const result = bytes.slice();
  const syndrome = syndromes(result, parity);
  if (!syndrome.some(Boolean)) return { data: result.slice(0, -parity), corrected: 0 };

  // Berlekamp–Massey, locator coefficients in ascending order.
  let locator = [1];
  let previous = [1];
  let degree = 0;
  let distance = 1;
  let previousDiscrepancy = 1;
  for (let i = 0; i < parity; i += 1) {
    let discrepancy = syndrome[i];
    for (let j = 1; j <= degree; j += 1) discrepancy ^= mul(locator[j] ?? 0, syndrome[i - j]);
    if (!discrepancy) { distance += 1; continue; }
    const saved = locator.slice();
    const scale = div(discrepancy, previousDiscrepancy);
    while (locator.length < previous.length + distance) locator.push(0);
    for (let j = 0; j < previous.length; j += 1) locator[j + distance] ^= mul(scale, previous[j]);
    if (2 * degree <= i) {
      degree = i + 1 - degree;
      previous = saved;
      previousDiscrepancy = discrepancy;
      distance = 1;
    } else distance += 1;
  }
  if (degree > parity / 2) throw new Error('坐标纠错容量不足，请使用更高 JPEG 质量。');
  const positions = [];
  const roots = [];
  for (let index = 0; index < result.length; index += 1) {
    const power = result.length - 1 - index;
    const inverse = EXP[(255 - power) % 255];
    let value = 0;
    for (let i = locator.length - 1; i >= 0; i -= 1) value = mul(value, inverse) ^ locator[i];
    if (!value) { positions.push(index); roots.push(EXP[power]); }
  }
  if (positions.length !== degree) throw new Error('坐标纠错失败，请使用更高 JPEG 质量。');

  // Solve the small Vandermonde system for error magnitudes.
  const matrix = Array.from({ length: degree }, (_, row) => {
    const values = new Uint8Array(degree + 1);
    for (let column = 0; column < degree; column += 1) {
      values[column] = row ? EXP[(LOG[roots[column]] * row) % 255] : 1;
    }
    values[degree] = syndrome[row];
    return values;
  });
  for (let column = 0; column < degree; column += 1) {
    let pivot = column;
    while (pivot < degree && !matrix[pivot][column]) pivot += 1;
    if (pivot === degree) throw new Error('坐标纠错失败。');
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let j = column; j <= degree; j += 1) matrix[column][j] = div(matrix[column][j], divisor);
    for (let row = 0; row < degree; row += 1) {
      if (row === column || !matrix[row][column]) continue;
      const scale = matrix[row][column];
      for (let j = column; j <= degree; j += 1) matrix[row][j] ^= mul(scale, matrix[column][j]);
    }
  }
  for (let i = 0; i < degree; i += 1) result[positions[i]] ^= matrix[i][degree];
  if (syndromes(result, parity).some(Boolean)) throw new Error('坐标纠错后校验失败。');
  return { data: result.slice(0, -parity), corrected: degree };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
