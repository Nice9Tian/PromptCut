/** 退出确认的续办（文档服务这一侧）。
 *
 * 用户在网站改密或重设后选「退出别的设备」，账号服务就发一条「旧登录作废」事件，网页一直显示「正在退出」，
 * 直到账号服务把这次退出记成办完。账号服务要四样确认都齐了才记：文档、素材、Agent、渲染。四样都经文档服务转交：
 *
 * 1. 素材服务自己读访问事件、关掉旧登录的流以后，向文档服务确认（`asset-store/project-revocations.mjs`）。
 * 2. Agent 这一项由文档服务据账本判定：读取都关了、要中止的任务都凭 root 的关闭记录结清了才算
 *    （`hosted/doc-agent-assembly.mjs` 的 `completeAccessEvents`）。
 * 3. 文档服务自己这一项：旧登录的连接已经关掉并永久拒绝、旧登录没有还没定序的操作。
 * 4. 这一版里不代任何登录持有连接或流的服务（`attestedServices`），由文档服务写明原因代为登记，见下。
 *
 * 四样齐了，文档服务把带着各项回执的确认送给账号服务，再向它登记结束见证；账号服务验过才把退出记成办完。
 *
 * 续办靠的都是账本里的记录，不靠内存：每一步先落盘再发，回应丢了、进程重启以后重发的是同一份；
 * 重复到达的事件和确认都认得出来，不办第二次。哪一样没齐，这里只是过一会儿再看，不报完成，也不放弃。
 */
import { accountError } from './client.mjs';
import { canonicalJson, digestOf } from './ledger.mjs';

const fail = (status, code) => { throw accountError(status, code); };
/** 一次退出等各服务确认的时限，和账号服务那边（VisuHive 的 account/events.mjs）是同一个数。
 * 到时只做两件事：把当时的情况记进账本并写一条日志、报给账号服务当调试信息。退出仍然接着办（迟到的确认到齐了照样办完），
 * 也绝不因为到时把已经作废的登录放回来。网页上显示失败是账号服务按它自己的钟判的，文档服务整个不在了也照样会显示。 */
export const LOGOUT_CONFIRM_TIMEOUT_MS = 120_000;

