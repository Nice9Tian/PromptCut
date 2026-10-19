import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { digestOf } from '../account/ledger.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';

// 真 mTLS；文档服务是受控的假口：登记照答，`runs/check` 按设定先回几次 503 再回答。
// 守的是 2026-10-19 生产实测的那一类：文档服务卡了几秒，任务进程问「这一轮还能不能写」拿到 503，整条任务就此失败。
async function fixture(t, plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-client-retry-'));
  const pki = assetWiringPki(dir);
  let checks = 0;
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(value)); };
      if (req.url === '/internal/v2/instances/challenge') return reply(200, { ok: true, result: { domain: 'promptcut.agent-instance.register.v1',
        authorityId: 'doc', serviceId: 'agent', serviceKid: 'agent-kid', requestId: body.requestId, challengeId: 'challenge', nonce: 'nonce',
        publicKeyDigest: digestOf(body.publicKey) } });
      if (req.url === '/internal/v2/instances/register') return reply(200, { ok: true, result: { authorityId: 'doc', serviceId: 'agent',
        serviceKid: 'agent-kid', instanceId: 'instance-1', instanceGeneration: 1 } });
      if (req.url === '/internal/v2/runs/check') {
        const step = plan[Math.min(checks++, plan.length - 1)];
        return reply(step.status, step.status === 200 ? { ok: true, result: { allowed: true, attempt: checks } } : { ok: false, code: step.code });
      }
      reply(404, { ok: false, code: 'no-route' });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const client = createRunClient({ origin: `https://127.0.0.1:${server.address().port}`, tls: pki.wrong,
    serverFingerprint256: pki.doc.fingerprint256, checkRetryDelaysMs: [20, 40, 80] });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { client, checks: () => checks };
}
const input = { projectId: 'p', runGrantId: 'g', action: 'write' };

test('文档服务一时答不上（503）时「还能不能写」的核对隔一会儿再问，答上了任务照常往下走', { timeout: 60_000 }, async t => {
  const f = await fixture(t, [{ status: 503, code: 'run-client-unavailable' }, { status: 503, code: 'run-scope-unavailable' }, { status: 200 }]);
  const result = await f.client.checkAccess(input);
  assert.equal(result.allowed, true); assert.equal(f.checks(), 3);
});

test('明确的拒绝（403 被撤销）不再问，原样交回', { timeout: 60_000 }, async t => {
  const f = await fixture(t, [{ status: 403, code: 'run-revoked' }, { status: 200 }]);
  await assert.rejects(f.client.checkAccess(input), e => e.status === 403 && e.code === 'run-revoked');
  assert.equal(f.checks(), 1);
});

test('一直答不上：问满次数后把 503 交回（由调用方记失败），不无限空转', { timeout: 60_000 }, async t => {
  const f = await fixture(t, [{ status: 503, code: 'run-client-unavailable' }]);
  await assert.rejects(f.client.checkAccess(input), e => e.status === 503 && e.code === 'run-client-unavailable');
  assert.equal(f.checks(), 4);
});
