/**
 * 账号云端项目里,页面那条文档连接的寿命:真的账号服务、文档服务、素材服务(`fixtures/account-dual-user-path.mjs`),
 * 页面一侧用真的 `SyncLink` + `DocSync` + `accountLinkLife`(`enterAccountProject` 用的同一套),只有 WebSocket 换成带根证书的。
 * 报告 `docs/reports/AGENT-v18-cardsync.md`。
 *
 * 跑:npm test -- server/test/account-page-link.test.mjs(要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE)
 *
 * 一条用例(服务只起一次;访问令牌是真实的 120 秒寿命,全程约 150 秒):
 *   1  登录 30 秒时甲改一次:乙看得到,服务端版本前进
 *   2  换会话不丢改动(把到期时刻报成 8 秒后,真服务上连换几次):丙连续改 24 次、乙同时连续改 24 次,
 *      换了至少 4 次会话,两边与服务端最后一致,48 处改动一处不少,没有被拒、没有转离线、没有重同步
 *   1b 传输断一次:几秒内在同一个会话上接回(原问题:接续带了票据,文档服务回 400,白等 60 秒保留期过完才重建会话)
 *   3  账号服务一时不通:到期还没换成 → 页面如实转离线(不是「在线」);离线时的改动不丢,通了之后补发
 *   4  登录 130 秒时(原问题:161 秒时放片段,服务端版本 10 → 10、对方看不到、页面仍显示在线)甲再改一次:
 *      乙看得到,服务端版本前进;甲的连接按时换过、从头到尾没被闸拒过
 *   5  睡眠醒来:丁的计时器从进项目起就停着(不换会话),130 秒后改一次 → 被闸拒 → 当场换会话 → 补发成功,乙看得到
 *   5b 可写改只读:服务端关掉旧连接(4003),页面凭新票据重新连上(不当成被踢),照常收到别人的改动;改回可写后照常写
 *   6  被踢:连接被服务端关,重连时取票据回 403 banned,不再重连,页面不在线
 *   7  项目被删:连接被关、不在线
 *   8  退出登录:连接被关、换会话取票据回 401,页面不在线
 *
 * 复现原问题(先红):`ACCOUNT_PAGE_LINK_REPRO_OLD=1 npm test -- server/test/account-page-link.test.mjs`
 * —— 甲、丁不换会话也不理会「凭证到期」、乙接续时带票据(改之前的页面就是这样):
 *    第 1b 步红(接续不上);去掉 1b 的断言再跑,第 4 步红(130 秒时的改动服务端版本不动、乙看不到、甲仍显示在线)。
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import WS from 'ws';
import { startAccountDualUserFixture } from './fixtures/account-dual-user-path.mjs';

const { SyncLink } = await import(srcUrl('editor/sync/link.ts'));
const { createAccountLinkLife } = await import(srcUrl('editor/sync/accountLinkLife.ts'));

const PORTS = [28660, 28661, 28662, 28663, 28664, 28665, 28666];
const OLD = process.env.ACCOUNT_PAGE_LINK_REPRO_OLD === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check, label, ms = 20_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout: ${label}`);
    await sleep(40);
  }
};

test('账号云端项目里页面的文档连接:到期前换会话、换的时候不丢改动、换不成如实转离线、过期后自己恢复', { timeout: 420_000 }, async (t) => {
  const fixture = await startAccountDualUserFixture({ ports: PORTS });
  const ca = fs.readFileSync(fixture.caFile);
  const origin = fixture.origin;
  const wsUrl = `${origin.replace(/^https:/, 'wss:')}/hosted/`;
  const projectId = fixture.projectId;
  const closers = [];
  class CaWebSocket extends WS { constructor(url, protocols) { super(url, protocols, { ca }); } }
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
  async function login(i, device) {
    const r = await post('/api/account/editor/login', { name: fixture.accounts[i].name, password: fixture.accounts[i].password, deviceId: device, deviceName: device, requestId: `pl-login-${device}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { token: r.body.accessToken, tokenExpiresAt: r.body.accessExpiresAt, recovery: r.body.recoveryToken, accountId: r.body.account.id, deviceId: device, out: false, down: false, tokenRenewals: 0 };
  }
  /** 账号客户端续访问令牌的规矩(`src/account/client.ts` 的 `ensureLogin`):剩不到 `minRemainingMs` 就续 */
  async function ensureToken(who, minRemainingMs = 10_000) {
    if (who.out || who.tokenExpiresAt > Date.now() + minRemainingMs) return;
    who.renewing ??= post('/api/account/editor/recover', { recoveryToken: who.recovery, deviceId: who.deviceId, requestId: `pl-rec-${++seq}` }).then((r) => {
      if (r.status === 200) { who.token = r.body.accessToken; who.tokenExpiresAt = r.body.accessExpiresAt; who.recovery = r.body.recoveryToken; who.tokenRenewals += 1; }
    }).finally(() => { who.renewing = null; });
    await who.renewing;
  }
  /** `CloudAccountClient.session` 的替身:同样的接口、同样的失败形状;`who.down` 模拟账号服务一时不通 */
  async function session(who, minRemainingMs) {
    if (who.down) throw Object.assign(new Error('account-unavailable'), { status: 503, code: 'account-unavailable' });
    await ensureToken(who, minRemainingMs);
    const s = await post('/hosted/shared/account/session', { projectId, deviceId: who.deviceId, requestId: `pl-s-${++seq}` }, who.token);
    if (s.status !== 200) throw Object.assign(new Error(s.body.code), { status: s.status, code: s.body.code });
    return s.body;
  }
  const admin = async (who, body) => {
    const s = await session(who);
    return post('/hosted/shared/account/admin', { projectId, expectedAccessRevision: s.accessRevision, requestId: `pl-a-${++seq}`, ...body }, who.token);
  };

  /**
   * 一个页面。`reportExpiry`:把票据的到期时刻报成什么(缺省照实);`ticking`:计时器走不走(假 = 睡着);
   * `renewing`:换不换会话、理不理会「凭证到期」(假 = 改之前的页面)。
   */
  function page(name, who, { reportExpiry = (real) => real, ticking = true, renewing = true, resumeWithTicket = false, lifeOptions = {} } = {}) {
    const p = { name, who, terminal: [], closes: [], notices: [], authExpired: [], statuses: [], sessions: 0, ticking };
    const life = createAccountLinkLife({
      session: async ({ minRemainingMs }) => { const s = await session(who, minRemainingMs); p.sessions += 1; return { connectionTicket: s.connectionTicket, expiresAt: reportExpiry(s.expiresAt) }; },
      link: () => link,
      onTerminal: (error) => { p.terminal.push({ status: error?.status, code: error?.code }); link.stop(); },
      ...lifeOptions,
    });
    const link = new SyncLink({
      url: wsUrl, projectId, session: `page-${who.deviceId}-${++seq}`, initial: { tracks: [] }, initialize: false, WebSocketImpl: CaWebSocket,
      protocols: async () => ['promptcut.v1', `promptcut.account.${await life.ticket()}`],
      // 改之前的页面接续时也带票据(文档服务回 400)
      ...(resumeWithTicket ? { resumeProtocols: async () => ['promptcut.v1', `promptcut.account.${(await session(who, 10_000)).connectionTicket}`] } : {}),
      onOpen: () => life.opened(),
      onAuthExpired: (reason) => { p.authExpired.push(reason); if (renewing) void life.authExpired(); },
      onClosed: (info) => p.closes.push({ code: info.code, reason: info.reason, fatal: info.fatal }),
      // 与 `enterAccountProject` 相同:关闭码不当终局,取票据的接口回 401 / 403 / 404 才收场
      isFatalClose: () => false,
      onProtocolError: (error) => { if ([401, 403, 404].includes(error?.status)) { p.terminal.push({ status: error.status, code: error.code }); return true; } return false; },
      reconnect: { minMs: 200, maxMs: 1000 },
      onMessage: (m) => { if (process.env.PL_DEBUG) console.log(name, '<~', m.type, m.reason ?? '', m.detail ?? ''); },
    });
    // 别人的改动到了(remote)是正常的,不记;记的是被拒、重同步、丢弃、被覆盖这些
    link.ds.on('notice', (n) => n.kind !== 'remote' && p.notices.push(n.kind === 'rejected' ? `rejected:${n.reason}` : n.kind === 'resync' ? `resync:${n.reason}` : n.kind));
    if (process.env.PL_DEBUG) { const r = link.ds.receive.bind(link.ds); link.ds.receive = (m) => { console.log(name, '<-', m.type, m.rev ?? '', m.reason ?? ''); return r(m); }; }
    link.ds.on('status', (s) => p.statuses.push(s));
    const timer = setInterval(() => { if (p.ticking && renewing) void life.tick(); }, 500);
    // 页面每 3 秒续一次会话读项目的状态(`enterAccountProject` 的那个定时),读到自己的权限就报给寿命模块
    const poll = setInterval(() => { if (p.ticking && renewing && link.connected) void session(who).then((s) => life.accessSeen(s.access), () => undefined); }, 2000);
    closers.push(() => { clearInterval(timer); clearInterval(poll); link.stop(); });
    link.start();
    return Object.assign(p, { link, life, ds: link.ds,
      set: (key, value) => link.ds.commit({ ...link.ds.project, [key]: value }),
      get: (key) => link.ds.project?.[key],
      online: () => link.ds.status === 'online' });
  }
  /** 服务端此刻的项目版本:另开一条连接问 */
  async function serverRev(who) {
    const s = await session(who);
    const socket = new WS(wsUrl, ['promptcut.v1', `promptcut.account.${s.connectionTicket}`], { ca, handshakeTimeout: 5000 });
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rev timeout')), 30_000);
        socket.on('message', (bytes) => { let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { return; } if (m.type === 'project.state') { clearTimeout(timer); resolve(m); } });
      });
      socket.send(JSON.stringify({ type: 'project.open', projectId }));
      const m = await reply;
      return { rev: m.rev, project: m.project };
    } finally { socket.terminate(); }
  }

  try {
    const alice = await login(0, 'pl-a');
    const loggedInAt = Date.now();
    const since = () => Math.round((Date.now() - loggedInAt) / 1000);
    const bob = await login(1, 'pl-b');
    const A = page('甲', alice, { renewing: !OLD });
    const B = page('乙', bob, { resumeWithTicket: OLD });
    // 丁:甲的另一个页面,计时器从头就停着(睡着的电脑)
    const D = page('丁', await login(0, 'pl-d'), { ticking: false, renewing: !OLD });
    const dLoginAt = Date.now();
    await waitFor(() => A.online() && B.online() && D.online(), '三个页面进项目');

    // ---- 2 换会话不丢改动(先做,等真到期的那一百来秒里跑):丙把到期时刻报成 8 秒后
    const carol = await login(1, 'pl-c');
    const C = page('丙', carol, { reportExpiry: () => Date.now() + 8_000, lifeOptions: { renewMarginMs: 3_000, minTicketLifeMs: 5_000 } });
    await waitFor(() => C.online(), '丙进项目');
    const revBefore2 = (await serverRev(bob)).rev;
    // 文档服务对账号连接的每次提交都要问账号服务,这台机器上一秒落不了几条,所以改得不快(人手的速度)
    const N = 24;
    for (let i = 0; i < N; i++) {
      C.set(`c${i}`, `丙-${i}`);
      B.set(`b${i}`, `乙-${i}`);
      await sleep(1200);
    }
    await waitFor(() => C.link.ds.unconfirmed === 0 && B.link.ds.unconfirmed === 0, '丙、乙的改动都确认', 60_000);
    const after2 = await serverRev(bob);
    const swaps = C.life.describe().renews;
    assert.ok(swaps >= 4, `丙换了 ${swaps} 次会话`);
    for (let i = 0; i < N; i++) {
      assert.equal(after2.project[`c${i}`], `丙-${i}`, `服务端有丙的第 ${i} 处`);
      assert.equal(after2.project[`b${i}`], `乙-${i}`, `服务端有乙的第 ${i} 处`);
    }
    const canon = (v) => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))));
    await waitFor(() => canon(C.ds.project) === canon(after2.project) && canon(B.ds.project) === canon(after2.project), '丙、乙与服务端一致');
    assert.equal(after2.rev, revBefore2 + 2 * N, `${2 * N} 次改动各落一次`);
    assert.deepEqual(C.notices, [], '丙没有被拒、没有重同步、没有丢弃');
    assert.ok(!C.statuses.includes('offline') && !C.statuses.includes('paused'), `丙没有转离线(${[...new Set(C.statuses)].join(',')})`);
    assert.equal(C.closes.length, 0, '换会话不算断线');
    assert.equal(C.life.describe().expires, 0);
    t.diagnostic(`2 丙换了 ${swaps} 次会话(取会话 ${C.sessions} 次),丙、乙各 ${N} 处改动全部落地,版本 +${2 * N},没有被拒、没有离线`);

    // ---- 1 登录 30 秒时
    await waitFor(() => since() >= 30, '登录满 30 秒', 60_000);
    {
      const rev = (await serverRev(bob)).rev;
      A.set('at30', `甲在 ${since()} 秒`);
      await waitFor(() => typeof B.get('at30') === 'string', '乙看到甲 30 秒时的改动');
      assert.equal((await serverRev(bob)).rev, rev + 1);
      t.diagnostic(`1 登录 ${since()} 秒:甲改一次,乙看得到,版本 ${rev} → ${rev + 1}`);
    }

    // ---- 1b 传输断一次(换网、代理掐断):几秒内在同一个会话上接回,不重建会话
    {
      const before = B.link.stats();
      const t0 = Date.now();
      assert.equal(B.link.cutTransport(), true);
      const resumed = await waitFor(() => (B.link.stats()?.resumes === (before.resumes ?? 0) + 1 && B.link.stats().transport === 'ws' ? Date.now() : null), '乙断一次传输后接回', 10_000).catch(() => null);
      A.set('afterCut', '甲在乙断线之后');
      const seen = await waitFor(() => (B.get('afterCut') ? Date.now() : null), '乙收到断线之后甲的改动', 90_000);
      t.diagnostic(`1b 传输断一次:乙${resumed ? `${resumed - t0} 毫秒接回` : '没接回'},${seen - t0} 毫秒后收到甲之后的改动,${B.closes.length ? `会话丢过(${JSON.stringify(B.closes)})` : '会话没断'}`);
      assert.ok(resumed, '传输断一次之后接续不上(白等保留期过完才重建会话)');
      assert.equal(B.closes.length, 0, '会话没有丢');
      assert.ok(seen - t0 < 10_000);
    }

    // ---- 3 账号服务一时不通:到期还没换成 → 如实转离线;离线时的改动通了之后补发
    {
      carol.down = true;
      const offlineAt = await waitFor(() => (C.ds.status === 'offline' ? Date.now() : null), '丙换不成会话、到期后转离线', 20_000);
      assert.equal(C.life.describe().expires, 1);
      assert.ok(C.closes.some((c) => c.code === 4401 && c.fatal === false), `按连接作废报(${JSON.stringify(C.closes)})`);
      assert.equal(C.terminal.length, 0, '一时不通不是登录失效');
      C.set('offline', '丙离线时改的');
      await sleep(1500);
      assert.equal(C.ds.status, 'offline', '账号服务不通期间一直是离线,不显示在线');
      assert.equal(B.get('offline'), undefined);
      carol.down = false;
      await waitFor(() => B.get('offline') === '丙离线时改的', '账号服务恢复后丙的离线改动补发,乙看得到', 20_000);
      await waitFor(() => C.online() && C.link.ds.unconfirmed === 0, '丙回到在线');
      t.diagnostic(`3 账号服务不通:丙到期后转离线(关闭码 4401,${Date.now() - offlineAt} 毫秒后恢复),离线时的改动恢复后补发`);
      C.ticking = false;
    }

    // ---- 4 登录 130 秒时(原问题的复现)
    await waitFor(() => since() >= 130, '登录满 130 秒', 200_000);
    {
      const rev = (await serverRev(bob)).rev;
      A.set('at130', `甲在 ${since()} 秒`);
      const seen = await waitFor(() => typeof B.get('at130') === 'string', '乙看到甲 130 秒时的改动', 10_000).catch(() => false);
      const revAfter = (await serverRev(bob)).rev;
      t.diagnostic(`4 登录 ${since()} 秒:甲改一次,乙${seen ? '看得到' : '看不到'},版本 ${rev} → ${revAfter},甲显示 ${A.ds.status}、未确认 ${A.link.ds.unconfirmed} 条、换过 ${A.life.describe().renews} 次会话、被闸拒 ${A.authExpired.length} 次`);
      assert.ok(seen, `登录 130 秒后甲的改动乙看不到(服务端版本 ${rev} → ${revAfter},甲仍显示 ${A.ds.status})`);
      assert.equal(revAfter, rev + 1);
      assert.equal(A.link.ds.unconfirmed, 0);
      assert.ok(A.life.describe().renews >= 1, '甲按时换过会话');
      assert.deepEqual(A.authExpired, [], '甲的连接从头到尾没被闸拒过');
      assert.deepEqual(A.notices, []);
      assert.ok(!A.statuses.includes('offline'), '甲没有转过离线');
    }

    // ---- 5 睡眠醒来:丁的计时器一直停着,连接早就过期
    await waitFor(() => Date.now() - dLoginAt >= 125_000, '丁登录满 125 秒', 60_000);
    {
      assert.equal(D.life.describe().renews, 0, '丁睡着,没换过会话');
      const rev = (await serverRev(bob)).rev;
      D.set('woke', '丁醒来改的');
      await waitFor(() => B.get('woke') === '丁醒来改的', '丁被闸拒后当场换会话、补发,乙看得到', 15_000);
      assert.equal((await serverRev(bob)).rev, rev + 1);
      assert.ok(D.authExpired.length >= 1, '丁确实被闸拒过');
      assert.equal(D.life.describe().renews, 1);
      assert.equal(D.link.ds.unconfirmed, 0);
      assert.deepEqual(D.notices, [], '丁的改动没有被撤回或丢弃');
      // 醒来之后计时器恢复,照常
      D.ticking = true;
      D.set('woke2', '丁醒来之后');
      await waitFor(() => B.get('woke2') === '丁醒来之后', '丁之后的改动照常');
      t.diagnostic(`5 睡眠醒来:丁的连接过期后被闸拒(${D.authExpired[0]}),当场换会话补发成功,版本 ${rev} → ${rev + 1}`);
    }

    // ---- 5b 可写改只读:服务端把乙的连接关掉(同样是 4003),乙凭新票据重新连上,能收不能写;改回可写后照常
    {
      const closesBefore = B.closes.length;
      const toR = await admin(alice, { op: 'set-list', members: [{ accountId: bob.accountId, access: 'r' }] });
      assert.equal(toR.status, 200, JSON.stringify(toR.body));
      await waitFor(() => B.closes.length > closesBefore, '乙的连接被服务端关过一次');
      await waitFor(() => B.online(), '乙凭新票据重新连上(没有被当成被踢)', 20_000);
      assert.deepEqual(B.terminal, []);
      A.set('whileReadonly', '甲在乙只读时改的');
      await waitFor(() => B.get('whileReadonly') === '甲在乙只读时改的', '只读的乙照常收到别人的改动');
      const toRw = await admin(alice, { op: 'set-list', members: [{ accountId: bob.accountId, access: 'rw' }] });
      assert.equal(toRw.status, 200, JSON.stringify(toRw.body));
      const renewsBefore = B.life.describe().renews;
      await waitFor(() => B.life.describe().renews > renewsBefore && B.online(), '乙读到权限变了,换了一个会话', 20_000);
      B.set('rwAgain', '乙改回可写之后');
      await waitFor(() => A.get('rwAgain') === '乙改回可写之后', '改回可写后乙的改动甲看得到', 20_000);
      t.diagnostic(`5b 可写改只读:乙的连接被关(${JSON.stringify(B.closes.at(-1))})后重新连上,照常收到别人的改动;改回可写后换一个会话、照常写`);
      C.ticking = true;
      await waitFor(() => C.online(), '丙也回到在线', 20_000);
    }

    // ---- 6 被踢(乙的账号:乙、丙两个页面)
    {
      C.ticking = true;
      const kicked = await admin(alice, { op: 'kick', accountId: bob.accountId });
      assert.equal(kicked.status, 200, JSON.stringify(kicked.body));
      await waitFor(() => !B.link.connected && !C.link.connected, '乙、丙的连接被关');
      // 服务端关连接(4003)之后页面凭新票据重连,取票据回 403 banned:这才是终局
      const final = (p) => p.terminal.some((e) => e.status === 403 && e.code === 'banned');
      await waitFor(() => final(B) && final(C), '乙、丙取票据回 403 banned,不再重连')
        .catch((e) => { throw new Error(`${e.message}:乙 ${JSON.stringify(B.closes)} ${JSON.stringify(B.terminal)} ${JSON.stringify(B.link.stats())};丙 ${JSON.stringify(C.closes)} ${JSON.stringify(C.terminal)}`); });
      assert.ok(!B.online() && !C.online(), '被踢后不显示在线');
      await assert.rejects(session(bob), (e) => e.status === 403 && e.code === 'banned');
      A.set('afterKick', 1);
      await sleep(1000);
      assert.equal(B.get('afterKick'), undefined, '被踢之后的改动乙收不到');
      await sleep(1500);
      assert.ok(!B.link.connected && !C.link.connected, '之后没有再连上');
      t.diagnostic(`6 被踢:乙、丙的连接被关(${JSON.stringify(B.closes.find((c) => c.code === 4003))}),重连时取票据回 ${JSON.stringify(B.terminal.at(-1))},不再重连`);
    }

    // ---- 8 退出登录(丁那个登录):连接被关、取票据回 401
    {
      D.who.out = true;
      const out = await post('/api/account/editor/logout', {}, D.who.token);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      await waitFor(() => !D.link.connected, '丁退出登录后连接被关');
      await waitFor(() => D.terminal.some((e) => e.status === 401), '丁重连时取票据回 401,不再重连');
      assert.ok(!D.online());
      t.diagnostic(`8 退出登录:丁的连接被关(${JSON.stringify(D.closes.at(-1))}),终局 ${JSON.stringify(D.terminal)}`);
    }

    // ---- 7 项目被删(甲还在里面)
    {
      const deleted = await admin(alice, { op: 'delete' });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      await waitFor(() => !A.link.connected, '项目被删后甲的连接被关');
      await waitFor(() => A.terminal.some((e) => e.status === 404), '甲重连时取票据回 404,不再重连');
      assert.ok(!A.online());
      await assert.rejects(session(alice), (e) => e.status === 404);
      t.diagnostic(`7 项目被删:甲的连接被关(${JSON.stringify(A.closes.find((c) => c.code === 4003))}),重连时取票据回 ${JSON.stringify(A.terminal.at(-1))}`);
    }
  } finally {
    for (const close of closers) { try { close(); } catch { /* 已经关了 */ } }
    const state = await fixture.close();
    assert.equal(state.closed, true);
    assert.equal(state.childClosed, true);
  }
});
