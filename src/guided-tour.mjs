// SPDX-License-Identifier: GPL-3.0-or-later
const TOURS = {
  encode: {
    label: '混淆图像', number: '01',
    steps: [
      { target: '#source-picker', action: 'upload-encode', title: '选择你要混淆的表情', text: '不用顾虑图片格式，我们也支持混淆动图！', note: '选好后点击“下一步”。' },
      { target: '#reference-panel', action: 'choose-preset', title: '选择参考图，或上传自己的图片', text: '参考图长什么样，混淆后的图就长什么样；参考图是动图的话，混淆后的图也会是动图。', note: '点选一张参考图后才能继续。' },
      { target: '.batch-unify', fallback: '#preset-list', title: '参考图可共用，参数独立调整', text: '勾选后，所有待处理的图片共用同一张参考图；输出选项仍是独立的。' },
      { target: '#encode-view .basic-settings', title: '输出选项', text: 'JPG 质量在文件体积与画面细节间取舍；效果偏向在还原原图与贴近参考图间取舍；分块越细，参考图案越清晰，但文件更大、处理更慢。' },
      { target: '#source-list .progress-ring', fallback: '#source-picker', action: 'encode-single', title: '单独处理一张图片', text: '如果对结果不满意，可以在调整设置后点击按钮重新生成。', demo: 'encode', note: '点击按钮处理单张图片。' },
      { target: '#encode-button', title: '一键生成全部混淆图', text: '批量处理所有图片。', note: '总而言之，混淆后的图长得像参考图，还原后的图长得像原图。' },
    ],
  },
  decode: {
    label: '还原图像', number: '02',
    steps: [
      { target: '#encoded-picker', action: 'upload-decode', title: '选一张混淆图', text: '选择原文件。可一次添加多张；不用再选参考图或设置参数。', note: '选好图片后继续。' },
      { target: '#decode-list .progress-ring', fallback: '#encoded-picker', action: 'decode-single', title: '单独还原一张图片', text: '点击按钮还原这张图。', demo: 'decode', note: '点击按钮还原单张图片。' },
      { target: '#decode-button', title: '批量还原与下载', text: '批量还原图片。点击某个条目可切换到对应预览。' },
    ],
  },
  advanced: {
    label: '高级模式', number: '03',
    steps: [
      { target: '#source-scale', title: '处理尺寸', text: '默认自动调整，通常不用改。关闭自动后可手动设比例。' },
      { target: '#carrier-scale', title: '放大倍数', text: '默认自动匹配分块。手动调高会增大文件；过低可能无法还原。' },
      { target: '#manual-parameters', area: 'label', title: '自定义效果', text: '需要微调时再开启，可改颜色、细节保留、参考图显示方式和 JPG 耐压缩度。' },
    ],
  },
};

