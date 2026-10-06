/**
 * 托管方渲染服务的「看画面」口子（契约 `docs/plan/hosted-render-contract.md` 第 8a 节；`docs/plan/cloud-agent-contract.md` 第 9.8 节）。
 * 管理进程用。云端 Agent 服务凭自己的服务身份向同机的渲染服务要「项目 × 版本 × 时刻（或片段）」的一帧。
 *
 *   POST http://127.0.0.1:<管理进程的诊断与代理口>/look
 *   头   x-pc-service-auth: v1.<base64url(JSON { v: 1, s, kid, d, ts, n, m })>
 *   体   { projectId, path, body, cards?, timeoutMs? }
 *
 * - `path` 只许 `LOOK_ROUTES` 里的几条（工作进程里本机 Agent 看画面用的同一批接口）；`body` 原样转给工作进程（项目内容在里面，
 *   是 Agent 服务此刻的项目副本——「这一版」由它带来，渲染服务不另取）；
 * - `cards`：这个项目内容库里卡片源码的「键 → 版本」（Agent 服务列的）。非空就必须走隔离工作进程，并等它把这几份装到至少这个版本。
 *
 * # 认身份
 *
 * 口子只绑回环（与代理口同一个监听），带 `Sec-Fetch-Site` / `Origin` 的（浏览器形状）在进到这里之前就被 403（`broker.mjs`）。
 * 调用方用**服务私钥**对「时刻、一次性随机数、请求体摘要」签名（Ed25519，用途串 `promptcut.look.v1\n…`，与握手的用途串不同，签名不能挪用）；
 * 管理进程按登记表（`<托管数据目录>/secrets/services.json`，只有公钥；文档服务认服务身份用的同一份）核对：服务名必须是 `agent`、
 * 登记的角色必须是 `agent`、这把公钥还在表里（撤钥当场失效）、时刻在前后 60 s 内、随机数没用过、请求体摘要对得上。
 * 登记表读不到、里面没有 `agent`：这个口子谁也进不来（失败即关）。私钥、签名、随机数不进日志。
 *
 * # 走哪个工作进程（不破第 7.5 节的隔离）
 *
 * - 项目必须在目录里、渲染服务的开关开着、云端 Agent 的开关开着；
 * - 内容库里**没有**卡片源码（Agent 服务报的 `cards` 是空的，常驻工作进程也确知没有）：转给常驻工作进程。它不装、不执行任何项目带来的卡，
 *   这一条与管理进程怎么路由无关——即使路由错了，常驻工作进程里也没有项目的代码可执行；
 * - **有**卡片源码（任一方说有）：只由隔离工作进程出。登记一条「要看画面」的需求，等隔离工作进程这一轮正是这个项目、卡片同步对完账、
 *   要的那几份卡装到了要的版本，才转给它。别的项目的一轮在跑时排队等（下一轮先轮到要看画面的）；管理进程绝不把一个项目的内容
 *   交给正在跑另一个项目的隔离工作进程；
 * - 转给工作进程时带那个工作进程自己的口令（`x-pc-look-key`，就是它的代理口口令；页面读不到环境变量）。工作进程的页面请求闸
 *   对这几条接口只认带对了口令的 Node 一侧的请求（`vite-gate.mjs`）；浏览器发来的照旧 403。
 *
 * # 并发、内存、时限
 *
 * - 同一时刻只转发一个看画面的请求，其余排队（最多 `maxWaiting` 个，再多回 `busy`）；在途时占一个并发名额
 *   （`busyOn()` 给管理进程：常驻工作进程的认领上限减一，已经在做的任务不打断）。看画面优先于预渲染任务：有人（模型的一轮）正等着它；
 * - 背压暂停（内存低、文档服务慢、负载高）时不接新的，回 `busy`；
 * - 不起任何新进程：画面在现有的两棵工作进程树里出，内存看护照旧量这两棵树；
 * - 每个请求有时限（缺省 60 s，上限 170 s）。到点回 `{ ok: false, look: 'timeout', error }`，不挂着。
 *
 * 回包：工作进程的 JSON 原样（`{ ok: true, … }`），或 `{ ok: false, look: <原因码>, error: <给模型看的话> }`。
 */
