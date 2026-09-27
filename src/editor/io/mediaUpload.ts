import { actions, getState, subscribe } from "../../store/project";
import type { MediaAsset } from "../../kernel/project";
import { isViewOnly } from "./viewOnly";

/**
 * 导入 = 先入库再引用(A1)。
 *
 * **为什么不在页面里算哈希**:素材键是文件内容的 sha256,4 GB 的视频在主线程上读一遍
 * 就是几秒的长任务,连 Worker 里读也要把整份字节搬进页面内存。这里改成把 File 直接
 * 交给 fetch 当 body —— 浏览器从磁盘流式发出去,页面一份字节都不持有;服务端
 * (server/vite-plugin-media.ts 的 storeMediaStream)边落盘边 update sha256,同样是
 * 常数内存、没有长任务。算完回一个 `<hash>`,素材地址就是 /@media/<hash>。
 * 于是主线程和 dev server 的事件循环在整个导入期间都是空的,时间轴照常能编辑。
 *
 * 上传期间素材先挂 `pending: true`、`url: ""`:素材层画「上传中」占位,
 * 不会再出现一个渲染进程 / 导出进程够不着的 blob: 地址。
 */

export interface UploadedMedia {
  hash: string;
  ext: string;
  name: string;
  /** 本地内容库里的绝对路径(迁移期的老代码还在看它) */
  path?: string;
  /** /@media/<hash> */
  url: string;
  bytes: number;
  /** 库里本来就有同样内容 */
  deduped?: boolean;
  /**
   * C6.6 两档(只有视频有):`original` 就是 `hash`(缺 faststart 的已经重封装过,哈希是重封装后的),
   * `small` 是素材小尺寸哈希;素材小尺寸还在本机后台转时是 null、`smallState` 是 pending,由 watchSmallTier 补上。
   */
  tiers?: { original: string; small: string | null };
  /** 素材小尺寸的状态:pending / ready / failed / none(没有视频流) */
  smallState?: string;
}

/** 服务端回包里的两档字段 → UploadedMedia 的那两项 */
function tiersOf(data: { tiers?: { original?: unknown; small?: unknown }; small?: unknown }): Pick<UploadedMedia, "tiers" | "smallState"> {
  const t = data?.tiers;
  if (!t || typeof t.original !== "string") return {};
  return {
    tiers: { original: t.original, small: typeof t.small === "string" ? t.small : null },
    smallState: typeof data.small === "string" ? data.small : undefined,
  };
}

/** 把一个 File 流进本地内容库,拿回它的内容哈希。失败给 null(调用方负责提示) */
export async function uploadMediaFile(file: File): Promise<UploadedMedia | null> {
  try {
    // tiers=1:视频在服务端做 faststart 判定(缺了就同容器重封装),并在后台生成素材小尺寸(C6.6)
    const res = await fetch(`/api/media/upload/${encodeURIComponent(file.name)}?tiers=1`, { method: "POST", body: file });
    if (!res.ok) {
      console.warn(`[io] 上传素材失败(HTTP ${res.status}): ${file.name}`);
      return null;
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") {
      console.warn(`[io] 上传素材没拿到内容哈希: ${file.name}`);
      return null;
    }
    return {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || file.name),
      path: typeof data.path === "string" ? data.path : undefined,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || file.size,
      deduped: !!data.deduped,
      ...tiersOf(data),
    };
  } catch (err) {
    console.warn(`[io] 上传素材异常: ${file.name}`, err);
    return null;
  }
}

/**
 * 给一个**已经在服务端素材目录里**的文件补算内容键(素材收集下载好的那种)。
 *
 * 不上传 —— 文件本来就在服务端,几百 MB 再往回传一遍纯属浪费;服务端就地流式
 * 算 sha256 并把它挂进内容库(见 vite-plugin-media.ts 的 adoptMediaFile)。
 * 失败给 null,那条素材就按没有 hash 的迁移期素材走(仍然能按文件名播)。
 */