export function createLogoutConfirmer({ ledger, authority, transportEvidence, operations = () => null,
  completeAgent = null, attestedServices = {}, now = Date.now, pollMs = 1000, onDiagnostic = () => {},
  timeoutMs = LOGOUT_CONFIRM_TIMEOUT_MS, reportTimeout = null, docInstanceId = 'doc' } = {}) {
  if (![ledger?.read, ledger?.transaction, authority?.flushAccountAcknowledgements, authority?.revocationStatus,
    authority?.ackAccessEvent, authority?.completeLogoutBarrier, transportEvidence, operations].every(value => typeof value === 'function') ||
      Object.entries(attestedServices).some(([service, reason]) => !['agent', 'render'].includes(service) || typeof reason !== 'string' || !reason))
    fail(503, 'logout-confirmer-configuration');
  let timer = null, running = null, again = false, stopped = false;
  const diagnostics = new Map(), agentCodes = new Map();
  const note = (eventId, code) => {
    // 同一条事件的同一个原因只报一次，原因变了再报；办完就清掉。
    if (diagnostics.get(eventId) === code) return;
    diagnostics.set(eventId, code); onDiagnostic({ code, eventId });
  };
  const barriers = () => Object.values(ledger.read().barriers ?? {}).filter(barrier => barrier.state !== 'complete');

  /** 文档服务自己这一项的证据。形成以后记进账本，以后每次给出去的都是同一份。 */
  async function getDocBarrier(barrier) {
    const saved = ledger.read().docLogoutBarriersV1?.[barrier.eventId];
    if (saved) return structuredClone(saved.proof);
    const evidence = transportEvidence(barrier.accessEventId);
    if (!evidence) { note(barrier.eventId, 'logout-doc-transport-pending'); return null; }
    const coordinator = operations();
    const settled = coordinator ? await coordinator.settleLogins([...barrier.loginIds])
      : { pendingSeals: 0, projectCursors: [], lastAcceptedOrderSeq: {} };
    if (settled.pendingSeals !== 0) { note(barrier.eventId, 'logout-doc-operations-pending'); return null; }
    const proof = { eventId: barrier.eventId, accountEventSeq: barrier.accountEventSeq, pendingSeals: 0,
      connections: evidence.connections.filter(row => barrier.loginIds.includes(row.loginId)).map(row => ({
        connectionId: row.connectionId, loginId: row.loginId, permanentlyDenied: true,
        lastAcceptedOrderSeq: settled.lastAcceptedOrderSeq[row.loginId] ?? 0 })),
      projectCursors: settled.projectCursors,
      endCursor: settled.projectCursors.reduce((max, row) => Math.max(max, row.lastAcceptedOrderSeq), 0),
      clockEvidence: { source: 'doc', docInstanceId: evidence.docInstanceId, transport: evidence.kind, recordedAt: now() },
      // 这一版只记下区间，不撤回这段时间的修改（撤回是 0.7.20 的事）。
      modifications: { state: 'retained', version: '0.7.18' } };
    return ledger.transaction(state => {
      const rows = state.docLogoutBarriersV1 ??= {};
      rows[barrier.eventId] ??= { proof, digest: digestOf(proof) };
      return structuredClone(rows[barrier.eventId].proof);
    });
  }
  /** 交出去之前再核一遍：就是账本里那一份，而且这些登录现在仍在作废名单里。 */
  function verifyDocBarrier(proof, barrier) {
    const state = ledger.read(), saved = state.docLogoutBarriersV1?.[barrier.eventId];
    return Boolean(saved && saved.digest === digestOf(proof) && canonicalJson(saved.proof) === canonicalJson(proof) &&
      proof.pendingSeals === 0 && barrier.loginIds.every(loginId => state.revokedLogins[`login:${loginId}`]));
  }
  /** 这一版里不代任何登录持有连接或流的服务，没有东西可关，也没有它自己的确认可等。文档服务写明原因代为登记。 */
  function attest(barrier, status) {
    for (const [service, reason] of Object.entries(attestedServices)) {
      if (status.serviceAcks[service]?.complete && status.serviceAcks[service].cursor >= barrier.accessSeq) continue;
      try {
        authority.ackAccessEvent(barrier.accessEventId, service, { receiptId: `doc-attested:${service}:${barrier.accessEventId}`,
          cursor: barrier.accessSeq, complete: true, closedStreams: [], stoppedRuns: [], rejectedCredentials: [],
          attestedBy: 'doc', reason });
      } catch (error) { note(barrier.eventId, `logout-${service}-attest-${error.code ?? 'failed'}`); }
    }
  }
  async function seal(barrier) {
    const coordinator = operations(), proof = ledger.read().docLogoutBarriersV1?.[barrier.eventId]?.proof;
    if (!coordinator || !proof) { note(barrier.eventId, 'logout-order-unavailable'); return; }
    try {
      const { witness } = await coordinator.sealLogout({ eventId: barrier.eventId, requestId: `logout-complete:${barrier.eventId}`,
        proof: { revocationSeq: barrier.accountEventSeq, pendingSeals: 0, projectCursors: proof.projectCursors, connections: proof.connections } });
      authority.completeLogoutBarrier(barrier.eventId, witness);
      diagnostics.delete(barrier.eventId); onDiagnostic({ code: 'logout-complete', eventId: barrier.eventId });
    } catch (error) { note(barrier.eventId, `logout-seal-${error.code ?? 'failed'}`); }
  }
  async function pass() {
    if (!barriers().length) return { pending: [] };
    try {
      const agent = await completeAgent?.(); agentCodes.clear();
      for (const row of agent?.pending ?? []) agentCodes.set(row.eventId, row.code);
    } catch (error) { onDiagnostic({ code: error.code ?? 'logout-agent-pending' }); }
    for (const barrier of barriers()) attest(barrier, authority.revocationStatus(barrier.eventId));
    await authority.flushAccountAcknowledgements();
    for (const barrier of barriers()) {
      const status = authority.revocationStatus(barrier.eventId);
      if (status.pendingServices.length) note(barrier.eventId, `logout-pending:${status.pendingServices.join(',')}`);
      else await seal(barrier);
    }
    for (const barrier of barriers()) await timeout(barrier);
    return { pending: barriers().map(barrier => barrier.eventId) };
  }
  /** 等过了时限的退出：记一次、报一次。调试信息里只有事件号、服务名、原因码、时长和文档服务实例号，没有登录号、令牌、票据。 */
  async function timeout(barrier) {
    const state = ledger.read(), event = state.accessEvents.find(row => row.eventId === barrier.accessEventId);
    const since = barrier.timeout?.since ?? event?.createdAt;
    if (!Number.isSafeInteger(since)) return;
    let record = barrier.timeout;
    if (!record) {
      const waitedMs = now() - since;
      if (waitedMs < timeoutMs) return;
      const status = authority.revocationStatus(barrier.eventId), all = ['doc', 'asset', 'agent', 'render'];
      const reasons = [diagnostics.get(barrier.eventId), agentCodes.has(barrier.accessEventId) ? `agent:${agentCodes.get(barrier.accessEventId)}` : null]
        .filter(code => typeof code === 'string' && /^[A-Za-z0-9_.:,-]{1,96}$/.test(code));
      record = authority.recordLogoutTimeout(barrier.eventId, { since, at: now(), waitedMs, timeoutMs,
        confirmed: all.filter(service => !status.pendingServices.includes(service)), pending: status.pendingServices, reasons }).timeout;
      onDiagnostic({ code: 'logout-timeout', eventId: barrier.eventId, waitedMs, timeoutMs, confirmed: record.confirmed, pending: record.pending, reasons });
    }
    if (record.reported || typeof reportTimeout !== 'function') return;
    try {
      await reportTimeout(barrier.eventId, { reportId: `logout-timeout:${barrier.accountEventSeq}`, confirmed: record.confirmed, pending: record.pending,
        reasons: record.reasons, waitedMs: record.waitedMs, docInstanceId });
      authority.recordLogoutTimeout(barrier.eventId, { reported: true });
    } catch (error) {
      // 账号服务还没有这个口（旧版本）或者暂时连不上：下一轮再报；它自己的钟照样会让网页显示失败。
      note(`${barrier.eventId}:report`, `logout-timeout-report-${error.code ?? 'failed'}`);
    }
  }
  /** 同一时间只跑一遍；跑的时候又被叫到，就在这一遍结束后再跑一遍。 */
  function tick() {
    if (stopped) return Promise.resolve({ pending: [] });
    if (running) { again = true; return running; }
    running = (async () => {
      try { let result; do { again = false; result = await pass(); } while (again && !stopped); return result; }
      finally { running = null; }
    })();
    return running;
  }
  const safeTick = () => tick().catch(error => { onDiagnostic({ code: error.code ?? 'logout-confirmer-failed' }); return { pending: null }; });
  return { getDocBarrier, verifyDocBarrier, tick,
    /** 有新进展时叫一下（来了作废事件、某个服务确认了）；不叫也行，定时会再看。 */
    kick() { void safeTick(); },
    /** 给诊断和测试看：一次退出现在还差哪几样。只读。 */
    status(eventId) {
      const value = authority.revocationStatus(eventId);
      return { eventId, pendingServices: value.pendingServices, docConfirmed: value.docConfirmed, logoutComplete: value.logoutComplete,
        timeout: value.timeout ? structuredClone(value.timeout) : null,
        services: Object.fromEntries(Object.entries(value.serviceAcks).map(([service, ack]) => [service, ack ? {
          receiptId: ack.receiptId, stoppedRuns: ack.stoppedRuns, attested: ack.attestedBy === 'doc' } : null])) };
    },
    start() {
      if (stopped || timer) return;
      // 上一个进程留下没办完的，从这里接着办。
      void safeTick();
      if (pollMs > 0) { timer = setInterval(safeTick, pollMs); timer.unref?.(); }
    },
    async close() { stopped = true; clearInterval(timer); timer = null; await running?.catch(() => {}); },
  };
}
