/**
 * 页面的同步管理(c65-design.md 第 4、6、8、9 节):页面用 WebSocket 接文档服务、把 DocSync 挂上 store。
 *
 * - **本机项目**:连本机编辑器的 `/docservice`(回环什么都不带 = `local` 空间),项目号就是 `project.id`。
 *   载入另一个项目(开始页、打开 .proc、新建)时换一条连接、一个新的 DocSync,并把载入的内容以根替换写进去
 *   (打开的文件就是用户要的那一份);载入的还是同一个项目时是对它的一次根替换。
 * - **共享项目**:按进入时的连接(凭证明,`server/auth/client.mjs`),项目号就是共享项目的 `projectId`。
 *   在共享项目里载入别的项目 = 离开共享项目、回到本机空间(不会把别的文件整份盖到大家的项目上)。
 * - `?join=<项目号>`:第二个页面加入同一个本机项目,内容以文档服务为准,不做根替换(V2 的真实页面版用)。
 * - 无头实例(`?headless=1`)、只读查看、连不上本机文档服务时不接:store 照旧用快照栈。
 *
 * 界面状态(同步状态、离线对话框、撤销提示条、成员列表、阻断弹窗、气泡)放在这里的一个小仓库里,
 * 组件用 `useSync(selector)` 读。
 */
import { useSyncExternalStore } from "react";
import { bindStore, type LocalBackup, type PausedInfo, type SyncNotice, type SyncStatus, type UndoResult, type Writer } from "../../store/docsync";
import { actions, getState, subscribe } from "../../store/project";
import { entitiesOf, entityOfPath, type PathOp } from "../../kernel/diffProject";
import type { Project } from "../../kernel/project";
import { isViewOnly } from "../io/viewOnly";
import { SyncLink, type AnyMsg, type CloseInfo } from "./link";
import { client, errorStatus, route, type Candidate, type SharedMode, type Where } from "./sharedApi";
import { clipOfEntity, entityLabel, writerLabel, type DisplayNames, type Me } from "./labels";

/* ---------------- 界面状态 ---------------- */

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  /** 编辑器绑在局域网上(以 PROMPTCUT_LAN_HOST=1 启动):能当局域网主机 */
  lanHost: boolean;
  /** 页面是本机编辑器给的(回环地址打开);纯浏览器(在线浏览器模式)不能当局域网主机 */
  localEditor: boolean;
}

export interface MemberRow {
  deviceId: string | null;
  deviceName: string | null;
  username: string;
  displayName: string;
  creator: boolean;
  tags: { editing: boolean; rendering: boolean; agents: number };
  conns: { role: string; conversation?: number }[];
}

export interface SharedInfo {
  projectId: string;
  name: string;
  mode: SharedMode;
  where: Where;
  base: string;
  username: string;
  /** 以创建者身份进入 */
  creator: boolean;
  hostDeviceName?: string;
}

export interface UndoNoticeView {
  id: number;
  kind: "undo" | "redo" | "agent";
  result: UndoResult;
  /** 出提示时的项目(实体名按它取) */
  project: Project;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn";
}

export type Blocked = "kicked" | "removed" | "deleted";

export interface AgentOp {
  /** 事件 id(`events.event` 的 eventId) */
  eventId: string;
  /** 这次工具调用的 callId(事件里带了才有;AI 栏按它对上 SSE 的工具调用) */
  callId?: string;
  opId: string;
  inverse?: PathOp[];
  rev?: number;
  by?: Writer;
  state: "ready" | "done" | "none";
}

export interface SyncView {
  /** 页面接上了文档服务(不然 store 用快照栈) */
  active: boolean;
  kind: "local" | "shared" | "off";
  status: SyncStatus;
  paused: PausedInfo | null;
  offlineOpen: boolean;
  shared: SharedInfo | null;
  members: MemberRow[];
  blocked: Blocked | null;
  notice: UndoNoticeView | null;
  toasts: Toast[];
  device: DeviceInfo | null;
  /** AI 栏记录的版本号:agentOps 变了就加一 */
  agentOpsVersion: number;
}

let view: SyncView = {
  active: false,
  kind: "off",
  status: "idle",
  paused: null,
  offlineOpen: false,
  shared: null,
  members: [],
  blocked: null,
  notice: null,
  toasts: [],
  device: null,
  agentOpsVersion: 0,
};
const viewListeners = new Set<() => void>();

