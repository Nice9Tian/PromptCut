/**
 * 游客每个项目只能开一个云端 Agent 对话（2026-10-23 用户定「游客每个项目只能开一个会话。帮我定死。」，回答安全审查 S8）。
 *
 * 这一层测的是**服务端**：绕过界面、直接对文档服务的对话权威（`server/account/conversation-authority.mjs`）发消息，
 * 用的是真的账号权威（`authority.mjs`）认游客令牌，不是手捏的 principal。HTTP 一路到页面的透传另见 `guest-one-chat-http.test.mjs`。
 *
 * 跑：npm test -- server/test/guest-one-chat.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createConversationAuthority, MAX_CONVERSATIONS_PER_OWNER } from '../account/conversation-authority.mjs';
import { GUEST_ERROR_TEXT, GUEST_LIMITS, guestChatLimitReached, signGuestToken } from '../account/guest.mjs';

const A = 'acc_' + 'a'.repeat(24);
const B = 'acc_' + 'b'.repeat(24);
const guestKey = randomBytes(32);

async function open(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-one-chat-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'guest-one-chat' });
  const accountOf = id => ({ identityVersion: 2, realm: 'account', accountId: id, accountName: id === A ? 'Alice' : 'Bob', loginId: `login-${id}`,
    credentialId: `cred-${id}`, loginGeneration: 1, expiresAt: Date.now() + 600_000, accountEventSeq: 0 });
  const authority = createAccountAuthority({ ledger, pollMs: 0, guestKey,
    accountClient: {
      async verify(token) { if (token !== A && token !== B) throw Object.assign(new Error('bad token'), { status: 401, code: 'unauthorized' }); return accountOf(token); },
      async events() { return { events: [], headSeq: 0 }; },
    },
    initializeProject: async () => ({ contentId: 'content' }) });
  await authority.start();
  const conversations = createConversationAuthority({ ledger, accountAuthority: authority,
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal, projectId, selectionInput }) => ({ projectId, accountId: principal.accountId,
      pageId: selectionInput?.pageId ?? 'page_1', selection: selectionInput?.selection ?? { clipIds: [] }, sentAt: 100, source: 'sent-snapshot' }),
    runHooks: { fenceInState() {} }, onFence: async value => ({ ack: true, ...value }) });
  t.after(() => { authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let serial = 0;
  const create = (token) => { serial++; return authority.createProject({ accessToken: token }, { name: `proj-${serial}`, requestId: `req-${serial}` }); };
  let sendSerial = 0;
  /** 直接发给对话权威：和页面带不带「新对话」按钮无关，新对话号就是新建 */
  const send = (token, projectId, conversationId, content = 'hello') => conversations.send({ principalRef: { accessToken: token },
    projectId, conversationId, requestId: `send-${++sendSerial}`, content, selectionInput: { pageId: 'page_1', selection: { clipIds: [] } } });
  const owned = (projectId, accountId) => Object.values(ledger.read().conversationsV2?.[projectId] ?? {}).filter(c => c.ownerAccountId === accountId);
  return { authority, conversations, ledger, create, send, owned };
}
const code = async promise => { try { await promise; return null; } catch (error) { return { status: error.status, code: error.code ?? error.message }; } };
const guest = () => signGuestToken({ key: guestKey, at: Date.now() });

test('GOC-1 游客在自己的项目里建第一条对话成功，往这条里接着发也成功', async t => {
  const { create, send, owned } = await open(t);
  const g = guest();
  const { projectId } = await create(g.token);
  const first = await send(g.token, projectId, 'chat-1', '你好');
  assert.equal(first.conversation.ownerAccountId, g.guestId);
  assert.ok(first.messageId);
  // 往已有的对话里发不是「新建」，不受这条限额影响
  const again = await send(g.token, projectId, 'chat-1', '再说一句');
  assert.equal(again.queuePosition, 2);
  assert.equal(owned(projectId, g.guestId).length, 1);
});

test('GOC-2 游客建第二条对话被拒，错误码是 guest-chat-limit（403），账本里仍只有一条；已有的那条照常能发', async t => {
  const { create, send, owned } = await open(t);
  const g = guest();
  const { projectId } = await create(g.token);
  await send(g.token, projectId, 'chat-1');
  assert.deepEqual(await code(send(g.token, projectId, 'chat-2')), { status: 403, code: 'guest-chat-limit' });
  assert.deepEqual(await code(send(g.token, projectId, 'chat-3', '换个对话号再试')), { status: 403, code: 'guest-chat-limit' }, '换对话号也拦');
  assert.deepEqual(owned(projectId, g.guestId).map(c => c.id), ['chat-1'], '被拒的不留半条对话');
  assert.equal((await send(g.token, projectId, 'chat-1', '老对话')).queuePosition, 2);
  assert.equal(GUEST_LIMITS.conversations, 1);
  assert.match(GUEST_ERROR_TEXT['guest-chat-limit'], /只能开 1 个/);
});

