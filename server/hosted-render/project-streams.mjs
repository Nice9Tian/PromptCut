/**
 * 托管方渲染服务的工作进程一侧：这个项目此刻产不产轨道流（任务书 `docs/plan/render-refactor-task.md`「甲三」，
 * 契约 `docs/plan/hosted-render-contract.md` 第 3.1 节）。
 *
 * 产不产由每个项目自己的「生成轨道流」定（项目记录 `hosted.render.streams`，缺省关，创建者能改）。管理进程从目录条目读它，
 * 放进代理口 `GET /projects` 的每一项里（`broker.mjs` 的 `selectProjects`：`streams` = 渲染节点开着并且这一项开着）；
 * 工作进程里没有目录、没有私钥，向代理口问。这里是问的那一头：
 *
 *   allowed(projectId)   同步：按手里的清单答（认领闸每一拍对每个候选的流任务都会问）。手里的清单问到之后过了 `refreshAfterMs`（300 ms）
 *                        就顺手在后台再问一次；过了 `maxAgeMs`（1.2 s）还没更新的**不作数**。
 *                        **从没问到过、清单过期了、清单里没有这个项目、这一项不是 true，一律答 false**：不知道就不认领（晚一拍，不会错认领）
 *   fresh(projectId)     异步：先问到新的再答（切分清单计划时用，那里本来就是异步的）。问不到、手里的又过期了：答 false
 *   status()             诊断：最近一次问到的时刻、项目数、最近一次的错误
 *
 * 不开计时器：没人问就不请求。认领闸每一拍（500 ms）问一次时，每一拍答的是上一拍问到的清单。代理口在本机回环上，一次请求是毫秒级的。
 * 关掉「生成轨道流」到工作进程不再认领新的流任务：目录当场推给管理进程；工作进程手里的清单最多是上一拍的，所以最迟一拍（约 0.5 s）之后生效。
 * 节点手里占满、一阵子没问过时清单已经过期，腾出手来的第一拍一律不认领流任务，先问到新的。
 * 手里已经认领的流任务不受影响（关这一项不放回认领，见契约第 3.1 节）。
 *
 * `workerProjectStreams(env)`：这个进程是托管方渲染服务的工作进程（环境里有 `PROMPTCUT_RENDER_BROKER`）时回一个进程内共用的实例，
 * 否则回 null（桌面应用、普通的独立渲染主机：这一项不管它们，照自己能不能产流来）。
 * 只引 Node 内置的 `fetch`（可注入）。口令不进日志、不进诊断。
 */

/** 代理模式的两个环境变量（与 `render-node/host.mjs` 的 `BROKER_URL_ENV` / `BROKER_KEY_ENV` 同名；那边引了别的模块，这里不引它） */
export const BROKER_URL_ENV = 'PROMPTCUT_RENDER_BROKER';
export const BROKER_KEY_ENV = 'PROMPTCUT_RENDER_BROKER_KEY';

export const PROJECT_STREAMS_DEFAULTS = Object.freeze({ REFRESH_AFTER_MS: 300, MAX_AGE_MS: 1200, TIMEOUT_MS: 4000 });

/**
 * @param {object} o
 * @param {string} o.url 管理进程的本机代理口（`http://127.0.0.1:<端口>`）
 * @param {string} o.key 这个工作进程的口令
 * @param {typeof globalThis.fetch} [o.fetch]
 * @param {() => number} [o.now]
 * @param {number} [o.refreshAfterMs] 清单问到之后过多久、再被问到时顺手更新
 * @param {number} [o.maxAgeMs] 清单多久算过期（过期的不作数）
 * @param {number} [o.timeoutMs]
 */
export function createProjectStreams({
  url, key, fetch: fetchImpl = globalThis.fetch, now = Date.now,
  refreshAfterMs = PROJECT_STREAMS_DEFAULTS.REFRESH_AFTER_MS, maxAgeMs = PROJECT_STREAMS_DEFAULTS.MAX_AGE_MS, timeoutMs = PROJECT_STREAMS_DEFAULTS.TIMEOUT_MS,
} = {}) {
  const base = String(url ?? '').replace(/\/+$/, '');
  /** projectId → 这个项目产不产流（清单里的每一项都记，不产的记 false） */
  let table = new Map();
  let at = -Infinity;
  let asked = 0;
  let failed = 0;
  let lastError = null;
  let inflight = null;

  async function load() {
    asked += 1;
    try {
      const res = await fetchImpl(`${base}/projects`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.json().catch(() => null);
      if (res.status !== 200 || !body || body.ok !== true || !Array.isArray(body.projects)) {
        throw Object.assign(new Error(`渲染代理口 /projects：${res.status}`), { code: body?.error ?? `http-${res.status}` });
      }
      const next = new Map();
      for (const p of body.projects) if (typeof p?.projectId === 'string') next.set(p.projectId, p.streams === true);
      table = next;
      at = now();
      lastError = null;
    } catch (err) {
      failed += 1;
      lastError = String(err?.code ?? err?.name ?? 'error');
      throw err;
    }
  }
  /** 同一时刻只问一次 */
  const refresh = () => (inflight ??= load().finally(() => { inflight = null; }));
  const age = () => now() - at;
  const answer = (projectId) => age() < maxAgeMs && table.get(projectId) === true;

  return {
    allowed(projectId) {
      if (age() >= refreshAfterMs) void refresh().catch(() => {});
      return answer(projectId);
    },
    async fresh(projectId) {
      if (age() >= refreshAfterMs) { try { await refresh(); } catch { /* 问不到：手里的没过期就按它，过期了答 false */ } }
      return answer(projectId);
    },
    refresh,
    status: () => ({ at: Number.isFinite(at) ? at : null, projects: table.size, on: [...table.values()].filter(Boolean).length, asked, failed, lastError }),
  };
}

let shared = null;
let sharedFor = '';

/**
 * 这个进程的那一个实例；不是托管方渲染服务的工作进程回 null。
 * @param {Record<string, string | undefined>} [env]
 * @returns {ReturnType<typeof createProjectStreams> | null}
 */
export function workerProjectStreams(env = process.env) {
  const url = String(env?.[BROKER_URL_ENV] ?? '').trim();
  if (!url) return null;
  const key = String(env?.[BROKER_KEY_ENV] ?? '');
  const id = `${url}\n${key}`;
  if (!shared || sharedFor !== id) { shared = createProjectStreams({ url, key }); sharedFor = id; }
  return shared;
}
