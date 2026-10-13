/**
 * 导出开始时请渲染节点把本页不执行的卡按原尺寸逐帧渲好(语义 `docs/semantics/product/platforms.md`「在线浏览器」的「导出」:
 * 「本页不执行的同步用户卡、素材效果卡,导出开始时请渲染节点按原尺寸逐帧渲好再用,没到齐时提示等待」)—— 页面这一侧。
 * 节点那一侧见 `server/export-frames.mjs`。
 *
 * # 怎么请
 *
 * 页面在自己的文档服务连接上发布一个**只为导出**的清单计划(任务形状同 `online/planPublisher.ts` 的清单计划,另带 `input.exportOnly: true`,
 * 签名里多一段,所以它和平时那份清单计划不是一个任务):
 *
 *   `plan:<projectId>@<projectRev>#clips:<sig>`   `input.clips` = 要渲染节点出的片段   `input.exportOnly: true`
 *
 * 认领它的节点不切快照、不切轨道流,只给这些片段切**导出位图任务**;计划完成时的回包带一份索引(每个片段的结果键、矩形、帧范围,
 * 出不了的片段和原因)。页面是这个计划的发布方,自动收到它的 `task.done`;同一个任务再发布一次,队列会把已完成任务的 `task.done`
 * 再发一遍,所以隔一会儿重发一次既是问状态(回包里的 `state`:`open` = 还没有节点认领),也是把漏掉的完成通知要回来。
 *
 * # 怎么等
 *
 * 索引到了之后,逐条取每一段的清单(内容库 `render-manifest`,键 `<结果键>:<起>-<止>`),每一帧都列了才算这一段到齐;全部到齐才开始导,
 * 不出半截的成片。等的时候把「在等什么」报给调用方(`onStatus`):还没有节点接、节点正在渲(已到几帧)。不设超时,用户可以取消。
 * 节点说某个片段出不了(手里没有这张卡的代码等)、某一段任务失败了、或节点渲的那一版和本页手里这一版对不上(导出期间项目被改了),
 * 抛带说明的错误,导出停下。
 *
 * # 怎么取
 *
 * 一帧一张 PNG(`px/<哈希>`,只读票据),取回来直接当 `data:` 地址用(无损,不解码)。只留当前这一帧,用完不留。
 */
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { STREAM_SEGMENT_FRAMES } from "../render/streamSegments.mjs";
import { CLIPS_KEY_MARK, clipsSig } from "../online/planPublisher";
import type { FrameCoverage, LayerRect } from "./cardLayers";
import { ONLINE_EXPORT_TEXT } from "./text";

