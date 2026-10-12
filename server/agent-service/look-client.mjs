/**
 * 云端 Agent 服务向同机的渲染服务要一帧画面(契约 `docs/plan/cloud-agent-contract.md` 第 9.8 节;
 * `docs/plan/hosted-render-contract.md` 第 8a 节;对端是 `server/hosted-render/look.mjs`)。
 *
 * 形状与桌面版的 `prerenderPost(path, body, opts)`(`server/prerender-client.mjs`)相同,所以 `agent-exec.mjs` 里看画面的那几个
 * 读工具(`see_frames`、`get_gif`、`bake_card`、`inspect_card_dom`、`get_layout` 的实体框)不用改:桌面版问本机的预渲染进程,
 * 云端问渲染服务的管理进程,由它转给合适的工作进程(带用户卡的项目只由隔离工作进程出图)。
 *
 *   const look = createLookClient({ url: 'http://127.0.0.1:5399', key: readServiceKeyFile(dir) });
 *   const post = look.forProject(projectId, { cards: () => ({ 'src/cards/user/x.tsx': 3 }) });
 *   const data = await post('/api/vision/snapshot', { project, t: 1 }, { signal });
 *
 * - **项目由宿主定**:`forProject` 的 `projectId` 来自鉴权(委托里的项目),工具参数改不了它。一个对话要不到别的项目的画面;
 * - 每个请求用**服务私钥**签名(时刻、一次性随机数、请求体摘要),渲染服务按登记表核对;私钥、签名不进日志;
 * - 地址只许回环(渲染服务的这个口子只绑回环;这里再核一遍,配错了不至于把项目内容发到别处);
 * - **排队**(0.7.18 第 3 项;`server/hosted-render/render-requests.mjs`):渲染服务忙(别的项目占着隔离工作进程、内存吃紧、
 *   排在别的请求后面)时不回「忙」,请求登记在它的队列里。这里先登记(带一个现生成的 `requestId`,回 202),再一趟一趟去问
 *   (`/look/poll`,每趟最多挂 20 秒)直到出结果。等的这段时间工具调用一直没返回——模型不会在画面出来之前说「看过了」;
 * - 渲染服务重启、一时连不上:**不算没看成**。按退避接着问(队列落了盘,它起来后请求还在);它说不认识这个 `requestId`
 *   (落盘失败又赶上重启)就照原样再登记一次。连着 `reconnectMs` 都连不上才放弃;
 * - 渲染服务说登记的请求到了上限(503 `busy`):过一会儿再登记,不交给模型;
 * - 渲染这一段每次最多一分钟、没成自动重试三次,是渲染服务那一侧做的(`look.mjs`)。调用方给的 `timeoutMs` 在排队的调用法里
 *   不再当整条请求的时限用(排队的时间不由它管),只保留 `signal`:这一轮被停掉时把排着的请求撤回;
 * - 渲染服务说「这次没看成」(`{ ok: false, look, error }`)时抛带原话的错,工具把它原样交给模型:这里不再重试、不挂着;
 * - 聊天栏的可视化记录(`/api/ai/visual` 的看画面记录、改片段的前后对比)存在工作进程里,在线页面取不到:这里直接回「没有」,不发请求。
 */
import { randomBytes } from 'node:crypto';
import { signLookRequest, LOOK_AUTH_HEADER, LOOK_ROUTES } from '../hosted-render/look.mjs';

export const LOOK_CLIENT_DEFAULTS = Object.freeze({
  /** 一趟 `/look/poll` 让渲染服务最多挂多久 */
  pollWaitMs: 20_000,
  /** 一趟请求(登记、问、撤回)自己的网络时限:挂的时间之外再留的余量 */
  requestSlackMs: 10_000,
  /** 登记那一趟(带着整个项目内容)的网络时限 */
  submitTimeoutMs: 60_000,
  /** 连不上、或渲染服务说登记的到了上限时,隔多久再试(逐次往后取,到最后一个为止) */
  backoffMs: [500, 1000, 2000, 5000, 10_000],
  /** 连着这么久都连不上渲染服务才放弃(它重启一次连同自检、起工作进程,一般一两分钟) */
  reconnectMs: 5 * 60_000,
  /** 渲染服务说不认识这个请求时,照原样再登记最多几次 */
  maxResubmits: 3,
});

