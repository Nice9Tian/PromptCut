import type { MediaAsset, Project } from "../kernel/project";
import { playableOnThisHost, probePlayable, shouldProbe } from "./playability";

/**
 * 「这一刻该拿哪个地址去播」—— 素材的换档判据(`docs/semantics/architecture/asset-storage.md`「两档素材」「拉取」;
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
 * (asset-storage.md「同步状态只问素材服务」);本机缓存落没落盘、项目文档里写了什么都不算数。
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

export function chooseTier(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean } = {},
): TierChoice {
  const original = originalUrl(media);
  const complete = asSet(localHashes);
  const originalHash = (media.tiers?.original || media.hash || hashFromUrl(original) || "").toLowerCase();
  const smallHash = (media.tiers?.small || "").toLowerCase();
  const smallTier = !!smallHash && smallHash !== originalHash;
  const small = smallTier ? `/@media/${smallHash}` : null;
  const pick = (tier: "small" | "original", awaiting: boolean): TierChoice => {
    const url = tier === "small" && small ? small : original;
    return { url: withBase(url, opts.cloudBase), tier: url ? tier : "none", awaiting: awaiting && !!url && !!originalHash };
  };
  // 0. 还没问过素材服务:先小后大
  if (!complete.size) return pick(small ? "small" : "original", false);
  const hasOriginal = !!originalHash && complete.has(originalHash);
  const hasSmall = smallTier && complete.has(smallHash);
  if (hasOriginal) {
    if (!hasSmall) return pick("original", false);
    const playable = (opts.playable ?? playableOnThisHost)(originalHash);
    if (playable === true) return pick("original", false);
    if (playable === undefined && opts.probe !== false && shouldProbe(originalHash)) {
      void probePlayable(originalHash, withBase(original, opts.cloudBase), media.ext, media.kind === "audio" ? "audio" : "video",
        { remote: !!opts.cloudBase || complete.has(TIERS_KNOWN_REMOTE) });
    }
    return pick("small", false);
  }
  if (hasSmall) return pick("small", false);
  return pick("original", true);
}

export function playbackUrl(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean } = {},
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

/** 「等待上传方」的提示文字(导出被拦时给用户看) */
export function awaitingUploaderMessage(missing: readonly MissingOriginal[]): string {
  const names = missing.map((m) => m.name);
  const shown = names.slice(0, 5).join("、") + (names.length > 5 ? ` 等 ${names.length} 个` : "");
  return `等待上传方:这些素材的原片还没传完,导出只用原片,传完后再导出 —— ${shown}`;
}
