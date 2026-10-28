// SPDX-License-Identifier: GPL-3.0-or-later
let connection;

function database() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('naiwa-custom-presets', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('builtin-presets')) db.createObjectStore('builtin-presets', { keyPath: 'src' });
    };
    request.onerror = () => { connection = null; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
  });
  return connection;
}

async function transact(mode, action, storeName = 'presets') {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('无法访问浏览器参考图存储。'));
  });
}

export async function listPresets() {
  const records = await transact('readonly', store => store.getAll());
  return records.filter(record => typeof record.id === 'string' && record.blob instanceof Blob).sort((a, b) => a.createdAt - b.createdAt);
}

export function savePreset(record) {
  return transact('readwrite', store => store.put(record));
}

export function deletePreset(id) {
  return transact('readwrite', store => store.delete(id));
}

// Bump this version when the bundled reference images change.
const BUILTIN_PRESET_VERSION = 1;

export async function loadBuiltinPreset(src) {
  const url = new URL(src, document.baseURI).href;
  try {
    const cached = await transact('readonly', store => store.get(url), 'builtin-presets');
    if (cached?.version === BUILTIN_PRESET_VERSION && cached.blob instanceof Blob && cached.blob.size > 0) return cached.blob;
  } catch { /* Load from the server if browser storage is unavailable. */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法加载内置参考图。');
  const blob = await response.blob();
  try {
    await transact('readwrite', store => store.put({ src: url, version: BUILTIN_PRESET_VERSION, blob }), 'builtin-presets');
  } catch { /* The image remains usable when the cache cannot be saved. */ }
  return blob;
}

export function selectedPreset(key) {
  try {
    if (key !== undefined) localStorage.setItem('naiwa-selected-preset', key);
    return localStorage.getItem('naiwa-selected-preset');
  } catch { return null; }
}
