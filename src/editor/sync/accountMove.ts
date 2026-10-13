/**
 * 账号办法的「搬到云端」(桌面版):把本机打开的本地项目、或旧办法在本机开的协作房间,搬成一个属于当前登录账号的云端项目。
 * 用户 2026-10-13 定的四条在 `docs/plan/user-decisions-2026-10-13.md` 第 2 节「本地项目搬到云端」;报告 `docs/reports/AGENT-v18-move.md`。
 *
 * 本文件只有流程本身,不认识 store、界面和账号客户端:要用的东西都由调用方给(`MoveDeps`),接线在 `accountMoveFlow.ts`。
 * 这样每一步的成功与失败都能在 Node 里单测(`accountMove.test.mjs`),对着真服务的在 `server/test/account-move.test.mjs`。
 *
 * **先云端、后本机**(旧流程的教训是先封锁本机房间再传,失败就把房间变成打不开的):
 *
 *   1 核对      登录了没有;协作房间要以创建者身份进入、并当场核对创建者密码(只读的一次核对,不改任何东西);
 *               等本机的修改都落定,取一份项目内容;内容超过文档服务一次根替换的上限就在这里停。
 *   2 建项目    `POST /hosted/shared/account/create`,带一份空白项目当占位(真内容不走这个接口:它的上限是 1 MiB,桌面外壳的账号桥
 *               也是 1 MiB,而且同一个请求号重放时内容必须一字不差)。请求号、项目名、占位内容先记在本机(`MoveAttemptStore`),
 *               失败后再点一次用的是同一个请求号 —— 新建接口对它幂等,云端不会多出一个重名的项目。
 *   3 传内容    另开一条文档连接(不是编辑器正在用的那条),把项目内容以一次根替换写进去;超过单次提交上限的由 `DocSync` 分片上传。
 *   4 核对      再开一条连接把云端的内容读回来,和本机那一份逐字段比;不一样就停。这期间本机又有新修改的,再传、再核对;
 *               传了几轮本机还在变(有 Agent 或工具在连着改)就停下,不往下走。
 *   —— 到这里为止,本机的项目文件、房间记录、协作状态一个字都没动。任何一步失败,本机原样可用。——
 *   5 协作房间  先把这台电脑上没有的素材拉齐(搬的人不在主机那台电脑上时),再关掉本机协作(删房间:旧成员的连接断开、
 *               旧邀请码作废、云端托管服务上的登记注销)。**关掉之后第一件事是把当前内容存到本机**(不带房间关联的普通本地项目),
 *               然后才补传关的那一下别人刚改过的;补传失败时本机这一份是全的,之后从本地项目再点一次,用原来的请求号接着补。
 *   6 进项目    编辑器接到云端项目上;素材交给上传队列在后台传(先小尺寸、再原尺寸)。
 *               **换过去的那一刻再比一次**(`MoveDeps.enter` 的约定):编辑器里的内容与云端核对过的那一份不同就不换、回来再传,
 *               所以不会出现「报了成功、云端却比本机旧」。
 *
 * 不随项目上云的东西(旧房间的成员与名单、项目密码、创建者口令、邀请码、禁入表、撤销栈、云端 Agent 对话等)列在报告里。
 */
import type { Project } from "../../kernel/project";
import { UPLOAD_MAX_PARTS, UPLOAD_PART_CHARS } from "../../store/docsync";
import { SyncLink } from "./link";

/* ---------------- 结果与错误 ---------------- */

export type MoveStage = "check" | "create" | "upload" | "verify" | "pull-media" | "close-local" | "sync-last" | "enter" | "queue-media" | "done";

export type MoveErrorCode =
  /** 没登录网站账号 */
  | "login-required"
  /** 当前打开的不是能搬的东西(已经是云端项目、协作身份还没恢复、在线页面) */
  | "not-ready"
  /** 协作房间:不是以创建者身份进入的 */
  | "not-creator"
  /** 协作房间:要创建者密码(本机没存、界面上也没填) */
  | "creator-password"
  /** 协作房间:创建者密码不对 */
  | "bad-password"
  | "rate-limited"
  /** 另一个窗口正在搬同一个项目 */
  | "busy"
  /** 搬的过程中项目一直在被修改(Agent、工具还在改),传了几轮都追不上 */
  | "busy-editing"
  /** 本机的修改还没落定(等不到文档服务确认) */
  | "save-pending"
  /** 项目内容超过一次根替换的上限 */
  | "too-large"
  | "name-taken"
  | "invalid-name"
  /** 这个账号现在不许新建(托管方的策略、数量上限) */
  | "create-refused"
  /** 目标云端没有账号办法的新建接口(不是账号模式的节点) */
  | "not-account-cloud"
  /** 连不上云端(网络、超时) */
  | "network"
  /** 云端回了服务端错误(5xx):建没建成不确定,请求号留着 */
  | "create-failed"
  | "upload-failed"
  | "verify-failed"
  | "media-pull-failed"
  | "close-failed"
  | "sync-last-failed"
  | "enter-failed";

export interface MediaReport {
  /** 交给上传队列的素材个数 */
  queued: number;
  /** 本机找不到文件、传不上去的素材名字 */
  missing: string[];
}

