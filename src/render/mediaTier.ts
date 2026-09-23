import type { MediaAsset } from "../kernel/project";
import { playableOnThisHost, probePlayable } from "./playability";

/**
 * 「这一刻该拿哪个地址去播」—— 素材的换档判据(`docs/semantics/architecture/asset-storage.md`「两档素材」「拉取」)。
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
 *
 *   1. 集合为空 → 原片(`media.url`)。今天还没有集合的来源(第 6 步主文档每 2 秒轮询
 *      `GET media/<hash>/chunks`),所以今天的行为和改之前一样:每条路都拿 `media.url`。
 *   2. 原片在集合里 → 原片;但**这台设备放不了原片**(本机缓存 `playability.ts`,#4)且小版也在集合里时 → 小版。
 *   3. 原片不在、小版在 → 小版(先小后大)。
 *   4. 两档都不在 → 原片(#3:「还没有小版时直接拉原片」;哪一档都没传完时也只能给原片)。
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
export function playbackUrl(
  media: Pick<MediaAsset, "url" | "hash" | "tiers"> & Partial<Pick<MediaAsset, "ext" | "kind">>,
  localHashes: ReadonlySet<string> | readonly string[] = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean } = {},
): string {
  const original = originalUrl(media);
  const complete = localHashes instanceof Set ? localHashes as ReadonlySet<string> : new Set(localHashes as readonly string[]);
  if (!complete.size) return withBase(original, opts.cloudBase);
  const originalHash = (media.tiers?.original || media.hash || hashFromUrl(original) || "").toLowerCase();
  const smallHash = (media.tiers?.small || "").toLowerCase();
  const hasOriginal = !!originalHash && complete.has(originalHash);
  const hasSmall = !!smallHash && smallHash !== originalHash && complete.has(smallHash);
  const small = hasSmall ? `/@media/${smallHash}` : null;
  if (hasOriginal) {
    if (!small) return withBase(original, opts.cloudBase);
    const playable = (opts.playable ?? playableOnThisHost)(originalHash);
    if (playable === true) return withBase(original, opts.cloudBase);
    if (playable === undefined && opts.probe !== false) {
      void probePlayable(originalHash, withBase(original, opts.cloudBase), media.ext, media.kind === "audio" ? "audio" : "video");
    }
    return withBase(small, opts.cloudBase);
  }
  return withBase(small ?? original, opts.cloudBase);
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
