/**
 * 调度方到任务进程的指令通道（本机 HTTPS 那一种）。
 *
 * 任务进程（`account-task-worker-cli.mjs --control https`）在它核身份用的那个口上另认四条：
 *   POST /internal/v2/agent/run-scope/control/prepare      领取：{ projectId, conversationId, requestId }
 *   POST /internal/v2/agent/run-scope/control/start        开跑：{}
 *   POST /internal/v2/agent/run-scope/control/close        收尾：{}（回应送到以后进程自己收掉）
 *   GET  /internal/v2/agent/run-scope/control/settlement   长挂：结算结果出来了就回，到时限回「还没有」
 * 这个口只认 root 那一张客户端证书（`expected.clientFingerprint256`），服务端证书在这里按指纹钉住。
 *
 * 两个导出：
 *   createWorkerControlClient      只管这条通道。进程是谁起的、活没活着由调用方说了算（Linux 上是 root 看 systemd）。
 *   createAccountWorkerHttpsGateway  和 `account-worker-gateway.mjs` 的 `createAccountWorkerGateway` 同形状：自己起一个子进程
 *                                    （不带父子通道），指令走上面的客户端。没有 systemd 的机器和测试用它。
 *
 * 和父子通道那一种一样：这里只是递。终态和意向由 root 的发布器对着文档服务公钥和这一代进程的公钥验；
 * 任何回应都不让出名额、不证明进程组已经关干净。
 */
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { certificateFingerprint } from '../account/client.mjs';

const fail = code => Object.assign(new Error(code), { status: 503, code });
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const entry = fileURLToPath(new URL('./account-task-worker-cli.mjs', import.meta.url));
const BASE = '/internal/v2/agent/run-scope/';
const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/**
 * @param {object} o
 * @param {string} o.origin 任务进程那个口：`https://127.0.0.1:<端口>`
 * @param {{ key, cert, ca }} o.tls root 的客户端证书（任务进程只认它）
 * @param {string} o.serverFingerprint256 任务进程身份证书的指纹（`expected.serverFingerprint256`）
 * @param {number} [o.timeoutMs] 一条指令最多等多久（领取要去文档服务登记、领任务，可能带退避，给宽一些）
 * @param {number} [o.settlementWaitMs] 结算结果一次长挂多久
 */
