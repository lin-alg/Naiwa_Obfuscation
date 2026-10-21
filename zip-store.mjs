// SPDX-License-Identifier: GPL-3.0-or-later
import { crc32 } from './reed-solomon.mjs';

// Files are already PNG/JPG compressed. STORE avoids recompression and keeps
// the archive a list of Blobs instead of copying the entire batch into RAM.
export async function zipFiles(files, onProgress) {
  if (files.length > 65535) throw new Error('单个 ZIP 最多支持 65535 个文件。');
  const parts = []; const directory = []; const names = new Set();
  const encoder = new TextEncoder(); let offset = 0; let directorySize = 0;
  const now = new Date();
  const date = (Math.max(1980, now.getFullYear()) - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
  const time = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1;
  for (let index = 0; index < files.length; index += 1) {
    const { blob } = files[index];
    const original = files[index].name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    let name = original; let suffix = 1;
    while (names.has(name)) name = original.replace(/(\.[^.]*)?$/, (_, ext = '') => ` (${suffix++})${ext}`);
    names.add(name);
    const filename = encoder.encode(name);
    const checksum = crc32(new Uint8Array(await blob.arrayBuffer()));
    const header = new Uint8Array(30 + filename.length); const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint16(10, time, true); view.setUint16(12, date, true);
    view.setUint32(14, checksum, true); view.setUint32(18, blob.size, true); view.setUint32(22, blob.size, true);
    view.setUint16(26, filename.length, true); header.set(filename, 30);
    const central = new Uint8Array(46 + filename.length); const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, checksum, true); cv.setUint32(20, blob.size, true); cv.setUint32(24, blob.size, true);
    cv.setUint16(28, filename.length, true); cv.setUint32(42, offset, true); central.set(filename, 46);
    parts.push(header, blob); directory.push(central);
    offset += header.length + blob.size; directorySize += central.length;
    if (offset + directorySize + 22 > 0xffffffff) throw new Error('ZIP 超过 4 GB，请分批下载。');
    onProgress?.(index + 1, files.length);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
