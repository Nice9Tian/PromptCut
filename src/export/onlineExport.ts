/**
 * 在线页面的逐帧导出(`docs/plan/c10a-contract.md` 第 11.1 节)——`src/editor/io/index.ts` 的 `exportVideo` 在线分支的本体。
 * 流水在 `browserExport.ts`;这里接编辑器那一侧:项目、素材服务与文档服务(`assetTiers.ts`)、提示(`pushToast`)、落点。
 * 由 `io/index.ts` 按需载入(这一串在 Node 单测里载不进来)。
 */
import type { Project } from "../kernel/project";
import { actions, getState } from "../store/project";
import { assetAuthHeaders, docRequest, exportGate, hasDocLink, remoteAssetBase, remoteAssetTicketInfo } from "../editor/media/assetTiers";
import { createTicketRenewer, type TicketRenewer } from "./ticketRenewal";
import { remoteMediaUrl, mediaTierPolicy } from "../render/mediaTier";
import { activeOnlineSource } from "../render/snapshotSource";
import { judgedPlan, planLowMemory } from "../editor/planDispatch";
import { pushToast } from "../editor/sync/syncManager";
import { MemorySink, type MuxSink } from "./mp4Mux";
import { runBrowserExport } from "./browserExport";
import { ONLINE_EXPORT_TEXT } from "./text";

export interface OnlineExportOptions {
  /**
   * 「另存为」拿到的落点:给了就边编边按位置写进去(`showSaveFilePicker` 的流式写),回包带 `written: true`,
   * 调用方**不要**再 `streamExportFile`(那会把刚写好的文件换成空的)。不给就攒在内存里,由 `streamExportFile` /
   * `fetchExportFile` 取走;这个浏览器连「另存为」都没有(iOS)时攒成 Blob 直接下载。
   */
  target?: FileSystemFileHandle | null;
  /** 导出前核对没过(素材原尺寸没传完、重卡缺预渲染原尺寸)时给用户看的话;null = 过了 */
  onWaiting?: (message: string | null) => void;
  /** 探针:只导前 n 帧 */
  maxFrames?: number;
}

export interface OnlineJob {
  controller: AbortController;
  blob: Blob | null;
}

let seq = 0;

/** 这个浏览器有没有「另存为」(没有的是 iOS 这类,只能攒成 Blob 下载) */
const canPickFile = () => typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/**
 * 这个项目里页面自己判重的片段(还没有渲染节点的层表时,导出前核对按它算缺)。按轻重判定的表(`judgedPlan`):
 * 低内存档里是界限搜索的结果,不是显示用的「全部判重」。
 */
function heavyClipsOfPlan(p: Project): string[] {
  const plan = judgedPlan() as { prerenderSet?: Iterable<string> } | null;
  const set = plan?.prerenderSet ? new Set(plan.prerenderSet) : null;
  if (!set) return [];
  return p.tracks.flatMap((tr) => tr.clips).map((c) => c.id).filter((id) => set.has(id));
}

/** 低内存档:只有判重的卡用预渲染原尺寸,判轻的卡本机逐帧渲(契约 `c10-contract.md` 第 18 节第 8 条);普通档不限 */
const heavyOnlyOf = (p: Project) => () => (planLowMemory() ? heavyClipsOfPlan(p) : null);

const originalsDeps = () => (hasDocLink() ? { request: docRequest, assetBase: remoteAssetBase, authHeaders: assetAuthHeaders } : null);

