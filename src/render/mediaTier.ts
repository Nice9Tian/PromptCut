import type { MediaAsset, Project } from "../kernel/project";
import { playableOnThisHost, probePlayable, shouldProbe } from "./playability";

/**
 * 「这一刻该拿哪个地址去播」—— 素材的换档判据(`docs/semantics/product/asset-service.md`「两档素材」「拉取」;
 * `docs/plan/c66-design.md` 第 4 节)。
 *
 * 放在 src/render/ 而不是 src/editor/ 是因为舞台 bundle(预览 / 预渲染 / 导出页)
 * 也要 import 它 —— 舞台够不着编辑器那一侧的任何模块。
 *
 * # 谁用它(T1a 审查 #5)
 *
 * 只有**实时播放**的几条路:舞台里的 `VideoTrack`(视频槽位和图片层)、`FrameScene` live 路的像素映射
 * 素材(`PixelMappedMedia`)、编辑器主文档的声音层(`MediaLayers` 的 `AudioLayer`)。
 * 导出、预渲染、`see_frames`、`FrameScene` 的 placeholder 路**一律用 `media.url`(原片)**,不经这里 ——
 * 导出和像素级检查只用原片。
 *
 * # 规则
 *
 * `localHashes`(标识符沿用)= **当前连接的素材服务报 `complete` 的哈希集合**,判据只看它
 * (mechanism/asset-service.md「同步状态只问素材服务」);本机缓存落没落盘、项目文档里写了什么都不算数。
 * 集合由主文档每 2 秒轮询 `GET media/<hash>/chunks` 得到(`src/editor/media/assetTiers.ts`),
 * 轮询回过一次之后集合里一定带一个**标记**(`TIERS_KNOWN_LOCAL` / `TIERS_KNOWN_REMOTE`),
 * 所以「问过了、一个都没到齐」和「还没问过」分得开。
 *
 *   0. 集合为空(还没问过)→ 有小版给小版,没有给原片:打开项目的第一帧不直接拉原片(A1「先小后大」)。
 *   1. 原片在集合里 → 原片;但**这台设备放不了原片**(本机缓存 `playability.ts`)且小版也在集合里时 → 小版。
 *   2. 原片不在、小版在 → 小版(先小后大)。
 *   3. 两档都不在 → 原片(「还没有小版时直接拉原片」;哪一档都没传完时也只能给原片,那一层等待上传方)。
 *
 * 原片和小版都在、可播性还不知道时:先给小版,顺手在后台探一次;探出来能放,下一次渲染就换回原片
 * (「先拉小版显示,再拉原片替换它」)。只有真有两档可选时才探 —— 不白白去拉原片的首帧。
 *
 * 地址里不带扩展名 —— 哈希就是身份,Content-Type 由服务端按入库时记下的扩展名给
 * (server/vite-plugin-media.ts 的 resolveHashFile / contentTypeForExt)。
 *
 * `opts.cloudBase`:给了就把 `/@media/...` 换成绝对地址(在线浏览器模式直接打远程素材服务)。
 * `opts.playable`:可播性从哪读,缺省读本机缓存(单测注入)。
 */

/** 轮询回过、当前连的是本地素材服务 */
export const TIERS_KNOWN_LOCAL = "@known:local";
/** 轮询回过、当前连的是远程素材服务(可播性探测按远端超时) */
export const TIERS_KNOWN_REMOTE = "@known:remote";

type TierMedia = Pick<MediaAsset, "url" | "hash" | "tiers"> & Partial<Pick<MediaAsset, "ext" | "kind">>;
type HashList = ReadonlySet<string> | readonly string[];

export interface TierChoice {
  /** 该挂的地址 */
  url: string;
  /** 挂的是哪一档 */
  tier: "small" | "original" | "none";
  /** 轮询回过、而挂的这一档在当前素材服务上还没到齐:这一层在等上传方 */
  awaiting: boolean;
}

function asSet(list: HashList): ReadonlySet<string> {
  return list instanceof Set ? list as ReadonlySet<string> : new Set(list as readonly string[]);
}

/* ------------------------------------------------------------------ *
 * 低内存档与在线浏览器模式(`docs/plan/c10a-contract.md` 第 8 节)
 * ------------------------------------------------------------------ */

