/**
 * 在线普通档的两个舞台(C10 契约 `docs/plan/c10-contract.md` 第 2 节;语义 `mechanism/rendering.md`「舞台」:舞台有两个)。
 *
 * - **舞台源**:两个舞台 A、B 各用一个源,与编辑器页同站跨源,三方的响应都带 `Origin-Agent-Cluster: ?1`(nginx 或本机代理加)。
 *   页面从运行配置 `/editor/runtime-config.json` 取舞台源(`scripts/remote/docservice.mjs deploy-hosted --stage-origins` 写进去):
 *
 *       { "v": 1, "stageOrigins": ["https://s1.<主机>", "https://s2.<主机>"] }
 *
 * - **退回**:读不到配置、配置不对、或舞台握手失败,退回 C10a 的同源单舞台 —— 不许开不出画面(`dualStage()` 的兜底原则)。
 * - **低内存档**:仍是单舞台,不开后台舞台(C10a)。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor;不读 `import.meta.env`(调用方把 `base` 传进来)。
 */

export type StageLetter = "A" | "B";
export type StageOrigins = Record<StageLetter, string>;
/**
 * 首次握手的进度。`interim`:可见舞台 A 挂上 20 秒还没握上手,先按同源单舞台出画面,同时在隐藏的 iframe 里预热两个舞台源;
 * 两台都加载完、握上手就换回双舞台(`ok`,只换一次),总上限到点还没好就 `failed`(`stageHandshake.ts`)。
 */
export type Handshake = "pending" | "interim" | "ok" | "failed";
export type StageLayout = "dual" | "single";

/** 运行配置的文件名(相对在线构建的 base,即 `/editor/`) */
export const RUNTIME_CONFIG_FILE = "runtime-config.json";
/** 取运行配置的时限 */
export const RUNTIME_CONFIG_TIMEOUT_MS = 5000;
/** 每个舞台从自己 iframe 的 `load` 起等握手的时限;过了算握手失败,退回同源单舞台(计时与总上限见 `stageHandshake.ts`) */
export const STAGE_HANDSHAKE_TIMEOUT_MS = 20_000;

/** 一个源:`http(s)://host[:port]`,不带路径、查询与片段 */
function originOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v.trim().replace(/\/+$/, "");
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
    return u.origin === text ? text : null;
  } catch {
    return null;
  }
}

/**
 * 运行配置 → 两个舞台源。收解析后的对象或 JSON 文本;`stageOrigins` 要是两个不同的合法源(数组,或 `{ A, B }`)。
 * 读不到或不合法回 null,不抛。
 */
export function parseStageOrigins(config: unknown): StageOrigins | null {
  let c: unknown = config;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { return null; }
  }
  if (!c || typeof c !== "object") return null;
  const raw = (c as { stageOrigins?: unknown }).stageOrigins;
  let a: unknown, b: unknown;
  if (Array.isArray(raw)) {
    if (raw.length !== 2) return null;
    [a, b] = raw;
  } else if (raw && typeof raw === "object") {
    a = (raw as { A?: unknown }).A;
    b = (raw as { B?: unknown }).B;
  } else {
    return null;
  }
  const A = originOf(a), B = originOf(b);
  if (!A || !B || A === B) return null;
  return { A, B };
}

/**
 * 开几个舞台:低内存档单舞台;没有舞台源(读不到配置)单舞台;握手失败单舞台;其余双舞台(握手进行中也按双舞台挂 iframe)。
 * `pageOrigin` 给了时,舞台源不能与编辑器页同源(那就不是跨源隔离,按读不到处理)。
 */
export function stageLayout({ lowMemory, origins, handshake, pageOrigin }: { lowMemory: boolean; origins: StageOrigins | null; handshake?: Handshake; pageOrigin?: string }): StageLayout {
  if (lowMemory) return "single";
  if (!origins) return "single";
  if (pageOrigin && (origins.A === pageOrigin || origins.B === pageOrigin)) return "single";
  if (handshake === "failed" || handshake === "interim") return "single";
  return "dual";
}

/**
 * 素材服务的基址交给跨源舞台时换成相对地址:舞台一律读**自己源上**反代的 `/media`(C10 契约第 2 节「舞台读素材」:
 * 同源读、不靠 CORS,媒体画进 canvas 不污染)。基址与编辑器页同源时回路径部分;不同源(素材服务在别的主机上)原样。
 */
export function stageAssetBase(base: string, pageOrigin: string): string {
  try {
    const u = new URL(base);
    if (u.origin !== pageOrigin) return base;
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ 本页的状态 */

interface State {
  /** 运行配置:还没取 / 在取 / 取完(可能没有舞台源) */
  config: "idle" | "loading" | "done";
  origins: StageOrigins | null;
  handshake: Handshake;
  /** 握手失败时的原因(诊断) */
  reason: string | null;
  /** 什么时候进的 `interim`(`Date.now()`);没进过为 null。换回双舞台之后仍留着(Preview 据此做换回那一下的画面衔接) */
  interimAt: number | null;
}

let state: State = { config: "idle", origins: null, handshake: "pending", reason: null, interimAt: null };
const listeners = new Set<() => void>();
let loading: Promise<StageOrigins | null> | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
}

export function onlineStageState(): Readonly<State> {
  return state;
}

export function subscribeOnlineStages(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 取运行配置(页面载入时调一次;`base` 是在线构建的 base,缺省 `/editor/`)。取不到、超时、不合法都当没有舞台源。
 */
export function loadStageConfig({ base = "/editor/", fetchImpl, timeoutMs = RUNTIME_CONFIG_TIMEOUT_MS }: { base?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<StageOrigins | null> {
  if (loading) return loading;
  set({ config: "loading" });
  const f = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  loading = (async () => {
    if (!f) return null;
    const url = `${base.replace(/\/?$/, "/")}${RUNTIME_CONFIG_FILE}`;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
      const res = await f(url, { cache: "no-store", signal: ctrl?.signal });
      if (!res.ok) return null;
      return parseStageOrigins(await res.text());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().then((origins) => {
    set({ config: "done", origins });
    return origins;
  });
  return loading;
}

/**
 * 舞台握手的结果(Preview 报):失败就退回同源单舞台,本页会话内不再试。
 * `interim` 只能从 `pending` 进(换回双舞台之后再出问题不回 `interim`,照看守走 `failed`,不来回切)。
 */
export function markStageHandshake(result: Exclude<Handshake, "pending">, reason: string | null = null): void {
  if (state.handshake === result) return;
  if (state.handshake === "failed") return;
  if (result === "interim") {
    if (state.handshake !== "pending") return;
    set({ handshake: result, reason, interimAt: Date.now() });
    return;
  }
  set({ handshake: result, reason: result === "ok" ? null : reason });
}

/** 测试用 */
export function resetOnlineStagesForTest(next: Partial<State> = {}): void {
  loading = null;
  state = { config: "idle", origins: null, handshake: "pending", reason: null, interimAt: null, ...next };
  listeners.clear();
}
