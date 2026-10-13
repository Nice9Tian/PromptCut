// 0.7.18 验收证据补充（conv 组）：「Agent 已读消息撤回例外」，改密选退出和被踢两种原因分别验。
//
// 真的组合见 accept-018-conv-stack.mjs：VisuHive 账号库与凭证(真的改密、真的退出选择)、文档服务的账号权限(真的踢人、关 Agent、删项目)、
// 对话权威、任务授权，同一份 SQLite 账本；「重启」是把账号库、账本、Agent 实例全部关掉再从同一个目录打开。
// 这里的「任务」停在任务授权这一层（授权状态、消息状态、能不能继续核对权限）；任务进程被真的关掉或放行的那一半在 account-worker-lifecycle.test.mjs。
// 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT；没有就跳过（不是通过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startStack, skipReason, servicePrincipal, startRun, finishRun } from './accept-018-conv-stack.mjs';
import { digestOf } from '../account/ledger.mjs';

const opts = { skip: skipReason };
const rejectedWith = (status, code) => error => (status === undefined || error.status === status) && (code === undefined || error.code === code);
const grantOf = (s, g) => s.ledger().runGrantsV2[g.runGrantId];
const messageOf = (s, projectId, conversationId, requestId) => s.ledger().conversationsV2[projectId][conversationId].messages.find(m => m.requestId === requestId);
const principalOf = (s, projectId, g) => s.f.provider.resolveRunPrincipal({ servicePrincipal, projectId, runGrantId: g.runGrantId });

/** 项目：创建者 C；成员甲(两台设备)、乙。共有对话 conv_shared 由乙开；甲在里面发的消息 m1 已被 Agent 读到(当前任务)，
 *  甲另一台设备又发 m2(未读，排队)，乙发 m3(排队)。甲自己还有一个私有对话 conv_priv：p1 已读(当前任务)，p2 排队。 */
