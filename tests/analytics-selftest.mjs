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
  '#visitor-count', '#conversion-count', '#policy-dialog', '#analytics-toggle', '#analytics-toggle-state',
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
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  const isConversionPage = options.headers['x-bsz-referer'].endsWith('/__naiwa_conversion__');
  if (options.method === 'POST' && isConversionPage) conversionEvents += 1;
  return {
    ok: true,
    headers: { get: name => name === 'Set-Bsz-Identity' && !options.headers.Authorization ? `service-visitor-id-${requests.length}` : null },
    json: async () => ({ success: true, data: { site_uv: 27, page_pv: isConversionPage ? conversionEvents : 40 } }),
  };
};

const analytics = initializeAnalytics();
assert.equal(elements.get('#analytics-toggle').checked, true, 'statistics default to enabled');
await analytics.ready;
assert.equal(requests.length, 2, 'entry records a visit and reads conversion totals');
assert.equal(requests[0].url, 'https://bsz.iirose.cn/api');
assert.equal(requests[0].options.method, 'POST');
assert.equal(requests[0].options.headers['x-bsz-referer'], location.href);
assert.equal(requests[1].options.method, 'GET', 'reading totals does not increment them');
assert.equal(requests[1].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_conversion__');
assert.equal(requests[0].options.headers.Authorization, undefined, 'the service issues the first visitor identity');
assert.equal(cookies.get('naiwa_bsz_id'), 'service-visitor-id-1');
assert.equal(elements.get('#visitor-count').textContent, '27');
assert.equal(elements.get('#conversion-count').textContent, '0');

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
assert.equal(requests.length, 2, 'disabled statistics send no conversion events');

toggle.checked = true;
await toggle.change();
assert.equal(storage.get('naiwa-analytics-enabled'), 'enabled');
assert.equal(requests.length, 4, 'enabling records a visit and reads the conversion total');
assert.equal(requests[2].options.method, 'POST');
assert.equal(requests[2].options.headers.Authorization, undefined);
assert.equal(cookies.get('naiwa_bsz_id'), 'service-visitor-id-3');

await analytics.recordConversion();
assert.equal(requests.length, 5, 'one successful image operation sends one conversion event');
assert.equal(requests[4].options.method, 'POST');
assert.equal(requests[4].options.headers.Authorization, 'Bearer service-visitor-id-3');
assert.equal(requests[4].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_conversion__');
assert.equal(elements.get('#conversion-count').textContent, '1');

const refreshedAnalytics = initializeAnalytics();
await refreshedAnalytics.ready;
assert.equal(requests.length, 7, 'refresh records a visit then reads the current conversion total');
assert.equal(requests[5].options.method, 'POST');
assert.equal(requests[6].options.method, 'GET');
assert.equal(requests[6].options.headers['x-bsz-referer'], 'https://nai-hub.com/__naiwa_conversion__');
assert.equal(conversionEvents, 1, 'refresh does not increment conversion events');
assert.equal(elements.get('#conversion-count').textContent, '1', 'the global conversion total survives refresh');

toggle.checked = false;
await toggle.change();
assert.equal(storage.get('naiwa-analytics-enabled'), 'disabled');
assert.equal(cookies.has('naiwa_bsz_id'), false);
await refreshedAnalytics.recordConversion();
assert.equal(requests.length, 7, 'disabled statistics stop future requests');

console.log('compatible analytics passed: cookie identity, per-conversion PV and refresh-safe read-only totals');
