// SPDX-License-Identifier: GPL-3.0-or-later
export function initializePreviews() {
  const $ = selector => document.querySelector(selector);
  let mode = 'compare'; let activeViewport = null; let zooms = new WeakMap();
  const zoomState = viewport => {
    if (!viewport) return { factor: null };
    if (!zooms.has(viewport)) zooms.set(viewport, { factor: null });
    return zooms.get(viewport);
  };
  const visual = viewport => viewport?.querySelector('.preview-animation:not([hidden])') ?? viewport?.querySelector('canvas:not([hidden])');
  const dimensions = element => element instanceof HTMLCanvasElement
    ? { width: element.width, height: element.height }
    : { width: element?.naturalWidth || element?.width || 0, height: element?.naturalHeight || element?.height || 0 };
  const modeViewport = () => $(`[data-panel="${mode === 'restored' ? 'restored' : 'mosaic'}"] .canvas-viewport`);
  function fitScale(panel) {
    const viewport = panel.querySelector('.canvas-viewport'); const image = visual(viewport); const size = dimensions(image);
    if (!size.width || !size.height || !viewport?.clientWidth || !viewport?.clientHeight) return 1;
    return Math.min(viewport.clientWidth / size.width, viewport.clientHeight / size.height);
  }
  function readout(viewport) {
    if (!viewport) return;
    const factor = zoomState(viewport).factor ?? fitScale(viewport.closest('.preview-panel'));
    const output = viewport.closest('.decode-preview') ? $('#decode-zoom-value') : $('#zoom-value');
    if (output) output.textContent = `${Math.round(factor * 100)}%`;
  }
  function apply(target = null, anchor = null) {
    const panels = target ? [target.closest('.preview-panel')].filter(Boolean)
      : [...document.querySelectorAll('.preview-panel')].filter(panel => panel.getClientRects().length && !panel.hidden && getComputedStyle(panel).display !== 'none');
    for (const panel of panels) {
      const viewport = panel.querySelector('.canvas-viewport'); const image = visual(viewport); const stage = panel.querySelector('.canvas-stage'); const size = dimensions(image);
      if (!size.width || !size.height || !viewport || !stage) continue;
      const scale = zoomState(viewport).factor ?? fitScale(panel);
      const width = Math.max(1, size.width * scale); const height = Math.max(1, size.height * scale);
      image.style.width = `${width}px`; image.style.height = `${height}px`;
      stage.style.width = `${Math.max(viewport.clientWidth, width)}px`; stage.style.height = `${Math.max(viewport.clientHeight, height)}px`;
    }
    if (anchor) {
      const { viewport, image, x, y, imageX, imageY } = anchor; const size = dimensions(image);
      const view = viewport.getBoundingClientRect(); const rect = image.getBoundingClientRect(); const scale = rect.width / size.width;
      viewport.scrollLeft = rect.left - view.left + viewport.scrollLeft + imageX * scale - x;
      viewport.scrollTop = rect.top - view.top + viewport.scrollTop + imageY * scale - y;
    }
    if (target) readout(target);
    else {
      const active = activeViewport?.getClientRects().length ? activeViewport : modeViewport();
      if (active?.getClientRects().length) readout(active);
      const decoded = $('#decode-preview').closest('.canvas-viewport');
      if (decoded.getClientRects().length) readout(decoded);
    }
  }
  function change(direction, viewport, clientX, clientY) {
    const panel = viewport?.closest('.preview-panel'); const image = visual(viewport); const size = dimensions(image);
    if (!panel || !size.width || !viewport.clientWidth || !viewport.clientHeight) return;
    if (!viewport.closest('.decode-preview')) activeViewport = viewport;
    const view = viewport.getBoundingClientRect(); const rect = image.getBoundingClientRect(); const scale = rect.width / size.width;
    const x = Math.max(0, Math.min(viewport.clientWidth, (clientX ?? view.left + view.width / 2) - view.left));
    const y = Math.max(0, Math.min(viewport.clientHeight, (clientY ?? view.top + view.height / 2) - view.top));
    const anchor = { viewport, image, x, y, imageX: Math.max(0, Math.min(size.width, (x - (rect.left - view.left)) / scale)), imageY: Math.max(0, Math.min(size.height, (y - (rect.top - view.top)) / scale)) };
    const current = zoomState(viewport).factor ?? fitScale(panel);
    zoomState(viewport).factor = Math.max(0.02, Math.min(8, current * (direction > 0 ? 1.15 : 1 / 1.15)));
    apply(viewport, anchor);
  }
  function setMode(value) {
    mode = value;
    document.querySelectorAll('.preview-choice').forEach(button => button.classList.toggle('is-active', button.dataset.preview === mode));
    $('#preview-grid').dataset.mode = mode; activeViewport = modeViewport(); requestAnimationFrame(() => apply());
  }
  document.querySelectorAll('.preview-choice').forEach(button => button.addEventListener('click', () => setMode(button.dataset.preview)));
  document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
    const viewport = button.closest('.decode-preview') ? $('#decode-preview').closest('.canvas-viewport') : activeViewport?.getClientRects().length ? activeViewport : modeViewport();
    if (['in', 'out'].includes(button.dataset.zoom)) { change(button.dataset.zoom === 'in' ? 1 : -1, viewport); return; }
    zoomState(viewport).factor = button.dataset.zoom === 'fit' ? null : 1;
    viewport.scrollLeft = viewport.scrollTop = 0;
    if (!button.closest('.decode-preview')) activeViewport = viewport;
    apply(viewport);
  }));
  document.querySelectorAll('.canvas-viewport').forEach(viewport => {
    viewport.addEventListener('wheel', event => {
      if (!dimensions(visual(viewport)).width) return;
      event.preventDefault(); change(event.deltaY < 0 ? 1 : -1, viewport, event.clientX, event.clientY);
    }, { passive: false });
    let drag = null;
    viewport.addEventListener('pointerenter', () => { if (!viewport.closest('.decode-preview')) { activeViewport = viewport; readout(viewport); } });
    viewport.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || !dimensions(visual(viewport)).width) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId); viewport.classList.add('is-panning'); event.preventDefault();
    });
    viewport.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      viewport.scrollLeft = drag.left - (event.clientX - drag.x); viewport.scrollTop = drag.top - (event.clientY - drag.y);
    });
    const finish = event => { if (drag?.id === event.pointerId) { drag = null; viewport.classList.remove('is-panning'); } };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(name, finish);
  });
  window.addEventListener('resize', () => apply());
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => apply()); observer.observe($('#preview-area')); observer.observe($('.decode-preview'));
  }
  return { apply, setMode, reset: () => { zooms = new WeakMap(); activeViewport = null; } };
}