function patch(p: Partial<SyncView>) {
  view = { ...view, ...p };
  for (const l of viewListeners) l();
}

export function getSyncView(): SyncView {
  return view;
}

export function subscribeSync(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

export function useSync<T>(selector: (v: SyncView) => T): T {
  return useSyncExternalStore(subscribeSync, () => selector(view), () => selector(view));
}

let toastSeq = 0;
export function pushToast(text: string, tone: Toast["tone"] = "info", ms = 6000) {
  const t = { id: ++toastSeq, text, tone };
  patch({ toasts: [...view.toasts, t] });
  setTimeout(() => dismissToast(t.id), ms);
}

export function dismissToast(id: number) {
  if (!view.toasts.some((t) => t.id === id)) return;
  patch({ toasts: view.toasts.filter((t) => t.id !== id) });
}

let noticeSeq = 0;
export function dismissNotice() {
  patch({ notice: null });
}

/* ---------------- 连接 ---------------- */

interface Current {
  link: SyncLink;
  kind: "local" | "shared";
  docProjectId: string;
  unbind: () => void;
  offs: (() => void)[];
}

let cur: Current | null = null;
let started = false;
const session = `page-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12)}`;

export function pageSession(): string {
  return session;
}

/** 当前连着的项目号(本机项目是 project.id,共享项目是共享项目的 projectId);没接文档服务时是 project.id */
export function currentDocProjectId(): string {
  return cur?.docProjectId ?? getState().project.id ?? "";
}

/** 本页面是谁(撤销提示条里认「你在另一个页面」用) */
export function me(): Me {
  const s = view.shared;
  if (s && view.device) return { session, userId: `${s.username}@${view.device.deviceId}` };
  return { session, userId: "local" };
}

export function displayNames(): DisplayNames {
  const m: DisplayNames = new Map();
  for (const row of view.members) if (row.deviceId) m.set(`${row.username}@${row.deviceId}`, row.displayName);
  return m;
}

function localWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/docservice`;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** 设备信息:本机编辑器给的;纯浏览器用存在本地的随机 id 和浏览器名 */
async function loadDevice(): Promise<DeviceInfo | null> {
  try {
    const r = await fetch("/api/docservice/device", { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.ok) return null;
    return { deviceId: j.deviceId, deviceName: j.deviceName, lanHost: !!j.lanHost, localEditor: isLoopbackHost(location.hostname) };
  } catch {
    return null;
  }
}

/* ---------------- 本地备份 ---------------- */

async function saveBackup(b: LocalBackup) {
  const project = getState().project;
  const body =
    b.kind === "offline-discard"
      ? { ...b, projectName: project.name, pageSession: session, batch: b.batch.map((x) => ({ ...x, entities: entitiesOf(x.ops) })) }
      : { ...b, projectName: project.name, pageSession: session };
  try {
    const r = await fetch("/api/project-backups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    // 存不下来也要让用户知道:不能让他以为备份在那儿
    pushToast(`本地备份没存下来(${(e as Error).message}),被覆盖的那一版找不回了。`, "warn", 10_000);
  }
}

/* ---------------- 远端改动描边 ---------------- */

const FLASH_MS = 1500;

function flashEntities(entities: string[]) {
  if (typeof document === "undefined") return;
  const ids = new Set<string>();
  const project = getState().project;
  for (const e of entities) {
    const clip = clipOfEntity(e);
    if (clip) ids.add(clip);
    const track = /^\/tracks\/@([^/]+)$/.exec(e);
    if (track) for (const c of project.tracks.find((t) => t.id === track[1])?.clips ?? []) ids.add(c.id);
  }
  if (!ids.size) return;
  // 等这次改动渲染出来再找元素(新插进来的片段这时才有 DOM)。用计时器不用 rAF:页面在后台时 rAF 不跑
  setTimeout(() => {
    for (const id of ids) {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`)) {
        el.setAttribute("data-remote-flash", "");
        const prev = Number(el.dataset.remoteFlashTimer || 0);
        if (prev) clearTimeout(prev);
        el.dataset.remoteFlashTimer = String(
          setTimeout(() => {
            el.removeAttribute("data-remote-flash");
            delete el.dataset.remoteFlashTimer;
          }, FLASH_MS),
        );
      }
    }
  }, 30);
}