async function scene(t, existing = null) {
  const s = existing ?? await startStack(); if (!existing) t.after(() => cur.s.close());
  const cur = { s };
  const creator = s.account('creator'), alice = s.account('alice'), bob = s.account('bob');
  const c1 = creator.login('creator-pc'), a1 = alice.login('alice-phone'), a2 = alice.login('alice-pc'), b1 = bob.login('bob-pc');
  const { projectId, admin } = await s.project(c1, [a1, b1]);
  await s.send(projectId, b1, 'conv_shared', 'b-open', '乙开对话');
  const gOpen = await startRun(s, projectId, 'conv_shared', 'admit-open'); await finishRun(s, projectId, 'conv_shared', gOpen, 'finish-open');
  await s.send(projectId, a1, 'conv_shared', 'm1', '甲发的共有任务');
  const gShared = await startRun(s, projectId, 'conv_shared', 'admit-m1');
  await s.send(projectId, a2, 'conv_shared', 'm2', '甲在另一台设备发的，Agent 还没读');
  await s.send(projectId, b1, 'conv_shared', 'm3', '乙排着的');
  await s.send(projectId, a1, 'conv_priv', 'p1', '甲的私有任务');
  await s.call('switchVisibility', projectId, a1, { conversationId: 'conv_priv', visibility: 'private', requestId: 'sw-priv' });
  const gPriv = await startRun(s, projectId, 'conv_priv', 'admit-p1');
  await s.send(projectId, a2, 'conv_priv', 'p2', '甲私有对话里排着的');
  return { cur, s, creator, alice, bob, c1, a1, a2, b1, projectId, admin, gShared, gPriv };
}
/** 被踢 / 改密选退出。退出时在改密之后另开一个新登录(应当不受影响)。 */
async function trigger(s, reason, w) {
  if (reason === 'kick') { await w.admin({ op: 'kick', accountId: w.alice.id }); return {}; }
  const now = Date.now(), tag = randomBytes(4).toString('hex');
  const website = s.store.createSession({ tokenHash: randomBytes(32).toString('hex'), accountId: w.alice.id, now, expiresAt: now + 86400000 });
  const changed = s.store.changePassword({ accountId: w.alice.id, requestId: `pw-${tag}`, pw: 'new-unusable-hash', now, initiatorWebsiteLoginId: website.loginId });
  const fresh = s.loginAs(w.alice, `fresh-${tag}`);
  s.store.choose(changed.event_id, website.loginId, true, `choose-${tag}`);
  await s.authority.synchronize();
  return { fresh };
}
/** 两种原因下都该成立的分类：已读的共有当前任务保留，私有任务中止，未读的排队消息作废，别人的不动，原文和作者不撤回。 */
function assertClassified(s, w, reason) {
  const { projectId, gShared, gPriv, alice, bob } = w;
  assert.equal(grantOf(s, gShared).state, 'retained', '共有对话里已读的当前任务继续');
  assert.equal(grantOf(s, gShared).reason, reason === 'kick' ? 'member' : 'credential');
  assert.equal(grantOf(s, gPriv).state, 'revoked', '私有任务中止');
  assert.equal(messageOf(s, projectId, 'conv_shared', 'm2').queueState, 'cancelled', '共有对话里未读的排队消息作废');
  assert.equal(messageOf(s, projectId, 'conv_priv', 'p2').queueState, 'cancelled', '私有对话里未读的排队消息作废');
  assert.equal(messageOf(s, projectId, 'conv_shared', 'm3').queueState, 'queued', '乙排着的消息不受影响');
  // 已读消息原文和作者保留，不撤回；未读被作废的也只是不再执行，文字仍在历史里。
  const m1 = messageOf(s, projectId, 'conv_shared', 'm1'), p1 = messageOf(s, projectId, 'conv_priv', 'p1');
  assert.deepEqual([m1.content, m1.senderAccountId, m1.queueState], ['甲发的共有任务', alice.id, 'running']);
  assert.deepEqual([p1.content, p1.senderAccountId], ['甲的私有任务', alice.id]);
  assert.ok(m1.readReceiptId && s.ledger().runReceiptsV2[m1.readReceiptId], '读过的记录还在');
  assert.equal(messageOf(s, projectId, 'conv_shared', 'm2').senderAccountId, alice.id);
  assert.equal(bob.id, messageOf(s, projectId, 'conv_shared', 'm3').senderAccountId);
}