test('GOC-3 两个新对话号同时发：事务里先到的成、后到的被拒，不会各成各的', async t => {
  const { create, send, owned } = await open(t);
  const g = guest();
  const { projectId } = await create(g.token);
  const results = await Promise.all(['chat-a', 'chat-b', 'chat-c'].map(id => code(send(g.token, projectId, id))));
  assert.equal(results.filter(r => r === null).length, 1, '只有一条建成');
  assert.deepEqual(results.filter(r => r !== null), [{ status: 403, code: 'guest-chat-limit' }, { status: 403, code: 'guest-chat-limit' }]);
  assert.equal(owned(projectId, g.guestId).length, 1);
});

test('GOC-4 登录账号不受影响：同一个项目里照常建多条；账号的 50 条上限还在', async t => {
  const { create, send, owned } = await open(t);
  const { projectId } = await create(A);
  for (let i = 0; i < 3; i++) assert.ok((await send(A, projectId, `acc-chat-${i}`)).messageId, `账号第 ${i + 1} 条`);
  assert.equal(owned(projectId, A).length, 3);
  for (let i = 3; i < MAX_CONVERSATIONS_PER_OWNER; i++) await send(A, projectId, `acc-chat-${i}`);
  assert.deepEqual(await code(send(A, projectId, 'acc-chat-over')), { status: 409, code: 'conversation-limit' }, '账号的上限仍是 50，码不变');
});

test('GOC-5 限额按人、按项目数：游客甲建满不影响游客乙；账号的项目里游客只读、本来就发不了', async t => {
  const { create, send, authority, owned } = await open(t);
  const g1 = guest(), g2 = guest();
  const p1 = (await create(g1.token)).projectId, p2 = (await create(g2.token)).projectId;
  await send(g1.token, p1, 'chat-1');
  assert.ok((await send(g2.token, p2, 'chat-1')).messageId, '换一个游客身份各有各的一条');
  assert.deepEqual(await code(send(g1.token, p1, 'chat-2')), { status: 403, code: 'guest-chat-limit' });
  // 游客进别人的项目是只读，发消息先死在只读这一关，不是对话数
  const accountProject = (await create(A)).projectId;
  await authority.joinProject({ accessToken: g1.token }, { projectId: accountProject, requestId: 'join-1' });
  assert.deepEqual(await code(send(g1.token, accountProject, 'chat-x')), { status: 403, code: 'guest-read-only' });
  assert.equal(owned(accountProject, g1.guestId).length, 0);
});

test('GOC-6 上限定下来之前留下的多于一条的游客历史对话：不删不动，照常能往里发，只是不让再建', async t => {
  const { create, send, ledger, owned } = await open(t);
  const g = guest();
  const { projectId } = await create(g.token);
  await send(g.token, projectId, 'old-1');
  // 把账本改成「历史上留下了三条」：模拟这条规矩定下来之前游客已经建了几条
  ledger.transaction(state => {
    const rows = state.conversationsV2[projectId];
    for (const id of ['old-2', 'old-3']) rows[id] = { ...structuredClone(rows['old-1']), id };
  });
  assert.equal(owned(projectId, g.guestId).length, 3);
  assert.ok((await send(g.token, projectId, 'old-2', '接着聊')).messageId, '老对话照常能发');
  assert.ok((await send(g.token, projectId, 'old-3', '接着聊')).messageId);
  assert.deepEqual(await code(send(g.token, projectId, 'brand-new')), { status: 403, code: 'guest-chat-limit' });
  assert.equal(owned(projectId, g.guestId).length, 3, '历史对话一条没少');
});

test('GOC-7 删掉那一条之后，名额让出来，游客可以再建一条（只管「现有几条」，不记「建过几条」）', async t => {
  const { create, send, ledger, owned } = await open(t);
  const g = guest();
  const { projectId } = await create(g.token);
  await send(g.token, projectId, 'chat-1');
  assert.deepEqual(await code(send(g.token, projectId, 'chat-2')), { status: 403, code: 'guest-chat-limit' });
  // 删除的流程另有测试（conversation-delete*.test.mjs）；这里只证明名额按「现有行数」算
  ledger.transaction(state => { delete state.conversationsV2[projectId]['chat-1']; });
  assert.ok((await send(g.token, projectId, 'chat-2')).messageId);
  assert.deepEqual(owned(projectId, g.guestId).map(c => c.id), ['chat-2']);
});

test('GOC-8 判断函数：只认游客编号，账号一律放行；没传数当 0', () => {
  const gid = 'gst_' + 'a'.repeat(24);
  assert.equal(guestChatLimitReached({ accountId: gid, ownedCount: 0 }), false);
  assert.equal(guestChatLimitReached({ accountId: gid }), false);
  assert.equal(guestChatLimitReached({ accountId: gid, ownedCount: 1 }), true);
  assert.equal(guestChatLimitReached({ accountId: gid, ownedCount: 7 }), true);
  assert.equal(guestChatLimitReached({ accountId: A, ownedCount: 1000 }), false);
});
