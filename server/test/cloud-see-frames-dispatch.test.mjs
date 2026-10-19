import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer as createVite } from 'vite';
import { createExistingHostedRunnerFactory } from '../agent/service/account-runner.mjs';
import { createWorkerMasterLookClient } from '../agent-service/account-task-worker-config.mjs';
import { createAccountMasterAssembly } from '../agent-service/account-master-assembly.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { ROOT, project, script, startDoc } from './cloud-agent-kit.mjs';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const EXPECTED_DIGEST = 'e'.repeat(64);
const PROJECT_ID = 'p-scope-look';
const CONVERSATION_ID = 'c-scope-look';
const RUN_ID = 'run-scope-1';
const RUN_GRANT_ID = 'grant-scope-1';
const MESSAGE_ID = 'msg-scope-1';

test('cloud see_frames dispatch: scopeBinding.assignmentDigest propagation, lookRoute req/res close handling, and heartbeat/release', { timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-see-frames-'));
  const masterDir = path.join(dir, 'master');
  const sharedDir = path.join(dir, 'shared');
  const workerDir = path.join(dir, 'worker');
  fs.mkdirSync(masterDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(workerDir, { recursive: true });

  const pki = assetWiringPki(dir);
  const doc = await startDoc(t);
  await doc.seed(project(PROJECT_ID, '测试项目'));

  const vite = await createVite({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  const workerSourceCalls = [];
  const masterLookCalls = [];
  const masterHeartbeats = [];
  const masterReleases = [];
  let holdLookPromise = null;
  let observedLookSignal = null;

  const masterLook = {
    forProject(projectId, { cards, run, signal } = {}) {
      return async (pathname, body, opts = {}) => {
        const sig = opts?.signal ?? signal ?? null;
        observedLookSignal = sig;
        masterLookCalls.push({
          projectId,
          path: pathname,
          body,
          cards: typeof cards === 'function' ? cards() : cards,
          run,
          abortedAtEntry: Boolean(sig?.aborted),
        });
        // 等待一段异步时间，验证 req 流读完触发 req 'close' 时不会误触发 ac.abort('client-closed')
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (holdLookPromise) {
          await holdLookPromise(sig);
        }
        if (sig?.aborted) {
          throw sig.reason ?? new Error('client-closed');
        }
        if (pathname === '/api/vision/snapshot') {
          return {
            ok: true,
            t: body?.t ?? 0,
            width: 768,
            height: 432,
            rects: null,
            note: '画面',
            __image: { mime: 'image/png', base64: PNG_B64 },
          };
        }
        return { ok: false, error: 'unsupported' };
      };
    },
    async heartbeat(projectId, info) {
      masterHeartbeats.push({ projectId, ...info });
    },
    async release(projectId, info) {
      masterReleases.push({ projectId, ...info });
    },
  };

  const transports = { run: async (_req, _res, fn) => fn(), dispatch: (fn) => fn() };
  const stub = async () => { throw Object.assign(new Error('unused'), { status: 503 }); };
  const conversationClient = {
    readTransports: transports,
    ...Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map((name) => [name, stub])),
  };

  const runClient = {
    async registerInstance() {
      return { instanceId: 'master-instance-1', instanceGeneration: 1 };
    },
    instanceIdentity: () => ({
      instanceId: 'master-instance-1',
      instanceGeneration: 1,
      purpose: 'control-only',
      authorityId: 'doc-authority-1',
    }),
    pending: stub,
    scopeControl: stub,
    async workerEventSource(input) {
      workerSourceCalls.push(input);
      if (input.assignmentDigest !== EXPECTED_DIGEST) {
        throw Object.assign(new Error('run-binding-mismatch'), { status: 403, code: 'run-binding-mismatch' });
      }
      return {
        allowed: true,
        workerFingerprint256: pki.asset.fingerprint256,
        runGrant: {
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          runId: RUN_ID,
          runGrantId: RUN_GRANT_ID,
          state: 'active',
        },
      };
    },
  };

  const assembly = await createAccountMasterAssembly({
    dataDir: masterDir,
    sharedDataDir: sharedDir,
    runClient,
    conversationClient,
    readControl: { transports, async start() {}, async close() {} },
    tls: pki.account,
    internalPort: 5820,
    controllerFingerprint256: pki.doc.fingerprint256,
    look: masterLook,
  });

  t.after(async () => {
    await assembly.close();
    await vite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const workerLook = createWorkerMasterLookClient({
    masterOrigin: `https://127.0.0.1:${assembly.internalPort}/`,
    masterFingerprint256: pki.account.fingerprint256,
    tls: pki.asset,
  });

  // 跟踪任务进程发往文档服务的 WS 消息，确认无本地页面桥时不会白发 selection.query
  const wsSentTypes = [];
  const openSockets = new Set();
  const dataClient = {
    wsUrl: 'wss://127.0.0.1:5821/docservice',
    openCount: () => openSockets.size,
    webSocketFor() {
      let seq = 0;
      class ScopedDataWebSocket extends WebSocket {
        constructor(_url) {
          super(doc.url, ['promptcut.v1', `promptcut.role.agent.${++seq}`]);
          openSockets.add(this);
          this.once('close', () => openSockets.delete(this));
        }
        send(data, ...rest) {
          try {
            const parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
            if (parsed?.type) wsSentTypes.push(parsed.type);
          } catch {}
          return super.send(data, ...rest);
        }
        static async closeOwned() {
          for (const s of [...openSockets]) {
            try { s.close(); } catch {}
          }
          openSockets.clear();
        }
      }
      return ScopedDataWebSocket;
    },
  };

  // 1. 验证 account-runner.mjs 在 grant 仅有 grant.scopeBinding.assignmentDigest 时，
  //    能将正确的 assignmentDigest 传给 createWorkerMasterLookClient -> lookRoute -> workerEventSource，
  //    且 lookRoute 等待异步 masterLook 期间不会误触发 client-closed，最终成功返回 see_frames 画面
  const runnerFactory = createExistingHostedRunnerFactory({
    root: ROOT,
    loadModule: (id) => vite.ssrLoadModule(id),
    dataClient,
    dataDir: workerDir,
    modelConfig: async () => ({ vendor: 'mock', model: 'mock-1' }),
    look: workerLook,
    resources: { authorize: async () => ({ allowed: true }) },
  });

  const grant = {
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    runId: RUN_ID,
    runGrantId: RUN_GRANT_ID,
    messageId: MESSAGE_ID,
    instanceId: 'worker-instance-1',
    accountId: 'user-1',
    initiatorName: 'alice',
    // 作用域模式下顶层没有 assignmentDigest，位于 scopeBinding.assignmentDigest
    scopeBinding: {
      assignmentDigest: EXPECTED_DIGEST,
    },
  };
  const record = {
    messageId: MESSAGE_ID,
    runId: RUN_ID,
    senderNameAtSend: 'alice',
    content: script([
      { tool: 'see_frames', input: { source: 'timeline', t: 1 } },
      { say: '画面看完了' },
    ]),
    attachments: [],
  };
  const events = [];
  const runner = await runnerFactory({
    grant,
    record,
    context: { projectId: PROJECT_ID, runGrantId: RUN_GRANT_ID },
    onModelCall: async () => {},
    beforeToolCall: async () => {},
    onEvent: (ev) => events.push(ev),
  });

  const handle = await runner.start();
  await handle.done;
  await runner.drain();

  // 代交的收尾汇报(模型没交;harness/agent.mjs requireFinalReport)不算
  const toolResults = events.filter((e) => e.type === 'tool_result' && e.name !== 'report_progress');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].name, 'see_frames');
  assert.equal(toolResults[0].ok, true, `see_frames 应当成功，实际: ${JSON.stringify(toolResults[0])}`);

  // 验证 masterLook 被调用，且 signal 未被误触发 abort
  const snapCall = masterLookCalls.find((c) => c.path === '/api/vision/snapshot');
  assert.ok(snapCall, 'masterLook 应当收到 /api/vision/snapshot 请求');
  assert.equal(snapCall.projectId, PROJECT_ID);
  assert.equal(snapCall.abortedAtEntry, false);

  // 验证无本地页面桥时不发 selection.query
  assert.equal(wsSentTypes.includes('selection.query'), false, '无 toolset.pageBridge.call 时不应发送 selection.query');

  // 验证 workerEventSource 收到了正确的 EXPECTED_DIGEST（包含 look 与 drain 时的 release）
  assert.ok(workerSourceCalls.length >= 2, 'workerEventSource 至少在 look 与 release 时被调用');
  for (const call of workerSourceCalls) {
    assert.equal(call.projectId, PROJECT_ID);
    assert.equal(call.runGrantId, RUN_GRANT_ID);
    assert.equal(call.assignmentDigest, EXPECTED_DIGEST, '每次向文档服务核对都必须携带 scopeBinding.assignmentDigest');
  }

  // 验证 drain 时 release 已被主服务执行
  assert.equal(masterReleases.length, 1);
  assert.deepEqual(masterReleases[0], { projectId: PROJECT_ID, runId: RUN_ID, aborted: false });

  // 2. 验证 heartbeat 与 release 同样携带 scopeBinding.assignmentDigest
  await workerLook.heartbeat(PROJECT_ID, {
    runId: RUN_ID,
    runGrantId: RUN_GRANT_ID,
    conversationId: CONVERSATION_ID,
    assignmentDigest: grant.assignmentDigest ?? grant.scopeBinding?.assignmentDigest,
  });
  assert.equal(masterHeartbeats.length, 1);
  assert.deepEqual(masterHeartbeats[0], { projectId: PROJECT_ID, runId: RUN_ID });

  await runner.fence({ kind: 'stop' });
  const releaseDeadline = Date.now() + 5000;
  while (masterReleases.length < 2 && Date.now() < releaseDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(masterReleases.length, 2);
  assert.deepEqual(masterReleases[1], { projectId: PROJECT_ID, runId: RUN_ID, aborted: true });

  // 3. 验证客户端在响应未结束（!res.writableEnded）真正提前断开连接时，lookRoute 能正常触发 ac.abort('client-closed')
  let abortObservedByMasterLook = null;
  let notifyMasterLookEntered;
  const masterLookEntered = new Promise((resolve) => { notifyMasterLookEntered = resolve; });
  holdLookPromise = (sig) => new Promise((resolve, reject) => {
    notifyMasterLookEntered();
    sig.addEventListener('abort', () => {
      abortObservedByMasterLook = sig.reason;
      reject(sig.reason ?? new Error('aborted'));
    }, { once: true });
  });

  const clientAbortController = new AbortController();
  const postToMaster = workerLook.forProject(PROJECT_ID, {
    assignmentDigest: EXPECTED_DIGEST,
    run: { runGrantId: RUN_GRANT_ID, runId: RUN_ID, conversationId: CONVERSATION_ID },
  });

  const pendingLook = postToMaster('/api/vision/snapshot', { project: { id: PROJECT_ID, tracks: [] }, t: 2 }, {
    signal: clientAbortController.signal,
  });

  await masterLookEntered;
  assert.equal(observedLookSignal?.aborted, false, '客户端未断开时 lookRoute 的 signal 不应 abort');

  // 客户端主动中断连接
  clientAbortController.abort(new Error('worker-cancelled'));
  await assert.rejects(pendingLook, /worker-cancelled/);

  // 等待主服务收到连接关闭并触发 ac.abort(new Error('client-closed'))
  const deadline = Date.now() + 5000;
  while (!abortObservedByMasterLook && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(abortObservedByMasterLook instanceof Error, '客户端提前断开时主服务 lookRoute 应触发 abort');
  assert.equal(abortObservedByMasterLook.message, 'client-closed');
});
