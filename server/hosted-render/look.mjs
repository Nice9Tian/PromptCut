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
 * # 排队、重试、时限（0.7.18 第 3 项的云端排队；队列本身在 `render-requests.mjs`）
 *
 * - **忙了就排队，不回「忙」**（2026-10-08 用户审定）：每个请求先登记进队列，轮到了才转给工作进程。背压暂停（内存低、文档服务慢、
 *   负载高）、隔离工作进程正装着别的项目、常驻工作进程还没连上这个项目、产物到了容量上限（只挡要写产物的 `bake_card`）——都是
 *   「排着等」，等的原因记在请求的 `blockedReason` 里，状态口看得到；等的那件事过去了自动接着做；
 * - 同一时刻只转发一个，在途时占一个并发名额；排着的请求里有常驻工作进程该出的，也先替它留出一个名额（`reserveOn()`）——
 *   **云端 Agent 要看画面的请求优先于预渲染任务**：已经在做的任务不打断，只是不再认领新的；
 * - 排着的按登记先后做，但排在前面的那个此刻做不了（它的项目还没轮到隔离工作进程）时不挡后面做得了的；
 * - **一分钟乘三次**（2026-10-09 用户定，`docs/plan/account-binding-task.md`「即时渲染卡住」）：转给工作进程之后，渲染这一段每次最多等
 *   `attemptMs`（一分钟）；到点没出来、工作进程出错、隔离工作进程那一轮没起成，都自动重试，最多重试 `retries`（三）次；都没成才回
 *   「这次没看成」。一分钟只算渲染本身，不含排队和把项目装进隔离工作进程的时间；
 * - 排队没有「一分钟」的限制，只有一个防呆的上限 `maxQueueMs`（三十分钟〔裁，三级〕），到了如实回「这次没看成」；
 * - 不起任何新进程：画面在现有的两棵工作进程树里出，内存看护照旧量这两棵树。
 *
 * # 两种调用法
 *
 * - **登记了再来问**（云端 Agent 服务用，`server/agent-service/look-client.mjs`）：`POST /look` 的请求体里带 `requestId`（调用方现生成的
 *   随机串，重发同一个 id 不会登记两次）→ 立刻回 202 `{ ok: true, requestId, state: 'queued', queuePosition }`；之后
 *   `POST /look/poll { requestId, waitMs? }`（最多挂 `maxPollMs`，出了结果立刻回）→ 还没好回 202，好了回最终的那一份；
 *   `POST /look/cancel { requestId }` 撤回。这种请求**落盘**：管理进程重启后还在队列里，调用方接着问就行；调用方 `orphanMs`
 *   没来问的（它自己没了）撤掉，不占着队列；
 * - **同步等**（请求体里不带 `requestId`；演练与旧调用方用）：同一条队列、同一套重试，只是这条连接一直挂到出结果或到 `timeoutMs`
 *   （缺省 60 s，上限 170 s）。不落盘（连接随重启就断了）。
 *
 * 回包：工作进程的 JSON 原样（`{ ok: true, … }`），或 `{ ok: false, look: <原因码>, error: <给模型看的话> }`。
 */
import { createHash, createPrivateKey, randomBytes, sign, verify } from 'node:crypto';
import { publicKeyOf, SERVICE_SIG_BYTES } from '../auth/service-identity.mjs';
import { createRenderRequests, isFinal, REQUEST_ID_RE } from './render-requests.mjs';

export const LOOK_AUTH_HEADER = 'x-pc-service-auth';
/** 管理进程转给工作进程时带的口令头（值是那个工作进程自己的代理口口令） */
export const LOOK_KEY_HEADER = 'x-pc-look-key';
/** 能要这个口子的服务与它在登记表里必须是的角色 */
export const LOOK_SERVICE = 'agent';
export const LOOK_ROLE = 'agent';

