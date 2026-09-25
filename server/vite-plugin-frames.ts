import type { Plugin } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { captureCode, frameCode, invalidateFrameCode } from "./frame-code.mjs";
import { FramePipeline } from "./frame-pipeline.mjs";
import { unpackFrameArchive } from "./frame-archive.mjs";
import { overLimit } from "./http-guard.mjs";
import { prerenderState, proxyToPrerender } from "./prerender-client.mjs";
import { isPrerender } from "./render-role.mjs";
import { ensureMirror } from "./vite-plugin-mirror";

import { latestPlayhead, ensureMirror as ensureMirrorVersion, reportReadySession } from "./vite-plugin-mirror";
import { snapshotTier } from "./snapshot-store.mjs";
import { readySessionOf } from "./ready-index.mjs";
import { describeEnvironment } from "./render-node/fingerprint.mjs";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { assetServiceOrigin, setMediaFallbackBases, setMediaFallbackTicket } from "./asset-client";
import { renderProject } from "./render-project.mjs";

const services = new Map<string, FramePipeline>();
/** C6.4:每个帧库根上的推送队列怎么收尾(停队列、关文档服务连接);没建推送队列的根不在这里 */
const pushTeardowns = new Map<string, () => Promise<void>>();

const pushLog = (event: string, fields: object = {}) => {
  // 每段推完一条太吵(预渲染进程的 stdout 由编辑器进程收走),只打建队、跳过、重试和出错
  if (event === "push.done" || event === "push.empty") return;
  try { console.info("[artifact-push]", event, JSON.stringify(fields)); } catch { console.info("[artifact-push]", event); }
};

/**
 * C6.4 第 4 节末段的接线(`docs/plan/manifest-contract.md`;方案写在 `docs/reports/AGENT-c6-4-pipeline.md`):
 * 预渲染进程只在**同时**满足下面两条时才建推送队列,否则什么都不建,行为与现在相同 —— 这就是离线。
 *
 *   1. 能解析到素材服务的基址:`asset-client.ts` 的 `assetServiceOrigin()`(预渲染进程里就是 `PROMPTCUT_EDITOR_URL`),
 *      API 基址 `<源>/api/asset`;真正推到哪一台按 D7 选(`selectAssetClient`,契约 J.13);
 *   2. 能连上文档服务:`render-node` 的 `resolveDocservice()` 回 `remote`、`local` 或 `editor`(M5b J.3:编辑器里挂的
 *      那一份,地址从 `PROMPTCUT_EDITOR_URL` 推出)。**`editor` 只在显式要推送时才算**(契约 J.12):
 *      进程设了 `PROMPTCUT_QUEUE_NODE=1` 或 `PROMPTCUT_PUSH=1`。都没设时编辑器里挂的那一份不算,不建推送队列、
 *      preload 前也不拉别人的结果,行为与 C6.4 之前逐字节相同 —— 默认的开发环境(含用户常驻的编辑器)不变,
 *      探针能在同一个工作副本里反复跑。`remote`、`local`(显式设了地址、或起了独立文档服务)照旧建。
 *   3. `PROMPTCUT_PUSH=0`:一律不建,不管哪种模式。
 *
 * 无头实例(`PROMPTCUT_HEADLESS === "1"`)不建:它是临时副本,不往共享服务写东西(同 C6.3 的口径)。
 * 内容库客户端 `createContentClient` 在 `render-node/index.mjs` 里(C6.4 节点侧);取不到这个函数也不建。
 * 任何一步出错都只打日志,不影响预渲染进程。
 */
/**
 * 服务地址登记里**别的机器**的素材服务(J.6 素材回退与 J.13 推送基址共用这一个判据):本机登记的排除 ——
 * `announcerId` 是 `asset:<本机主机名>`(`asset-announce.mjs` 的缺省身份),或者地址与本机素材服务同 host。
 * 按 `announcerId` 的字典序排,每项只留不是本机的地址,留不下地址的整项去掉。
 */
function foreignAssetEndpoints(list: any[], origin: string | null): { announcerId: string; urls: string[] }[] {
  const self = `asset:${String(os.hostname() || "host").replace(/[^A-Za-z0-9._:-]/g, "-") || "host"}`.slice(0, 128);
  let selfHost = "";
  try { selfHost = origin ? new URL(origin).host : ""; } catch { /* 没有就不按地址排 */ }
  const out: { announcerId: string; urls: string[] }[] = [];
  for (const item of list ?? []) {
    if (item?.kind !== "asset" || typeof item.announcerId !== "string" || item.announcerId === self) continue;
    const urls: string[] = [];
    for (const url of item.urls ?? []) {
      try { if (new URL(url).host === selfHost) continue; } catch { continue; }
      urls.push(String(url));
    }
    if (urls.length) out.push({ announcerId: item.announcerId, urls });
  }
  return out.sort((a, b) => (a.announcerId < b.announcerId ? -1 : a.announcerId > b.announcerId ? 1 : 0));
}

/**
 * 推送、拉取用的素材服务客户端(契约 J.13,按 D7 选基址),顺序:
 *   1. `PROMPTCUT_ASSET_URL`(形如 `http://192.168.50.96:5460/api/asset`);
 *   2. 服务地址登记里别的机器的 `asset`(`foreignAssetEndpoints`),取第一个的第一个地址;登记变了就新建一个
 *      client 换上,在飞的请求照旧用旧的(回的是一个代理,每次调用时才取当前的 client);
 *   3. 本机的 `assetServiceOrigin()` 加 `/api/asset`(原来的行为)。
 * 读写带素材票据(M6a,`docs/plan/auth-contract.md` 第 8、11 节):凭共享项目进入的,经文档服务连接的 `auth.ticket` 取
 * (`ticket`);本机身份不带票据(本机回环的素材服务不要票据)。集群令牌不再用于素材服务。
 * 每换一次基址记一行 `push.asset-base { source, base }`,基址不含票据。
 */
function selectAssetClient({ node, endpoint, origin, ticket, createAssetClient, owner }:
  { node: any; endpoint: any; origin: string; ticket: ((opts?: { refresh?: boolean }) => Promise<string | null>) | null; createAssetClient: any; owner: string }) {
  const localBase = `${origin}/api/asset`;
  let current: any = null;
  let currentBase: string | null = null;
  const use = (base: string, source: "env" | "announced" | "local") => {
    if (base === currentBase && current) return;
    let next: any;
    try { next = createAssetClient({ base, ticket }); }
    catch (error: any) { pushLog("push.asset-base-error", { source, base, for: owner, message: String(error?.message ?? error) }); return; }
    current = next;
    currentBase = base;
    pushLog("push.asset-base", { source, base, for: owner });
  };
  const envBase = String(process.env.PROMPTCUT_ASSET_URL || "").trim().replace(/\/+$/, "");
  let stop = () => {};
  if (envBase) use(envBase, "env");
  if (!current) {
    use(localBase, "local");
    stop = node.watchServiceEndpoints(endpoint, ["asset"], (list: any[]) => {
      const url = foreignAssetEndpoints(list, origin)[0]?.urls[0];
      if (url) use(url.replace(/\/+$/, ""), "announced");
      else use(localBase, "local");
    });
  }
  const client = new Proxy({}, { get: (_target, key) => { const value = current?.[key]; return typeof value === "function" ? value.bind(current) : value; } });
  return { client, stop: () => { try { stop(); } catch { /* 已经停了 */ } }, base: () => currentBase };
}

/** `resolveDocservice` 这几种结果算「连得上文档服务」;`editor` 是 J.3 新加的(编辑器里挂的文档服务);`shared` 是 M6a 的共享项目配置 */
const DOCSERVICE_MODES = new Set(["remote", "local", "editor", "shared"]);

type DocLink = { mode: string; url: string; tried?: any[]; protocols?: () => Promise<string[]>; shared: boolean; projectId?: string | null };

/**
 * 连哪个文档服务、凭什么进入(M6a,`docs/plan/auth-contract.md` 第 11 节):
 *   - 设了 `PROMPTCUT_SHARED_CONFIG`:用配置的第一项(是数组时只取第一项,多项目留给独立主机),
 *     凭共享项目的证明进入,角色 `render`;素材票据经这条连接的 `auth.ticket` 取。配置读不了回 `bad-config`;
 *   - 没设:照原来按 `resolveDocservice` 探活(远端 → 编辑器 → 本机回环),不带任何凭证 —— 连回环时是本机身份,
 *     连不上就回落本机。集群令牌不再用于数据面。
 */
async function resolveDocLink(node: any): Promise<DocLink | { mode: string; tried?: any[]; url?: undefined; shared: false; detail?: string }> {
  if (process.env.PROMPTCUT_SHARED_CONFIG) {
    try {
      const { loadSharedConfig, sharedProtocols }: any = await import("./auth/shared-config.mjs");
      const entries = loadSharedConfig();
      const entry = entries[0];
      return { mode: "shared", url: entry.url, protocols: sharedProtocols(entry, { role: "render" }), shared: true, projectId: entry.projectId ?? null };
    } catch (error: any) {
      return { mode: "bad-config", shared: false, detail: String(error?.message ?? error) };
    }
  }
  const resolved = await node.resolveDocservice();
  return { mode: resolved?.mode, url: resolved?.url, tried: resolved?.tried, shared: false };
}

