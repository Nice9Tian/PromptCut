/**
 * 素材服务「观察通道」的看门狗。查一次状态,只在确实断了的时候才去触发 rotate。
 *
 * 为什么不是定时无脑 rotate:`--rotate` 会 stop + start 素材服务
 * (`asset-root-registry-publisher.mjs`),高频跑等于反复让所有人读不了素材。
 * 所以这里是**条件触发**:只有「配了 run-assets 但 runAssetsReady 是 false」才动手。
 *
 * 正常漏做 rotate 的那条路由文档服务的 ExecStartPost 兜住
 * (`systemd-promptcut-doc-rotate.dropin.conf`);这个看门狗补的是另一半:
 * 不是文档服务重启引起的断线(连接自己掉了、rotate 那次失败了)。
 *
 * 跑:node server/hosted/deploy/asset-run-watchdog.mjs --config /etc/promptcut/asset-root/watchdog.json
 * 退出码 0 = 这一次处理完了(不管是没事、等冷却、还是触发了 rotate);1 = 配置或系统命令出错。
 * 每次往 stdout 写一行 JSON,进 journal,排障时 `journalctl -u promptcut-asset-rotate-watch` 一眼看得到。
 *
 * 它只会 `systemctl start` rotate 那个单元,不自己跑 publisher:publisher 必须在素材服务的
 * cgroup 之外以 root 跑,由独立单元执行这件事最省心,也不用在这里重复那一堆前置校验。
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { execFile } from 'node:child_process';

const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const absolute = (v) => typeof v === 'string' && path.isAbsolute(v) && path.normalize(v) === v;

export const WATCHDOG_DEFAULTS = Object.freeze({
  /** 两次 rotate 之间至少隔这么久:rotate 会让素材服务断一下,不能连着来 */
  minIntervalMs: 10 * 60_000,
  /** 连着这么多次 rotate 都没把 runAssetsReady 拉回来,就不再试,只报警 */
  maxRotates: 3,
});

/**
 * 纯判断:给定这一次读到的状态和上次留下的记录,这一次该做什么。
 * 抽出来是为了能单测——真去 stop/start 生产素材服务的那半没法测。
 *
 * @param {object|null} status 状态口返回的 JSON;读不到传 null
 * @returns {{action:'ok'|'disabled'|'unreachable'|'wait'|'rotate'|'alarm', reason:string}}
 */
export function decideWatchdog({ status, state = {}, now = Date.now(), minIntervalMs = WATCHDOG_DEFAULTS.minIntervalMs,
  maxRotates = WATCHDOG_DEFAULTS.maxRotates } = {}) {
  // 读不到状态口:素材服务自己没起来或正在重启。它的单元有 Restart 管,这里不插手——
  // 连状态都读不到的时候去 stop/start 它,只会把一次普通重启变成两次。
  if (!status || typeof status !== 'object') return { action: 'unreachable', reason: '状态口读不到,这一次不动' };
  // 没配 run-assets(PROMPTCUT_ASSET_RUN_ENABLED=0)是部署者有意关的,不是故障,别自作主张把它弄回来
  if (status.runAssetsConfigured !== true) return { action: 'disabled', reason: '这台节点没开 run-assets,不归看门狗管' };
  if (status.runAssetsReady === true) return { action: 'ok', reason: '观察通道正常' };
  const rotates = Number.isSafeInteger(state.rotates) && state.rotates > 0 ? state.rotates : 0;
  if (rotates >= maxRotates) {
    return { action: 'alarm', reason: `连着 ${rotates} 次 rotate 都没把观察通道拉回来,不再自动试,要人去看` };
  }
  const last = Number.isSafeInteger(state.lastRotateAt) ? state.lastRotateAt : 0;
  if (last && now - last < minIntervalMs) {
    return { action: 'wait', reason: `上次 rotate 到现在还不到 ${Math.round(minIntervalMs / 60_000)} 分钟,等冷却` };
  }
  return { action: 'rotate', reason: '配了 run-assets 但观察通道不可用' };
}