/** 只为导出的清单计划在签名里多的那一段 */
export const EXPORT_ONLY_SIG = "export=1";
/** 多久把计划再发布一次(问状态、要回完成通知) */
export const EXPORT_PLAN_POLL_MS = 3000;
/** 多久再取一次没到齐的清单 */
export const EXPORT_MANIFEST_POLL_MS = 2000;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface ExportFrameDeps {
  /** 文档服务上的一次请求(回同一 reqId 的回包) */
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** 队列推来的 `task.done` / `task.failed`(页面是发布方,自动订阅);回退订 */
  subscribeQueue(cb: (msg: Record<string, unknown>) => void): () => void;
  assetBase(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  publisherId: string;
  codeVersion?: string | null;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ExportPlanTask {
  id: string;
  kind: "plan";
  resultKey: string;
  range: null;
  source: { projectId: string; projectRev: number };
  input: { clips: string[]; exportOnly: true };
  weight: { class: "medium"; estMs: null; frames: null };
  requires: { codeVersion?: string };
  priority: number;
}

/**
 * 只为导出的计划在队列里的名次:排在所有细任务前面(锚帧 50、导出位图任务 60)。用户正等着导出;名次低的话,节点手里别的快照、
 * 轨道流任务没做完就轮不到它(实测同一个项目里等了五分钟)。整数名次仍属 normal 档(`server/render-queue/messages.mjs` 的 `priorityBand`)。
 */
export const EXPORT_PLAN_PRIORITY = 70;

/** 只为导出的清单计划(队列按清单计划收:结果键的形状、`input.clips` 的形状都照它的规矩) */
export function exportPlanTask({ projectId, projectRev, clips, codeVersion }: { projectId: string; projectRev: number; clips: readonly string[]; codeVersion?: string | null }): ExportPlanTask {
  const list = [...new Set(clips)].map(String).filter(Boolean).sort();
  const resultKey = `${projectId}@${projectRev}${CLIPS_KEY_MARK}${clipsSig(list, EXPORT_ONLY_SIG)}`;
  return {
    id: `plan:${resultKey}`, kind: "plan", resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list, exportOnly: true }, weight: { class: "medium", estMs: null, frames: null },
    requires: typeof codeVersion === "string" && codeVersion ? { codeVersion } : {}, priority: EXPORT_PLAN_PRIORITY,
  };
}

/** 索引里的一条(节点那一侧 `server/render-node/export-plan.mjs` 的 `exportIndexOf`) */
export interface ExportIndexStream {
  clipId: string;
  kind: "card" | "below";
  plane: "local" | "stage";
  resultKey: string;
  originFrame: number;
  lastFrame: number;
  lastSegment: number;
  segmentsPerTask: number;
  fps: number;
  rect: LayerRect;
  inputSig?: string;
}
export interface ExportIndex { streams: ExportIndexStream[]; unsupported: { clipId: string; reason: string }[] }

const rectOf = (r: unknown): LayerRect | null => {
  const o = r as Partial<LayerRect> | null;
  if (!o || typeof o !== "object") return null;
  const { x, y, w, h } = o;
  return [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) && (w as number) > 0 && (h as number) > 0 ? { x: x as number, y: y as number, w: w as number, h: h as number } : null;
};

/** 计划完成回包里的索引;形状不对回 null,单条不对的跳过 */
export function parseExportIndex(raw: unknown): ExportIndex | null {
  const b = raw as { streams?: unknown; unsupported?: unknown } | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.streams)) return null;
  const streams: ExportIndexStream[] = [];
  for (const s of b.streams as Record<string, unknown>[]) {
    const rect = rectOf(s?.rect);
    const kind = s?.kind === "below" ? "below" : s?.kind === "card" ? "card" : null;
    const plane = s?.plane === "stage" ? "stage" : s?.plane === "local" ? "local" : null;
    const ints = [s?.originFrame, s?.lastFrame, s?.lastSegment, s?.segmentsPerTask].map(Number);
    if (!s || typeof s.clipId !== "string" || !s.clipId || !HASH_RE.test(String(s.resultKey)) || !rect || !kind || !plane) continue;
    if (!ints.every(Number.isInteger) || ints[0] < 0 || ints[1] < ints[0] || ints[2] < 0 || ints[3] < 1 || !(Number(s.fps) > 0)) continue;
    streams.push({ clipId: s.clipId, kind, plane, resultKey: String(s.resultKey), originFrame: ints[0], lastFrame: ints[1], lastSegment: ints[2], segmentsPerTask: ints[3],
      fps: Number(s.fps), rect, ...(typeof s.inputSig === "string" && s.inputSig ? { inputSig: s.inputSig } : {}) });
  }
  const unsupported: ExportIndex["unsupported"] = [];
  for (const u of Array.isArray(b.unsupported) ? (b.unsupported as Record<string, unknown>[]) : []) {
    if (u && typeof u.clipId === "string" && u.clipId) unsupported.push({ clipId: u.clipId, reason: typeof u.reason === "string" && u.reason ? u.reason : "unknown" });
  }
  return { streams, unsupported };
}

/** 这条的清单按任务怎么分段:`[from, to]`(分段号),与切分同一种切法 */
export function exportSpans(stream: Pick<ExportIndexStream, "lastSegment" | "segmentsPerTask">): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = 0; from <= stream.lastSegment; from += stream.segmentsPerTask) out.push([from, Math.min(stream.lastSegment, from + stream.segmentsPerTask - 1)]);
  return out;
}

/** 一份清单里列着的帧:项目帧号 → PNG 的哈希 */
export function readExportManifest(body: unknown, resultKey: string, span: [number, number]): Map<number, string> | null {
  const b = body as { kind?: unknown; resultKey?: unknown; range?: { from?: unknown; to?: unknown }; frames?: unknown } | null;
  if (!b || typeof b !== "object" || b.kind !== "export-frames" || b.resultKey !== resultKey || !Array.isArray(b.frames)) return null;
  if (b.range?.from !== span[0] || b.range?.to !== span[1]) return null;
  const out = new Map<number, string>();
  for (const item of b.frames as unknown[]) {
    if (Array.isArray(item) && Number.isInteger(item[0]) && HASH_RE.test(String(item[1]))) out.set(item[0] as number, String(item[1]));
  }
  return out;
}