export async function adoptServerMedia(filePath: string): Promise<UploadedMedia | null> {
  try {
    const res = await fetch(`/api/media/adopt?path=${encodeURIComponent(filePath)}&tiers=1`, { method: "POST" });
    if (!res.ok) {
      console.warn(`[io] 补算素材哈希失败(HTTP ${res.status}): ${filePath}`);
      return null;
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") return null;
    return {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || ""),
      path: typeof data.path === "string" ? data.path : filePath,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || 0,
      deduped: !!data.deduped,
      ...tiersOf(data),
    };
  } catch (err) {
    console.warn(`[io] 补算素材哈希异常: ${filePath}`, err);
    return null;
  }
}

/**
 * 入库结果写回素材表。
 *
 * 走 `actions.updateMedia`(不进撤销栈:撤销管的是时间轴,不该把「素材传完了」这件事也收进去),
 * 拷一份新对象写回。**不许原地改** store 里那条记录:共享项目里 store 的项目就是 docsync 的
 * 本地副本,原地改过的字段 diffProject 看不出变化,hash / tiers / pending 就到不了文档服务,
 * 别的设备上这条素材永远是 pending(C6.6 T9 就是这么发现的)。
 *
 * 传失败时不退回 blob: —— 那种地址渲染进程和导出进程都打不开,留着只会在更远的
 * 地方炸(见 importAssets.ts 的说明)。素材留空地址、pending 落回 false,
 * 素材层就是透明的,用户重新导入即可。
 */
export function applyUploadedMedia(mediaId: string, up: UploadedMedia | null): void {
  const media = getState().project.media.find((m) => m.id === mediaId);
  if (!media) return;
  const patch: Partial<Omit<MediaAsset, "id">> = { pending: undefined, path: up?.path ?? media.path ?? "" };
  if (up) {
    patch.url = up.url;
    patch.hash = up.hash;
    patch.ext = up.ext || undefined;
    patch.size = up.bytes || undefined;
    // 两档(C6.6):项目里只记两个哈希,不记同步状态(传没传完只问素材服务的 chunks)
    if (up.tiers) patch.tiers = up.tiers.small ? { original: up.tiers.original, small: up.tiers.small } : { original: up.tiers.original };
  }
  actions.updateMedia(mediaId, patch);
  if (up?.tiers && !up.tiers.small && up.smallState === "pending") watchSmallTier(mediaId, up.tiers.original);
}

/** 素材小尺寸在本机后台转码,每隔这么久问一次 */
const SMALL_POLL_MS = 2000;
/** 最多问这么久 */
const SMALL_POLL_LIMIT_MS = 6 * 60 * 60 * 1000;
const watching = new Set<string>();

/**
 * 素材小尺寸好了就把它的哈希写进 `project.media[i].tiers.small`(C6.6)。问的是本机的
 * `GET /api/media/tiers?hashes=<素材原尺寸>`(本机转码的登记,不是同步状态)。素材被删了、素材原尺寸换了、
 * 转码失败或确定没有素材小尺寸就停。只在编辑器会话里跑:页面关了就不再问(素材小尺寸照样在本机生成、照样上传,
 * 只是这条素材的项目记录里没有 small,别的设备按「还没有素材小尺寸时直接拉素材原尺寸」处理)。
 */
export function watchSmallTier(mediaId: string, original: string): void {
  const key = `${mediaId}:${original}`;
  if (watching.has(key)) return;
  watching.add(key);
  const started = Date.now();
  const stop = () => { watching.delete(key); };
  const tick = async () => {
    const media = getState().project.media.find((m) => m.id === mediaId);
    if (!media || (media.tiers?.original ?? media.hash) !== original || media.tiers?.small || Date.now() - started > SMALL_POLL_LIMIT_MS) return stop();
    let state: string | null = null;
    let small: string | null = null;
    try {
      const res = await fetch(`/api/media/tiers?hashes=${original}`);
      const data = res.ok ? await res.json() : null;
      const item = data?.items?.[original];
      state = typeof item?.state === "string" ? item.state : null;
      small = typeof item?.small === "string" ? item.small : null;
    } catch { /* 下一次再问 */ }
    if (state === "ready" && small) {
      writeSmallTier(mediaId, original, small);
      return stop();
    }
    if (state && state !== "pending") return stop();
    setTimeout(() => { void tick(); }, SMALL_POLL_MS);
  };
  setTimeout(() => { void tick(); }, SMALL_POLL_MS);
}

