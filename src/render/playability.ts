/**
 * 「这台设备放不放得了这份原片」—— **设备本地缓存**(T1a 审查 #4;C6.6 设计稿第 4 节「可播性」、第 8 节查资料结论)。
 *
 * 能不能播取决于设备(浏览器、系统解码器、硬件),同一个项目在这台机器上放得了、在 iPad 上可能放不了,
 * 所以它**不是项目级的布尔值**:不写进项目文档、不进 `.proc`,`MediaAsset` 不加字段。
 * 结果只存在这台设备这个页面源里(内存 + `localStorage`,读写失败就只留内存)。
 *
 * **缓存键 = 原片哈希 + 浏览器主版本**:内容不可变,但浏览器升级后解码能力会变(查资料结论第 3 条),
 * 换了主版本就当没探过、重探一次。
 *
 * 探法:
 *   1. **按实际容器选 MIME** 问 `canPlayType`,回 `''` 就判 `false`(记下)。
 *      QuickTime(`.mov`)按 `video/mp4` 问:Chrome 的 `canPlayType('video/quicktime')` 恒回 `''`
 *      (Chrome 152 实测),可它用同一个 ISO BMFF 解复用器照样放 H.264 的 MOV —— 按字面 MIME 问,
 *      手机拍的 MOV 会全被判成放不了、永远停在小版。放不了的 MOV(ProRes、DNxHD)由第 2 步试放判出来。
 *   2. 否则**试放首帧**:离屏 `<video muted>` 挂原片,等到 `loadeddata`,再等 `requestVideoFrameCallback`
 *      确认真有一帧交给合成器,才判 `true`;报 `error` 判 `false`(记下)。
 *   3. **超时**(本地素材服务 5 s、远程素材服务 10 s)记「未知」:不写缓存,过 `RETRY_UNKNOWN_MS` 再探。
 *      网络慢不等于放不了,不能把它永久记成 `false`。
 *   4. 探测本身没法跑(没有 DOM)时不下结论(`undefined`),调用方按「不知道」处理。
 *
 * `playbackUrl`(`mediaTier.ts`)只读这里;要不要触发一次探测由它决定(只在真有两档可选时才探,
 * 不白白去拉原片的首帧)。探出结论时通知订阅方(`subscribePlayability`),暂停中的画面层也能当场换档。
 */

const STORAGE_PREFIX = "pc.playable.";
/** 本地素材服务上的原片:首帧 5 s 内出不来就记「未知」 */
export const PROBE_TIMEOUT_LOCAL_MS = 5000;
/** 远程素材服务上的原片(经本地读路由按需拉取,或直接打远程):10 s */
export const PROBE_TIMEOUT_REMOTE_MS = 10000;
/** 「未知」之后多久再探 */
export const RETRY_UNKNOWN_MS = 30000;

/** 舞台接管了 `setTimeout`(虚拟时钟,暂停时不走);超时要按真墙钟算,走 `__pcRealSetTimeout` 口子(同 mediaDrive.ts) */
const realSetTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> =>
  ((typeof window !== "undefined" && window.__pcRealSetTimeout) ? window.__pcRealSetTimeout(fn, ms) : setTimeout(fn, ms)) as ReturnType<typeof setTimeout>;
/** 同理,「未知」的重探时刻按真墙钟(舞台里 `Date.now` 钉在纪元上,要用 stageClock 留下的那份) */
const realNow = (): number => (typeof window !== "undefined" && window.__pcRealNow ? window.__pcRealNow() : Date.now());

let majorOverride: string | null = null;

/** 浏览器主版本(缓存键的一半)。认不出给 "0" */
export function browserMajor(): string {
  if (majorOverride !== null) return majorOverride;
  try {
    const nav = typeof navigator === "undefined" ? null : navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } };
    const brands = nav?.userAgentData?.brands ?? [];
    const hit = brands.find((b) => /chrom/i.test(b.brand)) ?? brands.find((b) => !/not.?a.?brand/i.test(b.brand));
    if (hit?.version) return String(parseInt(hit.version, 10) || 0);
    const m = /(?:Chrome|Chromium|Firefox|Version)\/(\d+)/.exec(nav?.userAgent ?? "");
    return m ? m[1] : "0";
  } catch {
    return "0";
  }
}

/** 单测用:钉住浏览器主版本(null = 按真实环境) */
export function setBrowserMajorForTest(v: string | null): void {
  majorOverride = v;
  known.clear();
}

const keyOf = (hash: string) => `${browserMajor()}:${hash.toLowerCase()}`;

const known = new Map<string, boolean>();
const probing = new Map<string, Promise<boolean | undefined>>();
/** 探成「未知」的:键 → 最早什么时候再探(真墙钟 ms) */
const retryAt = new Map<string, number>();

