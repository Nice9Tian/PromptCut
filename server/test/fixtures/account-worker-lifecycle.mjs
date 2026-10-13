// 一条独立进程任务从领取到结清的本机受控环境，只给 account-worker-lifecycle.test.mjs 用。
//
// 真的：文档服务这一侧的账本、任务授权、任务范围记录、实例登记和内部接口（都跑在真的双向 TLS 上）；
//       只做控制的主身份、主服务的事件库与收事件接口；每一代任务进程都是真的独立子进程；
//       root 发布器的事务顺序（开一代、绑定、关、强制关、退槽、失败观察）；槽调度。
// 受控的：root 看操作系统的那一半。这台机器是 Windows，没有 systemd 和 cgroup，所以「进程组空了」
//         用「这个子进程真的退出了」代替，记录里的 cgroup 字段是编的；账号服务对发送者的核对固定放行；
//         文档服务关自己连接用的是一个没有任何连接的真实文档服务实例。运行器见 account-worker-child-config.mjs。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assetWiringPki } from './asset-wiring-pki.mjs';
import { scopeModel, pair } from '../agent-run-scope-fixture.mjs';
import { openAccountLedger, digestOf, appendAccessEvent } from '../../account/ledger.mjs';
import { certificateFingerprint } from '../../account/client.mjs';
import { createRunAuthority } from '../../account/run-authority.mjs';
import { createRunInternalHandler } from '../../account/run-internal.mjs';
import { createAgentRunScopeDoc, agentScopeRef } from '../../account/agent-run-scope-doc.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../../account/agent-instance-internal.mjs';
import { createPasswordOrder } from '../../account/password-order.mjs';
import { inspectAgentScopeSource } from '../../hosted/agent-run-scope-reader.mjs';
import { createDocService } from '../../docservice/service.mjs';
import { openOperationHistory } from '../../docservice/modules/operation-history.mjs';
import { createRunClient } from '../../agent-service/run-client.mjs';
import { createAccountRunEvents } from '../../agent/service/account-run-events.mjs';
import { createWorkerEventInternalHandler } from '../../agent-service/worker-event-internal.mjs';
import { createAccountWorkerHttpsGateway } from '../../agent-service/account-worker-control-client.mjs';
import { freePort } from '../free-ports.mjs';
import { createAccountSlotScheduler } from '../../agent-service/account-slot-scheduler.mjs';
import { createAgentReadControl, createAgentReadControlHandler } from '../../account/agent-read-control.mjs';
import { createConversationControlClient } from '../../agent-service/conversation-control-client.mjs';

export const projectId = 'sp_worker_fixture', conversationId = 'conversation_worker';
const BOOT = '11111111-1111-1111-1111-111111111111';
const here = path.dirname(fileURLToPath(import.meta.url));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const closeServer = async (server, sockets) => {
  await Promise.all([...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })));
  if (server.listening) await new Promise(resolve => server.close(resolve));
};
export const until = async (check, { timeoutMs = 30_000, what = 'condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const getIdentity = (port, tls, pin) => new Promise((resolve, reject) => {
  let result, error, socketClosed = false, ended = false;
  const finish = () => { if (ended && socketClosed) error ? reject(error) : resolve(result); };
  const req = https.get(`https://127.0.0.1:${port}/internal/v2/agent/run-scope/identity`, { ...tls, agent: false, timeout: 5000,
    rejectUnauthorized: true, checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
      (certificateFingerprint(cert.fingerprint256) !== pin ? Error('fixture-identity-pin') : undefined); } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.on('end', () => { try { result = { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }; } catch (cause) { error = cause; } ended = true; finish(); }); });
  req.on('socket', socket => socket.once('close', () => { socketClosed = true; finish(); }));
  req.on('error', reject); req.on('timeout', () => req.destroy(Error('fixture-identity-timeout')));
});

