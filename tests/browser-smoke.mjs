// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, open, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDirectory, artifactEnvironment } from './artifact-paths.mjs';

const chrome = process.env.CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const temporaryRoot = await artifactDirectory('browser');
if (process.argv.includes('--background')) {
  const log = await open(join(temporaryRoot, 'browser-smoke.log'), 'w');
  const errors = await open(join(temporaryRoot, 'browser-smoke-error.log'), 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((arg) => arg !== '--background')], { detached: true, stdio: ['ignore', log.fd, errors.fd], windowsHide: true, env: artifactEnvironment(temporaryRoot) });
  child.unref(); await log.close(); await errors.close();
  console.log(`Browser smoke PID ${child.pid}`);
  process.exit(0);
}
const profile = await mkdtemp(join(temporaryRoot, 'naiwa-chrome-'));
const downloads = await mkdtemp(join(temporaryRoot, 'downloads-'));
const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=0',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  `--crash-dumps-dir=${temporaryRoot}`,
  '--window-size=1440,1100',
  'http://127.0.0.1:4173/',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: artifactEnvironment(temporaryRoot) });

let browserOutput = '';
browser.stderr.on('data', (chunk) => { browserOutput += chunk.toString(); });

function waitForPort() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chrome DevTools did not start: ${browserOutput}`)), 20000);
    const check = () => {
      const match = browserOutput.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      } else if (browser.exitCode !== null) {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited early: ${browserOutput}`));
      } else setTimeout(check, 100);
    };
    check();
  });
}

