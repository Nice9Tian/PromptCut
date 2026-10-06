/**
 * 等「写入停止」:重启新节点的托管服务之前,先确认用户桌面上开着的 PromptCut(5210)没有在往云端项目里写。
 * 只读:整份脚本只发两种请求,都是 GET,地址只能是下面两个,别的路径在代码里就拒绝(`readOnlyGet` 的白名单,单测守着):
 *
 *   GET http://127.0.0.1:5210/api/agent/status          Agent 绑没绑项目、各对话的提交数、项目副本的版本(link.replica.rev)
 *   GET http://127.0.0.1:5210/api/media/upload-queue    素材上传队列的状态
 *
 * 判「安静」的三条,采样间隔内全部成立才算这一拍安静,连续安静满 --quiet-min 分钟才算「写入已停止」:
 *   1. Agent 对话不再提交:agent/status 里 stats.executed、stats.committed 与上一拍相同;
 *   2. 项目版本不变:link.replica.rev 与上一拍相同(没绑项目 = 页面没连着任何云端项目,版本看不到,按不变算);
 *   3. 上传队列空闲:upload-queue 里没有在传(working 假、current 空)、没有排队的项,且 done / enqueued 计数与上一拍相同
 *      (queue 为 null 也算空闲)。
 * 5210 连不上(软件没开):按「没有桌面端在写」算安静,结论里单独写明,因为别处的成员是看不到的。
 *
 * 用法(这份脚本不会在任务书之外的时机运行;对 5210 的访问只有上面两个只读请求):
 *   node scripts/acceptance/wait-writes-quiet.mjs [--base http://127.0.0.1:5210] [--interval-s 20] [--quiet-min 5] [--max-hours 3] [--json]
 *
 * 输出:每次采样一行(时间、Agent 提交数、项目版本、队列、已安静多久);最后一行是结论,以 `RESULT ` 开头的 JSON(`--json` 时整份都是 JSON 行)。
 * 退出码:0 写入已停止(可以重启);3 等满 --max-hours 仍在写(停下告诉用户,不要重启);2 参数不对。
 *
 * 只允许回环地址:--base 给了别的主机一律拒绝,免得误对远端发请求。不发任何写请求、不带任何令牌。
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** 唯一允许的两个路径 */
export const ALLOWED_PATHS = ['/api/agent/status', '/api/media/upload-queue'];

export const DEFAULTS = { base: 'http://127.0.0.1:5210', intervalSec: 20, quietMin: 5, maxHours: 3, json: false };

