/**
 * 素材服务观察通道看门狗(`server/hosted/deploy/asset-run-watchdog.mjs`)的判断与配置校验。
 *
 * 真去 stop/start 素材服务那一半没法单测,所以判断抽成了纯函数 `decideWatchdog`,
 * 这里逐条钉死它:什么时候该动手、什么时候坚决不动手。最要紧的两条是
 *   1. 没开 run-assets(部署者有意关的)绝不自作主张去 rotate;
 *   2. rotate 会让素材服务断一下,所以有冷却,也有「试几次还不好就只报警」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideWatchdog, readWatchdogConfig, runWatchdog, WATCHDOG_DEFAULTS } from '../hosted/deploy/asset-run-watchdog.mjs';

const ready = { ok: true, ready: true, runAssetsConfigured: true, runAssetsReady: true };
const broken = { ok: true, ready: true, runAssetsConfigured: true, runAssetsReady: false };
const off = { ok: true, ready: true, runAssetsConfigured: false, runAssetsReady: false };

test('看门狗的判断:只有「配了 run-assets 但通道不可用」才动手', () => {
  assert.equal(decideWatchdog({ status: ready }).action, 'ok');
  assert.equal(decideWatchdog({ status: broken }).action, 'rotate');

  // 这台节点把 run-assets 关了(PROMPTCUT_ASSET_RUN_ENABLED=0):那是人定的,不是故障
  assert.equal(decideWatchdog({ status: off }).action, 'disabled');

  // 状态口都读不到:素材服务自己没起来或正在重启,这时候去 stop/start 它只会添乱
  assert.equal(decideWatchdog({ status: null }).action, 'unreachable');
  assert.equal(decideWatchdog({ status: 'not-json' }).action, 'unreachable');
});

test('看门狗的判断:冷却期内不重复 rotate,连着不好就只报警', () => {
  const now = 1_000_000_000;
  const justRotated = { lastRotateAt: now - 60_000, rotates: 1 };
  assert.equal(decideWatchdog({ status: broken, state: justRotated, now }).action, 'wait',
    'rotate 会让素材服务断一下,一分钟前刚断过就别再来');

  const cooled = { lastRotateAt: now - WATCHDOG_DEFAULTS.minIntervalMs - 1, rotates: 1 };
  assert.equal(decideWatchdog({ status: broken, state: cooled, now }).action, 'rotate');

  const tried = { lastRotateAt: now - 60 * 60_000, rotates: WATCHDOG_DEFAULTS.maxRotates };
  const alarm = decideWatchdog({ status: broken, state: tried, now });
  assert.equal(alarm.action, 'alarm');
  assert.match(alarm.reason, /要人去看/);

  // 坏掉的 state(手改过、文件截断)不能让它变成无限 rotate
  assert.equal(decideWatchdog({ status: broken, state: { rotates: -5, lastRotateAt: 'x' }, now }).action, 'rotate');
});

test('看门狗的配置校验:相对路径、非本机状态口、不像单元名的一律拒绝', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-watchdog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (value) => { const f = path.join(dir, 'watchdog.json'); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  const base = {
    statusUrl: 'https://127.0.0.1:8794/internal/v2/asset/status',
    tls: { cert: path.resolve(dir, 'c'), key: path.resolve(dir, 'k'), ca: path.resolve(dir, 'a') },
    rotateUnit: 'promptcut-asset-rotate.service',
    stateFile: path.resolve(dir, 'state.json'),
  };

  const ok = readWatchdogConfig(write(base));
  assert.equal(ok.minIntervalMs, WATCHDOG_DEFAULTS.minIntervalMs, '没写就用缺省的冷却时间');
  assert.equal(ok.maxRotates, WATCHDOG_DEFAULTS.maxRotates);

  const rejects = (patch, code) => assert.throws(() => readWatchdogConfig(write({ ...base, ...patch })), (e) => e.code === code);
  // 状态口只认本机:这条内部口是 mTLS 的,配到别的地址去等于把 doc 的客户端证书送出门
  rejects({ statusUrl: 'https://example.com/internal/v2/asset/status' }, 'watchdog-config-status-url');
  rejects({ tls: { ...base.tls, key: 'relative/key.pem' } }, 'watchdog-config-tls');
  rejects({ rotateUnit: 'promptcut-asset-rotate' }, 'watchdog-config-unit');
  rejects({ stateFile: 'state.json' }, 'watchdog-config-state');
  assert.throws(() => readWatchdogConfig('watchdog.json'), (e) => e.code === 'watchdog-config-path');
});

test('看门狗跑一轮:不好才真去 start 单元,好了就把 rotate 计数清掉', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-watchdog-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['c', 'k', 'a']) fs.writeFileSync(path.join(dir, name), 'x');
  const stateFile = path.resolve(dir, 'state.json');
  const configFile = path.join(dir, 'watchdog.json');
  fs.writeFileSync(configFile, JSON.stringify({
    statusUrl: 'https://127.0.0.1:8794/internal/v2/asset/status',
    tls: { cert: path.resolve(dir, 'c'), key: path.resolve(dir, 'k'), ca: path.resolve(dir, 'a') },
    rotateUnit: 'promptcut-asset-rotate.service', stateFile,
  }));
  const started = [];
  const run = (status) => runWatchdog(configFile, { fetch: async () => status, start: async (u) => { started.push(u); } });

  // 状态口读不到:不动手、不留状态文件
  const unreachable = await run(null);
  assert.equal(unreachable.action, 'unreachable');
  assert.equal(unreachable.started, false);
  assert.equal(fs.existsSync(stateFile), false, '没动手就别留状态文件');

  // 通道断了:真去 start rotate 单元,并记下这一次
  const rotated = await run(broken);
  assert.equal(rotated.action, 'rotate');
  assert.equal(rotated.started, true);
  assert.deepEqual(started, ['promptcut-asset-rotate.service']);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).rotates, 1);

  // 紧接着再跑一次:冷却期内不重复 stop/start 素材服务
  const waited = await run(broken);
  assert.equal(waited.action, 'wait');
  assert.deepEqual(started, ['promptcut-asset-rotate.service'], '只 start 过一次');

  // 通道恢复:计数清零,下次偶发断线不会一上来就撞「不再自动试」
  const okRun = await run(ready);
  assert.equal(okRun.action, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).rotates, 0);
});

test('看门狗:证书不是 PEM 时明着报错,不装作「读不到」', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-watchdog-pem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['c', 'k', 'a']) fs.writeFileSync(path.join(dir, name), 'not a pem');
  const configFile = path.join(dir, 'watchdog.json');
  fs.writeFileSync(configFile, JSON.stringify({
    statusUrl: 'https://127.0.0.1:8794/internal/v2/asset/status',
    tls: { cert: path.resolve(dir, 'c'), key: path.resolve(dir, 'k'), ca: path.resolve(dir, 'a') },
    rotateUnit: 'promptcut-asset-rotate.service', stateFile: path.resolve(dir, 'state.json'),
  }));
  // 配置坏了却被当成「现在看不出来」,看门狗就会一声不响地永远什么都不做,这正是要避免的
  await assert.rejects(() => runWatchdog(configFile, { start: async () => {} }), (e) => e.code === 'watchdog-tls-unusable');
});