import { createHash, createPrivateKey, randomBytes, sign, verify } from 'node:crypto';
import { publicKeyOf, SERVICE_SIG_BYTES } from '../auth/service-identity.mjs';

export const LOOK_AUTH_HEADER = 'x-pc-service-auth';
/** 管理进程转给工作进程时带的口令头（值是那个工作进程自己的代理口口令） */
export const LOOK_KEY_HEADER = 'x-pc-look-key';
/** 能要这个口子的服务与它在登记表里必须是的角色 */
export const LOOK_SERVICE = 'agent';
export const LOOK_ROLE = 'agent';

export const LOOK_DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxTimeoutMs: 170_000,
  /** 签名里的时刻与本机时钟最多差多少 */
  skewMs: 60_000,
  /** 排队等的最多几个 */
  maxWaiting: 4,
  /** 请求体上限（项目副本上限 16 MiB，留余量） */
  maxBodyBytes: 48 * 1024 * 1024,
  /** 「要看画面」的需求在最后一次请求之后再保持多久（隔离工作进程据此不急着结束：模型多半马上再看一眼） */
  holdMs: 90_000,
  /** 等常驻工作进程报出这个项目、报出它带没带卡，最多多久 */
  settleMs: 20_000,
  /** 隔离工作进程就绪之后，等要的那几份卡装到要的版本，最多再等多久；到点照渲并在结果里注明 */
  cardWaitMs: 20_000,
  pollMs: 200,
});

/**
 * 能转给工作进程的接口。`/api/ai/visual` 只许写动图的规格（`tool: 'get_gif'`）：聊天栏的可视化记录存在工作进程里，
 * 在线页面取不到，云端不写。
 */
export const LOOK_ROUTES = Object.freeze({
  '/api/vision/snapshot': Object.freeze({ tool: 'see_frames' }),
  '/api/cards/layout': Object.freeze({ tool: 'get_layout' }),
  '/api/cards/dom': Object.freeze({ tool: 'inspect_card_dom' }),
  '/api/vision/bake': Object.freeze({ tool: 'bake_card' }),
  '/api/ai/visual': Object.freeze({ tool: 'get_gif', only: (body) => body?.tool === 'get_gif' }),
  '/api/ai/visual/render': Object.freeze({ tool: 'get_gif' }),
});

/** 工作进程里这几条接口的路径前缀（页面请求闸对它们另要口令） */
export const LOOK_WORKER_PREFIXES = Object.freeze(['/api/vision/', '/api/ai/visual', '/api/cards/dom', '/api/cards/layout']);

const sha256hex = (text) => createHash('sha256').update(text).digest('hex');
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROJECT_ID_RE = /^sp_[a-z2-7]{26}$/;

/** 用途串：与握手的 `promptcut.service.v1` 不同，签名不能互相挪用 */
export function lookPurpose({ service, instanceId, ts, nonce, digest }) {
  return Buffer.from(`promptcut.look.v1\n${service}\n${instanceId}\n${ts}\n${nonce}\n${digest}`, 'utf8');
}

/**
 * 调用方（Agent 服务）：给一个请求体签名，回请求头的值。
 * @param {{ service, kid, priv, instanceId }} key `readServiceKeyFile` 的结果
 * @param {string | Buffer} bodyText 原样发出去的请求体
 */
export function signLookRequest(key, bodyText, { now = Date.now(), nonce = randomBytes(18).toString('base64url') } = {}) {
  const priv = createPrivateKey({ key: Buffer.from(key.priv, 'base64url'), format: 'der', type: 'pkcs8' });
  const digest = sha256hex(bodyText);
  const m = sign(null, lookPurpose({ service: key.service, instanceId: key.instanceId, ts: now, nonce, digest }), priv).toString('base64url');
  const json = { v: 1, s: key.service, kid: key.kid, d: key.instanceId, ts: now, n: nonce, m };
  return `v1.${Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')}`;
}

