/** Controlled delayed HTTP response proves the export network gate allows a
 * bounded card job beyond 30s. This is not Python execution/performance proof. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { PNG } from 'pngjs';
import { openBakery, bakeFrames } from './export-frames.mjs';

const root = process.cwd(), origin = 'http://127.0.0.1:5199';
const server = await createServer({ root, cacheDir: path.join(root, 'work/network-budget-vite-cache'),
  server: { host: '127.0.0.1', port: 5199, strictPort: true } });
const empty = { width: 32, height: 32, fps: 10, duration: 1, media: [], tracks: [] };
let bakery;
try {
  await server.listen();
  bakery = await openBakery({ url: origin+'/?export=1&timeline='+encodeURIComponent('data:application/json,'+encodeURIComponent(JSON.stringify(empty))) });
  await bakery.page.setRequestInterception(true);
  let delayed = false;
  bakery.page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/card-runtime/visual') { void request.continue(); return; }
    void (async () => {
      if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 35000)); }
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ registered: true, revision: 'controlled-delay',
        value: { type: 'draw', commands: [{ type: 'solid', color: [1,0,0,1] }] } }) });
    })().catch(error => console.error('Intercepted card response failed:', error.message));
  });
  const project = { ...empty,
    cardDefinitions: [{ id:'delay',language:'python',entry:'Card',source:'class Card: pass',kind:'animation',need_prerendering:false,compositing:'independent' }],
    cardNodes: [{ id:'node',adapter:'python',definitionId:'delay',inputs:{} }],
    tracks: [{ id:'main',clips:[{ id:'clip',nodeId:'node',start:0,end:1,params:{} }] }] };
  await bakery.loadProject(project, { deferCards: true });
  const start = performance.now(); let output;
  await bakeFrames(bakery, { out:path.join(root,'work/network-budget'),targetFrames:[0],fullFrame:true,writeFrames:false,onFrame:(_frame,png)=>{output=png;} });
  const elapsedMs = performance.now()-start;
  assert.ok(delayed && elapsedMs >= 35000, `Card delay was not exercised: ${elapsedMs}`);
  const png = PNG.sync.read(output), offset=(16*png.width+16)*4;
  assert.deepEqual([...png.data.subarray(offset,offset+4)],[255,0,0,255]);
  console.log('PASS delayed card network budget',JSON.stringify({delayMs:35000,elapsedMs,rgba:[255,0,0,255]}));
} finally { await bakery?.close(); await server.close(); }
