// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
const profile = JSON.parse(await readFile(process.argv[2]));
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const totals = new Map();
profile.samples.forEach((id, index) => {
  const frame = nodes.get(id).callFrame;
  const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').at(-1)}:${frame.lineNumber + 1}`;
  totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[index]);
});
console.table([...totals].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([frame, us]) => ({ frame, ms: Math.round(us / 1000) })));
