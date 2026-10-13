/**
 * 账号云端项目里页面那条连接什么时候换会话、换不成怎么办(`accountLinkLife.ts`)。连接用替身;
 * 对着真服务的在 `server/test/account-page-link.test.mjs`。跑:npm test -- src/editor/sync/accountLinkLife.test.mjs
 *
 *   ALL-01 取票据:要求访问令牌至少还剩 60 秒;进项目时那份会话够用就直接用,不够另取
 *   ALL-02 离到期超过 30 秒不动;不到 30 秒换;换成之后按新票据的到期时刻算
 *   ALL-03 账号服务一时不通:到期之前只是再试,不动连接;到期那一刻还没换成 → expire(转离线),只报一次
 *   ALL-04 会话接口回 401 / 403:交给 onTerminal,不 expire
 *   ALL-05 醒来时早就过期:第一下就急着换(不等旧连接上的提交落定);被闸拒时同样急着换,换不成 expire
 *   ALL-06 没有会话(正在断线重连)时不管;换的途中再来的 tick 不重入
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const L = await import("./accountLinkLife.ts");

function harness({ renew = async () => true } = {}) {
  const h = { now: 1_000_000, sessions: [], renews: [], expired: 0, terminal: [], connected: true, sessionError: null, renew };
  const link = { get connected() { return h.connected; }, renew: async (o) => { h.renews.push(o?.urgent === true); await h.life.ticket(); const ok = await h.renew(); if (ok) h.life.opened(); return ok; }, expire: () => { h.expired++; h.connected = false; } };
  h.life = L.createAccountLinkLife({
    session: async ({ minRemainingMs }) => { h.sessions.push(minRemainingMs); if (h.sessionError) throw h.sessionError; return { connectionTicket: `t${h.sessions.length}`, expiresAt: h.now + 120_000 }; },
    link: () => link, onTerminal: (e) => h.terminal.push(e.status), now: () => h.now,
  });
  return h;
}
async function open(h) { await h.life.ticket(); h.life.opened(); }

test("ALL-01 取票据要求令牌至少剩 60 秒;进项目时那份会话够用就用", async () => {
  const h = harness();
  assert.equal(await h.life.ticket({ connectionTicket: "first", expiresAt: h.now + 90_000 }), "first");
  assert.deepEqual(h.sessions, []);
  assert.equal(await h.life.ticket({ connectionTicket: "stale", expiresAt: h.now + 20_000 }), "t1");
  assert.deepEqual(h.sessions, [L.MIN_TICKET_LIFE_MS]);
  h.life.opened();
  assert.equal(h.life.describe().expiresAt, h.now + 120_000);
});

test("ALL-02 离到期超过 30 秒不动,不到 30 秒换,换成后按新票据算", async () => {
  const h = harness();
  await open(h);
  h.now += 80_000;
  assert.equal(await h.life.tick(), "idle");
  h.now += 11_000;
  assert.equal(await h.life.tick(), "renewed");
  assert.deepEqual(h.renews, [false], "还没到期:等旧连接上的提交落定再切");
  assert.equal(h.life.describe().expiresAt, h.now + 120_000);
  assert.equal(await h.life.tick(), "idle");
});

test("ALL-03 账号服务一时不通:到期前只是再试;到期还没换成就 expire,只一次", async () => {
  const h = harness();
  await open(h);
  h.sessionError = Object.assign(new Error("down"), { status: 503 });
  h.now += 95_000;
  assert.equal(await h.life.tick(), "retry");
  h.now += 20_000;
  assert.equal(await h.life.tick(), "retry");
  assert.equal(h.expired, 0, "到期之前不动连接");
  h.now += 6_000;
  assert.equal(await h.life.tick(), "expired");
  assert.equal(h.expired, 1);
  assert.equal(await h.life.tick(), "idle", "已经转离线,交给断线重连");
  assert.deepEqual(h.terminal, []);
});

test("ALL-04 会话接口回 401 / 403:onTerminal,不 expire", async () => {
  for (const status of [401, 403]) {
    const h = harness();
    await open(h);
    h.sessionError = Object.assign(new Error("x"), { status });
    h.now += 95_000;
    assert.equal(await h.life.tick(), "terminal");
    assert.deepEqual(h.terminal, [status]);
    assert.equal(h.expired, 0);
  }
});

test("ALL-05 醒来时早就过期、或被闸拒:急着换;换不成 expire", async () => {
  const h = harness();
  await open(h);
  h.now += 300_000;
  assert.equal(await h.life.tick(), "renewed");
  assert.deepEqual(h.renews, [true]);
  assert.equal(await h.life.authExpired(), "renewed");
  assert.deepEqual(h.renews, [true, true]);
  h.renew = async () => false;
  assert.equal(await h.life.authExpired(), "expired");
  assert.equal(h.expired, 1);
});

test("ALL-06 没有会话时不管;换的途中不重入", async () => {
  const h = harness();
  await open(h);
  h.connected = false;
  h.now += 200_000;
  assert.equal(await h.life.tick(), "idle");
  assert.equal(await h.life.authExpired(), "idle");
  h.connected = true;
  let release;
  h.renew = () => new Promise((r) => { release = () => r(true); });
  const first = h.life.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await h.life.tick(), "busy");
  assert.equal(await h.life.authExpired(), "busy");
  release();
  assert.equal(await first, "renewed");
  assert.equal(h.renews.length, 1);
});