export type MoveResult =
  | { ok: true; kind: "local" | "room"; projectId: string; name: string; link: string; media: MediaReport | null }
  | {
    ok: false; error: MoveErrorCode; stage: MoveStage; detail?: string;
    /** 本机协作已经关掉(只有第 5 步之后的失败才是 true);false = 本机的项目、房间、协作状态原样没动 */
    localClosed: boolean;
    /** 本机协作关掉之后,当前内容存到本机文件了没有(只在 `localClosed` 时有) */
    localSaved?: boolean;
    /** 云端已经建好的那个项目(再点一次接着用它);没有建成是 null */
    cloud: { projectId: string; name: string } | null;
    /** 限速时服务端给的冷却秒数 */
    retryAfter?: number | null;
  };

/* ---------------- 内容比较 ---------------- */

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** 项目内容的规范文本:键排序、去掉 `undefined`(与 JSON 往返之后的结果一致) */
export function contentText(project: unknown): string {
  return JSON.stringify(canonical(project));
}

/** 两份项目内容逐字段相同 */
export function sameContent(a: unknown, b: unknown): boolean {
  return a === b || contentText(a) === contentText(b);
}

/**
 * 一次根替换装得下的字符数:`DocSync` 把超过单次提交上限的根替换拆成最多 `UPLOAD_MAX_PARTS` 片、每片 `UPLOAD_PART_CHARS` 个字符
 * (`src/store/docsync.ts` 的 `wireOps`;文档服务 `PROJECT_LIMITS.UPLOAD_MAX_PARTS`)。再大就传不上去。
 */
export const MAX_CONTENT_CHARS = UPLOAD_MAX_PARTS * UPLOAD_PART_CHARS;

/* ---------------- 「云端」指的是不是账号云端 ---------------- */

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url.trim());
    return ["http:", "https:", "ws:", "wss:"].includes(u.protocol) ? u.host.toLowerCase() : null;
  } catch { return null; }
};

/**
 * 界面上填的(或房间登记用的)云端地址,指的是不是这台桌面版配置的账号云端。
 * 是:搬到云端走账号办法;不是(用户自己填了别的节点):照旧办法,由 `server/recovery/relocation-preflight.mjs` 把关。
 * 认三种:没填(缺省);和账号云端同一个主机;内置的缺省托管地址及它的 sslip.io 写法(与账号云端是同一个节点的另一个入口,
 * 账号任务书「在线浏览器的地址」)。
 */
export function isAccountCloudTarget(serviceUrl: string | null | undefined, accountOrigin: string, defaultHostedUrl: string): boolean {
  const text = String(serviceUrl ?? "").trim();
  if (!text) return true;
  const host = hostOf(text), account = hostOf(accountOrigin), builtin = hostOf(defaultHostedUrl);
  if (!host || !account) return false;
  if (host === account) return true;
  if (!builtin) return false;
  const name = (h: string) => h.replace(/:\d+$/, "");
  return name(host) === name(builtin) || name(host) === `${name(builtin).replaceAll(".", "-")}.sslip.io`;
}

/* ---------------- 本机记下的一次搬迁(请求号) ---------------- */

/**
 * 一次还没做完的搬迁。只记在这台设备的页面存储里(不进项目文件、不进房间记录):
 * 做完就删;失败后再点一次按它接着做,用同一个请求号、同一份占位内容(新建接口按请求号幂等,内容不同会被拒)。
 */
export interface MoveAttempt {
  v: 1;
  accountId: string;
  /** 本机项目文件里的项目号(`project.id`);协作房间里也是它,不是房间号 */
  contentId: string;
  requestId: string;
  name: string;
  stub: unknown;
  /** 云端已经回了项目号(建成了);没有 = 上一次请求的结果不确定 */
  projectId?: string;
  at: number;
}

export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MOVE_ATTEMPTS_KEY = "pc.account.move";
/** 「正在搬」的占位(同一台电脑上开了两个窗口时互相看得见);键同上,值是 `{ owner, at }` */
export const MOVE_LOCKS_KEY = "pc.account.move.lock";
/** 占位多久没续就算那个窗口不在了(搬的时候每 `LOCK_BEAT_MS` 续一次) */
export const LOCK_STALE_MS = 30_000;
export const LOCK_BEAT_MS = 5_000;
/** 搬到云端时关掉的本机协作房间(房间号 → 时刻):带着这些房间关联的旧文件重开时当普通本地项目开 */
export const MOVED_ROOMS_KEY = "pc.account.moved-rooms";
const MOVED_ROOMS_KEEP = 200;

const attemptKey = (accountId: string, contentId: string) => `${accountId}|${contentId}`;

