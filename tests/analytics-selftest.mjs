// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { initializeAnalytics } from '../src/analytics.mjs';

globalThis.crypto ??= webcrypto;
globalThis.location = { protocol: 'https:', origin: 'https://nai-hub.com', href: 'https://nai-hub.com/tool/' };

class Element {
  listeners = new Map();
  hidden = false;
  checked = false;
  textContent = '';
  dataset = {};
  attributes = new Map();

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  async click() {
    for (const callback of this.listeners.get('click') ?? []) await callback({ preventDefault() {}, target: this });
  }

  async change() {
    for (const callback of this.listeners.get('change') ?? []) await callback({ target: this });
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

const selectors = [
  '#visitor-count', '#conversion-count', '#phantom-count', '#policy-dialog', '#analytics-toggle', '#analytics-toggle-state',
  '#policy-title', '#terms-copy', '#privacy-copy',
];
const elements = new Map(selectors.map(selector => [selector, new Element()]));
const privacyLink = new Element();
privacyLink.dataset.policy = 'privacy';
const termsLink = new Element();
termsLink.dataset.policy = 'terms';
const policyLinks = [privacyLink, termsLink];
const dialog = elements.get('#policy-dialog');
dialog.showModal = () => { dialog.open = true; };
dialog.close = () => { dialog.open = false; };

const cookies = new Map();
globalThis.document = {
  querySelector: selector => elements.get(selector),
  querySelectorAll: selector => selector === '[data-policy]' ? policyLinks : [new Element(), new Element()],
  addEventListener() {},
  get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); },
  set cookie(value) {
    const [cookie, ...attributes] = value.split(';');
    const separator = cookie.indexOf('=');
    const name = cookie.slice(0, separator);
    const content = cookie.slice(separator + 1);
    if (attributes.some(attribute => attribute.trim() === 'Max-Age=0')) cookies.delete(name);
    else cookies.set(name, content);
  },
};

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};

const requests = [];
let conversionEvents = 0;
let phantomEvents = 7;
let failPhantom = false;
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  const isConversionPage = options.headers['x-bsz-referer'].endsWith('/__naiwa_conversion__');
  const isPhantomPage = options.headers['x-bsz-referer'].endsWith('/__naiwa_phantom__');
  if (isPhantomPage && failPhantom) throw new Error('Phantom statistics unavailable');
  if (options.method === 'POST' && isConversionPage) conversionEvents += 1;
  if (options.method === 'POST' && isPhantomPage) phantomEvents += 1;
  return {
    ok: true,
    headers: { get: name => name === 'Set-Bsz-Identity' && !options.headers.Authorization ? `service-visitor-id-${requests.length}` : null },
    json: async () => ({ success: true, data: { site_uv: 27, page_pv: isConversionPage ? conversionEvents : isPhantomPage ? phantomEvents : 40 } }),
  };
};

