/**
 * 本机采集代下在页面这一侧(0.7.18,工具包 C1;服务端是 `server/agent/service/collect-bridge.mjs`)。没有 React、没有 store,Node 单测直接用。
 *
 * 云端 Agent 的 `collect_download` 遇到要登录的站点、而发起人本人在线时,经**这个对话的事件流**(账号模式的反向通道,
 * 与 `pageRequests.ts` 的 `createAccountPageRequests` 同一份协议:`page.request { v: 2, id, nonce, runId, pageId, tool, args, timeoutMs }`)
 * 请这张页面代为下载。页面用本机同一套采集(`/api/collect/*`,带本机存着的登录态)下载,下载完把文件**直接**传进这个项目的素材服务
 * (账号会话签发的素材票据、本机的上传队列),云端只拿到一份回执。
 *
 * 五种请求:
 *   - `collect_delegate_start { delegationId, jobId, projectId, url, site, quality, … }`:能接就开始本机下载,回 `{ accepted: true }`;
 *     不能接回 `{ accepted: false, code }`(`not-logged-in`、`local-not-ready`、`local-busy`、`wrong-project`);
 *     这张页面没有本机采集(网页版)回 `ok: false, code: "unsupported"`——不假装能代下;
 *   - `collect_delegate_poll { delegationId }`:回 `running`(阶段与进度)、`error`(只有代号)或 `done` 加回执
 *     `{ requestId, jobId, assetRef: { projectId, hash, size }, result: { items, cookiesUsed } }`;
 *   - `collect_delegate_cancel { delegationId }`:停掉本机的那个下载;
 *   - `collect_login { site, method, force }`:打开本机现成的登录窗口,只回开没开、是不是已经登录;
 *   - `collect_login_check { site, hide }`:查本机的登录态,只回登没登、是不是过期了。
 *
 * 页面这一侧守的:
 *   1. 入口只有事件流那一处(与 `pageRequests.ts` 相同:不挂全局、不听 `postMessage`、不听自定义事件);
 *   2. 请求里的页面号必须就是这张页面此刻的在场页面号,版本号是 2,带一次性随机数;对不上的不执行也不答;
 *      同一个请求号重复到达只执行一次,再到时回第一次的答案;
 *   3. **交回的东西里没有 cookie、请求头、浏览器用户数据目录、本机路径、站点的用户标识**:答案由本文件逐字段拼出来,
 *      本机接口回的别的字段(`path`、`userId`、`message`、`stderrTail`……)一样都不带;没做成只回代号;
 *      文件名只取最后一段;登录态文件的路径只在本机的两个接口之间传(查到的那一份交给本机的下载),不出这台电脑;
 *   4. 本机下载好的文件不由这张页面登记进项目:登记由云端核实之后经文档服务做,所有成员(包括本人)照常同步看到。
 */
import type { CloudEvent } from "./types.ts";