export function readWatchdogConfig(file) {
  if (!absolute(file)) fail('watchdog-config-path');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('watchdog-config-unreadable'); }
  const { statusUrl, tls, rotateUnit, stateFile } = cfg ?? {};
  if (typeof statusUrl !== 'string' || !statusUrl.startsWith('https://127.0.0.1:')) fail('watchdog-config-status-url');
  if (!tls || !['cert', 'key', 'ca'].every((k) => absolute(tls[k]))) fail('watchdog-config-tls');
  if (typeof rotateUnit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(rotateUnit)) fail('watchdog-config-unit');
  if (!absolute(stateFile)) fail('watchdog-config-state');
  const positive = (v, d) => (Number.isSafeInteger(v) && v > 0 ? v : d);
  return { statusUrl, tls, rotateUnit, stateFile,
    minIntervalMs: positive(cfg.minIntervalMs, WATCHDOG_DEFAULTS.minIntervalMs),
    maxRotates: positive(cfg.maxRotates, WATCHDOG_DEFAULTS.maxRotates) };
}

const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const writeState = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/**
 * 读状态口。读不到(连不上、超时、不是 JSON、HTTP 不是 200)一律当作「读不到」,不区分——
 * 那都是「现在看不出来」,下一次定时再查就是。
 * 但证书读不了或不是 PEM 是配置坏了,不能当成「看不出来」糊过去——那样看门狗会一声不响地永远什么都不做。
 * 这种抛 `watchdog-tls-unusable`,CLI 以退出码 1 退出并在 journal 里留下这个代号。
 */
export async function fetchStatus({ statusUrl, tls, timeoutMs = 10_000 }) {
  let options;
  try {
    options = { cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key), ca: fs.readFileSync(tls.ca) };
  } catch { fail('watchdog-tls-unusable'); }
  return await new Promise((resolve, reject) => {
    let req;
    try {
      // PEM 解析失败在 https.request 里抛(ERR_OSSL_PEM_NO_START_LINE 之类),不是网络问题
      req = https.request(statusUrl, { method: 'GET', ...options, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (piece) => { if (body.length < 64 * 1024) body += piece; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
    } catch (error) {
      return reject(Object.assign(new Error('watchdog-tls-unusable'), { code: 'watchdog-tls-unusable', cause: error }));
    }
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
    return undefined;
  });
}

const startUnit = (unit) => new Promise((resolve, reject) => {
  execFile('/usr/bin/systemctl', ['--no-ask-password', 'start', unit], { timeout: 180_000 },
    (error) => (error ? reject(error) : resolve()));
});

/** `start` 与 `fetch` 只为单测留的口子:真去 stop/start 生产素材服务那一半没法测。 */
export async function runWatchdog(configFile, { now = Date.now, start = startUnit, fetch = fetchStatus } = {}) {
  const cfg = readWatchdogConfig(configFile);
  const status = await fetch(cfg);
  const state = readState(cfg.stateFile);
  const at = now();
  const decision = decideWatchdog({ status, state, now: at, minIntervalMs: cfg.minIntervalMs, maxRotates: cfg.maxRotates });
  let started = false;
  if (decision.action === 'rotate') {
    await start(cfg.rotateUnit);
    started = true;
    writeState(cfg.stateFile, { lastRotateAt: at, rotates: (Number.isSafeInteger(state.rotates) ? state.rotates : 0) + 1 });
  } else if (decision.action === 'ok') {
    // 好了就把计数清掉,免得下一次偶发断线一上来就撞上「不再自动试」
    if (state.rotates) writeState(cfg.stateFile, { lastRotateAt: state.lastRotateAt ?? 0, rotates: 0 });
  }
  return { ...decision, started, runAssetsReady: status?.runAssetsReady ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('deploy', 'asset-run-watchdog.mjs'))) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--config');
  const line = (fields) => process.stdout.write(`${JSON.stringify({ event: 'asset-run-watchdog', ...fields })}\n`);
  if (i < 0 || !args[i + 1] || args.length !== 2) { line({ error: 'watchdog-cli-invalid' }); process.exit(1); }
  try {
    line(await runWatchdog(args[i + 1]));
  } catch (error) {
    line({ error: error?.code ?? 'watchdog-failed' });
    process.exit(1);
  }
}