for (const reason of ['kick', 'exit']) {
  const label = reason === 'kick' ? '被踢' : '改密选退出';
  test(`2.1-4 [${label}] 已读的共有当前任务继续、私有任务中止、未读作废；原文与作者保留；该账号再读/发/启动下一轮被拒；其他成员不误伤`, opts, async t => {
    const w = await scene(t), { s, projectId, gShared, gPriv, a1, a2, b1, c1 } = w;
    const after = await trigger(s, reason, w);
    assertClassified(s, w, reason);
    // 保留的任务仍能通过任务授权核对(继续做)，私有任务不行。
    const kept = await s.f.provider.checkAccess({ principal: await principalOf(s, projectId, gShared), projectId, action: 'write' });
    assert.equal(kept.retainedGrant.state, 'retained'); assert.equal(kept.retainedGrant.currentRun, true);
    await assert.rejects(principalOf(s, projectId, gPriv), /run-no-longer-current|run-revoked/);
    if (reason === 'kick') {
      // 被踢：该账号全部设备查看、发送、新建、停任务都被拒；也不在项目列表里。
      for (const entry of [a1, a2]) {
        await assert.rejects(s.call('list', projectId, entry, {}), rejectedWith(403, 'banned'));
        await assert.rejects(s.call('get', projectId, entry, { conversationId: 'conv_shared' }), rejectedWith(403, 'banned'));
        await assert.rejects(s.send(projectId, entry, 'conv_shared', `again-${entry.device}`, '被踢后再发'), rejectedWith(403, 'banned'));
        await assert.rejects(s.send(projectId, entry, `conv_new_${entry.device}`, `new-${entry.device}`, '被踢后新建'), rejectedWith(403, 'banned'));
        await assert.rejects(s.call('stop', projectId, entry, { conversationId: 'conv_shared', runId: gShared.runId, requestId: `stop-${entry.device}` }), rejectedWith(403, 'banned'));
      }
      assert.equal(s.authority.listProjects(w.alice.id).joined.length, 0);
    } else {
      // 改密选退出：旧登录(两台设备)不能再读、再发；改密之后新开的登录是新授权，照常。
      for (const entry of [a1, a2]) {
        await assert.rejects(s.call('get', projectId, entry, { conversationId: 'conv_shared' }), rejectedWith(401, 'credential-revoked'));
        await assert.rejects(s.send(projectId, entry, 'conv_shared', `old-${entry.device}`, '旧登录再发'), rejectedWith(401, 'credential-revoked'));
      }
      assert.equal((await s.call('get', projectId, after.fresh, { conversationId: 'conv_shared' })).messages.length >= 4, true);
    }
    // 其他有效成员(乙、创建者)读、发都照常；乙排着的消息在保留任务做完之后轮到。
    assert.ok((await s.call('get', projectId, b1, { conversationId: 'conv_shared' })).messages.some(m => m.requestId === 'm1'));
    await s.send(projectId, b1, 'conv_shared', 'm4', '乙退出之后又发');
    await s.send(projectId, c1, 'conv_shared', 'm5', '创建者也发');
    await finishRun(s, projectId, 'conv_shared', gShared, 'finish-m1');
    assert.equal(messageOf(s, projectId, 'conv_shared', 'm1').queueState, 'done', '保留的任务做完');
    const next = await s.f.provider.admit({ servicePrincipal, projectId, conversationId: 'conv_shared', requestId: 'admit-next' });
    assert.equal(next.accountId, s.ledger().conversationsV2[projectId].conv_shared.messages.find(m => m.requestId === 'm3').senderAccountId);
    assert.notEqual(next.accountId, w.alice.id, '下一轮不是该账号发起的');
  });

  test(`2.1-4 [${label}] 例外只保留当前任务授权：之后关闭 Agent、删项目仍然中止保留的任务`, opts, async t => {
    for (const followup of ['agent-off', 'delete']) {
      const w = await scene(t), { s, projectId, gShared } = w;
      await trigger(s, reason, w);
      assert.equal(grantOf(s, gShared).state, 'retained');
      if (followup === 'agent-off') await w.admin({ op: 'set-hosted-service', service: 'agent', enabled: false });
      else await w.admin({ op: 'delete' });
      assert.equal(grantOf(s, gShared).state, 'revoked', `${followup} 之后保留的任务也中止`);
      assert.equal(grantOf(s, gShared).reason, followup === 'agent-off' ? 'agent-disabled' : 'delete');
      await assert.rejects(principalOf(s, projectId, gShared), /run-no-longer-current|run-revoked/);
      s.close();
    }
  });
}