const cancelled = () => Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true });

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(cancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 等待时报给调用方的状态 */
export type ExportFramesStatus =
  | { phase: "publishing"; clips: number }
  /** 计划发出去了,还没有渲染节点认领 */
  | { phase: "no-node"; clips: number }
  /** 有节点接了,正在算怎么出 */
  | { phase: "planning"; clips: number }
  /** 节点正在逐帧渲:已到 `done` 帧,共 `total` 帧 */
  | { phase: "rendering"; clips: number; done: number; total: number };

/** 请到的位图:每个片段有哪些帧、怎么取 */
export interface ExportFrames {
  coverage: Map<string, FrameCoverage>;
  /** 这个片段这一帧的 PNG(`data:` 地址) */
  dataUrl(clipId: string, frame: number, signal?: AbortSignal): Promise<string>;
  stats: { fetched: number; bytes: number };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * 请渲染节点把 `clips` 逐帧渲好,等到齐。`project` 是导出用的那一版(页面手里的快照),`projectRev` 是文档服务确认的版本号。
 * 到齐的判据:索引里每个片段的每一段清单都在、清单把这一段的每一帧都列了(帧范围以节点给的为准:片段的第一帧到最后一帧)。
 */
export async function requestExportFrames({ projectId, projectRev, project, clips, deps, signal, onStatus }: {
  projectId: string; projectRev: number; project: unknown; clips: readonly string[];
  deps: ExportFrameDeps; signal: AbortSignal; onStatus?: (s: ExportFramesStatus) => void;
}): Promise<ExportFrames> {
  const sleep = deps.sleep ?? defaultSleep;
  const task = exportPlanTask({ projectId, projectRev, clips, codeVersion: deps.codeVersion ?? null });
  const want = task.input.clips;
  const say = (s: ExportFramesStatus) => { try { onStatus?.(s); } catch { /* 宿主坏了不影响等待 */ } };
  const heard: { index: ExportIndex | null; planFailed: string | null } = { index: null, planFailed: null };
  /** 失败了的导出位图任务:结果键 → 原因(队列只在任务彻底失败时才发 `task.failed`:不可重试,或重试用尽) */
  const taskFailures = new Map<string, string>();
  const off = deps.subscribeQueue((msg) => {
    const id = typeof msg?.id === "string" ? msg.id : "";
    if (id === task.id) {
      if (msg.type === "task.done") heard.index = parseExportIndex((msg.result as { exportIndex?: unknown } | null)?.exportIndex) ?? heard.index;
      else if (msg.type === "task.failed") heard.planFailed = String(msg.error ?? "failed");
      return;
    }
    // 流任务的 id:`stream:<结果键>:<起>-<止>`
    if (msg?.type === "task.failed" && id.startsWith("stream:")) taskFailures.set(id.split(":")[1] ?? "", String(msg.error ?? "failed"));
  });
  const failureText = (error: string) => (error === "superseded" ? ONLINE_EXPORT_TEXT.projectChanged : ONLINE_EXPORT_TEXT.nodeFailed(error));
  try {
    say({ phase: "publishing", clips: want.length });
    let hello = false;
    // 一、发计划,等索引
    while (!heard.index) {
      if (signal.aborted) throw cancelled();
      if (heard.planFailed) throw new Error(failureText(heard.planFailed));
      let state: string | null = null;
      try {
        if (!hello) {
          const r = await deps.request({ type: "publisher.hello", publisherId: deps.publisherId });
          hello = r?.type === "publisher.welcome";
        }
        if (hello) {
          const reply = await deps.request({ type: "task.publish", tasks: [task] });
          if (reply?.type !== "task.published") hello = false;
          const results = Array.isArray(reply?.results) ? (reply.results as { id?: string; error?: string; state?: string }[]) : [];
          const r = results.find((x) => x?.id === task.id);
          state = r && !r.error && typeof r.state === "string" ? r.state : null;
        }
      } catch { hello = false; /* 连接断着:下一轮再发 */ }
      if (heard.index) break;
      say(state === "claimed" || state === "done" ? { phase: "planning", clips: want.length } : { phase: "no-node", clips: want.length });
      await sleep(EXPORT_PLAN_POLL_MS, signal);
    }
    const found: ExportIndex = heard.index;
    // 二、节点说出不了的、没列出来的片段:导不了,说清楚是哪几个、为什么
    const listed = new Map(found.streams.map((s) => [s.clipId, s]));
    const bad = want.filter((id) => !listed.has(id)).map((id) => ({ clipId: id, reason: found.unsupported.find((u) => u.clipId === id)?.reason ?? "unknown" }));
    if (bad.length) throw Object.assign(new Error(ONLINE_EXPORT_TEXT.nodeCannot(bad.length, bad[0].reason)), { unsupported: bad });
    // 节点渲的那一版和本页手里这一版对不上(导出期间项目被改了):不拿别的版本的画面出片
    for (const s of found.streams) {
      if (s.inputSig && streamSigStale(s.inputSig, streamInputSig(project, { clipIds: [s.clipId], kind: s.kind }))) throw new Error(ONLINE_EXPORT_TEXT.projectChanged);
    }
    // 三、等每一段的清单到齐
    const frames = new Map<string, Map<number, string>>();
    const pending = new Map<string, { stream: ExportIndexStream; span: [number, number] }>();
    let total = 0;
    for (const id of want) {
      const s = listed.get(id)!;
      frames.set(id, new Map());
      total += s.lastFrame - s.originFrame + 1;
      for (const span of exportSpans(s)) pending.set(`${s.resultKey}:${span[0]}-${span[1]}`, { stream: s, span });
    }
    const doneFrames = () => { let n = 0; for (const got of frames.values()) n += got.size; return n; };
    /** 这一段清单把它盖住的每一帧都列了才收(节点只在一段全推完之后写清单,不全的不该出现) */
    const covers = (got: Map<number, string>, s: ExportIndexStream, span: [number, number]) => {
      const first = s.originFrame + span[0] * STREAM_SEGMENT_FRAMES;
      const last = Math.min(s.lastFrame, s.originFrame + (span[1] + 1) * STREAM_SEGMENT_FRAMES - 1);
      for (let f = first; f <= last; f++) if (!got.has(f)) return false;
      return true;
    };
    for (;;) {
      if (signal.aborted) throw cancelled();
      for (const [key, { stream, span }] of [...pending]) {
        let body: unknown = null;
        try {
          const r = await deps.request({ type: "content.get", kind: "render-manifest", key });
          body = r?.type === "content.item" && !r.missing ? r.body : null;
        } catch { body = null; }
        const got = readExportManifest(body, stream.resultKey, span);
        if (!got || !covers(got, stream, span)) continue;
        const into = frames.get(stream.clipId)!;
        for (const [f, hash] of got) if (f >= stream.originFrame && f <= stream.lastFrame) into.set(f, hash);
        pending.delete(key);
      }
      if (!pending.size) break;
      for (const [resultKey, error] of taskFailures) {
        if ([...pending.values()].some((p) => p.stream.resultKey === resultKey)) throw new Error(failureText(error));
      }
      say({ phase: "rendering", clips: want.length, done: doneFrames(), total });
      await sleep(EXPORT_MANIFEST_POLL_MS, signal);
    }
    const coverage = new Map<string, FrameCoverage>();
    for (const id of want) {
      const s = listed.get(id)!;
      coverage.set(id, { clipId: id, plane: s.plane, rect: s.rect, frames: new Set(frames.get(id)!.keys()) });
    }
    const stats = { fetched: 0, bytes: 0 };
    return {
      coverage, stats,
      async dataUrl(clipId, frame, sig) {
        const hash = frames.get(clipId)?.get(frame);
        if (!hash) throw new Error(ONLINE_EXPORT_TEXT.nodeFailed("frame-missing"));
        const base = deps.assetBase();
        if (!base) throw new Error("还没有远程素材服务");
        const f = deps.fetch ?? fetch;
        const res = await f(`${base.replace(/\/+$/, "")}/px/${hash}`, { headers: await deps.authHeaders(), signal: sig });
        if (!res.ok) throw new Error(`取不到渲染节点渲好的画面 ${hash.slice(0, 12)}:${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        stats.fetched++;
        stats.bytes += bytes.length;
        return `data:image/png;base64,${bytesToBase64(bytes)}`;
      },
    };
  } finally {
    try { off(); } catch { /* 订阅方坏了 */ }
  }
}