/* ---------------- 绑定 ---------------- */

function onNotice(n: SyncNotice) {
  switch (n.kind) {
    case "undo":
    case "revert-remote": {
      const r = n.result;
      if (!r.skipped.length && !r.failed.length) return;
      patch({ notice: { id: ++noticeSeq, kind: n.kind === "undo" ? (n.redo ? "redo" : "undo") : "agent", result: r, project: getState().project } });
      return;
    }
    case "overwritten": {
      // 文案按交互稿第 5 节,「找回入口待裁定」换成裁定定下的入口(c65-design.md 第 8 节)
      const who = writerLabel(n.by, me(), displayNames());
      pushToast(`你的近期修改已被 ${who} 覆盖。已将你修改的版本存入草稿备份（「项目」菜单 →「本地备份…」可找回）。`, "warn", 10_000);
      return;
    }
    case "remote":
      flashEntities(n.entities);
      return;
    case "rejected":
      pushToast(`有一步修改没被文档服务接受(${n.reason}),已撤回。`, "warn");
      return;
    case "replay-dropped":
      pushToast("有一步离线时的修改在最新版本上落不下去,已丢弃。", "warn");
      return;
    default:
      return;
  }
}

function refreshStatus() {
  if (!cur) return;
  const ds = cur.link.ds;
  const status = ds.status;
  const paused = ds.pausedInfo;
  patch({ status, paused, offlineOpen: status === "paused" ? view.offlineOpen || view.status !== "paused" : false });
}

function bind(link: SyncLink, kind: "local" | "shared", docProjectId: string) {
  const prev = cur;
  if (prev) {
    for (const off of prev.offs) off();
    prev.unbind();
  }
  const unbind = bindStore(link.ds, { load: onLoad });
  const offs = [
    link.ds.on("status", () => refreshStatus()),
    link.ds.on("notice", onNotice),
  ];
  cur = { link, kind, docProjectId, unbind, offs };
  patch({ active: true, kind, members: kind === "local" ? [] : view.members, notice: null });
  refreshStatus();
  if (prev && prev.link !== link) retire(prev.link);
}

/** 换下来的连接:等它手里没确认的提交落地(最多 5 s)再关 */
function retire(link: SyncLink) {
  link.ds
    .whenSettled({ timeoutMs: 5000 })
    .catch(() => undefined)
    .finally(() => link.stop());
}

function newLocalLink(docProjectId: string, initial: Project): SyncLink {
  return new SyncLink({
    url: localWsUrl(),
    protocols: () => ["promptcut.v1"],
    projectId: docProjectId,
    session,
    initial,
    saveBackup: (b) => void saveBackup(b),
    onMessage: onSideMessage,
  });
}

/** 切到本机空间里的这个项目;`load` 为真时把这份内容以根替换写进去(文件内容为准) */
function switchToLocal(project: Project, { load }: { load: boolean }): Project {
  const id = project.id || "untitled";
  const link = newLocalLink(id, project);
  if (load) link.ds.load(project);
  bind(link, "local", id);
  patch({ shared: null, members: [], blocked: null });
  link.start();
  return link.ds.project;
}

/** store 的载入(loadProject)交到这里:同一个本机项目是根替换,别的项目换连接 */
function onLoad(project: Project): Project {
  if (cur && cur.kind === "local" && project.id === cur.docProjectId) return cur.link.ds.load(project);
  return switchToLocal(project, { load: true });
}

/* ---------------- 其余消息:成员、事件、通知 ---------------- */

const agentOps = new Map<string, AgentOp>();

function asOps(v: unknown): PathOp[] | undefined {
  return Array.isArray(v) && v.length ? (v as PathOp[]) : undefined;
}

function rememberEvent(e: Record<string, unknown>) {
  const opId = typeof e.opId === "string" ? e.opId : null;
  const eventId = typeof e.eventId === "string" ? e.eventId : null;
  if (!opId || !eventId) return;
  const callId = typeof e.callId === "string" ? e.callId : typeof e.toolCallId === "string" ? e.toolCallId : undefined;
  const actor = e.actor as { session?: string } | undefined;
  const prev = agentOps.get(eventId);
  const rec: AgentOp = {
    eventId,
    callId,
    opId,
    inverse: asOps(e.inverse) ?? prev?.inverse,
    rev: typeof e.rev === "number" ? e.rev : prev?.rev,
    by: actor ? { actor, session: actor.session } : prev?.by,
    state: prev?.state === "done" ? "done" : "ready",
  };
  agentOps.set(eventId, rec);
  if (callId) agentOps.set(`call:${callId}`, rec);
  patch({ agentOpsVersion: view.agentOpsVersion + 1 });
}