export function createWorkerControlClient({ origin, tls, serverFingerprint256, timeoutMs = 30_000, settlementWaitMs = 15_000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw fail('worker-control-configuration'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.hostname !== '127.0.0.1' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls.cert || !tls.ca || !/^[a-f0-9]{64}$/.test(pin) || !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(settlementWaitMs) || settlementWaitMs < 1 || settlementWaitMs > 60_000) throw fail('worker-control-configuration');
  const requests = new Set(); let stopped = false, pendingCommands = 0;
  /** 每条指令一条新连接；回应读完、连接真的关了才算完。`refused` 标出「对面还没在听」这一种（只有它算启动期可重试）。 */
  function call(method, route, body, limitMs) {
    if (stopped) return Promise.reject(fail('worker-control-closed'));
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let value, error = null, ready = false, socket = null, socketClosed = false, settled = false;
      const finish = () => { if (settled || !ready || (socket && !socketClosed)) return; settled = true; clearTimeout(timer);
        requests.delete(req); error ? reject(error) : resolve(value); };
      const abort = cause => { if (ready) return; error = cause; ready = true; req.destroy(); socket?.destroy(); finish(); };
      const req = https.request(new URL(route, base), { method, agent: false, key: tls.key, cert: tls.cert, ca: tls.ca,
        rejectUnauthorized: true, minVersion: 'TLSv1.3',
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? fail('worker-control-server-certificate') : undefined); },
        headers: { connection: 'close', ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) abort(fail('worker-control-response-too-large')); else chunks.push(chunk); });
        res.on('error', () => abort(fail('worker-control-response-incomplete')));
        res.on('aborted', () => abort(fail('worker-control-response-incomplete')));
        res.on('end', () => {
          if (ready) return;
          let parsed;
          try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { return abort(fail('worker-control-protocol')); }
          if (res.statusCode === 200 && parsed?.ok === true) value = parsed.result;
          // 任务进程自己说的原因码原样带回（调度方据它记日志）；它不是任何授权的依据。
          else error = Object.assign(fail(safe(parsed?.code) ? parsed.code : 'worker-control-unavailable'), { answered: true, httpStatus: res.statusCode });
          ready = true; req.destroy(); socket?.destroy(); finish();
        });
      });
      requests.add(req);
      const timer = setTimeout(() => abort(fail('worker-control-timeout')), limitMs);
      req.on('socket', current => { socket = current; current.once('close', () => { socketClosed = true; finish(); }); });
      req.on('error', cause => { if (cause?.code === 'ECONNREFUSED') abort(Object.assign(fail('worker-control-unreachable'), { refused: true }));
        else abort(safe(cause?.code) && cause.status ? cause : fail('worker-control-unavailable')); if (!socket) finish(); });
      req.end(encoded ?? undefined);
    });
  }
  const commandCall = async (name, body) => {
    pendingCommands += 1;
    try { return await call('POST', `${BASE}control/${name}`, body, timeoutMs); } finally { pendingCommands -= 1; }
  };
  let watching = null;
  return {
    /** 这一代进程自报的公开身份（公钥、实例号、进程号）。root 的发布器另凭自己对系统的观察去核它。 */
    identity: () => call('GET', `${BASE}identity`, undefined, Math.min(timeoutMs, 10_000)),
    prepare: task => commandCall('prepare', task),
    start: () => commandCall('start', {}),
    /** 叫它自己收尾。回应只说明它收到了，不说明它已经退出。 */
    close: () => commandCall('close', {}),
    /**
     * 结算结果。一直问到有结果；通道断了就隔一会儿再问，直到调用方说这个进程已经不在了（`gone()` 为真）——那时回 `{ kind: 'closed' }`。
     * 同一个客户端只开一条，重复调拿到同一个结果。
     * @param {{ gone: () => boolean }} o
     */
    settlement({ gone } = {}) {
      if (typeof gone !== 'function') throw fail('worker-control-configuration');
      watching ??= (async () => {
        let pause = 100;
        for (;;) {
          if (stopped || gone()) return { kind: 'closed' };
          try {
            const answer = await call('GET', `${BASE}control/settlement?waitMs=${settlementWaitMs}`, undefined, settlementWaitMs + 10_000);
            pause = 100;
            if (answer?.settled !== true) continue;
            const r = answer.settlement;
            if (r?.kind === 'normal' && r.terminal && typeof r.terminal === 'object' && r.intent && typeof r.intent === 'object')
              return { kind: 'normal', terminal: structuredClone(r.terminal), intent: structuredClone(r.intent) };
            return { kind: 'abandoned', code: safe(r?.code) ? r.code : 'worker-settlement-failed' };
          } catch {
            if (stopped || gone()) return { kind: 'closed' };
            await delay(pause); pause = Math.min(pause * 2, 2_000);
          }
        }
      })();
      return watching;
    },
    /** 不再问了（槽已经关了、调度要停）。只关这一侧的连接，不碰任务进程。 */
    stop() { stopped = true; for (const req of [...requests]) req.destroy(fail('worker-control-closed')); },
    describe: () => ({ pendingCommands, openRequests: requests.size, stopped }),
  };
}

/**
 * 自己起一个任务子进程，指令走本机 HTTPS。和 `createAccountWorkerGateway` 同形状（`ready / closed / settlement / pid /
 * terminate / prepare / start / close / describe`）。子进程不带父子通道，和 systemd 起的走同一种入口。
 * 这里拿到的只是这个子进程自己的退出，不是整棵进程树的关闭证明；槽让不让出来仍然只认 root 的关闭记录。
 *
 * @param {object} o
 * @param {string} o.configurationModule 任务进程的本机启动配置（绝对路径）
 * @param {string} o.cwd
 * @param {number} o.port 配置里写给任务进程听的那个端口（调用方定：没有父子通道，端口没法由子进程报回来）
 * @param {{ key, cert, ca }} o.controllerTls root 的客户端证书
 * @param {string} o.serverFingerprint256 任务进程身份证书的指纹
 */