export function createAttemptStore(storage: AttemptStorage | null) {
  const readAll = (): Record<string, MoveAttempt> => {
    try {
      const value = JSON.parse(storage?.getItem(MOVE_ATTEMPTS_KEY) ?? "");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, MoveAttempt> : {};
    } catch { return {}; }
  };
  const readJson = (key: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(storage?.getItem(key) ?? "");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
  };
  const writeAll = (all: Record<string, MoveAttempt>) => {
    if (Object.keys(all).length) storage?.setItem(MOVE_ATTEMPTS_KEY, JSON.stringify(all));
    else storage?.removeItem(MOVE_ATTEMPTS_KEY);
  };
  const valid = (a: MoveAttempt | undefined, accountId: string, contentId: string): a is MoveAttempt =>
    !!a && a.v === 1 && a.accountId === accountId && a.contentId === contentId && typeof a.requestId === "string" && !!a.requestId &&
    typeof a.name === "string" && !!a.name && (a.projectId === undefined || /^sp_[a-z2-7]{26}$/.test(a.projectId)) && Number.isFinite(a.at);
  return {
    get(accountId: string, contentId: string): MoveAttempt | null {
      const a = readAll()[attemptKey(accountId, contentId)];
      return valid(a, accountId, contentId) ? a : null;
    },
    /** 写不进去(存储满了、被禁用)要抛出来:记不住请求号就不该去建项目 */
    put(a: MoveAttempt): void {
      const all = readAll();
      all[attemptKey(a.accountId, a.contentId)] = a;
      writeAll(all);
      const back = readAll()[attemptKey(a.accountId, a.contentId)];
      if (!back || back.requestId !== a.requestId || back.projectId !== a.projectId) throw new Error("搬迁记录没有存下来");
    },
    /** 只删自己那一次的记录:请求号对不上(另一个窗口后来记的)不动 */
    drop(accountId: string, contentId: string, requestId: string): void {
      const all = readAll();
      if (all[attemptKey(accountId, contentId)]?.requestId !== requestId) return;
      delete all[attemptKey(accountId, contentId)];
      try { writeAll(all); } catch { /* 删不掉:下次按它接着用同一个项目,不会多建 */ }
    },
    /** 占住「正在搬这个项目」(自己已经占着就是续一次)。别的窗口占着、还没过期回 false */
    lock(accountId: string, contentId: string, owner: string, at: number): boolean {
      const all = readJson(MOVE_LOCKS_KEY) as Record<string, { owner?: string; at?: number }>;
      const held = all[attemptKey(accountId, contentId)];
      if (held && held.owner !== owner && typeof held.at === "number" && at - held.at < LOCK_STALE_MS && at >= held.at) return false;
      all[attemptKey(accountId, contentId)] = { owner, at };
      try { storage?.setItem(MOVE_LOCKS_KEY, JSON.stringify(all)); } catch { /* 占不上位:照常做,记录按请求号各管各的 */ }
      return true;
    },
    unlock(accountId: string, contentId: string, owner: string): void {
      const all = readJson(MOVE_LOCKS_KEY) as Record<string, { owner?: string }>;
      if (all[attemptKey(accountId, contentId)]?.owner !== owner) return;
      delete all[attemptKey(accountId, contentId)];
      try { if (Object.keys(all).length) storage?.setItem(MOVE_LOCKS_KEY, JSON.stringify(all)); else storage?.removeItem(MOVE_LOCKS_KEY); } catch { /* 过期后自然失效 */ }
    },
    /** 记下「这个本机协作房间是搬到云端时关掉的」 */
    noteMovedRoom(roomId: string, at: number): void {
      const all = readJson(MOVED_ROOMS_KEY) as Record<string, number>;
      all[roomId] = at;
      const keep = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, MOVED_ROOMS_KEEP);
      try { storage?.setItem(MOVED_ROOMS_KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* 记不下:那种旧文件重开时显示「原房间已删除」 */ }
    },
    isMovedRoom(roomId: string): boolean {
      return typeof (readJson(MOVED_ROOMS_KEY) as Record<string, unknown>)[roomId] === "number";
    },
  };
}

export type AttemptStore = ReturnType<typeof createAttemptStore>;

/* ---------------- 调用方给的东西 ---------------- */

export interface MoveSource {
  kind: "local" | "room";
  contentId: string;
  /** 协作房间:本页面是不是以创建者身份进入的 */
  creator?: boolean;
  /** 协作房间:房间号 */
  roomId?: string;
}

/** 账号接口的失败:`status` 0 = 没连上 */
export interface StatusError { status?: number; code?: string; message?: string }