function onSideMessage(msg: AnyMsg) {
  switch (msg.type) {
    case "shared.members.list":
      patch({ members: Array.isArray(msg.devices) ? (msg.devices as MemberRow[]) : [] });
      return;
    case "shared.notice":
      if (msg.event === "password-changed") pushToast("项目密码已被修改。你当前的连接不受影响，但下次进入需要新密码。", "info", 8000);
      return;
    case "events.event":
      rememberEvent(msg as Record<string, unknown>);
      return;
    case "events.listing":
      for (const it of Array.isArray(msg.items) ? msg.items : []) rememberEvent(it as Record<string, unknown>);
      return;
    default:
      return;
  }
}

/* ---------------- 验收用的钩子(只在开发模式) ---------------- */

if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as unknown as { __pcSyncTest?: unknown }).__pcSyncTest = {
    /** 断网 ms 毫秒(离线对话框的验收) */
    drop: (ms: number) => cur?.link.dropFor(ms),
    /** 交一条文档服务消息给页面(AI 栏「撤销这一步」:事件里的 opId 与 inverse 眼下由 c65-agent 那一路补) */
    inject: (msg: AnyMsg) => onSideMessage(msg),
    view: () => view,
    docProjectId: () => currentDocProjectId(),
    rev: () => cur?.link.ds.rev ?? null,
    agentOp: (callId: string) => agentOpFor(callId),
  };
}

/* ---------------- 启动 ---------------- */

/** 编辑器挂上时调一次(幂等)。连不上本机文档服务就什么都不接 */
export async function startSync(): Promise<void> {
  if (started) return;
  started = true;
  const q = new URLSearchParams(location.search);
  if (q.has("headless") || isViewOnly()) return;
  const device = await loadDevice();
  if (!device) return;
  patch({ device });
  const join = q.get("join");
  if (join) {
    const link = newLocalLink(join, getState().project);
    bind(link, "local", join);
    link.start();
    return;
  }
  switchToLocal(getState().project, { load: true });
}

/** `?join=` 打开的页面:内容以文档服务为准,演示卡之类的开场填充不要做 */
export function isJoinPage(): boolean {
  try {
    return new URLSearchParams(location.search).has("join");
  } catch {
    return false;
  }
}

/* ---------------- 保存 ---------------- */

/** `.proc` 只在所有本地修改都拿到确认之后写(语义「项目文件」);没接文档服务时直接放行 */
export async function whenSaved(timeoutMs = 10_000): Promise<void> {
  if (!cur) return;
  await cur.link.ds.whenSettled({ timeoutMs });
}

/* ---------------- 离线 ---------------- */

export function setOfflineOpen(open: boolean) {
  patch({ offlineOpen: open });
}

export function replayOffline() {
  cur?.link.ds.replayOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}

export function discardOffline() {
  cur?.link.ds.discardOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}

/** 离线对话框里「这段时间项目有以下改动」:谁改了哪些实体 */
export function pausedSummary(): { who: string; what: string[] }[] {
  const since = view.paused?.since ?? [];
  const project = getState().project;
  return since.map((s) => {
    const actor = s.actor as Record<string, unknown> | undefined;
    const entities = (s as { entities?: string[] }).entities ?? (s.paths ?? []).map(entityOfPath);
    return {
      who: writerLabel({ actor, session: s.session ?? (actor?.session as string | undefined) }, me(), displayNames()),
      what: [...new Set(entities.map((e) => entityLabel(e, project)))],
    };
  });
}

/* ---------------- 撤销:跳过去看 ---------------- */

