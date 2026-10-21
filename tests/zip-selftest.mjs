// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { zipFiles } from '../zip-store.mjs';
import { artifactDirectory } from './artifact-paths.mjs';

const directory = await artifactDirectory('zip');
const path = join(directory, 'unicode-duplicates.zip');
const zip = await zipFiles([
  { name: '还原图片.png', blob: new Blob(['first image']) },
  { name: '还原图片.png', blob: new Blob(['second image']) },
  { name: 'a/b.jpg', blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]) },
]);
await writeFile(path, Buffer.from(await zip.arrayBuffer()));
execFileSync('python', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.namelist()==["还原图片.png","还原图片 (1).png","a_b.jpg"]; assert z.read(z.namelist()[0])==b"first image"; assert z.read(z.namelist()[1])==b"second image"; assert z.read("a_b.jpg")==bytes([255,216,255]); assert all(i.date_time[0]>=1980 for i in z.infolist())', path]);
console.log('zip selftest passed: Python ZIP reader validates UTF-8 names, duplicates, CRC, timestamps and file bytes');
