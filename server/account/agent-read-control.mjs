import { accountError } from './client.mjs';
import { canonicalJson, digestOf } from './ledger.mjs';
import { assertInstanceDirectTransport, instanceRequestProof } from './agent-instance-internal.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const clone = value => structuredClone(value);
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const instanceKeys = ['serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'];
const sameInstance = (a, b) => instanceKeys.every(key => a?.[key] === b?.[key]);
const tables = state => (state.agentReadsV1 ??= { head: 0, controls: [], handles: {}, instances: {}, nonces: {}, requests: {} });
/** 每个实例最多留多少条已关的读取。每次 HTTP 读取都开一条、用完就关，原来一条都不删，账本跟着无限变大
 * （2026-10-17 节点上一个实例攒了四百多条，占了账本的七成多）。留最近的几十条，够关闭和开启的重试认出原来那条。 */
export const KEEP_CLOSED_READS_PER_INSTANCE = 64;
export const KEEP_READ_CONTROL_NONCES = KEEP_CLOSED_READS_PER_INSTANCE * 4;
/** 删掉用不着的已关读取，连同指向它的开启请求记录。还有控制记录在等它的回执（目标里列了它、还没回执）的不删。
 * 开启请求号每次读取都是新的随机号，读取关了以后 Agent 不会再拿同一个号来开，所以删掉记录不会让关过的读取重新开出来。 */
export function pruneClosedReads(state, keep = KEEP_CLOSED_READS_PER_INSTANCE) {
  const t = state.agentReadsV1;
  if (!t) return 0;
  const waiting = new Set();
  for (const control of t.controls)
    for (const target of Object.values(control.targets)) if (!target.receipt) for (const id of target.readHandleIds) waiting.add(id);
  const closedByInstance = new Map();
  for (const handle of Object.values(t.handles)) {
    if (handle.state !== 'closed' || !handle.closeReceipt || waiting.has(handle.readHandleId)) continue;
    const key = instanceKeys.map(k => handle[k]).join('\n');
    if (!closedByInstance.has(key)) closedByInstance.set(key, []);
    closedByInstance.get(key).push(handle.readHandleId);
  }
  const removed = new Set();
  // 实例本身已经收口（主服务换了新一代，旧一代 `closed` 且有收口记录）：它不会再拿这些读取来关闭或开启重试，一条都不用留。
  // 2026-10-19 节点上 8 个退出了的旧主服务各留 64 条，占了这本账四分之一（每次读取都要整段解析、整段写回）。
  const finished = key => { const row = state.agentInstancesV2?.[key.split('\n')[2]];
    return row?.state === 'closed' && Boolean(row.closure) && row.instanceGeneration === Number(key.split('\n')[3]); };
  // 对象按插入顺序遍历，前面的是早关的那批
  for (const [key, ids] of closedByInstance) for (const id of ids.slice(0, finished(key) ? ids.length : Math.max(0, ids.length - keep))) removed.add(id);
  if (!removed.size) return 0;
  for (const id of removed) delete t.handles[id];
  for (const [key, row] of Object.entries(t.requests)) if (removed.has(row.readHandleId)) delete t.requests[key];
  return removed.size;
}
/** 用过的一次性随机数留多久。每个请求的签名都绑着它自己那条 TLS 连接（`channelBinding`），一条连接只发一个请求就关，
 * 换一条连接重放签名就对不上；随机数表只是同一条连接里的那一道补充，用不着永远留着。原来一条不删，
 * 页面每 3 秒取一次对话就写进两三条，一小时一万多条，把账本撑到一百多万字节（2026-10-17 实测，又把文档服务主线程占满）。 */
export const READ_NONCE_TTL_MS = 10 * 60_000;
/** 删掉过了留存期的随机数；原来存成 `true`、没有时间的老记录一并删掉；同时按条数上限封顶。 */
export function pruneNonces(t, at, ttl = READ_NONCE_TTL_MS, maxCount = KEEP_READ_CONTROL_NONCES) {
  let removed = 0;
  for (const [key, value] of Object.entries(t.nonces)) {
    if (value === true || typeof value !== 'number' || value < at - ttl) { delete t.nonces[key]; removed++; }
  }
  const keys = Object.keys(t.nonces);
  for (const key of keys.slice(0, Math.max(0, keys.length - maxCount))) {
    delete t.nonces[key]; removed++;
  }
  return removed;
}
export const CONVERSATION_CONTROL_ROOT = '/internal/v2/conversation-controls/';
export const conversationControlOperations = Object.freeze({ subscribe: 'conversationControlSubscribe',
  open: 'conversationReadOpen', close: 'conversationReadClose', ack: 'conversationControlAck',
  // 〔裁〕H07：实例报「我在哪个数据目录的独占锁下跑」；后继实例凭同一把锁交「前一个已经不在了」（见 handover）
  lease: 'conversationInstanceLease', handover: 'conversationInstanceHandover' });

