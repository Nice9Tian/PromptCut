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
remote debugging enabled, open the printed project copy in its UI, then run it.`;
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
const copyName = path.basename(copy, path.extname(copy));
if (args.copy) await fs.access(copy); else await fs.copyFile(original, copy);
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ original, copy, originalSha256Before: before, origin, cdp: Number(args.cdp), provider: args.provider, startedAt: new Date().toISOString() }, null, 2));
if (args['prepare-only']) { console.log(JSON.stringify({ ok: true, copy, originalSha256: before })); process.exit(0); }

// Shell check only: no browser launch fallback. Chrome's /json/version endpoint
// is public CDP metadata and contains no application configuration or secrets.
const version = await fetch(`http://127.0.0.1:${Number(args.cdp)}/json/version`, { signal: AbortSignal.timeout(5000) });
assert.ok(version.ok, `CDP shell endpoint unavailable on ${args.cdp}`);
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${Number(args.cdp)}`, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(candidate => candidate.url().startsWith(origin)) || pages.find(candidate => !candidate.url().startsWith('devtools://'));
assert.ok(page, 'No desktop WebView2 page found through shell CDP');
const ui = await page.evaluate(async () => {
  const store = await import('/src/store/project.ts');
  const state = store.getState();
  return { url: location.href, title: document.title, ready: !!document.querySelector('#root'), filePath: state.filePath, projectId: state.project?.id };
});
assert.ok(ui.ready && await page.$('[data-pc="editor"]'), 'Connected page is not the PromptCut editor');
assert.equal(path.resolve(ui.filePath || ''), copy, `The installed app must be launched/opened with --copy before acceptance; current editor project is ${ui.filePath || '(unsaved)'}`);
// Save through the normal UI shortcut. If the shell presents a native picker,
// the already-authorized operator completes that picker; the script never
// writes project bytes as a substitute for product save behavior.
await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control');

function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find(row => row.startsWith('data: '));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* partial chunk */ }
  }
  return events;
}
const prompt = `Installed acceptance run ${randomUUID()}. The copied project is already open in the desktop UI. Create and apply two minimal Python card definitions: one transition using two sources, and one pixel/filter card using a source. Make both visibly change frames, then call see_frames on their active time range. Use only actual project tools; finish with a concise terminal completion message.`;
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
  for (const event of batch) if (['tool_call','tool_result','error','done'].includes(event.type)) console.log(JSON.stringify({type:event.type,name:event.name,ok:event.ok,message:event.message?.slice(0,300)}));
}
eventLog.push(...parseSse(pending).map(redact));
await fs.writeFile(path.join(output, 'chat-sse.redacted.json'), JSON.stringify(eventLog, null, 2));
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
assert.equal(eventLog.some(event=>event.type==='error'),false,'Agent reported an error');
assert.ok(terminal, 'SSE ended without a terminal completion event');

const authored=await page.evaluate(async()=>{const {getState}=await import('/src/store/project.ts');const s=getState();return {definitions:s.project.cardDefinitions,nodes:s.project.cardNodes,clips:s.project.tracks.flatMap(t=>t.clips),fps:s.project.fps};});
for(const kind of ['transition','filter'])assert.ok(authored.definitions?.some(d=>d.language==='python'&&d.kind===kind),`Agent did not create a Python ${kind}`);
await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control');
await page.waitForFunction(async()=>!(await import('/src/store/project.ts')).getState().dirty,{timeout:30000});
const savedDoc=JSON.parse(await fs.readFile(copy,'utf8'));
assert.deepEqual(savedDoc.project.cardDefinitions,authored.definitions,'Actual product save did not preserve Python source');
assert.deepEqual(savedDoc.project.cardNodes,authored.nodes,'Actual product save did not preserve card instances');
// Reload through the exact desktop launch URL; the product opens the saved file.
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForFunction(async(expected)=>(await import('/src/store/project.ts')).getState().filePath===expected,{timeout:60000},copy);
const reopened=await page.evaluate(async()=> (await import('/src/store/project.ts')).getState().project);
assert.deepEqual(reopened.cardDefinitions,authored.definitions,'Reopening changed card source');
const firstCustom=authored.clips.find(c=>c.nodeId&&authored.nodes?.some(n=>n.id===c.nodeId));
await page.evaluate(async(time)=>{const {actions}=await import('/src/store/project.ts');actions.seek(time);},firstCustom?.start||0);
await page.screenshot({path:path.join(output,'installed-preview.png')});

// Observe, never synthesize, ten seconds of actual preview playback. The UI
// may expose either a status attribute or a current timeline label; both are
// retained as evidence. A static/absent signal is an explicit failure.
const play = await page.$('button[title="播放"]');
assert.ok(play, 'Preview Play button not found');
await play.click();
const samples = [];
for (let i = 0; i < 11; i++) {
  samples.push(await page.evaluate(() => { const head = document.querySelector('[data-pc="playhead"]'); const preview = document.querySelector('.pc-pv[data-pc="preview"]'); return {
    at: performance.now(), shownFrame: Number(preview?.querySelector('canvas')?.dataset.frame ?? -1), playheadLabel: head?.querySelector('.pc-tl-playhead-label')?.textContent || null,
    playheadLeft: head instanceof HTMLElement ? head.style.left : null, previewCanvas: !!preview?.querySelector('canvas'),
    preview: preview?.getAttribute('data-status') || null, dropped: preview?.getAttribute('data-dropped') || null }; }));
  if (i < 10) await new Promise(resolve => setTimeout(resolve, 1000));
}
await fs.writeFile(path.join(output, 'playback-samples.json'), JSON.stringify(samples, null, 2));
assert.ok(new Set(samples.map(sample => `${sample.playheadLabel}:${sample.playheadLeft}`).filter(Boolean)).size > 1, 'Playback playhead did not advance for 10 seconds');
const pause = await page.$('button[title="暂停"]');
assert.ok(pause, 'Preview did not remain in playing state long enough to pause');
await pause.click();
const after = await hash(original);
assert.equal(after, before, 'Original project changed during acceptance run');
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, originalSha256Before: before, originalSha256After: after, copy, ui, toolCalls: names, samples }, null, 2));
await browser.disconnect();
console.log(`PASS installed Python-card acceptance evidence: ${output}`);
