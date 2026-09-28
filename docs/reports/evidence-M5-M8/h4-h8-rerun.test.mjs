/**
 * 证据补跑：M6 验收 H4（进入方式，每行各测 20 次）与 H8 第一条（抓握手全部消息，不出现口令明文）。
 * 只用仓库现有的测试套件 `server/test/auth-kit.mjs` 起服务（真共享项目文档服务，端口 0），不改产品代码。
 * 跑（仓库根）：node --test --test-reporter=spec docs/reports/evidence-M5-M8/h4-h8-rerun.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
const KIT = new URL('../../../server/test/auth-kit.mjs', import.meta.url).href;
const CLIENT = new URL('../../../server/auth/client.mjs', import.meta.url).href;
const {
  hostFor, createProject, join, joinStatus, newDevice, members, adminOp, credential, waitFor, rawHandshake, withRemote, PROTOCOL,
} = await import(KIT);

const N = 20;
let ip = 0;
const R = () => `198.18.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;   // 每次换一个非回环来源，避开限速

async function closedWithin(c, ms) {
  let timer;
  const t0 = Date.now();
  const e = await Promise.race([
    c.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${ms} ms 内没有关闭`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason, ms: Date.now() - t0 };
}

test('H4-1 自由进入，项目名与密码都对：20 次全部 101', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const got = [];
  for (let i = 0; i < N; i++) got.push(await joinStatus(env, proj, { username: `u${i}`, remote: R() }));
  t.diagnostic(`H4-1 结果 ${JSON.stringify(got)}`);
  assert.equal(got.filter((s) => s === 101).length, N);
});

test('H4-2 自由进入，密码错：20 次全部 401（0 次进入）', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const got = [];
  for (let i = 0; i < N; i++) got.push(await joinStatus(env, proj, { username: `u${i}`, password: `wrong-${i}`, remote: R() }));
  t.diagnostic(`H4-2 结果 ${JSON.stringify(got)}`);
  assert.equal(got.filter((s) => s === 101).length, 0);
  assert.equal(got.filter((s) => s === 401).length, N);
});

test('H4-3 限定进入，名单外用户名（10 次）或名单内用户密码错（10 次）：20 次全部 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
  const got = [];
  for (let i = 0; i < N / 2; i++) got.push(await joinStatus(env, proj, { username: `stranger${i}`, password: 'bob-pw', remote: R() }));
  for (let i = 0; i < N / 2; i++) got.push(await joinStatus(env, proj, { username: 'bob', password: `bad-${i}`, remote: R() }));
  t.diagnostic(`H4-3 结果 ${JSON.stringify(got)}`);
  assert.equal(got.filter((s) => s === 401).length, N);
  // 对照：名单内、密码对的能进
  assert.equal(await joinStatus(env, proj, { username: 'bob', remote: R() }), 101);
});

test('H4-4 限定进入，删掉名单条目：20 轮，每轮被删者的全部连接 5 s 内断开（4003），再连 401', async (t) => {
  const env = await hostFor(t);
  const times = [];
  for (let i = 0; i < N; i++) {
    const proj = await createProject(env, { mode: 'restricted', remote: R(), list: [{ username: 'bob', password: 'bob-pw' }, { username: 'cara', password: 'cara-pw' }] });
    const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R() });
    const dev = newDevice();
    const page = await join(env, proj, { username: 'bob', device: dev, remote: R() });
    const render = await join(env, proj, { username: 'bob', device: dev, role: 'render', remote: R() });
    const cara = await join(env, proj, { username: 'cara', remote: R() });
    const r = await adminOp(creator, proj, 'set-list', { list: [credential('cara-pw', 'cara')] });
    assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
    const a = await closedWithin(page, 5000);
    const b = await closedWithin(render, 5000);
    assert.deepEqual([a.code, a.reason, b.code, b.reason], [4003, 'removed', 4003, 'removed']);
    times.push(Math.max(a.ms, b.ms));
    assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'bob-pw', remote: R() }), 401);
    assert.equal(cara.ws.readyState, 1, '名单里的人不受影响');
    creator.close(); cara.close();
  }
  t.diagnostic(`H4-4 各轮断开用时 ms ${JSON.stringify(times)}，最大 ${Math.max(...times)} ms`);
});

test('H4-5 自由进入，两台设备自报同一用户名：20 轮，两个 userId 不同、显示名都带「(设备名)」', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const obs = await join(env, proj, { username: 'observer', remote: R() });
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const name = `sam${i}`;
    const dA = newDevice('Desk');
    const dB = newDevice('Phone');
    const a = await join(env, proj, { username: name, device: dA, remote: R() });
    const b = await join(env, proj, { username: name, device: dB, remote: R() });
    const ids = env.principals().filter((p) => p.username === name).map((p) => p.userId);
    assert.equal(new Set(ids).size, 2, `userId 不同：${ids}`);
    const list = await waitFor(async () => {
      const d = await members(obs);
      const ra = d.find((x) => x.deviceId === dA.deviceId);
      const rb = d.find((x) => x.deviceId === dB.deviceId);
      return ra && rb ? { ra, rb } : null;
    }, 3000, '成员列表里有两台');
    assert.equal(list.ra.displayName, `${name} (${dA.deviceName})`);
    assert.equal(list.rb.displayName, `${name} (${dB.deviceName})`);
    ok += 1;
    a.close(); b.close();
  }
  t.diagnostic(`H4-5 通过 ${ok}/${N} 轮`);
});

test('H8-1 抓握手全部消息（建项目、挑战、升级请求与响应），口令明文与常见编码都不出现', async (t) => {
  const env = await hostFor(t);
  const client = await import(CLIENT);
  const wire = [];
  const recFetch = async (url, init = {}) => {
    wire.push(`REQ ${init.method ?? 'GET'} ${url} ${init.body ?? ''}`);
    const r = await fetch(url, init);
    const text = await r.clone().text();
    wire.push(`RES ${r.status} ${[...r.headers].map(([k, v]) => `${k}: ${v}`).join('; ')} ${text}`);
    return r;
  };
  const secrets = ['Pw-free-7c1a!', 'Pw-crea-93be#', 'Pw-bob-55e0$', 'Pw-wrong-0f2%'];
  const [freePw, creatorPw, bobPw, wrongPw] = secrets;
  const base = env.httpBase;
  const free = await client.createSharedProject({ base, name: `h8-free-${process.pid}`, mode: 'free', creator: { username: 'alice', password: creatorPw }, password: freePw, fetch: recFetch });
  const restricted = await client.createSharedProject({ base, name: `h8-res-${process.pid}`, mode: 'restricted', creator: { username: 'alice', password: creatorPw }, list: [{ username: 'bob', password: bobPw }], fetch: recFetch });
  const dev = newDevice();
  const attempts = [
    { projectId: free.projectId, username: 'zoe', password: freePw, as: 'member', expect: 101 },
    { projectId: free.projectId, username: 'alice', password: creatorPw, as: 'creator', expect: 101 },
    { projectId: restricted.projectId, username: 'bob', password: bobPw, as: 'member', expect: 101 },
    { projectId: free.projectId, username: 'zoe', password: wrongPw, as: 'member', expect: 401 },
    { projectId: restricted.projectId, username: 'mallory', password: bobPw, as: 'member', expect: 401 },
  ];
  let n = 0;
  for (const a of attempts) {
    const remote = R();
    const protocols = await client.buildAuthProtocols({ base: `${base.replace(/\/$/, '')}${''}`, projectId: a.projectId, username: a.username, deviceId: dev.deviceId, deviceName: dev.deviceName, as: a.as, password: a.password, role: 'page', fetch: (u, i) => recFetch(withRemote(u, remote), i) });
    wire.push(`UPGRADE Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
    const r = await rawHandshake(env.port, { protocols, path: withRemote(env.wsPath, remote) });
    wire.push(`UPGRADE-RES ${r.status} ${JSON.stringify(r.headers)}`);
    r.sock.destroy();
    assert.equal(r.status, a.expect, JSON.stringify(a));
    n += 1;
  }
  const blob = wire.join('\n');
  const enc = (s) => [s, Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];
  const hits = [];
  for (const s of secrets) for (const e of enc(s)) if (blob.includes(e)) hits.push(`${s} as ${e}`);
  // 解开子协议里 base64url 的 JSON 再查一遍
  const decoded = wire.filter((l) => l.startsWith('UPGRADE ')).map((l) => {
    const item = l.split(', ').find((x) => x.startsWith('promptcut.auth.'));
    return item ? Buffer.from(item.slice('promptcut.auth.'.length), 'base64url').toString('utf8') : '';
  }).join('\n');
  for (const s of secrets) if (decoded.includes(s)) hits.push(`${s} in decoded proof`);
  t.diagnostic(`H8-1 抓到 ${wire.length} 段消息、${blob.length} 字节（${n} 次握手：3 次成功、2 次失败；另有 2 次建项目）；命中 ${hits.length} 处`);
  t.diagnostic(`H8-1 子协议解码样例：${decoded.split('\n')[0].slice(0, 200)}`);
  assert.deepEqual(hits, []);
});