/** 一条访问事件（旧登录作废、被踢等）在 Agent 这一侧的任务是否都收口了。只读账本，不改。
 *
 * 看的是请求号为 `access:<事件号>` 的任务控制记录：
 * - 没开「一条任务一个进程」（`scoped` 为假）：这一档没有任何办法证明一条任务占着的进程资源已经关掉，
 *   所以只有任务清单是空的（没有要中止的、没有保留的、没有牵涉到的实例）才算收口。
 * - 开了（`scoped` 为真）：要中止的每一条任务（私有对话里的、还没被读到的）都凭 root 的关闭记录结清了才算；
 *   还没绑到进程上就被撤掉的任务没有进程可关，不用等。保留下来继续跑的任务（共有对话里已读的当前任务）
 *   不在等的范围里：确认设备已退出不要求等它做完（`docs/plan/account-binding-contract.md`「改密、退出动画与延迟撤回」）。
 */
export function accessEventRunClosure(state, eventId, { scoped = false } = {}) {
  const controls = Object.values(state.runControlsV2 ?? {}).filter(c => c.requestId === `access:${eventId}`);
  const stoppedRuns = [], retainedRuns = [], pending = [];
  for (const control of controls) {
    if (!scoped) {
      if (control.instances.length || control.revoked.length || control.retained.length) pending.push(control.controlId);
      continue;
    }
    for (const id of control.retained) retainedRuns.push(state.runGrantsV2[id].runId);
    for (const id of control.revoked) {
      const grant = state.runGrantsV2?.[id], closure = state.runScopeClosuresV1?.[id];
      if (!grant) { pending.push(control.controlId); continue; }
      if (!grant.scopeBinding) continue;
      if (grant.state !== 'finished' || !closure?.closureWitnessDigest) { pending.push(control.controlId); continue; }
      stoppedRuns.push({ runId: grant.runId, closureWitnessDigest: closure.closureWitnessDigest });
    }
  }
  const byRun = (a, b) => (a.runId ?? a) < (b.runId ?? b) ? -1 : 1;
  return { complete: pending.length === 0, pending: [...new Set(pending)].sort(),
    stoppedRuns: stoppedRuns.sort(byRun), retainedRuns: [...new Set(retainedRuns)].sort() };
}

/** The whole exact request is the capability scope, including the fresh nonce.
 * Ordinary run metadata/read/write capabilities cannot authorize these APIs. */
export function conversationControlScope(operation, body) {
  const action = Object.keys(conversationControlOperations).find(key => conversationControlOperations[key] === operation);
  const shapes = { subscribe: ['requestId', 'nonce'], open: ['requestId', 'nonce', 'delegation', 'projectId', 'conversationId', 'action', 'after'],
    close: ['requestId', 'nonce', 'readHandleIds'], ack: ['requestId', 'nonce', 'controlId', 'payloadDigest', 'seq', 'readHandleIds'],
    lease: ['requestId', 'nonce', 'lockId', 'machine'], handover: ['requestId', 'nonce', 'instanceId', 'instanceGeneration'] };
  if (!action || !body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== [...shapes[action]].sort().join(',') ||
      !reference(body.requestId) || !reference(body.nonce)) fail(400, 'read-control-request-invalid');
  if (action === 'open' && (typeof body.delegation !== 'string' || !body.delegation || body.delegation.length > 8192 ||
      !reference(body.projectId) || (body.conversationId !== null && !reference(body.conversationId)) ||
      !['get', 'list', 'access'].includes(body.action) || !Number.isSafeInteger(body.after) || body.after < 0)) fail(400, 'read-control-request-invalid');
  if (['close', 'ack'].includes(action) && (!Array.isArray(body.readHandleIds) || body.readHandleIds.length > 1024 ||
      new Set(body.readHandleIds).size !== body.readHandleIds.length || !body.readHandleIds.every(reference))) fail(400, 'read-control-request-invalid');
  if (action === 'ack' && (!reference(body.controlId) || !/^[a-f0-9]{64}$/.test(body.payloadDigest ?? '') ||
      !Number.isSafeInteger(body.seq) || body.seq < 1)) fail(400, 'read-control-request-invalid');
  // machine 只收 64 位十六进制摘要（Agent 那边的 leaseMachineDigest）：别的形状一律拒，账本里就进不来可读的机器识别码
  if (action === 'lease' && (!reference(body.lockId) || !/^[a-f0-9]{64}$/.test(body.machine ?? ''))) fail(400, 'read-control-request-invalid');
  if (action === 'handover' && (!reference(body.instanceId) || !Number.isSafeInteger(body.instanceGeneration) ||
      body.instanceGeneration < 1)) fail(400, 'read-control-request-invalid');
  return { operation, request: clone(body) };
}

