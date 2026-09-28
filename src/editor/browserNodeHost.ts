/**
 * 在线页面的纯浏览器渲染节点的宿主(M7 契约 `docs/plan/m7-contract.md` 第 2、4、5、7 节):把 `src/online/browserNode.ts` 的编排
 * 接到这一页的连接、舞台、素材服务、页面内快照库与界面状态上。
 *
 * # 何时当节点(第 2 节)
 *
 * 每 `HOST_TICK_MS` 判一次 `browserNodeEligibility`(在线构建且嵌了代码版本、普通档、两个跨源舞台都握上手、Chromium、以成员身份
 * 连着云端项目、测量落定)。成立就开 render 连接当节点;不成立(运行中改判低内存档、退回单舞台、离开项目……)就放回全部、结束会话。
 * 被踢(4003)、项目被删(4004)、报到被拒(`forbidden` / `not-chromium` / `bad-message`)之后这一页不再当节点。
 *
 * # render 连接与票据(第 5 节)
 *
 * 父页开(不放舞台里:舞台会互换角色),地址与页面连接相同。每建一次会话,在页面连接上现签一张
 * `auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'browser' } }`(2 分钟),子协议 `promptcut.ticket.<票据>`;
 * 会话层 `createDocEndpoint`:保留期内传输断开就接续,不重交凭证;新会话在 `onOpen` 里报到(节点的 `start()`,带手里的认领)。
 * 票据不进地址、日志、诊断。
 *
 * # 闲的判据与让路(第 2 节、D8)
 *
 * `isIdle()`(父页判,舞台不判):后台活的门开着(页面可见、父页 rAF 不断档、父页 rIC 在回调,`backWorkGate`)、不在播放、不在拖动、
 * 离上一次播放或拖动已过 `INTERACTION_QUIET_MS`、单飞队列里没有更急的活(补跑、测量、探针)、有后台舞台。
 * 让路:播放开始 → `yieldFor('play')`,拖动开始 → `'drag'`(当前帧做完就放回);更急的后台活来了(生成快照那个单飞活收到 abort)
 * → `'urgent'`;页面隐藏或父页 rAF 断档 → `'hidden'`(不等当前帧,立即放回)。
 *
 * # 一帧(第 4.3～4.5 节,D3、D5、D7)
 *
 * 认领到的第一帧开一个单飞活 `bake`(最不急),`pushProject('back', 隔离单卡工程, { reset })` 灌进后台舞台(走 stageBridge 的基线),
 * 再逐帧 `bakeFrame`;舞台的 `bake-frame` 事件带回压过的 HTML 与小尺寸 WebP。父页:解压 → 推素材服务(`snap`、`px`,D7 父页推)→
 * 块进页面内快照库(`snap/<hash>`、`px/<hash>`)、这一层的 `ranges` 写这一帧(写入即就绪,通知在线来源)。
 * 两档并行推;推的同时先把下一帧发给舞台(顺推、还闲时),每帧耗时是「舞台一帧」与「推两档的网络往返」取大,不是两者相加。
 * 全段齐后组清单(形状同桌面 `collectSnapshotResult`)、写内容库(失败只记诊断),`task.complete { ranges, ...清单 }`。
 * 这一段收尾(完成、失败、放回、丢认领)就交还后台舞台。
 *
 * # 项目版本(D6)
 *
 * 清单计划发布前(`planPublisher` 的 `onPublish`)把此刻的已确认版本按版本号留在内存,最多 `KEPT_REVISIONS` 版;
 * 细任务先用留存的,没有再经 render 连接 `project.snapshot.get`,都没有就放回(`no-snapshot`)。
 *
 * # 诊断(第 7 节)
 *
 * `window.__pcBrowserNode()`:资格与原因、节点状态与计数(`browserNode.ts` 的 `debug()`)、推了几块 / 跳过几块 / 多少字节、
 * 小尺寸几帧、舞台每帧耗时 p50 / p95 与被门挡住的时长、连接状态、最近一次错误。
 */