/** 页面肯执行的采集请求。与服务端 `collect-bridge.mjs` 的 `COLLECT_PAGE_TOOLS` 对账(单测 C1-PAGE-05) */
export const COLLECT_PAGE_REQUEST_TOOLS = Object.freeze([
  "collect_delegate_start", "collect_delegate_poll", "collect_delegate_cancel", "collect_login", "collect_login_check",
] as const);
export type CollectPageRequestTool = (typeof COLLECT_PAGE_REQUEST_TOOLS)[number];
export const COLLECT_PAGE_REQUEST_VERSION = 2;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PRESENCE_PAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DELEGATION_ID_RE = /^cd-[0-9a-f]{24}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const QUALITIES = [2160, 1440, 1080, 720, 480, 360];
const STAGES = ["starting", "video", "audio", "merge", "transcode", "ingest", "upload", "done"];
const VIDEO_EXT = ["mp4", "mkv", "webm", "mov", "m4v", "flv", "avi", "ts"];
const AUDIO_EXT = ["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "avif"];

/** 本机下载作业里页面用得到的那几样(本机接口回的别的字段不读) */
export interface LocalCollectJob {
  status: "running" | "done" | "error";
  stage?: string;
  percent?: number;
  cookiesUsed?: boolean;
  items?: Array<{
    filename?: string; hash?: string; bytes?: number; title?: string;
    duration?: number; width?: number; height?: number; vcodec?: string;
  }>;
}

/** 本机采集(桌面版才有;接线的一侧用 `src/ai/collect.ts` 的同一组接口给)。纯网页的环境不给 */
export interface CollectBridgeLocal {
  status(): Promise<{ ready: boolean }>;
  /** 各站点存盘的登录态;`path` 只在本机用(交给本机的下载),不出这台电脑 */
  cookies(): Promise<Record<string, { loggedIn: boolean; path?: string | null }>>;
  download(url: string, opts: { site?: string; quality: number; audioOnly?: boolean; allParts?: boolean; keepCodec?: boolean; cookies?: string }): Promise<{ jobId: string }>;
  /** 没有这个作业(本机的编辑器进程重启过)回 null */
  job(jobId: string): Promise<LocalCollectJob | null>;
  cancel(jobId: string): Promise<void>;
  /** 打开本机现成的登录窗口(桌面版的「站点登录」弹窗或站点登录页);已经登录且没过期时不弹 */
  login(args: { site: string; method: "qr" | "browser"; force?: boolean }): Promise<{ ok?: boolean; alreadyLoggedIn?: boolean }>;
  loginCheck(args: { site: string; hide?: boolean }): Promise<{ ok?: boolean; loggedIn?: boolean; expired?: boolean }>;
}

/** 把本机内容库里的文件传进当前账号项目的素材服务(账号会话签发的素材票据、本机的上传队列) */
export interface CollectBridgeUpload {
  /** 这张页面此刻开着的账号项目;没有是 null */
  projectId(): string | null;
  /** 按哈希交给上传队列;本机内容库里没有、或没有上传目标时回 false */
  push(items: { hash: string; name: string }[]): Promise<boolean>;
  /** 这份字节在这个项目的素材服务里是不是已经齐了 */
  stored(hash: string): Promise<boolean>;
}

export interface CollectPageAnswer {
  v: 2;
  id: string;
  nonce: string;
  pageId: string;
  runId?: string;
  ok: boolean;
  result?: unknown;
  code?: string;
}

export interface CollectReceipt {
  requestId: string;
  jobId: string;
  assetRef: { projectId: string; hash: string; size: number };
  result: {
    items: Array<{
      assetRef: { projectId: string; hash: string; size: number };
      name: string; kind: "video" | "audio" | "image"; title?: string;
      duration?: number; width?: number; height?: number; vcodec?: string;
    }>;
    cookiesUsed: boolean;
  };
}

type Delegation = {
  id: string; jobId: string; projectId: string; localJobId: string | null;
  phase: "running" | "done" | "error";
  stage: string; percent: number; code: string | null; receipt: CollectReceipt | null; cancelled: boolean;
};

export interface CollectBridgePageDeps {
  /** 这张页面此刻的在场页面号(每次现取;没连上文档服务时是 null,那时什么都不执行) */
  pageId: () => string | null;
  /** 本机采集;网页版不给 */
  local?: CollectBridgeLocal | null;
  /** 上传进账号项目的素材服务;没有本机编辑器进程时不给 */
  upload?: CollectBridgeUpload | null;
  pollMs?: number;
  /** 本机下载最多等多久 */
  downloadMs?: number;
  /** 下载好之后等上传多久 */
  uploadMs?: number;
  remember?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const baseName = (value: unknown): string => {
  const text = typeof value === "string" ? value : "";
  const last = text.split(/[\\/]/).pop() ?? "";
  // 盘符冒号、控制字符一并去掉:交回去的只是一段名字
  return last.replace(/[:\u0000-\u001f]/g, "_").slice(0, 200);
};
const kindOfName = (name: string): "video" | "audio" | "image" | null => {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? "").toLowerCase();
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (IMAGE_EXT.includes(ext)) return "image";
  return null;
};
const finite = (value: unknown, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;

/**
 * 页面一侧的采集请求执行器。`handles(ev)` 说这条事件归不归它(接线的一侧据此在它与 `createAccountPageRequests` 之间分流);
 * `run(ev)` 回 null 表示这条不是给这张页面的合格请求:不执行、不答。
 */
export function createCollectBridgePage(deps: CollectBridgePageDeps): {
  handles(ev: CloudEvent): boolean;
  run(ev: CloudEvent): Promise<CollectPageAnswer | null>;
  /** 探针与单测的观察口:在办的委托数 */
  describe(): { delegations: number; running: number };
} {
  const remember = deps.remember ?? 400;
  const pollMs = deps.pollMs ?? 1000;
  const downloadMs = deps.downloadMs ?? 15 * 60_000;
  const uploadMs = deps.uploadMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const done = new Map<string, { nonce: string; answer: Promise<CollectPageAnswer> }>();
  const delegations = new Map<string, Delegation>();

  /** 本机下载 → 上传 → 回执。任何一步不成只记代号 */
  async function track(d: Delegation, local: CollectBridgeLocal, upload: CollectBridgeUpload): Promise<void> {
    const fail = (code: string) => { if (d.phase === "running") { d.phase = "error"; d.code = code; } };
    try {
      const started = now();
      let job: LocalCollectJob | null = null;
      for (;;) {
        if (d.cancelled) return fail("cancelled");
        job = await local.job(d.localJobId as string);
        if (!job) return fail("local-download-failed");
        if (job.status !== "running") break;
        if (typeof job.stage === "string" && STAGES.includes(job.stage)) d.stage = job.stage;
        // 本机下载占前九成,上传占后一成
        const p = finite(job.percent, 100);
        if (p !== undefined) d.percent = Math.round(p * 0.9);
        if (now() - started > downloadMs) { await local.cancel(d.localJobId as string).catch(() => {}); return fail("timeout"); }
        await sleep(pollMs);
      }
      if (job.status !== "done" || !Array.isArray(job.items) || job.items.length === 0) return fail("local-download-failed");
      const items: CollectReceipt["result"]["items"] = [];
      for (const it of job.items) {
        const hash = typeof it.hash === "string" ? it.hash.toLowerCase() : "";
        const size = it.bytes;
        const name = baseName(it.filename);
        const kind = kindOfName(name);
        if (!HASH_RE.test(hash) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || !name || !kind) return fail("local-download-failed");
        const duration = finite(it.duration, 48 * 3600);
        const width = finite(it.width, 65536);
        const height = finite(it.height, 65536);
        items.push({
          assetRef: { projectId: d.projectId, hash, size }, name, kind,
          ...(typeof it.title === "string" && it.title ? { title: it.title.slice(0, 200) } : {}),
          ...(duration !== undefined ? { duration } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
          ...(typeof it.vcodec === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(it.vcodec) ? { vcodec: it.vcodec } : {}),
        });
      }
      // 项目换了(用户切到了别的项目):不往别的项目里传
      if (upload.projectId() !== d.projectId) return fail("upload-failed");
      d.stage = "upload";
      d.percent = 92;
      if (!(await upload.push(items.map((it) => ({ hash: it.assetRef.hash, name: it.name }))))) return fail("upload-failed");
      const uploadStarted = now();
      for (const it of items) {
        for (;;) {
          if (d.cancelled) return fail("cancelled");
          if (upload.projectId() !== d.projectId) return fail("upload-failed");
          if (await upload.stored(it.assetRef.hash)) break;
          if (now() - uploadStarted > uploadMs) return fail("timeout");
          await sleep(pollMs);
        }
      }
      if (d.phase !== "running") return;
      d.receipt = { requestId: d.id, jobId: d.jobId, assetRef: items[0].assetRef, result: { items, cookiesUsed: job.cookiesUsed === true } };
      d.stage = "done";
      d.percent = 100;
      d.phase = "done";
    } catch {
      fail(d.stage === "upload" ? "upload-failed" : "local-download-failed");
    }
  }

  async function start(raw: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; code?: string }> {
    const local = deps.local ?? null;
    const upload = deps.upload ?? null;
    // 网页版:没有本机采集,也没有本机的上传队列。如实说做不了,不假装代下
    if (!local || !upload) return { ok: false, code: "unsupported" };
    const delegationId = typeof raw.delegationId === "string" && DELEGATION_ID_RE.test(raw.delegationId) ? raw.delegationId : null;
    const jobId = typeof raw.jobId === "string" && JOB_ID_RE.test(raw.jobId) ? raw.jobId : null;
    const url = typeof raw.url === "string" && raw.url.length > 0 && raw.url.length <= 2000 ? raw.url : null;
    const site = typeof raw.site === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(raw.site) ? raw.site : null;
    const quality = typeof raw.quality === "number" && QUALITIES.includes(raw.quality) ? raw.quality : null;
    if (!delegationId || !jobId || !url || !site || !quality || typeof raw.projectId !== "string") return { ok: false, code: "bad-args" };
    const existing = delegations.get(delegationId);
    if (existing) return { ok: true, result: { accepted: true } };
    // 云端说的项目必须就是这张页面此刻开着的账号项目:别的项目的委托不接
    if (upload.projectId() !== raw.projectId) return { ok: true, result: { accepted: false, code: "wrong-project" } };
    if ([...delegations.values()].some((d) => d.phase === "running")) return { ok: true, result: { accepted: false, code: "local-busy" } };
    let ready = false;
    try { ready = (await local.status()).ready === true; } catch { ready = false; }
    if (!ready) return { ok: true, result: { accepted: false, code: "local-not-ready" } };
    let login: { loggedIn: boolean; path?: string | null } | undefined;
    try { login = (await local.cookies())[site]; } catch { login = undefined; }
    // 本机没有这个站点没过期的登录态:由本机下载也只是未登录的画质,不如让云端自己下
    if (!login || login.loggedIn !== true) return { ok: true, result: { accepted: false, code: "not-logged-in" } };
    const preset = raw.preset === "bilibili" || raw.preset === "generic" ? raw.preset : undefined;
    let localJobId: string;
    try {
      const out = await local.download(url, {
        quality, ...(preset ? { site: preset } : {}),
        ...(raw.audioOnly === true ? { audioOnly: true } : {}), ...(raw.allParts === true ? { allParts: true } : {}), ...(raw.keepCodec === true ? { keepCodec: true } : {}),
        // 登录态文件的路径只从本机的一个接口交到另一个接口
        ...(typeof login.path === "string" && login.path ? { cookies: login.path } : {}),
      });
      if (typeof out?.jobId !== "string" || !out.jobId) throw new Error("no job");
      localJobId = out.jobId;
    } catch {
      return { ok: true, result: { accepted: false, code: "local-not-ready" } };
    }
    const d: Delegation = { id: delegationId, jobId, projectId: raw.projectId, localJobId, phase: "running", stage: "starting", percent: 0, code: null, receipt: null, cancelled: false };
    delegations.set(delegationId, d);
    if (delegations.size > 50) delegations.delete(delegations.keys().next().value as string);
    void track(d, local, upload);
    return { ok: true, result: { accepted: true } };
  }

  function poll(raw: Record<string, unknown>): { ok: boolean; result?: unknown; code?: string } {
    const d = typeof raw.delegationId === "string" ? delegations.get(raw.delegationId) : undefined;
    if (!d) return { ok: true, result: { state: "unknown" } };
    if (d.phase === "done" && d.receipt) return { ok: true, result: { state: "done", receipt: d.receipt } };
    if (d.phase === "error") return { ok: true, result: { state: "error", code: d.code ?? "failed" } };
    return { ok: true, result: { state: "running", stage: d.stage, percent: d.percent } };
  }

  async function cancel(raw: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; code?: string }> {
    const d = typeof raw.delegationId === "string" ? delegations.get(raw.delegationId) : undefined;
    if (d && d.phase === "running") {
      d.cancelled = true;
      d.phase = "error";
      d.code = "cancelled";
      if (d.localJobId && deps.local) await deps.local.cancel(d.localJobId).catch(() => {});
    }
    return { ok: true };
  }

  async function login(raw: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; code?: string }> {
    const local = deps.local ?? null;
    if (!local) return { ok: false, code: "unsupported" };
    const site = typeof raw.site === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(raw.site) ? raw.site : null;
    if (!site) return { ok: false, code: "bad-args" };
    try {
      const r = await local.login({ site, method: raw.method === "browser" ? "browser" : "qr", ...(raw.force === true ? { force: true } : {}) });
      if (r?.ok === false) return { ok: false, code: "local-failed" };
      // 本机回的用户标识、过期时间、窗口细节都不往云端带
      return { ok: true, result: r?.alreadyLoggedIn === true ? { opened: false, alreadyLoggedIn: true } : { opened: true, alreadyLoggedIn: false } };
    } catch {
      return { ok: false, code: "local-failed" };
    }
  }

  async function loginCheck(raw: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; code?: string }> {
    const local = deps.local ?? null;
    if (!local) return { ok: false, code: "unsupported" };
    const site = typeof raw.site === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(raw.site) ? raw.site : null;
    if (!site) return { ok: false, code: "bad-args" };
    try {
      const r = await local.loginCheck({ site, ...(raw.hide === false ? { hide: false } : {}) });
      if (r?.ok === false) return { ok: false, code: "local-failed" };
      return { ok: true, result: { loggedIn: r?.loggedIn === true, ...(r?.loggedIn !== true && r?.expired === true ? { expired: true } : {}) } };
    } catch {
      return { ok: false, code: "local-failed" };
    }
  }

  const handles = (ev: CloudEvent): boolean =>
    !!ev && ev.type === "page.request" && ev.v === COLLECT_PAGE_REQUEST_VERSION && typeof ev.tool === "string" &&
    (COLLECT_PAGE_REQUEST_TOOLS as readonly string[]).includes(ev.tool);

  return {
    handles,
    async run(ev: CloudEvent): Promise<CollectPageAnswer | null> {
      if (!handles(ev)) return null;
      const id = typeof ev.id === "string" && REQUEST_ID_RE.test(ev.id) ? ev.id : null;
      const nonce = typeof ev.nonce === "string" && NONCE_RE.test(ev.nonce) ? ev.nonce : null;
      if (!id || !nonce) return null;
      const mine = deps.pageId();
      // 不是发给这张页面的(页面号对不上、这张页面还没连上文档服务):不执行也不答
      if (!mine || !PRESENCE_PAGE_ID_RE.test(mine) || ev.pageId !== mine) return null;
      const seen = done.get(id);
      if (seen) return seen.nonce === nonce ? seen.answer : null;
      const tool = ev.tool as CollectPageRequestTool;
      const raw = ev.args && typeof ev.args === "object" && !Array.isArray(ev.args) ? (ev.args as Record<string, unknown>) : {};
      const base = { v: COLLECT_PAGE_REQUEST_VERSION as 2, id, nonce, pageId: mine, ...(typeof ev.runId === "string" ? { runId: ev.runId } : {}) };
      const answer = (async (): Promise<CollectPageAnswer> => {
        let out: { ok: boolean; result?: unknown; code?: string };
        try {
          if (tool === "collect_delegate_start") out = await start(raw);
          else if (tool === "collect_delegate_poll") out = poll(raw);
          else if (tool === "collect_delegate_cancel") out = await cancel(raw);
          else if (tool === "collect_login") out = await login(raw);
          else out = await loginCheck(raw);
        } catch {
          out = { ok: false, code: "local-failed" };
        }
        return { ...base, ok: out.ok, ...(out.result !== undefined ? { result: out.result } : {}), ...(out.code ? { code: out.code } : {}) };
      })();
      done.set(id, { nonce, answer });
      if (done.size > remember) done.delete(done.keys().next().value as string);
      return answer;
    },
    describe: () => ({ delegations: delegations.size, running: [...delegations.values()].filter((d) => d.phase === "running").length }),
  };
}