test('2.1-4 「已发送」不等于「已读」：伪造已读不取得继续执行授权；客户端自带的已读字段被忽略', opts, async t => {
  const s = await startStack(); t.after(() => s.close());
  const creator = s.account('creator'), alice = s.account('alice'), bob = s.account('bob');
  const c1 = creator.login(), a1 = alice.login(), b1 = bob.login();
  const { projectId, admin } = await s.project(c1, [a1, b1]);
  // 客户端在发送时自带「已读」「正在运行」字段：服务端只落自己算的，消息仍是排队、没有读取回执。
  const actorRef = await s.actor(projectId, a1);
  const sent = await s.conversationAuthority.send({ principalRef: actorRef, projectId, conversationId: 'conv_forge', requestId: 'forge-1', content: '带伪造字段',
    selectionInput: { pageId: 'page_1', selection: { clipIds: [] } }, readReceiptId: 'forged-receipt', queueState: 'running', runId: 'forged-run', senderAccountId: bob.id });
  const m = messageOf(s, projectId, 'conv_forge', 'forge-1');
  assert.equal(m.queueState, 'queued'); assert.equal(m.readReceiptId, undefined); assert.equal(m.runId, undefined); assert.equal(m.senderAccountId, alice.id);
  assert.equal(sent.messageId, m.messageId);
  // Agent 领取了这条消息，但「读到了」的确认被篡改(提示词内容与服务端记录不符)：确认被拒，没有读取回执。
  const g = await startRun(s, projectId, 'conv_forge', 'admit-forge', { read: false });
  const forged = { ...(await import('../account/run-authority.mjs')).canonicalReadRecord(g.message, g), content: '被改过的内容' };
  await assert.rejects(s.f.provider.confirmRead({ servicePrincipal, projectId, conversationId: 'conv_forge', messageId: g.messageId, runId: g.runId, runGrantId: g.runGrantId,
    requestId: 'read-forge', readIntentId: 'intent-forge', prompt: forged, promptDigest: digestOf(forged) }), /complete-prompt-unverified/);
  assert.equal(messageOf(s, projectId, 'conv_forge', 'forge-1').readReceiptId, undefined);
  assert.equal(grantOf(s, g).readReceiptId ?? null, null);
  // 此时该账号被踢：没有真正的读取回执，授权不保留(中止)，消息作废。
  await admin({ op: 'kick', accountId: alice.id });
  assert.equal(grantOf(s, g).state, 'revoked', '没读到就不取得继续执行授权');
  assert.equal(messageOf(s, projectId, 'conv_forge', 'forge-1').queueState, 'cancelled');
  await assert.rejects(principalOf(s, projectId, g), /run-no-longer-current|run-revoked/);
  assert.equal(Object.keys(s.ledger().runReceiptsV2 ?? {}).length, 0, '没有任何读取回执被写下');
});

for (const reason of ['kick', 'exit']) {
  const label = reason === 'kick' ? '被踢' : '改密选退出';
  test(`2.1-4 [${label}] 读状态落盘后重启：重启后仍能准确判定（已读保留、私有中止、未读作废）；先触发再重启结果不变`, opts, async t => {
    // A：先已读落盘 → 重启 → 再触发。
    let w = await scene(t); let { s } = w;
    const readReceipt = messageOf(s, w.projectId, 'conv_shared', 'm1').readReceiptId;
    assert.ok(readReceipt);
    s = await s.restart(); w.cur.s = s;
    assert.equal(messageOf(s, w.projectId, 'conv_shared', 'm1').readReceiptId, readReceipt, '重启后读状态还在');
    assert.equal(messageOf(s, w.projectId, 'conv_shared', 'm2').readReceiptId, undefined, '重启后未读仍是未读');
    assert.equal(grantOf(s, w.gShared).state, 'active');
    await trigger(s, reason, { ...w, admin: body => s.admin(w.projectId, w.c1, body) });
    assertClassified(s, w, reason);
    // 新的 Agent 实例(新的内存密钥)不能顶替旧实例去接这些任务：重启本身不会让被撤销或保留的任务复活。
    await assert.rejects(principalOf(s, w.projectId, w.gPriv), /run-no-longer-current|run-revoked|run-instance-mismatch/);
    await assert.rejects(principalOf(s, w.projectId, w.gShared), /run-instance-mismatch/);
    // B：先触发 → 重启 → 结果不变。
    const w2 = await scene(t); let s2 = w2.s;
    await trigger(s2, reason, w2);
    const before = JSON.stringify([grantOf(s2, w2.gShared).state, grantOf(s2, w2.gPriv).state, ['m1', 'm2', 'm3'].map(r => messageOf(s2, w2.projectId, 'conv_shared', r).queueState), messageOf(s2, w2.projectId, 'conv_priv', 'p2').queueState]);
    s2 = await s2.restart(); w2.cur.s = s2;
    assertClassified(s2, w2, reason);
    const afterRestart = JSON.stringify([grantOf(s2, w2.gShared).state, grantOf(s2, w2.gPriv).state, ['m1', 'm2', 'm3'].map(r => messageOf(s2, w2.projectId, 'conv_shared', r).queueState), messageOf(s2, w2.projectId, 'conv_priv', 'p2').queueState]);
    assert.equal(afterRestart, before);
    if (reason === 'kick') await assert.rejects(s2.call('get', w2.projectId, w2.a1, { conversationId: 'conv_shared' }), rejectedWith(403, 'banned'), '重启后被踢账号仍被拒');
    else await assert.rejects(s2.call('get', w2.projectId, w2.a1, { conversationId: 'conv_shared' }), rejectedWith(401, 'credential-revoked'), '重启后旧登录仍被拒');
  });
}

