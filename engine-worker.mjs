// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeImage, restoreImage } from './core.mjs';

self.onmessage = async (event) => {
  const { id, action, source, target, step, tileSize, fit, scale, colorAdapt, colorGain } = event.data;
  const onProgress = (progress) => self.postMessage({ id, type: 'progress', progress });

  try {
    const result = action === 'encode'
      ? await encodeImage(source, target, { step, tileSize, fit, scale, colorAdapt, colorGain, onProgress })
      : await restoreImage(source, { onProgress });
    self.postMessage({ id, type: 'result', result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