/** 凭共享项目进入的连接取素材票据;本机身份不要票据 */
async function ticketFor(link: DocLink, endpoint: any) {
  if (!link.shared) return null;
  const { createTicketSource }: any = await import("./auth/ticket-source.mjs");
  return createTicketSource(endpoint, { access: "rw" });
}
/**
 * 推送队列认哪几种文档服务(契约 J.12):`remote`、`local` 总认;`editor` 只在显式要推送时认 ——
 * `PROMPTCUT_QUEUE_NODE=1` 或 `PROMPTCUT_PUSH=1`。
 */
const pushModeAllowed = (mode: unknown) => mode === "remote" || mode === "local" || mode === "shared"
  || (mode === "editor" && (process.env.PROMPTCUT_QUEUE_NODE === "1" || process.env.PROMPTCUT_PUSH === "1"));
async function startArtifactPush(root: string, service: FramePipeline) {
  if (!isPrerender || process.env.PROMPTCUT_HEADLESS === "1") return;
  if (process.env.PROMPTCUT_PUSH === "0") return pushLog("push.skip", { reason: "disabled" });
  // M6b:独立渲染主机没有页面、不做 preload,产物由各项目节点的 sink 推(契约 render-host-contract 第 3 节「产物」)
  if (hostProfile()) return pushLog("push.skip", { reason: "host-profile" });
  const origin = assetServiceOrigin();
  if (!origin) return pushLog("push.skip", { reason: "no-asset-service" });
  const node: any = await import("./render-node/index.mjs");
  if (typeof node.createContentClient !== "function") return pushLog("push.skip", { reason: "no-content-client" });
  const resolved = await resolveDocLink(node);
  if (resolved.mode === "bad-config") return pushLog("push.skip", { reason: "bad-shared-config", detail: (resolved as any).detail });
  if (!DOCSERVICE_MODES.has(resolved?.mode) || !resolved.url) {
    return pushLog("push.skip", { reason: "docservice-offline", tried: (resolved?.tried ?? []).map((t: any) => ({ url: t.url, ok: t.ok, reason: t.reason })) });
  }
  // J.12:编辑器里挂的文档服务,没显式要推送就不建(开关关着时与 C6.4 之前相同)
  if (!pushModeAllowed(resolved.mode)) return pushLog("push.skip", { reason: "editor-docservice-not-enabled", mode: resolved.mode });
  if (services.get(root) !== service || (service as any).closed) return;
  const link = resolved as DocLink;
  const endpoint = node.createWsEndpoint({ url: link.url, ...(link.protocols ? { protocols: link.protocols } : {}), log: (event: string, fields: object) => {
    if (event === "ws.open" || event === "ws.close") pushLog(`docservice.${event}`, fields);
  } });
  const content = node.createContentClient(endpoint);
  const { createAssetClient }: any = await import("./asset-store/client.mjs");
  // J.13:按 D7 选推送的素材服务(环境变量 → 别的机器登记的 → 本机)
  const assets = selectAssetClient({ node, endpoint, origin, ticket: await ticketFor(link, endpoint), createAssetClient, owner: "push" });
  const client = assets.client;
  const { createPushQueue }: any = await import("./artifact-push.mjs");
  // settleMs:同一段最后一次进队后静置 1.5 s 再推,边渲边推时一段不被推十几遍
  const queue = createPushQueue({ pipeline: service, client, content, dir: service.root, log: pushLog, settleMs: 1500 });
  queue.start();
  pushTeardowns.set(root, async () => {
    try { await queue.stop(); } catch {}
    assets.stop();
    try { endpoint.close(); } catch {}
  });
  pushLog("push.started", { docservice: resolved.mode, url: resolved.url, asset: assets.base(), restored: queue.stats().restored });
}

/* ======================================================================== *
 * 队列模式的预渲染进程(契约 `docs/plan/render-queue-contract.md` J.5)
 * ======================================================================== */

/** 开关:`PROMPTCUT_QUEUE_NODE=1`,缺省关。关着时下面的东西一样都不建,行为与现在完全一样 */
const queueNodeSwitch = () => process.env.PROMPTCUT_QUEUE_NODE === "1";
/**
 * M6b(`docs/plan/render-host-contract.md`):`PROMPTCUT_NODE_PROFILE=host` 时这个预渲染进程是独立渲染主机 ——
 * 节点 `profile: 'host'`,`PROMPTCUT_SHARED_CONFIG` 每项一条 `render` 连接、一个节点,不发布也不认领 `plan`。
 * 其余取值(含不设)都是本机 PC 节点,行为与 M6a 相同。
 */
const hostProfile = () => process.env.PROMPTCUT_NODE_PROFILE === "host";
/**
 * 测试开关(M6b 探针 H2 用):主机节点对外报的代码版本改用这个值,不取 `frameCode(root)`。
 * 只影响 `profile: 'host'` 的 `codeVersions`(本机 PC 节点与帧库的键都不看它)。生产不设。
 */
const TEST_CODE_VERSION_ENV = "PROMPTCUT_TEST_CODE_VERSION";
/** 文档服务项目模块认的 projectId(`docservice/modules/project.mjs` 的 `PROJECT_ID_RE`) */
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** 发布 `plan` 之后等 `task.published` 的上限 */
const PUBLISH_TIMEOUT_MS = 10_000;
/** 节点节拍:续约、认领、让路都在这一拍里判 */
const QUEUE_TICK_MS = 500;
/** 诊断里留最近这么多条事件 */
const QUEUE_LOG = 80;
/** 诊断里本机节点认领 / 完成的任务 id,每类最多留几个 */
const MINE_MAX = 5000;

const queueLog = (event: string, fields: object = {}) => {
  try { console.info("[queue-node]", event, JSON.stringify(fields)); } catch { console.info("[queue-node]", event); }
};

type QueueNode = {
  /** 连着文档服务、本机节点已经报到:`/preload` 走队列模式 */
  active(): boolean;
  /** `/preload` 的队列那一半:报摘要、传快照、发布 `plan`。回 true = 这一版交给队列了;false = 本机自己产 */
  publish(session: string, project: any): Promise<boolean>;
  describe(): object;
  /** `GET /api/frames/queue`(契约 render-host-contract 第 3 节「诊断」):`{ nodes, codeVersion, envFingerprint, maxConcurrent }` */
  summary(): object;
  /** `POST /api/frames/queue/release`:让掉手里全部认领、停节点、关连接(主机退出前调)。回让掉的条数 */
  release(): Promise<number>;
  close(): Promise<void>;
};
const queueNodes = new Map<string, QueueNode>();

/**
 * 本机节点(PC 与独立渲染主机)`node.hello` 报的能力(M6c X1,`docs/plan/m6c-contract.md`):
 *   - `userCards: true, graphCards: false`:同 M5b / M6b;
 *   - `streams`:按实报 —— 预渲染管线有轨道流生产者、开关开着(`PROMPTCUT_STREAMS` 不是 0)、探到了能用的 H.264
 *     编码器(`FramePipeline.streamCapable`,一次进程只探一次)才是 true;
 *   - `transcode`:与 `streams` 同一个判据(本机有 ffmpeg 且编码器能用)。节点侧过滤的规则 2 对流任务同时查
 *     `requires.capabilities.streams` 与转码能力(B.2),只报 `streams` 的节点认领不了流任务。
 */
async function nodeCapabilities(service: FramePipeline) {
  let streams = false;
  try { streams = (await (service as any).streamCapable?.()) === true; } catch { streams = false; }
  return { userCards: true, graphCards: false, transcode: streams, streams };
}

/**
 * J.5:开关打开、又连得上文档服务时,在预渲染进程里起一个本机渲染节点,并替页面发布 `plan`。
 *
 *   - 节点:`createLocalNode`(`profile: 'pc'`、`maxConcurrent: 1`、`capabilities` 见 `nodeCapabilities`(M6c X1 起带 `streams`),
 *     `codeVersions: [frameCode(root)]`;环境指纹在报到前借一次流预渲染间来探),执行器是 J.4 的
 *     `createPrerenderExecutor`,产物库是 C6.2 / C6.4 的 `createAssetSink({ pipeline, client, content })`;
 *   - 发布:`/preload` 在 `service.preload(…, { queue: true })` 之前调 `publish`:`project.announce` 拿 `projectRev`、
 *     `putSnapshot` 传快照、以本节点的发布方身份发布 `plan:<projectId>@<projectRev>`(`requires` 带版本与指纹);
 *   - 收到 `task.done`:细任务的清单经 C6.2 的 `applyResult` 拉取并发布(本机产的已经在盘上,按「已有跳过」处理);
 *   - 连不上文档服务(断线):`service.leaveQueueMode()` 退回本机自己产,在跑的任务让掉;重连后新的 preload 再走队列;
 *   - 远端素材回退(J.6):订阅服务地址登记里的 `asset`,排除自己,填进 `setMediaFallbackBases`。
 *
 * `createProjectClient`(J.2)在 `render-node/index.mjs` 里;取不到它(svc 分支还没合进来)就不起,打日志,
 * 预渲染进程照原来的路径跑。任何一步出错都只打日志。
 */
