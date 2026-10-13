/**
 * 账号模式的 `GET /agent/v1/usage`(原先固定回 503 usage-unavailable)。
 * 契约 docs/plan/cloud-agent-contract.md 第 6 节:项目内的成员可查本项目的总量与各成员、各模型的量;
 * 身份以账号为准(由文档服务核对),不是本项目成员的不回数字,也看不到别的项目的流水。
 *
 * 跑:npm test -- server/test/agent-account-usage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAgentHttp } from '../agent-service/http.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { createUsageLog } from '../agent/service/usage.mjs';

const P1 = 'sp_' + 'a'.repeat(26), P2 = 'sp_' + 'b'.repeat(26);
const ALICE = 'acc_' + 'a'.repeat(24), BOB = 'acc_' + 'b'.repeat(24), EVE = 'acc_' + 'e'.repeat(24);

function stack(t, { usageDir }) {
  // 文档服务的替身:只认 P1 的成员 ALICE、BOB;别的账号核对不过(401/403)
  const members = { [P1]: new Set([ALICE, BOB]), [P2]: new Set([EVE]) };
  const client = Object.fromEntries(['access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map(n => [n, async () => ({})]));
  client.identity = async ({ delegation, projectId }) => {
    const accountId = String(delegation).replace(/^d:/, '');
    if (!members[projectId]?.has(accountId)) throw Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });
    return { projectId, accountId };
  };
  const service = createAccountConversationService({ conversationClient: client, usageDir });
  const identities = {
    alice: { accountMode: true, projectId: P1, accountId: ALICE, userId: ALICE, delegation: 'd:' + ALICE },
    eveInP1: { accountMode: true, projectId: P1, accountId: EVE, userId: EVE, delegation: 'd:' + EVE },
    eve: { accountMode: true, projectId: P2, accountId: EVE, userId: EVE, delegation: 'd:' + EVE },
  };
  let who = 'alice';
  const api = createAgentHttp({ service, authenticate: async () => identities[who] });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); service.close(); });
  const get = async (as, query = '') => { who = as; await ready;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/usage${query}`);
    return { status: res.status, body: await res.json() }; };
  return { service, get };
}

const row = (o) => ({ vendor: 'mock', model: 'scripted', input: 10, output: 5, ok: true, ms: 1, conversationId: 'c', runId: 'r', ...o });

test('账号模式 /v1/usage:成员看到本项目的总量、各成员、各模型,别的项目的流水不在里面', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-acc-usage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createUsageLog({ dir, flushMs: 3_600_000 }); t.after(() => log.close?.());
  log.append(row({ projectId: P1, userId: ALICE, username: 'Alice', t: 1_000_000 }));
  log.append(row({ projectId: P1, userId: ALICE, username: 'Alice', model: 'other', input: 100, output: 20, t: 2_000_000 }));
  log.append(row({ projectId: P1, userId: BOB, username: 'Bob', t: 3_000_000 }));
  log.append(row({ projectId: P2, userId: EVE, username: 'Eve', input: 999, output: 1 }));
  const { get } = stack(t, { usageDir: dir });
  const out = await get('alice');
  assert.equal(out.status, 200); assert.equal(out.body.ok, true);
  assert.deepEqual({ tokens: out.body.project.tokens, calls: out.body.project.calls }, { tokens: 15 + 120 + 15, calls: 3 });
  const byName = Object.fromEntries(out.body.members.map(m => [m.username, m]));
  assert.deepEqual([byName.Alice.tokens, byName.Alice.calls, byName.Bob.tokens, byName.Bob.calls], [135, 2, 15, 1]);
  assert.deepEqual(out.body.models.map(m => m.model).sort(), ['mock/other', 'mock/scripted']);
  assert.ok(!JSON.stringify(out.body).includes(ALICE) && !JSON.stringify(out.body).includes('Eve'), '不带账号编号,不带别的项目的人');
  // since 认
  const later = await get('alice', '?since=2500000');
  assert.deepEqual({ tokens: later.body.project.tokens, calls: later.body.project.calls }, { tokens: 15, calls: 1 });
  // 另一个项目的成员只看到自己项目的
  const eve = await get('eve');
  assert.equal(eve.status, 200); assert.equal(eve.body.project.tokens, 1000); assert.deepEqual(eve.body.members.map(m => m.username), ['Eve']);
});

test('账号模式 /v1/usage:不是本项目成员的账号不回数字', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-acc-usage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createUsageLog({ dir, flushMs: 3_600_000 }); t.after(() => log.close?.());
  log.append(row({ projectId: P1, userId: ALICE, username: 'Alice' }));
  const { get } = stack(t, { usageDir: dir });
  const out = await get('eveInP1');
  assert.ok(out.status === 401 || out.status === 403, `非成员被拒:${out.status}`);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.project, undefined); assert.ok(!JSON.stringify(out.body).includes('Alice'));
});

test('账号模式 /v1/usage:还没有任何用量记录的项目回零,不报错', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-acc-usage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { get } = stack(t, { usageDir: dir });
  const out = await get('alice');
  assert.equal(out.status, 200); assert.equal(out.body.project.tokens, 0); assert.deepEqual(out.body.members, []);
});

test('账号模式 /v1/usage:没挂用量目录(没有执行器)仍回 503,不编造零', async t => {
  const { get } = stack(t, { usageDir: null });
  const out = await get('alice');
  assert.equal(out.status, 503); assert.equal(out.body.code, 'usage-unavailable');
});
