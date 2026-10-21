// SPDX-License-Identifier: GPL-3.0-or-later
export class WorkerPool {
  constructor({ concurrency, memoryBudget } = {}) {
    const mobile = matchMedia('(pointer: coarse)').matches;
    const memory = navigator.deviceMemory ?? (mobile ? 4 : 8);
    this.concurrency = concurrency ?? Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1, memory <= 2 ? 1 : mobile || memory <= 4 ? 2 : 4));
    this.memoryBudget = memoryBudget ?? (memory <= 2 ? 160 : mobile || memory <= 4 ? 320 : 640) * 1048576;
    this.slots = []; this.queue = [];
  }

  run(payload, { signal, onProgress, memory = 64000000 } = {}) {
    return new Promise((resolve, reject) => {
      const job = { id: crypto.randomUUID(), payload, signal, onProgress, memory, resolve, reject };
      job.abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        const slot = this.slots.find(item => item.job === job);
        if (slot) { slot.worker.terminate(); this.slots.splice(this.slots.indexOf(slot), 1); }
        signal?.removeEventListener('abort', job.abort);
        reject(new DOMException('任务已取消', 'AbortError'));
        this.pump();
      };
      if (signal?.aborted) { job.abort(); return; }
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      const active = this.slots.filter(slot => slot.job);
      const job = this.queue[0];
      if (active.length >= this.concurrency || (active.length && active.reduce((sum, slot) => sum + slot.job.memory, 0) + job.memory > this.memoryBudget)) return;
      let slot = this.slots.find(item => !item.job);
      if (!slot) {
        slot = { worker: new Worker('./engine-worker.mjs', { type: 'module' }), job: null };
        this.slots.push(slot);
        slot.worker.onmessage = ({ data }) => {
          if (!slot.job || data.id !== slot.job.id) return;
          if (data.type === 'progress') { slot.job.onProgress?.(data.progress); return; }
          this.finish(slot, data.type === 'error' ? new Error(data.message) : null, data.result);
        };
        slot.worker.onerror = event => {
          if (!slot.job) return;
          slot.worker.terminate(); this.slots.splice(this.slots.indexOf(slot), 1);
          this.finish(slot, new Error(event.message || '图像处理失败'));
        };
      }
      this.queue.shift(); slot.job = job;
      job.onProgress?.({ label: '准备处理', fraction: 0.01 });
      try { slot.worker.postMessage({ ...job.payload, id: job.id }); }
      catch (error) { this.finish(slot, error); }
    }
  }

  finish(slot, error, result) {
    const job = slot.job; slot.job = null;
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
    this.pump();
  }
}
