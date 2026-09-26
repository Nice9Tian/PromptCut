/**
 * 页面这一侧的两档素材(`docs/plan/c66-design.md` 第 4 节;任务书 `docs/plan/cloud-task.md` A1「换档判据」):
 *
 * - **轮询**:每 2 秒向**当前连接的素材服务**问 `GET media/<hash>/chunks`,把报 `complete` 的哈希集合交给
 *   换档判据(`src/render/mediaTier.ts` 的 `chooseTier`):舞台经 `setLocalHashes` 下发、主文档的声音层直接读。
 *   只问还没到顶档的那一档:原片到齐了这份素材就不再问;哈希不可变,问到齐的不会再变回去。
 *   连本地素材服务时问的是本机 `/api/asset`;进了共享项目问的是那个项目的远程素材服务(带只读素材票据)——
 *   本机缓存落没落盘不作判据(asset-storage.md「同步状态只问素材服务」)。
 * - **远程素材服务**:进入共享项目时由 `syncManager` 设(`connectSharedAssets`),同时告诉本机编辑器进程
 *   (`POST /api/media/remote`),读路由才会按需拉取、预取队列才会动。票据按时续签后再推一次。
 * - **预取**:项目的素材表变了(打开项目、导入)且连着远程素材服务时,把 `prefetchOrder` 的清单交给编辑器进程。
 * - **导出前的拦截**:`exportGate` 问当前素材服务,时间轴上用到的原片哪些还没 `complete`。
 *
 * 集合里带一个标记(`TIERS_KNOWN_LOCAL` / `TIERS_KNOWN_REMOTE`):「问过了、一个都没到齐」和「还没问过」分得开。
 */
import { useSyncExternalStore } from "react";
import type { Project } from "../../kernel/project";
import { getState, subscribe } from "../../store/project";
import {
  TIERS_KNOWN_LOCAL, TIERS_KNOWN_REMOTE, missingOriginals, originalHashOf, prefetchOrder, smallHashOf, type MissingOriginal,
} from "../../render/mediaTier";

/** 轮询间隔(A1:每 2 秒) */
export const POLL_MS = 2000;
/** 同一轮里同时在飞的 `chunks` 请求数 */
const POLL_CONCURRENCY = 4;
/** 素材票据的有效期(`server/auth/protocol.mjs` 的 `TICKET_TTL.asset`);剩 1/3 时续签 */
const ASSET_TICKET_TTL_MS = 15 * 60_000;

export interface RemoteAssets {
  /** 远程素材服务的 API 基址,形如 `http://<ip>:<port>/api/asset` */
  base: string;
  /** 取一张只读素材票据;取不到给 null(那就不带,由素材服务回 401) */
  ticket?: () => Promise<string | null>;
}

const LOCAL_BASE = "/api/asset";

let remote: RemoteAssets | null = null;
/** 当前素材服务上到齐的哈希(换了素材服务就清空) */
let complete = new Set<string>();
let known = false;
let snapshot: readonly string[] = [];
let serviceGen = 0;
const listeners = new Set<() => void>();

function publish() {
  const next = known ? [remote ? TIERS_KNOWN_REMOTE : TIERS_KNOWN_LOCAL, ...[...complete].sort()] : [];
  if (next.length === snapshot.length && next.every((h, i) => h === snapshot[i])) return;
  snapshot = next;
  for (const l of [...listeners]) l();
}

/** 换档判据用的集合(带标记);还没问过是空数组 */
export function tierHashes(): readonly string[] {
  return snapshot;
}