export function parseArgs(argv) {
  const o = { ...DEFAULTS };
  const need = (i, n) => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${n} 缺少参数`); return v; };
  const num = (i, n, min, max) => { const v = Number(need(i, n)); if (!(v >= min && v <= max)) throw new Error(`${n} 要 ${min}～${max} 的数`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') { o.base = need(i, a); i++; }
    else if (a === '--interval-s') { o.intervalSec = num(i, a, 0.05, 600); i++; }
    else if (a === '--quiet-min') { o.quietMin = num(i, a, 0.001, 120); i++; }
    else if (a === '--max-hours') { o.maxHours = num(i, a, 0.0005, 48); i++; }
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`看不懂的参数:${a}`);
  }
  assertLoopback(o.base);
  return o;
}

/** --base 只能是回环地址、http、不带路径 */
export function assertLoopback(base) {
  let u;
  try { u = new URL(base); } catch { throw new Error(`--base ${base} 不是地址`); }
  if (u.protocol !== 'http:') throw new Error('--base 只许 http(本机的回环地址)');
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) throw new Error(`--base 只许回环地址,收到 ${u.hostname}`);
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('--base 不带路径');
  if (u.username || u.password || u.search) throw new Error('--base 不带用户名、口令、查询');
}

/**
 * 只读的 GET。路径不在白名单里直接抛错,不发请求。返回 { status, json }(连不上抛 { code: 'ECONNREFUSED' 等 })。
 */
export function readOnlyGet(base, urlPath, { timeoutMs = 8000 } = {}) {
  if (!ALLOWED_PATHS.includes(urlPath)) return Promise.reject(new Error(`拒绝:${urlPath} 不在只读白名单里`));
  try { assertLoopback(base); } catch (e) { return Promise.reject(e); }
  const u = new URL(urlPath, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', hostname: u.hostname === '[::1]' ? '::1' : u.hostname, port: u.port, path: u.pathname, headers: { Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4_000_000) req.destroy(new Error('响应过大')); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* 留 null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** 把两个接口的回包压成一拍的快照。reachable 假 = 软件没开(连不上) */
export function snapshotOf(agentRes, queueRes) {
  if (!agentRes && !queueRes) return { reachable: false };
  const a = agentRes?.json;
  const q = queueRes?.json;
  const bound = !!(a && a.bound);
  const stats = (bound && a.stats) || {};
  const queue = q && q.queue ? q.queue : null;
  return {
    reachable: true,
    bound,
    committed: Number(stats.committed ?? 0),
    executed: Number(stats.executed ?? 0),
    rev: bound ? (a.link?.replica?.rev ?? null) : null,
    conversations: bound && Array.isArray(a.conversations) ? a.conversations.length : 0,
    queueIdle: !queue || (!queue.working && (queue.current === null || queue.current === undefined) && !(queue.items && queue.items.length)),
    queueItems: queue?.items?.length ?? 0,
    queueDone: Number(queue?.done ?? 0),
    queueEnqueued: Number(queue?.enqueued ?? 0),
    httpOk: (agentRes?.status ?? 200) < 400 && (queueRes?.status ?? 200) < 400,
  };
}

/**
 * 这一拍相对上一拍是否安静。返回 { quiet, reasons }。第一拍没有上一拍,只看队列是否空闲(计数从这一拍起算)。
 */
export function evaluate(prev, cur) {
  const reasons = [];
  if (!cur.reachable) {
    return { quiet: true, reasons: ['5210 连不上(软件没开),按没有桌面端在写算'] , appDown: true };
  }
  if (!cur.queueIdle) reasons.push(`上传队列不空闲(排队 ${cur.queueItems} 项)`);
  if (prev && prev.reachable) {
    if (cur.executed !== prev.executed || cur.committed !== prev.committed) reasons.push(`Agent 对话在提交(executed ${prev.executed}→${cur.executed},committed ${prev.committed}→${cur.committed})`);
    if (cur.rev !== prev.rev) reasons.push(`项目版本变了(${prev.rev}→${cur.rev})`);
    if (cur.queueDone !== prev.queueDone || cur.queueEnqueued !== prev.queueEnqueued) reasons.push(`上传队列计数在动(done ${prev.queueDone}→${cur.queueDone},enqueued ${prev.queueEnqueued}→${cur.queueEnqueued})`);
  } else if (prev && !prev.reachable) {
    reasons.push('上一拍还连不上、这一拍连上了(软件刚起来),从这一拍重新算');
  }
  return { quiet: reasons.length === 0, reasons };
}

/**
 * 主循环。deps 可注入(单测用假时钟与假请求):
 *   fetchBoth()  → { agent, queue }(任一连不上就两个都 null)
 *   now()        → 毫秒
 *   sleep(ms)
 *   log(line)
 * 返回 { status: 'quiet' | 'timeout', ... }。
 */
export async function waitForQuiet(opts, deps) {
  const { fetchBoth, now, sleep, log } = deps;
  const quietMs = opts.quietMin * 60_000;
  const maxMs = opts.maxHours * 3_600_000;
  const t0 = now();
  let prev = null;
  let quietSince = null;
  let samples = 0;
  let sawApp = false, sawDown = false;
  for (;;) {
    const { agent, queue } = await fetchBoth();
    const cur = snapshotOf(agent, queue);
    const ev = evaluate(prev, cur);
    samples++;
    if (cur.reachable) sawApp = true; else sawDown = true;
    const t = now();
    if (ev.quiet) { if (quietSince === null) quietSince = t; } else quietSince = null;
    const quietFor = quietSince === null ? 0 : t - quietSince;
    log(JSON.stringify({
      at: new Date(t).toISOString(), reachable: cur.reachable, bound: cur.bound ?? null, committed: cur.committed ?? null, executed: cur.executed ?? null,
      rev: cur.rev ?? null, queueIdle: cur.queueIdle ?? null, queueItems: cur.queueItems ?? null,
      quiet: ev.quiet, quietForSec: Math.round(quietFor / 1000), reasons: ev.reasons,
    }));
    if (quietSince !== null && quietFor >= quietMs) {
      return { status: 'quiet', samples, waitedSec: Math.round((t - t0) / 1000), appDownOnly: sawDown && !sawApp, lastRev: cur.rev ?? null };
    }
    if (t - t0 >= maxMs) {
      return { status: 'timeout', samples, waitedSec: Math.round((t - t0) / 1000), lastReasons: ev.reasons, lastRev: cur.rev ?? null };
    }
    prev = cur;
    await sleep(Math.min(opts.intervalSec * 1000, Math.max(1, maxMs - (t - t0))));
  }
}

export function makeFetchBoth(base) {
  return async () => {
    try {
      const [agent, queue] = await Promise.all([readOnlyGet(base, ALLOWED_PATHS[0]), readOnlyGet(base, ALLOWED_PATHS[1])]);
      return { agent, queue };
    } catch (e) {
      if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(e.code)) return { agent: null, queue: null };
      throw e;
    }
  };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) { console.log('用法见文件头注释'); return 0; }
  console.log(`# 只读等待写入停止:只发 GET ${ALLOWED_PATHS.join('、GET ')}(${opts.base});间隔 ${opts.intervalSec}s,连续安静 ${opts.quietMin} 分钟算停止,最长等 ${opts.maxHours} 小时`);
  const res = await waitForQuiet(opts, {
    fetchBoth: makeFetchBoth(opts.base), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (l) => console.log(l),
  });
  const verdict = res.status === 'quiet'
    ? { ...res, conclusion: res.appDownOnly ? '写入已停止:5210 一直连不上(桌面版没开);别处的成员看不到,重启前仍要告知用户' : '写入已停止,可以重启托管服务' }
    : { ...res, conclusion: `等满 ${opts.maxHours} 小时仍在写,停下告诉用户,不要重启` };
  console.log('RESULT ' + JSON.stringify(verdict));
  return res.status === 'quiet' ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
}