/** Mounted only on doc's existing pinned Agent mTLS server. No public header can
 * replace the actual TLS socket, exporter, or currently registered instance. */
export function createAgentReadControlHandler({ control, resolveServicePrincipal, instanceAuthority }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'https://internal.invalid');
    if (!url.pathname.startsWith(CONVERSATION_CONTROL_ROOT)) return false;
    let invocation, unsubscribe, timer;
    try {
      assertInstanceDirectTransport(req);
      if (req.method !== 'POST' || url.search) fail(400, 'read-control-request-invalid');
      const action = url.pathname.slice(CONVERSATION_CONTROL_ROOT.length), operation = conversationControlOperations[action];
      if (!operation) fail(404, 'read-control-no-route');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) fail(413, 'read-control-body-too-large'); chunks.push(chunk); }
      let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { fail(400, 'read-control-request-invalid'); }
      conversationControlScope(operation, body);
      const base = await resolveServicePrincipal({ socket: req.socket });
      invocation = instanceAuthority.authenticate({ servicePrincipal: base, method: req.method, path: url.pathname,
        operation, request: body, proof: instanceRequestProof(req) });
      const servicePrincipal = { ...base, ...invocation };
      if (action === 'subscribe') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'connection': 'close' });
        const closed = new Promise(resolve => { res.once('close', resolve); req.once('aborted', resolve); });
        unsubscribe = control.subscribe({ servicePrincipal, body,
          send(frame) { if (res.destroyed || res.writableEnded) fail(503, 'read-control-disconnected');
            res.write(JSON.stringify(frame) + '\n'); },
          onFailure: () => res.destroy() });
        timer = setInterval(() => control.publish(), 1000); timer.unref?.();
        await closed;
      } else {
        const result = await ({ open: control.open, close: control.closeReads, ack: control.acknowledge,
          lease: control.declareLease, handover: control.handover })[action]({ servicePrincipal, body });
        if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result })); }
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) { res.writeHead(error.status ?? 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, code: error.code ?? 'read-control-unavailable' })); }
    } finally { clearInterval(timer); unsubscribe?.(); if (invocation) instanceAuthority.release(invocation.instanceSession); }
    return true;
  };
}

/** One SQLite authority for HTTP read inventory and close controls. Network
 * adapters must derive servicePrincipal from an actual authenticated socket and
 * release invocation capabilities only after the complete request/stream ends.
 * Unknown historical OS instances never become closed through an empty list.
 *
 * 〔裁〕H07（Agent 服务重启时有人开着云端对话页，之后的退出办不完）：一个实例开着的读取，只有两种办法收口：
 * 1. 它自己关掉、确认（照旧）；
 * 2. 它的进程确实不在了：后继实例凭「同一个数据目录的独占锁」交来证据（`handover`）。Agent 那一侧每个读取控制客户端
 *    在数据目录里握着一把操作系统的独占锁（`conversation-control-client.mjs`），握着锁时才报锁、才订阅、才开读取；
 *    进程结束（含被硬杀）或正常收口（读取全关完）以后锁才放开。所以后继拿到了锁，前一个握过这把锁的实例就不可能再往页面写东西。
 *    文档服务这边核：两个实例各自报过的锁号与机器码相同（各自用自己的实例钥匙签的，后继冒充不了前一个）、同一个服务身份、
 *    后继是更新的一代、前一个此刻没有连着本进程的订阅流。核过了才把前一个记成已收口。
 * 「新一代登记了」「连接断了」「过了多久」都不当证据（原来凭「更新一代的只做控制的主服务订阅了」就收口，已去掉）。 */
