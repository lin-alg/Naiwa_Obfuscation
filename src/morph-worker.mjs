// SPDX-License-Identifier: GPL-3.0-or-later
import { createMorphGif } from './morph-animation.mjs';

const channel = new MessageChannel();
let resumeYield;
channel.port1.onmessage = () => resumeYield?.();

function yieldControl() {
  return new Promise(resolve => {
    resumeYield = resolve;
    channel.port2.postMessage(0);
  });
}

self.addEventListener('message', async ({ data }) => {
  const { id, source, target, side, aspect, width, height, settings } = data;
  try {
    const result = await createMorphGif(
      { data: new Uint8ClampedArray(source), width: side, height: side },
      { data: new Uint8ClampedArray(target), width: side, height: side },
      side, aspect, width, height, settings,
      fraction => self.postMessage({ id, type: 'progress', fraction }),
      yieldControl,
    );
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message });
  }
});