let version = 0;
const listeners = new Set<() => void>();
function changed() {
  version++;
  for (const l of [...listeners]) {
    try { l(); } catch { /* 订阅方自己的事 */ }
  }
}
/** 有新结论时通知(画面层用它在暂停中也当场换档) */
export function subscribePlayability(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
/** 结论的版本号,每下一个结论加一(`useSyncExternalStore` 的快照) */
export function playabilityVersion(): number {
  return version;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** 这台设备(这个浏览器主版本)上对这份内容的结论;没探过、或探成「未知」是 `undefined` */
export function playableOnThisHost(hash: string | undefined | null): boolean | undefined {
  if (!hash) return undefined;
  const key = keyOf(hash);
  if (known.has(key)) return known.get(key);
  let stored: string | null = null;
  try { stored = storage()?.getItem(STORAGE_PREFIX + key) ?? null; } catch { /* 隐私模式、被禁用 */ }
  if (stored === "1" || stored === "0") {
    known.set(key, stored === "1");
    return stored === "1";
  }
  return undefined;
}

/** 记下结论(探测结果;单测也用它预置) */
export function rememberPlayable(hash: string, playable: boolean): void {
  const key = keyOf(hash);
  known.set(key, playable);
  retryAt.delete(key);
  try { storage()?.setItem(STORAGE_PREFIX + key, playable ? "1" : "0"); } catch { /* 只留内存 */ }
  changed();
}

/** 单测用:清掉内存里的结论(不碰 localStorage 以外的任何东西) */
export function forgetPlayable(): void {
  known.clear();
  probing.clear();
  retryAt.clear();
}

/** 这个哈希眼下该不该探:没有结论、没在探、也不在「未知」的冷却里 */
export function shouldProbe(hash: string): boolean {
  const key = keyOf(hash);
  if (playableOnThisHost(hash) !== undefined || probing.has(key)) return false;
  const at = retryAt.get(key);
  return at === undefined || realNow() >= at;
}

/**
 * 按**实际容器**问 `canPlayType` 用的 MIME(`ext` 是入库时记下的容器扩展名)。
 * `mov` 按 `video/mp4` 问,理由见文件头第 1 步。认不出就 null(那一步跳过,直接试放)。
 */
const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
  avi: "video/x-msvideo", ogv: "video/ogg", mxf: "application/mxf",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/ogg",
};

export function mimeForExt(ext: string | undefined | null): string | null {
  return MIME_BY_EXT[String(ext || "").toLowerCase()] ?? null;
}

export interface ProbeOptions {
  /** 原片在远程素材服务上(超时 10 s);缺省按本地(5 s) */
  remote?: boolean;
  /** 直接指定超时(单测) */
  timeoutMs?: number;
}

/**
 * 探一次(同一个哈希同时只探一次)。`url` 是原片地址,`ext` 用来拼 MIME。
 * 回 `true` / `false`(已记进缓存),或 `undefined`(没有 DOM、超时:不记,稍后重探)。
 */
export function probePlayable(hash: string, url: string, ext?: string, kind: "video" | "audio" = "video", opts: ProbeOptions = {}): Promise<boolean | undefined> {
  const key = keyOf(hash);
  const done = playableOnThisHost(hash);
  if (done !== undefined) return Promise.resolve(done);
  const running = probing.get(key);
  if (running) return running;
  const job = (async (): Promise<boolean | undefined> => {
    if (typeof document === "undefined" || !url) return undefined;
    const isVideo = kind !== "audio";
    const el = document.createElement(isVideo ? "video" : "audio") as HTMLVideoElement;
    const mime = mimeForExt(ext);
    if (mime && el.canPlayType(mime) === "") { rememberPlayable(hash, false); return false; }
    const timeoutMs = opts.timeoutMs ?? (opts.remote ? PROBE_TIMEOUT_REMOTE_MS : PROBE_TIMEOUT_LOCAL_MS);
    const verdict = await new Promise<boolean | undefined>((resolve) => {
      // 舞台里的 clearTimeout 也是虚拟的、清不掉真计时器,所以靠这个旗标只认第一次
      let settled = false;
      const finish = (value: boolean | undefined) => {
        if (settled) return;
        settled = true;
        el.removeAttribute("src");
        try { el.load(); } catch { /* 已经卸掉 */ }
        el.remove();
        resolve(value);
      };
      realSetTimeout(() => finish(undefined), timeoutMs);
      el.muted = true;
      el.preload = "auto";
      el.setAttribute("aria-hidden", "true");
      if (isVideo) {
        el.playsInline = true;
        // 挂进文档才会有帧交给合成器(帧回调才会来);几乎看不见、不挡点击
        el.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
        (document.body ?? document.documentElement).appendChild(el);
      }
      el.addEventListener("error", () => finish(false), { once: true });
      el.addEventListener("loadeddata", () => {
        if (!isVideo) return finish(true);
        if (!el.videoWidth) return finish(false);
        if (typeof el.requestVideoFrameCallback !== "function") return finish(true);
        el.requestVideoFrameCallback(() => finish(true));
        // 暂停着的元素首帧未必会再交一次:轻推一下,让它出一帧
        try { el.currentTime = Math.min(0.001, el.duration || 0); } catch { /* 不让 seek 就等超时 */ }
      }, { once: true });
      el.src = url;
    });
    if (verdict === undefined) {
      retryAt.set(key, realNow() + RETRY_UNKNOWN_MS);
      return undefined;
    }
    rememberPlayable(hash, verdict);
    return verdict;
  })().finally(() => probing.delete(key));
  probing.set(key, job);
  return job;
}