export function subscribeTierHashes(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useTierHashes(): readonly string[] {
  return useSyncExternalStore(subscribeTierHashes, tierHashes, tierHashes);
}

/** 当前连的是不是远程素材服务(基址);本地给 null */
export function remoteAssetBase(): string | null {
  return remote?.base ?? null;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!remote?.ticket) return {};
  try {
    const t = await remote.ticket();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

let pushedTicket: string | null = null;
/** 告诉本机编辑器进程(按需拉取与预取靠它);在线浏览器模式没有本机编辑器,失败就算了 */
async function pushRemoteToEditor(): Promise<void> {
  try {
    if (!remote) {
      pushedTicket = null;
      await fetch("/api/media/remote", { method: "DELETE" });
      return;
    }
    const auth = await authHeaders();
    const ticket = auth.Authorization ? auth.Authorization.slice("Bearer ".length) : null;
    pushedTicket = ticket;
    await fetch("/api/media/remote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: remote.base, ticket }) });
  } catch { /* 没有本机编辑器 */ }
}

/**
 * 设当前连接的远程素材服务;null = 回到本地素材服务。换了就清空集合、立刻重问一轮、重排预取。
 */
export function setRemoteAssets(next: RemoteAssets | null): void {
  const base = next ? next.base.replace(/\/+$/, "") : null;
  if ((remote?.base ?? null) === base) {
    if (next && remote) remote.ticket = next.ticket;
    return;
  }
  remote = next ? { ...next, base: base! } : null;
  serviceGen++;
  complete = new Set();
  known = false;
  publish();
  lastPrefetchKey = "";
  void pushRemoteToEditor().then(() => { kick(); });
}

/**
 * 问当前素材服务:这些哈希里哪些 `complete`。问不到的算没到齐。
 */
export async function askComplete(hashes: readonly string[]): Promise<Set<string>> {
  const base = remote?.base ?? LOCAL_BASE;
  const headers = await authHeaders();
  const out = new Set<string>();
  const queue = [...new Set(hashes)];
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      try {
        const r = await fetch(`${base}/media/${h}/chunks`, { headers, cache: "no-store" });
        if (!r.ok) continue;
        const body = await r.json();
        if (body?.complete === true) out.add(h);
      } catch { /* 算没到齐 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, worker));
  return out;
}

/** 这一轮要问的哈希:原片还没到齐的素材问原片,小版还没到齐的也问小版;全到顶档的不问 */
export function hashesToAsk(project: Pick<Project, "media">, done: ReadonlySet<string>): string[] {
  const ask: string[] = [];
  for (const m of project.media ?? []) {
    const o = originalHashOf(m);
    if (!o || done.has(o)) continue;
    ask.push(o);
    const s = smallHashOf(m);
    if (s && !done.has(s)) ask.push(s);
  }
  return [...new Set(ask)];
}

/** 跑一轮轮询(导出前、切换素材服务后也直接调) */
export async function pollOnce(project: Pick<Project, "media"> = getState().project): Promise<void> {
  const gen = serviceGen;
  const ask = hashesToAsk(project, complete);
  const got = ask.length ? await askComplete(ask) : new Set<string>();
  if (gen !== serviceGen) return; // 这一轮问的是换掉之前的素材服务
  for (const h of got) complete.add(h);
  known = true;
  publish();
}

/* ---------------- 预取 ---------------- */

let lastPrefetchKey = "";
async function maybePrefetch(project: Project): Promise<void> {
  if (!remote) return;
  const items = prefetchOrder(project);
  const key = `${remote.base}|${items.map((i) => i.hash).join(",")}`;
  if (key === lastPrefetchKey) return;
  lastPrefetchKey = key;
  try {
    await fetch("/api/media/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
  } catch { /* 没有本机编辑器 */ }
}

/* ---------------- 轮询循环 ---------------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
let polling = false;

function kick() {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = null;
  void loop();
}

async function loop() {
  if (polling) return;
  polling = true;
  try {
    const project = getState().project;
    // 票据续签过:编辑器进程那份也换掉(它拿这张去按需拉取)
    if (remote?.ticket) {
      const auth = await authHeaders();
      const t = auth.Authorization ? auth.Authorization.slice("Bearer ".length) : null;
      if (t && t !== pushedTicket) await pushRemoteToEditor();
    }
    await pollOnce(project);
    await maybePrefetch(project);
  } finally {
    polling = false;
    if (running && !timer) timer = setTimeout(() => { timer = null; void loop(); }, POLL_MS);
  }
}

/**
 * 开始轮询(预览挂上时调),回停止函数。素材表换了(打开别的项目、导入)立刻问一轮,不等 2 秒。
 * 可以重复调,引用计数。
 */
export function startAssetTiers(): () => void {
  running++;
  let lastMedia = getState().project.media;
  const unsub = subscribe(() => {
    const media = getState().project.media;
    if (media === lastMedia) return;
    lastMedia = media;
    kick();
  });
  if (running === 1) {
    // 页面重载过:编辑器进程那边可能还留着上一个页面设的远程素材服务,按本页面的状态对齐一次
    void pushRemoteToEditor();
    kick();
  }
  return () => {
    unsub();
    running = Math.max(0, running - 1);
    if (!running && timer) { clearTimeout(timer); timer = null; }
  };
}

/* ---------------- 导出前的拦截 ---------------- */

/**
 * 导出前问一遍当前素材服务:时间轴上用到的原片哪些还没 `complete`(A1「导出只用原片」「等待上传方」)。
 * 空数组 = 可以导出。
 */
export async function exportGate(project: Project): Promise<MissingOriginal[]> {
  const first = missingOriginals(project, []);
  if (!first.length) return [];
  const got = await askComplete(first.map((m) => m.hash));
  for (const h of got) complete.add(h);
  return missingOriginals(project, got);
}

/** 不发请求的快速判断:按轮询到的集合。还没问过给 null(不知道) */
export function exportGateNow(project: Project): MissingOriginal[] | null {
  if (!known) return null;
  return missingOriginals(project, complete);
}

/* ---------------- 共享项目 ---------------- */

interface LinkLike {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** 按 `auth.ticket` 取只读素材票据,剩 1/3 有效期时换新的 */
export function assetTicketSource(link: LinkLike, now: () => number = Date.now): () => Promise<string | null> {
  let cur: { ticket: string; exp: number } | null = null;
  let inflight: Promise<string | null> | null = null;
  return async () => {
    if (cur && cur.exp - now() > ASSET_TICKET_TTL_MS / 3) return cur.ticket;
    inflight ??= link.request({ type: "auth.ticket", kind: "asset", access: "r" }).then((r) => {
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") {
        cur = { ticket: r.ticket, exp: Number(r.exp) || now() + ASSET_TICKET_TTL_MS };
        return cur.ticket;
      }
      return null;
    }, () => null).finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * 从文档服务的服务地址登记(`service.watch`,kind `asset`)里挑这个共享项目的素材服务:
 * 优先和文档服务同一台主机的那一个;指向本页面自己的(本机就是主机)不算远程。
 */
export function pickAssetEndpoint(endpoints: unknown, docBase: string, selfHost: string): string | null {
  const urls: string[] = [];
  for (const e of Array.isArray(endpoints) ? endpoints : []) {
    const rec = e as { kind?: unknown; urls?: unknown };
    if (rec?.kind !== undefined && rec.kind !== "asset") continue;
    for (const u of Array.isArray(rec?.urls) ? rec.urls : []) if (typeof u === "string") urls.push(u);
  }
  let docHost = "";
  try { docHost = new URL(docBase).hostname; } catch { /* 留空 */ }
  const ok = urls.filter((u) => { try { return new URL(u).host !== selfHost; } catch { return false; } });
  return ok.find((u) => { try { return new URL(u).hostname === docHost; } catch { return false; } }) ?? ok[0] ?? null;
}

/**
 * 进入共享项目后调:从服务地址登记里挑素材服务、设成当前远程素材服务。挑不到(本机就是主机、
 * 或主机没登记素材服务)就留在本地素材服务。回挑中的基址。
 */
export async function connectSharedAssets(link: LinkLike, docBase: string): Promise<string | null> {
  let base: string | null = null;
  try {
    const r = await link.request({ type: "service.watch", kinds: ["asset"] });
    base = pickAssetEndpoint(r.endpoints, docBase, typeof location === "undefined" ? "" : location.host);
  } catch { /* 取不到登记:留在本地 */ }
  setRemoteAssets(base ? { base, ticket: assetTicketSource(link) } : null);
  return base;
}

/** 离开共享项目:回到本地素材服务 */
export function disconnectSharedAssets(): void {
  setRemoteAssets(null);
}

/** 探针与单测的观察口 */
export function assetTiersDebug() {
  return { remote: remote?.base ?? null, known, complete: [...complete].sort(), snapshot: [...snapshot] };
}

/** 单测用 */
export function resetAssetTiersForTest(): void {
  remote = null;
  complete = new Set();
  known = false;
  snapshot = [];
  serviceGen++;
  lastPrefetchKey = "";
  listeners.clear();
}
