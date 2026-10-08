/** Real Chromium page-role WS/project.op probe against an isolated actual-provider fixture.
 * Not a production UI test. Run with explicit provider/order env; all files stay in TMP.
 * Acceptance: unsealed invisible; trusted A/B actor; full durable store/history; same rev on restart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { operationFixture } from '../../server/test/operation-wiring-fixture.mjs';
import { stateBlobName } from '../../server/docservice/modules/project.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-operation-browser-'));
const entered = Promise.withResolvers(), release = Promise.withResolvers();
let once = false, f, browser, browserClosed;
const started = performance.now();
async function connect(page, name, projectId) {
  await page.evaluate(async ({ name, projectId }) => {
    if (window.socket) window.socket.close();
    window.messages = [];
    window.socket = new WebSocket(`ws://127.0.0.1:5760/?page=${name}&project=${projectId}`);
    window.socket.addEventListener('message', e => window.messages.push(JSON.parse(e.data)));
    await new Promise((resolve, reject) => { window.socket.onopen = resolve; window.socket.onerror = () => reject(Error('fixture WS failed')); });
  }, { name, projectId });
}
async function send(page, msg) { await page.evaluate(value => window.socket.send(JSON.stringify(value)), msg); }
async function wait(page, type, opId) {
  await page.waitForFunction((type, opId) => window.messages.some(m => m.type === type && (!opId || m.opId === opId)), { timeout: 15000 }, type, opId);
  return page.evaluate((type, opId) => window.messages.find(m => m.type === type && (!opId || m.opId === opId)), type, opId);
}
try {
  f = await operationFixture({ dir, request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/reserve') && !once) { once = true; entered.resolve(); await release.promise; }
    return result;
  } });
  await f.authority.joinProject({ accessToken: f.sessions.c.accessToken }, { projectId: f.projectId, requestId: 'browser-join' });
  browser = await puppeteer.launch({ headless: true, userDataDir: path.join(dir, 'chromium-profile'), args: ['--disable-background-networking'] });
  const process = browser.process();
  browserClosed = new Promise(resolve => process.once('close', resolve));
  const first = await browser.createBrowserContext(), second = await browser.createBrowserContext();
  const a = await first.newPage(), b = await second.newPage();
  await connect(a, 'a', f.projectId); await connect(b, 'c', f.projectId);
  await send(b, { type: 'project.open', projectId: f.projectId }); assert.equal((await wait(b, 'project.state')).rev, 1);
  await send(a, { type: 'project.op', projectId: f.projectId, opId: 'browser-a', accountId: 'forged',
    actor: { accountId: 'forged' }, ops: [{ op: 'set', path: '/title', value: 'browser value' }] });
  await entered.promise;
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).rev, 1);
  assert.equal(await a.evaluate(() => window.messages.some(m => m.type === 'project.op.ok')), false);
  assert.equal(await b.evaluate(() => window.messages.some(m => m.type === 'project.ops')), false);
  release.resolve(); assert.equal((await wait(a, 'project.op.ok', 'browser-a')).rev, 2);
  const broadcast = await wait(b, 'project.ops', 'browser-a');
  assert.equal(broadcast.actor.accountId, f.account.credentials.verify(f.sessions.a.accessToken).accountId);
  await send(b, { type: 'project.op', projectId: f.projectId, opId: 'browser-b', ops: [{ op: 'set', path: '/title', value: 'browser value' }] });
  assert.equal((await wait(b, 'project.op.ok', 'browser-b')).rev, 3);
  const operations = f.history.accepted(f.projectId);
  assert.notEqual(operations[0].actor.accountId, operations[1].actor.accountId);
  assert.equal(operations[1].changes[0].beforeVersion, operations[0].changes[0].afterVersion);
  const projectId = f.projectId;
  await f.close(); f = null;
  f = await operationFixture({ dir });
  await connect(a, 'a', projectId); await send(a, { type: 'project.open', projectId });
  const restored = await wait(a, 'project.state');
  assert.equal(restored.rev, 3); assert.equal(restored.project.title, 'browser value');
  assert.equal(f.history.accepted(projectId).length, 2);
  const result = { probe: 'operation-wiring-browser', ok: true, browser: await browser.version(), pages: 2, accountActors: 2,
    unsealedOk: 0, unsealedBroadcasts: 0, restoredRev: 3, accepted: 2, sameValueVersionEvidence: true, ms: performance.now() - started, dir };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally {
  release.resolve();
  if (f) await f.close();
  if (browser) { await browser.close(); await browserClosed; }
}
