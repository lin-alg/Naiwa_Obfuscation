// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { artifactDirectory, artifactEnvironment } from './artifact-paths.mjs';

const temporaryRoot = await artifactDirectory('image-io');

export function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: artifactEnvironment(temporaryRoot) });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    // FFmpeg can close its input immediately after reading the requested frame.
    // Decide success from its exit status, including Windows' equivalent EOF.
    child.stdin.on('error', (error) => { if (!['EPIPE', 'EOF'].includes(error.code)) reject(error); });
    child.on('close', (code) => code ? reject(new Error(Buffer.concat(stderr).toString())) : resolve(Buffer.concat(stdout)));
    child.stdin.end(input);
  });
}

export async function decode(input, width, height, filter) {
  const jpegInput = typeof input !== 'string' && input[0] === 0xff && input[1] === 0xd8;
  const bytes = await run('ffmpeg', ['-v', 'error', '-threads', '1', ...(jpegInput ? ['-f', 'mjpeg'] : []), '-i', typeof input === 'string' ? input : 'pipe:0',
    ...(filter ? ['-vf', filter] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], typeof input === 'string' ? undefined : input);
  return { width, height, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

export async function jpeg(image, quality) {
  const qualityScales = new Map([[95, 2], [85, 3], [75, 5], [65, 7], [55, 10]]);
  return run('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${image.width}x${image.height}`,
    '-i', 'pipe:0', '-frames:v', '1', '-q:v', String(qualityScales.get(quality) ?? Math.max(2, Math.round((100 - quality) / 5))),
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-pix_fmt', 'yuvj420p', 'pipe:1'], image.data);
}

export async function png(image, maxSide = 640) {
  return run('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${image.width}x${image.height}`,
    '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease:flags=area`,
    '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], image.data);
}