import { browserNodeEligibility, createBrowserNode, type BrowserNode, type EligibilityInput, type FrameRecord, type NodeTask } from "../online/browserNode";
import { bakeInputOf, isolatedCardProject, manifestBlocks, manifestCovers, manifestKey, snapshotManifest, type BakeInput } from "../online/bakeTask";
import { createSnapUploader, type SnapUploader } from "../online/snapUploader";
import { pageL2 } from "../online/l2";
import { pageEnvironment } from "./pageEnvironment.mjs";
import { backWorkDiag } from "./backWorkGate";
import { runBackJob, urgentBackJobs } from "./stageJobs";
import { backStage, onStageEvent, pushProject } from "./stageBridge";
import { getState, subscribe } from "../store/project";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { docRequest, remoteAssetBase } from "./media/assetTiers";
import { currentSharedUrl, me, pageSession } from "./sync/syncManager";
import type { Project } from "../kernel/project";
import type { BakeFrameReply, StageEvent, StageRpcClient } from "../render/stageRpc";
// @ts-expect-error 无类型声明的 .mjs(浏览器与 Node 通用,只用 WebSocket 与计时器)
import { createDocEndpoint as createDocEndpointUntyped } from "../../server/render-node/session-link.mjs";

/** 多久判一次资格、节拍一次(认领与续约由会话自己按间隔节流) */
export const HOST_TICK_MS = 250;
/** 离上一次播放或拖动至少这么久才算闲(沿用桌面节点的 500 ms,`server/queue-idle.mjs`;三级数字) */
export const INTERACTION_QUIET_MS = 500;
/** 发布时留存的已确认版本最多几版(同执行器的 `PLAN_CACHE_SIZE`) */
export const KEPT_REVISIONS = 4;
/** 取项目快照最多等多久 */
export const SNAPSHOT_FETCH_MS = 30_000;
/** render 会话建不成 / 结束后重建的退避 */
const REDIAL_MIN_MS = 1000;
const REDIAL_MAX_MS = 30_000;
/** 推帧口径(契约第 4.3 节):逐帧顺推(探针 P2:DOM 独立卡与桌面 4 帧一批从头推等价、便宜 4～7 倍;画布卡不进浏览器) */
export const BAKE_MODE: "batch4" | "seq" = "seq";
/** 被踢、项目被删:不再重连(HT-a) */
const FATAL_CLOSE = new Set([4003, 4004]);

