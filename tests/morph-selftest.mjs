// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { assignTargetPixels, buildSourcePalette, createSimulationBins, cropChangedFrame, destinationForce, displayProgress, isAnimatedRaster, outputDimensions, renderMorphFrame, updateMorphSimulation } from '../src/morph-animation.mjs';

const image = colors => ({
  width: 2,
  height: 2,
  data: Uint8ClampedArray.from(colors.flatMap(color => [...color, 255])),
});
const source = image([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]);
const target = image([[0, 0, 255], [255, 255, 255], [255, 0, 0], [0, 255, 0]]);

const colorMatch = await assignTargetPixels(source, target, 2);
assert.deepEqual([...colorMatch], [2, 3, 0, 1], 'color-first matching assigns each source pixel to its closest target color');
assert.equal(new Set(colorMatch).size, 4, 'pixel assignment is one-to-one');
await assert.rejects(assignTargetPixels(source, target, 3), /尺寸相同/);
await assert.rejects(assignTargetPixels(source, target, 2, { weights: new Uint8Array(3) }), /尺寸相同/);
const weightedMatch = await assignTargetPixels(source, target, 2, { weights: Uint8Array.of(0, 255, 255, 255) });
assert.equal(weightedMatch.length, 4, 'pixel matching accepts a per-target color weight map');
assert.equal((await assignTargetPixels(source, target, 2, { proximityImportance: 0 })).length, 4, 'pixel matching accepts a color-only proximity setting');
await assert.rejects(assignTargetPixels(source, target, 2, { proximityImportance: -1 }), /邻近权重/);
assert.deepEqual(outputDimensions(1600, 900), { width: 400, height: 225 }, 'landscape output preserves its source aspect ratio');
assert.deepEqual(outputDimensions(900, 1600), { width: 225, height: 400 }, 'portrait output preserves its source aspect ratio');
assert.ok(displayProgress(0.2) > 0.2, 'the progress display moves ahead early');
assert.equal(displayProgress(0.6), 0.6, 'the progress display reaches its slow phase at 60%');
assert.ok(displayProgress(0.8) < 0.8, 'the progress display advances slowly beyond 60%');
assert.ok(displayProgress(0, 5000) >= 0.6 && displayProgress(0, 5000) < 1, 'estimated progress reaches 60% within five seconds without claiming completion');
assert.ok(displayProgress(0.9, 1000) < 0.2, 'a late worker update cannot jump the visual ramp to 90%');
assert.ok(displayProgress(0, 1000) >= 0.01, 'estimated progress advances at least one point after one second');
assert.ok(displayProgress(0, 6000) >= 0.61, 'estimated progress continues advancing one point per second after the five-second ramp');
assert.equal(displayProgress(0, 100000), 0.99, 'estimated progress can wait at 99% but never claims completion');
for (let elapsed = 100; elapsed <= 100000; elapsed += 100) {
  assert.ok(displayProgress(0, elapsed) >= displayProgress(0, elapsed - 100), `estimated progress is monotonic at ${elapsed} ms`);
}
assert.equal(displayProgress(1, 0), 1, 'only completed work reaches 100%');

const previousFrame = Uint8Array.from({ length: 12 }, (_, index) => index);
const changedFrame = previousFrame.slice();
changedFrame[6] = 99;
changedFrame[11] = 88;
const changedCrop = cropChangedFrame(changedFrame, previousFrame, 4, 3);
assert.deepEqual(changedCrop, { x: 2, y: 1, width: 2, height: 2, indices: Uint8Array.of(99, 7, 10, 88) }, 'delta frames crop to the exact changed-pixel bounds');
const sparseCrop = cropChangedFrame(changedFrame, previousFrame, 4, 3, 255);
assert.deepEqual(sparseCrop.indices, Uint8Array.of(99, 255, 255, 88), 'unchanged pixels inside the frame rectangle become transparent skips');
const reconstructedFrame = previousFrame.slice();
for (let y = 0; y < changedCrop.height; y += 1) {
  reconstructedFrame.set(changedCrop.indices.subarray(y * changedCrop.width, (y + 1) * changedCrop.width), (changedCrop.y + y) * 4 + changedCrop.x);
}
assert.deepEqual(reconstructedFrame, changedFrame, 'compositing a delta rectangle reconstructs the full frame exactly');
assert.deepEqual(cropChangedFrame(previousFrame, previousFrame, 4, 3), { x: 0, y: 0, width: 1, height: 1, indices: Uint8Array.of(0) }, 'identical frames use a one-pixel timing frame');

