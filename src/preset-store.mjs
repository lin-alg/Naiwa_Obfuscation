// SPDX-License-Identifier: GPL-3.0-or-later
let connection;

function database() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('naiwa-custom-presets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('presets', { keyPath: 'id' });
    request.onerror = () => { connection = null; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
  });
  return connection;
}

async function transact(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('presets', mode);
    const request = action(transaction.objectStore('presets'));
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

export function selectedPreset(key) {
  try {
    if (key !== undefined) localStorage.setItem('naiwa-selected-preset', key);
    return localStorage.getItem('naiwa-selected-preset');
  } catch { return null; }
}