/**
 * 这一侧(主文档或舞台,各自一份)的取档策略。缺省 = 桌面运行环境,和 C6.6 一字不差。
 *
 * - `lowMemory`:低内存档。**素材只拉小尺寸**:有小尺寸就恒给小尺寸(轮询回过、它还没到齐时这一层等待上传方,
 *   不去拉);没有小尺寸的素材这一层显示「等待上传方」角标与占位,**不拉原尺寸**(导出除外,导出不经这里)。
 * - `remote`:在线浏览器模式下没有本机编辑器进程代理 `/@media/*`,按哈希寻址的地址换成远程素材服务的
 *   `GET <base>/media/<hash>?t=<只读票据>`(`server/asset-service.ts`「凭票据读写」:查询串只认 `r` 票据)。
 *   `<video>` / `<img>` 带不了 `Authorization` 头,所以票据走查询串。
 *
 * 舞台是另一个文档,它那一份由父页经 RPC `setMediaPolicy` 下发(`stageRpc.ts`)。
 */
export interface MediaTierPolicy {
  lowMemory: boolean;
  /** 在线页面在远程地址就绪前不得请求本机的 /@media 路由 */
  online: boolean;
  remote: { base: string; ticket: string | null } | null;
}
// Vite 的在线构建按完整属性名替换常量；Node 单测里 import.meta.env 不存在。
let policy: MediaTierPolicy = { lowMemory: false, online: typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1", remote: null };

export function setMediaTierPolicy(next: Partial<MediaTierPolicy>): void {
  const remote = next.remote === undefined ? policy.remote
    : next.remote && next.remote.base ? { base: next.remote.base.replace(/\/+$/, ""), ticket: next.remote.ticket || null } : null;
  policy = { lowMemory: next.lowMemory ?? policy.lowMemory, online: next.online ?? policy.online, remote };
}

export function mediaTierPolicy(): MediaTierPolicy {
  return policy;
}

const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg|tiff?|heic)$/i;
/** 按 C6.6 设计本来就没有素材小尺寸这一档的素材:图片、音频 */
function noSmallTierByDesign(media: TierMedia): boolean {
  if (media.kind === "audio" || media.kind === "image") return true;
  const ext = String(media.ext || "").replace(/^\./, "");
  return IMAGE_EXT.test(ext);
}

/** 按哈希寻址的地址(`/@media/<hash>`)换成远程素材服务的取回地址;别的地址原样 */
export function remoteMediaUrl(url: string, remote: MediaTierPolicy["remote"] = policy.remote): string {
  if (!remote || !url) return url;
  const hash = hashFromUrl(url);
  if (!hash) return url;
  const q = remote.ticket ? `?t=${encodeURIComponent(remote.ticket)}` : "";
  return `${remote.base}/media/${hash}${q}`;
}