export function jumpToEntity(entity: string) {
  const clip = clipOfEntity(entity);
  const project = getState().project;
  if (clip) {
    const c = project.tracks.flatMap((t) => t.clips).find((x) => x.id === clip);
    if (!c) return;
    actions.select([clip]);
    actions.seek(c.start);
    document.querySelector(`[data-clip-id="${CSS.escape(clip)}"]`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
    return;
  }
  if (entity.startsWith("/meta/")) window.dispatchEvent(new Event("pc-open-project-settings"));
}

/* ---------------- AI 栏「撤销这一步」 ---------------- */

export function agentOpFor(callId: string | undefined): AgentOp | null {
  if (!callId) return null;
  return agentOps.get(`call:${callId}`) ?? agentOps.get(callId) ?? null;
}

/** 撤 Agent 那一步:以本页面身份提交逆操作 + undoOf,进本页面的撤销栈 */
export function revertAgentOp(rec: AgentOp): UndoResult | null {
  if (!cur) return null;
  const ds = cur.link.ds;
  if (!ds.canRevertRemote(rec.opId, rec.inverse)) {
    pushToast("这一步的改动记录不在本页面上,撤不了。", "warn");
    return null;
  }
  const result = ds.revertRemote({ opId: rec.opId, inverse: rec.inverse, rev: rec.rev, by: rec.by });
  if (result.done) {
    rec.state = "done";
    patch({ agentOpsVersion: view.agentOpsVersion + 1 });
  }
  return result;
}

/* ---------------- 共享项目 ---------------- */

export type EnterError = "auth" | "rate-limited" | "unreachable" | "no-project" | "kicked" | "not-ready";

export interface EnterCredentials {
  as: "member" | "creator";
  username: string;
  password: string;
}

const KICKED_KEY = "pc.shared.kicked";
const CREATORS_KEY = "pc.shared.creators";

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "");
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 存不了就算了:只影响提示文案 */
  }
}

/** 这台设备上建过的共享项目的创建者用户名(打开时「我是创建者」预填用) */
export function knownCreator(projectId: string): string | null {
  return readJson<Record<string, string>>(CREATORS_KEY, {})[projectId] ?? null;
}

function rememberCreator(projectId: string, username: string) {
  writeJson(CREATORS_KEY, { ...readJson<Record<string, string>>(CREATORS_KEY, {}), [projectId]: username });
}

function kickedKey(projectId: string, username: string) {
  return `${projectId}\n${username}`;
}

function rememberKicked(projectId: string, username: string, on: boolean) {
  const all = readJson<Record<string, number>>(KICKED_KEY, {});
  if (on) all[kickedKey(projectId, username)] = Date.now();
  else delete all[kickedKey(projectId, username)];
  writeJson(KICKED_KEY, all);
}

function wasKicked(projectId: string, username: string): boolean {
  return !!readJson<Record<string, number>>(KICKED_KEY, {})[kickedKey(projectId, username)];
}

/** 当前连接上的创建者密钥:只活在一次创建者操作里(每次当场输密码) */
function deviceOrThrow(): DeviceInfo {
  if (!view.device) throw new Error("没连上本机编辑器");
  return view.device;
}

/**
 * 进入共享项目:取挑战、凭证明连上;连上之后本页面改连这个项目的空间,项目内容以文档服务为准
 * (项目还空着时,DocSync 把当前这份以根替换写进去 —— 新建共享项目就是这样把当前项目带过去的)。
 */
