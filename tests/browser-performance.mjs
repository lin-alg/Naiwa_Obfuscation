// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, execFileSync } from 'node:child_process';
import { writeFile, mkdtemp, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDirectory, artifactEnvironment } from './artifact-paths.mjs';

const directory = await artifactDirectory('performance');
if (process.argv.includes('--background')) {
  const output = await open(join(directory, 'browser-performance.log'), 'w'); const errors = await open(join(directory, 'browser-performance-error.log'), 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter(arg => arg !== '--background')], { detached: true, windowsHide: true, stdio: ['ignore', output.fd, errors.fd], env: artifactEnvironment(directory) });
  child.unref(); await output.close(); await errors.close(); console.log(`Performance PID ${child.pid}`); process.exit(0);
}
const revision = 'b5d2b4f';
for (const name of ['core.mjs', 'reed-solomon.mjs', 'engine-worker.mjs']) await writeFile(join(directory, name), execFileSync('git', ['show', `${revision}:${name}`]));
const profile = await mkdtemp(join(directory, 'chrome-'));
const browser = spawn(process.env.CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, `--crash-dumps-dir=${directory}`, 'http://127.0.0.1:4173/',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: artifactEnvironment(directory) });
let output = ''; browser.stderr.on('data', chunk => { output += chunk; });
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    port = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!port) throw new Error(output);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data); const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  async function evaluate(expression) {
    const next = ++id;
    const result = await new Promise((resolve, reject) => { pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(`location.origin==='http://127.0.0.1:4173'&&document.readyState==='complete'`)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await evaluate(`window.benchmark=async function(index){
    const {processingSize,processingOptions}=await import('./src/processing-settings.mjs');
    const settings={quality:75,balance:50,tileSize:8,autoResize:true,sourceScale:100,autoCarrier:true,carrierScale:2,manual:false,strength:16,fit:'contain',colorAdapt:true,colorGain:0.75};
    const file=await (await fetch('./tests/fixtures/static/'+index+'.jpg')).blob();
    const targetBlob=await (await fetch('./assets/images/static/%E5%A5%B6%E8%9B%99.png')).blob();
    async function read(blob,size){const bitmap=await createImageBitmap(blob);const dims=size?.(bitmap.width,bitmap.height)??bitmap;const canvas=document.createElement('canvas');canvas.width=dims.width;canvas.height=dims.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingQuality='high';ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();return {width:canvas.width,height:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data}}
    function canvas(image){const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').putImageData(new ImageData(image.data,image.width,image.height),0,0);return c}
    const target=await read(targetBlob);const source=await read(file,(w,h)=>processingSize(w,h,settings));
    async function run(url,payload){const worker=new Worker(url,{type:'module'});return new Promise((resolve,reject)=>{worker.onmessage=({data})=>{if(data.type==='progress')return;worker.terminate();if(data.type==='error')reject(new Error(data.message));else resolve(data.result)};worker.onerror=e=>{worker.terminate();reject(new Error(e.message))};worker.postMessage({id:'benchmark',...payload})})}
    const row={image:index,source:source.width+'x'+source.height};let jpg;
    let started=performance.now();
    const encoded=await run('./.test-artifacts/performance/engine-worker.mjs',{action:'encode',source,target,...processingOptions(settings)});
    const carrier={width:encoded.plan.outputWidth,height:encoded.plan.outputHeight,data:encoded.data};
    jpg=await new Promise(resolve=>canvas(carrier).toBlob(resolve,'image/jpeg',0.75));
    const compressed=await read(jpg);
    const verification=await run('./.test-artifacts/performance/engine-worker.mjs',{action:'verify',source:compressed,target:encoded.targetImage,original:source});
    row.baselineTotalMs=Math.round(performance.now()-started);row.baselineSSIM=verification.restoredSSIM;
    started=performance.now();await run('./.test-artifacts/performance/engine-worker.mjs',{action:'restore',source:compressed});row.baselineRestoreMs=Math.round(performance.now()-started);
    started=performance.now();const optimized=await run('./src/engine-worker.mjs',{action:'encode-file',file,settings,target});row.optimizedTotalMs=Math.round(performance.now()-started);row.optimizedSSIM=optimized.restoredSSIM;row.stages=optimized.timings;
    started=performance.now();await run('./src/engine-worker.mjs',{action:'restore-file',file:jpg});row.optimizedRestoreMs=Math.round(performance.now()-started);
    return row;
  }`);
  const rows = [];
  if (!process.argv.includes('--batch-only')) for (let index = 1; index <= 4; index += 1) { const row = await evaluate(`benchmark(${index})`); rows.push(row); console.log(JSON.stringify(row)); }
  const batch = await evaluate(`(async()=>{
    const {WorkerPool}=await import('./src/worker-pool.mjs');
    const {processingSize}=await import('./src/processing-settings.mjs');
    const settings={quality:75,balance:50,tileSize:8,autoResize:true,sourceScale:100,autoCarrier:true,carrierScale:2,manual:false,strength:16,fit:'contain',colorAdapt:true,colorGain:0.75};
    const bitmap=await createImageBitmap(await(await fetch('./assets/images/static/%E5%A5%B6%E8%9B%99.png')).blob());const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();const target={width:canvas.width,height:canvas.height,data:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data};
    const large=[];const medium=[];for(let index=1;index<=4;index++){const file=await(await fetch('./tests/fixtures/static/'+index+'.jpg')).blob();const image=await createImageBitmap(file);const size=processingSize(image.width,image.height,settings);large.push({payload:{action:'encode-file',file,target,settings,compactPreview:true},memory:size.width*size.height*(4*24+12)});const ratio=1536/Math.max(image.width,image.height);const small=new OffscreenCanvas(Math.round(image.width*ratio),Math.round(image.height*ratio));small.getContext('2d').drawImage(image,0,0,small.width,small.height);image.close();const resized=await small.convertToBlob();medium.push({payload:{action:'encode-file',file:resized,target,settings:{...settings,autoResize:false},compactPreview:true},memory:small.width*small.height*(4*24+12)});small.width=small.height=1}
    async function measure(jobs){const results={};for(const parallel of [false,true]){const pool=new WorkerPool(parallel?{}:{concurrency:1});let peak=0;const started=performance.now();await Promise.all(jobs.map(job=>pool.run(job.payload,{memory:job.memory,onProgress:()=>{peak=Math.max(peak,pool.slots.filter(slot=>slot.job).length)}})));results[parallel?'parallelMs':'sequentialMs']=Math.round(performance.now()-started);if(parallel){results.maxConcurrency=pool.concurrency;results.peakActive=peak}for(const slot of pool.slots)slot.worker.terminate()}return results}
    return {hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory,medium:await measure(medium),large:await measure(large)};
  })()`);
  console.log(JSON.stringify({ batch }));
  const result = { revision, rows, batch };
  await writeFile(join(directory, process.argv.includes('--batch-only') ? 'browser-batch-comparison.json' : 'browser-comparison.json'), JSON.stringify(result, null, 2));
} finally { socket?.close(); browser.kill(); }