export const LOOK_DEFAULTS = Object.freeze({
  /** 「同步等」的调用法（请求体里不带 requestId）整条连接最多挂多久 */
  timeoutMs: 60_000,
  maxTimeoutMs: 170_000,
  /** 签名里的时刻与本机时钟最多差多少 */
  skewMs: 60_000,
  /** 渲染这一段每次最多等多久（2026-10-09 用户定：一分钟；不含排队与把项目装进隔离工作进程的时间） */
  attemptMs: 60_000,
  /** 没成自动重试几次（2026-10-09 用户定：三次，每次也是一分钟）。所以最多试 1 + 3 次〔裁：「允许三次重试」按字面读成第一次之外再三次〕 */
  retries: 3,
  /** 排队最多等多久；到了如实回「这次没看成」〔裁，三级：防呆上限，不是「一分钟」那条规矩的一部分〕 */
  maxQueueMs: 30 * 60_000,
  /** 「登记了再来问」的请求：调用方这么久没来问就撤掉（它自己没了） */
  orphanMs: 120_000,
  /** 一次 `/look/poll` 最多挂多久 */
  maxPollMs: 25_000,
  /** 请求体上限（项目副本上限 16 MiB，留余量） */
  maxBodyBytes: 48 * 1024 * 1024,
  /**
   * 「要看画面」的需求登记一次管多久。排着、在做的请求会一直续（调度每一拍、在途每 5 秒），所以它只要比续的间隔长。
   * 〔裁，三级〕原来是 90 秒（最后一次请求之后隔离工作进程多留 90 秒，等模型再看一眼）；闲置回收改成五分钟之后这层保留没有用了，
   * 留着只会让「空闲满五分钟才让位」变成五分钟加 90 秒。现在出完图最多再算 15 秒有需求，之后开始算空闲
   */
  holdMs: 15_000,
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
  // 卡片声音（`cloud-agent-contract.md` 第 9.4c 节）：卡片的 audio() 在渲染页里求值，回 WAV；与出一帧走同一条路由、同一套隔离
  // 它不是「看画面」：算一段声音可以比一帧久得多。所以不套「每次一分钟、重试三次」，照原来的办法——这一次最多等调用方给的时限
  // （`timeoutMs`，上限 `maxTimeoutMs`），没成不自动重试〔裁，三级〕。排队、背压、重启接续与看画面一样
  '/api/cards/audio': Object.freeze({ tool: 'render_card_audio', attempt: 'caller', retries: 0 }),
});

/** 工作进程里这几条接口的路径前缀（页面请求闸对它们另要口令） */
export const LOOK_WORKER_PREFIXES = Object.freeze(['/api/vision/', '/api/ai/visual', '/api/cards/dom', '/api/cards/layout', '/api/cards/audio']);

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
  cancelled: '这次没看成：这个看画面的请求已经撤回。',
});

/** 要往素材服务写产物的接口：产物到了容量上限（507）时这几条排着等，别的照常出 */
const WRITES_ARTIFACT = new Set(['/api/vision/bake']);

const fail = (status, look, extra = '') => ({ status, body: { ok: false, look, error: `${LOOK_ERRORS[look] ?? '这次没看成。'}${extra}` } });


const pending202 = (requests, e) => ({
  status: 202,
  body: { ok: true, requestId: e.id, state: e.state, queuePosition: requests.position(e), attempts: e.attempts, ...(e.blockedReason ? { blockedReason: e.blockedReason } : {}) },
});

/**
 * @param {object} o
 * @param {boolean} o.enabled 配置里开没开
 * @param {(header: unknown, bodyText: string) => object} o.verify `createLookVerifier` 的结果
 * @param {(projectId: string) => null | { enabled: boolean, active: boolean, hosted?: object }} o.project 目录里的这一项
 * @param {() => boolean} [o.directoryReady] 目录清单拿到过没有。管理进程刚起来、还没拿到时「目录里没有这个项目」不作数：
 *   重启后接回来的请求这时候排着等，不能被当成项目不在了
 * @param {() => boolean} o.paused 背压是不是暂停着
 * @param {() => boolean} [o.storagePaused] 产物是不是到了容量上限（工作进程报的 `quotaPausedUntil` 还没过）
 * @param {() => { port: number, key: string, running: boolean, node(projectId: string): object | null }} o.resident 常驻工作进程此刻的样子；
 *   `node` 回它诊断里这个项目的节点（`{ connected, cards?: { state } }`），没连回 null
 * @param {() => { enabled: boolean, port: number, key: string | null, current: null | { projectId: string, phase: string }, report: null | object, lastRun: null | object }} o.iso
 *   隔离工作进程此刻的样子；`report` 是它这一轮最近交的诊断（`{ queue: { nodes, cardSync, cardCode } }`）
 * @param {(projectId: string, untilMs: number, o?: { fresh?: boolean }) => void} o.want 登记「这个项目要看画面」（隔离工作进程的候选）；
 *   `fresh`：为它起的那一轮没起成，这是重试——当成一批新的需求（不然隔离的编排会按「同一批先不再起」跳过它）
 * @param {ReturnType<typeof createRenderRequests>} [o.requests] 队列；不给就用一条只在内存里的
 */
