import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationAuthority } from '../account/conversation-authority.mjs';
import { startWorkerLifecycleFixture, until, projectId, conversationId } from './fixtures/account-worker-lifecycle.mjs';

/**
 * 块五 × 块一:删除一个「正在独立任务进程里跑」的对话。
 * 用块一的整条真路径(文档服务账本、真的运行授权与围栏、真的任务子进程、调度、root 发布器的事务)，
 * 只多挂一个对话权威，它的「停任务」口子接的是和 doc-agent-assembly.mjs 的 onFence 同一个办法:
 * 下围栏→读 root 的关闭记录→这条控制办完了才回 ack。
 * 验:任务进程真的被关掉、对话的名额在那之后才让出、停不下来时不删。
 */
async function fixture(t) {
  const f = await startWorkerLifecycleFixture();
  t.after(async () => {
    const result = await f.close();
    assert.equal(result.alive, 0, '收尾后不该还有活着的任务子进程');
    if (result.errors.length) throw new AggregateError(result.errors, `fixture close; kept ${result.dir}`);
  });
  const principal = { authorizationId: 'auth-owner', projectId, accountId: 'owner', loginId: 'login-owner',
    credentialId: 'credential-owner', loginGeneration: 1, username: 'Owner' };
  const calls = { onFence: 0, pending: 0 };
  const authority = createConversationAuthority({ ledger: f.ledger, runHooks: f.provider.hooks,
    accountAuthority: { authorizePrincipal: async () => structuredClone(principal) },
    // 和 doc-agent-assembly.mjs 的 onFence 一样:先把 root 已经写下的关闭记录读进来，控制办完了才算停稳
    async onFence(input) {
      calls.onFence++;
      await f.provider.reconcileScopeClosures();
      const open = Object.values(f.ledger.read().runControlsV2 ?? {}).filter(control => control.state === 'pending' &&
        control.projectId === input.projectId && control.scope.conversationId === input.conversationId && control.scope.runId === input.runId);
      if (open.length) { calls.pending++; throw Object.assign(Error('agent-fence-pending'), { status: 503, code: 'agent-fence-pending' }); }
      return { ack: true, ...input };
    } });
  const remove = (requestId = 'delete-1') => authority.remove({ principalRef: { authorizationId: 'auth-owner' }, projectId, conversationId, requestId });
  return { f, authority, remove, calls };
}

test('删除正在跑的对话：先停(任务进程被 root 关掉)、结清以后才删，名额此时才让出，排队的别人的消息作废', { timeout: 120_000 }, async t => {
  const { f, remove, calls } = await fixture(t);
  const first = f.enqueue([{ say: '开工' }, { hold: 'never-released' }, { say: '这句不该出现' }]);
  const second = f.enqueue([{ say: '排在后面' }], 'other');
  await f.scheduler.start();
  await until(() => f.marker('held-never-released'), { what: '任务进到占用状态' });
  const g1 = f.grantOf(first);
  assert.equal(f.conversation().currentRunId, g1.runId);

  // 第一次删:围栏下去了，但任务进程还没被关掉 → 回「还在办」，对话不删、进「正在删除」
  let outcome;
  try { outcome = await remove('delete-1'); } catch (error) { outcome = error; }
  if (outcome instanceof Error) {
    assert.equal(outcome.code, 'agent-fence-pending');
    assert.ok(f.conversation().deletion, '没停稳时对话停在「正在删除」');
  }
  // 一直重试同一个请求号，直到停稳(调度在后台让 root 关进程、结清)
  const done = await until(async () => { try { return await remove('delete-1'); } catch (error) { if (error.code === 'agent-fence-pending') return false; throw error; } },
    { what: '任务停稳后删除办完', timeoutMs: 60_000 });
  assert.equal(done.removed, true);
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId], undefined, '对话从账本里拿掉，名额让出');
  // 任务确实被停了，结果是「被中断」，进程是被 root 关掉的
  const grant = f.grantOf(first);
  assert.equal(grant.state, 'finished');
  assert.equal(grant.terminalOutcome.status, 'interrupted');
  const stop = f.stops.find(row => row.epoch === 1);
  assert.equal(stop.how, 'killed');
  assert.equal(f.generations.get(1).gateway.describe().childClosed, true);
  assert.equal(f.events().some(row => row.event.type === 'text' && row.event.delta === '这句不该出现'), false);
  // 排队的消息没有被领去跑:没有第二代进程、没有第二条的运行授权
  assert.equal(f.grantOf(second), null);
  assert.equal(f.generations.size, 1);
  const stone = f.ledger.read().conversationTombstonesV2[projectId][conversationId];
  assert.equal(JSON.stringify(stone).includes('排在后面'), false, '墓碑和账本里都没有这个对话的文字');
  assert.equal(JSON.stringify(f.ledger.read()).includes('开工'), false);
  // 发过消息的其他成员各收到一条通知(删的人是开对话的人，自己不通知)
  const notices = f.ledger.read().conversationNoticesV2[projectId];
  assert.deepEqual(Object.keys(notices).sort(), ['other', 'sender']);
  assert.equal(notices.other[0].recipientRole, 'participant');
  assert.equal(notices.sender[0].conversationId, conversationId);
  // 再删一次是幂等的
  assert.equal((await remove('delete-2')).already, true);
  t.diagnostic(`delete: onFence calls ${calls.onFence}, pending ${calls.pending}, killed pid ${stop.pid} at ${stop.at}`);
});