/* ---------------- 打开项目时补转素材小尺寸(C6.6 设计稿第 9 节第 2 条) ---------------- */

/** 这一页已经问过补转的素材原尺寸哈希(同一会话里不重复问;素材小尺寸在转的由 watchSmallTier 接着盯) */
const backfillAsked = new Set<string>();

/**
 * 项目里缺 `tiers.small`、按哈希入库的视频:请编辑器进程补转(`POST /api/media/tiers/backfill`)。
 * 本地内容库里有这份素材原尺寸的才转(没有的回 `absent`,不为了转素材小尺寸去拉素材原尺寸),转好补写 `tiers.small`。
 * 页面在素材小尺寸好之前关了,下次打开再补。没有本机编辑器(在线浏览器模式)时请求失败,什么都不做。
 * 回这次问了几份。
 */
export async function backfillSmallTiers(project = getState().project): Promise<number> {
  if (isViewOnly()) return 0; // 只读页面不改项目
  const want: { mediaId: string; hash: string; name: string }[] = [];
  for (const m of project.media ?? []) {
    if (m.kind !== "video" || m.pending || m.tiers?.small) continue;
    const hash = String(m.tiers?.original ?? m.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash) || backfillAsked.has(hash)) continue;
    backfillAsked.add(hash);
    want.push({ mediaId: m.id, hash, name: m.name ?? "" });
  }
  if (!want.length) return 0;
  let items: Record<string, { state?: string; small?: string }> = {};
  try {
    const res = await fetch("/api/media/tiers/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: want.map(({ hash, name }) => ({ hash, name })) }),
    });
    if (!res.ok) { for (const w of want) backfillAsked.delete(w.hash); return 0; }
    items = (await res.json())?.items ?? {};
  } catch {
    for (const w of want) backfillAsked.delete(w.hash);
    return 0;
  }
  for (const w of want) {
    const it = items[w.hash];
    if (it?.state === "ready" && typeof it.small === "string") writeSmallTier(w.mediaId, w.hash, it.small);
    else if (it?.state === "pending") watchSmallTier(w.mediaId, w.hash);
  }
  return want.length;
}

/** 把素材小尺寸哈希写进这条素材的 `tiers`(素材原尺寸没换过才写);写法同 applyUploadedMedia 的说明 */
function writeSmallTier(mediaId: string, original: string, small: string): void {
  const fresh = getState().project.media.find((m) => m.id === mediaId);
  if (!fresh || (fresh.tiers?.original ?? fresh.hash) !== original || fresh.tiers?.small) return;
  actions.updateMedia(mediaId, { tiers: { original, small } });
}

/**
 * 打开项目(以及素材表变了)时补转素材小尺寸,回停止函数。预览挂上时调。
 * 同一份素材原尺寸一个页面会话里只问一次;素材表没变就不问。
 */
export function startTierBackfill(): () => void {
  let lastMedia: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    const media = getState().project.media;
    if (media === lastMedia) return;
    lastMedia = media;
    // 打开项目的那一阵先让路(测量、首帧),稍后再问
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void backfillSmallTiers(); }, 1500);
  };
  const unsub = subscribe(check);
  check();
  return () => { unsub(); if (timer) clearTimeout(timer); };
}

/** 单测用 */
export function resetTierBackfillForTest(): void {
  backfillAsked.clear();
}
