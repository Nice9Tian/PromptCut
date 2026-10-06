/**
 * 等写入停止的只读脚本(scripts/acceptance/wait-writes-quiet.mjs)的单测。全部对着本进程里的假服务,不碰 5210。
 * 编号 WWQ-01～:每条用例名里带编号,便于对账。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_PATHS, parseArgs, assertLoopback, readOnlyGet, snapshotOf, evaluate, waitForQuiet,
} from '../../scripts/acceptance/wait-writes-quiet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'acceptance', 'wait-writes-quiet.mjs');

/** 假的 5210:记下每个请求的方法与路径,回包由 state 决定 */
async function fakeApp(state) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/agent/status') {
      const a = state.agent();
      return res.end(JSON.stringify(a));
    }
    if (req.method === 'GET' && req.url === '/api/media/upload-queue') {
      return res.end(JSON.stringify({ ok: true, target: null, queue: state.queue() }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const agentBound = (rev, committed = 0, executed = 0) => ({
  ok: true, bound: true, mode: 'ticket', url: 'ws://x', projectId: 'p', conversations: [{ key: 'a', conversation: 1, lastRead: rev }],
  stats: { executed, committed, stale: 0, rejected: 0, noop: 0, events: 0, eventErrors: 0, pageStates: 0, uploads: 0 },
  link: { url: 'ws://x', projectId: 'p', conversations: [], replica: { hasState: true, hasBody: true, rev, buffered: 0 } },
});
const queueIdle = (done = 0) => ({ running: true, working: false, current: null, enqueued: done, merged: 0, done, failures: 0, chunks: 0, items: [] });

/* ---------------------------------------------------------------- 参数与只读白名单 */

test('WWQ-01 parseArgs:缺省值、各选项、只许回环地址', () => {
  const d = parseArgs([]);
  assert.equal(d.base, 'http://127.0.0.1:5210');
  assert.equal(d.intervalSec, 20);
  assert.equal(d.quietMin, 5);
  assert.equal(d.maxHours, 3);
  const o = parseArgs(['--base', 'http://localhost:5999', '--interval-s', '1', '--quiet-min', '2', '--max-hours', '1']);
  assert.equal(o.base, 'http://localhost:5999');
  assert.equal(o.quietMin, 2);
  assert.throws(() => parseArgs(['--base', 'http://149.88.94.84:5210']), /只许回环地址/);
  assert.throws(() => parseArgs(['--base', 'https://127.0.0.1:5210']), /只许 http/);
  assert.throws(() => parseArgs(['--base', 'http://127.0.0.1:5210/api']), /不带路径/);
  assert.throws(() => parseArgs(['--base', 'http://u:p@127.0.0.1:5210']), /用户名/);
  assert.throws(() => parseArgs(['--interval-s']), /缺少参数/);
  assert.throws(() => parseArgs(['--quiet-min', 'x']), /的数/);
  assert.throws(() => parseArgs(['--post']), /看不懂的参数/);
  assert.doesNotThrow(() => assertLoopback('http://127.0.0.1:5210'));
  assert.doesNotThrow(() => assertLoopback('http://[::1]:5210'));
});

test('WWQ-02 readOnlyGet:只发 GET、只许两个路径,别的路径不发请求就拒绝', async () => {
  assert.deepEqual(ALLOWED_PATHS, ['/api/agent/status', '/api/media/upload-queue']);
  const app = await fakeApp({ agent: () => agentBound(1), queue: () => queueIdle() });
  try {
    for (const bad of ['/api/agent/bind', '/api/agent/unbind', '/api/media/upload-queue/target', '/api/media/upload-queue/enqueue', '/api/mcp/call', '/', '/api/agent/status?x=1']) {
      await assert.rejects(() => readOnlyGet(app.base, bad), /不在只读白名单/);
    }
    assert.deepEqual(app.seen, [], '被拒绝的路径一个请求都不能发出去');
    const a = await readOnlyGet(app.base, '/api/agent/status');
    const q = await readOnlyGet(app.base, '/api/media/upload-queue');
    assert.equal(a.status, 200);
    assert.equal(a.json.link.replica.rev, 1);
    assert.equal(q.json.ok, true);
    assert.deepEqual(app.seen, ['GET /api/agent/status', 'GET /api/media/upload-queue']);
    await assert.rejects(() => readOnlyGet('http://10.0.0.5:5210', '/api/agent/status'), /只许回环地址/);
  } finally { await app.close(); }
});

/* ---------------------------------------------------------------- 判一拍 */

test('WWQ-03 snapshotOf 与 evaluate:提交数、版本、队列计数、队列不空闲各自会让这一拍不安静', () => {
  const snap = (agent, queue) => snapshotOf({ status: 200, json: agent }, { status: 200, json: { ok: true, queue } });
  const s0 = snap(agentBound(5, 1, 1), queueIdle(2));
  assert.equal(s0.rev, 5);
  assert.equal(s0.queueIdle, true);
  assert.deepEqual(evaluate(null, s0), { quiet: true, reasons: [] });
  assert.deepEqual(evaluate(s0, snap(agentBound(5, 1, 1), queueIdle(2))), { quiet: true, reasons: [] });
  assert.match(evaluate(s0, snap(agentBound(5, 2, 2), queueIdle(2))).reasons.join(), /Agent 对话在提交/);
  assert.match(evaluate(s0, snap(agentBound(6, 1, 1), queueIdle(2))).reasons.join(), /项目版本变了/);
  assert.match(evaluate(s0, snap(agentBound(5, 1, 1), queueIdle(3))).reasons.join(), /上传队列计数在动/);
  const busy = { ...queueIdle(2), working: true, current: 'x', items: [{ id: 'x' }] };
  assert.match(evaluate(s0, snap(agentBound(5, 1, 1), busy)).reasons.join(), /上传队列不空闲/);
  assert.match(evaluate(null, snap(agentBound(5, 1, 1), busy)).reasons.join(), /上传队列不空闲/);
  // 没绑项目:版本看不到,按不变算;queue 为 null 算空闲
  const unbound = snap({ ok: true, bound: false }, null);
  assert.equal(unbound.bound, false);
  assert.equal(unbound.queueIdle, true);
  assert.equal(evaluate(unbound, unbound).quiet, true);
  // 连不上:按没有桌面端在写算,但标明
  const down = snapshotOf(null, null);
  assert.equal(evaluate(s0, down).quiet, true);
  assert.equal(evaluate(s0, down).appDown, true);
  assert.match(evaluate(down, s0).reasons.join(), /刚起来/);
});

/* ---------------------------------------------------------------- 主循环(假时钟) */

function clock() {
  let t = Date.UTC(2026, 9, 7, 0, 0, 0);
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('WWQ-04 waitForQuiet:连续安静满 5 分钟才算停止;中途有写入重新计时', async () => {
  const c = clock();
  const lines = [];
  // 每拍 20 s;前 3 拍版本在涨,之后不变
  let n = 0;
  const fetchBoth = async () => {
    n++;
    const rev = n <= 3 ? n : 3;
    return { agent: { status: 200, json: agentBound(rev) }, queue: { status: 200, json: { ok: true, queue: queueIdle() } } };
  };
  const res = await waitForQuiet({ quietMin: 5, maxHours: 3, intervalSec: 20 }, { fetchBoth, now: c.now, sleep: c.sleep, log: (l) => lines.push(JSON.parse(l)) });
  assert.equal(res.status, 'quiet');
  // 第 4 拍起版本不变,从第 4 拍开始计安静,到 5 分钟即 15 拍之后(4 + 15 = 第 19 拍)
  assert.equal(res.samples, 19);
  assert.equal(lines[2].quiet, false);
  assert.equal(lines[3].quiet, true);
  assert.equal(lines.at(-1).quietForSec, 300);
  assert.ok(lines.slice(0, 3).every((l) => l.reasons.length || l.quiet), '前几拍要么写了原因要么是第一拍');
});

test('WWQ-05 waitForQuiet:等满 3 小时仍在写就返回 timeout(不返回 quiet)', async () => {
  const c = clock();
  let n = 0;
  const fetchBoth = async () => ({ agent: { status: 200, json: agentBound(++n) }, queue: { status: 200, json: { ok: true, queue: queueIdle() } } });
  const res = await waitForQuiet({ quietMin: 5, maxHours: 3, intervalSec: 20 }, { fetchBoth, now: c.now, sleep: c.sleep, log: () => {} });
  assert.equal(res.status, 'timeout');
  assert.ok(res.waitedSec >= 3 * 3600);
  assert.match(res.lastReasons.join(), /项目版本变了/);
});

test('WWQ-06 waitForQuiet:上传队列一直不空闲也不算停止;软件没开算停止并标明', async () => {
  const c = clock();
  const busyQ = { ...queueIdle(), working: true, current: 'x', items: [{ id: 'x' }] };
  let res = await waitForQuiet({ quietMin: 1, maxHours: 0.1, intervalSec: 20 }, {
    fetchBoth: async () => ({ agent: { status: 200, json: { ok: true, bound: false } }, queue: { status: 200, json: { ok: true, queue: busyQ } } }),
    now: c.now, sleep: c.sleep, log: () => {},
  });
  assert.equal(res.status, 'timeout');
  const c2 = clock();
  res = await waitForQuiet({ quietMin: 1, maxHours: 1, intervalSec: 20 }, { fetchBoth: async () => ({ agent: null, queue: null }), now: c2.now, sleep: c2.sleep, log: () => {} });
  assert.equal(res.status, 'quiet');
  assert.equal(res.appDownOnly, true);
});

/* ---------------------------------------------------------------- 整份脚本对着假服务 */

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('WWQ-07 整份脚本:对着假服务安静时退出 0,整个过程只发了两种 GET', { timeout: 60_000 }, async () => {
  const app = await fakeApp({ agent: () => agentBound(7), queue: () => queueIdle() });
  try {
    const r = await runCli(['--base', app.base, '--interval-s', '0.05', '--quiet-min', '0.003', '--max-hours', '0.01']);
    assert.equal(r.code, 0, r.out + r.err);
    const result = JSON.parse(r.out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
    assert.equal(result.status, 'quiet');
    assert.match(result.conclusion, /可以重启/);
    assert.ok(app.seen.length >= 4);
    assert.ok(app.seen.every((s) => s === 'GET /api/agent/status' || s === 'GET /api/media/upload-queue'), JSON.stringify([...new Set(app.seen)]));
  } finally { await app.close(); }
});

test('WWQ-08 整份脚本:一直在写时退出 3 并写明不要重启', { timeout: 60_000 }, async () => {
  let rev = 0;
  const app = await fakeApp({ agent: () => agentBound(++rev), queue: () => queueIdle() });
  try {
    const r = await runCli(['--base', app.base, '--interval-s', '0.05', '--quiet-min', '0.05', '--max-hours', '0.0006']);
    assert.equal(r.code, 3, r.out + r.err);
    const result = JSON.parse(r.out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
    assert.equal(result.status, 'timeout');
    assert.match(result.conclusion, /不要重启/);
    assert.ok(app.seen.every((s) => s.startsWith('GET ')));
  } finally { await app.close(); }
});

test('WWQ-09 整份脚本:5210 连不上(软件没开)时退出 0,结论里写明;远端地址直接拒绝(退出 2)', { timeout: 60_000 }, async () => {
  const app = await fakeApp({ agent: () => agentBound(1), queue: () => queueIdle() });
  const base = app.base;
  await app.close(); // 关掉,端口无人听
  let r = await runCli(['--base', base, '--interval-s', '0.05', '--quiet-min', '0.002', '--max-hours', '0.01']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /桌面版没开/);
  r = await runCli(['--base', 'http://149.88.94.84:5210']);
  assert.equal(r.code, 2);
  assert.match(r.err, /只许回环地址/);
});
