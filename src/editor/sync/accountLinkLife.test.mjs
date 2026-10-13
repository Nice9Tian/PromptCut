/**
 * 账号云端项目里页面那条连接什么时候换会话、换不成怎么办(`accountLinkLife.ts`)。连接用替身;
 * 对着真服务的在 `server/test/account-page-link.test.mjs`。跑:npm test -- src/editor/sync/accountLinkLife.test.mjs
 *
 *   ALL-01 取票据:要求访问令牌至少还剩 60 秒;进项目时那份会话够用就直接用,不够另取
 *   ALL-02 离到期超过 30 秒不动;不到 30 秒换;换成之后按新票据的到期时刻算
 *   ALL-03 账号服务一时不通:到期之前只是再试,不动连接;到期那一刻还没换成 → expire(转离线),只报一次
 *   ALL-04 会话接口回 401 / 403:交给 onTerminal,不 expire
 *   ALL-05 已经过期才发现(睡眠醒来)、或被闸拒:不换会话,直接 expire(走离线重连的版本核对),不取票据
 *   ALL-06 没有会话(正在断线重连)时不管;换的途中再来的 tick 不重入
 *   ALL-07 权限变了(只读改可写)换一个会话;正忙着就记下,忙完的下一次 tick 补换
 *   ALL-08 取票据的请求挂住:到期后忙了超过 5 秒就 expire,不一直显示在线
 *   ALL-09 本机的钟快:票据算出来不够用就不信它的到期时刻,按从现在起 60 秒算、不凭本机的钟判过期;两次换之间至少隔 20 秒
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const L = await import("./accountLinkLife.ts");

function harness({ renew = async () => true, life = 120_000 } = {}) {
  const h = { now: 1_000_000, sessions: [], renews: 0, expired: 0, terminal: [], connected: true, sessionError: null, renew, life, hang: null };
  const link = {
    get connected() { return h.connected; },
    renew: async () => { h.renews++; await h.life_.ticket(); const ok = await h.renew(); if (ok) h.life_.opened(); return ok; },
    expire: () => { h.expired++; h.connected = false; },
  };
  h.life_ = L.createAccountLinkLife({
    session: async ({ minRemainingMs }) => {
      h.sessions.push(minRemainingMs);
      if (h.hang) await h.hang;
      if (h.sessionError) throw h.sessionError;
      return { connectionTicket: `t${h.sessions.length}`, expiresAt: h.now + h.life };
    },
    link: () => link, onTerminal: (e) => h.terminal.push(e.status), now: () => h.now,
  });
  return h;
}
async function open(h) { await h.life_.ticket(); h.life_.opened(); }

test("ALL-01 取票据要求令牌至少剩 60 秒;进项目时那份会话够用就用", async () => {
  const h = harness();
  assert.equal(await h.life_.ticket({ connectionTicket: "first", expiresAt: h.now + 90_000 }), "first");
  assert.deepEqual(h.sessions, []);
  assert.equal(await h.life_.ticket({ connectionTicket: "stale", expiresAt: h.now + 20_000 }), "t1");
  assert.deepEqual(h.sessions, [L.MIN_TICKET_LIFE_MS]);
  h.life_.opened();
  assert.deepEqual([h.life_.describe().expiresAt, h.life_.describe().trusted], [h.now + 120_000, true]);
});

test("ALL-02 离到期超过 30 秒不动,不到 30 秒换,换成后按新票据算", async () => {
  const h = harness();
  await open(h);
  h.now += 80_000;
  assert.equal(await h.life_.tick(), "idle");
  h.now += 11_000;
  assert.equal(await h.life_.tick(), "renewed");
  assert.equal(h.renews, 1);
  assert.equal(h.life_.describe().expiresAt, h.now + 120_000);
  assert.equal(await h.life_.tick(), "idle");
});

test("ALL-03 账号服务一时不通:到期前只是再试;到期还没换成就 expire,只一次", async () => {
  const h = harness();
  await open(h);
  h.sessionError = Object.assign(new Error("down"), { status: 503 });
  h.now += 95_000;
  assert.equal(await h.life_.tick(), "retry");
  h.now += 20_000;
  assert.equal(await h.life_.tick(), "retry");
  assert.equal(h.expired, 0, "到期之前不动连接");
  h.now += 6_000;
  assert.equal(await h.life_.tick(), "expired");
  assert.equal(h.expired, 1);
  assert.equal(await h.life_.tick(), "idle", "已经转离线,交给断线重连");
  assert.deepEqual(h.terminal, []);
});

test("ALL-04 会话接口回 401 / 403:onTerminal,不 expire", async () => {
  for (const status of [401, 403]) {
    const h = harness();
    await open(h);
    h.sessionError = Object.assign(new Error("x"), { status });
    h.now += 95_000;
    assert.equal(await h.life_.tick(), "terminal");
    assert.deepEqual(h.terminal, [status]);
    assert.equal(h.expired, 0);
  }
});

test("ALL-05 已经过期才发现、或被闸拒:不换会话、不取票据,直接 expire(过期期间的改动走离线重连的版本核对)", async () => {
  const slept = harness();
  await open(slept);
  slept.now += 300_000;
  assert.equal(await slept.life_.tick(), "expired");
  assert.deepEqual([slept.renews, slept.expired, slept.sessions.length], [0, 1, 1]);
  const refused = harness();
  await open(refused);
  assert.equal(await refused.life_.authExpired(), "expired");
  assert.deepEqual([refused.renews, refused.expired], [0, 1]);
  assert.equal(await refused.life_.authExpired(), "idle", "已经按断线处理了,再来的不重复");
});

test("ALL-06 没有会话时不管;换的途中不重入", async () => {
  const h = harness();
  await open(h);
  h.connected = false;
  h.now += 200_000;
  assert.equal(await h.life_.tick(), "idle");
  assert.equal(await h.life_.authExpired(), "idle");
  const g = harness();
  await open(g);
  g.now += 95_000;
  let release;
  g.renew = () => new Promise((r) => { release = () => r(true); });
  const first = g.life_.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await g.life_.tick(), "busy");
  release();
  assert.equal(await first, "renewed");
  assert.equal(g.renews, 1);
});

test("ALL-07 权限变了(只读改可写)换一个会话;第一次读到、没变时不动;正忙着就记下,下一次 tick 补换", async () => {
  const h = harness();
  await open(h);
  assert.equal(await h.life_.accessSeen("r"), "idle", "第一次读到只是记下");
  assert.equal(await h.life_.accessSeen("r"), "idle");
  assert.equal(await h.life_.accessSeen("rw"), "renewed");
  assert.equal(h.renews, 1);
  // 正忙着(到期前那一轮换会话还没回来)时读到权限变了
  h.now += 95_000;
  let release;
  h.renew = () => new Promise((r) => { release = () => r(true); });
  const swapping = h.life_.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await h.life_.accessSeen("r"), "busy");
  release();
  assert.equal(await swapping, "renewed");
  // 那一轮是在读到新权限之前取的票据:再补一轮(不受「两次至少隔 20 秒」限制的是这一种)
  h.renew = async () => true;
  h.now += 21_000;
  assert.equal(await h.life_.tick(), "renewed", "补换");
  assert.equal(h.renews, 3);
  assert.equal(await h.life_.tick(), "idle");
  h.connected = false;
  assert.equal(await h.life_.accessSeen("rw"), "idle", "没有会话(服务端已经关掉旧连接):交给断线重连");
});

test("ALL-08 取票据的请求挂住:到期前照常等;到期后忙了超过 5 秒就 expire", async () => {
  const h = harness();
  await open(h);
  h.now += 95_000;
  h.hang = new Promise(() => {});
  void h.life_.tick();
  await new Promise((r) => setTimeout(r, 5));
  h.now += 20_000;
  assert.equal(await h.life_.tick(), "busy", "还没到期:等着");
  assert.equal(h.expired, 0);
  h.now += 6_000;
  assert.equal(await h.life_.tick(), "expired", "到期了、换会话那一步 26 秒没回来");
  assert.equal(h.expired, 1);
});

test("ALL-09 本机的钟快:算出来不够用的票据不信它的到期时刻,按从现在起 60 秒算;不凭本机的钟判过期;两次换至少隔 20 秒", async () => {
  // 本机的钟快 100 秒:120 秒的票据算出来只剩 20 秒
  const h = harness({ life: 20_000 });
  await open(h);
  assert.deepEqual([h.life_.describe().expiresAt, h.life_.describe().trusted], [h.now + 60_000, false]);
  assert.equal(await h.life_.tick(), "idle", "不是一建成就换");
  h.now += 25_000;
  assert.equal(await h.life_.tick(), "idle");
  h.now += 6_000;
  assert.equal(await h.life_.tick(), "renewed", "约 30 秒换一次");
  h.now += 3_000;
  assert.equal(await h.life_.tick(), "idle");
  // 换不成、本机的钟显示「过期」了:不 expire(到期由文档服务回的「凭证到期」说了算)
  h.sessionError = Object.assign(new Error("down"), { status: 503 });
  h.now += 100_000;
  assert.equal(await h.life_.tick(), "retry");
  assert.equal(h.expired, 0);
  // 本机的钟快得更多(票据算出来已经过期)也一样:不会一建成就判过期、反复断开
  const far = harness({ life: -30_000 });
  await open(far);
  assert.equal(far.life_.describe().trusted, false);
  assert.equal(await far.life_.tick(), "idle");
  assert.equal(far.expired, 0);
  // 两次换之间至少隔 20 秒:票据寿命异常短(每次都只剩 45 秒)时不会每个 tick 都换
  const short = harness({ life: 45_000 });
  await open(short);
  short.now += 16_000;
  assert.equal(await short.life_.tick(), "renewed");
  short.now += 16_000;
  assert.equal(await short.life_.tick(), "idle", "离上次换不到 20 秒");
  short.now += 5_000;
  assert.equal(await short.life_.tick(), "renewed");
});