type DocEndpoint = {
  send(message: object): boolean;
  onMessage(handler: (message: Record<string, unknown>) => void): void;
  onOpen(handler: () => void): void;
  onResume(handler: () => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onConnectFail(handler: (info: { code: number; reason: string }) => void): void;
  close(): void;
  readonly connected: boolean;
  stats(): { transport: string | null; resumes: number; [k: string]: unknown };
};
const createDocEndpoint = createDocEndpointUntyped as (options: Record<string, unknown>) => DocEndpoint;

/* ------------------------------------------------------------------ 模块级:给清单计划与在线来源用 */

/** 发布时留存的已确认版本:版本号 → 项目(只读,不改) */
const kept = new Map<number, Project>();
/** D6:清单计划发布前留存这一版 */
export function keepConfirmedProject(rev: number, project: Project | null): void {
  if (!Number.isSafeInteger(rev) || rev <= 0 || !project) return;
  kept.delete(rev);
  kept.set(rev, project);
  while (kept.size > KEPT_REVISIONS) kept.delete(kept.keys().next().value as number);
}

let readyState: "none" | "pending" | "ready" = "none";
const readyListeners = new Set<() => void>();
const setReady = (next: "none" | "pending" | "ready") => {
  if (next === readyState) return;
  readyState = next;
  for (const l of [...readyListeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
};
/** 本页的纯浏览器节点报到了没有(清单计划据此等,最多 3 s):不当节点 `none`、在报到 `pending`、拿到指纹 `ready` */
export function browserNodeReady(): "none" | "pending" | "ready" {
  return readyState;
}
export function subscribeBrowserNodeReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

/* ------------------------------------------------------------------ 宿主 */

export interface BrowserNodeHostDeps {
  /** 此刻当节点的条件(第 2 节) */
  eligibility: () => EligibilityInput;
  /** 此刻连着的共享项目 id */
  projectId: () => string | null;
  /** 本页产出并完成了这一段:在线来源把这个结果键认作活着(D12) */
  onAlive?: (resultKey: string) => void;
}

const quantile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw Object.assign(new Error("浏览器没有 DecompressionStream"), { retryable: false });
  const stream = new Blob([buf]).stream().pipeThrough(new DS("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 这一段的「活」:单飞队列里那个 `bake` 活,段收尾时交还 */
interface Lease {
  taskId: string;
  isolated: Project;
  input: BakeInput;
  stage: StageRpcClient;
  /** 这台舞台灌过这一段的隔离单卡工程没有 */
  pushedTo: StageRpcClient | null;
  /** 已经先发给舞台的下一帧(父页推上一帧的两档时舞台接着推这一帧,见 `bakeFrame`) */
  ahead: { frame: number; stage: StageRpcClient; reply: Promise<BakeFrameReply> } | null;
  close: () => void;
}

export function startBrowserNodeHost(deps: BrowserNodeHostDeps): () => void {
  let stopped = false;
  let fatal: string | null = null;
  let node: BrowserNode | null = null;
  let nodeProject: string | null = null;
  let ep: DocEndpoint | null = null;
  let dialing = false;
  let redialAt = 0;
  let redialDelay = REDIAL_MIN_MS;
  let lastInteractionAt = -Infinity;
  let lastError: string | null = null;
  let eligibility: { ok: boolean; reason: string | null } = { ok: false, reason: "starting" };
  const nodeId = `browser-${pageSession()}`;
  const conn = { sessions: 0, opens: 0, closes: 0, resumes: 0, lastClose: null as { code: number; reason: string } | null };
  const stage = { frames: 0, ms: [] as number[], pausedMs: 0, remounts: 0, small: 0, smallMs: [] as number[], readyMs: [] as number[], errors: {} as Record<string, number> };
  /** 父页一侧每帧的时间构成(毫秒,最近 200 帧):开活与灌工程、舞台往返、解压、推两档、进页面内快照库 */
  const PHASES = ["lease", "rpc", "gunzip", "snap", "px", "push", "l2", "total"] as const;
  const phases = Object.fromEntries(PHASES.map((k) => [k, [] as number[]])) as Record<(typeof PHASES)[number], number[]>;
  const notePhase = (k: (typeof PHASES)[number], ms: number) => { const a = phases[k]; a.push(ms); if (a.length > 200) a.splice(0, a.length - 200); };
  const manifestStats = { written: 0, failed: 0, lastError: null as string | null };

  /* ---------------- 写票据与上传器(D7:父页推) ---------------- */

  let rw: { ticket: string; exp: number; issued: number } | null = null;
  /** 在签的那一次:两档并行推时同时来要票据,只签一张 */
  let rwSigning: Promise<string | null> | null = null;
  const rwTicket = (force = false): Promise<string | null> => {
    const now = Date.now();
    if (!force && rw && now < rw.issued + ((rw.exp - rw.issued) * 2) / 3) return Promise.resolve(rw.ticket);
    if (rwSigning) return rwSigning;
    rwSigning = signRw().finally(() => { rwSigning = null; });
    return rwSigning;
  };
  const signRw = async (): Promise<string | null> => {
    const now = Date.now();
    try {
      const r = await docRequest({ type: "auth.ticket", kind: "asset", access: "rw" });
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") {
        rw = { ticket: r.ticket, exp: Number(r.exp) || now + 15 * 60_000, issued: now };
        return rw.ticket;
      }
    } catch { /* 签不到:上传回 401,按可重试失败交回 */ }
    return rw?.ticket ?? null;
  };
  const uploader: SnapUploader = createSnapUploader({ base: remoteAssetBase, ticket: rwTicket });
  const store = pageL2({ lowMemory: false }).catch(() => null);

  /* ---------------- 生成快照的活 ---------------- */

  let lease: Lease | null = null;
  /** 舞台发来的 `bake-frame`:会话号 + 本地帧 → 事件 */
  const bakeEvents = new Map<string, Extract<StageEvent, { type: "bake-frame" }>>();
  const offStage = onStageEvent((e) => {
    if (e.type !== "bake-frame") return;
    bakeEvents.set(`${e.session}#${e.localFrame}`, e);
    if (bakeEvents.size > 16) bakeEvents.delete(bakeEvents.keys().next().value as string);
  });

  const closeLease = () => {
    const l = lease;
    lease = null;
    if (!l) return;
    try { void l.stage.bakeCancel().catch(() => {}); } catch { /* 舞台换了 */ }
    l.close();
  };

  /** 开这一段的活:排进单飞队列(最不急),拿到后台舞台才回 */
  const openLease = (task: NodeTask, project: unknown): Promise<Lease> => {
    const input = bakeInputOf(task);
    if (!input) return Promise.reject(Object.assign(new Error("任务没有 input.bake / clipId(切分方没给浏览器那一份的参数)"), { retryable: false }));
    let isolated: Project;
    try { isolated = isolatedCardProject(project as Project, input); } catch (e) { return Promise.reject(Object.assign(e as Error, { retryable: false })); }
    return new Promise<Lease>((resolve, reject) => {
      let got = false;
      void runBackJob("bake", async (ctx) => {
        let release!: () => void;
        const done = new Promise<void>((r) => { release = r; });
        const l: Lease = { taskId: task.id, isolated, input, stage: ctx.stage, pushedTo: null, ahead: null, close: () => release() };
        // 更急的活来了(补跑、测量、探针):当前帧做完就放回(D8)
        ctx.signal.addEventListener("abort", () => { node?.yieldFor("urgent"); }, { once: true });
        got = true;
        resolve(l);
        await done;
      }).catch((e) => { if (!got) reject(e); });
    });
  };

  const bakeFrame = async ({ task, project, localFrame, signal }: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal }) => {
    const t0 = performance.now();
    if (!lease || lease.taskId !== task.id) {
      closeLease();
      const l = await openLease(task, project);
      if (signal.aborted) { l.close(); throw Object.assign(new Error("已中止"), { retryable: true }); }
      lease = l;
    }
    const l = lease;
    // 舞台互换或 iframe 重载之后,后台位置上换了人:在新的后台舞台上重开(做到哪一帧记在节点里)
    const cur = backStage();
    if (cur && cur !== l.stage) { l.stage = cur; l.pushedTo = null; l.ahead = null; }
    if (l.pushedTo !== l.stage) {
      await pushProject("back", l.isolated, { reset: true });
      l.pushedTo = l.stage;
    }
    const session = task.id;
    const tRpc = performance.now();
    notePhase("lease", tRpc - t0);
    const onAbort = () => { void l.stage.bakeCancel().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    // 上一帧推两档时已经先发给舞台的这一帧:直接等它的回包;对不上(跳了帧、换了舞台)就照常发,新的一帧作废在飞的那一帧
    const ahead = l.ahead;
    l.ahead = null;
    let reply: BakeFrameReply;
    try {
      reply = ahead && ahead.frame === localFrame && ahead.stage === l.stage
        ? await ahead.reply
        : await l.stage.bakeFrame({ session, clipId: l.input.clipId, localFrame, mode: BAKE_MODE, small: true });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    notePhase("rpc", performance.now() - tRpc);
    /*
     * 先发下一帧(顺推时):推素材服务是网络往返(在线站点上每块至少一次 `GET chunks`),舞台在另一个进程里,
     * 两件事并行,每帧的耗时从「舞台 + 往返」降到两者取大。这一帧仍然两档都推成功才回(c10a 第 9 节);
     * 下一帧的回包只在节点真来要它时才用。让路、放回、丢认领时 `closeLease` 的 `bakeCancel` 把它停在帧边界。
     * 不闲(要让路)或已中止时不先发。
     */
    const range = task.range;
    if (reply.ok && BAKE_MODE === "seq" && range && localFrame + 1 <= range.to && !signal.aborted && isIdle() && lease === l) {
      const next = localFrame + 1;
      const p = l.stage.bakeFrame({ session, clipId: l.input.clipId, localFrame: next, mode: BAKE_MODE, small: true })
        .catch((e): BakeFrameReply => ({ ok: false, reason: "cancelled", detail: String((e as Error)?.message ?? e).slice(0, 200) }));
      l.ahead = { frame: next, stage: l.stage, reply: p };
    }
    if (!reply.ok) {
      stage.errors[reply.reason] = (stage.errors[reply.reason] ?? 0) + 1;
      // 不可重试:再做一遍结果一样。`not-ready`(就绪闸超时)按可重试交回,同桌面 waitFrameReady 抛错的处理
      const finalReasons = new Set(["lossy", "no-clip", "no-control", "frame-mismatch", "unsupported"]);
      if (reply.reason === "role" || reply.reason === "no-project") l.pushedTo = null;
      throw Object.assign(new Error(`生成快照没成:${reply.reason}${reply.detail ? `(${reply.detail})` : ""}`), { retryable: !finalReasons.has(reply.reason) });
    }
    const ev = bakeEvents.get(`${session}#${localFrame}`);
    bakeEvents.delete(`${session}#${localFrame}`);
    if (!ev || ev.hash !== reply.hash) throw Object.assign(new Error("舞台的 bake-frame 事件没到"), { retryable: true });
    stage.frames++;
    stage.ms.push(reply.ms);
    stage.readyMs.push(reply.readyMs);
    if (stage.ms.length > 200) { stage.ms.splice(0, stage.ms.length - 200); stage.readyMs.splice(0, stage.readyMs.length - 200); }
    stage.pausedMs += reply.pausedMs;
    if (reply.remounted) stage.remounts++;
    let tp = performance.now();
    const bytes = ev.htmlGz ? await gunzip(ev.htmlGz) : new Uint8Array(ev.htmlRaw ?? new ArrayBuffer(0));
    notePhase("gunzip", performance.now() - tp);
    if (bytes.length !== ev.bytes) throw Object.assign(new Error("解压后的快照字节数对不上"), { retryable: true });
    // 推素材服务:两档并行推(各自至少一次网络往返,互不依赖),两档都推成功才算这一帧做完(c10a 第 9 节)
    tp = performance.now();
    const timed = (k: "snap" | "px", work: Promise<unknown>) => work.then(() => notePhase(k, performance.now() - tp));
    const pushes = [timed("snap", uploader.put("snap", ev.hash, bytes, "html"))];
    if (ev.small) pushes.push(timed("px", uploader.put("px", ev.small.hash, new Uint8Array(ev.small.webp), "webp")));
    const settled = await Promise.allSettled(pushes);
    const bad = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (bad) throw bad.reason;
    notePhase("push", performance.now() - tp);
    let small: { hash: string; bytes: number } | null = null;
    if (ev.small) {
      small = { hash: ev.small.hash, bytes: ev.small.bytes };
      stage.small++;
      stage.smallMs.push(reply.smallMs);
      if (stage.smallMs.length > 200) stage.smallMs.splice(0, stage.smallMs.length - 200);
    }
    // 自产的块进页面内快照库;这一层的 ranges 写这一帧(写入即就绪,在线来源据此换上)
    tp = performance.now();
    const s = await store;
    if (s) {
      await s.putBlock(`snap/${ev.hash}`, bytes, "text/html").catch(() => {});
      if (ev.small) await s.putBlock(`px/${ev.small.hash}`, new Uint8Array(ev.small.webp), "image/webp").catch(() => {});
      await s.putRange(task.resultKey, localFrame, localFrame).catch(() => {});
    }
    notePhase("l2", performance.now() - tp);
    notePhase("total", performance.now() - t0);
    return { hash: ev.hash, bytes: bytes.length, small };
  };

  const finishTask = async ({ task, frames }: { task: NodeTask; frames: FrameRecord[] }) => {
    const manifest = snapshotManifest(task as Parameters<typeof snapshotManifest>[0], frames);
    const key = manifestKey(task);
    try {
      const r = await docRequest({ type: "content.put", kind: "snapshot-manifest", key, body: manifest });
      if (r.type === "content.stored") manifestStats.written++;
      else { manifestStats.failed++; manifestStats.lastError = String(r.reason ?? r.type); }
    } catch (e) {
      // 写内容库失败只记诊断(同桌面 writeManifest):清单照样随 task.complete 交给订阅方
      manifestStats.failed++;
      manifestStats.lastError = String((e as Error)?.message ?? e);
    }
    return manifest as unknown as Record<string, unknown>;
  };

  /** 去重(第 4.1 节):内容库清单在、覆盖整段、两档齐、每块都在素材服务上 */
  const lookupResult = async (task: NodeTask) => {
    const key = manifestKey(task);
    if (!key) return null;
    let body: unknown = null;
    try {
      const r = await docRequest({ type: "content.get", kind: "snapshot-manifest", key });
      body = r.type === "content.item" ? r.body : null;
    } catch { return null; }
    if (!manifestCovers(body, task as Parameters<typeof manifestCovers>[1])) return null;
    for (const b of manifestBlocks(body)) if (!(await uploader.has(b.ns, b.hash))) return null;
    return body as unknown as Record<string, unknown>;
  };

  /* ---------------- 取项目快照(经 render 连接) ---------------- */

  const snapshotWaiters = new Map<string, (m: Record<string, unknown>) => void>();
  let snapSeq = 0;
  const fetchSnapshot = (rev: number): Promise<Project | null> => new Promise((resolve) => {
    const e = ep;
    const projectId = nodeProject;
    if (!e || !projectId) { resolve(null); return; }
    const reqId = `browser-snap-${++snapSeq}`;
    const parts: string[] = [];
    let count = -1;
    const finish = (p: Project | null) => { snapshotWaiters.delete(reqId); clearTimeout(timer); resolve(p); };
    const timer = setTimeout(() => finish(null), SNAPSHOT_FETCH_MS);
    snapshotWaiters.set(reqId, (m) => {
      if (m.type === "project.snapshot.part") {
        if (m.missing === true) { finish(null); return; }
        const i = Number(m.index);
        if (Number.isInteger(i) && typeof m.data === "string") { parts[i] = m.data; count = Number(m.count); }
      } else if (m.type === "project.snapshot.end") {
        const text = parts.join("");
        if (count >= 0 && parts.filter((x) => typeof x === "string").length !== count) { finish(null); return; }
        void sha256HexText(text).then((digest) => {
          if (digest !== m.digest) { finish(null); return; }
          try { finish(JSON.parse(text) as Project); } catch { finish(null); }
        }, () => finish(null));
      } else if (m.type === "error") {
        finish(null);
      }
    });
    if (!e.send({ type: "project.snapshot.get", projectId, projectRev: rev, reqId })) finish(null);
  });

  /* ---------------- 闲的判据与让路 ---------------- */

  const isIdle = (): boolean => {
    const bw = backWorkDiag();
    if (!bw.on) return false;
    if (getState().playing || isScrubbing()) return false;
    if (Date.now() - lastInteractionAt < INTERACTION_QUIET_MS) return false;
    if (urgentBackJobs() > 0) return false;
    if (!backStage()) return false;
    return true;
  };

  let wasPlaying = !!getState().playing;
  const offStore = subscribe(() => {
    const playing = !!getState().playing;
    if (playing) lastInteractionAt = Date.now();
    if (playing && !wasPlaying) node?.yieldFor("play");
    if (!playing && wasPlaying) lastInteractionAt = Date.now();
    wasPlaying = playing;
  });
  let wasScrubbing = isScrubbing();
  const offScrub = subscribeScrub(() => {
    const s = isScrubbing();
    lastInteractionAt = Date.now();
    if (s && !wasScrubbing) node?.yieldFor("drag");
    wasScrubbing = s;
  });
  const onVisibility = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") node?.yieldFor("hidden"); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  /*
   * 冻结(M7 探针 P5):冻结只发生在隐藏之后,D8 已经放回;`freeze` 事件来时再尽力放回一次(切走约 2 s 后到,还发得出消息)。
   * 冻结恢复时 Chrome 会关掉 WebSocket,手里的认领在冻结超过租约时已经丢了:`resume` 一律当一次重连 —— 结束这条会话、马上重建、重新报到。
   */
  const onFreeze = () => { node?.yieldFor("hidden"); };
  const onResume = () => {
    conn.resumes++;
    const e = ep;
    if (!e) return;
    ep = null;
    if (readyState === "ready") setReady("pending");
    for (const w of [...snapshotWaiters.values()]) w({ type: "error" });
    try { e.close(); } catch { /* 已经关了 */ }
    redialAt = 0;
    redialDelay = REDIAL_MIN_MS;
  };
  if (typeof document !== "undefined") { document.addEventListener("freeze", onFreeze); document.addEventListener("resume", onResume); }
  const onPageHide = () => teardown("pagehide");
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  /* ---------------- render 连接 ---------------- */

  const dial = async () => {
    if (stopped || fatal || dialing || ep || !node) return;
    const url = currentSharedUrl();
    if (!url) return;
    dialing = true;
    let ticket: string | null = null;
    try {
      const r = await docRequest({ type: "auth.ticket", kind: "conn", role: "render", owner: { kind: "browser" } });
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") ticket = r.ticket;
      else lastError = `签 render 票据被拒:${String(r.reason ?? r.type)}`;
    } catch (e) {
      lastError = `签 render 票据失败:${String((e as Error)?.message ?? e)}`;
    }
    dialing = false;
    if (stopped || fatal || !node || !ticket) { scheduleRedial(); return; }
    const protocols = ["promptcut.v1", `promptcut.ticket.${ticket}`];
    let e: DocEndpoint;
    try {
      e = createDocEndpoint({ url, protocols: () => protocols, transport: "ws", renew: false, backoff: { baseMs: 500, factor: 2, maxMs: 5000, jitter: 0.2 } });
    } catch (err) {
      lastError = `建 render 会话失败:${String((err as Error)?.message ?? err)}`;
      scheduleRedial();
      return;
    }
    ep = e;
    conn.sessions++;
    e.onOpen(() => {
      if (ep !== e || !node) return;
      conn.opens++;
      redialDelay = REDIAL_MIN_MS;
      node.start();
    });
    e.onMessage((m) => {
      if (ep !== e || !m || typeof m !== "object") return;
      const reqId = typeof m.reqId === "string" ? m.reqId : null;
      const w = reqId ? snapshotWaiters.get(reqId) : undefined;
      if (w) { w(m); return; }
      node?.receive(m);
      if (m.type === "node.welcome" && node?.envFingerprint) setReady("ready");
    });
    const gone = (info: { code: number; reason: string }) => {
      if (ep !== e) return;
      ep = null;
      conn.closes++;
      conn.lastClose = { code: info.code, reason: String(info.reason ?? "").slice(0, 80) };
      if (readyState === "ready") setReady("pending");
      for (const w of [...snapshotWaiters.values()]) w({ type: "error" });
      if (FATAL_CLOSE.has(info.code)) { fatal = `closed-${info.code}`; teardown(fatal); return; }
      scheduleRedial();
    };
    e.onClose(gone);
    e.onConnectFail(gone);
  };
  const scheduleRedial = () => {
    if (stopped || fatal) return;
    redialAt = Date.now() + redialDelay;
    redialDelay = Math.min(REDIAL_MAX_MS, redialDelay * 2);
  };

  const openNode = (projectId: string) => {
    nodeProject = projectId;
    setReady("pending");
    node = createBrowserNode({
      nodeId, projectId, userId: me().userId ?? "", codeVersion: deps.eligibility().codeVersion ?? null, environment: pageEnvironment(),
      now: Date.now, isIdle,
      send: (m) => ep?.send(m) ?? false,
      keptProject: (rev) => kept.get(rev) ?? null,
      fetchSnapshot, bakeFrame, finishTask, lookupResult,
      onTaskEnd: (task, outcome) => {
        closeLease();
        if (outcome === "completed" || outcome === "dedup") { try { deps.onAlive?.(task.resultKey); } catch { /* 宿主坏了 */ } }
      },
      onFingerprint: () => setReady("ready"),
      onRefused: (reason) => { fatal = `refused-${reason}`; lastError = `报到被拒:${reason}`; teardown(fatal); },
    });
    redialAt = 0;
    redialDelay = REDIAL_MIN_MS;
  };

  let lastStop: { reason: string; at: number; debug: ReturnType<BrowserNode["debug"]> } | null = null;
  /** 下线:放回全部、结束会话(第 2 节「下线」) */
  function teardown(reason: string) {
    const n = node;
    node = null;
    nodeProject = null;
    if (n) { try { n.stop(); } catch { /* 连接已坏 */ } lastStop = { reason, at: Date.now(), debug: n.debug() }; }
    closeLease();
    const e = ep;
    ep = null;
    // 放回的消息先发出去再关(会话层 close 先发 session.close)
    if (e) setTimeout(() => { try { e.close(); } catch { /* 已经关了 */ } }, 50);
    setReady("none");
  }

  /**
   * 打开项目的那一轮测量落定过的项目(第 2 节「打开项目的测量已落定(加载遮罩撤下)」)。之后新加的卡在后台舞台里补测时
   * 不下线 —— 那是单飞队列里更急的活,由 `isIdle()` 让它先行,不必结束会话再重连。
   */
  const measuredProjects = new Set<string>();
  const loop = () => {
    if (stopped) return;
    const projectId = deps.projectId();
    const raw = deps.eligibility();
    if (raw.measured && projectId) measuredProjects.add(projectId);
    const input = projectId && measuredProjects.has(projectId) ? { ...raw, measured: true } : raw;
    eligibility = browserNodeEligibility(input);
    if (fatal || !eligibility.ok || !projectId) {
      if (node) teardown(fatal ?? eligibility.reason ?? "no-project");
      return;
    }
    if (node && nodeProject !== projectId) teardown("project-changed");
    if (!node) openNode(projectId);
    if (!ep && !dialing && Date.now() >= redialAt) void dial();
    // 页面隐藏、父页 rAF 断档:不等当前帧,立即放回(D8)
    const bw = backWorkDiag();
    if (!bw.on && (bw.reason === "hidden" || bw.reason === "raf-gap")) node?.yieldFor("hidden");
    if (getState().playing || isScrubbing()) lastInteractionAt = Date.now();
    try { node?.tick(); } catch (e) { lastError = String((e as Error)?.message ?? e); }
  };
  const timer = setInterval(loop, HOST_TICK_MS);
  loop();

  const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  if (w) {
    w.__pcBrowserNode = () => {
      const d = node?.debug() ?? null;
      const ms = [...stage.ms].sort((a, b) => a - b);
      const sm = [...stage.smallMs].sort((a, b) => a - b);
      const up = uploader.stats();
      return {
        eligibility, fatal, ready: readyState, nodeId,
        state: d?.state ?? "off", reason: d?.reason ?? (fatal ?? eligibility.reason),
        envFingerprint: d?.envFingerprint ?? null, codeVersion: d?.codeVersion ?? null, holding: d?.holding ?? [],
        counters: d?.counters ?? null,
        idle: node ? isIdle() : false,
        stage: {
          frames: stage.frames, remounts: stage.remounts, pausedMs: Math.round(stage.pausedMs), errors: { ...stage.errors },
          frameMs: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) },
          smallFrames: stage.small, smallMs: { p50: quantile(sm, 0.5), p95: quantile(sm, 0.95) },
          phases: Object.fromEntries(PHASES.map((k) => { const a = [...phases[k]].sort((x, y) => x - y); return [k, { n: a.length, p50: quantile(a, 0.5), p95: quantile(a, 0.95) }]; })),
        },
        upload: { pushed: up.pushed, skipped: up.skipped, bytes: up.pushedBytes, failed: up.failed, reauth: up.reauth, recheck: up.recheck, lastError: up.lastError, ms: up.ms },
        manifests: { ...manifestStats },
        connection: { connected: !!ep?.connected, transport: ep?.stats().transport ?? null, ...conn },
        kept: [...kept.keys()],
        lastError: d?.lastError ?? lastError,
        lastStop: lastStop && { reason: lastStop.reason, at: lastStop.at, counters: lastStop.debug.counters },
      };
    };
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    teardown("unmount");
    offStage();
    offStore();
    offScrub();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
    }
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    if (w) delete w.__pcBrowserNode;
  };
}