export interface MoveDeps {
  /** 现在打开的是什么;不能搬回 null */
  source(): MoveSource | null;
  /** 当前登录的账号;没登录回 null;连不上抛错 */
  account(): Promise<{ id: string; name: string } | null>;
  /** 新建云端项目;失败抛带 `status` / `code` 的错 */
  create(name: string, stub: unknown, requestId: string): Promise<{ projectId: string }>;
  /** 等本机的修改都落定,回一份项目内容的拷贝;等不到抛错 */
  snapshot(): Promise<Project>;
  /** 此刻编辑器里的项目内容(不拷贝,只用来比较) */
  current(): Project;
  /** 把内容写进云端项目(根替换);失败抛错 */
  upload(projectId: string, snapshot: Project): Promise<unknown>;
  /** 另开一条连接把云端的内容读回来;失败抛错 */
  read(projectId: string): Promise<Project>;
  /** 协作房间:核对创建者密码(只读,不改东西) */
  checkCreator?(password: string): Promise<{ ok: true } | { ok: false; error: "bad-password" | "rate-limited" | "network" }>;
  /** 协作房间:把这台电脑上没有的素材拉齐;`missing` 是还差几个 */
  pullMedia?(project: Project): Promise<{ ok: boolean; missing: number }>;
  /** 协作房间:关掉本机协作(删房间),编辑器回到本机项目 */
  closeRoom?(password: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 把本机这一份照现在的内容存到本机文件(不带房间关联)。本地项目:有草稿才存。协作房间(刚关掉):一定要存下来,
   * 没有草稿就新开一份 —— 房间已经删了,这是唯一一份全的。存不下抛错
   */
  saveLocal?(): Promise<void>;
  /**
   * 编辑器接到云端项目上。**换过去的那一刻**要再比一次:编辑器里的内容、云端发来的内容,有一样与 `snapshot` 不同就不换,
   * 抛带 `code: "content-changed"` 的错(流程回头再传、再来)。别的失败抛带 `status` 的错
   */
  enter(o: { projectId: string; name: string; snapshot: Project; kind: "local" | "room" }): Promise<void>;
  /** 项目引用到的素材交给上传队列;交不上回 null(调用方自己提示并重试);不抛错 */
  queueMedia(): Promise<MediaReport | null>;
  /** 这个窗口的号(同一台电脑上两个窗口同时搬同一个项目时互相认得出);不给用一个随机的 */
  owner?: string;
  attempts: AttemptStore;
  newRequestId(): string;
  /** 新建时带的占位内容:一份完整的空白项目(编辑器打得开) */
  stub(name: string, contentId: string): unknown;
  /** 项目链接 */
  linkOf(projectId: string): string;
  onStage?(stage: MoveStage): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface MoveInput {
  /** 云端项目名(已经建好、接着做的那一次沿用建好时的名字) */
  name: string;
  /** 协作房间:创建者密码 */
  creatorPassword?: string;
}

/** 内容在传的过程中本机又变了:最多再传几轮 */
export const MAX_CONTENT_ROUNDS = 3;
/** 进项目没成(连接一时不通)最多试几次 */
export const ENTER_TRIES = 3;

const statusOf = (error: unknown): number | undefined => {
  const s = (error as StatusError | null)?.status;
  return typeof s === "number" ? s : undefined;
};
const codeOf = (error: unknown): string => String((error as StatusError | null)?.code ?? "");
const detailOf = (error: unknown): string => {
  const e = error as StatusError | null;
  return String(e?.code || e?.message || error || "").slice(0, 200);
};

/**
 * 新建接口的失败:这个请求号**肯定没有**建出项目。只认四种:名字重、名字不合法、账号不许建(403)、没有这条路由 ——
 * 它们都是落账之前就拒绝的。别的一律当「结果不确定」留着请求号:401 也是(云端先记下项目、占住名字,初始化完再核一次登录,
 * 那时回 401 项目已经落账,`server/account/authority.mjs` 的 `createProject`),丢了请求号再点就是对着自己看不见的项目报重名。
 */
function createDefinitelyFailed(error: unknown): boolean {
  const kind = createErrorCode(error);
  return kind === "name-taken" || kind === "invalid-name" || kind === "create-refused" || kind === "not-account-cloud";
}

function createErrorCode(error: unknown): MoveErrorCode {
  const s = statusOf(error), code = codeOf(error);
  if (s === 0 || code === "network") return "network";
  if (s === 401) return "login-required";
  if (code === "name-taken") return "name-taken";
  if (code === "invalid-name") return "invalid-name";
  if (s === 403) return "create-refused";
  if (s === 404 || s === 405 || s === 501 || code === "account-required" || code === "no-route" || code === "desktop-bridge-unavailable") return "not-account-cloud";
  return "create-failed";
}

/**
 * 搬到云端。不抛错:结果里写清停在哪一步、本机协作关了没有、云端有没有已经建好的项目。
 * 同一个项目同一时间只做一次(同一台电脑上的别的窗口也算);中途失败后再调一次按本机记下的请求号接着做。
 */
export async function moveToAccountCloud(deps: MoveDeps, input: MoveInput): Promise<MoveResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stage: MoveStage = "check";
  let localClosed = false;
  let localSaved: boolean | undefined;
  let cloud: { projectId: string; name: string } | null = null;
  const at = (s: MoveStage) => { stage = s; deps.onStage?.(s); };
  const fail = (error: MoveErrorCode, detail?: string, extra: { retryAfter?: number | null } = {}): MoveResult =>
    ({ ok: false, error, stage, localClosed, ...(localClosed ? { localSaved: localSaved === true } : {}), cloud, ...(detail ? { detail } : {}), ...extra });

  /* 1 核对 */
  at("check");
  const source = deps.source();
  if (!source || !source.contentId) return fail("not-ready");
  let found: { id: string; name: string } | null;
  try { found = await deps.account(); }
  catch (error) { return fail(statusOf(error) === 401 ? "login-required" : "network", detailOf(error)); }
  if (!found) return fail("login-required");
  const account = found;
  const password = input.creatorPassword ?? "";
  if (source.kind === "room") {
    if (!source.creator) return fail("not-creator");
    if (!deps.checkCreator || !deps.closeRoom) return fail("not-ready");
    if (!password) return fail("creator-password");
    const checked = await deps.checkCreator(password);
    if (!checked.ok) return fail(checked.error);
  }
  // 同一个项目同一时间只做一次:另一个窗口正在搬就不动(它的记录、它建的项目都不碰)
  const owner = deps.owner ?? `w-${Math.random().toString(36).slice(2)}-${now()}`;
  if (!deps.attempts.lock(account.id, source.contentId, owner, now())) return fail("busy");
  const beat = setInterval(() => { deps.attempts.lock(account.id, source.contentId, owner, now()); }, LOCK_BEAT_MS);
  (beat as { unref?: () => void }).unref?.();
  try { return await run(); }
  finally { clearInterval(beat); deps.attempts.unlock(account.id, source.contentId, owner); }

  async function run(): Promise<MoveResult> {
    if (!source) return fail("not-ready");
    let snapshot: Project;
    try { snapshot = await deps.snapshot(); }
    catch (error) { return fail("save-pending", detailOf(error)); }
    const tooLarge = (p: Project) => JSON.stringify(p).length > MAX_CONTENT_CHARS;
    if (tooLarge(snapshot)) return fail("too-large", String(JSON.stringify(snapshot).length));

    /* 2 建项目(或接着用上一次建好的那个) */
    at("create");
    const name = input.name.trim();
    let attempt = deps.attempts.get(account.id, source.contentId);
    if (attempt && !attempt.projectId) {
      // 上一次的请求结果不确定(没收到回包):先用原样的请求问清楚,免得换了名字又建一个。
      // 云端的请求账本不过期,原样重放一直安全,所以这条记录也不设过期
      try {
        const made = await deps.create(attempt.name, attempt.stub, attempt.requestId);
        attempt = { ...attempt, projectId: made.projectId };
        deps.attempts.put(attempt);
      } catch (error) {
        if (!createDefinitelyFailed(error)) return fail(createErrorCode(error), detailOf(error));
        // 那一次确实没建成:记录作废。名字没换、或者不是名字的问题,直接报给用户;换了名字的按这一次填的重新来
        deps.attempts.drop(account.id, source.contentId, attempt.requestId);
        const kind = createErrorCode(error);
        if (attempt.name === name || (kind !== "name-taken" && kind !== "invalid-name")) return fail(kind, detailOf(error));
        attempt = null;
      }
    }
    if (!attempt) {
      if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) return fail("invalid-name");
      attempt = { v: 1, accountId: account.id, contentId: source.contentId, requestId: deps.newRequestId(), name, stub: deps.stub(name, source.contentId), at: now() };
      // 先记下请求号再发请求:发出去之后回包丢了,下一次也知道该问哪个请求
      try { deps.attempts.put(attempt); } catch (error) { return fail("not-ready", detailOf(error)); }
      try {
        const made = await deps.create(attempt.name, attempt.stub, attempt.requestId);
        attempt = { ...attempt, projectId: made.projectId };
        deps.attempts.put(attempt);
      } catch (error) {
        if (createDefinitelyFailed(error)) deps.attempts.drop(account.id, source.contentId, attempt.requestId);
        return fail(createErrorCode(error), detailOf(error));
      }
    }
    const made = attempt;
    const projectId = made.projectId!;
    cloud = { projectId, name: made.name };
    /** 云端说这个项目不在了(被删了):记录作废,下次重新建 */
    const goneCheck = (error: unknown) => { if (statusOf(error) === 404) deps.attempts.drop(account.id, source.contentId, made.requestId); };

    /* 3、4 传内容、读回来核对 */
    const push = async (content: Project): Promise<MoveResult | null> => {
      at(localClosed ? "sync-last" : "upload");
      try { await deps.upload(projectId, content); }
      catch (error) {
        goneCheck(error);
        if (statusOf(error) === 401) return fail("login-required", detailOf(error));
        return fail(localClosed ? "sync-last-failed" : "upload-failed", detailOf(error));
      }
      if (!localClosed) at("verify");
      let back: Project;
      try { back = await deps.read(projectId); }
      catch (error) { goneCheck(error); return fail(localClosed ? "sync-last-failed" : "verify-failed", detailOf(error)); }
      if (!sameContent(back, content)) return fail(localClosed ? "sync-last-failed" : "verify-failed", "content-mismatch");
      return null;
    };
    // 这期间本机又改了就再来一轮;传了几轮还在变(有 Agent 或工具连着改)就停下 —— 本机还没动过,不往下走
    for (let round = 1; ; round++) {
      const failed = await push(snapshot);
      if (failed) return failed;
      if (sameContent(deps.current(), snapshot)) break;
      if (round >= MAX_CONTENT_ROUNDS) return fail("busy-editing");
      try { snapshot = await deps.snapshot(); }
      catch (error) { return fail("save-pending", detailOf(error)); }
      if (tooLarge(snapshot)) return fail("too-large", String(JSON.stringify(snapshot).length));
    }

    /** 存过本机文件的那一份(对象身份);和 `snapshot` 不是同一个就还要再存 */
    let savedFor: Project | null = null;
    const saveLocal = async () => {
      try { await deps.saveLocal?.(); localSaved = true; savedFor = snapshot; }
      catch { localSaved = false; savedFor = null; }
    };

    /* 5 协作房间:拉齐素材、关掉本机协作,关完第一件事是把当前内容存到本机 */
    if (source.kind === "room") {
      if (deps.pullMedia) {
        at("pull-media");
        let pulled: { ok: boolean; missing: number };
        try { pulled = await deps.pullMedia(snapshot); } catch (error) { return fail("media-pull-failed", detailOf(error)); }
        if (!pulled.ok) return fail("media-pull-failed", String(pulled.missing));
      }
      at("close-local");
      // 先记下「这个房间是搬到云端时关的」:带着它的关联、这次又写不回去的旧文件(从别处打开的那份),重开时当普通本地项目开
      if (source.roomId) deps.attempts.noteMovedRoom(source.roomId, now());
      let closed: { ok: true } | { ok: false; error: string };
      try { closed = await deps.closeRoom!(password); } catch (error) { closed = { ok: false, error: detailOf(error) }; }
      if (!closed.ok) return fail(closed.error === "forbidden" ? "bad-password" : closed.error === "rate-limited" ? "rate-limited" : "close-failed", closed.error);
      localClosed = true;
      await saveLocal();
      if (!sameContent(deps.current(), snapshot)) savedFor = null;
    }

    /* 6 进项目。换过去之前、换过去的那一刻都再比:本机这一份与云端核对过的不同,就先补传再来 */
    let chases = 0;
    for (let tries = 1; ;) {
      if (!sameContent(deps.current(), snapshot)) {
        if (++chases > MAX_CONTENT_ROUNDS) return fail("busy-editing");
        try { snapshot = await deps.snapshot(); }
        catch (error) { return fail(localClosed ? "sync-last-failed" : "save-pending", detailOf(error)); }
        if (tooLarge(snapshot)) return fail("too-large", String(JSON.stringify(snapshot).length));
        // 本机协作已经关了的:先存本机、再补传 —— 补传失败时本机这一份是全的
        if (localClosed) await saveLocal();
        const failed = await push(snapshot);
        if (failed) return failed;
        continue;
      }
      // 本机那一份照现在的样子存一次:搬完之后它是一个普通的本地项目
      if (savedFor !== snapshot) await saveLocal();
      at("enter");
      try { await deps.enter({ projectId, name: made.name, snapshot, kind: source.kind }); break; }
      catch (error) {
        if (codeOf(error) === "content-changed") {
          // 换过去的那一刻内容对不上(刚又改了):没有换。回到上面补传;连着几次都这样就停
          if (++chases > MAX_CONTENT_ROUNDS) return fail("busy-editing");
          continue;
        }
        const s = statusOf(error);
        goneCheck(error);
        if (s === 401 || s === 403 || s === 404 || tries >= ENTER_TRIES) return fail("enter-failed", detailOf(error));
        await sleep(1000 * tries);
        tries++;
      }
    }
    deps.attempts.drop(account.id, source.contentId, made.requestId);
    at("queue-media");
    let media: MediaReport | null = null;
    // 交不上(上传通道没就绪)是 null:调用方自己提示「还没开始上传」并重试到交上为止
    try { media = await deps.queueMedia(); } catch { media = null; }
    at("done");
    return { ok: true, kind: source.kind, projectId, name: made.name, link: deps.linkOf(projectId), media };
  }
}