async function startQueueNode(root: string, service: FramePipeline) {
  if (!isPrerender || !queueNodeSwitch() || process.env.PROMPTCUT_HEADLESS === "1") return;
  const origin = assetServiceOrigin();
  if (!origin) return queueLog("queue.skip", { reason: "no-asset-service" });
  const node: any = await import("./render-node/index.mjs");
  const missing = ["createProjectClient", "createContentClient", "createLocalNode", "createWsEndpoint", "planTaskOf", "watchServiceEndpoints"]
    .filter(name => typeof node[name] !== "function");
  if (missing.length) return queueLog("queue.skip", { reason: "render-node-exports-missing", missing });
  if (hostProfile()) return startHostNode(root, service, node, origin);
  const resolved = await resolveDocLink(node);
  if (resolved.mode === "bad-config") return queueLog("queue.skip", { reason: "bad-shared-config", detail: (resolved as any).detail });
  if (!DOCSERVICE_MODES.has(resolved?.mode) || !resolved.url) {
    return queueLog("queue.skip", { reason: "docservice-offline", tried: (resolved?.tried ?? []).map((t: any) => ({ url: t.url, ok: t.ok, reason: t.reason })) });
  }
  if (services.get(root) !== service || (service as any).closed) return;
  const link = resolved as DocLink;

  // 指纹:报到前借一次流预渲染间探(`leaseStreamBakery` 开起来就定下本进程的环境),什么都不做就还
  try {
    const bakery = await (service as any).leaseStreamBakery();
    (service as any).returnStreamBakery(bakery);
  } catch (error: any) {
    return queueLog("queue.skip", { reason: "no-environment", message: String(error?.message ?? error) });
  }
  const envFingerprint: string | null = (service as any).envFingerprint;
  if (!envFingerprint) return queueLog("queue.skip", { reason: "no-environment" });
  if (services.get(root) !== service || (service as any).closed) return;
  const capabilities = await nodeCapabilities(service);
  if (services.get(root) !== service || (service as any).closed) return;

  const { createPrerenderExecutor }: any = await import("./prerender-executor.mjs");
  const { createAssetSink, applyResult }: any = await import("./artifact-transfer.mjs");
  const { createAssetClient }: any = await import("./asset-store/client.mjs");

  const endpoint = node.createWsEndpoint({ url: link.url, ...(link.protocols ? { protocols: link.protocols } : {}), log: (event: string, fields: object) => {
    if (event === "ws.open" || event === "ws.close") queueLog(`docservice.${event}`, fields);
  } });
  const projects = node.createProjectClient(endpoint);
  const content = node.createContentClient(endpoint);
  // J.13:sink 推、task.done 拉,都用按 D7 选的素材服务
  const assetTicket = await ticketFor(link, endpoint);
  const assets = selectAssetClient({ node, endpoint, origin, ticket: assetTicket, createAssetClient, owner: "queue" });
  // J.6 的回退读别的机器的素材服务:凭共享项目进入时带票据
  setMediaFallbackTicket(assetTicket ? () => assetTicket() : null);
  const client = assets.client;
  const events: object[] = [];
  const note = (event: string, fields: object = {}) => {
    events.push({ at: Date.now(), event, ...fields });
    while (events.length > QUEUE_LOG) events.shift();
  };
  const log = (event: string, fields: object = {}) => { note(event, fields); if (!/^executor\.render$/.test(event)) queueLog(event, fields); };
  const sink = createAssetSink({ pipeline: service, client, content, log });
  const executor = createPrerenderExecutor({ pipeline: service, projects, prepareProject: renderProject, log });
  const host = String(os.hostname() || "host").replace(/[^A-Za-z0-9._:-]/g, "-");
  let editorPort = "";
  try { editorPort = new URL(origin).port; } catch { /* 没有端口就不带 */ }
  // 同一台机器上可能有几个编辑器各带一个预渲染进程:按编辑器端口区分节点身份
  const nodeId = `prerender:${host}${editorPort ? `:${editorPort}` : ""}`.slice(0, 128);

  /** 诊断与 queue-mode-probe 的读口 */
  const stats = { claimed: 0, completed: 0, dedup: 0, failed: 0, discarded: 0, lost: 0, planSplit: 0, done: 0, failedTasks: 0, applied: 0, applyErrors: 0,
    written: 0, fetched: 0, skipped: 0 };
  const taskState = new Map<string, { state: string, at: number, error?: string }>();
  /** M6b 探针 H1:每个任务收到几次 `task.done`(恰好一次才对) */
  const doneCounts = new Map<string, number>();
  const planDerived = new Map<string, string[]>();
  /**
   * 本机节点自己认领、完成的任务 id(诊断 `queue.local`):W4 跨机时区分哪些活是本机做的。
   * `claimed` 取自发给本连接的 `task.claimed`,其余取自 local-node 的 `onEvent`。每类最多留 MINE_MAX 个。
   */
  const mine = { claimed: new Set<string>(), completed: new Set<string>(), dedup: new Set<string>(), failed: new Set<string>() };
  const remember = (set: Set<string>, id: unknown) => {
    if (typeof id !== "string") return;
    set.delete(id); set.add(id);
    while (set.size > MINE_MAX) set.delete(set.values().next().value as string);
  };
  /** `<projectId>\0<digest>` → 已发布的那一版 */
  const published = new Map<string, { projectId: string, projectRev: number, planId: string, digest: string, at: number }>();

  let codeVersion: string = frameCode(root);
  let localNode: any = null;
  let started = false;
  let closed = false;
  const buildNode = () => {
    localNode?.stop();
    localNode = node.createLocalNode({
      nodeId,
      node: { profile: "pc", envFingerprint, codeVersions: [codeVersion], capabilities, maxConcurrent: 1 },
      endpoint, now: Date.now, isIdle: () => executor.isIdle(), maxConcurrent: 1, codeVersion, executor, sink,
      onEvent: (event: any) => {
        const id = event?.id;
        if (event?.type === "completed") { stats.completed++; remember(mine.completed, id); }
        else if (event?.type === "dedup") { stats.dedup++; remember(mine.dedup, id); }
        else if (event?.type === "failed") { stats.failed++; remember(mine.failed, id); }
        else if (event?.type === "discarded") stats.discarded++;
        else if (event?.type === "lost") stats.lost++;
        else if (event?.type === "plan-split") { stats.planSplit++; planDerived.set(id, [...(event.derived ?? [])]); }
        if (event?.type && event.type !== "publish-result") note(`node.${event.type}`, { id, ...(event.error ? { error: event.error } : {}), ...(event.derived ? { derived: event.derived.length } : {}) });
      },
    });
  };
  buildNode();

  /** 队列那边回来的消息:`task.done` 拉取并发布,`task.failed` 记下 */
  let applyChain: Promise<unknown> = Promise.resolve();
  endpoint.onMessage((message: any) => {
    if (message?.type === "task.claimed") { stats.claimed++; remember(mine.claimed, message.id); }
    if (message?.type === "task.done" && typeof message.id === "string") {
      stats.done++;
      doneCounts.set(message.id, (doneCounts.get(message.id) ?? 0) + 1);
      taskState.set(message.id, { state: "done", at: Date.now() });
      const result = message.result;
      if (message.id.startsWith("plan:") && Array.isArray(result?.derived)) planDerived.set(message.id, [...result.derived]);
      // 细任务的清单(C6.2 形状,`v: 1`)才拉;M5b 之前的 local-node 完成时不带清单,本机产的由执行器自己发层
      if (result && typeof result === "object" && result.v === 1 && (result.kind === "snapshot" || result.kind === "stream")) {
        applyChain = applyChain.catch(() => {}).then(async () => {
          try {
            const applied = await applyResult(service, client, result);
            stats.applied++; stats.written += applied?.written ?? 0; stats.fetched += applied?.fetched ?? 0; stats.skipped += applied?.skipped ?? 0;
          } catch (error: any) {
            stats.applyErrors++;
            log("queue.apply-failed", { id: message.id, code: error?.code ?? null, message: String(error?.message ?? error) });
          }
        });
      }
    } else if (message?.type === "task.failed" && typeof message.id === "string") {
      stats.failedTasks++;
      taskState.set(message.id, { state: "failed", at: Date.now(), error: String(message.error ?? "") });
      log("queue.task-failed", { id: message.id, error: message.error ?? null });
    }
  });
  const onOpen = () => {
    if (closed) return;
    // G.7 约定写法:(重)连上就报到,接续本实例仍持有的认领
    localNode.start(localNode.session.held().map(({ id, token }: any) => ({ id, token })));
    started = true;
    log("queue.started", { docservice: resolved.mode, url: resolved.url, nodeId, envFingerprint, codeVersion: codeVersion.slice(0, 12), capabilities });
  };
  endpoint.onOpen(onOpen);
  endpoint.onClose(() => {
    if (!started || closed) return;
    started = false;
    // J.5「中途连不上文档服务」:退回本机自己产,已经排进去的任务作废(在跑的让掉;重连后新的 preload 重新发布)
    published.clear();
    try { localNode.yieldAll("offline"); } catch { /* 连接已断,放回的消息反正发不出去 */ }
    const rerun = (service as any).leaveQueueMode?.() ?? 0;
    log("queue.offline", { rerun });
  });
  // J.6:别的机器的素材服务地址,本机的排除(与 J.13 选推送基址同一个判据)
  const stopWatch = node.watchServiceEndpoints(endpoint, ["asset"], (list: any[]) => {
    const urls = foreignAssetEndpoints(list, origin).flatMap(item => item.urls);
    const bases = setMediaFallbackBases(urls);
    note("queue.media-fallback", { bases: bases.length });
  });

  const timer = setInterval(() => {
    if (closed || !started) return;
    try {
      // 代码变了(改了 src 或管线):节点的代码版本跟着换,重新报到,不然新发布的任务谁都认领不了
      const now = frameCode(root);
      if (now !== codeVersion) {
        codeVersion = now;
        buildNode();
        localNode.start([]);
        log("queue.code-changed", { codeVersion: codeVersion.slice(0, 12) });
      }
      // 让路:播放 / 拖动时在跑的任务放回去,空闲了再认领(J.4 的 isIdle 管认领)
      if (localNode.running().length && (service as any).streamBusy?.()) localNode.yieldAll("busy");
      localNode.tick();
    } catch (error: any) {
      note("queue.tick-error", { message: String(error?.message ?? error) });
    }
  }, QUEUE_TICK_MS);
  timer.unref?.();

  /** 发布 `plan` 等同一 reqId 的回包(`task.published` 或 `error`);reqId 带自己的前缀,不和 local-node 的撞 */
  let publishSeq = 0;
  const waiting = new Map<string, (message: any) => void>();
  endpoint.onMessage((message: any) => {
    const waiter = message?.reqId != null ? waiting.get(String(message.reqId)) : undefined;
    if (waiter && (message.type === "task.published" || message.type === "error")) waiter(message);
  });
  endpoint.onClose(() => { for (const waiter of [...waiting.values()]) waiter({ type: "error", reason: "disconnected" }); });
  const publishPlan = (task: any) => new Promise<any>((resolve, reject) => {
    const reqId = `${nodeId}#plan-${++publishSeq}`;
    const timeout = setTimeout(() => settle({ type: "error", reason: "timeout" }), PUBLISH_TIMEOUT_MS);
    const settle = (message: any) => {
      if (!waiting.has(reqId)) return;
      waiting.delete(reqId);
      clearTimeout(timeout);
      if (message.type === "task.published") resolve(message.results);
      else reject(Object.assign(new Error(`发布 plan 没成:${message.reason}`), { code: message.reason }));
    };
    waiting.set(reqId, settle);
    if (!endpoint.send({ type: "task.publish", tasks: [task], reqId })) settle({ type: "error", reason: "disconnected" });
  });

  const handle: QueueNode = {
    active: () => started && !closed && endpoint.connected === true,
    async publish(session, project) {
      if (!handle.active()) return false;
      const projectId = typeof project?.id === "string" && PROJECT_ID_RE.test(project.id) ? project.id
        : typeof session === "string" && PROJECT_ID_RE.test(session) ? session : null;
      if (!projectId) { log("queue.publish-skip", { reason: "no-project-id" }); return false; }
      const text = JSON.stringify(project);
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      const key = `${projectId}\u0000${digest}`;
      if (published.has(key)) return true;
      try {
        const { projectRev } = await projects.announce(projectId, digest, session && session.length <= 128 ? session : undefined);
        await projects.putSnapshot(projectId, projectRev, digest, text);
        const task = node.planTaskOf({ projectId, projectRev, codeVersion: frameCode(root), envFingerprint });
        // J.3 的 `planTaskOf` 会自己写进 `requires`;合并之前的版本不认这两个参数,这里补上(两种都对)
        task.requires = { ...(task.requires ?? {}), codeVersion: frameCode(root), envFingerprint };
        const results = await publishPlan(task);
        const result = Array.isArray(results) ? results.find((r: any) => r?.id === task.id) : null;
        if (!result || result.error) throw Object.assign(new Error(`plan 没发布成:${result?.error ?? "no-result"}`), { code: result?.error ?? "no-result" });
        published.set(key, { projectId, projectRev, planId: task.id, digest, at: Date.now() });
        if (!taskState.has(task.id)) taskState.set(task.id, { state: result.state ?? "open", at: Date.now() });
        log("queue.published", { planId: task.id, bytes: text.length, state: result.state ?? null, created: result.created ?? null });
        return true;
      } catch (error: any) {
        log("queue.publish-failed", { projectId, code: error?.code ?? error?.reason ?? null, message: String(error?.message ?? error) });
        return false;
      }
    },
    describe() {
      return {
        mode: resolved.mode, url: resolved.url, connected: endpoint.connected === true, active: handle.active(), nodeId, envFingerprint, assetBase: assets.base(),
        codeVersion, running: localNode?.running?.() ?? [], held: localNode?.session?.held?.().map(({ id }: any) => id) ?? [],
        stats: { ...stats },
        local: { nodeId, claimed: [...mine.claimed], completed: [...mine.completed], dedup: [...mine.dedup], failed: [...mine.failed] },
        published: [...published.values()],
        plans: Object.fromEntries(planDerived),
        tasks: Object.fromEntries(taskState),
        doneCounts: Object.fromEntries(doneCounts),
        events: events.slice(-QUEUE_LOG),
      };
    },
    summary() {
      return {
        profile: "pc",
        nodes: [{ projectId: link.projectId ?? "local", nodeId, connected: endpoint.connected === true, claimed: stats.claimed, completed: stats.completed,
          dedup: stats.dedup, failed: stats.failed, lost: stats.lost }],
        codeVersion, envFingerprint, maxConcurrent: 1,
      };
    },
    async release() {
      const released = closed ? 0 : (() => { try { return localNode?.yieldAll("shutdown") ?? 0; } catch { return 0; } })();
      await new Promise(resolve => setTimeout(resolve, 300));
      await handle.close();
      return released;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { stopWatch?.(); } catch {}
      assets.stop();
      try { localNode?.stop(); } catch {}
      try { await localNode?.settled(); } catch {}
      try { endpoint.close(); } catch {}
    },
  };
  queueNodes.set(root, handle);
  // 端点在挂上 onOpen 之前就连上了(一般不会):补一次报到
  if (endpoint.connected === true && !started) onOpen();
}