export function chooseTier(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean; lowMemory?: boolean; online?: boolean; remote?: MediaTierPolicy["remote"] } = {},
): TierChoice {
  const original = originalUrl(media);
  const complete = asSet(localHashes);
  const originalHash = (media.tiers?.original || media.hash || hashFromUrl(original) || "").toLowerCase();
  const smallHash = (media.tiers?.small || "").toLowerCase();
  const smallTier = !!smallHash && smallHash !== originalHash;
  const small = smallTier ? `/@media/${smallHash}` : null;
  const remote = opts.remote !== undefined ? opts.remote : policy.remote;
  const pick = (tier: "small" | "original", awaiting: boolean): TierChoice => {
    const url = tier === "small" && small ? small : original;
    if ((opts.online ?? policy.online) && !remote && hashFromUrl(url)) return { url: "", tier: "none", awaiting: true };
    return { url: remoteMediaUrl(withBase(url, opts.cloudBase), remote), tier: url ? tier : "none", awaiting: awaiting && !!url && !!originalHash };
  };
  /*
   * 低内存档:素材只拉小尺寸(c10a 第 8 节)。按哈希寻址、而没有小尺寸这一档的素材一律不给地址、等待上传方;
   * 有小尺寸:还没问过素材服务就先给它(先小后大的「小」),问过了而它没到齐就等,不回退到原尺寸。
   * 迁移期没有哈希的老素材不经素材服务,原样给(它们本来就只有一份)。
   */
  if (opts.lowMemory ?? policy.lowMemory) {
    if (!originalHash) return pick("original", false);
    /*
     * 图片、音频按 C6.6 设计不生成素材小尺寸(`c66-design.md`「只对视频做」)。照字面「没有小尺寸就等待上传方」
     * 它们会永远等下去,所以只对视频执行「只拉小尺寸」,图片、音频照常给原尺寸〔偏离,见报告〕。
     */
    if (!smallTier && noSmallTierByDesign(media)) return pick("original", false);
    if (!small) return { url: "", tier: "none", awaiting: true };
    if (!complete.size || complete.has(smallHash)) return pick("small", false);
    return { url: "", tier: "none", awaiting: true };
  }
  // 0. 还没问过素材服务:先小后大
  if (!complete.size) return pick(small ? "small" : "original", false);
  const hasOriginal = !!originalHash && complete.has(originalHash);
  const hasSmall = smallTier && complete.has(smallHash);
  if (hasOriginal) {
    if (!hasSmall) return pick("original", false);
    const playable = (opts.playable ?? playableOnThisHost)(originalHash);
    if (playable === true) return pick("original", false);
    // The playability probe is itself a fetch. Wait for the hosted asset address
    // just as the visible media element does.
    if (playable === undefined && opts.probe !== false && shouldProbe(originalHash)
      && !((opts.online ?? policy.online) && !remote && hashFromUrl(original))) {
      void probePlayable(originalHash, remoteMediaUrl(withBase(original, opts.cloudBase), remote), media.ext, media.kind === "audio" ? "audio" : "video",
        { remote: !!opts.cloudBase || !!remote || complete.has(TIERS_KNOWN_REMOTE) });
    }
    return pick("small", false);
  }
  if (hasSmall) return pick("small", false);
  return pick("original", true);
}

export function playbackUrl(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean; lowMemory?: boolean; online?: boolean; remote?: MediaTierPolicy["remote"] } = {},
): string {
  return chooseTier(media, localHashes, opts).url;
}

/** 原片的地址:`media.url` 就是身份(`/@media/<original 哈希>`);没有 url 但有哈希的才拼一个 */
function originalUrl(media: Pick<MediaAsset, "url" | "hash">): string {
  if (media.url) return media.url;
  return media.hash ? `/@media/${media.hash}` : "";
}

function withBase(url: string, base?: string): string {
  if (!base || !url.startsWith("/@media/")) return url;
  return base.replace(/\/+$/, "") + url;
}