const port = await waitForPort();
let pageTarget;
for (let attempt = 0; attempt < 50 && !pageTarget; attempt += 1) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  pageTarget = (await response.json()).find((target) => target.type === 'page');
  if (!pageTarget) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!pageTarget) throw new Error('Chrome page target not found.');

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
const pending = new Map();
const pageErrors = [];
const finishedDownloads = [];
let nextId = 1;
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') finishedDownloads.push(message.params.guid);
  if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(message.params.exceptionDetails.text);
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function setInputFile(selector, path) {
  const { root } = await command('DOM.getDocument', { depth: -1 });
  const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Input not found: ${selector}`);
  await command('DOM.setFileInputFiles', { files: [path], nodeId });
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
}

async function screenshot(filename) {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const path = join(temporaryRoot, filename);
  await writeFile(path, Buffer.from(result.data, 'base64'));
  return path;
}

try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('DOM.enable');
  await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await waitFor('document.querySelectorAll(".preset-option").length === 4');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobileLayout = await evaluate(`({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, controls: document.querySelector('.controls').getBoundingClientRect().width, presets: document.querySelector('#preset-list').getBoundingClientRect().width })`);
  if (mobileLayout.document > mobileLayout.viewport) throw new Error(`Mobile layout overflows: ${JSON.stringify(mobileLayout)}`);
  const mobileScreenshot = await screenshot('naiwa-browser-mobile.png');
  console.log(`mobile layout: ${JSON.stringify(mobileLayout)}; screenshot: ${mobileScreenshot}`);
  await command('Emulation.clearDeviceMetricsOverride');
  const inputFile = fileURLToPath(new URL('../test/static/Funny Background Image Wallpaper.jpg', import.meta.url));
  if (await evaluate('document.querySelectorAll("input[type=password]").length')) throw new Error('Password controls remain');
  const basicMode = await evaluate(`({advancedClosed: !document.querySelector('#advanced-settings').open, manual: document.querySelector('#manual-parameters').checked, quality: document.querySelector('#jpg-quality').value, button: document.querySelector('#download-button').textContent})`);
  if (!basicMode.advancedClosed || basicMode.manual || basicMode.quality !== '75' || !basicMode.button.includes('JPG')) throw new Error(`Incorrect basic defaults: ${JSON.stringify(basicMode)}`);
  await setInputFile('#source-file', inputFile);
  await waitFor('document.querySelector("#source-meta").textContent.includes("Funny Background")');
  await evaluate('document.querySelector("#encode-button").click()');
  const encodedSummary = await waitFor('document.querySelector("#result-summary").textContent.includes("还原验证通过") || document.querySelector("#result-summary").textContent.includes("处理未完成")');
  if (await evaluate('document.querySelector("#result-summary").textContent.includes("处理未完成")')) throw new Error(await evaluate('document.querySelector("#toast").textContent'));
  const initialBytes = await evaluate('Number(document.querySelector("#output-size").dataset.bytes)');
  // Drag rapidly in both directions; the final quality and the cached download
  // must agree, and older asynchronous previews may not overwrite the last one.
  await evaluate(`(() => {const input=document.querySelector('#jpg-quality');for(const value of [60,80,65]){input.value=value;input.dispatchEvent(new Event('input'))}})()`);
  await waitFor('document.querySelector("#output-size").dataset.quality === "65" && document.querySelector("#result-summary").textContent.includes("还原验证通过")');
  const adjustedBytes = await evaluate('Number(document.querySelector("#output-size").dataset.bytes)');
  if (!(adjustedBytes > 0 && adjustedBytes < initialBytes)) throw new Error(`JPG size did not update: ${initialBytes} => ${adjustedBytes}`);
  const unrestricted = await evaluate(`(() => {
    const input=document.querySelector('#preset-threshold');input.value='1';input.dispatchEvent(new Event('input'));
    const allowed=!document.querySelector('#download-button').disabled;
    input.value='';input.dispatchEvent(new Event('input'));
    const emptyAllowed=!document.querySelector('#download-button').disabled;
    input.value='0.50';input.dispatchEvent(new Event('input'));
    return {allowed,emptyAllowed};
  })()`);
  if (!unrestricted.allowed || !unrestricted.emptyAllowed) throw new Error(`Similarity still blocks download: ${JSON.stringify(unrestricted)}`);
  await evaluate('document.querySelector("#download-button").click()');
  const downloadStart = Date.now();
  while (!finishedDownloads.length && Date.now() - downloadStart < 20000) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!finishedDownloads.length) throw new Error('JPG download did not complete');
  const jpgPath = join(downloads, 'naiwa-obfuscated-q65.jpg');
  const jpegBytes = await readFile(jpgPath);
  if (jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8 || (await stat(jpgPath)).size !== adjustedBytes) throw new Error('Downloaded JPG does not match displayed byte count');
  const pngSize = await evaluate(`new Promise(resolve=>document.querySelector('#mosaic-preview').toBlob(blob=>resolve(blob.size),'image/png'))`);
  console.log(`JPG actual download: Q75 ${initialBytes} bytes => Q65 ${adjustedBytes} bytes; preview PNG ${pngSize} bytes; path=${jpgPath}`);
  await setInputFile('#encoded-file', jpgPath);
  await waitFor('document.querySelector("#encoded-meta").textContent.includes("naiwa-obfuscated-q65.jpg")');
  await evaluate('document.querySelector("#decode-button").click()');
  const restoredMessage = await waitFor('document.querySelector("#decode-message").textContent.includes("坐标验证通过")');
  const restoredDimensions = await evaluate('({width: document.querySelector("#decode-preview").width, height: document.querySelector("#decode-preview").height})');
  if (restoredDimensions.width !== 1920 || restoredDimensions.height !== 1200) throw new Error(`Restored dimensions incorrect: ${JSON.stringify(restoredDimensions)}`);
  const transformScreenshot = await screenshot('naiwa-browser-transform.png');
  await evaluate('document.querySelector("#advanced-settings").open = true');
  await waitFor('!document.querySelector(".advanced-preview").hidden');
  await screenshot('naiwa-browser-advanced.png');
  await evaluate('document.querySelector("#download-png").click()');
  const pngDownloadStart = Date.now();
  while (finishedDownloads.length < 2 && Date.now() - pngDownloadStart < 20000) await new Promise((resolve) => setTimeout(resolve, 100));
  if (finishedDownloads.length < 2) throw new Error('Advanced PNG download did not complete');
  const pngPath = join(downloads, 'naiwa-obfuscated.png');
  const rawPngBytes = (await stat(pngPath)).size;
  if (!(rawPngBytes > adjustedBytes)) throw new Error('Expected compressed JPG to be smaller than the raw PNG');
  const pngUrl = '/' + relative(fileURLToPath(new URL('../', import.meta.url)), pngPath).split(sep).join('/');
  const compressionComparison = await evaluate(`(async () => {
    const {restoreImage,imageSimilarity}=await import('./core.mjs');
    const png=await (await fetch(${JSON.stringify(pngUrl)})).blob();
    const bitmap=await createImageBitmap(png);
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
    const restored=await restoreImage({width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data});
    const source=document.querySelector('#source-preview');
    const sourcePixels=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
    const pngSSIM=imageSimilarity(sourcePixels,restored.data,source.width,source.height);
    const jpgSSIM=Number(document.querySelector('#restore-metrics').textContent.match(/SSIM ([0-9.]+)/)[1]);
    return {pngSSIM,jpgSSIM};
  })()`);
  if (Math.abs(compressionComparison.pngSSIM - compressionComparison.jpgSSIM) > 0.015) throw new Error(`Unexpected JPG restoration degradation: ${JSON.stringify(compressionComparison)}`);
  const jpegVerification = { quality: 65, jpgBytes: adjustedBytes, rawPngBytes, jpgToPngRatio: adjustedBytes / rawPngBytes, ...compressionComparison };
  await writeFile(join(temporaryRoot, 'jpg-verification.json'), JSON.stringify(jpegVerification, null, 2));
  console.log(`JPG vs raw PNG: ${JSON.stringify(jpegVerification)}`);
  await evaluate('document.querySelector("#advanced-settings").open = false');
  await waitFor('document.querySelector(".advanced-preview").hidden');
  await evaluate('document.querySelector("#balance").value=90; document.querySelector("#balance").dispatchEvent(new Event("input"))');
  await waitFor('document.querySelector("#applied-options").textContent.includes("强度 22") && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);
  // Benchmark the standard balanced profile after checking automatic re-generation.
  await evaluate('document.querySelector("#balance").value=50; document.querySelector("#balance").dispatchEvent(new Event("input"))');
  await waitFor('document.querySelector("#applied-options").textContent.includes("强度 16") && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);

  await evaluate('document.querySelector("[data-view=benchmark]").click(); document.querySelector("#test-count").value = "1"; document.querySelector("#benchmark-button").click()');
  await waitFor('document.querySelector("#benchmark-progress").textContent.includes("评测完成")', 180000);
  const chartRows = await evaluate('document.querySelectorAll("#benchmark-results tr").length');
  const benchmarkScreenshot = await screenshot('naiwa-browser-benchmark.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobileBenchmark = await evaluate('({viewport:window.innerWidth,document:document.documentElement.scrollWidth})');
  if (mobileBenchmark.document > mobileBenchmark.viewport) throw new Error(`Mobile benchmark overflows: ${JSON.stringify(mobileBenchmark)}`);
  await command('Emulation.clearDeviceMetricsOverride');
  if (process.argv.includes('--reports')) {
    await command('Page.navigate', { url: 'http://127.0.0.1:4173/reports/compare.html' });
    await waitFor('document.querySelector("#selection")?.textContent.includes("当前约束下")');
    const reportState = await evaluate('({ rows: document.querySelectorAll("#rows tr").length, text: document.querySelector("#selection").textContent })');
    if (reportState.rows !== 32) throw new Error(`Expected 32 report rows: ${JSON.stringify(reportState)}`);
    const reportGate = await evaluate(`(() => {
      const input = document.querySelector('#preset-floor');
      input.value = '1'; input.dispatchEvent(new Event('input'));
      const blocked = document.querySelector('#selection').textContent.includes('没有');
      input.value = '0.50'; input.dispatchEvent(new Event('input'));
      return blocked;
    })()`);
    if (!reportGate) throw new Error('Interactive report threshold did not update');
    console.log(`interactive report passed: ${JSON.stringify(reportState)}`);
    await screenshot('naiwa-report-compare.png');
  }
  if (pageErrors.length) throw new Error(`Browser runtime errors: ${pageErrors.join(' | ')}`);

  if (chartRows !== 5) throw new Error(`Expected 5 benchmark rows, received ${chartRows}`);
  console.log(`browser smoke passed: ${encodedSummary}; ${restoredMessage}; ${chartRows} benchmark rows; downloads unrestricted ${JSON.stringify(unrestricted)}; profiles=${profile}`);
  console.log(`screenshots: ${transformScreenshot}; ${benchmarkScreenshot}`);
} finally {
  socket.close();
  browser.kill();
}
