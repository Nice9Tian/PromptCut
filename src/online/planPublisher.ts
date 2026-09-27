/**
 * 在线页面自己发布 `plan` 任务(C10 契约第 7 节、第 18 节第 9 条〔裁〕)。
 *
 * 在线页面没有编辑器进程。页面经文档服务连接发布一个「清单计划」—— 带片段清单的 `plan`,清单是页面自己判重的片段,normal 档:
 *
 *   `plan:<projectId>@<projectRev>#clips:<sig>`   `input.clips` = 清单(升序去重)   `priority: 'normal'`
 *
 * - `requires` 里**不写** `envFingerprint`、**不写** `preferNode`:在线页面没有预渲染进程、也没有自己的环境,它发的 plan 要让任何能切分的
 *   节点(桌面版、独立渲染主机)都认领得了,由认领的节点用自己的指纹切分(主会话 2026-09-28 的补充约束;队列侧见 M6c X4 的修改)。
 * - `requires.codeVersion`:在线构建在构建时用渲染节点同一套算法(`server/frame-code.mjs` 的 `frameCode`,换行统一成 LF)算出代码版本、
 *   嵌进页面(`vite.config.ts` 的在线构建),给了就写,版本不同的节点不认领;算不出(开发构建)就不写,靠第 5 节「层表对不上当没有」兜底。
 * - 时机(沿用 C6.6 的时机修复):测量落定之后才发;项目每次改动(文档服务确认的版本变了)防抖后重发;清单变了也重发。
 *   同一个结果键队列不另起任务,重复发只合并。
 * - `source.userId` 由文档服务按页面连接的凭证填,发布方自报的不作数(现状)。
 * - 没有节点认领时 plan 等着,页面不报错(重层播放占位、暂停活渲)。
 * - 页面订阅 `task.done`(发布方自动订阅自己发布的 plan 与它切出的细任务),并入层表与就绪:宿主收到就让在线来源立刻重取层表。
 *
 * 任务形状与队列侧 `server/render-queue/messages.mjs` 的 `clipsPlanTaskOf` 逐字段相同(单测对拍);这里照抄,页面构建不带服务端模块。
 * 本模块属于 render 这一层(`src/online/`):不引 editor。
 */

/** 清单计划结果键的标记(同 `messages.mjs` 的 `CLIPS_KEY_MARK`) */
export const CLIPS_KEY_MARK = "#clips:";
/** 防抖:连着改项目时只发最后一版 */
export const PLAN_DEBOUNCE_MS = 800;

/** 片段清单的签名:与 `server/render-queue/messages.mjs` 的 `backfillSig` 同一个算法(FNV-1a 两轮,base36) */
export function clipsSig(clips: readonly string[]): string {
  const text = [...new Set(clips)].map(String).sort().join("\n");
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  return fnv(0x811c9dc5).toString(36) + fnv(0x2f4a7c15).toString(36);
}

export interface ClipsPlanTask {
  id: string;
  kind: "plan";
  resultKey: string;
  range: null;
  source: { projectId: string; projectRev: number };
  input: { clips: string[] };
  weight: { class: "medium"; estMs: null; frames: null };
  requires: { codeVersion?: string };
  priority: "normal";
}

export function clipsPlanTask({ projectId, projectRev, clips, codeVersion }: { projectId: string; projectRev: number; clips: readonly string[]; codeVersion?: string | null }): ClipsPlanTask {
  const list = [...new Set(clips)].map(String).filter(Boolean).sort();
  const resultKey = `${projectId}@${projectRev}${CLIPS_KEY_MARK}${clipsSig(list)}`;
  return {
    id: `plan:${resultKey}`, kind: "plan", resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list }, weight: { class: "medium", estMs: null, frames: null },
    requires: typeof codeVersion === "string" && codeVersion ? { codeVersion } : {}, priority: "normal",
  };
}

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
/** `createWsEndpoint` 的形状(只用这两样) */
export interface EndpointLike {
  send(msg: Record<string, unknown>): boolean;
  onMessage(handler: (msg: Record<string, unknown>) => void): void | (() => void);
}

