#!/usr/bin/env node
/**
 * Installed-app acceptance harness for Python cards.
 *
 * This deliberately does not start Vite, Chrome, an exporter, or a Python
 * runtime. It connects only to the desktop shell's already-running CDP target
 * and sends one real, non-mock /api/ai/chat request. The original project is
 * never opened for write: a byte-for-byte copy is made first and its hash is
 * checked again at the end.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer';

const usage = `Usage: node scripts/verify-installed-python-cards.mjs --exe <PromptCut.exe> --project <original.pcproj> --out <evidence-dir> [--origin http://127.0.0.1:5210] --cdp <port> --provider <agy|gemini|...>

The script never launches --exe. Start the installed desktop app yourself with
remote debugging enabled, open the printed project copy in its UI, then run it.
--verify-existing verifies saved tool events and the currently open project;
it sends no new Agent request and preserves any provider completion error.`;
const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, i, all) => {
  if (value.startsWith('--')) out.push([value.slice(2), !all[i+1] || all[i+1].startsWith('--') ? true : all[i + 1]]); return out;
}, []));
for (const key of ['exe', 'project', 'out']) if (!args[key]) throw new Error(`${usage}\nMissing --${key}`);
if (!args['prepare-only']) for (const key of ['cdp', 'provider']) if (!args[key]) throw new Error(`${usage}\nMissing --${key}`);
if (/^(mock|fake|test)$/i.test(args.provider)) throw new Error('Installed acceptance requires a configured non-mock provider');
const origin = args.origin || 'http://127.0.0.1:5210';
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const redact = value => JSON.parse(JSON.stringify(value, (key, item) => /key|token|secret|authorization|cookie|password/i.test(key) ? '[redacted]' : item));
const eventLog = [];
const output = path.resolve(args.out), original = path.resolve(args.project), exe = path.resolve(args.exe);
await fs.mkdir(output, { recursive: true });
await fs.access(exe); await fs.access(original);
const before = await hash(original);
const copy = args.copy ? path.resolve(args.copy) : path.join(output, `${path.basename(original, path.extname(original))}.acceptance-copy${path.extname(original)}`);
assert.notEqual(copy.toLowerCase(), original.toLowerCase(), 'Acceptance requires a separate project copy');
if (args.copy) await fs.access(copy); else await fs.copyFile(original, copy);
await fs.writeFile(path.join(output, args['verify-existing']?'verification-manifest.json':'manifest.json'), JSON.stringify({ original, copy, originalSha256Before: before, origin, cdp: Number(args.cdp), provider: args.provider, startedAt: new Date().toISOString() }, null, 2));
if (args['prepare-only']) { console.log(JSON.stringify({ ok: true, copy, originalSha256: before })); process.exit(0); }

let browser;
try {
// Shell check only: no browser launch fallback. Chrome's /json/version endpoint
// is public CDP metadata and contains no application configuration or secrets.
const version = await fetch(`http://127.0.0.1:${Number(args.cdp)}/json/version`, { signal: AbortSignal.timeout(5000) });
assert.ok(version.ok, `CDP shell endpoint unavailable on ${args.cdp}`);
browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${Number(args.cdp)}`, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(candidate => candidate.url().startsWith(origin)) || pages.find(candidate => !candidate.url().startsWith('devtools://'));
assert.ok(page, 'No desktop WebView2 page found through shell CDP');
const ui = await page.evaluate(async () => {
  const store = await import('/src/store/project.ts');
  const state = store.getState();
  return { url: location.href, title: document.title, ready: !!document.querySelector('#root'), filePath: state.filePath, projectId: state.project?.id };
});
assert.ok(ui.ready && await page.$('[data-pc="editor"]'), 'Connected page is not the PromptCut editor');
assert.equal(path.resolve(new URL(ui.url).searchParams.get('open') || ''), copy, 'The desktop launch URL must open the exact acceptance copy');
assert.equal(ui.filePath, path.basename(copy), 'The product must have completed opening the copy');
const inputDoc=JSON.parse(await fs.readFile(copy,'utf8'));
assert.equal(ui.projectId,inputDoc.project.id,'The editor did not load the real project');

function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find(row => row.startsWith('data: '));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* partial chunk */ }
  }
  return events;
}
const prompt = `Installed acceptance run ${randomUUID()}. The copied project is already open in the desktop UI. Create and apply two minimal Python card definitions: one gradual GLSL transition using two sources, and one visibly colored GLSL filter using a source. Read card_authoring_guide first. Make both visibly change frames within the first ten seconds, then call see_frames on each active time range after your final source edit. Use the documented SDK symbols; do not assume Python has a global clamp function. If a render fails, edit the same definition to fix it, without adding duplicate instances or replacing the gradual transition with a hard cut. Work in this conversation without messaging or delegating to other conversations. Use only actual project tools; finish with a concise terminal completion message and report any remaining render failure honestly.`;
if(args['verify-existing']) {
  eventLog.push(...JSON.parse(await fs.readFile(path.join(output,'chat-sse.redacted.json'),'utf8')));
} else {
const response = await fetch(`${origin}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ provider: args.provider, prompt, conversationId: `installed_${Date.now()}` }), signal: AbortSignal.timeout(12 * 60_000) });
assert.ok(response.ok, `/api/ai/chat failed: HTTP ${response.status}`);
const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  pending += decoder.decode(value, { stream: true });
  const cut = pending.lastIndexOf('\n\n');
  if (cut < 0) continue;
  const batch = parseSse(pending.slice(0, cut + 2)); pending = pending.slice(cut + 2);
  eventLog.push(...batch.map(redact));
  await fs.writeFile(path.join(output, 'chat-sse.redacted.json'), JSON.stringify(eventLog, null, 2));
  for (const event of batch) if (['tool_call','tool_result','error','done'].includes(event.type)) console.log(JSON.stringify({type:event.type,name:event.name,ok:event.ok,runId:event.runId,callId:event.callId,message:(event.message||event.summary)?.slice(0,1000)}));
}
eventLog.push(...parseSse(pending).map(redact));
await fs.writeFile(path.join(output, 'chat-sse.redacted.json'), JSON.stringify(eventLog, null, 2));
}
const calls = eventLog.filter(event => event.type === 'tool_call');
const names = calls.map(event => event.name);
const results = eventLog.filter(event => event.type === 'tool_result');
const successful = calls.filter(call => results.some(result => result.callId === call.callId && result.name === call.name && result.ok === true));
const terminal = eventLog.some(event => /^(done|terminal|complete)$/i.test(event.type || '') || event.done === true);
assert.ok(names.filter(name => /create.*card|save.*card/i.test(name)).length >= 2, `Expected two real create-card tool calls: ${names.join(', ')}`);
assert.ok(names.filter(name => /apply.*card/i.test(name)).length >= 2, `Expected two real apply-card tool calls: ${names.join(', ')}`);
assert.ok(names.some(name => /see.*frames/i.test(name)), `No real see_frames tool call: ${names.join(', ')}`);
assert.ok(successful.filter(call=>/create.*card|save.*card/i.test(call.name)).length>=2, 'Two card creations did not succeed');
assert.ok(successful.filter(call=>/apply.*card/i.test(call.name)).length>=2, 'Two card applications did not succeed');
assert.ok(successful.some(call=>/see.*frames/i.test(call.name)), 'Frame verification did not succeed');
const lastCardChange=Math.max(...successful.filter(call=>/apply.*card|edit.*card/i.test(call.name)).map(call=>eventLog.indexOf(call)));
assert.ok(successful.some(call=>/see.*frames/i.test(call.name)&&eventLog.indexOf(call)>lastCardChange),'No successful frame verification after the final card change');
const providerErrors=eventLog.filter(event=>event.type==='error').map(event=>event.message);
if(!args['verify-existing'])assert.deepEqual(providerErrors,[],'Agent reported an error');
assert.ok(terminal, 'SSE ended without a terminal completion event');

const authored=await page.evaluate(async()=>{const {getState}=await import('/src/store/project.ts');const s=getState();return {definitions:s.project.cardDefinitions,nodes:s.project.cardNodes,clips:s.project.tracks.flatMap(t=>t.clips),fps:s.project.fps};});
for(const kind of ['transition','filter'])assert.ok(authored.definitions?.some(d=>d.language==='python'&&d.kind===kind),`Agent did not create a Python ${kind}`);
// openProcPath deliberately opens a copy and remembers only its display name.
// Exercise the installed product's real draft-save entry point, including
// serializeProc/withFrameSnapshots and its persisted .proc backend.
const draftId='acceptance-'+Date.now();
await page.evaluate(async(id)=>{const io=await import('/src/editor/io/drafts.ts');await io.saveDraft(id);},draftId);
const savedResponse=await fetch(origin+'/api/projects/'+draftId);
assert.ok(savedResponse.ok,'Product draft save did not produce a readable project');
const savedText=await savedResponse.text(), savedDoc=JSON.parse(savedText);
await fs.writeFile(path.join(output,'saved-project.proc'),savedText);
assert.deepEqual(savedDoc.project.cardDefinitions,authored.definitions,'Actual product save did not preserve Python source');
assert.deepEqual(savedDoc.project.cardNodes,authored.nodes,'Actual product save did not preserve card instances');
// Open the saved draft through the normal Shell route and a new document.
await page.goto(origin+'/?draft='+draftId,{waitUntil:'domcontentloaded'});
await page.waitForFunction(async(expected)=>(await import('/src/editor/io/drafts.ts')).getActiveDraftId()===expected,{timeout:60000},draftId);
const reopened=await page.evaluate(async()=> (await import('/src/store/project.ts')).getState().project);
assert.deepEqual(reopened.cardDefinitions,authored.definitions,'Reopening changed card source');
const firstCustom=authored.clips.find(c=>c.nodeId&&authored.nodes?.some(n=>n.id===c.nodeId));
await page.evaluate(async(time)=>{const {actions}=await import('/src/store/project.ts');actions.seek(time);},firstCustom?.start||0);
await page.waitForFunction((frame)=>{const img=document.querySelector('.pc-pv[data-pc="preview"] img');return img?.complete&&img.naturalWidth>0&&new URL(img.src).pathname.endsWith('/'+String(frame).padStart(6,'0')+'.png');},{timeout:120000},Math.round((firstCustom?.start||0)*authored.fps));
await page.screenshot({path:path.join(output,'installed-preview.png')});

// Observe, never synthesize, ten seconds of actual preview playback. The UI
// may expose either a status attribute or a current timeline label; both are
// retained as evidence. A static/absent signal is an explicit failure.
async function measurePlayback(label) {
await page.evaluate(async(time)=>{(await import('/src/store/project.ts')).actions.seek(time);},firstCustom?.start||0);
const play = await page.$('button[title="播放"]');
assert.ok(play, 'Preview Play button not found');
await page.evaluate(async()=>{
  const {getState}=await import('/src/store/project.ts');
  window.__acceptanceFrames=[];
  const tick=at=>{const s=getState(),c=document.querySelector('.pc-pv[data-pc="preview"] canvas');
    if(s.playing)window.__acceptanceFrames.push({at,target:Math.round(s.t*s.project.fps),shown:Number(c?.dataset.frame??-1)});
    window.__acceptanceRaf=requestAnimationFrame(tick);
  };window.__acceptanceRaf=requestAnimationFrame(tick);
});
await play.click();
const samples = [];
for (let i = 0; i < 11; i++) {
  samples.push(await page.evaluate(() => { const head = document.querySelector('[data-pc="playhead"]'); const preview = document.querySelector('.pc-pv[data-pc="preview"]'); return {
    at: performance.now(), shownFrame: Number(preview?.querySelector('canvas')?.dataset.frame ?? -1), playheadLabel: head?.querySelector('.pc-tl-playhead-label')?.textContent || null,
    playheadLeft: head instanceof HTMLElement ? head.style.left : null, previewCanvas: !!preview?.querySelector('canvas'),
    preview: preview?.getAttribute('data-status') || null, dropped: preview?.getAttribute('data-dropped') || null }; }));
  if (i < 10) await new Promise(resolve => setTimeout(resolve, 1000));
}
await fs.writeFile(path.join(output, `${label}-playback-samples.json`), JSON.stringify(samples, null, 2));
assert.ok(new Set(samples.map(sample => `${sample.playheadLabel}:${sample.playheadLeft}`).filter(Boolean)).size > 1, 'Playback playhead did not advance for 10 seconds');
const pause = await page.$('button[title="暂停"]');
assert.ok(pause, 'Preview did not remain in playing state long enough to pause');
await pause.click();
const frameTrace=await page.evaluate(()=>{cancelAnimationFrame(window.__acceptanceRaf);return window.__acceptanceFrames;});
await fs.writeFile(path.join(output,`${label}-playback-frame-trace.json`),JSON.stringify(frameTrace));
const stableFrames=frameTrace.filter(x=>x.at-frameTrace[0].at>=2000),presentations=[];
for(const item of stableFrames)if(item.shown>=0&&item.shown!==presentations.at(-1)?.shown)presentations.push(item);
const measuredSeconds=stableFrames.length?(stableFrames.at(-1).at-stableFrames[0].at)/1000:0;
const metrics={seconds:measuredSeconds,distinctPresentedFrames:presentations.length,presentedFps:presentations.length/Math.max(.01,measuredSeconds),maxGapMs:Math.max(0,...presentations.slice(1).map((x,i)=>x.at-presentations[i].at)),blankFraction:stableFrames.filter(x=>x.shown<0).length/Math.max(1,stableFrames.length)};
await fs.writeFile(path.join(output,`${label}-playback-metrics.json`),JSON.stringify(metrics,null,2));
console.log('PLAYBACK',label,JSON.stringify(metrics));
return metrics;
}
const coldPlayback=await measurePlayback('cold');
// Produce every actual frame in the tested range through the installed frame
// API, without changing the project or fabricating/repeating captured samples.
// This separates renderer throughput from the completed-cache playback check.
const warmStarted=Date.now(), warmBatches=[];
const firstFrame=Math.round((firstCustom?.start||0)*authored.fps);
const lastFrame=Math.min(Math.floor(reopened.duration*authored.fps)-1,firstFrame+Math.ceil(12*authored.fps));
for(let frame=firstFrame;frame<=lastFrame;frame+=12){
  const times=Array.from({length:Math.min(12,lastFrame-frame+1)},(_,i)=>(frame+i)/authored.fps);
  const batchStarted=Date.now();
  const result=await page.evaluate(async(times)=>{const {getState}=await import('/src/store/project.ts');const {see_frames}=await import('/src/render/frameClient.ts');return see_frames(getState().project,times,undefined,{target:'user',lane:'agent'});},times);
  assert.equal(result.incomplete,false,'Warm-cache preparation returned placeholders');
  assert.equal(result.frames.length,times.length,'Warm-cache preparation omitted frames');
  warmBatches.push({frame,count:times.length,ms:Date.now()-batchStarted,sources:[...new Set(result.frames.map(f=>f.source))]});
  await fs.writeFile(path.join(output,'warm-cache-preparation.json'),JSON.stringify({elapsedMs:Date.now()-warmStarted,batches:warmBatches},null,2));
  console.log('WARM_CACHE',frame,lastFrame,warmBatches.at(-1).ms);
}
const warmPreparationMs=Date.now()-warmStarted;
const warmPlayback=await measurePlayback('warm');
assert.ok(warmPlayback.presentedFps>=authored.fps*.8 && warmPlayback.blankFraction<.05 && warmPlayback.maxGapMs<300,'Completed-cache playback did not meet measured smoothness acceptance');
const after = await hash(original);
assert.equal(after, before, 'Original project changed during acceptance run');
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, agentCompleted:providerErrors.length===0,providerErrors,verificationOfExistingRun:!!args['verify-existing'],originalSha256Before: before, originalSha256After: after, copy, ui, toolCalls: names, coldPlayback, warmPlayback, warmPreparationMs }, null, 2));
console.log(`PASS installed Python-card acceptance evidence: ${output}`);

} catch (error) {
  await fs.writeFile(path.join(output, args['verify-existing']?'verification-failure.json':'failure.json'), JSON.stringify({message:error.message,stack:error.stack},null,2));
  throw error;
} finally {
  const after=await hash(original);
  await fs.writeFile(path.join(output,'original-integrity.json'),JSON.stringify({before,after,unchanged:before===after},null,2));
  await browser?.disconnect();
  assert.equal(after,before,'Original project changed during acceptance run');
}
