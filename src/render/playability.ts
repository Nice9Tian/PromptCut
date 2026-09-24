/**
 * 「这台设备放不放得了这份原片」—— **本机缓存**(T1a 审查 #4)。
 *
 * 能不能播取决于设备(浏览器、系统解码器、硬件),同一个项目在这台机器上放得了、在 iPad 上可能放不了,
 * 所以它**不是项目级的布尔值**:不写进项目文档、不进 `.proc`,`MediaAsset` 不加字段。
 * 结果只存在这台设备这个页面源里(内存 + `localStorage`,读写失败就只留内存),按内容哈希寻址 ——
 * 内容不可变,同一个哈希在同一台设备上的结论不会变。
 *
 * 探法(`docs/plan/cloud-task.md` A1「原片可不可播」的步骤原样保留,只是结果换了存处):
 *   1. `HTMLMediaElement.canPlayType(<按扩展名拼的 MIME>)`,回 `''` 就判 `false`;
 *   2. 回 `'maybe'` / `'probably'` 时再**试放首帧**:离屏 `<video muted>` 挂原片,等到 `loadeddata`
 *      才判 `true`;`error` 或超时判 `false`。
 *   3. 探测本身没法跑(没有 DOM)时不下结论(`undefined`),调用方按「不知道」处理。
 *
 * `playbackUrl`(`mediaTier.ts`)只读这里;要不要触发一次探测由它决定(只在真有两档可选时才探,
 * 不白白去拉原片的首帧)。
 */

const STORAGE_PREFIX = "pc.playable.";
const PROBE_TIMEOUT_MS = 8000;

/** 舞台接管了 `setTimeout`(虚拟时钟,暂停时不走);超时要按真墙钟算,走 `__pcRealSetTimeout` 口子(同 mediaDrive.ts) */
const realSetTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> =>
  ((typeof window !== "undefined" && window.__pcRealSetTimeout) ? window.__pcRealSetTimeout(fn, ms) : setTimeout(fn, ms)) as ReturnType<typeof setTimeout>;

const known = new Map<string, boolean>();
const probing = new Map<string, Promise<boolean | undefined>>();

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** 这台设备上对这份内容的结论;没探过是 `undefined` */
export function playableOnThisHost(hash: string | undefined | null): boolean | undefined {
  if (!hash) return undefined;
  const key = hash.toLowerCase();
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
  const key = hash.toLowerCase();
  known.set(key, playable);
  try { storage()?.setItem(STORAGE_PREFIX + key, playable ? "1" : "0"); } catch { /* 只留内存 */ }
}

/** 单测用:清掉内存里的结论(不碰 localStorage 以外的任何东西) */
export function forgetPlayable(): void {
  known.clear();
  probing.clear();
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  avi: "video/x-msvideo", ogv: "video/ogg", mxf: "application/mxf",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/ogg",
};

/** 按扩展名拼 `canPlayType` 要的 MIME;认不出就 null(那一步跳过,直接试放) */
export function mimeForExt(ext: string | undefined | null): string | null {
  return MIME_BY_EXT[String(ext || "").toLowerCase()] ?? null;
}

/**
 * 探一次(同一个哈希同时只探一次)。`url` 是原片地址,`ext` 用来拼 MIME。
 * 没有 DOM(Node、Worker)时回 `undefined`、不记结论。
 */
export function probePlayable(hash: string, url: string, ext?: string, kind: "video" | "audio" = "video"): Promise<boolean | undefined> {
  const key = hash.toLowerCase();
  const done = playableOnThisHost(key);
  if (done !== undefined) return Promise.resolve(done);
  const running = probing.get(key);
  if (running) return running;
  const job = (async (): Promise<boolean | undefined> => {
    if (typeof document === "undefined" || !url) return undefined;
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    const mime = mimeForExt(ext);
    if (mime && el.canPlayType(mime) === "") { rememberPlayable(key, false); return false; }
    const ok = await new Promise<boolean>((resolve) => {
      // 舞台里的 clearTimeout 也是虚拟的、清不掉真计时器,所以靠这个旗标只认第一次
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.removeAttribute("src");
        try { el.load(); } catch { /* 已经卸掉 */ }
        resolve(value);
      };
      const timer = realSetTimeout(() => finish(false), PROBE_TIMEOUT_MS);
      el.muted = true;
      el.preload = "auto";
      el.addEventListener("loadeddata", () => finish(true), { once: true });
      el.addEventListener("error", () => finish(false), { once: true });
      el.src = url;
    });
    rememberPlayable(key, ok);
    return ok;
  })().finally(() => probing.delete(key));
  probing.set(key, job);
  return job;
}
