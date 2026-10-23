// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, open, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { artifactDirectory, artifactEnvironment } from './artifact-paths.mjs';
import { decode, png } from './image-io.mjs';
import { embeddedImagePayload, parseGif } from '../src/gif-codec.mjs';

const chrome = process.env.CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const testUrl = process.env.NAIWA_TEST_URL ?? 'http://127.0.0.1:4173/';
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
  testUrl,
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
    pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const diagnostic = await evaluate(`({ presets:document.querySelectorAll('.preset-option').length, result:document.querySelector('#result-summary')?.textContent, toast:document.querySelector('#toast')?.textContent, custom:document.querySelector('#custom-preset-hint')?.textContent })`);
  throw new Error(`Timed out waiting for: ${expression}; ${JSON.stringify({ ...diagnostic, pageErrors })}`);
}

async function setInputFile(selector, path, append = false) {
  if (!append && ['#source-file', '#encoded-file'].includes(selector)) {
    await evaluate(`document.querySelectorAll('${selector === '#source-file' ? '#source-list' : '#decode-list'} .batch-remove').forEach(button=>button.click())`);
  }
  const { root } = await command('DOM.getDocument', { depth: -1 });
  const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Input not found: ${selector}`);
  await command('DOM.setFileInputFiles', { files: Array.isArray(path) ? path : [path], nodeId });
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
  await waitFor('document.querySelectorAll(".preset-option").length === 6');
  await waitFor('!document.querySelector("#custom-preset-picker").disabled');
  for (const width of [320, 768]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    const layout = await evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth,height:innerHeight,documentHeight:document.documentElement.scrollHeight})');
    if (layout.document > layout.viewport) throw new Error(`Layout overflows at ${width}: ${JSON.stringify(layout)}`);
    if (width < 500 && layout.documentHeight > layout.height + 1) throw new Error(`Initial phone view requires vertical scrolling at ${width}: ${JSON.stringify(layout)}`);
  }
  for (const [width, height] of [[641, 480], [800, 600], [1024, 768], [1440, 900], [1920, 1080]]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const viewportFit = await evaluate(`(() => {const workbench=document.querySelector('#encode-view .workbench').getBoundingClientRect(),controls=document.querySelector('#encode-view .controls').getBoundingClientRect(),footer=document.querySelector('.site-footer').getBoundingClientRect();return {viewport:innerHeight,bodyHeight:document.body.clientHeight,bodyScroll:document.body.scrollHeight,documentWidth:document.documentElement.scrollWidth,overflowY:getComputedStyle(document.documentElement).overflowY,scrollY:window.scrollY,previewHidden:document.querySelector('#preview-area').hidden,workbenchBottom:Math.round(workbench.bottom),controlsBottom:Math.round(controls.bottom),footerTop:Math.round(footer.top)}})()`);
    if (viewportFit.bodyScroll > viewportFit.bodyHeight + 1 || viewportFit.documentWidth > width + 1 || viewportFit.overflowY !== 'hidden' || viewportFit.scrollY !== 0 || !viewportFit.previewHidden || viewportFit.controlsBottom > viewportFit.workbenchBottom + 1 || viewportFit.workbenchBottom > viewportFit.footerTop + 1) throw new Error(`Desktop start view overflows at ${width}x${height}: ${JSON.stringify(viewportFit)}`);
  }
  if (!await evaluate(`document.querySelector('#advanced-settings').parentElement.classList.contains('basic-settings')`)) throw new Error('Advanced settings must be inside output options');
  await evaluate(`document.querySelector('#advanced-settings').open=true`);
  await waitFor('document.body.classList.contains("has-advanced-settings")');
  const expandedDesktop = await evaluate(`({overflowY:getComputedStyle(document.documentElement).overflowY,documentHeight:document.documentElement.scrollHeight,viewport:innerHeight,contentHeight:document.querySelector('#advanced-settings').getBoundingClientRect().height,contentWidth:document.querySelector('#advanced-settings').getBoundingClientRect().width})`);
  if (expandedDesktop.overflowY !== 'auto' || expandedDesktop.contentWidth < 400 || expandedDesktop.contentHeight < 300 || expandedDesktop.documentHeight <= expandedDesktop.viewport) throw new Error(`Expanded desktop settings should use the output column and page scrolling: ${JSON.stringify(expandedDesktop)}`);
  await evaluate(`document.querySelector('#advanced-settings').open=false`);
  await waitFor('!document.body.classList.contains("has-advanced-settings")');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobileLayout = await evaluate(`({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, height: window.innerHeight, documentHeight: document.documentElement.scrollHeight, controls: document.querySelector('.controls').getBoundingClientRect().width, presets: document.querySelector('#preset-list').getBoundingClientRect().width })`);
  if (mobileLayout.document > mobileLayout.viewport || mobileLayout.documentHeight > mobileLayout.height + 1) throw new Error(`Initial mobile layout overflows or scrolls: ${JSON.stringify(mobileLayout)}`);
  const mobileScreenshot = await screenshot('naiwa-browser-mobile.png');
  console.log(`mobile layout: ${JSON.stringify(mobileLayout)}; screenshot: ${mobileScreenshot}`);
  const mobileAdvanced = await evaluate(`(() => {document.querySelector('#advanced-settings').open=true;const bounds=[...document.querySelectorAll('.preference-labels span')].map(item=>{const rect=item.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}});return {viewport:innerWidth,document:document.documentElement.scrollWidth,bounds,overlap:bounds[0].right>bounds[1].left&&bounds[0].top<bounds[1].bottom&&bounds[1].top<bounds[0].bottom}})()`);
  if (mobileAdvanced.document > mobileAdvanced.viewport || mobileAdvanced.overlap) throw new Error(`Mobile advanced controls overlap or overflow: ${JSON.stringify(mobileAdvanced)}`);
  await evaluate(`document.querySelector('#advanced-settings').open=false`);
  await command('Emulation.clearDeviceMetricsOverride');
  if (!await evaluate('document.querySelector("#preview-area").hidden && document.querySelectorAll("#preview-grid .preview-panel:not([hidden])").length === 3')) throw new Error('Initial view should keep the preview area hidden until generation');
  await screenshot('naiwa-browser-start.png');
  await evaluate(`document.querySelector('.preset-option[data-index="0"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  if (!await evaluate(`document.querySelector('.preset-option[data-index="1"]').getAttribute('aria-checked') === 'true'`)) throw new Error('Preset keyboard navigation failed');
  await evaluate(`document.querySelector('.preset-option[data-index="1"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
  await evaluate(`document.querySelector('.preset-option[data-index="4"]').click()`);
  const animatedPresetDefaults = await evaluate(`({balance:document.querySelector('#balance').value,tileSize:document.querySelector('#tile-size').value})`);
  if (animatedPresetDefaults.balance !== '100' || animatedPresetDefaults.tileSize !== '2') throw new Error(`Animated output preset should default to 2px / preset-focused: ${JSON.stringify(animatedPresetDefaults)}`);
  await evaluate(`document.querySelector('.preset-option[data-index="0"]').click()`);
  const staticDefaults = await evaluate(`({balance:document.querySelector('#balance').value,tileSize:document.querySelector('#tile-size').value,label:document.querySelector('#balance-value').value})`);
  if (staticDefaults.balance !== '50' || staticDefaults.tileSize !== '8' || staticDefaults.label !== '两边兼顾') throw new Error(`Static output should default to the calibrated midpoint: ${JSON.stringify(staticDefaults)}`);
  const smokeImage = await decode(fileURLToPath(new URL('./fixtures/static/4.jpg', import.meta.url)), 640, 360, 'scale=640:360:flags=area');
  const inputFile = join(temporaryRoot, 'test-photo.png');
  await writeFile(inputFile, await png(smokeImage, 640));
  const userPageControls = await evaluate(`({benchmarkTab:document.querySelector('[data-view="benchmark"]'),benchmarkWidgets:document.querySelectorAll('#benchmark-button,#benchmark-chart,#preset-chart').length})`);
  if (userPageControls.benchmarkTab || userPageControls.benchmarkWidgets) throw new Error('Developer-only benchmark controls are exposed on the user page');
  if (await evaluate('document.querySelectorAll("input[type=password]").length')) throw new Error('Password controls remain');
  const basicMode = await evaluate(`({advancedClosed: !document.querySelector('#advanced-settings').open, manual: document.querySelector('#manual-parameters').checked, quality: document.querySelector('#jpg-quality').value, balance: document.querySelector('#balance').value, balanceLabel: document.querySelector('#balance-value').value, tileType: document.querySelector('#tile-size').type, tile: document.querySelector('#tile-size').value, autoCarrier: document.querySelector('#auto-carrier').checked, carrierDisabled: document.querySelector('#carrier-scale').disabled, button: document.querySelector('#download-button').textContent})`);
  if (!basicMode.advancedClosed || basicMode.manual || basicMode.quality !== '75' || basicMode.balance !== '50' || basicMode.balanceLabel !== '两边兼顾' || basicMode.tileType !== 'range' || basicMode.tile !== '8' || !basicMode.autoCarrier || !basicMode.carrierDisabled || !basicMode.button.includes('JPG')) throw new Error(`Incorrect basic defaults: ${JSON.stringify(basicMode)}`);
  const carrierPairing = await evaluate(`(() => {const tile=document.querySelector('#tile-size');tile.value='4';tile.dispatchEvent(new Event('input'));const fine=document.querySelector('#carrier-scale').value;tile.value='8';tile.dispatchEvent(new Event('input'));return {fine,restored:document.querySelector('#carrier-scale').value,hint:document.querySelector('#tile-size-hint').textContent,choices:document.querySelector('#carrier-scale').options.length}})()`);
   if (carrierPairing.fine !== '4' || carrierPairing.restored !== '2' || carrierPairing.choices !== 15 || !carrierPairing.hint.includes('调小后')) throw new Error(`Automatic carrier pairing is incorrect: ${JSON.stringify(carrierPairing)}`);
  await setInputFile('#source-file', inputFile);
  await waitFor('document.querySelector("#source-meta").textContent.includes("test-photo.png")');
  await evaluate('document.querySelector("#encode-button").click()');
  const encodedSummary = await waitFor('document.querySelector("#result-summary").textContent.includes("还原验证通过") || document.querySelector("#result-summary").textContent.includes("处理未完成")');
  if (await evaluate('document.querySelector("#result-summary").textContent.includes("处理未完成")')) throw new Error(await evaluate('document.querySelector("#toast").textContent'));
  const carrierDimensions = await evaluate('({width: document.querySelector("#mosaic-preview").width, height: document.querySelector("#mosaic-preview").height})');
  if (carrierDimensions.width !== 3648 || carrierDimensions.height !== 2048) throw new Error(`Default carrier must be 8px / 2x: ${JSON.stringify(carrierDimensions)}`);
   if (!await evaluate(`document.querySelector('#applied-options').textContent.includes('8 px 图块') && document.querySelector('#applied-options').textContent.includes('放大 2 倍')`)) throw new Error('Default must use 8px tiles and a 2x carrier');
  if (!await evaluate(`!document.querySelector('#preview-area').hidden && document.querySelector('#result-strip').dataset.status === 'ready'`)) throw new Error('Generation did not reveal the preview row and verified output');
  const previewBounds = await evaluate(`(() => {const area=document.querySelector('#preview-area'),grid=document.querySelector('#preview-grid');return {body:document.body.className,html:document.documentElement.className,area:{height:Math.round(area.getBoundingClientRect().height),display:getComputedStyle(area).display,hidden:area.hidden},grid:{height:Math.round(grid.getBoundingClientRect().height),css:getComputedStyle(grid).height},panels:[...document.querySelectorAll('.preview-panel')].filter(panel=>panel.getClientRects().length&&getComputedStyle(panel).display!=='none').map(panel=>{const box=panel.getBoundingClientRect(),canvas=panel.querySelector('.canvas-wrap').getBoundingClientRect();return {panel:panel.dataset.panel,height:Math.round(box.height),canvas:Math.round(canvas.height),overflow:canvas.bottom>box.bottom+1}})}})()`);
  if (previewBounds.panels.some((panel) => panel.canvas < 120 || panel.overflow)) throw new Error(`Visible preview panels collapsed or overflowed: ${JSON.stringify(previewBounds)}`);
  const zoomBehavior = await evaluate(`(() => {
    const canvas=document.querySelector('#mosaic-preview');
    const viewport=canvas.closest('.canvas-viewport');
    document.querySelector('#zoom-one').click();
    const oneToOne=Math.abs(canvas.getBoundingClientRect().width-canvas.width)<1;
    document.querySelector('#zoom-in').click();
    const zoomed={readout:document.querySelector('#zoom-value').textContent,viewportWidth:viewport.clientWidth,scrollWidth:viewport.scrollWidth,canvasWidth:canvas.style.width,stageWidth:canvas.parentElement.parentElement.style.width};
    const scrollContained=viewport.scrollWidth>viewport.clientWidth&&getComputedStyle(viewport).overflow==='hidden'&&document.documentElement.scrollWidth<=innerWidth;
    document.querySelector('#zoom-fit').click();
    const bounds=canvas.getBoundingClientRect(),area=viewport.getBoundingClientRect();
    const fits=bounds.width<=area.width+1&&bounds.height<=area.height+1;
    return {oneToOne,scrollContained,fits,zoomed,overflow:getComputedStyle(viewport).overflow,documentWidth:document.documentElement.scrollWidth};
  })()`);
  if (!zoomBehavior.oneToOne || !zoomBehavior.scrollContained || !zoomBehavior.fits) throw new Error(`Preview zoom/overflow behavior failed: ${JSON.stringify(zoomBehavior)}`);
  await evaluate('document.querySelector("#zoom-one").click();document.querySelector("#zoom-in").click()');
  const mosaicViewport = await evaluate(`(() => {const rect=document.querySelector('#mosaic-preview').closest('.canvas-viewport').getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()`);
  const independentBefore = await evaluate(`Object.fromEntries(['source','mosaic','restored'].map(name=>[name,document.querySelector('#'+({source:'source-preview',mosaic:'mosaic-preview',restored:'restored-preview'}[name])).style.width]))`);
  const zoomAnchorBefore = await evaluate(`(() => {const c=document.querySelector('#mosaic-preview'),v=c.closest('.canvas-viewport'),r=c.getBoundingClientRect(),a=v.getBoundingClientRect(),x=a.left+a.width/2,y=a.top+a.height/2,s=r.width/c.width;return {x:(x-r.left)/s,y:(y-r.top)/s}})()`);
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mosaicViewport.x, y: mosaicViewport.y, deltaY: -120, deltaX: 0 });
  const wheelZoom = await evaluate('Number(document.querySelector("#zoom-value").textContent.replace("%",""))');
  if (wheelZoom <= 115) throw new Error(`Mouse wheel did not zoom the mosaic viewer: ${wheelZoom}`);
  const zoomAnchorAfter = await evaluate(`(() => {const c=document.querySelector('#mosaic-preview'),v=c.closest('.canvas-viewport'),r=c.getBoundingClientRect(),a=v.getBoundingClientRect(),x=a.left+a.width/2,y=a.top+a.height/2,s=r.width/c.width;return {x:(x-r.left)/s,y:(y-r.top)/s}})()`);
  if (Math.abs(zoomAnchorBefore.x - zoomAnchorAfter.x) > 1 || Math.abs(zoomAnchorBefore.y - zoomAnchorAfter.y) > 1) throw new Error(`Wheel zoom moved the image point under the cursor: ${JSON.stringify({ zoomAnchorBefore, zoomAnchorAfter })}`);
  const independentAfter = await evaluate(`Object.fromEntries(['source','mosaic','restored'].map(name=>[name,document.querySelector('#'+({source:'source-preview',mosaic:'mosaic-preview',restored:'restored-preview'}[name])).style.width]))`);
  if (independentBefore.source !== independentAfter.source || independentBefore.restored !== independentAfter.restored || independentBefore.mosaic === independentAfter.mosaic) throw new Error(`Preview zoom is not isolated to the hovered viewer: ${JSON.stringify({ independentBefore, independentAfter })}`);
  await evaluate(`(() => {const viewport=document.querySelector('#mosaic-preview').closest('.canvas-viewport');window.__panBefore={x:viewport.scrollLeft,y:viewport.scrollTop};return viewport.getBoundingClientRect()})()`);
  const panBounds = await evaluate(`(() => {const r=document.querySelector('#mosaic-preview').closest('.canvas-viewport').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: panBounds.x, y: panBounds.y, button: 'left', buttons: 1, clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panBounds.x - 60, y: panBounds.y - 40, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panBounds.x - 60, y: panBounds.y - 40, button: 'left', buttons: 0, clickCount: 1 });
   const panMoved = await evaluate(`(() => {const v=document.querySelector('#mosaic-preview').closest('.canvas-viewport');return v.scrollLeft>window.__panBefore.x&&v.scrollTop>window.__panBefore.y})()`);
   if (!panMoved) throw new Error('Mouse drag did not pan the mosaic viewer');
   await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
   const touchViewport = await evaluate(`(() => {document.querySelector('#zoom-fit').click();document.querySelector('#preview-area').scrollIntoView({block:'start'});const viewport=document.querySelector('#mosaic-preview').closest('.canvas-viewport');const fitAction=getComputedStyle(viewport).touchAction;document.querySelector('#zoom-one').click();const rect=viewport.getBoundingClientRect();return {fitAction,zoomedAction:getComputedStyle(viewport).touchAction,x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`);
   if (touchViewport.fitAction !== 'pan-y' || touchViewport.zoomedAction !== 'none') throw new Error(`Touch gestures are not configured for fit and zoomed previews: ${JSON.stringify(touchViewport)}`);
   await evaluate(`(() => {const viewport=document.querySelector('#mosaic-preview').closest('.canvas-viewport');window.__touchPanBefore={x:viewport.scrollLeft,y:viewport.scrollTop}})()`);
   await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: touchViewport.x, y: touchViewport.y, radiusX: 2, radiusY: 2, force: 1 }] });
   await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: touchViewport.x - 60, y: touchViewport.y - 40, radiusX: 2, radiusY: 2, force: 1 }] });
   await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
   const touchPanMoved = await evaluate(`(() => {const viewport=document.querySelector('#mosaic-preview').closest('.canvas-viewport');return viewport.scrollLeft>window.__touchPanBefore.x&&viewport.scrollTop>window.__touchPanBefore.y})()`);
   if (!touchPanMoved) throw new Error('Touch drag did not pan the zoomed mosaic preview');
   await evaluate('window.scrollTo(0,0)');
   await command('Emulation.clearDeviceMetricsOverride');
   console.log(`touch preview passed: fit=${touchViewport.fitAction}, zoomed=${touchViewport.zoomedAction}, pan=${touchPanMoved}`);
   await evaluate('document.querySelector("#zoom-fit").click()');
  const initialBytes = await evaluate('Number(document.querySelector("#output-size").dataset.bytes)');
  // Drag rapidly in both directions; the final quality and the cached download
  // must agree, and older asynchronous previews may not overwrite the last one.
  await evaluate(`(() => {const input=document.querySelector('#jpg-quality');for(const value of [60,80,65]){input.value=value;input.dispatchEvent(new Event('input'))}})()`);
  await waitFor('document.querySelector("#output-size").dataset.quality === "65" && document.querySelector("#result-summary").textContent.includes("还原验证通过")');
  const adjustedBytes = await evaluate('Number(document.querySelector("#output-size").dataset.bytes)');
  if (!(adjustedBytes > 0 && adjustedBytes < initialBytes)) throw new Error(`JPG size did not update: ${initialBytes} => ${adjustedBytes}`);
  const downloadEnabled = await evaluate('!document.querySelector("#download-button").disabled');
  if (!downloadEnabled) throw new Error('Verified output should be downloadable');
  await evaluate('document.querySelector("#download-button").click()');
  const downloadStart = Date.now();
  while (!finishedDownloads.length && Date.now() - downloadStart < 20000) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!finishedDownloads.length) throw new Error('JPG download did not complete');
  const jpgPath = join(downloads, 'test-photo-obfuscated-q65.jpg');
  const jpegBytes = await readFile(jpgPath);
  if (jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8 || (await stat(jpgPath)).size !== adjustedBytes) throw new Error('Downloaded JPG does not match displayed byte count');
  const pngSize = await evaluate(`new Promise(resolve=>document.querySelector('#mosaic-preview').toBlob(blob=>resolve(blob.size),'image/png'))`);
  console.log(`JPG actual download: Q75 ${initialBytes} bytes => Q65 ${adjustedBytes} bytes; preview PNG ${pngSize} bytes; path=${jpgPath}`);
  await setInputFile('#encoded-file', jpgPath);
  await waitFor('document.querySelector("#encoded-meta").textContent.includes("test-photo-obfuscated-q65.jpg")');
  await evaluate('document.querySelector("#decode-button").click()');
  const restoredMessage = await waitFor('document.querySelector("#decode-message").textContent.includes("还原完成")');
  const restoredDimensions = await evaluate('({width: document.querySelector("#decode-preview").width, height: document.querySelector("#decode-preview").height})');
  if (restoredDimensions.width !== 1820 || restoredDimensions.height !== 1024) throw new Error(`Restored dimensions incorrect: ${JSON.stringify(restoredDimensions)}`);
  await evaluate('document.querySelector("[data-view=decode]").click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const decodePreview = await evaluate('({visible:document.querySelector("#decode-preview").getBoundingClientRect().width>0,stageWidth:document.querySelector("#decode-preview").style.width,canvasWidth:document.querySelector("#decode-preview").getBoundingClientRect().width})');
  if (!decodePreview.visible || !decodePreview.stageWidth || !decodePreview.canvasWidth) throw new Error(`Restored image is not visible in the decode view: ${JSON.stringify(decodePreview)}`);
  await screenshot('naiwa-browser-decode-restored.png');
  await evaluate('document.querySelector(".decode-preview [data-zoom=one]").click()');
  const decodeZoom = await evaluate('({oneToOne:Math.abs(document.querySelector("#decode-preview").getBoundingClientRect().width-document.querySelector("#decode-preview").width)<1,contained:document.documentElement.scrollWidth===innerWidth})');
  if (!decodeZoom.oneToOne || !decodeZoom.contained) throw new Error(`Restoration preview zoom failed: ${JSON.stringify(decodeZoom)}`);
  await evaluate('document.querySelector(".decode-preview [data-zoom=fit]").click(); document.querySelector("[data-view=encode]").click()');
  const transformScreenshot = await screenshot('naiwa-browser-transform.png');
  await evaluate('document.querySelector("#advanced-settings").open = true');
  await waitFor('!document.querySelector(".advanced-preview").hidden');
  await screenshot('naiwa-browser-advanced.png');
  await evaluate('document.querySelector("#download-png").click()');
  const pngDownloadStart = Date.now();
  while (finishedDownloads.length < 2 && Date.now() - pngDownloadStart < 20000) await new Promise((resolve) => setTimeout(resolve, 100));
  if (finishedDownloads.length < 2) throw new Error('Advanced PNG download did not complete');
  const pngPath = join(downloads, 'test-photo-obfuscated.png');
  const rawPngBytes = (await stat(pngPath)).size;
  if (!(rawPngBytes > adjustedBytes)) throw new Error('Expected compressed JPG to be smaller than the raw PNG');
  const pngUrl = '/' + relative(fileURLToPath(new URL('../', import.meta.url)), pngPath).split(sep).join('/');
  const compressionComparison = await evaluate(`(async () => {
    const {restoreImage,imageSimilarity}=await import('./src/core.mjs');
    const png=await (await fetch(${JSON.stringify(pngUrl)})).blob();
    const bitmap=await createImageBitmap(png);
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
    const restored=await restoreImage({width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data});
    const source=document.querySelector('#source-preview');
    const sourcePixels=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
    const pngSSIM=imageSimilarity(sourcePixels,restored.data,source.width,source.height);
     const jpgSSIM=Number(document.querySelector('#restore-metrics').textContent.match(/评分 · ([0-9.]+)/)[1]);
    return {pngSSIM,jpgSSIM};
  })()`);
  if (Math.abs(compressionComparison.pngSSIM - compressionComparison.jpgSSIM) > 0.015) throw new Error(`Unexpected JPG restoration degradation: ${JSON.stringify(compressionComparison)}`);
  const jpegVerification = { quality: 65, jpgBytes: adjustedBytes, rawPngBytes, jpgToPngRatio: adjustedBytes / rawPngBytes, ...compressionComparison };
  await writeFile(join(temporaryRoot, 'jpg-verification.json'), JSON.stringify(jpegVerification, null, 2));
  console.log(`JPG vs raw PNG: ${JSON.stringify(jpegVerification)}`);
  await evaluate('document.querySelector("#advanced-settings").open = false');
  await waitFor('document.querySelector(".advanced-preview").hidden');
  await evaluate('document.querySelector("#balance").value=100; document.querySelector("#balance").dispatchEvent(new Event("input"))');
     await waitFor('document.querySelector("#applied-options").textContent.includes("保留 25%") && document.querySelector("#balance-value").value === "混淆图更像预设" && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);
   const presetPriority = await evaluate('({outline:Number(document.querySelector("#preset-score").textContent.match(/轮廓 ([0-9.]+)/)[1]),restored:Number(document.querySelector("#restore-metrics").textContent.match(/评分 · ([0-9.]+)/)[1])})');
  await evaluate('document.querySelector("#balance").value=0; document.querySelector("#balance").dispatchEvent(new Event("input"))');
   await waitFor('document.querySelector("#applied-options").textContent.includes("保留 100%") && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);
   const priorityScores = await evaluate('({restored:Number(document.querySelector("#restore-metrics").textContent.match(/评分 · ([0-9.]+)/)[1]),preset:Number(document.querySelector("#preset-score").textContent.match(/轮廓 ([0-9.]+)/)[1])})');
  const qualityPriorityScore = priorityScores.restored;
  if (qualityPriorityScore <= 0.90 || qualityPriorityScore <= presetPriority.restored) throw new Error(`Quality preference did not improve restoration quality: ${JSON.stringify({ presetPriority, qualityPriorityScore })}`);
  if (presetPriority.outline <= priorityScores.preset) throw new Error(`Preset preference did not improve the mixed image resemblance: ${presetPriority.outline} -> ${priorityScores.preset}`);
  console.log(`preference endpoints: quality-first SSIM ${qualityPriorityScore} vs preset-first ${presetPriority.restored}; preset-first outline ${presetPriority.outline} vs quality-first ${priorityScores.preset}`);
  // Benchmark the standard balanced profile after checking automatic re-generation.
  await evaluate('document.querySelector("#balance").value=50; document.querySelector("#balance").dispatchEvent(new Event("input"))');
   await waitFor('document.querySelector("#applied-options").textContent.includes("8 px 图块") && document.querySelector("#applied-options").textContent.includes("保留 50%") && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);

  const makeFixture = async (name, width, height, transparent = false) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      data.set([40 + x / width * 180, 50 + y / height * 160, 140 + Math.sin(x / 35) * 50, transparent && x < width / 4 ? 0 : 255], (y * width + x) * 4);
    }
    const path = join(temporaryRoot, name);
    await writeFile(path, await png({ width, height, data }, Math.max(width, height)));
    return path;
  };
  const largePath = await makeFixture('large-source.png', 4000, 2000);
  await setInputFile('#source-file', largePath);
  await waitFor('document.querySelector("#source-preview").width === 2960 && document.querySelector("#source-preview").height === 1480');
  await evaluate(`document.querySelector('#auto-resize').checked=false;document.querySelector('#auto-resize').dispatchEvent(new Event('change'));document.querySelector('#source-scale').value=50;document.querySelector('#source-scale').dispatchEvent(new Event('change'))`);
  await waitFor('document.querySelector("#source-preview").width === 2000 && document.querySelector("#source-preview").height === 1000');
  await evaluate(`document.querySelector('#auto-resize').checked=true;document.querySelector('#auto-resize').dispatchEvent(new Event('change'))`);
  await waitFor('document.querySelector("#source-preview").width === 2960');
  const smallPath = await makeFixture('small-source.png', 160, 100);
  await setInputFile('#source-file', smallPath);
  await waitFor('document.querySelector("#source-preview").width === 1638 && document.querySelector("#source-preview").height === 1024');
  const customPath = await makeFixture('custom-transparent.png', 128, 128, true);
  await setInputFile('#custom-preset-file', customPath);
   await waitFor('document.querySelectorAll(".preset-option").length === 7 && document.querySelectorAll(".preset-option")[6].getAttribute("aria-checked") === "true"');
  await evaluate('document.querySelector("#encode-button").click()');
  await waitFor('document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);
  const transparentPadding = await evaluate('document.querySelector("#target-preview").getContext("2d").getImageData(0,0,1,1).data[3]');
  if (transparentPadding !== 0) throw new Error('Preset padding must retain transparent alpha');
  await setInputFile('#custom-preset-file', customPath);
  await waitFor('document.querySelector("#toast").textContent.includes("已经在")');
   if (await evaluate('document.querySelectorAll(".preset-option").length') !== 7) throw new Error('Duplicate preset was saved twice');
  await command('Page.reload', { ignoreCache: true });
   await waitFor('document.querySelectorAll(".preset-option").length === 7 && !document.querySelector("#custom-preset-picker").disabled && document.querySelectorAll(".preset-option")[6].getAttribute("aria-checked") === "true"');
  if (!await evaluate(`document.querySelector('#custom-preset-hint').textContent.includes('已保存在')`)) throw new Error('Custom preset was not restored from local storage');
  await evaluate('document.querySelector(".preset-remove").click()');
   await waitFor('document.querySelectorAll(".preset-option").length === 6 && document.querySelector(".toast-action")');
  await evaluate('document.querySelector(".toast-action").click()');
   await waitFor('document.querySelectorAll(".preset-option").length === 7 && document.querySelectorAll(".preset-option")[6].getAttribute("aria-checked") === "true"');
  await command('Page.reload', { ignoreCache: true });
   await waitFor('document.querySelectorAll(".preset-option").length === 7 && !document.querySelector("#custom-preset-picker").disabled');
  console.log('preset persistence passed: saved, deduplicated, restored after reload, removed, undo saved and survived another reload');
  await setInputFile('#source-file', smallPath);
  await waitFor('document.querySelector("#source-preview").width === 1638');
  await evaluate(`document.querySelector('#advanced-settings').open=true;document.querySelector('#auto-carrier').checked=false;document.querySelector('#auto-carrier').dispatchEvent(new Event('change'));document.querySelector('#carrier-scale').value='3';document.querySelector('#carrier-scale').dispatchEvent(new Event('input'));document.querySelector('#manual-parameters').checked=true;document.querySelector('#manual-parameters').dispatchEvent(new Event('change'));document.querySelector('#tile-size').value='4';document.querySelector('#tile-size').dispatchEvent(new Event('input'));document.querySelector('#encode-button').click()`);
   await waitFor('document.querySelector("#applied-options").textContent.includes("4 px 图块") && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);
  const fineDimensions = await evaluate('({width:document.querySelector("#mosaic-preview").width,height:document.querySelector("#mosaic-preview").height})');
  if (fineDimensions.width !== 4920 || fineDimensions.height !== 3072) throw new Error(`Incorrect 4px / 3x dimensions: ${JSON.stringify(fineDimensions)}`);
  await evaluate('document.querySelector("#download-button").click()');
  const fineDownloadStart = Date.now();
  while (finishedDownloads.length < 3 && Date.now() - fineDownloadStart < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  if (finishedDownloads.length < 3) throw new Error('Fine-tile JPG did not download');
  const fineJpgPath = join(downloads, 'small-source-obfuscated-q75.jpg');
  await setInputFile('#encoded-file', fineJpgPath);
  await waitFor('document.querySelector("#encoded-meta").textContent.includes("q75")');
  await evaluate('document.querySelector("#decode-button").click()');
  await waitFor('document.querySelector("#decode-message").textContent.includes("还原完成")');
  if (!await evaluate('document.querySelector("#decode-preview").width === 1638 && document.querySelector("#decode-preview").height === 1024')) throw new Error('Fine-tile JPG restored to the wrong dimensions');
  await screenshot('naiwa-browser-fine-tiles.png');
  console.log(`4px / 3x JPG download and automatic restoration passed: ${JSON.stringify(fineDimensions)}`);
  await evaluate(`document.querySelector('#auto-resize').checked=false;document.querySelector('#auto-resize').dispatchEvent(new Event('change'));document.querySelector('#source-scale').value=800;document.querySelector('#source-scale').dispatchEvent(new Event('change'));document.querySelector('#carrier-scale').value='4';document.querySelector('#carrier-scale').dispatchEvent(new Event('input'));document.querySelector('#jpg-quality').value=80;document.querySelector('#jpg-quality').dispatchEvent(new Event('input'))`);
   await waitFor('document.querySelector("#applied-options").textContent.includes("放大 4 倍") && document.querySelector("#output-size").dataset.quality === "80" && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);
  if (!await evaluate('document.querySelector("#mosaic-preview").width === 5120 && document.querySelector("#mosaic-preview").height === 3200')) throw new Error('Incorrect 4px / 4x carrier dimensions');
  await evaluate('document.querySelector("#download-button").click()');
  const scale4DownloadStart = Date.now();
  while (finishedDownloads.length < 4 && Date.now() - scale4DownloadStart < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  if (finishedDownloads.length < 4) throw new Error('4x carrier JPG did not download');
  await setInputFile('#encoded-file', join(downloads, 'small-source-obfuscated-q80.jpg'));
  await waitFor('document.querySelector("#encoded-meta").textContent.includes("q80")');
  await evaluate('document.querySelector("#decode-button").click()');
  await waitFor('document.querySelector("#decode-message").textContent.includes("还原完成")');
  if (!await evaluate('document.querySelector("#decode-preview").width === 1280 && document.querySelector("#decode-preview").height === 800')) throw new Error('4x carrier restored to the wrong source dimensions');
  console.log('4px / 4x JPG download and automatic restoration passed: 5120x3200 -> 1280x800');
  await command('Page.reload', { ignoreCache: true });
   await waitFor('document.querySelectorAll(".preset-option").length === 7 && !document.querySelector("#custom-preset-picker").disabled');
  const panoramaPath = await makeFixture('panorama-source.png', 1200, 160);
  await setInputFile('#source-file', panoramaPath);
  await waitFor('document.querySelector("#source-preview").width === 2960 && document.querySelector("#source-preview").height === 395');
  await evaluate('document.querySelector("#encode-button").click()');
  await waitFor('document.querySelector("#applied-options").textContent.includes("7 段") && document.querySelector("#result-summary").textContent.includes("还原验证通过")', 180000);
  await screenshot('naiwa-browser-panorama.png');
  console.log(`sizing and custom presets passed: large 4000x2000 -> 2960x1480; manual 50% -> 2000x1000; small 160x100 -> 1638x1024; panorama 1200x160 -> 2960x395, 7 panels, final JPG restored; padding alpha=${transparentPadding}`);
  await evaluate('document.querySelector(".preset-remove").click()');
   await waitFor('document.querySelectorAll(".preset-option").length === 6');
  await command('Page.reload', { ignoreCache: true });
   await waitFor('document.querySelectorAll(".preset-option").length === 6 && !document.querySelector("#custom-preset-picker").disabled');
  if (await evaluate('document.querySelectorAll(".preset-remove").length')) throw new Error('Deleted preset returned after reload');
  console.log('permanent preset deletion passed after reload');

  // Batch settings, worker cancellation, partial failure and archive downloads.
  await evaluate(`document.querySelector('#auto-resize').checked=false;document.querySelector('#auto-resize').dispatchEvent(new Event('change'))`);
  await setInputFile('#source-file', [inputFile, smallPath]);
  await waitFor(`document.querySelectorAll('#source-list .batch-item').length===2 && [...document.querySelectorAll('#source-list .batch-item')].every(row=>row.dataset.status==='idle')`);
  if (!await evaluate(`document.querySelector('#unify-settings').checked`)) throw new Error('Batch settings must default to unified');
  await evaluate(`document.querySelector('#jpg-quality').value=85;document.querySelector('#jpg-quality').dispatchEvent(new Event('input'));document.querySelectorAll('#source-list .batch-select')[1].click()`);
  if (!await evaluate(`document.querySelector('#jpg-quality').value==='85'`)) throw new Error('Unified quality did not reach every entry');
  await evaluate(`document.querySelector('.preset-option[data-index="1"]').click();document.querySelectorAll('#source-list .batch-select')[0].click()`);
  if (!await evaluate(`document.querySelector('.preset-option[data-index="1"]').getAttribute('aria-checked')==='true'`)) throw new Error('Unified preset did not reach every entry');
  await evaluate(`document.querySelector('#unify-settings').checked=false;document.querySelector('#unify-settings').dispatchEvent(new Event('change'));document.querySelectorAll('#source-list .batch-select')[1].click();document.querySelector('#jpg-quality').value=80;document.querySelector('#jpg-quality').dispatchEvent(new Event('input'));document.querySelector('#tile-size').value=16;document.querySelector('#tile-size').dispatchEvent(new Event('input'));document.querySelector('.preset-option[data-index="2"]').click();document.querySelectorAll('#source-list .batch-select')[0].click()`);
  if (!await evaluate(`document.querySelector('#jpg-quality').value==='85'&&document.querySelector('#tile-size').value==='8'&&document.querySelector('.preset-option[data-index="1"]').getAttribute('aria-checked')==='true'`)) throw new Error('Independent settings leaked into another entry');
  await evaluate(`document.querySelector('#encode-button').click()`);
  await waitFor(`document.querySelector('#source-list .batch-item[data-status="processing"] .progress-ring[aria-valuenow]')`);
  await evaluate(`for(const value of [75,90]){document.querySelector('#jpg-quality').value=value;document.querySelector('#jpg-quality').dispatchEvent(new Event('input'))}`);
  await waitFor(`document.querySelectorAll('#source-list .batch-item[data-status="done"]').length===2&&document.querySelector('#output-size').dataset.quality==='90'&&document.querySelector('#result-summary').textContent.includes('还原验证通过')`);
  if (!await evaluate(`document.querySelector('#mosaic-preview').width===1280&&document.querySelector('#mosaic-preview').height===720`)) throw new Error('First batch entry has incorrect dimensions');
  await evaluate(`document.querySelectorAll('#source-list .batch-select')[1].click()`);
  await waitFor(`document.querySelector('#output-size').dataset.quality==='80'&&document.querySelector('#mosaic-preview').width===160&&document.querySelector('#result-summary').textContent.includes('还原验证通过')`);
  if (!await evaluate(`document.querySelector('#tile-size').value==='16'&&document.querySelector('.preset-option[data-index="2"]').getAttribute('aria-checked')==='true'`)) throw new Error('Second batch entry lost its independent settings');
  for (const width of [320,390,768]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    if (!await evaluate(`document.documentElement.scrollWidth<=innerWidth`)) throw new Error(`Batch encode layout overflows at ${width}`);
  }
  await screenshot('naiwa-browser-batch-mobile.png');
  await command('Emulation.clearDeviceMetricsOverride');
  const beforeBatchDownloads = finishedDownloads.length;
  await evaluate(`document.querySelectorAll('#source-list .batch-download').forEach(button=>button.click());document.querySelector('#download-all-encoded').click()`);
  await waitFor(`!document.querySelector('#download-all-encoded').disabled`);
  const batchDownloadStart = Date.now();
  while (finishedDownloads.length < beforeBatchDownloads + 3 && Date.now() - batchDownloadStart < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  if (finishedDownloads.length < beforeBatchDownloads + 3) throw new Error('Batch JPG/ZIP downloads did not complete');
  function inspectZip(bytes) {
    let offset = 0; const files = [];
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
      const size = bytes.readUInt32LE(offset + 18); const length = bytes.readUInt16LE(offset + 26); const extra = bytes.readUInt16LE(offset + 28);
      const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8'); const start = offset + 30 + length + extra;
      files.push({ name, data: bytes.subarray(start, start + size) }); offset = start + size;
    }
    if (bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50) throw new Error('ZIP directory is invalid');
    return files;
  }
  const encodedArchive = inspectZip(await readFile(join(downloads, 'naiwa-obfuscated.zip')));
  if (encodedArchive.length !== 2) throw new Error('Batch archive must contain two JPG files');
  for (const item of encodedArchive) if (!item.data.equals(await readFile(join(downloads, item.name)))) throw new Error('ZIP content differs from per-entry JPG');
  await setInputFile('#encoded-file', [join(downloads, 'test-photo-obfuscated-q90.jpg'), join(downloads, 'small-source-obfuscated-q80.jpg'), inputFile]);
  await waitFor(`document.querySelectorAll('#decode-list .batch-item[data-status="idle"]').length===3`);
  await evaluate(`document.querySelector('[data-view="decode"]').click();document.querySelector('#decode-button').click()`);
  await waitFor(`document.querySelectorAll('#decode-list .batch-item[data-status="done"]').length===2&&document.querySelectorAll('#decode-list .batch-item[data-status="error"]').length===1`);
  await evaluate(`document.querySelectorAll('#decode-list .batch-select')[0].click()`);
  await waitFor(`document.querySelector('#decode-preview').width===640&&document.querySelector('#decode-preview').height===360&&document.querySelector('#decode-message').textContent.includes('还原完成')`);
  await evaluate(`document.querySelectorAll('#decode-list .batch-select')[1].click()`);
  await waitFor(`document.querySelector('#decode-preview').width===160&&document.querySelector('#decode-preview').height===100&&document.querySelector('#decode-message').textContent.includes('还原完成')`);
  const beforeRestoreDownloads = finishedDownloads.length;
  await evaluate(`document.querySelector('#download-restored').click();document.querySelector('#download-all-restored').click()`);
  const restoreDownloadStart = Date.now();
  while (finishedDownloads.length < beforeRestoreDownloads + 2 && Date.now() - restoreDownloadStart < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  const restoredArchive = inspectZip(await readFile(join(downloads, 'naiwa-restored.zip')));
  if (restoredArchive.length !== 2 || restoredArchive.some(item => item.data.readUInt32BE(0) !== 0x89504e47)) throw new Error('Restored archive must contain only successful PNGs');
  const independentPNG = await readFile(join(downloads, 'small-source-obfuscated-q80-restored.png'));
  if (!restoredArchive.find(item => item.name === 'small-source-obfuscated-q80-restored.png')?.data.equals(independentPNG)) throw new Error('Restored ZIP does not match individual download');
  for (const width of [320,390,768]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    if (!await evaluate(`document.documentElement.scrollWidth<=innerWidth`)) throw new Error(`Batch restore layout overflows at ${width}`);
  }
  await screenshot('naiwa-browser-batch-restore-mobile.png');
  await command('Emulation.clearDeviceMetricsOverride');
  await evaluate(`document.querySelector('[data-view="encode"]').click();document.querySelector('#encode-button').click();document.querySelectorAll('#source-list .batch-remove')[1].click()`);
  await waitFor(`document.querySelectorAll('#source-list .batch-item').length===1&&document.querySelector('#source-list .batch-item').dataset.status==='done'`);
  await evaluate(`document.querySelector('#unify-settings').checked=true;document.querySelector('#unify-settings').dispatchEvent(new Event('change'))`);
  await setInputFile('#source-file', smallPath, true);
  await waitFor(`document.querySelectorAll('#source-list .batch-item[data-status="idle"]').length===1`);
  await evaluate(`document.querySelectorAll('#source-list .batch-select')[1].click()`);
  if (!await evaluate(`document.querySelector('#jpg-quality').value==='90'&&document.querySelector('#tile-size').value==='8'`)) throw new Error('New entry did not inherit unified settings');
  await evaluate(`document.querySelectorAll('#source-list .batch-select')[0].click();document.querySelector('#jpg-quality').value=88;document.querySelector('#jpg-quality').dispatchEvent(new Event('input'));document.querySelectorAll('#source-list .batch-select')[1].click()`);
  if (!await evaluate(`document.querySelector('#jpg-quality').value==='88'`)) throw new Error('Re-enabling unified settings did not synchronize the batch');
  await evaluate(`document.querySelectorAll('#source-list .batch-remove').forEach(button=>button.click());document.querySelectorAll('#decode-list .batch-remove').forEach(button=>button.click())`);
  if (!await evaluate(`document.querySelector('#encode-button').disabled&&document.querySelector('#decode-button').disabled&&document.querySelector('#preview-area').hidden`)) throw new Error('Removing the final batch entry did not reset the view');
  console.log('batch passed: unified/independent presets and settings, cancellation, progress, previews, single downloads, JPG/PNG ZIPs, partial failure and 320/390/768px layouts');

  const gifInput = fileURLToPath(new URL('./fixtures/animated/2.gif', import.meta.url));
  const gifOriginal = await readFile(gifInput); const beforeGifDownload = finishedDownloads.length;
  await setInputFile('#source-file', gifInput);
  await waitFor(`document.querySelector('#source-list .batch-item')?.dataset.status==='idle'&&document.querySelector('#source-meta').textContent.includes('2.gif')`);
  await evaluate(`document.querySelector('.preset-option[data-index="4"]').click();document.querySelector('#advanced-settings').open=true;document.querySelector('#encode-button').click()`);
  await waitFor(`document.querySelector('#result-summary').textContent.includes('原图可完整还原')`, 240000);
  const gifMetrics = await evaluate(`({summary:document.querySelector('#result-summary').textContent,preset:document.querySelector('#preset-score').textContent,dimensions:document.querySelector('#mosaic-preview').width+'x'+document.querySelector('#mosaic-preview').height,animated:!!document.querySelector('[data-panel="mosaic"] .preview-animation:not([hidden])')&&document.querySelector('[data-panel="mosaic"] .preview-animation').naturalWidth>0,animatedDimensions:document.querySelector('[data-panel="mosaic"] .preview-animation')?.naturalWidth+'x'+document.querySelector('[data-panel="mosaic"] .preview-animation')?.naturalHeight,qualityDisabled:document.querySelector('#jpg-quality').disabled,carrierDisabled:document.querySelector('#carrier-scale').disabled,bytes:Number(document.querySelector('#output-size').dataset.bytes)})`);
  const originalGif = parseGif(gifOriginal); const selectedGifPreset = parseGif(await readFile(fileURLToPath(new URL('../assets/images/animated/1.gif', import.meta.url)))); const gifDownload = Date.now();
  await evaluate(`document.querySelector('#download-button').click()`);
  while (finishedDownloads.length < beforeGifDownload + 1 && Date.now() - gifDownload < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  if (finishedDownloads.length < beforeGifDownload + 1) throw new Error('Obfuscated GIF download did not complete');
  const gifOutputPath = join(downloads, '2-obfuscated.gif'); const gifOutput = await readFile(gifOutputPath); const encodedGif = parseGif(gifOutput);
  const presetScore = Number(gifMetrics.preset.match(/轮廓 ([0-9.]+)/)?.[1]);
  const followsGifPreset = encodedGif.duration === selectedGifPreset.duration && encodedGif.loop === selectedGifPreset.loop;
  if (!gifMetrics.animated || !gifMetrics.qualityDisabled || !gifMetrics.carrierDisabled || !followsGifPreset || gifMetrics.dimensions !== `${encodedGif.width}x${encodedGif.height}` || gifMetrics.animatedDimensions !== gifMetrics.dimensions || encodedGif.frames.length !== originalGif.frames.length || encodedGif.frames.length !== 50 || !(presetScore >= 0.5)) throw new Error(`GIF frame alignment, preset timing, preview or similarity failed: ${JSON.stringify({ ...gifMetrics, followsGifPreset, outputDuration: encodedGif.duration, targetDuration: selectedGifPreset.duration, outputLoop: encodedGif.loop, targetLoop: selectedGifPreset.loop })}`);
  if (gifMetrics.bytes !== gifOutput.length || gifOutput.length > gifOriginal.length * 3) throw new Error(`GIF output size exceeded the 3x budget or displayed size differed: ${JSON.stringify({ metrics: gifMetrics, actual: gifOutput.length, input: gifOriginal.length })}`);
  await setInputFile('#encoded-file', gifOutputPath);
  await waitFor(`document.querySelector('#decode-list .batch-item')?.dataset.status==='idle'`);
  await evaluate(`document.querySelector('[data-view="decode"]').click();document.querySelector('#decode-button').click()`);
  await waitFor(`document.querySelector('#decode-message').textContent.includes('GIF')&&document.querySelector('#decode-message').textContent.includes('完整还原')`);
  const beforeRestoredGifDownload = finishedDownloads.length; await evaluate(`document.querySelector('#download-restored').click()`);
  const restoredGifDeadline = Date.now();
  while (finishedDownloads.length < beforeRestoredGifDownload + 1 && Date.now() - restoredGifDeadline < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  const restoredGif = await readFile(join(downloads, '2-obfuscated-restored.gif'));
  if (!restoredGif.equals(gifOriginal)) throw new Error('Restored GIF bytes differ from the uploaded original');
  console.log(`GIF encode/restore passed: ${JSON.stringify({ ...gifMetrics, inputBytes: gifOriginal.length, actualBytes: gifOutput.length, ratio: Number((gifOutput.length / gifOriginal.length).toFixed(2)), frames: encodedGif.frames.length, exactRestore: restoredGif.equals(gifOriginal) })}`);
  await evaluate(`document.querySelector('.preset-option[data-index="0"]').click();document.querySelector('#encode-button').click()`);
  await waitFor(`document.querySelector('#preset-score').textContent.includes('共 1 帧')&&document.querySelector('#result-summary').textContent.includes('原图可完整还原')`, 240000);
  if (!await evaluate(`document.querySelector('#preset-score').textContent.includes('逐帧平均')`)) throw new Error('GIF encoding with a static preset failed');
  const staticTiming = await evaluate(`(async()=>{const image=document.querySelector('[data-panel="mosaic"] .preview-animation');const {parseGif}=await import('./src/gif-codec.mjs');const gif=parseGif(new Uint8Array(await (await fetch(image.src)).arrayBuffer()));return {duration:gif.duration,loop:gif.loop,frames:gif.frames.length}})()`);
  if (staticTiming.duration !== originalGif.duration || staticTiming.loop !== originalGif.loop) throw new Error(`Static preset should preserve source animation timing and loop behavior: ${JSON.stringify(staticTiming)}`);
  console.log('GIF encoding with a static image preset passed');
  const gifSamples = [];
  for (const [sample, preset] of [['1.gif', 5], ['3.gif', 4]]) {
    const inputPath = fileURLToPath(new URL(`./fixtures/animated/${sample}`, import.meta.url));
    const inputBytes = await readFile(inputPath); const sourceGif = parseGif(inputBytes); const beforeDownload = finishedDownloads.length;
    await setInputFile('#source-file', inputPath);
    await waitFor(`document.querySelector('#source-list .batch-item')?.dataset.status==='idle'&&document.querySelector('#source-meta').textContent.includes('${sample}')`);
    await evaluate(`document.querySelector('.preset-option[data-index="${preset}"]').click();document.querySelector('#encode-button').click()`);
    await waitFor(`document.querySelector('#result-summary').textContent.includes('原图可完整还原')`, 240000);
    const resultMetrics = await evaluate(`({preset:document.querySelector('#preset-score').textContent,bytes:Number(document.querySelector('#output-size').dataset.bytes),frames:Number(document.querySelector('#result-summary').textContent.match(/GIF (\\d+) 帧/)[1])})`);
    await evaluate(`document.querySelector('#download-button').click()`);
    const downloadDeadline = Date.now();
    while (finishedDownloads.length < beforeDownload + 1 && Date.now() - downloadDeadline < 20000) await new Promise(resolve => setTimeout(resolve, 100));
    const outputPath = join(downloads, `${sample.replace('.gif', '')}-obfuscated.gif`); const outputBytes = await readFile(outputPath); const outputGif = parseGif(outputBytes);
    const outline = Number(resultMetrics.preset.match(/轮廓 ([0-9.]+)/)?.[1]); const ratio = outputBytes.length / inputBytes.length;
    const targetPath = fileURLToPath(new URL(`../assets/images/animated/${preset === 4 ? '1' : '2'}.gif`, import.meta.url));
    const targetGif = parseGif(await readFile(targetPath));
    const followsPreset = outputGif.duration === targetGif.duration && outputGif.loop === targetGif.loop;
    if (outputGif.frames.length !== sourceGif.frames.length || !followsPreset || resultMetrics.frames !== sourceGif.frames.length || resultMetrics.bytes !== outputBytes.length || ratio > 3 || outline < 0.5) {
      throw new Error(`GIF sample ${sample} exceeded quality, preset timing, frame or size limits: ${JSON.stringify({ ...resultMetrics, actualBytes: outputBytes.length, inputBytes: inputBytes.length, ratio, outline, followsPreset, outputDuration: outputGif.duration, targetDuration: targetGif.duration })}`);
    }
    gifSamples.push({ sample, frames: outputGif.frames.length, inputBytes: inputBytes.length, outputBytes: outputBytes.length, ratio: Number(ratio.toFixed(2)), outline, duration: outputGif.duration, presetDuration: targetGif.duration });
  }
  console.log(`additional GIF samples passed: ${JSON.stringify(gifSamples)}`);

  const staticOriginal = await readFile(smallPath); const beforeStillGifDownload = finishedDownloads.length;
  await setInputFile('#source-file', smallPath);
  await waitFor(`document.querySelector('#source-list .batch-item')?.dataset.status==='idle'&&document.querySelector('#source-meta').textContent.includes('small-source.png')`);
  await evaluate(`document.querySelector('.preset-option[data-index="4"]').click();document.querySelector('#balance').value=100;document.querySelector('#balance').dispatchEvent(new Event('input'));document.querySelector('#tile-size').value=2;document.querySelector('#tile-size').dispatchEvent(new Event('input'));document.querySelector('#encode-button').click()`);
  await waitFor(`document.querySelector('#result-summary').textContent.includes('GIF 100 帧')&&document.querySelector('#result-summary').textContent.includes('原图可完整还原')`, 240000);
  const stillGifMetrics = await evaluate(`({preset:document.querySelector('#preset-score').textContent,options:document.querySelector('#applied-options').textContent,bytes:Number(document.querySelector('#output-size').dataset.bytes),animated:!!document.querySelector('[data-panel="mosaic"] .preview-animation:not([hidden])'),restored:document.querySelector('#restored-score').textContent})`);
  await evaluate(`document.querySelector('#download-button').click()`);
  const stillGifDownload = Date.now();
  while (finishedDownloads.length < beforeStillGifDownload + 1 && Date.now() - stillGifDownload < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  const stillGifPath = join(downloads, 'small-source-obfuscated.gif'); const stillGifBytes = await readFile(stillGifPath); const stillGif = parseGif(stillGifBytes);
  const stillPayload = embeddedImagePayload(stillGif); const targetStillGif = parseGif(await readFile(fileURLToPath(new URL('../assets/images/animated/1.gif', import.meta.url))));
  const stillPresetScore = Number(stillGifMetrics.preset.match(/轮廓 ([0-9.]+)/)?.[1]);
  if (stillPayload?.mime !== 'image/png' || !gunzipSync(stillPayload.compressed).equals(staticOriginal) || stillGif.duration !== targetStillGif.duration || stillGif.loop !== targetStillGif.loop || stillGif.frames.length !== targetStillGif.frames.length || !stillGifMetrics.animated || !stillGifMetrics.restored.includes('静态图') || !stillGifMetrics.options.includes('保留 25%') || stillPresetScore < 0.5) {
    throw new Error(`Static source to animated preset GIF failed: ${JSON.stringify({ ...stillGifMetrics, frames: stillGif.frames.length, duration: stillGif.duration, targetDuration: targetStillGif.duration, loop: stillGif.loop, targetLoop: targetStillGif.loop, mime: stillPayload?.mime })}`);
  }
  const beforeStillRestoreDownload = finishedDownloads.length;
  await setInputFile('#encoded-file', stillGifPath);
  await waitFor(`document.querySelector('#decode-list .batch-item')?.dataset.status==='idle'`);
  await evaluate(`document.querySelector('[data-view="decode"]').click();document.querySelector('#decode-button').click()`);
  await waitFor(`document.querySelector('#decode-message').textContent.includes('完整还原')`);
  await evaluate(`document.querySelector('#download-restored').click()`);
  const stillRestoreDeadline = Date.now();
  while (finishedDownloads.length < beforeStillRestoreDownload + 1 && Date.now() - stillRestoreDeadline < 20000) await new Promise(resolve => setTimeout(resolve, 100));
  const restoredStatic = await readFile(join(downloads, 'small-source-obfuscated-restored.png'));
  if (!restoredStatic.equals(staticOriginal)) throw new Error('Static image embedded in animated GIF did not restore byte-for-byte');
  console.log(`static source / animated preset passed: ${JSON.stringify({ ...stillGifMetrics, frames: stillGif.frames.length, originalBytes: staticOriginal.length, outputBytes: stillGifBytes.length, exactRestore: true })}`);

  if (process.argv.includes('--reports')) {
    await command('Page.navigate', { url: new URL('reports/compare.html', testUrl).href });
    await waitFor('document.querySelector("#selection")?.textContent.includes("当前条件下")');
    const reportState = await evaluate('({ rows: document.querySelectorAll("#rows tr").length, text: document.querySelector("#selection").textContent })');
    if (reportState.rows !== 32) throw new Error(`Expected 32 report rows: ${JSON.stringify(reportState)}`);
    if (!reportState.text.includes('8 px 图块 · 放大 2 倍 · 保留 75% 原图细节')) throw new Error(`Report settings are not shown in plain language: ${JSON.stringify(reportState)}`);
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
  await command('Page.reload', { ignoreCache: true });
  await waitFor('document.querySelectorAll(".preset-option").length === 6 && !document.querySelector("#custom-preset-picker").disabled');
  await evaluate(`document.querySelector('.preset-option[data-index="0"]').click()`);
  const resetStaticDefaults = await evaluate(`({balance:document.querySelector('#balance').value,tileSize:document.querySelector('#tile-size').value})`);
  if (resetStaticDefaults.balance !== '50' || resetStaticDefaults.tileSize !== '8') throw new Error(`Reloaded static defaults are incorrect: ${JSON.stringify(resetStaticDefaults)}`);
  await setInputFile('#source-file', gifInput);
  const gifSourceDefaults = await waitFor(`document.querySelector('#source-meta').textContent.includes('2.gif') && document.querySelector('#balance').value === '100' && document.querySelector('#tile-size').value === '2'`);
  if (!gifSourceDefaults) throw new Error('GIF source with a static preset must default to 2px / preset-focused');
  if (pageErrors.length) throw new Error(`Browser runtime errors: ${pageErrors.join(' | ')}`);

  console.log(`browser smoke passed: ${encodedSummary}; ${restoredMessage}; zoom=${JSON.stringify(zoomBehavior)}; profiles=${profile}`);
  console.log(`screenshots: ${transformScreenshot}`);
} finally {
  socket.close();
  await new Promise(resolve => {
    const cleanup = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    cleanup.once('error', resolve); cleanup.once('exit', resolve);
  });
}