const analytics = initializeAnalytics();
assert.equal(elements.get('#analytics-toggle').checked, true, 'statistics default to enabled');
await analytics.ready;
assert.equal(requests.length, 3, 'entry records a visit and reads both independent totals');
assert.equal(requests[0].url, 'https://bsz.iirose.cn/api');
assert.equal(requests[0].options.method, 'POST');
assert.equal(requests[0].options.headers['x-bsz-referer'], location.href);
assert.equal(requests[1].options.method, 'GET', 'reading totals does not increment them');
assert.equal(requests[1].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_conversion__');
assert.equal(requests[2].options.method, 'GET', 'reading phantom totals does not increment them');
assert.equal(requests[2].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_phantom__');
assert.equal(requests[0].options.headers.Authorization, undefined, 'the service issues the first visitor identity');
assert.equal(cookies.get('naiwa_bsz_id'), 'service-visitor-id-1');
assert.equal(elements.get('#visitor-count').textContent, '27');
assert.equal(elements.get('#conversion-count').textContent, '0');
assert.equal(elements.get('#phantom-count').textContent, '7');

await privacyLink.click();
assert.equal(dialog.open, true);
assert.equal(elements.get('#policy-title').textContent, '隐私政策');
assert.equal(elements.get('#privacy-copy').hidden, false);

const toggle = elements.get('#analytics-toggle');
toggle.checked = false;
await toggle.change();
assert.equal(storage.get('naiwa-analytics-enabled'), 'disabled');
assert.equal(elements.get('#analytics-toggle-state').textContent, '已关闭');
assert.equal(cookies.has('naiwa_bsz_id'), false, 'disabling statistics removes the visitor identity cookie');
await analytics.recordConversion();
await analytics.recordPhantom();
assert.equal(elements.get('#phantom-count').textContent, '关闭');
assert.equal(requests.length, 3, 'disabled statistics send neither conversion nor phantom events');

toggle.checked = true;
await toggle.change();
assert.equal(storage.get('naiwa-analytics-enabled'), 'enabled');
assert.equal(requests.length, 6, 'enabling records a visit and reads both totals');
assert.equal(requests[3].options.method, 'POST');
assert.equal(requests[3].options.headers.Authorization, undefined);
assert.equal(cookies.get('naiwa_bsz_id'), 'service-visitor-id-4');

await analytics.recordConversion();
assert.equal(requests.length, 7, 'one successful image operation sends one conversion event');
assert.equal(requests[6].options.method, 'POST');
assert.equal(requests[6].options.headers.Authorization, 'Bearer service-visitor-id-4');
assert.equal(requests[6].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_conversion__');
assert.equal(elements.get('#conversion-count').textContent, '1');
assert.equal(elements.get('#phantom-count').textContent, '7', 'ordinary operations do not change phantom totals');

await analytics.recordPhantom();
assert.equal(requests.length, 8, 'one completed phantom sends one independent event');
assert.equal(requests[7].options.method, 'POST');
assert.equal(requests[7].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_phantom__');
assert.equal(elements.get('#phantom-count').textContent, '8');
assert.equal(elements.get('#conversion-count').textContent, '1', 'phantom operations do not overwrite ordinary totals');
assert.equal(conversionEvents, 1);
assert.equal(phantomEvents, 8);

const refreshedAnalytics = initializeAnalytics();
await refreshedAnalytics.ready;
assert.equal(requests.length, 11, 'refresh records a visit then reads both independent totals');
assert.equal(requests[8].options.method, 'POST');
assert.equal(requests[9].options.method, 'GET');
assert.equal(requests[9].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_conversion__');
assert.equal(requests[10].options.method, 'GET');
assert.equal(requests[10].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_phantom__');
assert.equal(conversionEvents, 1, 'refresh does not increment conversion events');
assert.equal(phantomEvents, 8, 'refresh does not increment phantom events');
assert.equal(elements.get('#conversion-count').textContent, '1', 'the global conversion total survives refresh');
assert.equal(elements.get('#phantom-count').textContent, '8', 'the global phantom total survives refresh');

failPhantom = true;
await refreshedAnalytics.recordPhantom();
assert.equal(elements.get('#phantom-count').textContent, '—');
assert.equal(elements.get('#conversion-count').textContent, '1', 'a phantom service failure does not clear the ordinary count');
assert.equal(elements.get('#visitor-count').textContent, '27');
failPhantom = false;
await refreshedAnalytics.recordPhantom();
assert.equal(elements.get('#phantom-count').textContent, '9', 'future events still work after a failed request');

toggle.checked = false;
await toggle.change();
assert.equal(storage.get('naiwa-analytics-enabled'), 'disabled');
assert.equal(cookies.has('naiwa_bsz_id'), false);
await refreshedAnalytics.recordConversion();
await refreshedAnalytics.recordPhantom();
assert.equal(elements.get('#phantom-count').textContent, '关闭');
assert.equal(requests.length, 13, 'disabled statistics stop future requests');

console.log('compatible analytics passed: cookie identity, independent conversion/phantom totals, refresh-safe reads, disable and failure isolation');