export function createAccountWorkerHttpsGateway({ configurationModule, cwd, env = process.env, timeoutMs = 10_000, port,
  controllerTls, serverFingerprint256, settlementWaitMs = 15_000 } = {}) {
  if (!path.isAbsolute(configurationModule ?? '') || !path.isAbsolute(cwd ?? '') || !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(port) || port < 1 || port > 65535) throw fail('worker-gateway-configuration');
  const client = createWorkerControlClient({ origin: `https://127.0.0.1:${port}`, tls: controllerTls, serverFingerprint256,
    timeoutMs, settlementWaitMs });
  const childEnv = { ...env }; delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry, '--configuration-module', configurationModule, '--control', 'https'],
    { cwd, env: childEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stopped = false, fatal = null, stopping = null, closeResolve, stderr = '';
  const closed = new Promise(resolve => { closeResolve = resolve; });
  // 起不来时入口往标准错误写一行 { ok: false, code }：只用来把原因码带给调用方看。
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr = (stderr + text).slice(-4096); });
  child.once('error', () => { fatal ??= fail('worker-gateway-process'); });
  child.once('close', (code, signal) => {
    stopped = true;
    if (!fatal) {
      let reported = null;
      for (const text of stderr.split('\n')) { try { const row = JSON.parse(text); if (row?.ok === false && safe(row.code)) reported = row.code; } catch { /* 不是那一行 */ } }
      fatal = fail(reported ?? 'worker-gateway-process-closed');
    }
    client.stop();
    closeResolve({ pid: child.pid ?? null, exitCode: code, signal, childClosed: true, rootClosureProved: false });
  });
  // 起来了没有：问它的身份口。还没在听就隔一会儿再问；它答了别的进程号、或者别的错，都不算起来。
  const ready = (async () => {
    const deadline = Date.now() + timeoutMs; let pause = 50;
    for (;;) {
      if (stopped) throw fatal ?? fail('worker-gateway-process-closed');
      try {
        const identity = await client.identity();
        if (identity?.pid !== child.pid) throw fail('worker-gateway-identity');
        return { pid: child.pid, port };
      } catch (error) {
        if (stopped) throw fatal ?? fail('worker-gateway-process-closed');
        if (!error?.refused) throw error;
        if (Date.now() >= deadline) throw fail('worker-gateway-start-timeout');
        await delay(pause); pause = Math.min(pause * 2, 400);
      }
    }
  })();
  void ready.catch(() => {});
  const settlement = client.settlement({ gone: () => stopped });
  const observeClose = () => { let timer;
    return Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('worker-gateway-actual-close-pending')), timeoutMs); })])
      .finally(() => clearTimeout(timer)); };
  const command = fn => (stopped ? Promise.reject(fatal ?? fail('worker-gateway-closed'))
    : stopping ? Promise.reject(fail('worker-gateway-closed')) : fn());
  return { ready, closed, settlement, pid: () => child.pid,
    /** 不商量，直接结束这个子进程并等它真的关掉。只给强制路径和进程已经不听话的时候用。 */
    terminate() {
      stopping ??= closed;
      if (!stopped) { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }
      return observeClose();
    },
    prepare: input => command(() => client.prepare(input)), start: () => command(() => client.start()),
    close() {
      if (stopping) return stopping;
      stopping = (async () => {
        let error;
        if (!stopped) { try { await client.close(); } catch (cause) { if (!stopped) error = cause; } }
        const observed = await observeClose();
        if (error) throw error; if (observed.exitCode !== 0) throw fail('worker-gateway-close-failed');
        return observed;
      })();
      void stopping.catch(() => {}); return stopping;
    },
    describe: () => ({ pid: child.pid ?? null, childClosed: stopped, pendingCommands: client.describe().pendingCommands, completionReady: false }),
  };
}