/** 地址里的素材哈希(/@media/<hash> 或 /@media/<hash>.<ext>),不是哈希地址就给 null */
export function hashFromUrl(url: string): string | null {
  const m = /^\/@media\/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/i.exec(String(url || "").split(/[?#]/, 1)[0]);
  return m ? m[1].toLowerCase() : null;
}

/** 素材的原片哈希(按哈希寻址的才有;迁移期按文件名存的给 null) */
export function originalHashOf(media: Pick<MediaAsset, "url" | "hash" | "tiers">): string | null {
  const h = (media.tiers?.original || media.hash || hashFromUrl(media.url) || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** 素材的小版哈希(没有小版、或小版就是原片时给 null) */
export function smallHashOf(media: Pick<MediaAsset, "url" | "hash" | "tiers">): string | null {
  const s = (media.tiers?.small || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) && s !== originalHashOf(media) ? s : null;
}

/* ------------------------------------------------------------------ *
 * 预取顺序与导出拦截(C6.6 第 4 节)
 * ------------------------------------------------------------------ */

/** 按片段在时间轴上的先后排素材 id;时间轴上没用到的素材排在最后(按素材表的顺序) */
function mediaInTimelineOrder(project: Pick<Project, "tracks" | "media">): MediaAsset[] {
  const firstUse = new Map<string, number>();
  for (const tr of project.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      if (!c.mediaId) continue;
      const at = Number.isFinite(c.start) ? c.start : 0;
      const had = firstUse.get(c.mediaId);
      if (had === undefined || at < had) firstUse.set(c.mediaId, at);
    }
  }
  const index = new Map((project.media ?? []).map((m, i) => [m.id, i]));
  return [...(project.media ?? [])].sort((a, b) => {
    const ua = firstUse.get(a.id), ub = firstUse.get(b.id);
    if (ua !== undefined && ub !== undefined) return ua - ub || (index.get(a.id)! - index.get(b.id)!);
    if (ua !== undefined) return -1;
    if (ub !== undefined) return 1;
    return index.get(a.id)! - index.get(b.id)!;
  });
}

export interface PrefetchItem {
  hash: string;
  tier: "small" | "original";
  mediaId: string;
}

/**
 * 打开项目后的预取队列(A1「预取队列」):项目引用到的每个哈希,**先全部小版、再全部原片**,
 * 每一档内按片段在时间轴上的先后。同一个哈希只出现一次。只收按哈希寻址的素材。
 */
export function prefetchOrder(project: Pick<Project, "tracks" | "media">): PrefetchItem[] {
  const ordered = mediaInTimelineOrder(project);
  const seen = new Set<string>();
  const out: PrefetchItem[] = [];
  const add = (hash: string | null, tier: PrefetchItem["tier"], mediaId: string) => {
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, tier, mediaId });
  };
  for (const m of ordered) add(smallHashOf(m), "small", m.id);
  for (const m of ordered) add(originalHashOf(m), "original", m.id);
  return out;
}

export interface MissingOriginal {
  mediaId: string;
  name: string;
  hash: string;
}

/**
 * 导出前的拦截(A1「导出只用原片」):时间轴上用到的、按哈希寻址的素材里,原片在当前素材服务上
 * 还没 `complete` 的那些。`complete` 是当前素材服务报齐了的哈希集合。
 * 空数组 = 可以导出。迁移期没有哈希的素材不在这里拦(它们不经素材服务)。
 */
export function missingOriginals(project: Pick<Project, "tracks" | "media">, complete: HashList): MissingOriginal[] {
  const have = asSet(complete);
  const used = new Set<string>();
  for (const tr of project.tracks ?? []) for (const c of tr.clips ?? []) if (c.mediaId) used.add(c.mediaId);
  const out: MissingOriginal[] = [];
  const seen = new Set<string>();
  for (const m of mediaInTimelineOrder(project)) {
    if (!used.has(m.id)) continue;
    const h = originalHashOf(m);
    if (!h || have.has(h) || seen.has(h)) continue;
    seen.add(h);
    out.push({ mediaId: m.id, name: m.name || h.slice(0, 12), hash: h });
  }
  return out;
}

export interface ExportGateResult {
  ok: boolean;
  /** 拦下时是 `awaiting-uploader` */
  code?: "awaiting-uploader";
  message?: string;
  missing: MissingOriginal[];
}

/**
 * 导出前的拦截,按「问一个哈希」的形状:`has(hash)` 回这份素材原尺寸在**当前素材服务**上 `complete` 没有
 * (问不到按没有算)。只问被片段引用、带哈希的素材的原尺寸,不问小尺寸。
 * 页面(`src/editor/media/assetTiers.ts`)与预渲染进程的 `/api/export`(`server/export-originals.ts`)共用这一条判据。
 */
export async function checkExportOriginals(
  { project, has }: { project: Pick<Project, "tracks" | "media">; has: (hash: string) => boolean | Promise<boolean> },
): Promise<ExportGateResult> {
  const complete: string[] = [];
  for (const m of missingOriginals(project, [])) {
    try { if (await has(m.hash)) complete.push(m.hash); } catch { /* 问不到按没到齐算 */ }
  }
  const missing = missingOriginals(project, complete);
  if (!missing.length) return { ok: true, missing: [] };
  return { ok: false, code: "awaiting-uploader", message: awaitingUploaderMessage(missing), missing };
}

/** 「等待上传方」的提示文字(导出被拦时给用户看) */
export function awaitingUploaderMessage(missing: readonly MissingOriginal[]): string {
  const names = missing.map((m) => m.name);
  const shown = names.slice(0, 5).join("、") + (names.length > 5 ? ` 等 ${names.length} 个` : "");
  // 用词照 glossary.md「素材原尺寸、素材小尺寸」(取代旧词「原片」「小版」);界面上的字用新词,代码注释暂未统一
  return `等待上传方:这些素材的原尺寸还没传完,导出只用素材原尺寸,传完后再导出 —— ${shown}`;
}
