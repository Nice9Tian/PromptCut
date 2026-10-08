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
 *   const data = await post('/api/vision/snapshot', { project, t: 1 }, { timeoutMs: 120000 });
 *
 * - **项目由宿主定**:`forProject` 的 `projectId` 来自鉴权(委托里的项目),工具参数改不了它。一个对话要不到别的项目的画面;
 * - 每个请求用**服务私钥**签名(时刻、一次性随机数、请求体摘要),渲染服务按登记表核对;私钥、签名不进日志;
 * - 地址只许回环(渲染服务的这个口子只绑回环;这里再核一遍,配错了不至于把项目内容发到别处);
 * - 渲染服务说「这次没看成」(`{ ok: false, look, error }`)时抛带原话的错,工具把它原样交给模型:不重试、不挂着;
 * - 聊天栏的可视化记录(`/api/ai/visual` 的看画面记录、改片段的前后对比)存在工作进程里,在线页面取不到:这里直接回「没有」,不发请求。
 */
import { signLookRequest, LOOK_AUTH_HEADER, LOOK_ROUTES } from '../hosted-render/look.mjs';

export const LOOK_CLIENT_DEFAULTS = Object.freeze({ timeoutMs: 120_000, maxTimeoutMs: 170_000 });

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
 */
export function createLookClient({ url, key, fetch: fetchImpl = globalThis.fetch, log = () => {}, limits: limitsIn = {}, now = () => Date.now() } = {}) {
  const base = parseLookUrl(url);
  if (!base) throw new TypeError('createLookClient: url 要是回环上的 http 地址(如 http://127.0.0.1:5399)');
  if (!key || typeof key.priv !== 'string') throw new TypeError('createLookClient: 要服务私钥');
  const limits = { ...LOOK_CLIENT_DEFAULTS, ...limitsIn };
  const stats = { requests: 0, ok: 0, refused: 0, failed: 0 };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };

  async function post(projectId, cards, pathname, body, { timeoutMs, signal } = {}) {
    // 可视化记录:云端不存(在线页面取不到工作进程里的文件)。`get_gif` 写规格的那一次除外
    if (pathname === '/api/ai/visual' && body?.tool !== 'get_gif') return { ok: false, error: '云端不存可视化记录' };
    if (!Object.hasOwn(LOOK_ROUTES, pathname)) throw new Error(`云端的渲染服务不提供 ${pathname}`);
    const limit = Math.min(limits.maxTimeoutMs, Math.max(5000, Number(timeoutMs) > 0 ? Number(timeoutMs) : limits.timeoutMs));
    let cardRevs = {};
    try { cardRevs = (typeof cards === 'function' ? cards() : cards) ?? {}; } catch { cardRevs = {}; }
    const text = JSON.stringify({ projectId, path: pathname, body, cards: cardRevs, timeoutMs: limit });
    stats.requests += 1;
    const started = now();
    const signals = [AbortSignal.timeout(limit + 5000)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetchImpl(`${base}/look`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [LOOK_AUTH_HEADER]: signLookRequest(key, text, { now: now() }) },
        body: text,
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      stats.failed += 1;
      if (signal?.aborted) throw err;
      const timedOut = err?.name === 'TimeoutError';
      say('agent.look.failed', { projectId, reason: timedOut ? 'timeout' : String(err?.cause?.code ?? err?.code ?? 'fetch') });
      throw new Error(timedOut
        ? '这次没看成：渲染服务在时限内没有出图。先按项目内容继续，稍后可以再看一次。'
        : '这次没看成：连不上这台云节点的渲染服务。先按项目内容继续，并在汇报里说明没有看过画面。');
    }
    const data = await res.json().catch(() => null);
    const ms = now() - started;
    if (res.status === 401 || res.status === 404 || !data || typeof data !== 'object') {
      stats.refused += 1;
      say('agent.look.refused', { projectId, status: res.status, look: data?.look ?? null, ms });
      throw new Error(typeof data?.look === 'string' && typeof data.error === 'string' ? data.error : '这次没看成：这台云节点的渲染服务没有接受看画面的请求。先按项目内容继续，并在汇报里说明没有看过画面。');
    }
    if (typeof data.look === 'string' && data.ok === false) {
      stats.refused += 1;
      say('agent.look.refused', { projectId, status: res.status, look: data.look, ms });
      throw new Error(typeof data.error === 'string' && data.error ? data.error : '这次没看成。');
    }
    stats.ok += 1;
    say('agent.look', { projectId, path: pathname, ok: data.ok !== false, ms });
    // 工作进程自己的回答(含它的 `{ ok: false, error }`,例如片段不存在)原样交回,由工具照桌面版的办法处理
    return data;
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