/* ---------------- 内容的上传与读回(真的文档连接) ---------------- */

export interface ContentLinkOptions {
  /** 云端文档服务的 WebSocket 地址(`wss://<账号云端>/hosted/`) */
  url: string;
  /** 取一张连接票据(每建一个会话取一次;背后的访问令牌要够用) */
  ticket: () => Promise<string>;
  /** 整件事最多等多久(只为防卡死) */
  timeoutMs?: number;
  WebSocketImpl?: unknown;
  /** 测试用:拿到这条连接(掐传输、断会话) */
  onLink?: (link: SyncLink) => void;
}

export const CONTENT_TIMEOUT_MS = 180_000;

class ContentLinkError extends Error {
  status?: number;
  code: string;
  constructor(code: string, status?: number) { super(code); this.code = code; if (status !== undefined) this.status = status; }
}

let contentSeq = 0;

/** 开一条只为这次搬迁用的文档连接,跑完就关。`run` 里用 `until` 等条件;连接被拒、超时、提交被拒都让整件事失败 */
async function withContentLink<T>(o: ContentLinkOptions, projectId: string, initial: Project,
  run: (link: SyncLink, until: (check: () => boolean) => Promise<void>) => Promise<T>): Promise<T> {
  let kill!: (error: unknown) => void;
  let dead: unknown = null;
  const died = new Promise<never>((_, reject) => { kill = (error) => { if (!dead) { dead = error; reject(error); } }; });
  died.catch(() => undefined);
  const rand = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 10);
  const link: SyncLink = new SyncLink({
    url: o.url, projectId, session: `move-${++contentSeq}-${rand}`, initial, initialize: false,
    protocols: async () => ["promptcut.v1", `promptcut.account.${await o.ticket()}`],
    // 关闭码不当终局(账号连接上 4003 也用在权限变化),该不该再连由取票据的接口说了算
    isFatalClose: () => false,
    onProtocolError: (error) => {
      const s = statusOf(error);
      if (s === 401 || s === 403 || s === 404) { kill(new ContentLinkError(codeOf(error) || "refused", s)); return true; }
      return false;
    },
    // 这条连接背后的访问令牌到期:按断线处理,凭新票据重建会话,没确认的提交在新会话上补发
    onAuthExpired: () => link.expire(),
    ...(o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl as never } : {}),
  });
  const offNotice = link.ds.on("notice", (n) => {
    if (n.kind === "rejected") kill(new ContentLinkError(`rejected:${n.reason}`));
    else if (n.kind === "replay-dropped") kill(new ContentLinkError("replay-dropped"));
  });
  const offStatus = link.ds.on("status", (s) => { if (s === "paused") kill(new ContentLinkError("paused")); });
  const timer = setTimeout(() => kill(new ContentLinkError("timeout")), o.timeoutMs ?? CONTENT_TIMEOUT_MS);
  const until = async (check: () => boolean) => {
    while (!check()) {
      if (dead) throw dead;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  link.start();
  o.onLink?.(link);
  try { return await Promise.race([run(link, until), died]); }
  finally { clearTimeout(timer); offNotice(); offStatus(); link.stop(); }
}

const linkReady = (link: SyncLink) => link.ds.confirmedProject !== null && link.ds.status === "online";

/**
 * 把 `snapshot` 写成云端项目的内容:连上、拿到云端现在的内容,不一样就做一次根替换(大的由 `DocSync` 分片上传),等文档服务确认。
 * 云端已经是这份内容(上一次传到了、只是没来得及核对)就什么都不发。
 */
export async function uploadProjectContent(o: ContentLinkOptions, projectId: string, snapshot: Project): Promise<{ rev: number; wrote: boolean }> {
  return withContentLink(o, projectId, snapshot, async (link, until) => {
    await until(() => linkReady(link));
    let wrote = false;
    if (!sameContent(link.ds.confirmedProject, snapshot)) {
      wrote = true;
      link.ds.load(snapshot);
      await until(() => link.ds.unconfirmed === 0 && linkReady(link));
    }
    if (!sameContent(link.ds.confirmedProject, snapshot)) throw new ContentLinkError("not-landed");
    return { rev: link.ds.rev, wrote };
  });
}

/** 另开一条连接,把云端项目现在的内容读回来(核对用:这份是文档服务发回来的,不是本端自己算的) */
export async function readProjectContent(o: ContentLinkOptions, projectId: string, placeholder: Project): Promise<{ project: Project; rev: number }> {
  return withContentLink(o, projectId, placeholder, async (link, until) => {
    await until(() => linkReady(link));
    return { project: link.ds.confirmedProject!, rev: link.ds.rev };
  });
}

/* ---------------- 给用户看的字(草稿,待用户审;表在报告里) ---------------- */

export const ACCOUNT_MOVE_TEXT = {
  /** 设置里选了「放云端」、目标是账号云端时,表单上方的说明 */
  intro: "云端项目属于你的网站账号。点「确定」后把当前项目搬到云端，编辑器接着就在云端项目里；本机这一份保留为普通的本地项目。",
  loggedIn: (name: string) => `已登录：${name}`,
  checkingLogin: "正在检查登录状态…",
  needLogin: "搬到云端需要先登录网站账号。",
  loginButton: "登录账号",
  loginBusy: "正在登录…",
  nameLabel: "云端项目名",
  /** 上一次没做完、云端项目已经建好:再点「确定」接着做 */
  pending: (name: string) => `上次搬到云端没有做完，云端项目「${name}」已经建好。点「确定」接着做，不会多建一个。`,
  /** 协作房间点「搬到云端」时的确认框 */
  roomConfirm: (account: string) => `搬到云端后，云端会新建一个属于账号「${account}」的项目，内容和现在一样。\n本机协作会关闭，旧邀请码作废，原来的成员要用新的项目链接、登录自己的网站账号重新加入。\n确认搬到云端？`,
  stage: {
    check: "正在搬到云端：检查登录和项目…",
    create: "正在搬到云端：建立云端项目…",
    upload: "正在搬到云端：上传项目内容…",
    verify: "正在搬到云端：核对云端内容…",
    "pull-media": "正在搬到云端：把素材拉到这台电脑…",
    "close-local": "正在搬到云端：关闭本机协作…",
    "sync-last": "正在搬到云端：补传最后的修改…",
    enter: "正在搬到云端：进入云端项目…",
    "queue-media": "正在搬到云端：安排素材上传…",
    done: "正在搬到云端：收尾…",
  } as Record<MoveStage, string>,
  doneLocal: "已搬到云端，现在编辑的是云端项目。本机那一份保留为普通的本地项目。",
  doneRoom: "已搬到云端。本机协作已关闭，旧邀请码已作废；请把新的项目链接发给原来的成员，他们登录自己的网站账号后加入。",
  /** 搬完的气泡(带「复制项目链接」按钮) */
  toastLocal: "已搬到云端，可以将项目链接发给其他已登录成员。",
  toastRoom: "已搬到云端。本机协作已关闭、旧邀请码已作废，请把新的项目链接发给原来的成员。",
  copyLink: "复制项目链接",
  uploading: (n: number) => `素材还在后台上传（共 ${n} 个，含卡片声音；先传小尺寸、再传原尺寸）。传完之前，其他成员看到的是占位。`,
  uploaded: "素材和卡片源码都已传到云端。",
  uploadedWithMissing: (n: number) => `上传已结束，但有 ${n} 份素材文件在这台电脑上找不到，没有传上去，其他成员看不到它们。`,
  mediaNotQueued: "素材还没开始上传（上传通道还没就绪），正在自动重试；传上去之前，其他成员看到的是占位。",
  mediaRetrying: "素材上传出错，正在自动重试，会一直试到传上去。",
  cardsUploading: "卡片源码还在同步到云端。",
  cardsStuck: "卡片源码还没同步到云端（卡片同步没连上），其他成员暂时画不出自定义卡；连上后会自动补传。",
  /** 旧文件带着搬到云端时关掉的那个房间的关联:重开时当普通本地项目开,提示一次 */
  reopenedLocal: "这个文件原来的本机协作已在搬到云端时关闭，现在按普通的本地项目打开。",
} as const;

const unchanged = (kind: "local" | "room") => (kind === "room" ? "本机协作没有改动，原房间照常可用。" : "本机项目没有改动。");
const resume = "再点一次会接着用云端已经建好的那个项目，不会多建一个。";
/** 本机协作已经关掉之后的失败:现在打开的是本地项目,入口是设置里的「多用户协作 → 云端」 */
const again = "在项目设置里勾「多用户协作」、选云端、点「确定」，会接着用云端已经建好的那个项目，不会多建一个。";

/** 本机协作已经关掉之后的失败:当前内容存到本机文件了没有 */
const savedNote = (r: Extract<MoveResult, { ok: false }>) => (r.localSaved === false
  ? "最新内容还在这个窗口里、没能存到本机文件，请先手动保存；"
  : "最新内容已存在本机这份文件里；");

/** 失败时给用户的那句话:说清停在哪、本机现在是什么状态 */
export function moveFailureText(r: Extract<MoveResult, { ok: false }>, kind: "local" | "room"): string {
  const local = unchanged(kind);
  switch (r.error) {
    case "login-required": return ACCOUNT_MOVE_TEXT.needLogin;
    case "not-ready": return `现在还不能搬到云端（项目或协作身份尚未就绪）。${local}`;
    case "not-creator": return "只有以创建者身份进入的人能把协作房间搬到云端。";
    case "creator-password": return "要创建者密码才能搬到云端（搬完会关闭本机协作）。";
    case "bad-password": return r.localClosed ? "密码错误。" : `密码错误。${local}`;
    case "rate-limited": return `尝试太多次，等 60 秒后再试。${local}`;
    case "busy": return "另一个窗口正在搬这个项目，等它做完再试。";
    case "busy-editing": return r.localClosed
      ? `项目一直在被修改（可能有 Agent 或工具还在改），最后的修改没有追上。本机协作已关闭，${savedNote(r)}先让它停下，再搬一次：${again}`
      : `搬的过程中项目一直在被修改（可能有 Agent 或工具还在改），没有搬成。${local}先让它停下，再点一次；${r.cloud ? resume : "不会多建项目。"}`;
    case "save-pending": return `本机的修改还没保存完，没有开始搬。${local}`;
    case "too-large": return `项目内容太大（约 ${(Number(r.detail) / 1_000_000 || 0).toFixed(1)} 百万字符，上限 ${(MAX_CONTENT_CHARS / 1_000_000).toFixed(1)} 百万），暂时搬不上云端。${local}`;
    case "name-taken": return `这个项目名已被使用，请换一个名字。${local}`;
    case "invalid-name": return `项目名不能为空，不能超过 200 个字。${local}`;
    case "create-refused": return `这个账号现在不能新建云端项目（${r.detail || "被拒绝"}）。${local}`;
    case "not-account-cloud": return `这个云端不接受网站账号的项目，没有搬。${local}`;
    case "network": return r.stage === "create" ? `连不上云端，云端项目没有建成。${local}稍后再点一次。` : `连不上云端，没有开始搬。${local}`;
    case "create-failed": return `云端暂时不可用，云端项目没有建成。${local}稍后再点一次，不会多建一个。`;
    case "upload-failed": return `项目内容没有传完。${local}${resume}`;
    case "verify-failed": return `云端内容核对没通过，已停下。${local}${resume}`;
    case "media-pull-failed": return `有 ${Number(r.detail) || "一些"} 个素材还没拉到这台电脑，没有关闭本机协作。${local}等素材拉完再点一次。`;
    case "close-failed": return `云端项目已经建好并核对过，但本机协作没有关掉，现在仍是原来的房间。${resume}`;
    case "sync-last-failed": return `本机协作已关闭，${savedNote(r)}云端项目已建好，但缺最后的几处修改。再补一次：${again}`;
    case "enter-failed": return `已搬到云端${r.localClosed ? "，本机协作已关闭" : ""}，但这次没能进入云端项目「${r.cloud?.name ?? ""}」。${again}也可以回开始页用项目链接打开它。`;
  }
}