/**
 * 主机一个项目的素材服务客户端(契约 render-host-contract 第 3 节「产物」:推到该项目文档服务下发的素材服务),顺序:
 *   1. `PROMPTCUT_ASSET_URL`(显式指定,调试用);
 *   2. 这条连接上 `service.endpoints` 里的 `asset`:按 `announcerId` 字典序取第一个的第一个地址。
 *      只排除与本主机编辑器同 host:port 的地址 —— 主机在逻辑上是另一台设备,同一台机器上的创建者登记的
 *      `asset:<主机名>` 也要认(PC 节点的 `foreignAssetEndpoints` 会把它当本机排掉);
 *   3. 都没有:从文档服务地址推出同一进程的素材服务 `http(s)://<文档服务 host>/api/asset` —— 局域网模式的
 *      文档服务挂在创建者的编辑器里,素材服务就在同一个进程(auth-contract 第 8 节末条)。
 * 不回落到主机自己的素材服务:产物推到那里,发布方拉不到。读写都带这条连接取的素材票据。
 */
function hostAssetClient({ node, endpoint, docUrl, origin, ticket, createAssetClient, owner }:
  { node: any; endpoint: any; docUrl: string; origin: string | null; ticket: any; createAssetClient: any; owner: string }) {
  let derived: string | null = null;
  try {
    const u = new URL(docUrl);
    derived = `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}/api/asset`;
  } catch { /* 地址不对:只能靠登记 */ }
  let selfHost = "";
  try { selfHost = origin ? new URL(origin).host : ""; } catch { /* 没有就不排 */ }
  let current: any = null;
  let currentBase: string | null = null;
  const use = (base: string | null, source: "env" | "announced" | "docservice") => {
    if (!base || (base === currentBase && current)) return;
    let next: any;
    try { next = createAssetClient({ base, ticket }); }
    catch (error: any) { pushLog("push.asset-base-error", { source, base, for: owner, message: String(error?.message ?? error) }); return; }
    current = next;
    currentBase = base;
    pushLog("push.asset-base", { source, base, for: owner });
  };
  const envBase = String(process.env.PROMPTCUT_ASSET_URL || "").trim().replace(/\/+$/, "");
  let stop = () => {};
  if (envBase) use(envBase, "env");
  else {
    use(derived, "docservice");
    stop = node.watchServiceEndpoints(endpoint, ["asset"], (list: any[]) => {
      const urls = [...(list ?? [])]
        .filter((item: any) => item?.kind === "asset" && typeof item.announcerId === "string")
        .sort((a: any, b: any) => (a.announcerId < b.announcerId ? -1 : a.announcerId > b.announcerId ? 1 : 0))
        .flatMap((item: any) => (item.urls ?? []).map(String))
        .filter((url: string) => { try { return new URL(url).host !== selfHost; } catch { return false; } });
      if (urls[0]) use(urls[0].replace(/\/+$/, ""), "announced");
      else use(derived, "docservice");
    });
  }
  const client = new Proxy({}, { get: (_target, key) => { const value = current?.[key]; return typeof value === "function" ? value.bind(current) : value; } });
  return { client, stop: () => { try { stop(); } catch { /* 已经停了 */ } }, base: () => currentBase };
}