/**
 * 核对器：带一次性随机数的记账（在时刻窗口内记着，窗口外的本来就过不了时刻那一关）。
 * @param {object} o
 * @param {{ get(name: string): null | { role: string, keys: { kid: string, pub: string }[] } } | null} o.registry 登记表（`createServiceRegistry`）
 * @returns {(header: unknown, bodyText: string | Buffer) => { ok: true, service: string, kid: string, instanceId: string } | { ok: false, reason: string }}
 */
export function createLookVerifier({ registry, now = Date.now, skewMs = LOOK_DEFAULTS.skewMs } = {}) {
  /** 随机数 → 过期时刻 */
  const seen = new Map();
  const prune = (at) => { for (const [n, until] of seen) if (until <= at) seen.delete(n); };
  return function verifyLook(header, bodyText) {
    if (!registry) return { ok: false, reason: 'no-registry' };
    if (typeof header !== 'string' || !header.startsWith('v1.') || header.length > 2048) return { ok: false, reason: 'format' };
    let json;
    try { json = JSON.parse(Buffer.from(header.slice(3), 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'format' }; }
    if (!json || typeof json !== 'object' || json.v !== 1 || typeof json.s !== 'string' || typeof json.kid !== 'string' || typeof json.d !== 'string'
      || !Number.isSafeInteger(json.ts) || typeof json.n !== 'string' || !NONCE_RE.test(json.n) || typeof json.m !== 'string') return { ok: false, reason: 'format' };
    // 只有云端 Agent 服务能要；渲染服务自己的私钥、别的服务的私钥都不行
    if (json.s !== LOOK_SERVICE) return { ok: false, reason: 'service' };
    let entry = null;
    try { entry = registry.get(json.s); } catch { entry = null; }
    if (!entry || entry.role !== LOOK_ROLE) return { ok: false, reason: 'not-registered' };
    const k = entry.keys.find((x) => x.kid === json.kid);
    if (!k) return { ok: false, reason: 'revoked' };
    const at = now();
    if (Math.abs(at - json.ts) > skewMs) return { ok: false, reason: 'expired' };
    let good = false;
    try {
      const sig = Buffer.from(json.m, 'base64url');
      good = sig.length === SERVICE_SIG_BYTES
        && verify(null, lookPurpose({ service: json.s, instanceId: json.d, ts: json.ts, nonce: json.n, digest: sha256hex(bodyText) }), publicKeyOf(k.pub), sig);
    } catch { good = false; }
    if (!good) return { ok: false, reason: 'signature' };
    prune(at);
    if (seen.has(json.n)) return { ok: false, reason: 'replay' };
    seen.set(json.n, json.ts + skewMs + 1000);
    return { ok: true, service: json.s, kid: json.kid, instanceId: json.d };
  };
}

/** 给模型看的话（原因码 → 一句）。都以「这次没看成」开头，模型据此继续，不反复重试 */
export const LOOK_ERRORS = Object.freeze({
  off: '这次没看成：这台云节点的渲染服务没有开看画面。',
  'no-project': '这次没看成：渲染服务的目录里没有这个项目。',
  'service-disabled': '这次没看成：项目创建者关掉了这个项目的渲染节点，云端渲不了画面。',
  'agent-disabled': '这次没看成：项目创建者关掉了这个项目的云端 Agent。',
  busy: '这次没看成：渲染服务现在忙（看画面的请求排满了，或节点正在让出资源）。过一会儿再看，先按项目内容继续。',
  'not-ready': '这次没看成：渲染服务还没连上这个项目。过几秒再看一次。',
  'iso-busy': '这次没看成：渲染服务正在渲别的项目的自定义卡片，带自定义卡片的项目要排队。过一会儿再看，先按项目内容继续。',
  'iso-off': '这次没看成：这台云节点没有开自定义卡片的渲染，带自定义卡片的项目看不了画面。',
  'iso-failed': '这次没看成：渲染这个项目自定义卡片的工作进程没起来。先按项目内容继续，并在汇报里说明没有看过画面。',
  timeout: '这次没看成：渲染服务在时限内没有出图。先按项目内容继续，稍后可以再看一次。',
  failed: '这次没看成：渲染画面的工作进程出了错。',
});

const fail = (status, look, extra = '') => ({ status, body: { ok: false, look, error: `${LOOK_ERRORS[look] ?? '这次没看成。'}${extra}` } });

/**
 * @param {object} o
 * @param {boolean} o.enabled 配置里开没开
 * @param {(header: unknown, bodyText: string) => object} o.verify `createLookVerifier` 的结果
 * @param {(projectId: string) => null | { enabled: boolean, active: boolean, hosted?: object }} o.project 目录里的这一项
 * @param {() => boolean} o.paused 背压是不是暂停着
 * @param {() => { port: number, key: string, running: boolean, node(projectId: string): object | null }} o.resident 常驻工作进程此刻的样子；
 *   `node` 回它诊断里这个项目的节点（`{ connected, cards?: { state } }`），没连回 null
 * @param {() => { enabled: boolean, port: number, key: string | null, current: null | { projectId: string, phase: string }, report: null | object, lastRun: null | object }} o.iso
 *   隔离工作进程此刻的样子；`report` 是它这一轮最近交的诊断（`{ queue: { nodes, cardSync, cardCode } }`）
 * @param {(projectId: string, untilMs: number) => void} o.want 登记「这个项目要看画面」（隔离工作进程的候选）
 */
export function createLook({
  enabled = true, verify: verifyAuth, project, paused = () => false, resident, iso, want = () => {},
  fetch: fetchImpl = globalThis.fetch, now = Date.now, log = () => {}, limits: limitsIn = {},
} = {}) {
  const limits = { ...LOOK_DEFAULTS, ...limitsIn };
  const stats = { requests: 0, served: 0, refused: 0, failed: 0, unauthorized: 0, lastMs: null, lastAt: null, byWorker: { resident: 0, isolated: 0 } };
  /** 在途的那一个：`{ projectId, worker: 'resident' | 'isolated' | null, since }` */
  let current = null;
  /** 在途的加排队的 */
  let pending = 0;
  let chain = Promise.resolve();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 隔离工作进程这一轮对这个项目是不是可以出图了；回 `{ ready, stale? }` */
  function isoReadyFor(projectId, cards, readySince) {
    const s = iso();
    if (!s.current || s.current.projectId !== projectId || s.current.phase !== 'running' || !s.key) return { ready: false };
    const q = s.report?.queue ?? null;
    const node = q?.nodes?.find((n) => n.projectId === projectId) ?? null;
    if (!node || node.connected !== true || node.cards?.state !== 'synced' || q?.cardCode?.settled !== true) return { ready: false };
    // 要的那几份卡装到了要的版本没有（装上或被预检拒掉都算有了结论）
    const sync = (q.cardSync ?? []).find((c) => c?.projectId === projectId) ?? null;
    const records = sync?.records ?? {};
    const notices = Array.isArray(sync?.notices) ? sync.notices : [];
    const settled = Object.entries(cards).every(([key, rev]) => {
      const have = records[key];
      if (have !== undefined && (!Number.isFinite(rev) || (Number.isFinite(have) && have >= rev))) return true;
      return notices.some((n) => n?.key === key && (!Number.isFinite(rev) || (Number.isFinite(n.rev) && n.rev >= rev)));
    });
    if (settled) return { ready: true };
    // 就绪之后再等一会儿还没对上：照渲，结果里注明
    if (readySince !== null && now() - readySince >= limits.cardWaitMs) return { ready: true, stale: true };
    return { ready: false, base: true };
  }

  async function route(projectId, cards, deadline) {
    const wantsIso = Object.keys(cards).length > 0;
    let isoSince = null;
    let baseSince = null;
    for (;;) {
      const p = project(projectId);
      if (!p) return fail(404, 'no-project');
      if (!p.enabled) return fail(403, 'service-disabled');
      if (p.hosted?.agent?.enabled === false) return fail(403, 'agent-disabled');
      const r = resident();
      const node = r.running ? r.node(projectId) : null;
      const state = node?.cards?.state ?? null; // 'none' | 'some' | 'unknown' | null（常驻工作进程不判有没有卡：USER_CARDS=off）
      const needIso = wantsIso || state === 'some';
      if (needIso) {
        const s = iso();
        if (!s.enabled) return fail(503, 'iso-off');
        want(projectId, now() + limits.holdMs);
        isoSince ??= now();
        const ready = isoReadyFor(projectId, cards, baseSince);
        if (ready.base) baseSince ??= now();
        if (ready.ready) return { target: { worker: 'isolated', port: s.port, key: s.key }, stale: ready.stale === true };
        // 这一轮为它起过、又没起成（起不来、内存超限）：不干等到时限
        if (!s.current && s.lastRun && s.lastRun.projectId === projectId && s.lastRun.at >= isoSince && ['prepare-failed', 'start-timeout', 'oom', 'exit'].includes(s.lastRun.reason)) return fail(503, 'iso-failed');
      } else if (node && node.connected === true && (state === 'none' || state === null)) {
        return { target: { worker: 'resident', port: r.port, key: r.key }, stale: false };
      }
      if (now() >= deadline) {
        if (needIso) { const s = iso(); return fail(504, s.current && s.current.projectId !== projectId ? 'iso-busy' : 'timeout'); }
        return fail(504, node ? 'timeout' : 'not-ready');
      }
      await sleep(limits.pollMs);
    }
  }

  async function serve({ projectId, path, body, cards, timeoutMs }) {
    const started = now();
    const deadline = started + timeoutMs;
    current = { projectId, worker: null, since: started };
    try {
      const routed = await route(projectId, cards, Math.min(deadline, started + Math.max(limits.settleMs, timeoutMs - 5000)));
      if (!routed.target) return routed;
      const { target } = routed;
      current.worker = target.worker;
      const left = Math.max(1000, deadline - now());
      // 在途期间需求不过期（隔离工作进程不会在出图的半路上因为闲置被结束）
      const keep = target.worker === 'isolated' ? setInterval(() => want(projectId, now() + limits.holdMs), 5000) : null;
      keep?.unref?.();
      try {
        const res = await fetchImpl(`http://127.0.0.1:${target.port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [LOOK_KEY_HEADER]: target.key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(left),
        });
        const data = await res.json().catch(() => null);
        // 转出去之后隔离工作进程换了一轮：这份结果不作数（不该发生：在途期间需求不过期；这里只是兜底）
        if (target.worker === 'isolated' && iso().key !== target.key) return fail(503, 'iso-failed');
        if (!data || typeof data !== 'object') return fail(502, 'failed', `（工作进程回了 HTTP ${res.status}）`);
        stats.byWorker[target.worker] += 1;
        if (routed.stale && data.ok !== false) {
          const note = '注意：这个项目刚改过的卡片源码可能还没同步到渲染节点，画面里的那张卡可能是上一版。';
          data.note = typeof data.note === 'string' && data.note ? `${data.note} ${note}` : note;
        }
        return { status: 200, body: data, worker: target.worker };
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return fail(504, 'timeout');
        return fail(502, 'failed', `（${String(err?.cause?.code ?? err?.code ?? err?.message ?? err).slice(0, 80)}）`);
      } finally {
        if (keep) clearInterval(keep);
        if (target.worker === 'isolated') want(projectId, now() + limits.holdMs);
      }
    } finally {
      current = null;
    }
  }

  return {
    enabled,
    limits,
    /**
     * 处理一个请求。
     * @param {{ auth: unknown, bodyText: string }} input 请求头里的身份证明与原样的请求体
     * @returns {Promise<{ status: number, body: object }>}
     */
    async handle({ auth, bodyText }) {
      stats.requests += 1;
      // 关着：与没有这条路一样答，不透露别的
      if (!enabled) { stats.refused += 1; return { status: 404, body: { ok: false, look: 'off', error: LOOK_ERRORS.off } }; }
      const who = verifyAuth(auth, bodyText);
      if (!who.ok) {
        stats.unauthorized += 1;
        log('look.unauthorized', { reason: who.reason });
        return { status: 401, body: { ok: false, error: 'unauthorized' } };
      }
      let msg = null;
      try { msg = JSON.parse(bodyText); } catch { msg = null; }
      const route0 = msg && typeof msg.path === 'string' && Object.hasOwn(LOOK_ROUTES, msg.path) ? LOOK_ROUTES[msg.path] : null;
      if (!msg || typeof msg !== 'object' || typeof msg.projectId !== 'string' || !PROJECT_ID_RE.test(msg.projectId) || !route0
        || !msg.body || typeof msg.body !== 'object' || Array.isArray(msg.body) || (route0.only && !route0.only(msg.body))) {
        stats.refused += 1;
        return { status: 400, body: { ok: false, error: 'bad-request' } };
      }
      const cards = {};
      if (msg.cards && typeof msg.cards === 'object' && !Array.isArray(msg.cards)) {
        for (const [k, v] of Object.entries(msg.cards).slice(0, 512)) if (typeof k === 'string' && k.length <= 256) cards[k] = Number.isFinite(v) ? v : null;
      }
      const timeoutMs = Math.min(limits.maxTimeoutMs, Math.max(2000, Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : limits.timeoutMs));
      if (paused()) { stats.refused += 1; log('look.refused', { projectId: msg.projectId, reason: 'backpressure' }); return fail(503, 'busy'); }
      // 一个在途，最多再排 maxWaiting 个
      if (pending >= limits.maxWaiting + 1) { stats.refused += 1; log('look.refused', { projectId: msg.projectId, reason: 'queue-full' }); return fail(503, 'busy'); }
      pending += 1;
      const arrived = now();
      const run = chain.then(async () => {
        try {
          // 排队把时限等光了：不再去渲
          const left = timeoutMs - (now() - arrived);
          if (left < 1500) return fail(504, 'busy');
          return await serve({ projectId: msg.projectId, path: msg.path, body: msg.body, cards, timeoutMs: left });
        } finally {
          pending -= 1;
        }
      });
      chain = run.catch(() => {});
      let out;
      try { out = await run; } catch (err) { out = fail(500, 'failed', `（${String(err?.message ?? err).slice(0, 80)}）`); }
      const ms = now() - arrived;
      stats.lastMs = ms;
      stats.lastAt = now();
      if (out.status === 200 && out.body?.ok !== false) stats.served += 1;
      else if (out.status === 200) stats.failed += 1;
      else if (out.status >= 500) stats.failed += 1;
      else stats.refused += 1;
      log('look.done', { projectId: msg.projectId, tool: route0.tool, status: out.status, look: out.body?.look ?? null, ok: out.body?.ok !== false, worker: out.worker ?? null, ms, from: who.instanceId.slice(0, 8) });
      return { status: out.status, body: out.body };
    },
    /** 在途的那个请求正在哪个工作进程上出图（管理进程据此让出一个并发名额）；没有回 null */
    busyOn: () => current?.worker ?? null,
    /** 在途的那个请求是哪个项目的（还在等路由时也算）；没有回 null */
    busyProject: () => current?.projectId ?? null,
    status: () => ({ enabled, inFlight: current ? { projectId: current.projectId, worker: current.worker, ms: now() - current.since } : null, waiting: Math.max(0, pending - (current ? 1 : 0)), ...stats, byWorker: { ...stats.byWorker } }),
  };
}