export interface PlanPublisherDeps {
  /** 文档服务上的一次请求(回同一 reqId 的回包);与 `endpoint` 二选一 */
  request?: Request;
  endpoint?: EndpointLike;
  publisherId?: string;
  /** 此刻页面自己判重的片段(清单);空就不发 */
  clips?: () => readonly string[];
  codeVersion?: string | null;
  debounceMs?: number;
  /** 收到队列推来的 `task.done` / `task.failed`(只在 `endpoint` 模式里由这里转;`request` 模式由宿主自己接) */
  onTaskEvent?: (msg: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

export interface Version { projectId: string | null; projectRev: number | null }

export interface PlanPublisher {
  /** 测量落定(打开项目那一轮测完、或之后补测完):此后才发 */
  measured(v: Version): void;
  /** 项目改了(文档服务确认的版本变了)、或清单变了:防抖后重发 */
  changed(v: Version): void;
  /** 连接换了(重连、换项目):重新报到,下一次照常发(队列只在内存里,重启后要重新发布) */
  reset(): void;
  dispose(): void;
  debug(): { measured: boolean; want: Version | null; last: string | null; helloOk: boolean; log: { at: number; id: string; clips: number; ok: boolean; error?: string; state?: string }[] };
}

/** endpoint → request:按 reqId 等回包 */
function requestOver(endpoint: EndpointLike, prefix: string, onOther?: (m: Record<string, unknown>) => void): { request: Request; stop: () => void } {
  const waiting = new Map<string, (m: Record<string, unknown>) => void>();
  let seq = 0;
  const off = endpoint.onMessage((m) => {
    const id = m?.reqId !== undefined ? String(m.reqId) : "";
    const w = id ? waiting.get(id) : undefined;
    if (w) { waiting.delete(id); w(m); return; }
    if (m?.type === "task.done" || m?.type === "task.failed") onOther?.(m);
  });
  return {
    request: (msg, timeoutMs = 15_000) => new Promise((resolve, reject) => {
      const reqId = `${prefix}-${++seq}`;
      const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`${String(msg.type)} 没有回应`)); }, timeoutMs);
      waiting.set(reqId, (m) => { clearTimeout(timer); resolve(m); });
      if (!endpoint.send({ ...msg, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error("连接断了")); }
    }),
    stop: () => { if (typeof off === "function") off(); waiting.clear(); },
  };
}

export function createPlanPublisher(deps: PlanPublisherDeps): PlanPublisher {
  const publisherId = deps.publisherId ?? `page-${Math.random().toString(36).slice(2, 10)}`;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? PLAN_DEBOUNCE_MS;
  const over = !deps.request && deps.endpoint ? requestOver(deps.endpoint, publisherId, deps.onTaskEvent) : null;
  const request: Request | null = deps.request ?? over?.request ?? null;
  let measuredOk = false;
  let want: Version | null = null;
  let last: string | null = null;
  let helloOk = false;
  let timer: unknown = null;
  let busy = false;
  let again = false;
  let disposed = false;
  const log: ReturnType<PlanPublisher["debug"]>["log"] = [];
  const note = (e: (typeof log)[number]) => { log.push(e); if (log.length > 20) log.splice(0, log.length - 20); };

  const publish = async () => {
    timer = null;
    if (disposed || !measuredOk || !want || !request) return;
    if (busy) { again = true; return; }
    const { projectId, projectRev } = want;
    if (!projectId || !Number.isSafeInteger(projectRev)) return;
    const clips = [...(deps.clips?.() ?? [])];
    if (!clips.length) return;
    const task = clipsPlanTask({ projectId, projectRev: projectRev as number, clips, codeVersion: deps.codeVersion ?? null });
    if (task.id === last) return;
    busy = true;
    try {
      if (!helloOk) {
        const hello = await request({ type: "publisher.hello", publisherId });
        if (hello?.type !== "publisher.welcome") throw new Error(`publisher.hello:${String(hello?.reason ?? hello?.type ?? "no-reply")}`);
        helloOk = true;
      }
      const reply = await request({ type: "task.publish", tasks: [task] });
      if (reply?.type !== "task.published") {
        helloOk = false;
        throw new Error(`task.publish:${String(reply?.reason ?? reply?.type ?? "no-reply")}`);
      }
      const results = Array.isArray(reply.results) ? (reply.results as { id?: string; error?: string; state?: string }[]) : [];
      const r = results.find((x) => x?.id === task.id);
      if (!r || r.error) throw new Error(`task.publish:${r?.error ?? "no-result"}`);
      last = task.id;
      note({ at: now(), id: task.id, clips: clips.length, ok: true, state: r.state });
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      if (/连接断了|没连上|没有回应/.test(error)) helloOk = false;
      // 没人认领、发不出去都不报错(C10 契约第 7 节):记下来,下一次改动或下一轮再发
      note({ at: now(), id: task.id, clips: clips.length, ok: false, error });
    } finally {
      busy = false;
      // 等回包期间防抖已到期的那一版(again):防抖已经等过了,马上发,不再多等一轮防抖
      if (again && !disposed) { again = false; void publish(); }
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { void publish(); }, debounceMs);
  };

  return {
    measured(v) { measuredOk = true; want = { ...v }; schedule(); },
    changed(v) { want = { ...v }; if (measuredOk) schedule(); },
    reset() { helloOk = false; last = null; if (measuredOk && want) schedule(); },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      over?.stop();
    },
    debug: () => ({ measured: measuredOk, want, last, helloOk, log: log.slice() }),
  };
}