export async function exportVideoOnline(
  opts: { onProgress?: (done: number, total: number, stage?: "render" | "compose") => void; onStart?: (id: string) => void } & OnlineExportOptions,
  jobs: Map<string, OnlineJob>,
): Promise<{ outDir: string; id: string; written?: boolean }> {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  const id = `online-${Date.now().toString(36)}-${++seq}`;
  const job: OnlineJob = { controller: new AbortController(), blob: null };
  jobs.set(id, job);
  opts.onStart?.(id);
  // 导出期间暂停预览,并释放小尺寸缓存(契约第 11.1 节)
  if (getState().playing) actions.pause();
  activeOnlineSource()?.clearCache();

  const writable = opts.target ? await opts.target.createWritable() : null;
  const memory = writable ? null : new MemorySink();
  const sink: MuxSink = writable
    ? { write: (data, position) => writable.write({ type: "write", position, data: data as unknown as BufferSource }) }
    : memory!;
  const remote = mediaTierPolicy().remote ?? (remoteAssetBase() ? { base: remoteAssetBase()!, ticket: null } : null);
  const name = `${(p.name || "PromptCut").replace(/[\\/:*?"<>|]+/g, "_")}.mp4`;
  let waitingShown = "";
  // C10 契约第 12 节:导出可能比只读票据的时限还长,途中按时限提前续签(取票复用 assetTicketSource)
  const renewer = remote ? await startRenewer() : null;
  try {
    const result = await runBrowserExport({
      project: p,
      sink,
      signal: job.controller.signal,
      maxFrames: opts.maxFrames,
      onProgress: (done, total) => opts.onProgress?.(done, total, "render"),
      onWaiting: (message) => {
        opts.onWaiting?.(message);
        if (!opts.onWaiting && message && message !== waitingShown) pushToast(message, "warn", 8000);
        waitingShown = message ?? "";
      },
      confirm: (message) => window.confirm(message),
      notify: (message, tone) => pushToast(message, tone ?? "info"),
      checkMediaOriginals: () => exportGate(p),
      originals: originalsDeps(),
      fallbackHeavy: () => heavyClipsOfPlan(p),
      heavyOnly: heavyOnlyOf(p),
      // 导出只用素材原尺寸:它的地址换成远程素材服务的取回地址(只读票据走查询串,`<video>` 带不了头)
      mediaUrl: remote ? (url) => remoteMediaUrl(url, { base: remote.base, ticket: renewer?.ticket() ?? remote.ticket }) : undefined,
      freshTicket: renewer ? () => renewer.ticket() : undefined,
    });
    renewer?.stop();
    if (writable) await writable.close();
    else {
      job.blob = memory!.blob();
      if (!canPickFile()) downloadBlob(job.blob, name);
    }
    pushToast(`${ONLINE_EXPORT_TEXT.done}(${result.frames} 帧,${(result.bytes / 1024 / 1024).toFixed(1)} MB)`, "info");
    return { outDir: "", id, written: !!writable };
  } catch (e) {
    renewer?.stop();
    try { await writable?.abort?.(); } catch { /* 已经关了 */ }
    const err = e as Error & { cancelled?: boolean };
    pushToast(err.cancelled ? ONLINE_EXPORT_TEXT.cancelled : ONLINE_EXPORT_TEXT.failed(err.message), err.cancelled ? "info" : "warn");
    throw err.cancelled ? Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true }) : err;
  }
}

/** 逐帧导出的票据续签(C10 契约第 12 节);取不到票据来源(本地素材服务)回 null,照旧用固定的那一张 */
async function startRenewer(): Promise<TicketRenewer | null> {
  if (!(await remoteAssetTicketInfo(false))) return null;
  const renewer = createTicketRenewer({ fetchTicket: () => remoteAssetTicketInfo(true) });
  await renewer.start();
  lastRenewer = renewer;
  return renewer;
}
/** 探针看:最近一次导出的续签次数 */
let lastRenewer: TicketRenewer | null = null;
export function exportRenewalStats() {
  return lastRenewer?.stats() ?? null;
}

/**
 * 探针入口(`window.__pcIo.exportVideoBrowser`,`scripts/probes/lowmem-export-compare.mjs`):在当前页面上跑一次浏览器逐帧导出,
 * 回产物字节(base64)与统计。不经「另存为」、不下载;`originals: false` 时重卡照活渲(桌面运行环境没有渲染节点的层表)。
 */
export async function exportVideoBrowserProbe(o: { maxFrames?: number; originals?: boolean } = {}) {
  const p = JSON.parse(JSON.stringify(getState().project)) as Project;
  const sink = new MemorySink();
  const controller = new AbortController();
  const waits: string[] = [];
  // 在线页面上(c10a-demo-probe):素材原尺寸同 exportVideoOnline 一样换成远程素材服务的取回地址;桌面运行环境没有远程时照旧
  const remote = mediaTierPolicy().remote ?? (remoteAssetBase() ? { base: remoteAssetBase()!, ticket: null } : null);
  const renewer = remote ? await startRenewer() : null;
  let result: Awaited<ReturnType<typeof runBrowserExport>>;
  try {
    result = await runBrowserExport({
    project: p, sink, signal: controller.signal, maxFrames: o.maxFrames,
    onWaiting: (m) => { if (m) waits.push(m); if (waits.length > 3) controller.abort(); },
    confirm: () => true, notify: () => {},
    checkMediaOriginals: () => exportGate(p),
    originals: o.originals ? originalsDeps() : null,
    fallbackHeavy: () => heavyClipsOfPlan(p),
    heavyOnly: heavyOnlyOf(p),
    mediaUrl: remote ? (url) => remoteMediaUrl(url, { base: remote.base, ticket: renewer?.ticket() ?? remote.ticket }) : undefined,
    freshTicket: renewer ? () => renewer.ticket() : undefined,
    });
  } catch (e) {
    renewer?.stop();
    // 导出前核对一直没过(等待上传方等)时,把看到的提示交回去,探针要核对文案
    const err = e as Error & { cancelled?: boolean };
    return { result: null, waits, base64: "", error: String(err?.message ?? err), cancelled: !!err?.cancelled };
  }
  renewer?.stop();
  const bytes = sink.bytes();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { result, waits, base64: btoa(bin), renewal: renewer?.stats() ?? null };
}
