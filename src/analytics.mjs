// SPDX-License-Identifier: GPL-3.0-or-later
const API_URL = 'https://bsz.iirose.cn/api';
const PREFERENCE_KEY = 'naiwa-analytics-enabled';
const LEGACY_CONSENT_KEY = 'naiwa-analytics-consent';
const COOKIE_NAME = 'naiwa_bsz_id';
const $ = selector => document.querySelector(selector);

function readCookie() {
  const prefix = `${COOKIE_NAME}=`;
  const value = document.cookie.split('; ').find(cookie => cookie.startsWith(prefix))?.slice(prefix.length);
  return value ? decodeURIComponent(value) : null;
}

function writeCookie(value, maxAge = 31536000) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
}

function randomIdentity() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function getPreference() {
  try {
    const preference = localStorage.getItem(PREFERENCE_KEY);
    if (preference !== null) return preference;
    return localStorage.getItem(LEGACY_CONSENT_KEY) === 'rejected' ? 'disabled' : null;
  } catch { return null; }
}

function savePreference(value) {
  try { localStorage.setItem(PREFERENCE_KEY, value); } catch { /* The choice still applies for this page view. */ }
}

function displayCount(element, value) {
  const count = Number(value);
  element.textContent = Number.isFinite(count) ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(count) : '—';
  element.removeAttribute('title');
}

export function initializeAnalytics() {
  const visitorCount = $('#visitor-count');
  const conversionCount = $('#conversion-count');
  const phantomCount = $('#phantom-count');
  const countElements = [visitorCount, conversionCount, phantomCount];
  const dialog = $('#policy-dialog');
  const toggle = $('#analytics-toggle');
  const preference = getPreference();
  let enabled = preference !== 'disabled';
  let requestQueue = Promise.resolve();

  const updateToggle = () => {
    toggle.checked = enabled;
    toggle.setAttribute('aria-checked', String(enabled));
    $('#analytics-toggle-state').textContent = enabled ? '已开启' : '已关闭';
  };

  const updateCounts = (data, operationCount) => {
    if (!enabled) return;
    displayCount(visitorCount, data.site_uv);
    if (operationCount) displayCount(operationCount, data.page_pv);
  };

  async function requestCounts(referer, method) {
    const identity = readCookie();
    const headers = { 'x-bsz-referer': referer };
    if (identity) headers.Authorization = `Bearer ${identity}`;
    const response = await fetch(API_URL, { method, headers, cache: 'no-store' });
    if (!response.ok) throw new Error('统计服务请求失败');
    const result = await response.json();
    if (!result.success || !result.data) throw new Error('统计服务响应无效');
    if (method === 'POST') {
      const serviceIdentity = response.headers.get('Set-Bsz-Identity');
      if (serviceIdentity) writeCookie(serviceIdentity);
      else if (!identity) writeCookie(randomIdentity());
    }
    return result.data;
  }

  function refreshCounts() {
    return Promise.all([
      enqueue(async () => updateCounts(await requestCounts(location.href, 'POST')), [visitorCount]),
      enqueue(async () => updateCounts(await requestCounts(new URL('/__naiwa_conversion__', location.origin).href, 'GET'), conversionCount), [conversionCount]),
      enqueue(async () => updateCounts(await requestCounts(new URL('/__naiwa_phantom__', location.origin).href, 'GET'), phantomCount), [phantomCount]),
    ]);
  }

  function enqueue(taskAction, affectedElements) {
    const task = requestQueue.then(() => enabled ? taskAction() : undefined);
    requestQueue = task.catch(() => {});
    return task.catch(() => {
      if (enabled) {
        for (const element of affectedElements) {
          element.textContent = '—';
          element.title = '统计服务暂不可用';
        }
      }
    });
  }

  function setEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    savePreference(next ? 'enabled' : 'disabled');
    if (!next) {
      writeCookie('', 0);
      countElements.forEach(element => { element.textContent = '关闭'; });
    } else {
      countElements.forEach(element => { element.textContent = '…'; });
      const request = refreshCounts();
      updateToggle();
      return request;
    }
    updateToggle();
  }

  document.querySelectorAll('[data-policy]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    const policy = link.dataset.policy;
    $('#policy-title').textContent = policy === 'privacy' ? '隐私政策' : '使用条款';
    $('#terms-copy').hidden = policy !== 'terms';
    $('#privacy-copy').hidden = policy !== 'privacy';
    dialog.showModal();
  }));
  document.querySelectorAll('.policy-close, .policy-done').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  toggle.addEventListener('change', () => setEnabled(toggle.checked));

  const ready = enabled ? refreshCounts() : Promise.resolve();
  if (!enabled) {
    countElements.forEach(element => { element.textContent = '关闭'; });
  }
  updateToggle();

  return {
    ready,
    recordConversion() {
      if (!enabled) return;
      const conversionPage = new URL('/__naiwa_conversion__', location.origin).href;
      return enqueue(async () => updateCounts(await requestCounts(conversionPage, 'POST'), conversionCount), [conversionCount]);
    },
    recordPhantom() {
      if (!enabled) return;
      const phantomPage = new URL('/__naiwa_phantom__', location.origin).href;
      return enqueue(async () => updateCounts(await requestCounts(phantomPage, 'POST'), phantomCount), [phantomCount]);
    },
  };
}