export function createAgentReadControl({ ledger, instanceAuthority, authorizeRead, checkReadInState,
  synchronize = async () => {}, onProgress = () => {}, now = Date.now } = {}) {
  if (![ledger?.read, ledger?.transaction, instanceAuthority?.verifyInState, authorizeRead, checkReadInState]
    .every(value => typeof value === 'function')) fail(503, 'read-control-configuration');
  const streams = new Map(), waiters = new Set(), seenNonces = new Set(); let stopped = false;
  const instance = (state, servicePrincipal, action, body) => {
    const operation = conversationControlOperations[action]; conversationControlScope(operation, body);
    if (stopped) fail(503, 'read-control-closed');
    return instanceAuthority.verifyInState(state, servicePrincipal, { operation, input: body });
  };
  const rememberNonce = key => {
    seenNonces.add(key);
    if (seenNonces.size > KEEP_READ_CONTROL_NONCES * 4) {
      const oldest = seenNonces.values().next().value;
      if (oldest !== undefined) seenNonces.delete(oldest);
    }
  };
  const nonce = (state, who, body) => {
    const key = digestOf({ instanceId: who.instanceId, nonce: body.nonce });
    const t = tables(state), at = now();
    if (t.nonces[key] || seenNonces.has(key)) fail(409, 'read-control-replay');
    t.nonces[key] = at; rememberNonce(key);
    pruneNonces(t, at);
  };
  /** 把一个已经证明不在了的实例记成已收口：它名下没关的读取记已关、等它的控制记录补上回执、实例本身记 `closed`。
   * 只由 `handover` 调；调之前要核完证据（见下）。 */
  function closeGoneInstanceInState(state, prior, closure) {
    const t = tables(state), priorWho = Object.fromEntries(instanceKeys.map(k => [k, prior[k]]));
    prior.state = 'closed'; prior.closure = closure;
    for (const handle of Object.values(t.handles)) {
      if (!sameInstance(handle, priorWho) || (handle.state === 'closed' && handle.closeReceipt)) continue;
      handle.state = 'closed';
      handle.closeReceipt ??= { requestId: closure.witnessId, ...priorWho };
    }
    for (const control of t.controls) {
      const target = control.targets[prior.instanceId];
      if (!target || target.receipt || !sameInstance(target, priorWho)) continue;
      target.receipt = { controlId: control.controlId, seq: control.seq, payloadDigest: control.payloadDigest,
        ...priorWho, closedReadHandleIds: [...target.readHandleIds].sort() };
    }
  }
  const requireLive = who => {
    const stream = streams.get(who.instanceId);
    if (!stream || !sameInstance(stream.who, who)) fail(503, 'read-control-disconnected');
    stream.verify();
    return stream;
  };
  function subscribe({ servicePrincipal, body, send, onFailure }) {
    if (typeof send !== 'function' || typeof onFailure !== 'function') fail(503, 'read-control-configuration');
    const who = ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'subscribe', body); nonce(state, who, body);
      const t = tables(state), old = t.instances[who.instanceId];
      if (old && !sameInstance(old, who)) fail(403, 'read-instance-mismatch');
      t.instances[who.instanceId] ??= { ...who };
      return who;
    });
    // A reconnect invalidates the old stream before publishing any ready frame.
    streams.get(who.instanceId)?.close();
    const stream = { who, seq: 0, closed: false,
      verify() { instance(ledger.read(), servicePrincipal, 'subscribe', body); },
      close() { if (stream.closed) return; stream.closed = true;
        if (streams.get(who.instanceId) === stream) streams.delete(who.instanceId); onFailure(); },
      pump() {
        if (stream.closed) return;
        try {
          stream.verify(); const state = ledger.read(), t = tables(state);
          for (const control of t.controls) {
            if (control.seq <= stream.seq) continue;
            if (control.seq !== stream.seq + 1) fail(503, 'read-control-gap');
            const target = control.targets[who.instanceId];
            send({ type: 'control', authorityId: ledger.authorityId, seq: control.seq,
              controlId: control.controlId, payloadDigest: control.payloadDigest,
              readHandleIds: target?.readHandleIds ?? [], required: Boolean(target && !target.receipt),
              unknownInstance: target?.unknownInstance === true });
            stream.seq = control.seq;
          }
          send({ type: 'ready', authorityId: ledger.authorityId, ...who, head: t.head,
            openReadHandleIds: Object.values(t.handles).filter(h => sameInstance(h, who) && h.state !== 'closed').map(h => h.readHandleId) });
        } catch { stream.close(); }
      } };
    streams.set(who.instanceId, stream); stream.pump();
    return () => stream.close();
  }
  const publish = () => { for (const stream of streams.values()) stream.pump(); };
  async function open({ servicePrincipal, body }) {
    const who = instance(ledger.read(), servicePrincipal, 'open', body); requireLive(who);
    await synchronize();
    // The adapter resolves the opaque delegation, and doc reconstructs the
    // principal. No caller-supplied user/creator/run field becomes authority.
    const principal = await authorizeRead(body);
    // 同一个长连接（如 SSE 事件流）已经开好读取且仍在 open 状态时，后续 250ms 轮询只需在内存里验单次随机数与当前权限，不必每秒重写整本 SQLite 账本。
    const currentState = ledger.read(), currentNow = instance(currentState, servicePrincipal, 'open', body);
    requireLive(currentNow);
    const reqKey = digestOf({ instanceId: currentNow.instanceId, requestId: body.requestId });
    const reqBinding = (who, p) => ({ ...who, projectId: body.projectId, conversationId: body.conversationId,
      ...Object.fromEntries(['accountId', 'loginId', 'loginGeneration'].map(k => [k, p[k]])) });
    const existing = currentState.agentReadsV1?.requests?.[reqKey];
    if (existing) {
      const nonceKey = digestOf({ instanceId: currentNow.instanceId, nonce: body.nonce });
      if (currentState.agentReadsV1?.nonces?.[nonceKey] || seenNonces.has(nonceKey)) fail(409, 'read-control-replay');
      rememberNonce(nonceKey);
      const value = checkReadInState(currentState, principal, body);
      const binding = { ...reqBinding(currentNow, principal), credentialId: principal.credentialId };
      if (existing.digest !== digestOf(reqBinding(currentNow, principal)) && existing.digest !== digestOf(binding))
        fail(409, 'read-request-mismatch');
      const handle = currentState.agentReadsV1?.handles?.[existing.readHandleId];
      if (handle?.state !== 'open') fail(403, 'read-handle-closed');
      return { readHandle: { ...clone(handle), credentialId: principal.credentialId }, value };
    }
    return ledger.transaction(state => {
      const current = instance(state, servicePrincipal, 'open', body); requireLive(current); nonce(state, current, body);
      const value = checkReadInState(state, principal, body);
      const t = tables(state), reqDigest = digestOf(reqBinding(current, principal));
      const binding = { ...reqBinding(current, principal), credentialId: principal.credentialId };
      const key = digestOf({ instanceId: current.instanceId, requestId: body.requestId });
      const old = t.requests[key];
      if (old) {
        if (old.digest !== reqDigest && old.digest !== digestOf(binding)) fail(409, 'read-request-mismatch');
        const handle = t.handles[old.readHandleId];
        if (handle.state !== 'open') fail(403, 'read-handle-closed');
        handle.credentialId = principal.credentialId;
        return { readHandle: clone(handle), value };
      }
      const handle = { ...binding, readHandleId: `read_${key}`, state: 'open', head: t.head };
      t.handles[handle.readHandleId] = handle; t.requests[key] = { digest: reqDigest, readHandleId: handle.readHandleId };
      return { readHandle: clone(handle), value };
    });
  }
  function closeReads({ servicePrincipal, body }) {
    return ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'close', body); nonce(state, who, body);
      const t = tables(state);
      for (const id of body.readHandleIds) {
        const handle = t.handles[id]; if (!handle || !sameInstance(handle, who)) fail(403, 'read-instance-mismatch');
        handle.state = 'closed';
        handle.closeReceipt ??= { requestId: body.requestId, ...who };
      }
      pruneClosedReads(state);
      return { closedReadHandleIds: [...body.readHandleIds] };
    });
  }
  function fenceInState(state, fence) {
    if (!reference(fence.requestId)) fail(400, 'read-fence-invalid');
    if (!['credential', 'member', 'private', 'stop', 'delete', 'agent-disabled', 'service-revoked', 'instance-revoked'].includes(fence.kind)) fail(400, 'read-fence-invalid');
    const t = tables(state), scope = Object.fromEntries(['kind', 'projectId', 'conversationId', 'runId', 'serviceKid',
      'instanceId', 'instanceGeneration', 'requestId'].map(k => [k, fence[k] ?? null]));
    const id = `read-control:${digestOf(scope)}`, digest = digestOf(fence), old = t.controls.find(c => c.controlId === id);
    if (old) { if (old.payloadDigest !== digest) fail(409, 'read-control-mismatch'); return clone(old); }
    const control = { controlId: id, payloadDigest: digest, seq: ++t.head, scope,
      accessSeq: fence.accessSeq ?? null, targets: {} };
    for (const handle of Object.values(t.handles)) {
      if (handle.state === 'closed' || fence.kind === 'stop' ||
          (fence.projectId && fence.projectId !== handle.projectId) ||
          (fence.conversationId && handle.conversationId && fence.conversationId !== handle.conversationId) ||
          (fence.loginIds && !fence.loginIds.includes(handle.loginId)) ||
          (fence.accountIds && !fence.accountIds.includes(handle.accountId)) ||
          (fence.serviceKid && fence.serviceKid !== handle.serviceKid) ||
          (fence.instanceId && (fence.instanceId !== handle.instanceId || fence.instanceGeneration !== handle.instanceGeneration))) continue;
      if (fence.kind === 'private') {
        const c = state.conversationsV2?.[fence.projectId]?.[fence.conversationId];
        if (!c) fail(503, 'read-fence-conversation-missing');
        if (handle.accountId === c.ownerAccountId || handle.accountId === state.projects[fence.projectId]?.creatorAccountId) continue;
      }
      handle.state = 'closing';
      const target = control.targets[handle.instanceId] ??= { ...Object.fromEntries(instanceKeys.map(k => [k, handle[k]])),
        readHandleIds: [], receipt: null, unknownInstance: false };
      target.readHandleIds.push(handle.readHandleId);
    }
    // Instances created before mandatory read inventory cannot prove empty by
    // reconnecting with the same certificate, or by registering a new RAM key.
    for (const row of Object.values(state.agentInstancesV2 ?? {})) {
      if (row.state === 'closed' && row.closure) continue;
      if (t.instances[row.instanceId] || fence.kind === 'stop') continue;
      // 只跑一条任务的进程用不了读对话的接口（实例权威里拒掉），名下不可能有读取；它的进程资源由任务的关闭记录管，不在这里等。
      if (row.purpose === 'run-worker') continue;
      // 〔裁〕H07：登记在「本账本的读取必须清点」之后、又从没订阅过的实例，名下不可能有读取：开读取要先有本进程里活着的订阅流
      // （`open` 的 `requireLive`），订阅时就记进了 `t.instances`；对话数据接口也只认经读取控制开的读取。原来照样把它当
      // 「来历不明」一直等，而「来历不明」的目标谁都确认不了（`acknowledge` 拒掉），于是主服务刚登记、还没订阅上的那一会儿
      // 赶上一次退出，这次退出就永远办不完。更早登记的（这条规矩生效以前的）照旧按来历不明等。
      if (Number.isSafeInteger(t.inventorySinceGeneration) && row.instanceGeneration > t.inventorySinceGeneration) continue;
      control.targets[row.instanceId] = { ...Object.fromEntries(instanceKeys.map(k => [k, row[k]])),
        readHandleIds: [], receipt: null, unknownInstance: true };
    }
    t.controls.push(control);
    // Runs after the synchronous SQLite commit; rollback leaves nothing to send.
    queueMicrotask(() => { publish(); onProgress(); });
    return clone(control);
  }
  function reconcileInState(state) {
    const t = tables(state);
    for (const e of state.accessEvents ?? []) {
      if (e.seq <= (t.accessCursor ?? 0)) continue;
      if (!t.controls.some(c => c.accessSeq === e.seq)) {
        const base = { requestId: `access:${e.eventId}`, accessSeq: e.seq, ...(e.projectId ? { projectId: e.projectId } : {}) };
        if (e.type === 'login-revoked') fenceInState(state, { ...base, kind: 'credential', loginIds: e.loginIds });
        else if (e.type === 'project-access-changed') {
          if (e.reason === 'delete') fenceInState(state, { ...base, kind: 'delete' });
          else if (e.reason === 'set-hosted-service' && e.service === 'agent' && e.enabled === false)
            fenceInState(state, { ...base, kind: 'agent-disabled' });
          else if (e.accountIds?.length) fenceInState(state, { ...base, kind: 'member', accountIds: e.accountIds });
        }
      }
      t.accessCursor = e.seq;
    }
  }
  function reconcileAccessEvents() {
    const s = ledger.read(), t = s.agentReadsV1;
    if (t && (t.accessCursor ?? 0) >= (s.accessEvents?.at(-1)?.seq ?? 0)) return;
    ledger.transaction(reconcileInState);
  }
  ledger.transaction(state => {
    state.agentReadControlRequired = true;
    const t = tables(state);
    // 从这一代往后登记的实例，开读取一定先订阅（见 fenceInState）；只记一次
    if (!Number.isSafeInteger(t.inventorySinceGeneration)) t.inventorySinceGeneration = state.agentInstanceGenerationV2 ?? 0;
    pruneClosedReads(state);
    pruneNonces(t, now());
  });
  /** 实例报自己在哪把锁下跑：锁号（Agent 数据目录里那把独占锁的号）和机器摘要。用自己的实例钥匙签，一个实例只报一次、报了不能改。
   * 每一份按报上来的先后记一个序号（`declaredSeq`）：Agent 那边握着锁才报，所以同一把锁下报得早的，一定是先握锁的那个。
   * 后继要交「前一个已经不在了」的证据，两边报的必须是同一把锁、同一台机器，而且前一个报得更早（见 handover）。 */
  function declareLease({ servicePrincipal, body }) {
    return ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'lease', body); nonce(state, who, body);
      const t = tables(state), leases = t.leases ??= {}, old = leases[who.instanceId];
      const lease = { ...who, lockId: body.lockId, machine: body.machine };
      if (old) {
        const { declaredSeq, ...same } = old;
        if (canonicalJson(same) !== canonicalJson(lease)) fail(409, 'read-lease-mismatch');
        return clone(old);
      }
      leases[who.instanceId] = { ...lease, declaredSeq: t.leaseHead = (t.leaseHead ?? 0) + 1 };
      return clone(leases[who.instanceId]);
    });
  }
  /** 〔裁〕H07：后继实例交「前一个实例的进程已经不在了」。证据是 Agent 那一侧的独占锁：前一个在握着这把锁的时候才报锁、订阅、
   * 开读取，锁要等它的进程结束（或它正常收口、读取全关完）才放开；后继现在握着同一把锁，前一个就不可能再往页面写东西。
   * 文档服务核的是它自己核得了的那几样，任何一样不符都不收口（照旧等，不放过）：
   * - 前一个是同一个服务身份（证书与钥匙号）、同一种用途，不是只跑一条任务的进程；
   * - 两个实例各自报过锁（`declareLease`），是同一把锁、同一台机器，而且前一个报得更早。不看代次：主服务先登记、后拿锁，
   *   两个主服务交叠着起来时，代次低的可能后拿到锁（审查用例 F2），握锁的先后只有报锁的先后说得准；
   * - 前一个此刻没有连着本进程的订阅流（连着就说明它还活着，和证据矛盾：拒掉，让后继稍后再试）。 */
  function handover({ servicePrincipal, body }) {
    let progressed = false;
    const result = ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'handover', body); nonce(state, who, body);
      const t = tables(state), leases = t.leases ?? {}, rows = state.agentInstancesV2 ?? {};
      const prior = rows[body.instanceId];
      if (!prior || prior.instanceGeneration !== body.instanceGeneration) fail(404, 'read-handover-unknown');
      const priorWho = Object.fromEntries(instanceKeys.map(k => [k, prior[k]]));
      if (prior.state === 'closed' && prior.closure) return { ...priorWho, closed: true };
      if (prior.instanceId === who.instanceId || prior.serviceId !== who.serviceId || prior.serviceKid !== who.serviceKid ||
          prior.purpose === 'run-worker' || (prior.purpose ?? null) !== (rows[who.instanceId]?.purpose ?? null)) fail(403, 'read-handover-forbidden');
      const mine = leases[who.instanceId], theirs = leases[prior.instanceId];
      if (!mine || !theirs || !sameInstance(mine, who) || !sameInstance(theirs, priorWho) ||
          mine.lockId !== theirs.lockId || mine.machine !== theirs.machine) fail(403, 'read-handover-unproven');
      if (!(Number.isSafeInteger(theirs.declaredSeq) && Number.isSafeInteger(mine.declaredSeq) && theirs.declaredSeq < mine.declaredSeq))
        fail(403, 'read-handover-forbidden');
      if (streams.has(prior.instanceId)) fail(409, 'read-handover-predecessor-live');
      closeGoneInstanceInState(state, prior, { complete: true, witnessId: `handover:${who.instanceId}:${who.instanceGeneration}`,
        evidence: 'agent-data-dir-exclusive-lock', lockId: theirs.lockId,
        handoverByInstanceId: who.instanceId, handoverByGeneration: who.instanceGeneration });
      delete leases[prior.instanceId];
      pruneClosedReads(state); progressed = true;
      return { ...priorWho, closed: true };
    });
    if (progressed) queueMicrotask(() => { for (const wake of waiters) wake(); onProgress(); });
    return result;
  }
  function acknowledge({ servicePrincipal, body }) {
    const result = ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'ack', body); nonce(state, who, body);
      const t = tables(state), control = t.controls.find(c => c.controlId === body.controlId), target = control?.targets[who.instanceId];
      if (!control || control.seq !== body.seq || control.payloadDigest !== body.payloadDigest || !target ||
          !sameInstance(target, who) || target.unknownInstance ||
          canonicalJson([...target.readHandleIds].sort()) !== canonicalJson([...body.readHandleIds].sort())) fail(403, 'read-control-receipt-mismatch');
      if (target.readHandleIds.some(id => t.handles[id]?.state !== 'closed' || !t.handles[id].closeReceipt)) fail(503, 'read-close-pending');
      const receipt = { controlId: control.controlId, seq: control.seq, payloadDigest: control.payloadDigest,
        ...who, closedReadHandleIds: [...target.readHandleIds].sort() };
      if (target.receipt && canonicalJson(target.receipt) !== canonicalJson(receipt)) fail(409, 'read-control-receipt-mismatch');
      target.receipt = receipt; pruneClosedReads(state); return clone(receipt);
    });
    for (const wake of waiters) wake();
    onProgress();
    return result;
  }
  function completion({ projectId, conversationId, accessSeq } = {}) {
    const state = ledger.read(), t = tables(state);
    const relevant = t.controls.filter(c => (accessSeq !== undefined ? c.accessSeq === accessSeq :
      c.scope.projectId === projectId && (!conversationId || c.scope.conversationId === conversationId)));
    const pending = relevant.filter(c => Object.values(c.targets).some(target => !target.receipt));
    return { complete: pending.length === 0, controlIds: relevant.map(c => c.controlId), pending: pending.map(c => c.controlId) };
  }
  function waitCompletion(scope, timeoutMs = 5000) {
    if (completion(scope).complete) return Promise.resolve(completion(scope));
    return new Promise((resolve, reject) => {
      const wake = () => { const result = completion(scope); if (!result.complete && !stopped) return;
        clearTimeout(timer); waiters.delete(wake); stopped ? reject(accountError(503, 'read-control-closed')) : resolve(result); };
      const timer = setTimeout(() => { waiters.delete(wake); reject(accountError(503, 'read-close-pending')); }, timeoutMs);
      waiters.add(wake); wake();
    });
  }
  function finalizeAccessEvent({ eventId, scoped = false }) {
    return ledger.transaction(state => {
      const event = state.accessEvents.find(row => row.eventId === eventId);
      if (!event) fail(404, 'read-control-event-missing');
      const controls = tables(state).controls.filter(c => c.accessSeq === event.seq);
      if (!controls.length || controls.some(c => Object.values(c.targets).some(target => !target.receipt))) fail(503, 'read-close-pending');
      const runs = accessEventRunClosure(state, eventId, { scoped });
      if (!runs.complete) fail(503, 'agent-run-closure-pending');
      const payload = { source: 'doc-agent-read-control', complete: true, eventId, accessSeq: event.seq,
        controlIds: controls.map(c => c.controlId), receipts: controls.flatMap(c => Object.values(c.targets).map(t => t.receipt)),
        // 只有「一条任务一个进程」时才有任务的关闭记录可填；没开这个模式时任务清单必须是空的，这两项不出现，摘要和原来一样。
        ...(scoped ? { stoppedRuns: runs.stoppedRuns, retainedRuns: runs.retainedRuns } : {}) };
      const result = { payload, digest: digestOf(payload) }, rows = state.agentReadAccessClosuresV1 ??= {};
      if (rows[eventId] && canonicalJson(rows[eventId]) !== canonicalJson(result)) fail(409, 'read-control-closure-mismatch');
      rows[eventId] = result; return result;
    });
  }
  return { open, closeReads, subscribe, publish, acknowledge, completion, waitCompletion, finalizeAccessEvent, reconcileAccessEvents,
    declareLease, handover,
    hooks: { fenceInState }, close() { stopped = true; seenNonces.clear(); for (const stream of [...streams.values()]) stream.close();
      for (const wake of waiters) wake(); } };
}
