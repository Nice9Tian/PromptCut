/**
 * 账号模式下 Agent 主服务的装配：只接待人、只做控制，**自己不跑任何任务**。
 *
 * 任务在各自的任务进程里跑（一条任务一个进程，`account-task-worker-cli.mjs`）；任务进程由节点上的槽调度开、
 * 由 root 关（Linux 上是 `account-root-main.mjs`）。主服务这一侧有四样：
 *   1. 只做控制的主身份（`run-client.mjs`，`registrationPurpose: 'control-only'`）和给人读对话用的读取控制连接；
 *   2. 事件库（`account-run-events.mjs`）：各任务进程交来的事件落在这里，页面的事件流从这里读；
 *   3. 一个只绑回环、双向 TLS 的内部口，上面两类请求：
 *        - 任务进程交事件（`worker-event-internal.mjs`，凭任务证书加它内存里钥匙的签名，逐条回文档服务核）；
 *        - 槽调度来问「哪些对话在排队、哪些任务要强制关」「这一条强制终态」（只认 root 那张证书；主服务原样转问文档服务，
 *          回来的终态是文档服务签的，root 的发布器自己验签，主服务改不了）；
 *   4. 用户上传的附件：存进**各代任务进程共用**的数据目录里这个对话的工作目录（任务进程的工具从那里读）。
 *   5. 发起人页面的反向通道的登记表（`page-bridge.mjs`：哪张页面在线、哪条请求在等、请求的状态落盘）。页面的事件流与交回请求
 *      都落在这个进程；工具在任务进程里跑，它经内部口上的另一类请求（`worker-page-internal.mjs`，鉴权与交事件同一套）来问，
 *      这里等发起页交回再答。主服务重启时在等的请求在登记表里标成被中断，任务进程那一头得到的是连接断开，按「发起人不在线」收。
 *   6. 对话转私有时把这个对话的云端浏览器数据清掉（浏览器在任务进程里跑，数据目录在共用数据目录里）：没有任务进程正占着就当场删，
 *      有（发起人自己正在跑的那一轮被保留）就留一个记号，由那个任务进程在下一次网页操作前或收尾时清。
 *
 * 槽调度不在这个进程里。它有没有在问，这里记着（`schedulerAlive()`）：没有调度在问时消息仍然持久排队，
 * `GET /v1/info` 的 `executorMounted` 与 `/healthz` 如实报「没有」，不装作在执行。
 */
import https from 'node:https';
import path from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { certificateFingerprint } from '../account/client.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { AgentServiceError } from '../agent/service/create-agent-service.mjs';
import { createAccountRunEvents } from '../agent/service/account-run-events.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { saveAttachment } from '../agent/service/hosted-tools.mjs';
import { createWorkerEventInternalHandler, WORKER_EVENT_PATH } from './worker-event-internal.mjs';
import { createWorkerPageInternalHandler, WORKER_PAGE_PATH } from './worker-page-internal.mjs';
import { createPageBridge, PageBridgeError, BRIDGE_PAGE_ID_RE } from '../agent/service/page-bridge.mjs';
import { collectPageTools } from '../agent/service/collect-bridge.mjs';
import { hostedBrowserDir } from '../agent/service/hosted-browser.mjs';
import { BROWSER_PURGE_MARK } from '../agent/service/account-tools.mjs';
import { reapOrphan, removeSessionData } from '../web/hosted/session.mjs';
import fs from 'node:fs';
import { MASTER_SCHEDULER_PENDING_PATH, MASTER_SCHEDULER_CONTROL_PATH } from './account-master-scheduler-client.mjs';