test('2.1-4 无关修改不误伤：项目入口、成员名单里与该账号无关的改动，以及别的账号改密选退出，都不影响正在跑的已读任务和排队的消息', opts, async t => {
  const w = await scene(t), { s, projectId, gShared, gPriv, bob } = w;
  // 项目入口改动(不涉及任何成员)。
  await w.admin({ op: 'set-entry', allowLinkJoin: false });
  // 乙改密码并选「退出别的设备」：乙自己的旧登录失效，与甲无关。
  const now = Date.now(), tag = randomBytes(4).toString('hex');
  const website = s.store.createSession({ tokenHash: randomBytes(32).toString('hex'), accountId: bob.id, now, expiresAt: now + 86400000 });
  const changed = s.store.changePassword({ accountId: bob.id, requestId: `pw-${tag}`, pw: 'new-unusable-hash', now, initiatorWebsiteLoginId: website.loginId });
  s.store.choose(changed.event_id, website.loginId, true, `choose-${tag}`);
  await s.authority.synchronize();
  assert.equal(grantOf(s, gShared).state, 'active', '甲的共有任务不受影响');
  assert.equal(grantOf(s, gPriv).state, 'active', '甲的私有任务不受影响');
  assert.equal(messageOf(s, projectId, 'conv_shared', 'm2').queueState, 'queued', '甲排着的消息不受影响');
  assert.equal(messageOf(s, projectId, 'conv_priv', 'p2').queueState, 'queued');
  assert.equal(messageOf(s, projectId, 'conv_shared', 'm3').queueState, 'cancelled', '乙自己排着的、用旧登录发的消息按「未读不继续」作废(这是乙的退出，不是无关修改)');
  // 甲照常读、发。
  assert.ok((await s.call('get', projectId, w.a1, { conversationId: 'conv_shared' })).messages.length >= 4);
  await s.send(projectId, w.a1, 'conv_shared', 'm6', '甲照常发');
  assert.equal((await s.f.provider.checkAccess({ principal: await principalOf(s, projectId, gShared), projectId, action: 'write' })).activeGrant.state, 'active');
});

test('2.1-5 改密选「否」(不退出别的设备)：旧登录、正在跑的任务、排队的消息都不受影响', opts, async t => {
  const w = await scene(t), { s, projectId, gShared, gPriv, alice } = w;
  const now = Date.now(), tag = randomBytes(4).toString('hex');
  const website = s.store.createSession({ tokenHash: randomBytes(32).toString('hex'), accountId: alice.id, now, expiresAt: now + 86400000 });
  const changed = s.store.changePassword({ accountId: alice.id, requestId: `pw-${tag}`, pw: 'new-unusable-hash', now, initiatorWebsiteLoginId: website.loginId });
  s.store.choose(changed.event_id, website.loginId, false, `choose-${tag}`);
  await s.authority.synchronize();
  assert.equal(grantOf(s, gShared).state, 'active'); assert.equal(grantOf(s, gPriv).state, 'active');
  assert.equal(messageOf(s, projectId, 'conv_shared', 'm2').queueState, 'queued');
  assert.equal(messageOf(s, projectId, 'conv_priv', 'p2').queueState, 'queued');
  for (const entry of [w.a1, w.a2]) assert.ok((await s.call('get', projectId, entry, { conversationId: 'conv_shared' })).messages.length >= 4, '旧登录照常能读');
  await s.send(projectId, w.a1, 'conv_shared', 'm7', '选否之后旧登录照常发');
});