test('任务停不下来(进程关闭被卡住)时一直不删，放开以后同一个请求号再删才成', { timeout: 120_000 }, async t => {
  const { f, remove } = await fixture(t);
  f.enqueue([{ say: '开工' }, { hold: 'stuck' }]);
  await f.scheduler.start();
  await until(() => f.marker('held-stuck'), { what: '任务进到占用状态' });
  // 让 root 的强制关闭卡住:forcedClose 一直不返回，模拟「停不下来」
  let unblock; const blocked = new Promise(resolve => { unblock = resolve; });
  const original = f.slot.forcedClose;
  f.slot.forcedClose = async args => { await blocked; return original(args); };
  for (let i = 0; i < 8; i++) {
    await assert.rejects(remove('delete-1'), { code: 'agent-fence-pending' });
    await f.scheduler.tick();
    assert.ok(f.ledger.read().conversationsV2[projectId][conversationId], `第 ${i + 1} 次：没停稳，不删`);
  }
  assert.equal(f.ledger.read().conversationTombstonesV2?.[projectId]?.[conversationId], undefined);
  assert.ok(f.ledger.read().conversationsV2[projectId][conversationId].deletion, '停在「正在删除」');
  unblock();
  const done = await until(async () => { try { return await remove('delete-1'); } catch (error) { if (error.code === 'agent-fence-pending') return false; throw error; } },
    { what: '放开以后删除办完', timeoutMs: 60_000 });
  assert.equal(done.removed, true);
});

test('块五第 7 条 一次删除调用就办完：替页面等强制结束(最多等 15 秒)，任务进程没了、对话查不到、Agent 一侧清理和接缝都在删成功之后调用', { timeout: 120_000 }, async t => {
  const { createAccountConversationService } = await import('../agent/service/conversation-policy.mjs');
  const { f, authority } = await fixture(t);
  const first = f.enqueue([{ say: '开工' }, { hold: 'never-released' }, { say: '这句不该出现' }]);
  await f.scheduler.start();
  await until(() => f.marker('held-never-released'), { what: '任务进到占用状态' });
  const order = [];
  const ref = { authorizationId: 'auth-owner' };
  const client = Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map(n => [n, async () => ({})]));
  client.remove = async input => { const r = await authority.remove({ principalRef: ref, projectId, conversationId: input.conversationId, requestId: input.requestId });
    order.push(['doc-removed', f.generations.get(1).gateway.describe().childClosed]); return r; };
  const svc = createAccountConversationService({ conversationClient: client, deleteWaitMs: 60_000,
    purger: { purge: async () => { order.push(['purge']); } }, onConversationDeleted: async () => { order.push(['seam']); } });
  const out = await svc.remove({ accountMode: true, delegation: 'd', projectId, accountId: 'owner' }, conversationId, 'one-call');
  assert.equal(out.removed, true);
  // 删成功的那一刻任务进程已经被 root 关掉(强制结束)；Agent 一侧清理与接缝在其后
  assert.deepEqual(order.at(-3), ['doc-removed', true]); assert.deepEqual(order.slice(-2), [['purge'], ['seam']]);
  assert.equal(f.generations.get(1).gateway.describe().childClosed, true);
  assert.equal(f.stops.find(row => row.epoch === 1).how, 'killed');
  assert.equal(f.grantOf(first).terminalOutcome.status, 'interrupted');
  await assert.rejects(authority.get({ principalRef: ref, projectId, conversationId }), { status: 404, code: 'conversation-deleted' });
  assert.equal(JSON.stringify(f.ledger.read()).includes('这句不该出现'), false);
});
