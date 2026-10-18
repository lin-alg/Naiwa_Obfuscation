// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Test scratch data always lives inside this repository, independent of CWD.
export const artifactRoot = fileURLToPath(new URL('../.test-artifacts/', import.meta.url));

export async function artifactDirectory(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('Invalid artifact directory');
  const path = join(artifactRoot, name);
  await mkdir(path, { recursive: true });
  return path;
}

export function artifactEnvironment(directory) {
  return { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
}