assert.equal(destinationForce(0), 0, 'destination pull begins at zero');
assert.equal(destinationForce(120), destinationForce(60) * 8, 'destination pull follows Obamify’s cubic acceleration curve');
assert.equal(destinationForce(100000), 1000, 'destination pull stays bounded at long runtimes');
const fastPositions = Float32Array.of(10, 10);
updateMorphSimulation(fastPositions, new Float32Array(2), Float32Array.of(20, 10), Uint16Array.of(1000), 32, createSimulationBins(32 * 32), new Float32Array(2));
assert.ok(fastPositions[0] - 10 > 1.92, 'particle velocity follows the uncapped Obamify simulation');

const trajectoryPositions = Float32Array.of(1.5, 1.5);
const trajectoryVelocities = new Float32Array(2);
const trajectoryDestinations = Float32Array.of(15.5, 15.5);
const trajectoryAges = new Uint16Array(1);
const trajectoryBins = createSimulationBins(32 * 32);
const trajectoryAcceleration = new Float32Array(2);
const frameTravel = [];
for (let frame = 0; frame < 100; frame += 1) {
  const startX = trajectoryPositions[0];
  const startY = trajectoryPositions[1];
  for (let step = 0; step < 14; step += 1) {
    updateMorphSimulation(trajectoryPositions, trajectoryVelocities, trajectoryDestinations, trajectoryAges, 32, trajectoryBins, trajectoryAcceleration);
  }
  frameTravel.push(Math.hypot(trajectoryPositions[0] - startX, trajectoryPositions[1] - startY));
}
assert.ok(frameTravel[0] < frameTravel[8] && frameTravel[8] > frameTravel[90], 'particle motion accelerates from rest and eases as it reaches its destination');

const neighborPositions = Float32Array.of(10, 10, 10.5, 10);
const neighborVelocities = new Float32Array(4);
const neighborDestinations = neighborPositions.slice();
const neighborAges = new Uint16Array(2);
updateMorphSimulation(neighborPositions, neighborVelocities, neighborDestinations, neighborAges, 32, createSimulationBins(32 * 32), new Float32Array(4));
const neighborSeparation = Math.hypot(neighborPositions[0] - neighborPositions[2], neighborPositions[1] - neighborPositions[3]);
assert.ok(neighborSeparation > 0.51 && neighborSeparation < 0.53, 'neighbor forces are scaled from the 400-pixel simulation into grid coordinates');

const positions = Float32Array.of(1, 1, 1, 1);
const velocities = new Float32Array(4);
const destinations = Float32Array.of(0.5, 0.5, 1.5, 0.5);
const ages = new Uint16Array(2);
const bins = createSimulationBins(4);
updateMorphSimulation(positions, velocities, destinations, ages, 2, bins, new Float32Array(4));
assert.ok(Math.hypot(positions[0] - positions[2], positions[1] - positions[3]) > 0.00001, 'coincident particles receive a deterministic separating force');
assert.deepEqual([...ages], [1, 1], 'each simulation step advances the particle age');

const initialGrid = renderMorphFrame(Float32Array.of(0.5, 0.5, 1.5, 0.5, 0.5, 1.5, 1.5, 1.5), Uint8Array.of(1, 2, 3, 4), 2);
assert.equal(initialGrid.length, 64, 'the Voronoi renderer fills the complete output frame');
assert.ok(initialGrid.every(index => index > 0), 'Voronoi rendering leaves no unowned or transparent pixels');
for (let y = 0; y < 8; y += 1) {
  for (let x = 0; x < 8; x += 1) {
    const expected = (Math.floor(y / 4) * 2 + Math.floor(x / 4)) + 1;
    assert.equal(initialGrid[y * 8 + x], expected, 'the source grid is reconstructed exactly before movement');
  }
}