export async function startWorkerLifecycleFixture({ slotId = 'slot-a', pollMs = 100 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-lifecycle-'));
  const chainDir = path.join(dir, 'root-chain'), markerDir = path.join(dir, 'markers');
  fs.mkdirSync(chainDir); fs.mkdirSync(markerDir);
  const pki = assetWiringPki(dir), docKey = pair(), log = [];
  const workerPin = certificateFingerprint(pki.wrong.fingerprint256), masterPin = certificateFingerprint(pki.account.fingerprint256);
  const say = (event, fields) => log.push({ at: Date.now(), event, ...fields });

  // ---------- 文档服务这一侧 ----------
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'doc-worker-lifecycle' });
  const hooks = await import(new URL('../../account/conversation-authority.mjs', import.meta.url).href);
  ledger.transaction(s => {
    s.projects[projectId] = { projectId, status: 'active', creatorAccountId: 'owner', hosted: { agent: true }, bans: {},
      members: { owner: { access: 'rw' }, sender: { access: 'rw' }, other: { access: 'rw' } }, accessRevision: 1 };
    s.conversationsV2 = { [projectId]: { [conversationId]: { v: 2, projectId, id: conversationId, ownerAccountId: 'owner',
      visibility: 'shared', aclRevision: 1, queueRevision: 1, currentRunId: null, messages: [] } } };
    s.testServices = { 'worker-key': true, 'master-key': true };
  });
  const m = scopeModel(slotId);
  Object.assign(m.expected, { docAuthorityId: ledger.authorityId, docPublicKey: docKey.publicKey,
    clientFingerprint256: masterPin, serverFingerprint256: certificateFingerprint(pki.asset.fingerprint256) });
  const anchorDigest = () => digestOf(m.files.get('anchor.json'));
  const scope = createAgentRunScopeDoc({ ledger, signingKey: docKey.privateKey,
    slots: [{ expected: m.expected, workerServiceKid: 'worker-key', workerFingerprint256: workerPin }],
    masterServiceKid: 'master-key', masterFingerprint256: masterPin,
    // 生产上锚点摘要写在文档服务的配置里；这里槽是测试里现建的，所以读的时候现算。
    sourceFactory: () => ({ read: ({ checkpoint }) => inspectAgentScopeSource({ read: m.io.read, expected: m.expected,
      configuredAnchorDigest: anchorDigest(), checkpoint }) }) });
  const socketIds = new WeakMap();
  const peerPrincipal = ({ socket }) => {
    const fingerprint = certificateFingerprint(socket.getPeerCertificate()?.fingerprint256);
    if (socket.authorized !== true || socket.destroyed || ![workerPin, masterPin].includes(fingerprint))
      throw Object.assign(Error('fixture-peer'), { status: 403, code: 'run-service-forbidden' });
    if (!socketIds.has(socket)) socketIds.set(socket, randomUUID());
    return { service: 'agent', serviceKid: fingerprint === workerPin ? 'worker-key' : 'master-key',
      scope: 'service', authenticationId: socketIds.get(socket), socket };
  };
  const verifyService = (state, p) => {
    if (!state.testServices[p?.serviceKid] || p?.service !== 'agent' || p.socket?.destroyed || !socketIds.has(p.socket))
      throw Object.assign(Error('fixture-current-service'), { status: 403, code: 'run-service-forbidden' });
    return { serviceId: 'agent', serviceKid: p.serviceKid };
  };
  const instances = createAgentInstanceAuthority({ ledger, scopeAuthority: scope,
    verifyTransportInState(state, p) { return { ...verifyService(state, p), authenticationId: p.authenticationId,
      channelBinding: instanceTlsBinding(p.socket), fingerprint256: certificateFingerprint(p.socket.getPeerCertificate().fingerprint256) }; } });
  // 文档服务关它自己那一侧的连接：真的 fencePrincipals 和真的操作围栏，只是这里一条数据连接都没有。
  const docService = createDocService({ autoTick: false, log: () => {} });
  const history = openOperationHistory(path.join(dir, 'operations.db')); history.createProject(projectId, { id: projectId });
  const unavailable = () => { throw Error('no-account-operation'); };
  const operations = createPasswordOrder({ history, account: { get: unavailable }, verifyWitness: unavailable, checkGate: unavailable });
  const gates = { holdTerminalDelivery: false, rejectWorkerEvents: false };
  const deliveries = new Map();
  let provider;
  function deliver(control) {
    if (deliveries.has(control.controlId)) return deliveries.get(control.controlId);
    const work = (async () => {
      if (control.kind === 'terminal') await until(() => !gates.holdTerminalDelivery, { timeoutMs: 60_000, what: 'terminal delivery gate' });
      await scope.closeDocControl({ controlId: control.controlId, docInstanceId: 'doc-live', service: docService, operationCoordinator: operations });
      say('doc.control.closed', { controlId: control.controlId, kind: control.kind });
    })().catch(error => { say('doc.control.pending', { controlId: control.controlId, code: error?.code ?? error?.message }); })
      .finally(() => deliveries.delete(control.controlId));
    deliveries.set(control.controlId, work); return work;
  }
  const docClosedHere = control => ledger.read().docRunClosuresV2?.[control.controlId]?.instances?.['doc-live']?.state === 'closed';
  provider = createRunAuthority({ ledger, conversationHooks: hooks, instanceAuthority: instances, scopeAuthority: scope,
    docInstanceId: 'doc-live', verifyServiceInState: verifyService, synchronize: async () => {},
    verifySender: async ref => ({ ...ref, accountEventSeq: ledger.read().accountHead }),
    onControl: control => { void deliver(control); } });
  const instanceHandler = createAgentInstanceInternalHandler({ instanceAuthority: instances, agentFingerprint256: workerPin,
    masterFingerprint256: masterPin, resolveServicePrincipal: peerPrincipal });
  const runHandler = createRunInternalHandler({ runAuthority: provider, agentFingerprint256: workerPin, masterFingerprint256: masterPin,
    resolveServicePrincipal: peerPrincipal, requirePendingProof: true, includeScopeControls: true,
    authenticateInvocation({ req, servicePrincipal, body, operation }) {
      const cap = instances.authenticate({ servicePrincipal, method: req.method, path: req.url, operation, request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...servicePrincipal, ...cap }, release: () => instances.release(cap.instanceSession) };
    },
    principalForCheck({ projectId: requested, runGrantId, servicePrincipal }) {
      const grant = ledger.read().runGrantsV2?.[runGrantId];
      if (!grant || grant.projectId !== requested) throw Object.assign(Error('run-binding-mismatch'), { status: 403, code: 'run-binding-mismatch' });
      return { ...grant, realm: 'account', identityVersion: 2, role: 'agent', creator: false, servicePrincipal };
    },
    // 和 doc-agent-assembly.mjs 的 listPendingRuns 同一个顺序：读失败观察、补投没办完的控制、结清、再列。
    async listPendingRuns({ servicePrincipal }) {
      instances.verifyInState(ledger.read(), servicePrincipal, { operation: 'pendingRuns', input: {} });
      if (ledger.read().agentInstancesV2?.[servicePrincipal.instanceId]?.purpose !== 'control-only')
        throw Object.assign(Error('instance-purpose-forbidden'), { status: 403, code: 'instance-purpose-forbidden' });
      for (const control of await provider.reconcileScopeFailures()) await deliver(control);
      for (const control of Object.values(ledger.read().runControlsV2 ?? {}))
        if (control.state === 'pending' && (control.kind === 'terminal' || control.revoked?.length) && !docClosedHere(control)) void deliver(control);
      await provider.reconcileScopeClosures();
      const state = ledger.read(), rows = [];
      for (const [id, group] of Object.entries(state.conversationsV2 ?? {})) for (const conversation of Object.values(group))
        if (conversation.messages.some(message => message.queueState === 'queued'))
          rows.push({ projectId: id, conversationId: conversation.id, queueRevision: conversation.queueRevision });
      return { conversations: rows, scopeControls: provider.listScopeControls({ servicePrincipal }) };
    } });
  const docSockets = new Set();
  // 读取清点（给人读对话用的那一路）只在测退出确认时挂上，见下面的 startReadControl。
  let readControl = null, readHandler = null, masterReadControl = null;
  const docServer = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    try { if (await readHandler?.(req, res)) return; if (await instanceHandler(req, res)) return; if (await runHandler(req, res)) return; res.writeHead(404); res.end(); }
    catch { if (!res.writableEnded) { res.writeHead(503); res.end(); } }
  });
  docServer.on('connection', socket => { docSockets.add(socket); socket.once('close', () => docSockets.delete(socket)); });
  const docOrigin = `https://127.0.0.1:${await listen(docServer)}`;

  // ---------- 主服务：只做控制的身份、事件库、收事件接口 ----------
  const master = createRunClient({ origin: docOrigin, tls: pki.account, serverFingerprint256: pki.doc.fingerprint256, registrationPurpose: 'control-only' });
  const eventStore = createAccountRunEvents({ file: path.join(dir, 'master-events.sqlite'), authorityId: ledger.authorityId,
    verifyGrant: async () => { throw Object.assign(Error('not-a-human-gate'), { status: 403 }); } });
  const eventHandler = createWorkerEventInternalHandler({ eventStore, resolveWorker: input => master.workerEventSource(input) });
  const masterSockets = new Set();
  const masterServer = https.createServer({ ...pki.asset, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    // gates.rejectWorkerEvents：主服务收事件的口一时答不上（任务进程那边的事件交不上去）
    if (gates.rejectWorkerEvents) { req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"code":"master-unavailable"}'); return; }
    void eventHandler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(() => res.destroy());
  });
  masterServer.on('connection', socket => { masterSockets.add(socket); socket.once('close', () => masterSockets.delete(socket)); });
  const masterOrigin = `https://127.0.0.1:${await listen(masterServer)}`;

  // ---------- root：发布器的事务是真的，看操作系统的那一半换成「真的子进程」 ----------
  const generations = new Map(), stops = [];
  const originalWrite = m.io.write, originalInspect = m.io.inspect, originalLock = m.io.lock, originalPin = m.io.pinPrevious;
  m.io.write = async (name, value, exclusive) => { await originalWrite(name, value, exclusive);
    fs.writeFileSync(path.join(chainDir, name), JSON.stringify(value), { flag: exclusive ? 'wx' : 'w', mode: 0o600 }); };
  m.io.lock = async () => { const release = await originalLock(); return options => release(options); };
  m.io.start = async reservation => {
    const settingsFile = path.join(dir, `worker-${reservation.epoch}.json`), identityPort = await freePort();
    fs.writeFileSync(settingsFile, JSON.stringify({ pkiDir: dir, chainDir, markerDir, expected: m.expected, reservation, identityPort,
      docOrigin, docFingerprint256: pki.doc.fingerprint256, masterOrigin, masterFingerprint256: pki.asset.fingerprint256,
      journalFile: path.join(dir, `worker-journal-${reservation.epoch}.sqlite`), dataDir: path.join(dir, `worker-data-${reservation.epoch}`) }), { mode: 0o600 });
    // 子进程不带父子通道（和 systemd 起的一样）：领取、开跑、收尾、结算结果都走它那个只认 root 证书的本机 HTTPS 口
    const gateway = createAccountWorkerHttpsGateway({ configurationModule: path.join(here, 'account-worker-child-config.mjs'), cwd: here,
      env: { ...process.env, PROMPTCUT_WORKER_FIXTURE_SETTINGS: settingsFile }, timeoutMs: 15_000, port: identityPort,
      controllerTls: pki.account, serverFingerprint256: m.expected.serverFingerprint256,
      scope: { slotId: m.expected.slotId, epoch: reservation.epoch, instanceId: reservation.instanceId } });
    const ready = await gateway.ready;
    generations.set(reservation.epoch, { gateway, pid: ready.pid, port: ready.port, journalFile: path.join(dir, `worker-journal-${reservation.epoch}.sqlite`) });
    say('root.started', { epoch: reservation.epoch, pid: ready.pid });
  };
  m.io.inspect = async reservation => { const value = await originalInspect(reservation); value.instance.pid = generations.get(reservation.epoch).pid; return value; };
  m.io.identity = async reservation => {
    const result = await getIdentity(generations.get(reservation.epoch).port, pki.account, m.expected.serverFingerprint256);
    if (result.status !== 200 || result.body?.ok !== true) throw Error('fixture-identity-status'); return result.body.result;
  };
  const stopped = (record, how, observed) => { stops.push({ epoch: record.epoch, how, pid: observed.pid, exitCode: observed.exitCode,
    signal: observed.signal, at: Date.now() }); say('root.stopped', { epoch: record.epoch, how, exitCode: observed.exitCode }); };
  m.io.pinPrevious = async record => {
    const pinned = await originalPin(record), generation = generations.get(record.epoch);
    // 正常关：要这一代进程自己把手里的东西收完再退，并且真的看到它退出。
    return { ...pinned, async stopAndObserve() { stopped(record, 'graceful', await generation.gateway.close()); return pinned.stopAndObserve(); } };
  };
  m.io.pinRetired = async record => {
    const pinned = await originalPin(record), generation = generations.get(record.epoch);
    return { ...pinned,
      async stopAndObserve() { stopped(record, 'killed', await generation.gateway.terminate()); return pinned.stopAndObserve(); },
      async observeFailure() {
        if (!generation.gateway.describe().childClosed) throw Object.assign(Error('main-still-live'), { code: 'agent-scope-main-still-live' });
        return { kind: 'main-birth-gone', at: Date.now(), bootId: BOOT, serviceInstance: structuredClone(record.instance),
          closureScope: structuredClone(record.closureScope), scopeActive: true, scopeExclusive: true, mainPid: 0, mainBirthGone: true, populated: 0 };
      } };
  };
  const headRecord = () => { const head = m.files.get('current.json'); return head ? { head, record: m.files.get(`epoch-${head.epoch}.json`) } : null; };
  const holds = { normalClose: null };
  const slot = {
    slotId,
    async current() { const now = headRecord(); return now ? { rootScopeRef: agentScopeRef(now.record), phase: now.head.phase } : null; },
    async open() {
      await m.run(m.files.has('current.json') ? 'start' : 'initialize');
      const { record } = headRecord(), generation = generations.get(record.epoch), gateway = generation.gateway;
      return { rootScopeRef: agentScopeRef(record), worker: { prepare: task => gateway.prepare(task), start: () => gateway.start(),
        settlement: gateway.settlement, exited: gateway.closed, alive: () => !gateway.describe().childClosed, stop: () => gateway.terminate() } };
    },
    bind: assignment => m.run('bind', { assignment }),
    async close({ terminal, intent }) { say('root.close.requested', {}); if (holds.normalClose) await holds.normalClose; return m.run('close', { terminal, intent }); },
    forcedClose: ({ terminal }) => m.run('forced-close', { terminal, intent: null }),
    retire({ reason }) { const { record } = headRecord();
      return m.run('retire', { intent: null, terminal: { v: 1, protocol: 'promptcut.agent-run-scope.unassigned-retirement.v1',
        authorityId: m.expected.authorityId, slotId: m.expected.slotId, epoch: record.epoch, recordDigest: digestOf(record), reason } }); },
    observeFailure: () => m.run('observe-failure'),
  };
  const scheduler = createAccountSlotScheduler({ slots: [slot], pollMs,
    master: { pending: () => master.pending(), scopeControl: row => master.scopeControl(row) }, log: say });

  let serial = 0;
  function enqueue(steps, accountId = 'sender', inConversation = conversationId) {
    const messageId = `message${++serial}`, content = `任务 ${serial}\n\`\`\`script\n${JSON.stringify(steps)}\n\`\`\``;
    ledger.transaction(s => {
      const c = s.conversationsV2[projectId][inConversation];
      c.messages.push({ messageId, requestId: `send-${messageId}`, arrivalSeq: c.messages.length + 1, createdAt: Date.now(),
        senderAccountId: accountId, senderNameAtSend: `${accountId} name`, loginId: `login-${accountId}`, credentialId: `credential-${accountId}`,
        loginGeneration: 1, content, contentDigest: digestOf(content), attachments: [],
        selectionSnapshot: { projectId, accountId, messageId, pageId: 'page1', selection: { clipIds: [] }, sentAt: Date.now(), source: 'sent-snapshot' },
        queueState: 'queued' });
    });
    return messageId;
  }
  const marker = name => { try { return JSON.parse(fs.readFileSync(path.join(markerDir, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const conversation = () => ledger.read().conversationsV2[projectId][conversationId];
  const grantOf = messageId => Object.values(ledger.read().runGrantsV2 ?? {}).find(g => g.messageId === messageId) ?? null;
  return { dir, m, ledger, provider, scope, scheduler, slot, master, eventStore, generations, stops, log, gates, holds,
    enqueue, marker, conversation, grantOf, headRecord,
    release: name => fs.writeFileSync(path.join(markerDir, `release-${name}`), '1'),
    chain: epoch => Object.fromEntries(['epoch', 'assignment', 'terminal', 'intent', 'closure', 'failure'].map(k => [k, m.files.get(`${k}-${epoch}.json`) ?? null])),
    events: (inConversation = conversationId) => eventStore.after({ projectId, conversationId: inConversation }).events,
    /** 再开一个对话（比如某个成员自己的私有对话）。 */
    addConversation(id, { ownerAccountId, visibility }) {
      ledger.transaction(s => { s.conversationsV2[projectId][id] = { v: 2, projectId, id, ownerAccountId, visibility,
        aclRevision: 1, queueRevision: 1, currentRunId: null, messages: [] }; });
    },
    /** 挂上真的读取清点：文档服务一侧的清点与接口，加上主身份那一侧真的订阅连接（生产上 Agent 主服务就是这样连的）。
     * 这个夹具里没有人读对话，所以清点里没有读取；挂它是为了让「Agent 这一项确认了没有」走生产上的同一个判断。 */
    async startReadControl() {
      const noHumanRead = () => { throw Object.assign(Error('fixture-no-human-read'), { status: 403, code: 'forbidden' }); };
      readControl = createAgentReadControl({ ledger, instanceAuthority: instances, authorizeRead: async () => noHumanRead(), checkReadInState: noHumanRead });
      readHandler = createAgentReadControlHandler({ control: readControl, resolveServicePrincipal: peerPrincipal, instanceAuthority: instances });
      masterReadControl = createConversationControlClient({ origin: docOrigin, tls: pki.account, serverFingerprint256: pki.doc.fingerprint256,
        runClient: master, receiptFile: path.join(dir, 'master-read-closures.sqlite'), onDiagnostic: entry => say('read-control.diagnostic', entry) });
      await masterReadControl.start();
      await until(() => masterReadControl.describe().connected, { timeoutMs: 10_000, what: '主身份的读取控制连接' });
    },
    /** Agent 这一项对一次退出确认了没有。就是生产上 doc-agent-assembly.mjs 的 completeAccessEvents 用的那个判断
     * （读取都关了、要中止的任务都凭 root 的关闭记录结清了）；这里不往账号服务回，只看判断结果。 */
    agentConfirmation(eventId) {
      try { return { confirmed: true, closure: readControl.finalizeAccessEvent({ eventId, scoped: true }) }; }
      catch (error) {
        if (!['read-close-pending', 'agent-run-closure-pending'].includes(error.code)) throw error;
        return { confirmed: false, code: error.code };
      }
    },
    /** 用户按「停止」时对话权威做的那一步：在文档服务的账本里给这条任务下围栏，并通知它自己去关连接。 */
    stop: (runId, requestId = `stop-${runId}`) => provider.fence({ kind: 'stop', projectId, conversationId, runId, requestId }),
    /** 改密选了退出（或被踢）：账号的旧登录作废，文档服务据这条访问事件给相关任务下围栏。 */
    exit(accountId) {
      const event = ledger.transaction(s => { s.revokedLogins[`login:login-${accountId}`] = { seq: ++s.accountHead };
        const event = appendAccessEvent(s, { type: 'login-revoked', accountIds: [accountId], loginIds: [`login-${accountId}`] });
        // 生产上账号权威在同一个事务里先给读取下围栏、再给任务下围栏（doc-agent-assembly.mjs 的 runHooks）。
        readControl?.hooks.fenceInState(s, { kind: 'credential', requestId: `access:${event.eventId}`, loginIds: event.loginIds, accessSeq: event.seq });
        return event; });
      return Object.assign(provider.applyAccessEvent(event), { event });
    },
    /** 开对话的人把它切成私有：只在账本里下围栏，不另外通知（文档服务在主服务下一次来问时补做它那一侧的关闭）。 */
    makePrivate: (requestId = 'private-1') => ledger.transaction(s => hooks.privateFenceInState(s, { projectId, conversationId,
      ownerAccountId: 'owner', requestId, runHooks: provider.hooks })),
    async close() {
      const errors = [];
      const attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
      gates.holdTerminalDelivery = false;
      await attempt(() => scheduler.stop());
      await attempt(() => masterReadControl?.close()); readControl?.close();
      // 测试收尾：把还活着的子进程按进程号结束掉。这是清理，不是关闭证明。
      for (const generation of generations.values()) await attempt(() => generation.gateway.terminate());
      await Promise.allSettled([...deliveries.values()]);
      await attempt(() => master.close());
      await attempt(() => closeServer(masterServer, masterSockets)); await attempt(() => closeServer(docServer, docSockets));
      await attempt(() => eventStore.close()); await attempt(() => operations.idle()); await attempt(() => history.close());
      await attempt(() => docService.close()); instances.close(); await attempt(() => ledger.close());
      if (!errors.length) fs.rmSync(dir, { recursive: true, force: true });
      return { errors, dir, alive: [...generations.values()].filter(g => !g.gateway.describe().childClosed).length };
    } };
}