export function initializeTutorial() {
  const $ = selector => document.querySelector(selector);
  const seen = new Set();
  const positions = new Map();
  const stepProgress = new Map();
  let current = null;
  let switching = false;
  let previousFocus = null;
  let frame = 0;
  let target = null;
  let presetPrompt = null;
  const storageKey = kind => `naiwa-tutorial-v1-${kind}`;
  const stateForStep = (kind, index) => {
    const key = `${kind}:${index}`;
    if (!stepProgress.has(key)) stepProgress.set(key, { triggered: false, done: false });
    return stepProgress.get(key);
  };
  const hasSeen = kind => {
    try { return seen.has(kind) || localStorage.getItem(storageKey(kind)) === '1'; } catch { return seen.has(kind); }
  };
  const remember = kind => {
    seen.add(kind);
    try { localStorage.setItem(storageKey(kind), '1'); } catch { /* The tour still works when storage is unavailable. */ }
  };

  const root = document.createElement('div');
  root.className = 'tutorial'; root.hidden = true;
  root.innerHTML = `
    <svg class="tutorial-shade" aria-hidden="true" width="100%" height="100%">
      <defs><mask id="tutorial-mask" maskUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="white"/><rect class="tutorial-cutout" rx="12" fill="black"/><rect class="tutorial-navigation-cutout" fill="black"/></mask></defs>
      <rect width="100%" height="100%" fill="#171e22" fill-opacity=".64" mask="url(#tutorial-mask)"/>
    </svg>
    <div class="tutorial-spotlight" aria-hidden="true"></div>
    <section class="tutorial-card" role="dialog" aria-labelledby="tutorial-title" aria-describedby="tutorial-description" tabindex="-1">
      <div class="tutorial-card-top"><span class="tutorial-kicker"><span class="tutorial-spark" aria-hidden="true">✦</span> 奶蛙混淆 · 使用指南</span><button class="tutorial-close" type="button" aria-label="退出教程" title="退出，本板块不再自动提示">×</button></div>
      <nav class="tutorial-sections" aria-label="教程板块">${Object.entries(TOURS).map(([kind, tour]) => `<button type="button" data-tour="${kind}"><span>${tour.number}</span>${tour.label}</button>`).join('')}</nav>
      <div class="tutorial-content" aria-live="polite" aria-atomic="true">
        <p class="tutorial-step-label"></p><h2 id="tutorial-title"></h2><p id="tutorial-description"></p>
        <div class="tutorial-demo" aria-hidden="true" hidden><span class="tutorial-demo-image">N</span><span class="tutorial-demo-copy"><strong>我的图片.png</strong><small>等待处理</small></span><span class="progress-ring tutorial-demo-ring">▶</span><span class="tutorial-demo-download">↓</span></div>
        <p class="tutorial-note" hidden></p>
        <p class="tutorial-gate" role="status" aria-live="polite" hidden></p>
      </div>
      <div class="tutorial-dots" role="group" aria-label="教程步骤"></div>
      <div class="tutorial-footer"><button class="tutorial-skip" type="button" title="本板块不再自动提示">跳过教程</button><div><button class="tutorial-prev" type="button">上一步</button><button class="tutorial-next" type="button">下一步 <span aria-hidden="true">→</span></button></div></div>
    </section>`;
  document.body.append(root);
  const card = root.querySelector('.tutorial-card');
  const cutout = root.querySelector('.tutorial-cutout');
  const spotlight = root.querySelector('.tutorial-spotlight');
  const navigationCutout = root.querySelector('.tutorial-navigation-cutout');
  const dots = root.querySelector('.tutorial-dots');
  const previous = root.querySelector('.tutorial-prev');
  const next = root.querySelector('.tutorial-next');

  function actionIsComplete(kind = current?.kind, index = current?.index) {
    return !TOURS[kind]?.steps[index]?.action || stateForStep(kind, index).done;
  }

  function syncPresetPrompt() {
    const list = $('#preset-list');
    const options = [...list.querySelectorAll('.preset-option')];
    const waiting = current?.kind === 'encode' && current.index === 1 && !stateForStep('encode', 1).done;
    if (waiting) {
      if (!presetPrompt) {
        const selected = list.querySelector('.preset-option.is-active');
        presetPrompt = { index: selected?.dataset.index ?? null, name: $('#selected-preset-name').textContent };
      }
      options.forEach((button, index) => {
        button.classList.remove('is-active');
        button.setAttribute('aria-checked', 'false');
        button.tabIndex = index === 0 ? 0 : -1;
      });
      $('#selected-preset-name').textContent = '请选择';
      return;
    }
    if (!presetPrompt) return;
    if (!stateForStep('encode', 1).done) {
      options.forEach(button => {
        const selected = button.dataset.index === presetPrompt.index;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      $('#selected-preset-name').textContent = presetPrompt.name;
    }
    presetPrompt = null;
  }

  function listIsLoaded(selector) {
    const rows = [...$(selector).querySelectorAll('.batch-item')];
    return rows.length > 0 && rows.every(row => ['idle', 'done', 'warning'].includes(row.dataset.status));
  }

  function checkAction() {
    if (!current) return;
    const step = TOURS[current.kind].steps[current.index];
    if (!step.action) return;
    const progress = stateForStep(current.kind, current.index);
    if (!progress.triggered || progress.done) return;
    const ready = ({
      'upload-encode': () => listIsLoaded('#source-list'),
      'upload-decode': () => listIsLoaded('#decode-list'),
      'choose-preset': () => true,
      'share-preset': () => $('#unify-preset').checked,
      'adjust-balance': () => true,
      'encode-single': () => {
        const row = [...$('#source-list').querySelectorAll('.batch-item')].find(item => item.dataset.id === progress.entryId);
        return ['done', 'warning'].includes(row?.dataset.status);
      },
      'encode-batch': () => listIsProcessed('#source-list'),
      'download-encode': () => true,
      'decode-single': () => [...$('#decode-list').querySelectorAll('.batch-item')].some(row => row.dataset.id === progress.entryId && row.dataset.status === 'done'),
      'decode-batch': () => listIsProcessed('#decode-list'),
      'download-decode': () => true,
      'adjust-resize': () => !$('#auto-resize').checked && Number($('#source-scale').value) < 100,
      'adjust-carrier': () => true,
      'enable-manual': () => $('#manual-parameters').checked,
      'adjust-manual': () => true,
    })[step.action]?.() ?? false;
    if (!ready) return;
    progress.done = true;
    refreshGate();
  }

  function matchingActionEvent(event) {
    if (!current) return false;
    const action = TOURS[current.kind].steps[current.index].action;
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return false;
    const matches = selector => Boolean(element.closest(selector));
    if (action === 'upload-encode') return event.type === 'change' && matches('#source-file');
    if (action === 'upload-decode') return event.type === 'change' && matches('#encoded-file');
    if (action === 'choose-preset') return (event.type === 'click' || event.type === 'keydown' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) && matches('#preset-list .preset-option');
    if (action === 'share-preset') return event.type === 'change' && matches('#unify-preset') && $('#unify-preset').checked;
    if (action === 'adjust-balance') return event.type === 'input' && matches('#balance');
    if (action === 'encode-single' || action === 'decode-single') {
      const list = action === 'encode-single' ? '#source-list' : '#decode-list';
      const button = event.type === 'click' ? element.closest(`${list} .progress-ring`) : null;
      if (!button) return false;
      stateForStep(current.kind, current.index).entryId = button.closest('.batch-item')?.dataset.id;
      return true;
    }
    if (action === 'encode-batch') return event.type === 'click' && matches('#encode-button');
    if (action === 'download-encode') return event.type === 'click' && matches('#download-button');
    if (action === 'decode-batch') return event.type === 'click' && matches('#decode-button');
    if (action === 'download-decode') return event.type === 'click' && matches('#download-restored');
    if (action === 'adjust-resize') return ['change', 'input'].includes(event.type) && matches('#auto-resize, #source-scale');
    if (action === 'adjust-carrier') return ['change', 'input'].includes(event.type) && matches('#auto-carrier, #carrier-scale');
    if (action === 'enable-manual') return event.type === 'change' && matches('#manual-parameters') && $('#manual-parameters').checked;
    if (action === 'adjust-manual') return ['change', 'input'].includes(event.type) && matches('#manual-fields select, #manual-fields input');
    return false;
  }

  function handleActionEvent(event) {
    if (!current || !matchingActionEvent(event)) return;
    stateForStep(current.kind, current.index).triggered = true;
    queueMicrotask(checkAction);
  }
  for (const type of ['click', 'input', 'change', 'drop']) document.addEventListener(type, handleActionEvent, true);
  document.addEventListener('drop', event => {
    if (!current || !event.dataTransfer?.files.length) return;
    const action = TOURS[current.kind].steps[current.index].action;
    if ((action === 'upload-encode' && event.target.closest('#source-picker')) || (action === 'upload-decode' && event.target.closest('#encoded-picker'))) {
      stateForStep(current.kind, current.index).triggered = true;
      checkAction();
    }
  }, true);

  function resolveTarget(step) {
    const visible = element => element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    let element = $(step.target);
    if (!visible(element)) element = step.fallback ? $(step.fallback) : null;
    return element && step.area ? element.closest(step.area) : element;
  }

  function position() {
    frame = 0;
    if (!current) return;
    const width = document.documentElement.clientWidth;
    const height = window.visualViewport?.height ?? innerHeight;
    const margin = width < 641 ? 12 : 24;
    const gap = 18;
    const navBottom = Math.max(0, Math.min($('.tabs').getBoundingClientRect().bottom, height));
    navigationCutout.setAttribute('width', String(width)); navigationCutout.setAttribute('height', String(navBottom));
    target = resolveTarget(TOURS[current.kind].steps[current.index]);
    const bounds = target?.getBoundingClientRect();
    const rect = bounds && bounds.bottom > navBottom && bounds.top < height ? {
      left: Math.max(5, bounds.left - 7), right: Math.min(width - 5, bounds.right + 7),
      top: Math.max(navBottom + 5, bounds.top - 7), bottom: Math.min(height - 5, bounds.bottom + 7),
    } : null;
    spotlight.hidden = !rect;
    for (const element of [cutout, spotlight]) {
      const box = rect ?? { left: 0, right: 0, top: 0, bottom: 0 };
      if (element === cutout) {
        for (const [key, value] of Object.entries({ x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top })) element.setAttribute(key, String(value));
      } else Object.assign(element.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
    }
    card.style.width = ''; card.style.maxHeight = '';
    let cardWidth = card.offsetWidth; let cardHeight = card.offsetHeight;
    let left = (width - cardWidth) / 2; let top = (height - cardHeight) / 2;
    if (rect) {
      const candidates = () => [
        { left: rect.right + gap, top: (rect.top + rect.bottom - cardHeight) / 2, fits: width - rect.right >= cardWidth + gap + margin },
        { left: rect.left - cardWidth - gap, top: (rect.top + rect.bottom - cardHeight) / 2, fits: rect.left >= cardWidth + gap + margin },
        { left: (rect.left + rect.right - cardWidth) / 2, top: rect.bottom + gap, fits: height - rect.bottom >= cardHeight + gap + margin },
        { left: (rect.left + rect.right - cardWidth) / 2, top: rect.top - cardHeight - gap, fits: rect.top >= cardHeight + gap + margin },
      ];
      if (!candidates().some(candidate => candidate.fits)) {
        const sideWidth = Math.floor(Math.max(rect.left, width - rect.right) - gap - margin);
        if (sideWidth >= 260 && sideWidth < cardWidth) {
          card.style.width = `${sideWidth}px`; cardWidth = card.offsetWidth; cardHeight = card.offsetHeight;
        }
      }
      if (!candidates().some(candidate => candidate.fits)) {
        const availableHeight = Math.floor(Math.max(rect.top, height - rect.bottom) - gap - margin);
        if (availableHeight >= 160) { card.style.maxHeight = `${availableHeight}px`; cardHeight = card.offsetHeight; }
      }
      const placement = candidates().find(candidate => candidate.fits);
      if (placement) ({ left, top } = placement);
      else top = height - cardHeight - margin;
    }
    Object.assign(card.style, {
      left: `${Math.max(margin, Math.min(width - cardWidth - margin, left))}px`,
      top: `${Math.max(margin, Math.min(height - cardHeight - margin, top))}px`,
    });
  }

  function requestPosition() { if (current && !frame) frame = requestAnimationFrame(position); }
  const resizeObserver = new ResizeObserver(requestPosition);
  resizeObserver.observe(card);
  document.querySelectorAll('.controls').forEach(element => resizeObserver.observe(element));
  document.addEventListener('scroll', requestPosition, { capture: true, passive: true });
  window.addEventListener('resize', requestPosition, { passive: true });
  window.visualViewport?.addEventListener('resize', requestPosition, { passive: true });
  const listObserver = new MutationObserver(() => { requestPosition(); checkAction(); });
  for (const selector of ['#source-list', '#decode-list']) listObserver.observe($(selector), { childList: true, subtree: true, attributes: true, attributeFilter: ['data-status'] });

  function render() {
    const { kind, index } = current; const tour = TOURS[kind]; const step = tour.steps[index];
    root.dataset.tour = kind; root.dataset.step = String(index);
    syncPresetPrompt();
    root.querySelectorAll('[data-tour]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.tour === kind);
      button.setAttribute('aria-current', button.dataset.tour === kind ? 'step' : 'false');
    });
    root.querySelector('.tutorial-step-label').textContent = `${tour.label}： ${String(index + 1).padStart(2, '0')} / ${String(tour.steps.length).padStart(2, '0')}`;
    $('#tutorial-title').textContent = step.title; $('#tutorial-description').textContent = step.text;
    const note = root.querySelector('.tutorial-note'); note.textContent = step.note ?? ''; note.hidden = !step.note;
    root.querySelector('.tutorial-demo').hidden = !step.demo;
    root.querySelector('.tutorial-demo-copy small').textContent = kind === 'decode' ? '等待还原 · 点击右侧按钮' : '等待生成 · 点击右侧按钮';
    previous.disabled = index === 0;
    next.innerHTML = index === tour.steps.length - 1 ? '完成指引 <span aria-hidden="true">✓</span>' : '下一步 <span aria-hidden="true">→</span>';
    dots.replaceChildren(...tour.steps.map((item, stepIndex) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tutorial-dot';
      button.setAttribute('aria-label', `第 ${stepIndex + 1} 步：${item.title}`);
      button.setAttribute('aria-current', stepIndex === index ? 'step' : 'false');
      button.classList.toggle('is-complete', stepIndex < index);
      button.disabled = stepIndex > index && !Array.from({ length: stepIndex }, (_, before) => actionIsComplete(kind, before)).every(Boolean);
      button.addEventListener('click', () => go(stepIndex)); return button;
    }));
    target?.classList.remove('tutorial-target');
    target = resolveTarget(step);
    const disclosure = target?.closest('details');
    if (disclosure) disclosure.open = true;
    target?.classList.add('tutorial-target');
    target?.scrollIntoView({ block: matchMedia('(max-width: 640px)').matches ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
    card.scrollTop = 0; refreshGate(); position(); requestPosition();
  }

  function refreshGate() {
    if (!current) return;
    const step = TOURS[current.kind].steps[current.index];
    const done = actionIsComplete();
    next.disabled = !done;
    root.querySelector('.tutorial-gate').textContent = done ? '' : stateForStep(current.kind, current.index).triggered
      ? '正在等待这项操作完成…' : '请先完成页面高亮区域指引的操作。';
    root.querySelector('.tutorial-gate').hidden = done;
    dots.querySelectorAll('.tutorial-dot').forEach((button, stepIndex) => {
      button.disabled = stepIndex > current.index && !Array.from({ length: stepIndex }, (_, before) => actionIsComplete(current.kind, before)).every(Boolean);
    });
  }

  function close(rememberSeen = true, restoreFocus = true) {
    if (!current) return;
    if (rememberSeen) { remember(current.kind); positions.delete(current.kind); }
    else positions.set(current.kind, current.index);
    current = null; syncPresetPrompt(); root.hidden = true; document.body.classList.remove('has-tutorial'); target?.classList.remove('tutorial-target');
    $('#tutorial-button').setAttribute('aria-expanded', 'false');
    if (restoreFocus && previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
  }

  function open(kind, { force = false, navigate = false } = {}) {
    if (current?.kind === kind && !force) return;
    if (!force && hasSeen(kind)) { close(false, false); return; }
    if (!current) previousFocus = document.activeElement;
    else positions.set(current.kind, current.index);
    switching = true;
    if (navigate) {
      $(`[data-view="${kind === 'decode' ? 'decode' : 'encode'}"]`).click();
      $('#advanced-settings').open = kind === 'advanced';
    }
    current = { kind, index: force ? 0 : positions.get(kind) ?? 0 };
    root.hidden = false; document.body.classList.add('has-tutorial');
    $('#tutorial-button').setAttribute('aria-expanded', 'true');
    render(); card.focus({ preventScroll: true });
    switching = false;
  }

  function go(index) {
    if (!current) return;
    if (index > current.index && (!actionIsComplete() || !Array.from({ length: index }, (_, before) => actionIsComplete(current.kind, before)).every(Boolean))) return;
    if (index >= TOURS[current.kind].steps.length) { close(); return; }
    current.index = Math.max(0, index); render();
  }

  root.querySelector('.tutorial-close').addEventListener('click', () => close());
  root.querySelector('.tutorial-skip').addEventListener('click', () => close());
  previous.addEventListener('click', () => go(current.index - 1));
  next.addEventListener('click', () => go(current.index + 1));
  root.querySelectorAll('[data-tour]').forEach(button => button.addEventListener('click', () => open(button.dataset.tour, { force: true, navigate: true })));
  $('#tutorial-button').setAttribute('aria-expanded', 'false');
  $('#tutorial-button').addEventListener('click', () => {
    const kind = $('#decode-view').hidden ? $('#advanced-settings').open ? 'advanced' : 'encode' : 'decode';
    open(kind, { force: true });
  });
  document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
    if (!switching) open(button.dataset.view === 'decode' ? 'decode' : $('#advanced-settings').open ? 'advanced' : 'encode');
  }));
  $('#advanced-settings').addEventListener('toggle', () => {
    if (switching || !$('#decode-view').hidden) return;
    if ($('#advanced-settings').open) open('advanced');
    else if (current?.kind === 'advanced') { close(false, false); open('encode'); }
  });
  document.addEventListener('keydown', event => {
    if (!current) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (card.contains(event.target) && !event.target.matches('input, select, textarea')) {
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); go(current.index + (event.key === 'ArrowRight' ? 1 : -1)); }
    }
  });
  requestAnimationFrame(() => open('encode'));
  return { open, close };
}
