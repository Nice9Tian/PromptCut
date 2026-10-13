// 「真实运行器放进任务进程」的本机环境，只给 account-runner-process.test.mjs 用。
//
// 真的：
//   - 网站账号后端、文档服务的托管组合（账号模式，开了「一条任务一个进程」）、独立进程的素材服务（cloud-queue-user-path.mjs）；
//     文档服务一侧走的就是生产的装配 `doc-agent-assembly.mjs`（任务授权、任务范围、实例登记、结算、文档服务关自己那一侧的连接）；
//   - 只做控制的主身份、主服务的事件库与收事件接口、槽调度（`account-slot-scheduler.mjs`）；
//   - 每一代任务进程都是真的独立子进程，里面跑的是真实的运行器：进程内 vite 载工具实现、到文档服务的项目数据连接、
//     真的工具、看画面的客户端、运行素材的传输（配置走生产的 `account-task-worker-config.mjs`）；
//   - 渲染服务「看画面」的口子：真的签名核对（`createLookVerifier`）、真的落盘队列（`render-requests.mjs`）、真的调度（`look.mjs`）。
// 受控的：
//   - 模型：仓库里的模拟提供方，照用户消息里的脚本调工具；
//   - root 看操作系统的那一半：这台机器是 Windows，没有 systemd 和 cgroup，「进程组空了」用「这个子进程真的退出了」代替，
//     记录里的 cgroup 字段是编的；文档服务读 root 记录的来源换成了内存里的这份（生产的读端只在 Linux 上跑）；
//   - 出图的渲染工作进程：一个回固定图片的替身（这一块不验画面）；
//   - 运行素材要的「素材服务现在是哪一个进程」的 root 登记：见下面 runAssets 一段的说明。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startCloudQueueUserFixture } from './cloud-queue-user-path.mjs';
import { hostedPaths } from '../../hosted/combo.mjs';
import { scopeModel, pair } from '../agent-run-scope-fixture.mjs';
import { digestOf } from '../../account/ledger.mjs';
import { certificateFingerprint } from '../../account/client.mjs';
import { agentScopeRef } from '../../account/agent-run-scope-doc.mjs';
import { inspectAgentScopeSource } from '../../hosted/agent-run-scope-reader.mjs';
import { addServiceKey, generateServiceKeyPair, writeServiceKeyFile, newInstanceId, createServiceRegistry } from '../../auth/service-identity.mjs';
import { createAccountRunEvents } from '../../agent/service/account-run-events.mjs';
import { createHostedAgentService } from '../../agent/service/create-agent-service.mjs';
import { createWorkspaces } from '../../agent/service/workspace.mjs';
import { createWorkerEventInternalHandler } from '../../agent-service/worker-event-internal.mjs';
import { createAccountWorkerHttpsGateway } from '../../agent-service/account-worker-control-client.mjs';
import { createAccountSlotScheduler } from '../../agent-service/account-slot-scheduler.mjs';
import { createAccountMasterAssembly } from '../../agent-service/account-master-assembly.mjs';
import { createMasterSchedulerClient } from '../../agent-service/account-master-scheduler-client.mjs';
import { createLook, createLookVerifier, LOOK_AUTH_HEADER } from '../../hosted-render/look.mjs';
import { createRenderRequests } from '../../hosted-render/render-requests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT = '11111111-1111-1111-1111-111111111111';
const ASSET_IDENTITY = 'asset-runner-fixture';
/** 端口都在分给这一块的 28220～28259 里 */
export const RUNNER_PORTS = Object.freeze({ combo: [28220, 28221, 28222, 28223, 28224, 28225, 28226], agent: 28227,
  masterEvents: 28230, look: 28231, renderWorker: 28232, identityBase: 28240, controlBase: 28250 });
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const listenOn = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
const closeServer = async (server, sockets = new Set()) => {
  await Promise.all([...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })));
  if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
};
export const until = async (check, { timeoutMs = 60_000, what = 'condition', everyMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, everyMs));
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
/** 一段 0.25 秒、8 kHz、单声道的正弦波 WAV（给「导入素材」「测响度」用的真实字节） */
export function toneWav({ hz = 440, seconds = 0.25, rate = 8000 } = {}) {
  const samples = Math.round(seconds * rate), data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 12000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * @param {object} [o]
 * @param {typeof RUNNER_PORTS} [o.ports] 换一组端口（同一次 npm test 里另一个测试文件也用这个夹具时）
 * @param {boolean} [o.productionMaster] 主服务这一侧改用生产的装配（`account-master-assembly.mjs`：事件库、内部口、附件存储、
 *        页面的事件流从事件库读），槽调度经内部口用 root 那张证书去问（`account-master-scheduler-client.mjs`）——
 *        和 Linux 上 root 入口的接法相同。缺省仍是夹具自己拼的那一份。
 */
export async function startRunnerProcessFixture({ slotId = 'slot-a', pollMs = 100, ports: P = RUNNER_PORTS, productionMaster = false, publicHandler = null } = {}) {
  const log = [], say = (event, fields) => log.push({ at: Date.now(), event, ...fields });
  const docKey = pair(), masterKey = generateServiceKeyPair(), m = scopeModel(slotId);
  const generations = new Map(), stops = [];
  let dir, pki, chainDir, agentKey, servicesFile, masterPin, workerPin, authorityId, docInternalPort, ports, statusConfig;
  let master, readControl, eventStore, masterServer, lookServer, renderWorker, scheduler, slot, look, requests, masterAssembly = null, schedulerMaster = null;
  const masterSockets = new Set(), lookSockets = new Set(), renderSockets = new Set(), humanSockets = new Set();
  const lookCalls = [], renderGate = { hold: false };

  const fixture = await startCloudQueueUserFixture({ ports: [...P.combo], agentPort: P.agent, publicHandler,
    variant: {
      pkiNames: ['master', 'rootctl', 'workerid'],
      async configure(ctx) {
        ({ dir, pki, agentKey, servicesFile, authorityId, ports, statusConfig } = ctx); docInternalPort = ports.docInternal;
        chainDir = path.join(dir, 'root-chain'); fs.mkdirSync(chainDir);
        masterPin = certificateFingerprint(pki.master.fingerprint256); workerPin = certificateFingerprint(pki.wrong.fingerprint256);
        // 主身份（只做控制）在文档服务的服务登记表里是另一把钥匙；任务身份还是组合夹具里登记的那一把
        addServiceKey(servicesFile, { service: 'agent', role: 'agent', actsFor: 'member', kid: masterKey.kid, pub: masterKey.pub });
        Object.assign(m.expected, { docAuthorityId: authorityId, docPublicKey: docKey.publicKey,
          clientFingerprint256: certificateFingerprint(pki.rootctl.fingerprint256),
          serverFingerprint256: certificateFingerprint(pki.workerid.fingerprint256) });
        // ---------- 运行素材 ----------
        // 文档服务要知道「现在活着的素材服务是哪一个进程」。生产上这来自 root 写的登记（只在 Linux 上）；这里换成：
        // 连过来的确实是钉住的那张素材证书，实例号读素材服务自己起来时落盘的那一份。它还没起来时一律答不上。
        const assetPin = certificateFingerprint(pki.asset.fingerprint256);
        const currentAsset = ({ socket }) => {
          if (!socket || socket.destroyed || socket.authorized !== true ||
              certificateFingerprint(socket.getPeerCertificate()?.fingerprint256) !== assetPin) return null;
          let live; try { live = JSON.parse(fs.readFileSync(path.join(ctx.assetDir, 'asset-instance.json'), 'utf8')); } catch { throw new Error('asset-instance-not-started'); }
          if (live?.state !== 'running' || live.serviceIdentity !== ASSET_IDENTITY || typeof live.instanceId !== 'string') throw new Error('asset-instance-not-started');
          return { assetInstanceId: live.instanceId, serviceIdentity: ASSET_IDENTITY };
        };
        return {
          runAssets: { currentAsset, resolveObserver: async input => currentAsset(input), ticketTtlMs: 120_000, maxBodyBytes: 1024 * 1024 },
          assetChild: { args: [path.join(here, 'account-runner-asset-entry.mjs')], cwd: path.resolve(here, '..', '..', '..'),
            env: { PROMPTCUT_ASSET_SERVICE_IDENTITY: ASSET_IDENTITY, PROMPTCUT_ASSET_AGENT_FINGERPRINT256: workerPin, PROMPTCUT_ASSET_AGENT_SERVICE_KID: agentKey.kid } },
          agentTls: pki.master, agentRegistrationPurpose: 'control-only',
          // 带素材表的空项目（导入素材要往素材表里登记）
          initialProject: { tracks: [], media: [] },
          comboLog: (event, fields) => { if (!/^(http|ws\.frame)/.test(event)) say(`doc.${event}`, { code: fields?.code ?? fields?.reason ?? null, detail: fields?.detail ?? fields?.type ?? null, controlId: fields?.controlId ?? null }); },
          accountAgent: { runScopes: { signingKey: docKey.privateKey,
            slots: [{ expected: m.expected, workerServiceKid: agentKey.kid, workerFingerprint256: workerPin }],
            masterServiceKid: masterKey.kid, masterFingerprint256: masterPin,
            // 生产上这一项不存在：文档服务按配置里的目录和锚点摘要去读 root 写的文件（只在 Linux 上）。
            sourceFactory: () => ({ read: ({ checkpoint }) => inspectAgentScopeSource({ read: m.io.read, expected: m.expected,
              configuredAnchorDigest: digestOf(m.files.get('anchor.json')), checkpoint }) }) } },
        };
      },
    },
    async createAgentService({ agentOptions, agentClient, agentRunClient, agentReadControl, dir: fixtureDir }) {
      master = agentRunClient; readControl = agentReadControl;
      if (productionMaster) {
        // 生产的装配：主身份登记、读取控制、事件库、内部口（收事件 + 给槽调度问话）、附件存进各代共用的数据目录
        const sharedDataDir = path.join(fixtureDir, 'agent-shared-data'), masterDataDir = path.join(fixtureDir, 'agent-master-data');
        fs.mkdirSync(sharedDataDir, { recursive: true }); fs.mkdirSync(masterDataDir, { recursive: true });
        masterAssembly = await createAccountMasterAssembly({ dataDir: masterDataDir, sharedDataDir, runClient: agentRunClient,
          conversationClient: agentClient, readControl: agentReadControl, tls: pki.master, internalPort: P.masterEvents,
          controllerFingerprint256: pki.rootctl.fingerprint256, log: (event, fields) => say(`master.${event}`, { code: fields?.code ?? null }) });
        eventStore = masterAssembly.eventStore;
        await until(() => readControl.describe().connected, { timeoutMs: 10_000, what: '主身份的读取控制连接' });
        schedulerMaster = createMasterSchedulerClient({ origin: `https://127.0.0.1:${P.masterEvents}`, tls: pki.rootctl,
          serverFingerprint256: pki.master.fingerprint256 });
        return { service: masterAssembly.service, async close() { schedulerMaster.close(); await masterAssembly.close(); } };
      }
      // 主服务这一侧：只接待人（发消息、停止都转给文档服务），自己不跑任务
      const service = createHostedAgentService({ accountMode: true, conversationClient: agentClient });
      await readControl.start();
      await until(() => readControl.describe().connected, { timeoutMs: 10_000, what: '主身份的读取控制连接' });
      eventStore = createAccountRunEvents({ file: path.join(fixtureDir, 'master-events.sqlite'), authorityId,
        verifyGrant: async () => { throw Object.assign(Error('not-a-human-gate'), { status: 403 }); } });
      const eventHandler = createWorkerEventInternalHandler({ eventStore, resolveWorker: input => master.workerEventSource(input) });
      masterServer = https.createServer({ ...pki.master, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
        void eventHandler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(() => res.destroy());
      });
      masterServer.on('connection', socket => { masterSockets.add(socket); socket.once('close', () => masterSockets.delete(socket)); });
      await listenOn(masterServer, P.masterEvents);
      return { service, async close() { await readControl.close(); await closeServer(masterServer, masterSockets); await eventStore.close(); } };
    } });
  const projectId = fixture.projectId, docOrigin = `https://127.0.0.1:${docInternalPort}`;
  const dataDir = path.join(dir, 'agent-shared-data'); fs.mkdirSync(dataDir, { recursive: true });

  // ---------- 渲染服务的「看画面」口子：签名、队列、调度是真的；出图的工作进程是替身 ----------
  renderWorker = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 记下坏请求 */ }
      const call = { path: new URL(req.url, 'http://x').pathname, projectName: body?.project?.name ?? null, t: body?.t ?? null, key: req.headers['x-pc-look-key'] ?? null, at: Date.now() };
      lookCalls.push(call);
      while (renderGate.hold && !req.socket.destroyed) await new Promise(resolve => setTimeout(resolve, 20));
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(call.path === '/api/vision/snapshot'
        ? { ok: true, t: body?.t ?? 0, clipId: null, width: 768, height: 432, rects: null, note: '替身画面', __image: { mime: 'image/png', base64: PNG_B64 } }
        : { ok: false, error: '替身没有这一条' }));
    });
  });
  renderWorker.on('connection', socket => { renderSockets.add(socket); socket.once('close', () => renderSockets.delete(socket)); });
  await listenOn(renderWorker, P.renderWorker);
  const lookKeyDir = path.join(dir, 'look-key'); fs.mkdirSync(lookKeyDir, { mode: 0o700 });
  // 任务进程签看画面请求用的服务私钥：公钥就是文档服务登记表里 agent 的那一把（渲染服务按同一份登记表核）
  writeServiceKeyFile(lookKeyDir, { service: 'agent', kid: agentKey.kid, priv: agentKey.priv, instanceId: newInstanceId(), instanceName: 'runner fixture' });
  const registry = createServiceRegistry({ file: servicesFile });
  requests = createRenderRequests({ dir: path.join(dir, 'look-queue'), log: (event, fields) => say(`render.${event}`, fields) });
  requests.load();
  look = createLook({ verify: createLookVerifier({ registry }), requests,
    project: id => (id === projectId ? { enabled: true, active: true, hosted: { agent: { enabled: true } } } : null),
    resident: () => ({ port: P.renderWorker, key: 'resident-key', running: true, node: id => (id === projectId ? { projectId: id, connected: true, cards: { state: 'none' } } : null) }),
    iso: () => ({ enabled: false, port: 0, key: null, current: null, report: null, lastRun: null }),
    log: (event, fields) => say(`render.${event}`, fields), limits: { pollMs: 20 } });
  lookServer = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://x').pathname, op = { '/look': 'handle', '/look/poll': 'poll', '/look/cancel': 'cancel' }[route];
    if (req.method !== 'POST' || !op) { res.writeHead(404); res.end(); return; }
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      void look[op]({ auth: req.headers[LOOK_AUTH_HEADER], bodyText: Buffer.concat(chunks).toString('utf8') }).then(out => {
        if (res.destroyed) return; res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body));
      }, () => { if (!res.destroyed) { res.writeHead(500); res.end(); } });
    });
  });
  lookServer.on('connection', socket => { lookSockets.add(socket); socket.once('close', () => lookSockets.delete(socket)); });
  await listenOn(lookServer, P.look);

  // ---------- root：发布器的事务是真的，看操作系统的那一半换成「真的子进程」 ----------
  const originalWrite = m.io.write, originalInspect = m.io.inspect, originalLock = m.io.lock, originalPin = m.io.pinPrevious;
  m.io.write = async (name, value, exclusive) => { await originalWrite(name, value, exclusive);
    fs.writeFileSync(path.join(chainDir, name), JSON.stringify(value), { flag: exclusive ? 'wx' : 'w', mode: 0o600 }); };
  m.io.lock = async () => { const release = await originalLock(); return options => release(options); };
  const file = name => path.join(dir, name);
  m.io.start = async reservation => {
    const epoch = reservation.epoch, settingsFile = file(`runner-worker-${epoch}.json`), logFile = file(`runner-worker-${epoch}.log`);
    // 生产形状的设置文件（`account-task-worker-config.mjs`）
    const worker = { v: 1, expected: m.expected, reservation, rootRecordFile: path.join(chainDir, `epoch-${epoch}.json`),
      identity: { keyFile: file('workerid.key'), certFile: file('workerid.crt'), caFile: file('ca.crt'), port: P.identityBase + epoch },
      doc: { origin: `${docOrigin}/`, fingerprint256: pki.doc.fingerprint256, keyFile: file('wrong.key'), certFile: file('wrong.crt'), caFile: file('ca.crt') },
      master: { origin: `https://127.0.0.1:${P.masterEvents}/`, fingerprint256: pki.master.fingerprint256 },
      journalFile: file(`runner-journal-${epoch}.sqlite`), dataDir, stateDir: file(`runner-state-${epoch}`),
      controlPort: P.controlBase + epoch,
      look: { url: `http://127.0.0.1:${P.look}`, keyDir: lookKeyDir },
      // 任务进程连素材服务的内部口，用的是它连文档服务的同一张任务证书
      runAssets: { origin: `https://127.0.0.1:${ports.assetInternal}/`, fingerprint256: pki.asset.fingerprint256,
        // 全量测试时机器很忙：一次素材请求里素材服务要回文档服务核好几趟，缺省的 5 秒无动静时限不够宽
        maxResponseBytes: 1024 * 1024, maxImportBytes: 64 * 1024 * 1024, timeoutMs: 30_000 } };
    fs.writeFileSync(settingsFile, JSON.stringify({ worker, logFile, lookLimits: { pollWaitMs: 300 } }), { mode: 0o600 });
    // 子进程不带父子通道（和 systemd 起的一样）：指令走它那个只认 root 证书的本机 HTTPS 口
    const gateway = createAccountWorkerHttpsGateway({ configurationModule: path.join(here, 'account-runner-child-config.mjs'), cwd: path.resolve(here, '..', '..', '..'),
      env: { ...process.env, PROMPTCUT_RUNNER_FIXTURE_SETTINGS: settingsFile }, timeoutMs: 30_000, port: worker.identity.port,
      controllerTls: pki.rootctl, serverFingerprint256: m.expected.serverFingerprint256,
      scope: { slotId: m.expected.slotId, epoch: reservation.epoch, instanceId: reservation.instanceId } });
    const ready = await gateway.ready;
    generations.set(epoch, { gateway, pid: ready.pid, port: ready.port, logFile, journalFile: worker.journalFile });
    say('root.started', { epoch, pid: ready.pid });
  };
  m.io.inspect = async reservation => { const value = await originalInspect(reservation); value.instance.pid = generations.get(reservation.epoch).pid; return value; };
  m.io.identity = async reservation => {
    const result = await getIdentity(generations.get(reservation.epoch).port, pki.rootctl, m.expected.serverFingerprint256);
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
  const holds = { forcedClose: null };
  const headRecord = () => { const head = m.files.get('current.json'); return head ? { head, record: m.files.get(`epoch-${head.epoch}.json`) } : null; };
  slot = {
    slotId,
    async current() { const now = headRecord(); return now ? { rootScopeRef: agentScopeRef(now.record), phase: now.head.phase } : null; },
    async open() {
      await m.run(m.files.has('current.json') ? 'start' : 'initialize');
      const { record } = headRecord(), gateway = generations.get(record.epoch).gateway;
      return { rootScopeRef: agentScopeRef(record), worker: { prepare: task => gateway.prepare(task), start: () => gateway.start(),
        settlement: gateway.settlement, exited: gateway.closed, alive: () => !gateway.describe().childClosed, stop: () => gateway.terminate() } };
    },
    bind: assignment => m.run('bind', { assignment }),
    close: ({ terminal, intent }) => m.run('close', { terminal, intent }),
    // holds.forcedClose：测试可以让 root 晚一点动手强制关（看清「进程还活着时权限已经没了」那一段）
    async forcedClose({ terminal }) { say('root.forced-close.requested', {}); if (holds.forcedClose) await holds.forcedClose; return m.run('forced-close', { terminal, intent: null }); },
    retire({ reason }) { const { record } = headRecord();
      return m.run('retire', { intent: null, terminal: { v: 1, protocol: 'promptcut.agent-run-scope.unassigned-retirement.v1',
        authorityId: m.expected.authorityId, slotId: m.expected.slotId, epoch: record.epoch, recordDigest: digestOf(record), reason } }); },
    observeFailure: () => m.run('observe-failure'),
  };
  scheduler = createAccountSlotScheduler({ slots: [slot], pollMs,
    master: schedulerMaster ?? { pending: () => master.pending(), scopeControl: row => master.scopeControl(row) }, log: say });

  // ---------- 人这一侧：真的登录、真的页面连接、经主服务的公开接口发消息和停止 ----------
  const ca = fs.readFileSync(fixture.caFile);
  const request = (route, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(fixture.origin + route, { method, ca, timeout: 15_000,
      headers: { ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...headers } }, res => {
      const bytes = []; res.on('data', chunk => bytes.push(chunk)); res.once('error', reject);
      res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(bytes).toString()),
        cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); } catch (error) { reject(error); } });
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(Error('fixture-http-timeout'))); req.end(text);
  });
  async function connectActor(index) {
    let cookie = '', csrf = '';
    const site = async (route, body) => { const result = await request('/api/account' + route, { method: body ? 'POST' : 'GET', body,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: fixture.origin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
      if (result.cookie) cookie = result.cookie; if (result.body.csrfToken) csrf = result.body.csrfToken; return result; };
    await site('/me'); const login = await site('/login', fixture.accounts[index]);
    if (login.status !== 200) throw Error('runner-fixture-login');
    let editor = await site('/editor/session', { deviceId: `runner-device-${index}`, deviceName: 'Runner page', requestId: `runner-editor-${index}` });
    if (editor.status !== 200) throw Error('runner-fixture-editor-session');
    const doc = (route, body) => request('/hosted/shared/account/' + route, { method: 'POST', body, headers: { authorization: `Bearer ${editor.body.accessToken}` } });
    const consent = await site('/cloud-agent-consent', { accept: true, noticeVersion: 1, requestId: `runner-consent-${index}` });
    if (consent.status !== 200) throw Error('runner-fixture-consent');
    let session = await doc('session', { projectId, deviceId: `runner-device-${index}`, requestId: `runner-session-${index}` });
    if (session.status !== 200) throw Error('runner-fixture-doc-session');
    if (index === 0) {
      const changed = await doc('admin', { projectId, op: 'set-hosted-service', service: 'agent', enabled: true,
        expectedAccessRevision: session.body.accessRevision, requestId: 'runner-enable-agent' });
      if (changed.status !== 200) throw Error('runner-fixture-enable-agent');
      session = await doc('session', { projectId, deviceId: `runner-device-${index}`, requestId: 'runner-enabled-session' });
    }
    const ws = new WebSocket(fixture.origin.replace('https:', 'wss:') + '/hosted/', ['promptcut.v1', `promptcut.account.${session.body.connectionTicket}`], { ca, origin: fixture.origin });
    const closed = new Promise(resolve => ws.once('close', resolve)); humanSockets.add(ws); ws.once('close', () => humanSockets.delete(ws));
    const send = frame => new Promise((resolve, reject) => { const reqId = `human-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => { ws.off('message', receive); reject(Error('runner-fixture-page-timeout')); }, 10_000);
      const receive = bytes => { const reply = JSON.parse(bytes.toString()); if (reply.reqId !== reqId) return;
        clearTimeout(timer); ws.off('message', receive); resolve(reply); };
      ws.on('message', receive); ws.send(JSON.stringify({ ...frame, reqId })); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const opened = await send({ type: 'project.open', projectId });
    const pageId = `runner-page-${index}`;
    const selection = await send({ type: 'selection.set', projectId, pageId, revision: 1, selection: { clipIds: [] } });
    if (selection.type !== 'selection.ok') throw Error('runner-fixture-selection');
    // 委托票据有时限；机器很忙时一条测试会跑过它。快到期就凭同一个登录重新要一份（和页面的做法一样）
    let renewals = 0;
    const tickets = async () => {
      if (session.body.expiresAt - Date.now() < 30_000) {
        let renewed = await doc('session', { projectId, deviceId: `runner-device-${index}`, requestId: `runner-session-${index}-renew-${++renewals}` });
        if (renewed.status === 401) {
          // 编辑器这一侧的短期凭证也到期了：凭网站登录再换一份
          const again = await site('/editor/session', { deviceId: `runner-device-${index}`, deviceName: 'Runner page', requestId: `runner-editor-${index}-renew-${renewals}` });
          if (again.status !== 200) throw Error('runner-fixture-editor-session-renew');
          editor = again;
          renewed = await doc('session', { projectId, deviceId: `runner-device-${index}`, requestId: `runner-session-${index}-renew-${++renewals}` });
        }
        if (renewed.status !== 200) throw Error('runner-fixture-doc-session-renew');
        session = renewed;
      }
      return session.body;
    };
    return { opened, pageId, send, session: session.body,
      project: async () => (await send({ type: 'project.open', projectId })),
      agent: async (route, body) => request('/agent/v1' + route, { method: body ? 'POST' : 'GET', body, headers: { authorization: `Bearer ${(await tickets()).agentDelegationTicket}` } }),
      /** 照页面的做法传一个附件：字节直接是请求体，文件名在查询串里 */
      upload: async (conversationId, name, bytes) => new Promise((resolve, reject) => { void tickets().then(ticket => {
        const req = https.request(`${fixture.origin}/agent/v1/conversations/${conversationId}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', ca, timeout: 15_000,
          headers: { authorization: `Bearer ${ticket.agentDelegationTicket}`, 'content-type': 'application/octet-stream', 'content-length': bytes.length } }, res => {
          const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
          res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } }); });
        req.once('error', reject); req.once('timeout', () => req.destroy(Error('fixture-upload-timeout'))); req.end(bytes); }, reject); }),
      /** 照页面的做法开这个对话的事件流；收到的事件逐条放进 `seen`。回 `{ status(), close() }` */
      stream: async (conversationId, seen, after = 0) => {
        const ticket = await tickets(); let status = null, buffer = '';
        const req = https.request(`${fixture.origin}/agent/v1/conversations/${conversationId}/events?after=${after}`, { method: 'GET', ca,
          headers: { authorization: `Bearer ${ticket.agentDelegationTicket}`, accept: 'text/event-stream' } }, res => {
          status = res.statusCode; res.setEncoding('utf8');
          res.on('data', text => { buffer += text; for (;;) { const at = buffer.indexOf('\n\n'); if (at < 0) break;
            const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
            for (const row of block.split('\n')) if (row.startsWith('data: ')) { try { seen.push(JSON.parse(row.slice(6))); } catch { /* 不是事件 */ } } } });
          res.on('error', () => {}); });
        req.on('error', () => {}); req.end();
        return { status: () => status, close: () => req.destroy() };
      },
      /** 凭成员自己的素材票据直接问素材服务（不经 Agent）：用来核对任务写进去的字节 */
      asset: async hash => { const res = await fetch(`http://127.0.0.1:${ports.asset}/api/asset/media/${hash}`, { headers: { authorization: `Bearer ${(await tickets()).assetTicket}` } });
        return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) }; },
      async close() { ws.terminate(); await closed; } };
  }
  // 文档服务的账本：另开一个只读连接看（账本是文档服务进程内的对象，这里不碰它、只读盘上已经提交的那一份）
  const ledgerFile = path.join(hostedPaths(path.join(dir, 'doc')).docservice, 'account-v2.sqlite');
  const ledger = () => { const db = new DatabaseSync(ledgerFile, { readOnly: true });
    try { return JSON.parse(db.prepare('SELECT payload FROM account_authority_state WHERE id=1').get().payload); } finally { db.close(); } };
  const conversation = conversationId => ledger().conversationsV2?.[projectId]?.[conversationId] ?? null;
  const messageOf = (conversationId, requestId) => conversation(conversationId)?.messages.find(row => row.requestId === requestId) ?? null;
  const grantOf = messageId => Object.values(ledger().runGrantsV2 ?? {}).find(g => g.messageId === messageId) ?? null;
  // 对话的工作目录：和运行器里算的是同一个位置（各代共用的数据目录下，按项目、对话分）
  const workspaceOf = conversationId => createWorkspaces({ dataDir }).open({ projectId, conversationId,
    ownerKey: createHash('sha256').update(`account-v2
${projectId}
${conversationId}`).digest('hex').slice(0, 32) });

  return { ...fixture, dir, dataDir, projectId, m, scheduler, slot, master, generations, stops, log, lookCalls, renderGate, look, requests, masterAssembly, pki, ports: { ...fixture.ports, ...P },
    connectActor, headRecord, workspaceOf, ledger, conversation, messageOf, grantOf, holds,
    chain: epoch => Object.fromEntries(['epoch', 'assignment', 'terminal', 'intent', 'closure', 'failure'].map(k => [k, m.files.get(`${k}-${epoch}.json`) ?? null])),
    events: conversationId => eventStore.after({ projectId, conversationId }).events,
    workerLog: epoch => { try { return fs.readFileSync(generations.get(epoch).logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    async close() {
      const errors = [];
      const attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
      renderGate.hold = false;
      await attempt(() => scheduler.stop());
      // 测试收尾：把还活着的子进程按进程号结束掉。这是清理，不是关闭证明。
      for (const generation of generations.values()) await attempt(() => generation.gateway.terminate());
      await Promise.all([...humanSockets].map(ws => { const done = new Promise(resolve => ws.once('close', resolve)); ws.terminate(); return done; }));
      look.close();
      await attempt(() => closeServer(lookServer, lookSockets)); await attempt(() => closeServer(renderWorker, renderSockets));
      const closed = await fixture.close().catch(error => { errors.push(error); return null; });
      return { errors, closed, alive: [...generations.values()].filter(g => !g.gateway.describe().childClosed).length };
    } };
}