const UNREACHABLE = '这次没看成：连不上这台云节点的渲染服务。先按项目内容继续，并在汇报里说明没有看过画面。';
const NOT_ACCEPTED = '这次没看成：这台云节点的渲染服务没有接受看画面的请求。先按项目内容继续，并在汇报里说明没有看过画面。';

/** 只许回环上的 http 地址,不带路径;不合格回 null */
export function parseLookUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(host)) return null;
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
  return `http://${u.host}`;
}

/**
 * @param {object} o
 * @param {string} o.url 渲染服务管理进程的诊断与代理口(`http://127.0.0.1:<端口>`)
 * @param {{ service, kid, priv, instanceId }} o.key 服务私钥(`readServiceKeyFile` 的结果,服务名 `agent`)
 * @param {typeof globalThis.fetch} [o.fetch]
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [o.sleep] 测试用
 */
export function createLookClient({ url, key, fetch: fetchImpl = globalThis.fetch, log = () => {}, limits: limitsIn = {}, now = () => Date.now(), sleep: sleepIn = null } = {}) {
  const base = parseLookUrl(url);
  if (!base) throw new TypeError('createLookClient: url 要是回环上的 http 地址(如 http://127.0.0.1:5399)');
  if (!key || typeof key.priv !== 'string') throw new TypeError('createLookClient: 要服务私钥');
  const limits = { ...LOOK_CLIENT_DEFAULTS, ...limitsIn };
  const stats = { requests: 0, ok: 0, refused: 0, failed: 0, queued: 0, reconnects: 0, resubmits: 0, cancelled: 0 };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  const sleep = sleepIn ?? ((ms, signal) => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  }));

  /** 发一趟签了名的请求。回 `{ res, data }`;网络层的错原样抛 */
  async function send(pathname, text, timeoutMs, signal) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const res = await fetchImpl(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [LOOK_AUTH_HEADER]: signLookRequest(key, text, { now: now() }) },
      body: text,
      signal: AbortSignal.any(signals),
    });
    return { res, data: await res.json().catch(() => null) };
  }

  /** 这一轮被停掉了:把排着的请求撤回(尽力而为,不等结果) */
  function cancel(requestId) {
    stats.cancelled += 1;
    void send('/look/cancel', JSON.stringify({ requestId }), 5000).catch(() => {});
  }

  async function post(projectId, cards, pathname, body, { signal } = {}) {
    // 可视化记录:云端不存(在线页面取不到工作进程里的文件)。`get_gif` 写规格的那一次除外
    if (pathname === '/api/ai/visual' && body?.tool !== 'get_gif') return { ok: false, error: '云端不存可视化记录' };
    if (!Object.hasOwn(LOOK_ROUTES, pathname)) throw new Error(`云端的渲染服务不提供 ${pathname}`);
    let cardRevs = {};
    try { cardRevs = (typeof cards === 'function' ? cards() : cards) ?? {}; } catch { cardRevs = {}; }
    // 同一个 id 重发不会登记两次:没收到回执、渲染服务重启后不认识,都拿它再登记
    const requestId = randomBytes(18).toString('base64url');
    const submitText = JSON.stringify({ projectId, path: pathname, body, cards: cardRevs, requestId });
    stats.requests += 1;
    const started = now();
    let submitted = false; // 渲染服务认下这个请求了没有
    let resubmits = 0;
    let downSince = null; // 从什么时候起连不上
    let tries = 0;
    let waited = false;
    const backoff = () => limits.backoffMs[Math.min(tries++, limits.backoffMs.length - 1)];

    for (;;) {
      if (signal?.aborted) { if (submitted) cancel(requestId); throw signal.reason ?? new Error('aborted'); }
      let out;
      try {
        out = submitted
          ? await send('/look/poll', JSON.stringify({ requestId, waitMs: limits.pollWaitMs }), limits.pollWaitMs + limits.requestSlackMs, signal)
          : await send('/look', submitText, limits.submitTimeoutMs, signal);
      } catch (err) {
        if (signal?.aborted) { if (submitted) cancel(requestId); throw err; }
        // 连不上、这一趟超时:渲染服务可能正在重启。不算没看成,按退避接着来;连着太久都不通才放弃
        downSince ??= now();
        stats.reconnects += 1;
        if (now() - downSince >= limits.reconnectMs) {
          stats.failed += 1;
          say('agent.look.failed', { projectId, reason: String(err?.cause?.code ?? err?.code ?? err?.name ?? 'fetch'), downMs: now() - downSince });
          throw new Error(UNREACHABLE);
        }
        await sleep(backoff(), signal);
        continue;
      }
      if (downSince !== null) say('agent.look.reconnected', { projectId, downMs: now() - downSince });
      downSince = null;
      const { res, data } = out;

      // 还排着、或正在渲:接着问
      if (res.status === 202 && data?.ok === true) {
        if (!submitted || !waited) { stats.queued += 1; waited = true; say('agent.look.queued', { projectId, path: pathname, position: data.queuePosition ?? null, blockedReason: data.blockedReason ?? null }); }
        submitted = true;
        tries = 0;
        continue;
      }
      // 渲染服务不认识这个请求(落盘失败又赶上它重启,或结果过了保留期):照原样再登记
      if (submitted && res.status === 404 && data?.error === 'unknown-request') {
        resubmits += 1;
        stats.resubmits += 1;
        if (resubmits > limits.maxResubmits) { stats.failed += 1; throw new Error(NOT_ACCEPTED); }
        submitted = false;
        continue;
      }
      // 登记的到了上限:过一会儿再登记。这不是「没看成」,不交给模型
      if (!submitted && res.status === 503 && data?.look === 'busy') {
        if (!waited) { stats.queued += 1; waited = true; say('agent.look.queued', { projectId, path: pathname, position: null, blockedReason: 'queue-full' }); }
        await sleep(backoff(), signal);
        continue;
      }

      const ms = now() - started;
      if (res.status === 401 || res.status === 404 || res.status === 409 || !data || typeof data !== 'object') {
        stats.refused += 1;
        say('agent.look.refused', { projectId, status: res.status, look: data?.look ?? null, ms });
        throw new Error(typeof data?.look === 'string' && typeof data.error === 'string' ? data.error : NOT_ACCEPTED);
      }
      if (typeof data.look === 'string' && data.ok === false) {
        stats.refused += 1;
        say('agent.look.refused', { projectId, status: res.status, look: data.look, ms });
        throw new Error(typeof data.error === 'string' && data.error ? data.error : '这次没看成。');
      }
      stats.ok += 1;
      say('agent.look', { projectId, path: pathname, ok: data.ok !== false, ms, queued: waited });
      // 工作进程自己的回答(含它的 `{ ok: false, error }`,例如片段不存在)原样交回,由工具照桌面版的办法处理
      return data;
    }
  }

  return {
    url: base,
    /**
     * 这个项目的 `prerenderPost`。`cards()` 回这个项目内容库里卡片源码的「键 → 版本」(没有卡就是空的):渲染服务据此决定
     * 走不走隔离工作进程,并等它把这几份装到至少这个版本。
     * @param {string} projectId 来自鉴权,不来自工具参数
     * @param {{ cards?: () => Record<string, number | null> }} [o]
     */
    forProject(projectId, { cards = null } = {}) {
      if (typeof projectId !== 'string' || !projectId) throw new TypeError('forProject: 要 projectId');
      return (pathname, body, opts) => post(projectId, cards, pathname, body, opts);
    },
    describe: () => ({ url: base, ...stats }),
  };
}
