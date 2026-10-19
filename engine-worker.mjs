// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeImage, imageSimilarity, presetSimilarity, restoreImage } from './core.mjs';

self.onmessage = async (event) => {
  const { id, action, source, target, original, step, tileSize, fit, scale, colorAdapt, colorGain } = event.data;
  const onProgress = (progress) => self.postMessage({ id, type: 'progress', progress });

  try {
    let result;
    if (action === 'encode') result = await encodeImage(source, target, { step, tileSize, fit, scale, colorAdapt, colorGain, onProgress });
    else if (action === 'verify') {
      const restored = await restoreImage(source, { onProgress });
      result = {
        restored,
        restoredSSIM: imageSimilarity(original.data, restored.data, original.width, original.height),
        preset: presetSimilarity(source.data, target.data, source.width, source.height),
      };
    } else result = await restoreImage(source, { onProgress });
    const transfer = [];
    for (const image of [result, result.targetImage, result.restored]) if (image?.data?.buffer) transfer.push(image.data.buffer);
    self.postMessage({ id, type: 'result', result }, transfer);
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