const detailedSide = 128;
const detailedCount = detailedSide * detailedSide;
const detailedSource = new Uint8ClampedArray(detailedCount * 4);
const detailedTarget = new Uint8ClampedArray(detailedCount * 4);
for (let y = 0; y < detailedSide; y += 1) {
  for (let x = 0; x < detailedSide; x += 1) {
    const offset = (y * detailedSide + x) * 4;
    detailedSource[offset] = x * 37 + y * 13;
    detailedSource[offset + 1] = x * 11 + y * 29;
    detailedSource[offset + 2] = x * 7 ^ y * 31;
    detailedSource[offset + 3] = 255;
  }
}
for (let y = 0; y < detailedSide; y += 1) {
  for (let x = 0; x < detailedSide; x += 1) {
    const offset = (y * detailedSide + x) * 4;
    const shiftedOffset = (y * detailedSide + (x + 1) % detailedSide) * 4;
    detailedTarget.set(detailedSource.subarray(shiftedOffset, shiftedOffset + 4), offset);
  }
}
const detailedMapping = await assignTargetPixels({ data: detailedSource }, { data: detailedTarget }, detailedSide);
assert.equal(new Set(detailedMapping).size, detailedCount, 'the detailed 128 × 128 assignment remains one-to-one');
assert.ok(detailedMapping.some((destination, sourceIndex) => Math.abs(destination % detailedSide - sourceIndex % detailedSide) === 1), 'the detailed assignment preserves local one-cell color matches');
const movementDistances = Array.from(detailedMapping, (destination, sourceIndex) => Math.hypot(
  destination % detailedSide - sourceIndex % detailedSide,
  Math.floor(destination / detailedSide) - Math.floor(sourceIndex / detailedSide),
)).sort((a, b) => a - b);
assert.ok(movementDistances[Math.floor(detailedCount * 0.95)] <= 2, 'at least 95% of pixel matches stay within two grid cells');
assert.ok(movementDistances.at(-1) <= 12, 'pixel matching avoids arbitrary long-distance rearrangement');
const detailedPositions = new Float32Array(detailedCount * 2);
const detailedColors = Uint8Array.from({ length: detailedCount }, (_, index) => index % 254 + 1);
for (let index = 0; index < detailedCount; index += 1) {
  detailedPositions[index * 2] = index % detailedSide + 0.5;
  detailedPositions[index * 2 + 1] = Math.floor(index / detailedSide) + 0.5;
}
const detailedFrame = renderMorphFrame(detailedPositions, detailedColors, detailedSide);
assert.equal(detailedFrame.length, detailedSide * 4 * detailedSide * 4, 'the detailed renderer produces a full-size frame');
assert.ok(detailedFrame.every(index => index > 0), 'the detailed Voronoi frame has no uncovered pixels');
const wideFrame = renderMorphFrame(Float32Array.of(0.16, 0.16, 32.16, 0.16), Uint8Array.of(1, 2), 128, 400, 400);
assert.equal(wideFrame[399], 2, '400-pixel JFA starts at the upstream 256-pixel jump so distant seeds reach the canvas edges');
const landscapeFrame = renderMorphFrame(Float32Array.of(0.5, 0.5, 1.5, 0.5, 0.5, 1.5, 1.5, 1.5), Uint8Array.of(1, 2, 3, 4), 2, 8, 8, 4, 2);
assert.equal(landscapeFrame.length, 32, 'the renderer returns the source aspect ratio rather than a square frame');
const portraitFrame = renderMorphFrame(Float32Array.of(0.5, 0.5, 1.5, 0.5, 0.5, 1.5, 1.5, 1.5), Uint8Array.of(1, 2, 3, 4), 2, 8, 4, 8, 0.5);
assert.equal(portraitFrame.length, 32, 'portrait frames map the same square simulation into a tall output');

const sourcePalette = buildSourcePalette(source, 3);
assert.equal(sourcePalette.palette.length, 256 * 3, 'NeuQuant returns a GIF-sized RGB palette');
assert.ok(sourcePalette.indices.every(index => index < 3), 'a reduced NeuQuant palette stays within its requested color count');
assert.ok(new Set(sourcePalette.indices).size >= 2, 'NeuQuant keeps distinct colors distinguishable in the mapped source image');

const gif = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
assert.equal(isAnimatedRaster(gif), true, 'GIF inputs are excluded from the static-image workflow');

const apng = new Uint8Array(45);
apng.set([137, 80, 78, 71, 13, 10, 26, 10]);
new DataView(apng.buffer).setUint32(8, 13, false);
apng.set(new TextEncoder().encode('IHDR'), 12);
new DataView(apng.buffer).setUint32(33, 8, false);
apng.set(new TextEncoder().encode('acTL'), 37);
assert.equal(isAnimatedRaster(apng), true, 'APNG animation control chunks are detected');

const webp = new Uint8Array(20);
webp.set(new TextEncoder().encode('RIFF'), 0);
webp.set(new TextEncoder().encode('WEBP'), 8);
webp.set(new TextEncoder().encode('ANIM'), 12);
assert.equal(isAnimatedRaster(webp), true, 'animated WebP chunks are detected');

console.log('morph animation passed: unique color assignment, spatial matching, and animated GIF/APNG/WebP rejection');