export async function enterShared(candidate: Candidate, cred: EnterCredentials): Promise<{ ok: true } | { ok: false; error: EnterError }> {
  let device: DeviceInfo;
  try {
    device = deviceOrThrow();
  } catch {
    return { ok: false, error: "not-ready" };
  }
  let key: string | undefined;
  const make = () =>
    client.buildAuthProtocols({
      base: candidate.base,
      projectId: candidate.projectId,
      username: cred.username,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      as: cred.as,
      ...(key ? { key } : { password: cred.password }),
      role: "page",
      onKey: (k) => {
        key = k;
      },
    });
  // 先取一次挑战:限速(429)、项目没了(404)、连不上,在这一步就分得清
  let first: string[] | null;
  try {
    first = await make();
  } catch (e) {
    const { status } = errorStatus(e);
    if (status === 429) return { ok: false, error: "rate-limited" };
    if (status === 404) return { ok: false, error: "no-project" };
    return { ok: false, error: "unreachable" };
  }
  const outcome = await new Promise<"open" | CloseInfo>((resolve) => {
    let settled = false;
    const link = new SyncLink({
      url: route.wsBaseOf(candidate.base),
      protocols: () => {
        if (first) {
          const p = first;
          first = null;
          return p;
        }
        return make();
      },
      projectId: candidate.projectId,
      session,
      initial: getState().project,
      saveBackup: (b) => void saveBackup(b),
      onMessage: onSideMessage,
      onOpen: () => {
        if (settled) {
          // 重连上了:重新订阅成员变化
          link.send({ type: "shared.watch" });
          return;
        }
        settled = true;
        bind(link, "shared", candidate.projectId);
        patch({
          shared: { projectId: candidate.projectId, name: candidate.name, mode: candidate.mode, where: candidate.where, base: candidate.base, username: cred.username, creator: cred.as === "creator", hostDeviceName: candidate.hostDeviceName },
          members: [],
          blocked: null,
        });
        rememberKicked(candidate.projectId, cred.username, false);
        if (cred.as === "creator") rememberCreator(candidate.projectId, cred.username);
        link.send({ type: "shared.watch" });
        link.send({ type: "events.list", projectId: candidate.projectId });
        resolve("open");
      },
      onClosed: (info) => {
        if (!settled) {
          if (info.neverOpened && info.reason !== "protocols") {
            settled = true;
            link.stop();
            resolve(info);
          }
          return;
        }
        if (info.fatal && cur?.link === link) {
          const blocked: Blocked = info.code === 4004 ? "deleted" : info.reason === "removed" ? "removed" : "kicked";
          if (blocked === "kicked") rememberKicked(candidate.projectId, cred.username, true);
          patch({ blocked });
        }
        refreshStatus();
      },
    });
    link.start();
    setTimeout(() => {
      if (settled) return;
      settled = true;
      link.stop();
      resolve({ code: 0, reason: "timeout", fatal: false, neverOpened: true });
    }, 15_000);
  });
  if (outcome === "open") return { ok: true };
  if (outcome.reason === "timeout") return { ok: false, error: "unreachable" };
  return { ok: false, error: wasKicked(candidate.projectId, cred.username) ? "kicked" : "auth" };
}

/** 被踢 / 被移出 / 项目被删之后点「开始页」:回到本机空间,回开始页 */
export function leaveBlocked() {
  patch({ blocked: null, shared: null, members: [] });
  switchToLocal(getState().project, { load: false });
  window.dispatchEvent(new Event("pc-go-home"));
}

/* ---------------- 创建者操作 ---------------- */

export type AdminError = "forbidden" | "rate-limited" | "bad-message" | "offline" | "other";

/**
 * 做一次创建者操作(契约 `auth-contract.md` 第 7 节):同一连接取挑战、按创建者密码派生 K、算证明、发 `shared.admin`。
 * 密码每次当场给(不缓存);`key` 是同一次操作流程里刚验证过的那份 K(验证身份与真正的操作是两次证明)。
 */
export async function adminOp(
  op: string,
  auth: { password?: string; key?: string },
  fields: Record<string, unknown> = {},
): Promise<{ ok: true; reply: AnyMsg; key: string } | { ok: false; error: AdminError }> {
  const s = view.shared;
  if (!cur || cur.kind !== "shared" || !s) return { ok: false, error: "offline" };
  const link = cur.link;
  let ch: AnyMsg;
  try {
    ch = await link.request({ type: "shared.challenge" });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (ch.type !== "shared.challenge.ok") return { ok: false, error: ch.reason === "rate-limited" ? "rate-limited" : "forbidden" };
  const key = auth.key ?? (await client.deriveKey(auth.password ?? "", ch.salt as string, ch.kdf as never));
  const m = await client.adminProof({ key, projectId: s.projectId, username: s.username, op, nonce: ch.nonce as string });
  let reply: AnyMsg;
  try {
    reply = await link.request({ type: "shared.admin", op, proof: { nonce: ch.nonce, m }, ...fields });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (reply.type === "shared.admin.ok") return { ok: true, reply, key };
  const reason = String(reply.reason ?? "");
  return { ok: false, error: reason === "forbidden" || reason === "rate-limited" || reason === "bad-message" ? (reason as AdminError) : "other" };
}

/** 新的一份口令凭证(改项目密码、改名单、改创建者密码用),kdf 与项目记录一致用缺省 */
export function makeCredential(password: string) {
  return client.makeCredential(password);
}
