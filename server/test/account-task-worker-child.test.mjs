import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createAccountWorkerGateway } from '../agent-service/account-worker-gateway.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { scopeModel } from './agent-run-scope-fixture.mjs';
import { certificateFingerprint } from '../account/client.mjs';

const get = (port, tls) => new Promise((resolve, reject) => {
  let result, socketClosed = false, responseClosed = false, ended = false;
  const done = () => { if (ended && socketClosed && responseClosed) resolve(result); };
  const req = https.get(`https://127.0.0.1:${port}/internal/v2/agent/run-scope/identity`, { ...tls, agent: false,
    rejectUnauthorized: true, timeout: 5000 }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.once('close', () => { responseClosed = true; done(); });
    res.once('end', () => { try { result = { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }; ended = true; done(); }
      catch (error) { reject(error); } });
  });
  req.on('socket', socket => socket.once('close', () => { socketClosed = true; done(); }));
  req.on('error', reject); req.on('timeout', () => req.destroy(Error('identity-timeout')));
});
// Real independent Node OS/RAM/key and identity mTLS. No Doc/root ready record
// is available here: admission/model execution must reject. Not SSR completion.
test('private worker child owns its RAM identity; gateway cannot provide grant or skip root ready', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-task-worker-child-'));
  const diagnostic = phase => fs.appendFileSync(path.join(dir, 'safe-phases.log'), phase + '\n');
  diagnostic('temporary-pki');
  const pki = assetWiringPki(dir), model = scopeModel('child'); await model.run('initialize');
  model.expected.clientFingerprint256 = certificateFingerprint(pki.account.fingerprint256);
  model.expected.serverFingerprint256 = certificateFingerprint(pki.asset.fingerprint256);
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ expected: model.expected, reservation: model.files.get('reservation-1.json') }), { mode: 0o600 });
  const configurationModule = path.join(dir, 'worker-config.mjs');
  const code = `import fs from 'node:fs';
const dir=${JSON.stringify(dir)}, settings=${JSON.stringify(settings)};
const tls=name=>({key:fs.readFileSync(dir+'/'+name+'.key'),cert:fs.readFileSync(dir+'/'+name+'.crt'),ca:fs.readFileSync(dir+'/ca.crt')});
export function createWorkerConfiguration(){const s=JSON.parse(fs.readFileSync(settings));return {listener:{host:'127.0.0.1',port:6703},workerOptions:{
expected:s.expected,reservation:s.reservation,identityTls:tls('asset'),
doc:{origin:'https://127.0.0.1:6700',tls:tls('wrong'),serverFingerprint256:${JSON.stringify(pki.doc.fingerprint256)}},
readRootRecord:async()=>{throw Object.assign(Error('root ready missing'),{status:503,code:'root-ready-missing'});},
createAssemblyOptions:async()=>{throw Object.assign(Error('must not execute'),{code:'model-must-not-start'});}
}};}`;
  fs.writeFileSync(configurationModule, code, { mode: 0o600 });
  diagnostic('gateway-spawn');
  const gateway = createAccountWorkerGateway({ configurationModule, cwd: path.dirname(fileURLToPath(import.meta.url)), timeoutMs: 10000 });
  t.after(async () => { diagnostic('teardown'); await gateway.close(); diagnostic('child-actual-closed'); fs.rmSync(dir, { recursive: true, force: true }); });
  const ready = await gateway.ready; assert.notEqual(ready.pid, process.pid); assert.equal(ready.pid, gateway.pid()); assert.equal(ready.port, 6703);
  diagnostic('gateway-ready');
  const first = await get(ready.port, pki.account), second = await get(ready.port, pki.account);
  assert.equal(first.status, 200); assert.equal(first.body.pid, ready.pid);
  assert.equal(first.body.publicKey, second.body.publicKey); assert.equal(first.body.instanceId, model.files.get('reservation-1.json').instanceId);
  assert.equal((await get(ready.port, pki.wrong)).status, 403);
  await assert.rejects(gateway.start(), { code: 'account-worker-not-prepared' });
  await assert.rejects(gateway.prepare({ projectId: 'project', conversationId: 'conversation-child', requestId: 'one' }), { code: 'root-ready-missing' });
  await assert.rejects(gateway.prepare({ projectId: 'project', conversationId: 'conversation-child', requestId: 'one', runGrantId: 'master-grant' }), { code: 'account-worker-task' });
  assert.equal(gateway.describe().completionReady, false);
  const closed = await gateway.close(); assert.equal(closed.childClosed, true); assert.equal(closed.exitCode, 0);
  diagnostic('close-returned');
  assert.equal(closed.rootClosureProved, false); assert.equal(gateway.describe().pendingCommands, 0);
  t.diagnostic('owned hidden independent Node child; identity listener 6703; actual ChildProcess close only, no root cgroup/FIFO proof');
});
