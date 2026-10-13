/**
 * 账号云端项目里的卡片源码同步:真的账号服务、文档服务、素材服务(`fixtures/account-dual-user-path.mjs`),
 * 两个账号各起一份编辑器进程里的那套同步(`server/card-sync.mjs` 的规则 + `server/account-card-link.mjs` 的连接),
 * 文件用内存里的替身。报告 `docs/reports/AGENT-v18-cardsync.md`。
 *
 * 跑:npm test -- server/test/account-card-sync.test.mjs(要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE)
 *
 * 一条用例走完(服务只起一次),分步核对:
 *   1 甲带着一张用户卡进项目 → 传上内容库;乙对账时装上
 *   2 甲改这张卡 → 乙装上新版本
 *   3 另一条账号连接(模拟云端 Agent 直接写内容库)写一张新卡 → 甲、乙都装上
 *   4 旧办法的 `auth.ticket`、`service.*` 在账号连接上仍被拒(闸没放宽)
 *   5 乙被改成只读:读照常,写被拒(not-listed),内容库不变;改回可写后能写
 *   6 别的项目:乙拿不到那个项目的会话;在本项目的连接上点名别的项目写被拒(project-mismatch),那个项目的内容库是空的
 *   7 传输断一次:同一个会话接续(不带票据,服务端按会话里的身份重新核对),不重建会话
 *   7b 连接的寿命:按票据的到期时刻提前换会话,换过之后收发照常(真服务,到期时刻报成 12 秒后)
 *   7c 真的到期(等访问令牌的 120 秒过去):没按时换的连接被闸拒,端点当场换会话并补传;按时换的连接从头到尾没被拒过
 *   8 乙被踢:连接被服务端关掉,再取票据被拒,甲之后的版本乙拿不到
 *   9 项目被删:连接被关,会话接口回 404
 *  10 甲退出登录:连接被关,会话接口回 401,手里没过期的旧票据也连不进去
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import WS from 'ws';
import { startAccountDualUserFixture } from './fixtures/account-dual-user-path.mjs';
import { freePorts } from './free-ports.mjs';
import { createCardSync, CARD_SOURCE } from '../card-sync.mjs';
import { accountCardProtocols, cardSyncConnect } from '../account-card-link.mjs';

const CARD = 'src/cards/user/acct-sync-probe.tsx';
const AGENT_CARD = 'src/cards/user/acct-sync-agent.tsx';
const src = (mark) => `export const mark = "${mark}";\n`;

const waitFor = async (check, label, ms = 20_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
};

test('账号云端项目的卡片源码同步:上传、装上、只读、别的项目、被踢、项目被删、退出登录', { timeout: 420_000 }, async (t) => {
  const fixture = await startAccountDualUserFixture({ ports: await freePorts(7) });
  const ca = fs.readFileSync(fixture.caFile);
  const origin = fixture.origin;
  const wsUrl = `${origin.replace(/^https:/, 'wss:')}/hosted/`;
  const closers = [];
  const post = (route, body, token) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(new URL(route, origin), { method: 'POST', ca, timeout: 10_000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); } });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });

  let seq = 0;
  /** 桌面版的登录:外壳的账号桥走的就是这条接口(`desktop/src-tauri/src/account_vault.rs` 的 login) */
  async function login(i) {
    const deviceId = `cardsync-dev-${i}`;
    const r = await post('/api/account/editor/login', { name: fixture.accounts[i].name, password: fixture.accounts[i].password,
      deviceId, deviceName: `card sync ${i}`, requestId: `cs-login-${i}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { token: r.body.accessToken, tokenExpiresAt: r.body.accessExpiresAt, recovery: r.body.recoveryToken, accountId: r.body.account.id, deviceId, out: false };
  }
  /** 访问令牌剩不到 10 秒就续(页面的账号客户端同一个规矩,`src/account/client.ts` 的 `ensureLogin`);退出登录之后不续 */
  async function ensureToken(who) {
    if (who.out || who.tokenExpiresAt > Date.now() + 10_000) return;
    who.renewing ??= post('/api/account/editor/recover', { recoveryToken: who.recovery, deviceId: who.deviceId, requestId: `cs-rec-${++seq}` }).then((r) => {
      if (r.status === 200) { who.token = r.body.accessToken; who.tokenExpiresAt = r.body.accessExpiresAt; who.recovery = r.body.recoveryToken; who.tokenRenewals = (who.tokenRenewals ?? 0) + 1; }
    }).finally(() => { who.renewing = null; });
    await who.renewing;
  }
  const session = async (who, projectId) => { await ensureToken(who); return post('/hosted/shared/account/session', { projectId, deviceId: who.deviceId, requestId: `cs-s-${++seq}` }, who.token); };
  const admin = async (who, projectId, body) => {
    const s = await session(who, projectId);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return post('/hosted/shared/account/admin', { projectId, expectedAccessRevision: s.body.accessRevision, requestId: `cs-a-${++seq}`, ...body }, who.token);
  };

  /** 编辑器进程里的那套同步,文件在内存里 */
  function editor(who, projectId, initial = {}, { expiresAt = (real) => real } = {}) {
    const files = new Map(Object.entries(initial));
    const log = [];
    const tickets = { ok: 0, refused: [] };
    /** `ws` 包带上夹具的根证书(Node 自带的 WebSocket 没法给单条连接指定根证书);记下开过的传输,好掐断 */
    const sockets = [];
    class CaWebSocket extends WS { constructor(url, protocols) { super(url, protocols, { ca }); sockets.push(this); } }
    const sync = createCardSync({
      stateDir: null,
      retryMs: 300,
      files: {
        read: (rel) => files.get(rel) ?? null,
        changed: (rel) => files.has(rel),
        backup: (rel) => `backup/${rel}`,
        install: (rel, source) => { files.set(rel, source); return { ok: true }; },
      },
      // 与编辑器进程里的同一个端点选择(`vite-plugin-cards.ts`),只把 WebSocket 换成带根证书的
      connect: cardSyncConnect((event, fields) => log.push({ event, ...fields }), { WebSocket: CaWebSocket }),
      log: (event, fields) => log.push({ event, ...fields }),
    });
    const getTicket = async () => {
      const s = await session(who, projectId);
      if (s.status !== 200) { tickets.refused.push({ status: s.status, code: s.body.code }); throw Object.assign(new Error(s.body.code), { status: s.status }); }
      tickets.ok++;
      return { ticket: s.body.connectionTicket, expiresAt: expiresAt(s.body.expiresAt) };
    };
    sync.bind({ projectId, url: wsUrl, protocols: accountCardProtocols(getTicket), keys: Object.keys(initial) });
    closers.push(() => sync.close());
    const cut = () => { for (const socket of sockets) if (socket.readyState === WS.OPEN) socket.terminate(); };
    const renews = () => log.filter((e) => e.event === 'doc.account.renew');
    return { sync, files, log, tickets, cut, renews, connected: () => sync.status().connected, record: (rel) => sync.status().records?.[rel] ?? null };
  }

  /** 一条裸的账号连接:发一条消息等回包 */
  async function raw(ticket, message) {
    const socket = new WS(wsUrl, ['promptcut.v1', `promptcut.account.${ticket}`], { ca, handshakeTimeout: 5000 });
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('raw timeout')), 8000);
        socket.on('message', (bytes) => {
          let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { return; }
          if (m.reqId === 'raw') { clearTimeout(timer); resolve(m); }
        });
      });
      socket.send(JSON.stringify({ ...message, reqId: 'raw' }));
      return await reply;
    } finally { socket.terminate(); }
  }
  const rawAs = async (who, projectId, message) => {
    const s = await session(who, projectId);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return raw(s.body.connectionTicket, message);
  };

  try {
    const projectId = fixture.projectId;
    const [alice, bob] = [await login(0), await login(1)];
    const loggedInAt = Date.now();

    // ---- 1 甲带着一张用户卡进项目;乙对账时装上
    const a = editor(alice, projectId, { [CARD]: src('v1') });
    await waitFor(() => a.record(CARD)?.rev === 1, '甲把卡传上内容库');
    assert.equal(a.record(CARD).mine, true);
    const b = editor(bob, projectId);
    await waitFor(() => b.files.get(CARD) === src('v1'), '乙装上甲的卡');
    assert.deepEqual({ rev: b.record(CARD).rev, mine: b.record(CARD).mine }, { rev: 1, mine: false });
    t.diagnostic('1 甲上传 rev 1,乙装上');

    // ---- 2 甲改卡,乙装上新版本
    a.files.set(CARD, src('v2'));
    a.sync.saved(CARD);
    await waitFor(() => b.files.get(CARD) === src('v2'), '乙装上 v2');
    assert.equal(b.record(CARD).rev, 2);
    const installed = b.sync.status().notices.filter((n) => n.type === 'installed' && n.key === CARD);
    assert.deepEqual(installed.map((n) => n.rev), [1, 2]);
    assert.equal(installed[1].actor.accountId, alice.accountId, '写入身份取自连接,是甲的账号');
    assert.equal(installed[1].actor.role, 'page', '角色仍是 page');
    t.diagnostic('2 甲改成 v2,乙装上 rev 2,写入身份是甲的账号、角色 page');

    // ---- 3 另一条账号连接直接写内容库(模拟云端 Agent 建卡):甲、乙都装上
    const put = await rawAs(alice, projectId, { type: 'content.put', kind: CARD_SOURCE, key: AGENT_CARD, body: src('agent'), session: 'cloud-agent-sim' });
    assert.equal(put.type, 'content.stored', JSON.stringify(put));
    await waitFor(() => a.files.get(AGENT_CARD) === src('agent') && b.files.get(AGENT_CARD) === src('agent'), '甲、乙都装上直接写进内容库的卡');
    t.diagnostic('3 直接写进内容库的卡,甲、乙都装上');

    // ---- 4 旧办法在账号连接上仍被拒
    for (const message of [{ type: 'auth.ticket', kind: 'conn', role: 'page' }, { type: 'service.watch', kinds: ['asset'] }]) {
      const r = await rawAs(alice, projectId, message);
      assert.deepEqual([r.type, r.reason], ['error', 'forbidden'], `${message.type} ${JSON.stringify(r)}`);
    }
    t.diagnostic('4 auth.ticket、service.watch 在账号连接上回 forbidden');

    // ---- 5 乙改成只读
    const toReadonly = await admin(alice, projectId, { op: 'set-list', members: [{ accountId: bob.accountId, access: 'r' }] });
    assert.equal(toReadonly.status, 200, JSON.stringify(toReadonly.body));
    assert.equal((await session(bob, projectId)).body.access, 'r');
    const roGet = await rawAs(bob, projectId, { type: 'content.get', kind: CARD_SOURCE, key: CARD });
    assert.equal(roGet.body, src('v2'), '只读成员照常读');
    const roPut = await rawAs(bob, projectId, { type: 'content.put', kind: CARD_SOURCE, key: CARD, body: src('bob-ro') });
    assert.deepEqual([roPut.type, roPut.reason], ['error', 'not-listed'], JSON.stringify(roPut));
    // 乙的编辑器进程那一侧:权限变化时连接被服务端关过一次,重连后上传被拒
    await waitFor(() => b.connected(), '乙的同步在只读下重新连上');
    b.files.set(CARD, src('bob-ro'));
    b.sync.saved(CARD);
    await waitFor(() => b.log.some((e) => e.event === 'cards.sync.put-failed' && e.code === 'not-listed'), '乙的上传被拒');
    const afterRo = await rawAs(alice, projectId, { type: 'content.get', kind: CARD_SOURCE, key: CARD });
    assert.deepEqual([afterRo.body, afterRo.rev], [src('v2'), 2], '只读成员没有写进内容库');
    assert.equal(a.files.get(CARD), src('v2'));
    // 改回可写:乙那份待上传的补传上去
    const toRw = await admin(alice, projectId, { op: 'set-list', members: [{ accountId: bob.accountId, access: 'rw' }] });
    assert.equal(toRw.status, 200, JSON.stringify(toRw.body));
    await waitFor(() => a.files.get(CARD) === src('bob-ro'), '改回可写后乙的版本传上去、甲装上');
    assert.equal(a.record(CARD).rev, 3);
    t.diagnostic('5 只读成员:读可以,写回 not-listed,内容库停在 rev 2;改回可写后补传成 rev 3');

    // ---- 6 别的项目
    const other = await post('/hosted/shared/account/create', { name: 'card sync other project', requestId: 'cs-create-2', allowLinkJoin: false, initialProject: { tracks: [] } }, alice.token);
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const otherId = other.body.projectId;
    const refused = await session(bob, otherId);
    assert.deepEqual([refused.status, refused.body.code], [403, 'not-listed']);
    const cross = await rawAs(bob, projectId, { type: 'content.put', projectId: otherId, kind: CARD_SOURCE, key: 'src/cards/user/cross.tsx', body: src('cross') });
    assert.deepEqual([cross.type, cross.reason], ['error', 'project-mismatch'], JSON.stringify(cross));
    const otherList = await rawAs(alice, otherId, { type: 'content.list', kind: CARD_SOURCE, prefix: 'src/' });
    assert.deepEqual(otherList.items, [], '本项目的写没有进别的项目的内容库');
    t.diagnostic('6 别的项目:会话 403 not-listed,点名别的项目写回 project-mismatch,那个项目内容库为空');

    // ---- 7 传输断一次:同一个会话接续,不重建
    const before = { opens: b.sync.status().opens, resumes: b.sync.status().resumes, tickets: b.tickets.ok };
    assert.ok(b.sync.status().link, '端点是会话');
    // 掐掉本端这条传输(不是会话结束):会话层按传输断开处理,凭会话号接续
    b.cut();
    await waitFor(() => b.sync.status().resumes === before.resumes + 1, '乙的同步接续');
    assert.equal(b.sync.status().opens, before.opens, '没有重建会话');
    assert.equal(b.tickets.ok, before.tickets, '接续不取票据');
    a.files.set(CARD, src('v4'));
    a.sync.saved(CARD);
    await waitFor(() => b.files.get(CARD) === src('v4'), '接续之后乙照常装上');
    t.diagnostic('7 传输断一次:接续 +1、会话数不变、没有再取票据,之后照常同步');

    // ---- 7b 连接的寿命:账号连接只能用到票据到期,到期前换一个会话(这里把到期时刻报成 12 秒后,真服务上连换几次)
    const c = editor(bob, projectId, {}, { expiresAt: () => Date.now() + 12_000 });
    await waitFor(() => c.files.get(CARD) === src('v4'), '丙(乙的另一台设备)对账装上');
    await waitFor(() => c.renews().length >= 2 && c.connected(), '丙按到期时刻换了两次会话', 30_000);
    assert.ok(c.renews().every((e) => e.why === 'ticket-expiring'));
    assert.ok(c.tickets.ok >= 3, '每个新会话现取一张票据');
    a.files.set(CARD, src('v4b'));
    a.sync.saved(CARD);
    await waitFor(() => c.files.get(CARD) === src('v4b'), '换过会话之后丙照常装上别人的版本');
    c.files.set(AGENT_CARD, src('from-c'));
    c.sync.saved(AGENT_CARD);
    await waitFor(() => a.files.get(AGENT_CARD) === src('from-c'), '换过会话之后丙的改动照常传上去');
    assert.equal(c.sync.status().notices.filter((n) => n.type === 'installed' && n.key === CARD && n.rev === 5).length, 1, '同一版只装一次');
    t.diagnostic(`7b 按票据到期换会话 ${c.renews().length} 次(取票据 ${c.tickets.ok} 次),换过之后收发照常`);

    // ---- 7c 真的到期:一条不按时换的连接(到期时刻故意报成很久以后),访问令牌到期后闸回 credential-revoked,端点当场换会话、补传
    const d = editor(alice, projectId, {}, { expiresAt: () => Date.now() + 600_000 });
    await waitFor(() => d.files.get(CARD) === src('v4b'), '丁(甲的另一台设备)对账装上');
    const dTicketExpiry = loggedInAt + 120_000;
    assert.equal(d.renews().length, 0);
    t.diagnostic(`7c 等甲登录时那张访问令牌到期(还有 ${Math.max(0, Math.round((dTicketExpiry - Date.now()) / 1000))} 秒)`);
    await new Promise((r) => setTimeout(r, Math.max(0, dTicketExpiry - Date.now()) + 2_000));
    const LATE = 'src/cards/user/acct-sync-late.tsx';
    d.files.set(LATE, src('after-expiry'));
    d.sync.saved(LATE);
    await waitFor(() => d.renews().some((e) => e.why === 'credential-revoked' || e.why === 'authorization-expired'), '到期的连接被闸拒,端点换会话');
    await waitFor(() => a.files.get(LATE) === src('after-expiry'), '换会话之后补传成功,甲装上', 30_000);
    assert.ok(alice.tokenRenewals >= 1, '期间访问令牌续过');
    assert.ok(a.renews().length >= 1 && a.renews().every((e) => e.why === 'ticket-expiring'), '甲那条按时换的连接没等到被拒');
    assert.ok(!a.log.some((e) => e.event === 'cards.sync.put-failed' && /credential-revoked|authorization-expired/.test(e.code ?? '')), '按时换的连接没有因为到期丢过上传');
    t.diagnostic(`7c 访问令牌到期后:没按时换的连接被闸拒(${d.renews().map((e) => e.why).join(',')})并当场换会话补传;按时换的连接换了 ${a.renews().length} 次、没被拒过`);

    // ---- 8 乙被踢
    const kicked = await admin(alice, projectId, { op: 'kick', accountId: bob.accountId });
    assert.equal(kicked.status, 200, JSON.stringify(kicked.body));
    await waitFor(() => !b.connected(), '乙的同步连接被关');
    await waitFor(() => b.tickets.refused.some((r) => r.status === 403 && r.code === 'banned'), '乙再取票据被拒');
    a.files.set(CARD, src('v5'));
    a.sync.saved(CARD);
    await waitFor(() => a.sync.status().pending.length === 0 && a.log.some((e) => e.event === 'cards.sync.put' && e.key === CARD && e.rev === 6), '甲传上 v5');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(b.files.get(CARD), src('v4b'), '被踢之后的版本乙拿不到');
    assert.equal(c.files.get(CARD), src('v4b'), '乙的另一台设备也拿不到');
    assert.equal(c.connected(), false);
    assert.equal(b.connected(), false);
    t.diagnostic(`8 乙被踢:连接被关,取票据回 403 banned(${b.tickets.refused.length} 次都被拒),甲的 v5 乙没拿到`);

    // ---- 9 项目被删(另一个项目,甲是创建者)
    const a2 = editor(alice, otherId, { [CARD]: src('other-v1') });
    await waitFor(() => a2.record(CARD)?.rev === 1, '甲在另一个项目里传上卡');
    const deleted = await admin(alice, otherId, { op: 'delete' });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    await waitFor(() => !a2.connected(), '被删项目的同步连接被关');
    await waitFor(() => a2.tickets.refused.some((r) => r.status === 404), '被删项目再取票据回 404');
    t.diagnostic(`9 项目被删:连接被关,取票据回 ${JSON.stringify(a2.tickets.refused[0])}`);

    // ---- 10 甲退出登录
    const held = await session(alice, projectId);
    assert.equal(held.status, 200);
    alice.out = true;
    const out = await post('/api/account/editor/logout', {}, alice.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    await waitFor(() => !a.connected(), '甲退出登录后同步连接被关');
    await waitFor(() => a.tickets.refused.some((r) => r.status === 401), '甲再取票据回 401');
    await assert.rejects(raw(held.body.connectionTicket, { type: 'content.list', kind: CARD_SOURCE }), '退出登录前取的、还没过期的票据也连不进去');
    assert.equal(a.connected(), false);
    t.diagnostic(`10 甲退出登录:连接被关,取票据回 ${JSON.stringify(a.tickets.refused.at(-1))},旧票据握手被拒`);
  } finally {
    for (const close of closers) { try { close(); } catch { /* 已经关了 */ } }
    const state = await fixture.close();
    assert.equal(state.closed, true);
    assert.equal(state.childClosed, true);
  }
});
