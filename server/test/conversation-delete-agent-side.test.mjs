import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountRunEvents } from '../agent/service/account-run-events.mjs';
import { openReadIntents } from '../agent/service/read-intents.mjs';
import { createConversationPurger, accountConversationOwnerKey } from '../agent/service/conversation-purge.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { digestOf } from '../account/ledger.mjs';

/**
 * 块五第 2、7 条的 Agent 服务一侧：对话被删以后事件库、已读意向、模型历史、工作目录都清干净；
 * 删除替页面等强制结束办完；删除后留给云端工具表接线的接缝(onConversationDeleted)。
 */
const projectId = 'sp_agentside', other = 'sp_other';
const SECRET = '绝密-agent-9c1';
const msg = (content, n = 1, conv = 'c1', pid = projectId) => ({ messageId: `m${n}-${conv}`, requestId: `req${n}-${conv}`, arrivalSeq: n, senderAccountId: 'acc1',
  senderNameAtSend: 'A', createdAt: 1, content, contentDigest: digestOf(content), attachments: [],
  selectionSnapshot: { projectId: pid, accountId: 'acc1', messageId: `m${n}-${conv}`, pageId: 'p', selection: {}, sentAt: 1, source: 'sent-snapshot' } });

function stores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-purge-'));
  const eventStore = createAccountRunEvents({ file: path.join(dir, 'events.sqlite'), authorityId: 'a', verifyGrant: async () => { throw new Error('unused'); } });
  const readIntents = openReadIntents({ file: path.join(dir, 'intents.sqlite') });
  const shared = path.join(dir, 'shared');
  return { dir, eventStore, readIntents, shared, async close() { await eventStore.close(); readIntents.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const rawDump = file => { const db = new DatabaseSync(file, { readOnly: true }); try {
  return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().flatMap(t => db.prepare(`SELECT * FROM ${t.name}`).all()));
} finally { db.close(); } };

test('清干净：事件库(已接受消息原文)、已读意向(提示词)、模型历史、工作目录(含附件)，别的对话与别的项目不动', async () => {
  const s = stores();
  try {
    for (const conv of ['c1', 'c2']) {
      await s.eventStore.mirrorAccepted({ projectId, conversationId: conv, read: async () => ({ v: 2, projectId, id: conv, messages: [msg(conv === 'c1' ? SECRET : '保留的话', 1, conv)] }) });
    }
    await s.eventStore.mirrorAccepted({ projectId: other, conversationId: 'c1', read: async () => ({ v: 2, projectId: other, id: 'c1', messages: [msg('别的项目的话', 1, 'c1', other)] }) });
    for (const [pid, conv, prompt] of [[projectId, 'c1', SECRET], [projectId, 'c2', '保留的提示'], [other, 'c1', '别的项目的提示']])
      s.readIntents.prepare({ requestId: `r-${pid}-${conv}`, binding: { projectId: pid, conversationId: conv, messageId: 'm', runId: 'r', runGrantId: 'g' }, prompt: { text: prompt } });
    const owner = accountConversationOwnerKey(projectId, 'c1');
    for (const f of [`tenants/${projectId}/conversations/c1/history.json`, `work/${projectId}/${owner}/c1/attachments/a.txt`,
      `tenants/${projectId}/conversations/c2/history.json`, `work/${projectId}/${accountConversationOwnerKey(projectId, 'c2')}/c2/attachments/b.txt`,
      `tenants/${other}/conversations/c1/history.json`]) {
      fs.mkdirSync(path.dirname(path.join(s.shared, f)), { recursive: true }); fs.writeFileSync(path.join(s.shared, f), f.includes('/c1/') && f.includes(projectId) ? SECRET : '别的');
    }
    assert.ok(rawDump(path.join(s.dir, 'events.sqlite')).includes(SECRET)); assert.ok(rawDump(path.join(s.dir, 'intents.sqlite')).includes(SECRET));

    const purger = createConversationPurger({ eventStore: s.eventStore, readIntents: s.readIntents, sharedDataDir: s.shared });
    const out = await purger.purge({ projectId, conversationId: 'c1' });
    assert.ok(out.runEvents.rows > 0 && out.readIntents.rows === 1 && out.history && out.workspace);
    // 逐处核对：删后各处查不到
    assert.equal(rawDump(path.join(s.dir, 'events.sqlite')).includes(SECRET), false, '事件库');
    assert.equal(rawDump(path.join(s.dir, 'intents.sqlite')).includes(SECRET), false, '已读意向');
    assert.equal(fs.existsSync(path.join(s.shared, `tenants/${projectId}/conversations/c1`)), false, '模型历史');
    assert.equal(fs.existsSync(path.join(s.shared, `work/${projectId}/${owner}/c1`)), false, '工作目录');
    assert.equal(s.eventStore.after({ projectId, conversationId: 'c1' }).head, 0);
    // 别的不动
    assert.ok(rawDump(path.join(s.dir, 'events.sqlite')).includes('保留的话') && rawDump(path.join(s.dir, 'events.sqlite')).includes('别的项目的话'));
    assert.ok(rawDump(path.join(s.dir, 'intents.sqlite')).includes('保留的提示') && rawDump(path.join(s.dir, 'intents.sqlite')).includes('别的项目的提示'));
    assert.ok(fs.existsSync(path.join(s.shared, `tenants/${projectId}/conversations/c2/history.json`)));
    assert.ok(fs.existsSync(path.join(s.shared, `tenants/${other}/conversations/c1/history.json`)));
    // 幂等；不合法的号拒绝
    await purger.purge({ projectId, conversationId: 'c1' });
    await assert.rejects(purger.purge({ projectId, conversationId: '../x' }), { code: 'purge-invalid' });
  } finally { await s.close(); }
});

const identity = { accountMode: true, delegation: 'd', projectId, accountId: 'acc1' };
function client(over = {}) {
  const calls = [];
  const base = Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map(n => [n, async () => ({})]));
  return { calls, c: { ...base, async remove(input) { calls.push(['remove', input]); return { conversationId: input.conversationId, projectId, removed: true, already: false }; },
    async removeMemberPrivate(input) { calls.push(['removeMemberPrivate', input]); return { accountId: input.targetAccountId, projectId, removed: ['p1', 'p2'], pending: [] }; }, ...over } };
}