const fail = code => { throw Object.assign(new Error(code), { status: 503, code }); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
/** 拉得住进程的等待：启动时等文档服务用。那时这个进程还没有任何监听口，用不拉住进程的定时器等，进程会自己以退出码 0 退出。 */
const holdingDelay = ms => new Promise(resolve => { setTimeout(resolve, ms); });
/** 对话的工作目录在共用数据目录里的位置：和任务进程里算的是同一个（`account-runner.mjs`） */
export const accountWorkspaceOwnerKey = (projectId, conversationId) =>
  createHash('sha256').update(`account-v2\n${projectId}\n${conversationId}`).digest('hex').slice(0, 32);

/**
 * @param {object} o
 * @param {string} o.dataDir 主服务自己的数据目录（事件库在这里）
 * @param {string} o.sharedDataDir 各代任务进程共用的数据目录（附件存进这里；要和任务进程设置里的 `dataDir` 是同一个）
 * @param {object} o.runClient 主身份（`createRunClient({ registrationPurpose: 'control-only' })`）
 * @param {object} o.conversationClient 已经 `useReadControl(readControl)` 的对话客户端
 * @param {object} o.readControl 读取控制连接
 * @param {{ key, cert, ca }} o.tls 主服务的证书（内部口用它当服务端证书；任务进程按它的指纹钉）
 * @param {number} o.internalPort 内部口的端口（0 = 系统分配，测试用）
 * @param {string} o.controllerFingerprint256 root 那张证书的指纹：只有它能来问调度要的那两条
 * @param {number} [o.schedulerStaleMs] 调度多久没来问就算不在了
 * @param {number} [o.stopWaitMs] 「停止」在服务器上最多等多久（等 root 把进程关掉、文档服务结清）；到时仍没办完照旧回「还在办」
 */
export async function createAccountMasterAssembly({ dataDir, sharedDataDir, runClient, conversationClient, readControl, tls,
  internalPort, internalHost = '127.0.0.1', controllerFingerprint256, schedulerStaleMs = 15_000, stopWaitMs = 15_000,
  registerRetryMs = 2_000, workspaceLimits = {}, attachmentLimits = {}, now = Date.now, log = () => {} } = {}) {
  const controllerPin = certificateFingerprint(controllerFingerprint256);
  let ownPin = null;
  try { ownPin = certificateFingerprint(new X509Certificate(tls?.cert).fingerprint256); } catch { ownPin = null; }
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof sharedDataDir !== 'string' || !path.isAbsolute(sharedDataDir) ||
      typeof runClient?.pending !== 'function' || typeof runClient.scopeControl !== 'function' || typeof runClient.workerEventSource !== 'function' ||
      typeof runClient.registerInstance !== 'function' || typeof runClient.instanceIdentity !== 'function' ||
      !readControl?.transports || typeof readControl.start !== 'function' || conversationClient?.readTransports !== readControl.transports ||
      !tls?.key || !tls.cert || !tls.ca || !hash(ownPin) || !hash(controllerPin) || controllerPin === ownPin ||
      !Number.isInteger(internalPort) || internalPort < 0 || internalPort > 65535 || internalHost !== '127.0.0.1' ||
      !Number.isInteger(schedulerStaleMs) || schedulerStaleMs < 100 || !Number.isInteger(stopWaitMs) || stopWaitMs < 0 ||
      !Number.isInteger(registerRetryMs) || registerRetryMs < 10)
    fail('account-master-configuration');
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志不影响服务 */ } };
  let stopped = false, closing = null, server = null, eventStore = null, registerTimer = null, registered = false, lastSchedulerAt = 0;
  const sockets = new Set();
  const schedulerAlive = () => lastSchedulerAt > 0 && now() - lastSchedulerAt < schedulerStaleMs;

  // ---------- 主身份：登记、读取控制 ----------
  // 事件库钉在文档服务的权威号上，登记成功才知道它：所以启动要等到第一次登记成功。文档服务这时连不上不算故障，
  // 隔一会儿再试（每次记一行 `agent.master.pending`），一直等、进程不退；文档服务明确不认（4xx）、
  // 或者登记出来的不是「只做控制」的身份才是配置错，直接拒绝。
  let authorityId = null;
  for (;;) {
    try {
      const instance = await runClient.registerInstance(), identity = runClient.instanceIdentity();
      if (identity?.purpose !== 'control-only' || !safe(identity.authorityId)) fail('account-master-purpose');
      authorityId = identity.authorityId; registered = true;
      say('agent.master.registered', { instanceId: instance.instanceId, instanceGeneration: instance.instanceGeneration });
      break;
    } catch (error) {
      if (error?.code === 'account-master-purpose' || [400, 401, 403].includes(error?.status)) throw error;
      say('agent.master.pending', { code: error?.code ?? 'unavailable' });
      await holdingDelay(registerRetryMs);
    }
  }
  // 读取控制连接自己退避重连；第一次起不来也一样隔一会儿再试
  const startReadControl = async () => {
    if (stopped) return;
    try { await readControl.start(); }
    catch (error) {
      if (stopped) return;
      say('agent.master.read-control.pending', { code: error?.code ?? 'unavailable' });
      registerTimer = setTimeout(() => { void startReadControl(); }, registerRetryMs); registerTimer.unref?.();
    }
  };
  // 主服务从不替哪条任务登记事件：事件只经 appendWorker 进来（每条都回文档服务核是哪一条任务的哪一代进程）
  eventStore = createAccountRunEvents({ file: path.join(dataDir, 'master-run-events.sqlite'), now, authorityId,
    verifyGrant: async () => { throw Object.assign(new Error('not-a-human-gate'), { status: 403 }); } });

  // ---------- 发起人页面的反向通道（登记表在这个进程） ----------
  // 这一轮的权威信息：向文档服务现问（主身份的 workerEventSource：任务还在、还是那一代进程；回的里面有发送者账号和发消息时的页面号）。
  // 问的时候要带任务绑定的摘要：它来自任务进程那条已经验过签名的内部请求，只在那条请求还在办的时候留着。
  const pageScopes = new Map();
  const pageDenied = () => new PageBridgeError('run-access-denied', 403);
  const pageAuthority = { signalFor: () => null,
    async current(context) {
      const scope = pageScopes.get(context.runGrantId);
      if (!scope) throw pageDenied();
      let source;
      try { source = await runClient.workerEventSource({ projectId: context.projectId, runGrantId: context.runGrantId, assignmentDigest: scope.assignmentDigest }); }
      catch (error) { if ([400, 401, 403, 404, 409].includes(error?.status)) throw pageDenied(); throw new PageBridgeError('run-authority-unavailable', 503); }
      const grant = source?.runGrant;
      if (source?.allowed !== true || !grant || ['projectId', 'conversationId', 'runId', 'runGrantId', 'messageId', 'instanceId', 'instanceGeneration'].some(k => grant[k] !== context[k]) ||
          grant.accountId !== context.senderAccountId || !['active', 'retained'].includes(grant.state) ||
          !Number.isSafeInteger(source.fenceRevision) || source.message?.messageId !== context.messageId || source.message?.senderAccountId !== grant.accountId) throw pageDenied();
      const snapshot = source.message.selectionSnapshot;
      let pageId = null;
      if (snapshot !== null && snapshot !== undefined) {
        if (typeof snapshot !== 'object' || snapshot.source !== 'sent-snapshot' || snapshot.projectId !== context.projectId || snapshot.accountId !== context.senderAccountId ||
            typeof snapshot.pageId !== 'string' || !BRIDGE_PAGE_ID_RE.test(snapshot.pageId) ||
            (snapshot.messageId !== undefined && snapshot.messageId !== context.messageId)) throw new PageBridgeError('run-page-binding-invalid', 403);
        pageId = snapshot.pageId;
      }
      return { accountId: grant.accountId, pageId, fenceRevision: source.fenceRevision, grantState: grant.state };
    } };
  let pageBridge = null;
  try {
    pageBridge = createPageBridge({ databasePath: path.join(dataDir, 'page-requests.sqlite'), runAuthority: pageAuthority, now, log: say,
      // 发起页此刻在不在文档服务的在场表里：任务进程用这一轮自己的数据连接问来的（随内部请求带过来）；发给谁仍只看文档服务给的账号与页面号
      presence: async context => { const scope = pageScopes.get(context.runGrantId);
        return { members: scope ? [{ accountId: context.senderAccountId, isInitiator: true, pages: scope.pages }] : [] }; },
      // 交回的人此刻读不读得到这个对话：和事件流用的是同一个核对（凭他的委托票据问文档服务）
      checkSubmitter: (identity, conversationId) => base.access(identity, conversationId, 'read'),
      extraTools: collectPageTools() });
  } catch (error) { await eventStore.close().catch(() => {}); throw Object.assign(new Error('account-master-page-bridge'), { status: 503, code: 'account-master-page-bridge', cause: error }); }
  const pageHandler = createWorkerPageInternalHandler({ authorityId, resolveWorker: input => runClient.workerEventSource(input),
    async onRequest({ context, envelope, signal }) {
      const key = context.runGrantId, scope = pageScopes.get(key) ?? { uses: 0 };
      scope.assignmentDigest = envelope.assignmentDigest; scope.pages = envelope.request.initiatorPages; scope.uses += 1; pageScopes.set(key, scope);
      try {
        const who = await pageBridge.initiator(context);
        return await pageBridge.requestPage({ run: context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId,
          tool: envelope.request.tool, args: envelope.request.args, requestId: envelope.requestId, deadline: now() + envelope.request.timeoutMs, signal });
      } finally { scope.uses -= 1; if (scope.uses <= 0 && pageScopes.get(key) === scope) pageScopes.delete(key); }
    } });

  // ---------- 对话的云端浏览器数据（在共用数据目录里；浏览器进程在任务进程里） ----------
  const purging = new Map();
  /** 清掉一个对话的浏览器数据。有任务进程正占着它就不动、留记号（那个进程自己清）；回 `{ existed, removed, deferred }` */
  function purgeBrowser(scope, reason) {
    let dir;
    try { dir = hostedBrowserDir(sharedDataDir, scope); } catch { return Promise.resolve({ existed: false, removed: false, deferred: false }); }
    const prior = purging.get(dir);
    const work = (prior ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!fs.existsSync(dir)) return { existed: false, removed: false, deferred: false };
      // 先留记号：万一下面没删成（进程在占着、删到一半这个进程被关），任务进程下次用浏览器之前会照着它清
      try { fs.writeFileSync(path.join(dir, BROWSER_PURGE_MARK), JSON.stringify({ reason, at: now() }), { mode: 0o600 }); } catch { /* 目录刚好没了 */ }
      const reaped = await reapOrphan(dir, { respectLiveOwner: true });
      if (reaped.liveOwner === true || reaped.stillHeld === true) { say('agent.master.browser-purge', { reason, deferred: true }); return { existed: true, removed: false, deferred: true }; }
      const removed = await removeSessionData(dir, { keepRev: !['conversation-deleted', 'project-deleted'].includes(reason) });
      say('agent.master.browser-purge', { reason, removed });
      return { existed: true, removed, deferred: !removed };
    });
    purging.set(dir, work);
    void work.finally(() => { if (purging.get(dir) === work) purging.delete(dir); }).catch(() => {});
    return work;
  }
  /**
   * 清，清不成（任务进程还占着：那一轮正在被 root 关、或发起人自己的那一轮被保留着在跑）就隔一会儿再来，最多两分钟。
   * 到时仍被占着的留给那个任务进程自己清（记号已经留下）。回第一次尝试的结果。
   */
  function purgeBrowserEventually(scope, reason) {
    const first = purgeBrowser(scope, reason);
    void first.then(result => {
      if (!result.deferred) return;
      let left = 60;
      const again = () => {
        if (stopped || left-- <= 0) return;
        const timer = setTimeout(() => { void purgeBrowser(scope, reason).then(next => { if (next.deferred) again(); }, () => {}); }, 2_000);
        timer.unref?.();
      };
      again();
    }, () => {});
    return first;
  }
  /** Agent 被关：这个项目名下各对话的浏览器数据都清（关的时候在跑的任务已经被文档服务叫停、由 root 关进程） */
  async function purgeProjectBrowsers(projectId, reason) {
    let names = [];
    const root = path.dirname(hostedBrowserDir(sharedDataDir, { projectId, conversationId: 'x' }));
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return 0; }
    let count = 0;
    for (const name of names) {
      const dir = path.join(root, name);
      try { fs.writeFileSync(path.join(dir, BROWSER_PURGE_MARK), JSON.stringify({ reason, at: now() }), { mode: 0o600 }); } catch { continue; }
      const reaped = await reapOrphan(dir, { respectLiveOwner: true });
      if (reaped.liveOwner === true || reaped.stillHeld === true) continue;
      if (await removeSessionData(dir, { keepRev: true })) count += 1;
    }
    say('agent.master.browser-purge', { reason, conversations: names.length, removed: count });
    return count;
  }
  /** 文档服务说这个项目的 Agent 开关关了（页面的任何一次读取都会碰到）：清一次这个项目的浏览器数据；之后同一个项目不重复清，直到再开 */
  /**
   * 槽调度来取「这条任务的强制终态」时,文档服务的回答里写着这一轮是因为什么被收回的。创建者关了云端 Agent(agent-disabled)时,
   * 把这个项目名下各对话的浏览器数据都清掉;那一轮的进程这时正被 root 关,所以隔一会儿再清几遍。
   */
  const noteControl = (body, result) => {
    const projectId = body?.projectId;
    if (result?.terminal?.fence?.kind !== 'agent-disabled' || typeof projectId !== 'string') return;
    for (const ms of [0, 3_000, 10_000, 30_000]) { const timer = setTimeout(() => { if (!stopped) void purgeProjectBrowsers(projectId, 'agent-off').catch(() => {}); }, ms); timer.unref?.(); }
  };
  const disabledSeen = new Set();
  const noteDisabled = (identity, error) => {
    const projectId = identity?.projectId;
    if (error?.code !== 'disabled' || typeof projectId !== 'string' || disabledSeen.has(projectId)) return;
    disabledSeen.add(projectId);
    void purgeProjectBrowsers(projectId, 'agent-off').catch(() => {});
  };
  const watched = (name) => async (identity, ...rest) => {
    try { const value = await base[name](identity, ...rest); if (typeof identity?.projectId === 'string') disabledSeen.delete(identity.projectId); return value; }
    catch (error) { noteDisabled(identity, error); throw error; }
  };

  // ---------- 内部口 ----------
  const eventHandler = createWorkerEventInternalHandler({ eventStore, resolveWorker: input => runClient.workerEventSource(input) });
  const reply = (res, status, body) => { if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }); res.end(JSON.stringify(body)); };
  async function schedulerRoute(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'method-not-allowed' });
    // 只认 root 那张证书，直连（不认经反向代理转来的）
    if (req.socket?.encrypted !== true || req.socket.authorized !== true || req.socket.destroyed ||
        certificateFingerprint(req.socket.getPeerCertificate?.()?.fingerprint256) !== controllerPin ||
        Object.keys(req.headers ?? {}).some(k => k === 'forwarded' || k === 'x-real-ip' || k.startsWith('x-forwarded-')))
      return reply(res, 403, { ok: false, code: 'master-scheduler-forbidden' });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) return reply(res, 413, { ok: false, code: 'master-scheduler-body' }); chunks.push(chunk); }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return reply(res, 400, { ok: false, code: 'master-scheduler-body' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400, { ok: false, code: 'master-scheduler-body' });
    try {
      // 原样转问文档服务。回来的东西（排队的对话、强制终态）主服务不改、不补：终态是文档服务签的，root 自己验。
      const result = req.url === MASTER_SCHEDULER_PENDING_PATH ? await runClient.pending() : await runClient.scopeControl(body);
      if (req.url !== MASTER_SCHEDULER_PENDING_PATH) noteControl(body, result);
      if (req.url === MASTER_SCHEDULER_PENDING_PATH) lastSchedulerAt = now();
      reply(res, 200, { ok: true, result });
    } catch (error) {
      // 文档服务说还没准备好（它那一侧的连接没关完）是 503；说不行是 4xx。原样带回，调度据此下一轮再问或记下。
      reply(res, [400, 403, 404, 409].includes(error?.status) ? error.status : 503, { ok: false, code: safe(error?.code) ? error.code : 'master-scheduler-unavailable' });
    }
  }
  server = https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    void (async () => {
      if (stopped) return reply(res, 503, { ok: false, code: 'master-unavailable' });
      if (req.url === WORKER_EVENT_PATH) { if (!await eventHandler(req, res)) reply(res, 404, { ok: false, code: 'no-route' }); return; }
      if (req.url === WORKER_PAGE_PATH) { if (!await pageHandler(req, res)) reply(res, 404, { ok: false, code: 'no-route' }); return; }
      if (req.url === MASTER_SCHEDULER_PENDING_PATH || req.url === MASTER_SCHEDULER_CONTROL_PATH) return schedulerRoute(req, res);
      reply(res, 404, { ok: false, code: 'no-route' });
    })().catch(() => { try { res.destroy(); } catch { /* 已经关了 */ } });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(internalPort, internalHost, () => { server.off('error', reject); resolve(); }); });
  } catch (error) { try { pageBridge.close('listen-failed'); } catch { /* 已经关了 */ } await eventStore.close().catch(() => {}); throw Object.assign(new Error('account-master-listen'), { status: 503, code: 'account-master-listen', cause: error }); }

  // ---------- 接待人的那一面 ----------
  const base = createAccountConversationService({ conversationClient, now });
  const workspaces = createWorkspaces({ dataDir: sharedDataDir, limits: workspaceLimits, log: say });
  const workspaceFor = (identity, conversationId) => workspaces.open({ projectId: identity.projectId, conversationId,
    ownerKey: accountWorkspaceOwnerKey(identity.projectId, conversationId) });
  const mirror = (identity, conversationId) => eventStore.mirrorAccepted({ projectId: identity?.projectId, conversationId,
    read: () => base.conversation(identity, conversationId, 0) });
  const service = { ...base,
    // 这几条读取顺带看一眼「Agent 开关是不是关了」（关了就清这个项目的云端浏览器数据）；结果与错误原样交回
    conversations: watched('conversations'), conversation: watched('conversation'), access: watched('access'),
    /** 页面的事件流挂上反向通道用（`http.mjs` 的 `accountEvents`）；只有这三样，登记表本身不外露 */
    pageBridge: Object.freeze({ attach: input => pageBridge.attach(input) }),
    /** 发起页交回一次请求的结果。身份是 HTTP 层核过委托票据的；发起人、页面号、一次性随机数、这一轮的授权在登记表里逐样重核 */
    async pageResult(identity, conversationId, body) {
      if (!identity || identity.accountMode !== true || typeof identity.accountId !== 'string' || !identity.accountId ||
          typeof identity.projectId !== 'string' || !identity.projectId) throw new AgentServiceError('unauthorized', 'unauthorized', 401);
      // 先核交的人此刻读得到这个对话(读不到、对话不存在:和读对话的接口一样的回法,不进登记表)。登记表里还会再核一次并对权限版本
      await base.access(identity, conversationId, 'read');
      try { return await pageBridge.acceptResult({ identity, conversationId, body }); }
      catch (error) {
        if (error instanceof PageBridgeError) throw new AgentServiceError(error.code, error.code, error.status);
        throw error;
      }
    },
    /** 转私有、转共有。转成私有以后把这个对话的云端浏览器数据清掉（能看这个对话的人换了一批，之前攒下的状态不带过去）。 */
    async switchVisibility(identity, conversationId, visibility, requestId) {
      let out, failure = null;
      try { out = await base.switchVisibility(identity, conversationId, visibility, requestId); }
      catch (error) { failure = error; }
      // 文档服务回「还在办」（503 agent-fence-pending）时对话已经是私有的了，只是别人那一轮的进程还没被 root 关完：同样要清
      if (visibility === 'private' && typeof identity?.projectId === 'string' && (!failure || failure.code === 'agent-fence-pending')) {
        const first = purgeBrowserEventually({ projectId: identity.projectId, conversationId }, 'private');
        if (!failure) { try { await first; } catch (error) { say('agent.master.browser-purge', { reason: 'private', code: error?.code ?? 'error' }); } }
      }
      if (failure) throw failure;
      return out;
    },
    /** 这个对话的云端浏览器数据清掉（对话被删时调；账号模式的删对话接口本身还没有开放，这里先把收场备好） */
    purgeConversationBrowser: (scope, reason = 'conversation-deleted') => purgeBrowserEventually(scope, reason),
    runEvents: eventStore,
    // 看画面由任务进程自己接（它的设置里写没写）；主服务不跑任务，这里如实是「没有」
    look: false,
    mirrorAccepted: mirror,
    schedulerAlive,
    async send(identity, conversationId, body = {}) {
      // 页面带回来的附件地址只认这个对话工作目录里真有的文件（先经 attach 传上来的）；别的一律拒，不悄悄丢掉
      let verifiedAttachments = null;
      if (body.verifiedAttachments !== undefined) throw new AgentServiceError('bad-request', 'bad-request', 400);
      if (Array.isArray(body.attachments) && body.attachments.length) {
        if (!workspaces.available || body.attachments.length > 32) throw new AgentServiceError('bad-request', 'bad-request', 400);
        const workspace = workspaceFor(identity, conversationId); verifiedAttachments = [];
        for (const item of body.attachments) {
          const url = typeof item?.url === 'string' ? item.url : '';
          let stat = null;
          if (/^work:attachments\/[^\\/]{1,200}$/.test(url)) { try { stat = workspace.stat(url.slice(5)); } catch { stat = null; } }
          if (!stat || !(stat.size > 0) || verifiedAttachments.some(row => row.url === url)) throw new AgentServiceError('attachment-missing', 'attachment-missing', 400);
          verifiedAttachments.push({ name: url.slice('work:attachments/'.length), url, size: stat.size });
        }
      }
      const response = await base.send(identity, conversationId, { ...body, ...(verifiedAttachments ? { verifiedAttachments } : {}) });
      // 文档服务回的是元数据，不是原文：从它那里读回已接受的原文再落进事件库，读不到就把错抛出去
      await mirror(identity, conversationId);
      return response;
    },
    /**
     * 停止。文档服务当场给这条任务下围栏（权限立刻没了）；「办完」要等 root 真的把那一代进程关掉、文档服务读到关闭记录。
     * 没办完时文档服务回 503 `agent-fence-pending`：这里凭同一个请求号隔一会儿再问，最多等 `stopWaitMs`，到时仍没办完原样回它。
     */
    async abort(identity, conversationId, runId, requestId = randomUUID()) {
      const deadline = now() + stopWaitMs;
      for (;;) {
        try { return await base.abort(identity, conversationId, runId, requestId); }
        catch (error) {
          if (stopped || error?.status !== 503 || error.code !== 'agent-fence-pending' || now() >= deadline) throw error;
          await delay(200);
        }
      }
    },
    /** 存一个附件到这个对话的工作目录（各代任务进程共用的那个数据目录里）。回 `{ name, url, size, kind, text? }`。 */
    async attach(identity, conversationId, name, stream) {
      // 先向文档服务核这张委托票据和这个人：能发消息的人（项目里可写的成员）才能传。对话已经在了就再核他读得到它，
      // 并且不是「创建者只读地看别人的私有对话」那一种。对话还没有（先选附件、后发第一条）时只凭项目里的身份收下：
      // 文件只落在这个对话自己的工作目录里，进不进素材库由导入时这条任务的写权限定。
      if (!identity || identity.accountMode !== true || typeof identity.delegation !== 'string' || !identity.delegation ||
          typeof identity.projectId !== 'string' || !identity.projectId) throw new AgentServiceError('unauthorized', 'unauthorized', 401);
      let who;
      try { who = await conversationClient.identity({ delegation: identity.delegation, projectId: identity.projectId }); }
      catch (error) { throw new AgentServiceError(error?.code ?? 'conversation-unavailable', error?.code ?? 'conversation-unavailable', Number.isInteger(error?.status) ? error.status : 503); }
      if (who?.access !== 'rw') throw new AgentServiceError('forbidden', 'forbidden', 403);
      if (!workspaces.available) throw new AgentServiceError('attachment-unavailable', 'attachment storage is not mounted', 503);
      // 这个人看得到的对话清单（文档服务按他的权限给）：在清单里的，不能是「创建者只读地看别人的私有对话」那一种。
      // 不在清单里的当成还没发过消息的新对话收下——别人的私有对话他看不到、也猜不到对话号；真猜中了也只是往里多放一个文件
      // （不覆盖已有的），读不回来，能不能进素材库仍由那条任务自己的写权限定。
      const listed = (await base.conversations(identity)).find(row => row?.id === conversationId);
      if (listed && listed.creatorReadOnly === true) throw new AgentServiceError('forbidden', 'forbidden', 403);
      const workspace = workspaceFor(identity, conversationId);
      try { return await saveAttachment(workspace, name, stream, attachmentLimits); }
      catch (error) {
        if (error?.workspace) throw new AgentServiceError(['quota', 'too-large'].includes(error.code) ? 'too-large' : 'bad-request', error.message, ['quota', 'too-large'].includes(error.code) ? 413 : 400);
        if (error?.code === 'too-large') throw new AgentServiceError('too-large', error.message, 413);
        if (error?.code === 'bad-request') throw new AgentServiceError('bad-request', error.message, 400);
        throw error;
      }
    },
    async info(identity) {
      try { const value = await base.info(identity); if (typeof identity?.projectId === 'string') disabledSeen.delete(identity.projectId); return { ...value, executorMounted: schedulerAlive() }; }
      catch (error) { noteDisabled(identity, error); throw error; }
    },
    describe: () => ({ accountMode: true, runAuthorityMounted: true, taskProcesses: true, schedulerAlive: schedulerAlive(), at: now() }),
    close() { /* 由装配的 close 统一收 */ },
  };

  void startReadControl();
  const close = () => closing ??= (async () => {
    stopped = true; if (registerTimer) clearTimeout(registerTimer);
    const closedSockets = [...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    const results = await Promise.allSettled([...closedSockets,
      server.listening ? new Promise(resolve => server.close(resolve)) : null, readControl.close()]);
    // 在等发起页的请求全部收掉（登记表里标成取消）；在清的浏览器数据等它清完
    results.push(...await Promise.allSettled([Promise.resolve().then(() => pageBridge.close('master-close')), ...purging.values()]));
    results.push(...await Promise.allSettled([eventStore.close()]));
    const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
    if (errors.length) throw new AggregateError(errors, 'account-master-close-pending');
  })();
  return { service, eventStore, close, internalPort: server.address().port, schedulerAlive,
    /** 不经内部口、在同一个进程里直接给调度用的那两条（没有 root 分离的机器和测试）。 */
    master: { async pending() { const value = await runClient.pending(); lastSchedulerAt = now(); return value; },
      async scopeControl(row) { const result = await runClient.scopeControl(row); noteControl(row, result); return result; } },
    pageBridge, purgeBrowser, purgeProjectBrowsers,
    describe: () => ({ registered, schedulerAlive: schedulerAlive(), lastSchedulerAt, internalSockets: sockets.size, internalPort: server.address()?.port ?? null,
      pageBridge: pageBridge.describe() }) };
}