/**
 * M6b 独立渲染主机(`docs/plan/render-host-contract.md` 第 3 节;编排在 `render-node/host.mjs`):
 *
 *   - 配置:`PROMPTCUT_SHARED_CONFIG`(一项或数组,每项一个共享项目),`maxConcurrent` 见 `loadHostConfig`;
 *   - 每项一条 `render` 连接(凭项目证明,每次重连现取挑战)、一个节点(`profile: 'host'`,
 *     `codeVersions: [本机 frameCode]`,能力与 PC 相同,指纹照本机探测);
 *   - 全部节点共用这个进程的 `FramePipeline`('queue' lane),并发总数由 host.mjs 的全局闸管;
 *     执行器与产物库按项目各一份:项目快照要从那个项目的连接取,产物推到那个项目的素材服务;
 *   - 不发布 `plan`、不认领 `plan`(filter 规则 6),不接 `/preload` 的队列发布(`active()` 恒为 false);
 *   - 闲时门槛只有全局闸;断线重连按 G.7 接续仍持有的认领;
 *   - 诊断 `GET /api/frames/queue`(`summary()`),退出前 `POST /api/frames/queue/release`(`release()`)。
 */
async function startHostNode(root: string, service: FramePipeline, node: any, origin: string) {
  const hostMod: any = await import("./render-node/host.mjs");
  let config: { entries: any[]; maxConcurrent: number } | null;
  try { config = hostMod.loadHostConfig(); }
  catch (error: any) { return queueLog("queue.skip", { reason: "bad-shared-config", profile: "host", detail: String(error?.message ?? error) }); }
  if (!config) return queueLog("queue.skip", { reason: "no-shared-config", profile: "host" });
  if (services.get(root) !== service || (service as any).closed) return;

  // 指纹:同 PC 节点,报到前借一次流预渲染间探
  try {
    const bakery = await (service as any).leaseStreamBakery();
    (service as any).returnStreamBakery(bakery);
  } catch (error: any) {
    return queueLog("queue.skip", { reason: "no-environment", profile: "host", message: String(error?.message ?? error) });
  }
  const envFingerprint: string | null = (service as any).envFingerprint;
  if (!envFingerprint) return queueLog("queue.skip", { reason: "no-environment", profile: "host" });
  if (services.get(root) !== service || (service as any).closed) return;
  // M6c X1:能力与 PC 节点同一个判据(`streams` 按实报)
  const capabilities = await nodeCapabilities(service);
  if (services.get(root) !== service || (service as any).closed) return;

  const { sharedProtocols }: any = await import("./auth/shared-config.mjs");
  const { createTicketSource }: any = await import("./auth/ticket-source.mjs");
  const { createPrerenderExecutor }: any = await import("./prerender-executor.mjs");
  const { createAssetSink }: any = await import("./artifact-transfer.mjs");
  const { createAssetClient }: any = await import("./asset-store/client.mjs");

  const events: object[] = [];
  const note = (event: string, fields: object = {}) => {
    events.push({ at: Date.now(), event, ...fields });
    while (events.length > QUEUE_LOG) events.shift();
  };
  const log = (event: string, fields: object = {}) => { note(event, fields); if (!/^executor\.render$/.test(event)) queueLog(event, fields); };

  const override = String(process.env[TEST_CODE_VERSION_ENV] || "").trim() || null;
  let codeVersion: string = override ?? frameCode(root);
  const hostName = String(os.hostname() || "host").replace(/[^A-Za-z0-9._:-]/g, "-");
  let editorPort = "";
  try { editorPort = new URL(origin).port; } catch { /* 没有端口就不带 */ }
  const nodeIdBase = `host:${hostName}${editorPort ? `:${editorPort}` : ""}`;

  /** 每项的连接记录:诊断用(连不上的次数、素材基址),退出时关 */
  const wired: { projectId: string | null; endpoint: any; assets: any; ticket: any; connectFailed: number; opens: number }[] = [];
  const host = hostMod.createRenderHost({
    entries: config.entries,
    maxConcurrent: config.maxConcurrent,
    envFingerprint,
    codeVersion,
    capabilities,
    now: Date.now,
    nodeIdOf: (_entry: any, index: number) => `${nodeIdBase}/p${index}`.slice(0, 128),
    connect: (entry: any, index: number) => {
      const rec: any = { projectId: entry.projectId ?? null, endpoint: null, assets: null, ticket: null, connectFailed: 0, opens: 0 };
      rec.endpoint = node.createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: "render" }), log: (event: string, fields: object) => {
        if (event === "ws.connect-failed") rec.connectFailed++;
        if (event === "ws.open") rec.opens++;
        // 连不上时每次退避都会打一行,只在头几次打,免得刷屏
        if (event === "ws.open" || event === "ws.close" || (event === "ws.connect-failed" && rec.connectFailed <= 3)) {
          queueLog(`docservice.${event}`, { project: index, projectId: rec.projectId, ...fields });
        }
      } });
      const projects = node.createProjectClient(rec.endpoint);
      const content = node.createContentClient(rec.endpoint);
      rec.ticket = createTicketSource(rec.endpoint, { access: "rw" });
      rec.assets = hostAssetClient({ node, endpoint: rec.endpoint, docUrl: entry.url, origin, ticket: rec.ticket, createAssetClient, owner: `host:p${index}` });
      const sink = createAssetSink({ pipeline: service, client: rec.assets.client, content, log });
      const executor = createPrerenderExecutor({ pipeline: service, projects, prepareProject: renderProject, log });
      wired.push(rec);
      return { endpoint: rec.endpoint, executor, sink };
    },
    onEvent: (event: any) => {
      if (event?.type && event.type !== "publish-result") note(`node.${event.type}`, { project: event.index, id: event.id, ...(event.error ? { error: event.error } : {}) });
    },
  });

  // J.6 的素材回退(读别的机器上的素材):各项目的素材服务都当回退基址;票据按基址挑,用那台素材服务所属项目的
  // (票据只在签发它的素材服务上有效;同一台服务上有几个项目时用配置里靠前的那个,按哈希寻址,任一项目的有效票据都能读)
  let fallbackKey = "";
  const refreshFallback = () => {
    const bases = wired.map(rec => rec.assets.base()).filter((b: string | null): b is string => !!b);
    const key = JSON.stringify(bases);
    if (key === fallbackKey) return;
    fallbackKey = key;
    note("queue.media-fallback", { bases: setMediaFallbackBases(bases).length });
  };
  refreshFallback();
  setMediaFallbackTicket(hostMod.fallbackTicketFor(wired.map(rec => ({ base: () => rec.assets.base(), ticket: () => rec.ticket() }))));

  let closed = false;
  let released = false;
  host.start();
  log("queue.started", { profile: "host", projects: config.entries.map((e: any) => e.projectId), maxConcurrent: host.maxConcurrent,
    envFingerprint, codeVersion: codeVersion.slice(0, 12), codeVersionOverride: override !== null, capabilities });

  const timer = setInterval(() => {
    if (closed) return;
    try {
      if (override === null) {
        const now = frameCode(root);
        if (now !== codeVersion) {
          codeVersion = now;
          host.setCodeVersion(now);
          log("queue.code-changed", { profile: "host", codeVersion: codeVersion.slice(0, 12) });
        }
      }
      refreshFallback();
      host.tick();
    } catch (error: any) {
      note("queue.tick-error", { message: String(error?.message ?? error) });
    }
  }, QUEUE_TICK_MS);
  timer.unref?.();

  const summary = () => ({
    profile: "host",
    nodes: host.nodes().map((n: any, i: number) => ({ ...n, opens: wired[i]?.opens ?? 0, connectFailed: wired[i]?.connectFailed ?? 0, assetBase: wired[i]?.assets.base() ?? null })),
    codeVersion, envFingerprint, maxConcurrent: host.maxConcurrent,
  });
  const closeAll = async () => {
    clearInterval(timer);
    for (const rec of wired) { rec.assets.stop(); try { rec.endpoint.close(); } catch { /* 已关 */ } }
  };
  const handle: QueueNode = {
    active: () => false,
    publish: async () => false,
    describe: () => ({ ...summary(), busy: host.busy(), running: host.running(), events: events.slice(-QUEUE_LOG) }),
    summary,
    async release() {
      if (released || closed) return 0;
      released = true;
      closed = true;
      const count = host.shutdown("shutdown");
      log("queue.release", { profile: "host", released: count });
      // task.release 已经交给各条连接;留一点时间让它们发出去,再等执行收尾、关连接
      await new Promise(resolve => setTimeout(resolve, 300));
      await Promise.race([host.settled(), new Promise(resolve => setTimeout(resolve, 5000))]);
      await closeAll();
      return count;
    },
    async close() {
      if (!released) { released = true; try { host.shutdown("closing"); } catch { /* 已停 */ } }
      if (closed && wired.every(rec => rec.endpoint.closed)) return;
      closed = true;
      await Promise.race([host.settled(), new Promise(resolve => setTimeout(resolve, 5000))]);
      await closeAll();
    },
  };
  queueNodes.set(root, handle);
}
function requestSignal(req: any, res: any) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.("aborted", abort);
  res.once?.("close", () => { if (!res.writableEnded) abort(); });
  return controller.signal;
}
export function frameService(root: string, origin: string) {
  root = path.resolve(root);
  let service = services.get(root);
  if (!service) {
    service = new FramePipeline({ root: path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(root, "out"), "frame-library"), origin: () => origin,
      code: () => frameCode(root), captureCode: () => captureCode(root),
      // 成本记录和可调系数跟 vite-plugin-costs 同一个根(帧库目录不是它们的家)
      dataRoot: root,
      /*
       * D5 的 `interactive`(R7 的原子切换把编辑器进程这一侧翻了过来)。
       *
       * **预渲染进程 `true`**:热池在它这里,改叫 `streamPool`,给 G 的分段和 C2 锚帧用;
       * `?preview=legacy` 的服务端旧调度器(`acquireUser` / `updatePlayback`)也留在它这里 ——
       * legacy 页面照今天的方式发 `user` / `playback` lane,只是打到预渲染的源上
       * (`frameClient` 的缺省 `target` 已经是 `"prerender"`),服务端不另读开关。
       *
       * **编辑器进程 `false`**:不再养那对无头 Chrome。`user` / `playback` 两条 lane
       * 立即回 `USE_PRERENDER`、不进 `acquireUser`,两处 `prewarmUser` 都不调。
       * 页面侧的热渲染是可见舞台 iframe,和 Node 侧的热池不是一回事(总规则倒数第二条)。
       */
      interactive: isPrerender,
      /** C4:`wanted` 从镜像插件读(frame-pipeline 是 .mjs,镜像插件是 .ts) */
      playhead: () => latestPlayhead(),
      /** 没有内容哈希的素材打戳时向素材服务发 HEAD 的地址(基址按 asset-client.ts 定,不读素材目录) */
      mediaUrl: (m: any) => mediaSourceOf(m),
    });
    services.set(root, service);
    /*
     * R8:轨道流分段的读口挂在下面的 `/api/frames/*` 上 —— 生产者要读口接上了才开工、才发 `stream` 层
     * (`StreamProducer.routeAttached`)。编辑器进程(`interactive: false`)没有生产者,这里是空操作。
     */
    service.streamProducer()?.attachRoute();
    /*
     * F5:预渲染进程起来先扫盘重建「键 → 区间」。只挂在键上,不发 `layer` ——
     * `clipId` 要等项目到位、重算 card plan 之后才反查得出来(`adoptCardPlan`)。
     */
    void service.rescanSnapshots().catch(() => {});
    /* C6.4:连得上素材服务和文档服务时建推送队列(只在预渲染进程里;连不上就什么都不建) */
    void startArtifactPush(root, service).catch(error => pushLog("push.skip", { reason: "error", message: String(error?.message ?? error) }));
    /* J.5:`PROMPTCUT_QUEUE_NODE=1` 又连得上文档服务时起本机渲染节点(开关关着时这里立即返回,什么都不建) */
    if (queueNodeSwitch()) void startQueueNode(root, service).catch(error => queueLog("queue.skip", { reason: "error", message: String(error?.message ?? error) }));
  }
  return service;
}
/** 原样搬到 `render-project.mjs`(契约 J.5),这里转出,调用方(`vision/render.ts`、脚本)不用改 */
export { renderProject };
export function framesPlugin(): Plugin {
  return { name: "promptcut-frames", configureServer(server) {
    const root = path.resolve(server.config.root);
    let remoteLease: { owner: string; url: string; at: number; ready: boolean } | null = null;
    const borrow = async (owner: string) => {
      const remote = prerenderState();
      if (isPrerender || !remote.ready || !remote.url) return false;
      if (remoteLease?.owner === owner && remoteLease.url === remote.url && Date.now() - remoteLease.at < 1000) return remoteLease.ready;
      try {
        const response = await fetch(remote.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, ttl: 5000 }), signal: AbortSignal.timeout(2000) });
        const result = await response.json();
        remoteLease = { owner, url: remote.url, at: Date.now(), ready: response.ok && result.yielded === true };
      } catch { remoteLease = { owner, url: remote.url, at: Date.now(), ready: false }; }
      return remoteLease.ready;
    };
    const release = async (owner: string) => {
      if (remoteLease?.owner !== owner) return;
      const lease = remoteLease; remoteLease = null;
      await fetch(lease.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, ttl: 0 }), signal: AbortSignal.timeout(1500) }).catch(() => {});
    };
    server.watcher.on("change", file => { if (/^(src|scripts)\//.test(path.relative(root, file).replaceAll("\\", "/"))) invalidateFrameCode(root); });
    server.httpServer?.once("close", () => {
      const s = services.get(root); services.delete(root);
      const teardown = pushTeardowns.get(root); pushTeardowns.delete(root);
      const queueNode = queueNodes.get(root); queueNodes.delete(root);
      void (async () => { await queueNode?.close(); await teardown?.(); await s?.close(); })();
    });
    /*
     * D4(b) `/api/cards/layout`:Agent 的 `get_layout` —— 按 t 在**整场景**上实测实体框
     * (pinned 架构 4:Agent 的 query 跑预渲染进程;用户交互的 query 走自己的离屏舞台,不走这里)。
     * body `{ session, localRev, t, clipIds? }`,项目来路和 `/preload` / `/playback` / `/see`
     * 同一套(A7 的镜像前奏,迁移期仍收 `project`)。
     *
     * **只在预渲染进程里答**(T1a 审查 #14;cloud-task.md I4(c):`/api/cards/layout` 只服务 Agent 的
     * `get_layout`,走 `'agent'` 角色)。编辑器进程收到就原样转给预渲染进程,转不过去回
     * `503 NO_AGENT_LANE` —— 以前这里直接调本进程的 `FramePipeline.layout`,会在编辑器这一侧开查询 Chrome。
     * 预渲染进程里经 `runAgentTask` 借 agent lane 的 bakery,和 `see_frames` 的 agent 批排同一条队。
     */
    server.middlewares.use("/api/cards/layout", (req, res, next) => {
      if (req.method !== "POST") return next();
      if (!isPrerender) return proxyToPrerender(req, res, { unavailable: { status: 503, code: "NO_AGENT_LANE",
        error: "编辑器进程没有 Agent lane,/api/cards/layout 只在预渲染进程里答,而预渲染进程现在够不着" } });
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Layout request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body || "{}");
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          if (input.t !== undefined && !Number.isFinite(input.t)) throw new Error("t 要是秒数");
          if (input.clipIds !== undefined && input.clipIds !== null && (!Array.isArray(input.clipIds) || input.clipIds.some((id: unknown) => typeof id !== "string")))
            throw new Error("clipIds 要是字符串数组");
          const service = frameService(root, origin);
          return json(200, await service.layout(project, { t: Number(input.t) || 0, clipIds: input.clipIds ?? null, signal: requestSignal(req, res) }));
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          json(status, { ok: false, code: timedOut ? "FRAME_TIMEOUT" : cancelled ? "FRAME_CANCELLED" : (error?.code || "LAYOUT_ERROR"),
            retryable: timedOut || status >= 500, error: error?.message || "实体框测量失败" });
        }
      });
    });
    server.middlewares.use("/api/frames", (req, res, next) => {
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      /*
       * M6b 队列节点的诊断与退出(`docs/plan/render-host-contract.md` 第 2、3 节):
       *   GET  /api/frames/queue          `{ nodes: [{ projectId, connected, claimed, completed, dedup, failed, lost, … }],
       *                                     codeVersion, envFingerprint, maxConcurrent }`;节点还没起来时 `nodes: []`、`starting: true`
       *   POST /api/frames/queue/release  让掉全部认领、停节点、关连接(`scripts/render-host.mjs` 退出前调)
       * 节点在预渲染进程里:编辑器进程原样转过去(不在编辑器这一侧建管线)。预渲染进程里第一次打 `/api/frames/*`
       * 才建管线、起节点,所以 GET 这一下同时就是「开工」。
       */
      const queuePath = (req.url || "/").split("?")[0];
      if ((req.method === "GET" && queuePath === "/queue") || (req.method === "POST" && queuePath === "/queue/release")) {
        if (!isPrerender) return proxyToPrerender(req, res);
        frameService(root, origin);
        const queueNode = queueNodes.get(root);
        if (req.method === "GET") {
          return json(200, queueNode ? queueNode.summary()
            : { nodes: [], codeVersion: null, envFingerprint: null, maxConcurrent: null, starting: queueNodeSwitch(), profile: hostProfile() ? "host" : "pc" });
        }
        req.resume();
        if (!queueNode) return json(200, { ok: true, released: 0 });
        void queueNode.release().then(released => json(200, { ok: true, released }), (error: any) => json(500, { ok: false, error: String(error?.message ?? error) }));
        return;
      }
      const service = frameService(root, origin);
      const url = new URL(req.url || "/", origin);
      /*
       * C3 就绪索引的 SSE。**页面直连预渲染进程**(和 J3 的快照字节同源,同走
       * `PROMPTCUT_CORS_ORIGINS`);编辑器进程不代理 —— D5 的 `/api/frames/*`
       * 保留清单里没有它,这里的中间件对不认识的路径一律 `next()`。
       *
       * 连上先灌 `reset` + 每层一条全量 `layer`(已经 done 的再补一条 `done`),
       * 之后增量。断线由页面按 1s / 2s / 4s / 8s 退避重连同一条 SSE(J3),
       * 重连就是再走一次这里 —— 和 F5 共用一条恢复路径,没有轮询端点。
       */
      if (req.method === "GET" && url.pathname === "/ready") {
        // Item 4:按 `session` 分片订阅,只收自己这个页面会话的层(不带 session 的是缺省会话)
        const session = readySessionOf(url.searchParams.get("session") ?? undefined);
        if (session === null) return json(400, { error: "session 参数不合法" });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        // 反向代理和 vite 的 compression 都可能攒着不发,SSE 攒一下就等于断线
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        const send = (message: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`); };
        const off = service.ready.subscribe(session, send);
        // 空闲连接被中间的代理掐掉之前先说句话(注释行不是事件,页面收不到)
        const beat = setInterval(() => { if (!res.writableEnded) res.write(": beat\n\n"); }, 15000);
        beat.unref?.();
        const stop = () => { clearInterval(beat); off(); };
        req.on("close", stop);
        res.on("close", stop);
        return;
      }
      /*
       * 诊断读口:A3c 的超限帧(卡 id、字节数)和 C4 的批次插队。预渲染进程的
       * stdout 被编辑器进程收走了,端到端探针只能从这里看这两件事。
       */
      if (req.method === "GET" && url.pathname === "/diagnostics") {
        // J.5:队列模式才多一个 `queue` 键(queue-mode-probe 读它);开关关着时形状不变
        const queueNode = queueNodes.get(root);
        return json(200, { ok: true, ...service.diagnostics(), ...(queueNode ? { queue: queueNode.describe() } : {}) });
      }
      if (req.method === "GET") {
        /*
         * R8 轨道流的字节(清单 / init / 分段),和快照字节同源、同走 `PROMPTCUT_CORS_ORIGINS`。
         * 只有预渲染进程(`interactive: true`)有生产者;编辑器进程这里是 null,不答。
         */
        const producer = service.streamProducer();
        if (producer && producer.handle(req, res, url.pathname)) return;
        /*
         * J3 / C3 的快照字节:`GET /api/frames/snapshot/<kind>/<key>/<localFrame>`。
         * `kind` 为 `local` 时 `key` = `<entry.key>/<共享键>`,所以有两个键段。
         * 键是内容寻址的,所以可以 immutable 缓存一年。
         */
        const snapshot = /^\/snapshot\/(html|local)\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?\/(\d{1,8})$/.exec(url.pathname);
        if (snapshot) {
          const local = snapshot[1] === "local";
          if (local && !snapshot[3]) return json(404, { error: "本地档的键是 <entry.key>/<共享键>" });
          void service.snapshots().readSnapshot({
            tier: local ? "local" : "shared",
            entryKey: local ? snapshot[2] : undefined,
            key: local ? snapshot[3] : snapshot[2],
            localFrame: Number(snapshot[4]),
          }).then((html: string | null) => {
            if (html === null) return json(404, { error: "Snapshot is not ready" });
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.end(html);
          }, () => json(404, { error: "Snapshot is not ready" }));
          return;
        }
        const control = /^\/control\/([a-f0-9]{64})\/(\d{1,8})$/.exec(url.pathname);
        if (control) {
          void fsp.readFile(path.join(service.root, 'controls', control[1], 'mov', 'frames', control[2].padStart(6, '0') + '.png')).then(buf => {
            res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'private,max-age=31536000,immutable'); res.end(buf);
          }, () => json(404, { error: 'Control frame is not ready' })); return;
        }
        // The final cumulative render is used by the editor, while the
        // cumulative track renders are useful to callers that want to rebuild
        // only the edited upper part.  Keep both forms behind fixed-length
        // hexadecimal keys; no user supplied path segment reaches the disk.
        const final = /^\/([a-f0-9]{64})\/(preview\.mp4|mov\/full\.mov|mov\/playback-[a-f0-9-]{36}\.mov|mov\/frames\/\d{6}\.png|frames\/\d{6}\.png|preview-frames\/\d{6}\.png)$/.exec(url.pathname);
        const track = /^\/([a-f0-9]{64})\/tracks\/([a-f0-9]{64})\/(preview\.mp4|frames\/\d{6}\.png)$/.exec(url.pathname);
        if (!final && !track) return next();
        const file = final
          ? path.join(service.root, final[1], final[2])
          : path.join(service.root, track![1], "tracks", track![2], track![3]);
        void fsp.stat(file).then(stat => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1;
          if (start > end || start >= stat.size) { res.statusCode = 416; return res.end(); }
          res.statusCode = range ? 206 : 200;
          res.setHeader("Content-Type", file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".mov") ? "video/quicktime" : "image/png");
          if (file.includes("playback-")) res.setHeader("Cache-Control", "no-store");
          res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Length", end - start + 1);
          if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
        }, () => json(404, { error: "Frame is not ready" }));
        return;
      }
      /*
       * K1:**探针推过的帧直接存成死素材**。后台舞台第一趟(全局时钟逐帧推)每生成
       * 一帧快照就把 `{ session, localRev, clipId, localFrame, html, environment }` 报上来,经编辑器
       * 进程转到这里。`kind` / `key` 由**预渲染进程**按镜像里的项目用 A3a 的规则算
       * (共享键要 `card-identity.mjs` 的 `digest`,本地模式里页面不算它)。
       *
       * **只存审阅表 `independent` 的卡**(pinned 渲染 5 末句):`sourceDependent`
       * (链上的源在缩水项目里没有)和 `belowDependent` / `unknown`(没有下层背景)
       * 在缩水项目里都拿不到输入,存下去等于把错画面当死素材发出去;它们的本地档
       * 仍由 C2 的整场景路产。
       *
       * 写进同一棵目录、进 C3 的索引,预渲染不再重新预渲染这些帧。键乘的是页面的环境指纹,
       * 这张卡随之锁定到页面的环境(卡片级指纹锁,契约 F.3),见下面 `acceptMeasuredSnapshot` 那一段。
       */
      if (req.method === "PUT" && url.pathname === "/snapshot") {
        let probeBody = "", probeOver = false;
        req.on("data", chunk => { if (!probeOver) { probeBody += chunk; probeOver = overLimit(req, res, probeBody.length, 32 * 1024 * 1024, "Probe snapshot too large"); } });
        req.on("end", async () => {
          if (probeOver) return;
          try {
            const input = JSON.parse(probeBody || "{}");
            if (!isPrerender) {
              // 编辑器进程只转发,不存 —— 快照库在预渲染进程那一侧
              const remote = prerenderState();
              if (!remote.ready || !remote.url) return json(503, { ok: false, code: "PRERENDER_UNAVAILABLE", error: "预渲染进程还没就绪" });
              const forwarded = await fetch(remote.url + "/api/frames/snapshot", { method: "PUT", headers: { "Content-Type": "application/json" },
                body: probeBody, signal: AbortSignal.timeout(10000) });
              return json(forwarded.status, await forwarded.json().catch(() => ({ ok: forwarded.ok })));
            }
            const clipId = String(input.clipId || "");
            const localFrame = Number(input.localFrame);
            const html = typeof input.html === "string" ? input.html : null;
            if (!clipId || !Number.isInteger(localFrame) || localFrame < 0 || html === null) throw new Error("探针帧要带 clipId / localFrame / html");
            const version = await ensureMirrorVersion(String(input.session || ""), input.localRev);
            if (!version) return json(409, { ok: false, code: "MIRROR_MISSING", retryable: true, error: "镜像里没有这一版项目" });
            const entry = await service.entry(renderProject(version.project));
            // 键从 card plan 反查(`control.clipId` ↔ `control.snapshotKey`)。plan 要
            // 浏览器才算得出来,还没算过就先不存 —— 下一次预渲染自己会产这一帧。
            const control = (entry.cardPlan || []).find((item: any) => item.clipId === clipId);
            if (!control?.snapshotKey) return json(202, { ok: false, code: "PLAN_PENDING", stored: false, error: "card plan 还没算出来" });
            const compositing = control.capabilities?.compositing;
            const tier = snapshotTier(control.capabilities);
            if (compositing !== "independent" || tier !== "shared") return json(200, { ok: true, stored: false, reason: "NOT_INDEPENDENT" });
            /*
             * 卡片级指纹锁(契约 F.3,取代 E.6 的指纹闸):测量帧产自用户的浏览器,写在**页面自己的
             * 环境指纹**乘出来的键下,这张卡的共享快照随之锁定到页面的环境(「预渲染结果的复用」)。
             * 页面指纹按页面上报的 `environment`(`src/editor/pageEnvironment.mjs`)用同一份
             * `describeEnvironment` 算;没有 `environment` 就认字符串 `envFingerprint`;都没有传 null。
             * 得锁、写盘、发层都在 `acceptMeasuredSnapshot` 里。页面(`probeRunner.ts`)只在意 404,回 200 不影响它。
             */
            let pageFingerprint: string | null = null;
            const environment = input.environment;
            if (environment && typeof environment === "object" && !Array.isArray(environment)) {
              pageFingerprint = describeEnvironment({ platform: environment.platform, renderer: environment.renderer, vendor: environment.vendor,
                chromeVersion: environment.userAgent ?? environment.chromeVersion }).fingerprint;
            } else if (typeof input.envFingerprint === "string") pageFingerprint = input.envFingerprint;
            return json(200, await service.acceptMeasuredSnapshot(entry, control, { envFingerprint: pageFingerprint, localFrame, html }));
          } catch (error: any) {
            json(400, { ok: false, code: "PROBE_SNAPSHOT_ERROR", error: error?.message || "探针帧没存下" });
          }
        });
        return;
      }
      if (req.method !== "POST") return next();
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Frame request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body);
          // Item 4:preload 一进门就替它的会话领号(在等镜像之前),乱序完成时按到达顺序定谁赢
          let preloadSession: string | null = null, preloadTicket: number | undefined;
          if (url.pathname === "/preload") {
            preloadSession = readySessionOf(input.session);
            if (preloadSession === null) throw new Error("session 参数不合法");
            preloadTicket = service.ready.request(preloadSession);
          }
          if (url.pathname === "/yield") {
            if (typeof input.owner !== "string" || input.owner.length > 100) throw new Error("Invalid playback owner");
            if (input.ttl === 0) await service.resumeBackground(input.owner);
            else await service.yieldBackground(input.owner, 5000);
            return json(200, { yielded: input.ttl !== 0 });
          }
          /*
           * 项目从哪儿来(A7)。body 里带 `project` 的是迁移期的调用方(脚本、只读观看页、
           * 舞台页、导出页)—— 照旧用它。编辑页只带 `{session, localRev}`:按这个键从
           * **本进程**的镜像插件取,本进程没有就按 PROMPTCUT_EDITOR_URL 回拉一次。
           * 还是取不到就回 409 MIRROR_MISSING,页面整份重推之后重试。
           */
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          const entry = await service.entry(project);
          if (url.pathname === "/playback") {
            if (typeof input.owner !== "string" || input.owner.length > 100 || !Number.isSafeInteger(input.sequence)
              || !Number.isFinite(input.t) || typeof input.playing !== "boolean" || (input.rate !== undefined && (!Number.isFinite(input.rate) || input.rate <= 0 || input.rate > 8))
              || (input.deliveryMs !== undefined && (!Number.isFinite(input.deliveryMs) || input.deliveryMs < 0 || input.deliveryMs > 5000))) throw new Error("Invalid playback clock");
            return json(200, await service.updatePlayback(project, input, { borrow, release }));
          }
          if (url.pathname === "/see") {
            const lane = input.lane === "agent" ? "agent" : input.lane === "background" ? "background" : "user";
            const frames = await service.see_frames(project, input.times || [0], { lane, signal: requestSignal(req, res) });
            const movReady = await fsp.access(path.join(entry.dir, "mov", "full.mov")).then(() => true, () => false);
            return json(200, { key: entry.key, incomplete: [...frames.values()].some((value: any) => value.incomplete),
              frames: [...frames].map(([frame, value]: any) => ({ frame, source: value.source, incomplete: !!value.incomplete, missing: value.missing || [],
                url: `/api/frames/${entry.key}/${value.incomplete ? 'preview-frames' : value.source === "mov" ? "mov/frames" : "frames"}/${String(frame).padStart(6, "0")}.png` })), mov: movReady ? `/api/frames/${entry.key}/mov/full.mov` : null });
          }
          // 会话「当前版本」的唯一来源(Item 4):页面的 preload 带着它的 `{ session, localRev }`
          if (url.pathname === "/preload") {
            /*
             * J.5 队列模式:节点连着文档服务时,先替页面报摘要、传快照、发布 `plan`,成了就让这一版的快照交给队列产
             * (`queue: true`),没成(发布失败、没有能用的 projectId)就本机自己产(`queue: false`)。
             * 开关关着时 `queueNodes` 是空的,这里的调用和原来一字不差。
             */
            const queueNode = queueNodes.get(root);
            const viaQueue = queueNode?.active() ? await queueNode.publish(preloadSession!, project) : undefined;
            await service.preload(project, { session: preloadSession!, localRev: input.localRev, ticket: preloadTicket, ...(viaQueue === undefined ? {} : { queue: viaQueue }) });
            // 报给编辑器进程登记(方案 A):这个进程崩溃重启后,由编辑器照表重放 preload。
            // 只报这个会话此刻真正认下的版本 —— 被更新的 preload 取代了的请求不报
            if (preloadSession && service.ready.current(preloadSession) === entry.key) reportReadySession(preloadSession, input.localRev);
          }
          else if (url.pathname === "/import" && typeof input.snapshots === "string") {
            try {
              // Restore the control index together with the HTML.  It is built from
              // the same snapshots and lets callers address a component at its
              // local frame without sampling the whole project again.
              const archive = unpackFrameArchive(input.snapshots, entry.key, { spillDir: path.join(entry.dir, "html-cache") });
              entry.html = archive.frames;
              entry.controls = archive.controls;
              entry.createControl = archive.createControl;
              entry.disposeArchive?.(); entry.disposeArchive = archive.dispose;
              entry.recordVersion = (entry.recordVersion || 0) + 1;
              await service.save(entry);
            }
            catch { return json(200, { discarded: true }); }
          } else if (url.pathname === "/archive") {
            const snapshots = await service.portableArchive(entry);
            return json(200, { key: entry.key, snapshots, localOnly: snapshots === null });
          } else if (url.pathname !== "/status") return json(404, { error: "Unknown frame operation" });
          await entry.mov?.ready;
          const videoReady = await fsp.access(path.join(entry.dir, "preview.mp4")).then(() => true, () => false);
          const movReady = await fsp.access(path.join(entry.dir, "mov", "full.mov")).then(() => true, () => false);
          return json(200, { key: entry.key, status: entry.status, sampled: entry.html.size, movSampled: entry.mov ? [...(entry.mov.frames || [])].length : 0, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))), error: entry.error,
            video: videoReady ? `/api/frames/${entry.key}/preview.mp4` : null,
            mov: movReady ? `/api/frames/${entry.key}/mov/full.mov` : null });
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          const code = timedOut ? "FRAME_TIMEOUT" : error?.superseded ? "FRAME_SUPERSEDED" : cancelled ? "FRAME_CANCELLED" : (error?.code || "FRAME_ERROR");
          if (status >= 500) console.error(`[frames] ${code}:`, error?.stack || error?.message || error);
          json(status, {
            ok: false,
            code,
            retryable: timedOut || status >= 500,
            error: error?.message || "帧渲染失败",
          });
        }
      });
    });
  } };
}