test('删除替页面等强制结束：围栏没办完(agent-fence-pending)就隔一会儿用同一个请求号再问，办完才清 Agent 一侧并回成功；超时仍没办完原样回 503', async () => {
  const purged = [], seam = [];
  let n = 0;
  const { c, calls } = client({ async remove(input) { calls.push(input.requestId); if (++n < 4) throw Object.assign(new Error('p'), { status: 503, code: 'agent-fence-pending' });
    return { conversationId: input.conversationId, projectId, removed: true }; } });
  const svc = createAccountConversationService({ conversationClient: c, purger: { purge: async x => { purged.push(x); } }, onConversationDeleted: async x => { seam.push(x); },
    sleep: async () => {}, deleteWaitMs: 15_000 });
  const out = await svc.remove(identity, 'c1', 'req-1');
  assert.equal(out.removed, true);
  assert.deepEqual(calls, ['req-1', 'req-1', 'req-1', 'req-1'], '同一个请求号');
  assert.deepEqual(purged, [{ projectId, conversationId: 'c1' }]);
  assert.deepEqual(seam, [{ projectId, conversationId: 'c1' }], '接缝在删成功之后调用');
  // 到时间还没办完：不清 Agent 一侧、不调接缝，原样回 503
  let t = 0; const forever = client({ async remove() { throw Object.assign(new Error('p'), { status: 503, code: 'agent-fence-pending' }); } });
  const slow = createAccountConversationService({ conversationClient: forever.c, purger: { purge: async x => { purged.push(['no', x]); } }, onConversationDeleted: async () => { seam.push('no'); },
    sleep: async () => {}, now: () => (t += 4000), deleteWaitMs: 15_000 });
  await assert.rejects(slow.remove(identity, 'c1', 'req-2'), { status: 503, code: 'agent-fence-pending' });
  assert.equal(purged.length, 1); assert.equal(seam.length, 1);
});

test('清理失败回 503 purge-failed，重放同一个删除(文档服务回「已删」)会再清一遍；文档服务拒绝时不清', async () => {
  let fail = true; const purged = [];
  const { c } = client({ async remove(input) { return { conversationId: input.conversationId, projectId, removed: true, already: !fail }; } });
  const svc = createAccountConversationService({ conversationClient: c, purger: { purge: async x => { if (fail) throw new Error('disk'); purged.push(x); } }, sleep: async () => {} });
  await assert.rejects(svc.remove(identity, 'c1', 'r'), { status: 503, code: 'purge-failed' });
  fail = false;
  assert.equal((await svc.remove(identity, 'c1', 'r')).already, true);
  assert.equal(purged.length, 1);
  const denied = client({ async remove() { throw Object.assign(new Error('x'), { status: 403, code: 'delete-forbidden' }); } });
  const svc2 = createAccountConversationService({ conversationClient: denied.c, purger: { purge: async x => { purged.push(['denied', x]); } } });
  await assert.rejects(svc2.remove(identity, 'c1', 'r'), { status: 403, code: 'delete-forbidden' });
  assert.equal(purged.length, 1, '被拒绝的不清');
});

test('移出成员时清私有对话：文档服务删完逐个清 Agent 一侧并调接缝；没办完的不清、等同一个请求号再来', async () => {
  const purged = [], seam = [];
  const first = client({ async removeMemberPrivate(input) { return { accountId: input.targetAccountId, projectId, removed: ['p1'], pending: ['p2'] }; } });
  const svc = createAccountConversationService({ conversationClient: first.c, purger: { purge: async x => { purged.push(x.conversationId); } },
    onConversationDeleted: async x => { seam.push(x.conversationId); }, sleep: async () => {}, deleteWaitMs: 0 });
  const out = await svc.removeMemberPrivate(identity, 'acc2', 'clear-1');
  assert.deepEqual([out.removed, out.pending], [['p1'], ['p2']]);
  assert.deepEqual(purged, ['p1']); assert.deepEqual(seam, ['p1']);
  const done = client();
  const svc2 = createAccountConversationService({ conversationClient: done.c, purger: { purge: async x => { purged.push(x.conversationId); } }, sleep: async () => {} });
  assert.deepEqual((await svc2.removeMemberPrivate(identity, 'acc2', 'clear-1')).removed, ['p1', 'p2']);
  assert.deepEqual(purged, ['p1', 'p1', 'p2']);
});