export function createLook({
  enabled = true, verify: verifyAuth, project, directoryReady = () => true, paused = () => false, storagePaused = () => false, resident, iso, want = () => {},
  requests: requestsIn = null,
  fetch: fetchImpl = globalThis.fetch, now = Date.now, log = () => {}, limits: limitsIn = {},
} = {}) {
  const limits = { ...LOOK_DEFAULTS, ...limitsIn };
  const requests = requestsIn ?? createRenderRequests({ now, log });
  const stats = { requests: 0, served: 0, refused: 0, failed: 0, unauthorized: 0, retried: 0, over5min: 0, lastMs: null, lastAt: null, byWorker: { resident: 0, isolated: 0 } };
  /** 在途的那一个：`{ id, projectId, worker, since, abort }` */
  let current = null;
  let timer = null;
  let syncSeq = 0;

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

  /**
   * 这个请求此刻能不能做（不等、不睡）。回三种之一：
   *   `{ fail }`    做不了，而且等也没用（项目不在了、开关关了、这台节点不出带卡的画面、为它起的隔离工作进程重试用完了）
   *   `{ target }`  轮到了：转给这个工作进程
   *   `{ wait }`    排着等，`wait` 是原因
   */
  function routeOnce(e) {
    const { projectId, cards } = e;
    if (!directoryReady()) return { wait: 'directory' };
    const p = project(projectId);
    if (!p) return { fail: fail(404, 'no-project') };
    if (!p.enabled) return { fail: fail(403, 'service-disabled') };
    if (p.hosted?.agent?.enabled === false) return { fail: fail(403, 'agent-disabled') };
    const r = resident();
    const node = r.running ? r.node(projectId) : null;
    const state = node?.cards?.state ?? null; // 'none' | 'some' | 'unknown' | null（常驻工作进程不判有没有卡：USER_CARDS=off）
    const needIso = Object.keys(cards).length > 0 || state === 'some';
    e.needIso = needIso;
    if (needIso) {
      const s = iso();
      if (!s.enabled) return { fail: fail(503, 'iso-off') };
      // 排着的时候需求一直登记着：隔离工作进程的编排据此把这个项目当候选（并排在只有预渲染任务的项目前面）
      want(projectId, now() + limits.holdMs);
      e.isoSince ??= now();
      // 为它起过、又没起成（起不来、内存超限、进程自己没了）：算一次没成；还有重试次数就再要一轮
      if (!s.current && s.lastRun && s.lastRun.projectId === projectId && s.lastRun.at >= e.isoSince && ['prepare-failed', 'start-timeout', 'oom', 'exit'].includes(s.lastRun.reason)) {
        e.attempts += 1;
        stats.retried += 1;
        log('look.retry', { id: e.id.slice(0, 8), projectId, why: `iso-${s.lastRun.reason}`, attempts: e.attempts });
        if (e.attempts > (e.retries ?? limits.retries)) return { fail: fail(503, 'iso-failed') };
        e.isoSince = s.lastRun.at + 1;
        e.baseSince = null;
        requests.touchAttempts(e);
        want(projectId, now() + limits.holdMs, { fresh: true });
        return { wait: 'iso-restart' };
      }
    }
    // 背压暂停：排着等它过去（不回「忙」）
    if (paused()) return { wait: 'backpressure' };
    if (WRITES_ARTIFACT.has(e.path) && storagePaused()) return { wait: 'storage-pressure' };
    if (needIso) {
      const s = iso();
      const ready = isoReadyFor(projectId, cards, e.baseSince ?? null);
      if (ready.base) e.baseSince ??= now();
      if (ready.ready) return { target: { worker: 'isolated', port: s.port, key: s.key }, stale: ready.stale === true };
      return { wait: s.current && s.current.projectId !== projectId ? 'iso-other-project' : 'iso-loading' };
    }
    if (node && node.connected === true && (state === 'none' || state === null)) return { target: { worker: 'resident', port: r.port, key: r.key }, stale: false };
    return { wait: 'not-ready' };
  }

  /** 等到头了还没轮到：按它最后在等什么，如实回 */
  function waitedOut(e) {
    if (e.blockedReason === 'iso-other-project') return fail(504, 'iso-busy');
    if (e.blockedReason === 'not-ready') return fail(504, 'not-ready');
    return fail(504, 'timeout');
  }

  function settle(e, state, out) {
    requests.finish(e, state, out);
    const ms = now() - e.createdAt;
    stats.lastMs = ms;
    stats.lastAt = now();
    if (state === 'done' && out.body?.ok !== false) stats.served += 1;
    else if (state === 'cancelled') stats.refused += 1;
    else if (out.status === 200 || out.status >= 500) stats.failed += 1;
    else stats.refused += 1;
    // 端到端超过五分钟的单独数（`render-scheduling-supplement.md` 第 4.1 节：不能只看平均）
    if (ms > 5 * 60_000) stats.over5min += 1;
    log('look.done', {
      id: e.id.slice(0, 8), projectId: e.projectId, tool: e.tool, state, status: out.status, look: out.body?.look ?? null, ok: out.body?.ok !== false, worker: out.worker ?? null,
      ms, queuedMs: e.waitedMs, attempts: e.attempts, restored: e.restored === true, from: String(e.owner ?? '').slice(0, 8),
    });
  }

  /** 转给工作进程做一次；最多 `attemptMs` */
  async function attempt(e, routed) {
    const { target } = routed;
    const { projectId } = e;
    const abort = new AbortController();
    requests.start(e);
    current = { id: e.id, projectId, worker: target.worker, since: now(), abort };
    const room = e.deadline ? Math.max(1000, e.deadline - now()) : Infinity;
    const limit = Math.min(e.attemptMs ?? limits.attemptMs, room);
    // 在途期间需求不过期（隔离工作进程不会在出图的半路上因为闲置被结束）
    const keep = target.worker === 'isolated' ? setInterval(() => want(projectId, now() + limits.holdMs), 5000) : null;
    keep?.unref?.();
    /** `{ final }` 出了结果；`{ retry, out }` 这一次没成；`{ cancelled }` 被撤回 */
    let res;
    try {
      const r = await fetchImpl(`http://127.0.0.1:${target.port}${e.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [LOOK_KEY_HEADER]: target.key },
        body: JSON.stringify(e.body),
        signal: AbortSignal.any([AbortSignal.timeout(limit), abort.signal]),
      });
      const data = await r.json().catch(() => null);
      // 转出去之后隔离工作进程换了一轮：这份结果不作数（不该发生：在途期间需求不过期；这里只是兜底）
      if (target.worker === 'isolated' && iso().key !== target.key) res = { retry: 'iso-changed', out: fail(503, 'iso-failed') };
      else if (!data || typeof data !== 'object') res = { retry: 'bad-reply', out: fail(502, 'failed', `（工作进程回了 HTTP ${r.status}）`) };
      else {
        stats.byWorker[target.worker] += 1;
        if (routed.stale && data.ok !== false) {
          const note = '注意：这个项目刚改过的卡片源码可能还没同步到渲染节点，画面里的那张卡可能是上一版。';
          data.note = typeof data.note === 'string' && data.note ? `${data.note} ${note}` : note;
        }
        res = { final: { status: 200, body: data, worker: target.worker } };
      }
    } catch (err) {
      if (abort.signal.aborted) res = { cancelled: true };
      else if (err?.name === 'TimeoutError' || err?.name === 'AbortError') res = { retry: 'timeout', out: fail(504, 'timeout') };
      else res = { retry: 'error', out: fail(502, 'failed', `（${String(err?.cause?.code ?? err?.code ?? err?.message ?? err).slice(0, 80)}）`) };
    } finally {
      if (keep) clearInterval(keep);
      if (target.worker === 'isolated') want(projectId, now() + limits.holdMs);
      current = null;
    }
    if (isFinal(e.state)) return; // 在途时被撤回、已经结了
    if (res.cancelled) { settle(e, 'cancelled', fail(499, 'cancelled')); return; }
    if (res.final) { settle(e, 'done', res.final); return; }
    e.attempts += 1;
    const outOfTime = e.deadline && now() >= e.deadline - 500;
    if (e.attempts > (e.retries ?? limits.retries) || outOfTime) { settle(e, 'failed', res.out); return; }
    stats.retried += 1;
    log('look.retry', { id: e.id.slice(0, 8), projectId, why: res.retry, attempts: e.attempts });
    requests.requeue(e);
  }

  /** 过一遍队列：结掉等到头的、没人问的；挑第一个此刻做得了的转出去 */
  function pump() {
    timer = null;
    requests.sweep();
    const at = now();
    for (const e of requests.queued()) {
      // 「登记了再来问」的：调用方很久没来问（它自己没了），撤掉，不占着队列
      if (e.persist && at - e.lastPollAt >= limits.orphanMs) { log('look.orphaned', { id: e.id.slice(0, 8), projectId: e.projectId }); settle(e, 'cancelled', fail(499, 'cancelled')); continue; }
      if (e.deadline ? at >= e.deadline : at - e.queuedAt >= limits.maxQueueMs) { settle(e, 'failed', waitedOut(e)); continue; }
      const r = routeOnce(e);
      if (r.fail) { settle(e, 'failed', r.fail); continue; }
      if (r.wait) { e.blockedReason = r.wait; continue; }
      if (current) { e.blockedReason = 'behind-another'; continue; }
      void attempt(e, r).catch((err) => {
        current = null;
        if (!isFinal(e.state)) settle(e, 'failed', fail(500, 'failed', `（${String(err?.message ?? err).slice(0, 80)}）`));
      }).finally(kick);
    }
    kick();
  }
  function kick() {
    if (timer || requests.queued().length === 0) return;
    timer = setTimeout(() => { try { pump(); } catch (err) { log('look.pump-error', { message: String(err?.message ?? err) }); timer = null; kick(); } }, limits.pollMs);
    timer.unref?.();
  }

  /** 把出了的结果交给调用方 */
  const deliver = (e) => { requests.delivered(e); return { status: e.result.status, body: e.result.body }; };

  /** 认身份 + 解析；不过回 `{ out }` */
  function admit(auth, bodyText) {
    requests.sweep();
    // 关着：与没有这条路一样答，不透露别的
    if (!enabled) { stats.refused += 1; return { out: { status: 404, body: { ok: false, look: 'off', error: LOOK_ERRORS.off } } }; }
    const who = verifyAuth(auth, bodyText);
    if (!who.ok) {
      stats.unauthorized += 1;
      log('look.unauthorized', { reason: who.reason });
      return { out: { status: 401, body: { ok: false, error: 'unauthorized' } } };
    }
    let msg = null;
    try { msg = JSON.parse(bodyText); } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { stats.refused += 1; return { out: { status: 400, body: { ok: false, error: 'bad-request' } } }; }
    return { who, msg };
  }

  return {
    enabled,
    limits,
    /**
     * `POST /look`：登记一个请求。带 `requestId` 的立刻回 202（之后来 `poll`）；不带的同步等到出结果或到时限。
     * @param {{ auth: unknown, bodyText: string }} input 请求头里的身份证明与原样的请求体
     * @returns {Promise<{ status: number, body: object }>}
     */
    async handle({ auth, bodyText }) {
      stats.requests += 1;
      const a = admit(auth, bodyText);
      if (a.out) return a.out;
      const { who, msg } = a;
      const route0 = typeof msg.path === 'string' && Object.hasOwn(LOOK_ROUTES, msg.path) ? LOOK_ROUTES[msg.path] : null;
      const queued = msg.requestId !== undefined;
      if (typeof msg.projectId !== 'string' || !PROJECT_ID_RE.test(msg.projectId) || !route0
        || !msg.body || typeof msg.body !== 'object' || Array.isArray(msg.body) || (route0.only && !route0.only(msg.body))
        || (queued && (typeof msg.requestId !== 'string' || !REQUEST_ID_RE.test(msg.requestId)))) {
        stats.refused += 1;
        return { status: 400, body: { ok: false, error: 'bad-request' } };
      }
      const cards = {};
      if (msg.cards && typeof msg.cards === 'object' && !Array.isArray(msg.cards)) {
        for (const [k, v] of Object.entries(msg.cards).slice(0, 512)) if (typeof k === 'string' && k.length <= 256) cards[k] = Number.isFinite(v) ? v : null;
      }
      const timeoutMs = Math.min(limits.maxTimeoutMs, Math.max(2000, Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : limits.timeoutMs));
      const added = requests.add({
        id: queued ? msg.requestId : `sync-${(syncSeq += 1).toString(36).padStart(4, '0')}-${randomBytes(9).toString('base64url')}`,
        owner: who.instanceId, projectId: msg.projectId, path: msg.path, tool: route0.tool, cards, body: msg.body,
        persist: queued, deadline: queued ? null : now() + timeoutMs,
        attemptMs: route0.attempt === 'caller' ? timeoutMs : null, retries: Number.isInteger(route0.retries) ? route0.retries : null,
      });
      if (added.conflict) { stats.refused += 1; return { status: 409, body: { ok: false, error: 'request-id-taken' } }; }
      // 登记的已经到了上限（防磁盘被占满的硬上限）：调用方过一会儿再登记；它不把这当成「没看成」
      if (added.full) { stats.refused += 1; log('look.refused', { projectId: msg.projectId, reason: 'queue-full' }); return fail(503, 'busy'); }
      const e = added.entry;
      requests.touch(e);
      if (added.created) log('look.queued', { id: e.id.slice(0, 8), projectId: e.projectId, tool: e.tool, mode: queued ? 'poll' : 'sync', position: requests.position(e), persisted: e.persisted });
      kick();
      if (queued) return isFinal(e.state) ? deliver(e) : pending202(requests, e);
      // 同步等：连接一直挂到出结果。到点由 pump 按时限结掉
      while (!isFinal(e.state)) await requests.wait(e, 1000);
      return deliver(e);
    },

    /**
     * `POST /look/poll { requestId, waitMs? }`：问一个登记过的请求。好了回最终那一份；没好最多挂 `waitMs` 再回 202。
     */
    async poll({ auth, bodyText }) {
      const a = admit(auth, bodyText);
      if (a.out) return a.out;
      const { who, msg } = a;
      if (typeof msg.requestId !== 'string' || !REQUEST_ID_RE.test(msg.requestId)) return { status: 400, body: { ok: false, error: 'bad-request' } };
      const e = requests.get(msg.requestId, who.instanceId);
      // 不认识（没登记过、结果过了保留期、落盘失败又赶上重启）：调用方照原样再登记一次
      if (!e) return { status: 404, body: { ok: false, error: 'unknown-request' } };
      requests.touch(e);
      kick();
      const waitMs = Math.min(limits.maxPollMs, Math.max(0, Number.isFinite(msg.waitMs) ? msg.waitMs : 0));
      const until = now() + waitMs;
      while (!isFinal(e.state) && now() < until) { await requests.wait(e, Math.min(until - now(), 5000)); requests.touch(e); }
      return isFinal(e.state) ? deliver(e) : pending202(requests, e);
    },

    /** `POST /look/cancel { requestId }`：撤回。排着的直接撤；在做的那一个掐掉 */
    async cancel({ auth, bodyText }) {
      const a = admit(auth, bodyText);
      if (a.out) return a.out;
      const { who, msg } = a;
      if (typeof msg.requestId !== 'string' || !REQUEST_ID_RE.test(msg.requestId)) return { status: 400, body: { ok: false, error: 'bad-request' } };
      const e = requests.get(msg.requestId, who.instanceId);
      if (!e) return { status: 404, body: { ok: false, error: 'unknown-request' } };
      if (!isFinal(e.state)) {
        log('look.cancelled', { id: e.id.slice(0, 8), projectId: e.projectId, was: e.state });
        const mine = e.state === 'running' && current?.id === e.id ? current : null;
        settle(e, 'cancelled', fail(499, 'cancelled'));
        mine?.abort.abort();
      }
      return { status: 200, body: { ok: true, requestId: e.id, state: e.state } };
    },

    /** 管理进程起来、把盘上的队列接回来之后调一次：让调度转起来 */
    resume() { kick(); },
    /** 停表（管理进程退出时；排着的留在盘上，下次起来接着做） */
    close() { if (timer) clearTimeout(timer); timer = null; },
    /** 在途的那个请求正在哪个工作进程上出图（管理进程据此让出一个并发名额）；没有回 null */
    busyOn: () => current?.worker ?? null,
    /** 在途的那个请求是哪个项目的；没有回 null */
    busyProject: () => current?.projectId ?? null,
    /** 排着的请求里有没有该由常驻工作进程出的（管理进程据此先替它留出一个并发名额：看画面优先于预渲染任务） */
    reserveOn: () => (requests.queued().some((e) => e.needIso === false) ? 'resident' : null),
    /** 这个项目有没有排着或在做的请求 */
    wanted: (projectId) => current?.projectId === projectId || requests.queued().some((e) => e.projectId === projectId),
    status: () => {
      const q = requests.stats();
      return {
        enabled, inFlight: current ? { projectId: current.projectId, worker: current.worker, ms: now() - current.since } : null,
        waiting: q.queued, queue: q, ...stats, byWorker: { ...stats.byWorker },
      };
    },
  };
}
