/**
 * 0.7.18「云端 Agent 工具表接线」的单测(不起任何服务、不占端口)。
 * 跑:npm test -- server/test/cloud-tools-wire.test.mjs
 *
 *   WIRE-TABLE  工具表:没有提供者时逐项是原来的回答;这个进程里建出了提供者的才算可用、才交给模型;给模型看的那一段跟着变
 *   WIRE-JOBS   作业账本:重开时排着的、在跑的都标成被中断;`active` 只列这一轮名下没结束的
 *   WIRE-CONF   任务进程设置里的 `tools` 一节:只认列出的键;写了但路径不在就拒绝
 *   WIRE-PAGE   任务进程到主服务的页面请求内部通道:签名、连接绑定、一次性随机数、文档服务的现问,一样不对都拒,
 *               并且交给反向通道的运行上下文取自文档服务的回答,不取自请求体
 * 整条链(模型发工具调用 → 提供者 → 文档与素材;停止、转私有、关 Agent 的收场;隔离)在探针 scripts/probes/cloud-tools-wire-probe.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CLOUD_TOOL_PLAN, CLOUD_OPEN_TOOLS, CLOUD_OPEN_TOOLS_NO_LOOK, CLOUD_PROVIDER_TOOLS, CLOUD_PROVIDER_FAMILIES, CLOUD_SYSTEM_NOTE,
  checkCloudTool, cloudOpenTools, cloudSystemNote, providedTools } from '../agent/service/cloud-tools.mjs';
import { createToolJobs } from '../agent/service/tool-jobs.mjs';
import { ACCOUNT_TOOL_SETTING_KEYS, readAccountToolConfig, validateAccountToolSettings } from '../agent/service/account-tools.mjs';
import { validateWorkerSettings } from '../agent-service/account-task-worker-config.mjs';
import { WORKER_PAGE_PATH, WORKER_PAGE_PROOF_HEADER, WORKER_PAGE_BINDING_FIELDS, createWorkerPageInternalHandler,
  validateWorkerPageEnvelope, workerPageProofPayload, workerPageRequest, workerPageTlsBinding } from '../agent-service/worker-page-internal.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { tools as ALL_TOOLS } from '../mcp-tools.mjs';

const SCOPE = ['detect_shots', 'list_shots', 'stt_status', 'stt_install', 'transcribe_media', 'track_status', 'track_install', 'track_points', 'get_track',
  'attach_clip_motion', 'subject_status', 'subject_install', 'detect_subjects', 'list_subjects', 'background_job_status', 'auto_workflow', 'auto_workflow_status',
  'web_open', 'web_view', 'web_click', 'web_type', 'web_scroll', 'web_read', 'web_close', 'web_handoff', 'seek', 'play', 'pause', 'collect_login', 'collect_login_check'];

test('WIRE-TABLE 可以由提供者接的正是这一期点名的三十个;不在这一期的四样照旧', () => {
  assert.deepEqual([...CLOUD_PROVIDER_TOOLS].sort(), [...SCOPE].sort());
  for (const name of SCOPE) assert.ok(ALL_TOOLS.some((t) => t.name === name), `${name} 在工具总表里`);
  // 不在这一期:自定义测量仍是「还没接上」,开子 Agent 固定不支持
  assert.equal(CLOUD_TOOL_PLAN.measure_audio_js.provider, undefined);
  assert.equal(checkCloudTool('measure_audio_js', CLOUD_PROVIDER_TOOLS).ok, false);
  assert.deepEqual(checkCloudTool('spawn_agent', new Set(['spawn_agent'])), { ok: false, cloudUnavailable: true, error: '云端暂不支持开子 Agent' });
  assert.equal(CLOUD_TOOL_PLAN.see_frames.provider, undefined);
  assert.equal(CLOUD_TOOL_PLAN.get_gif.provider, undefined);
});

test('WIRE-TABLE 没有提供者(旧托管档):这些工具的回答与交给模型的清单和接线之前一样', () => {
  for (const name of SCOPE) {
    const plan = CLOUD_TOOL_PLAN[name];
    const answer = checkCloudTool(name);
    if (plan.mode === 'pending') {
      assert.equal(answer.ok, false, name); assert.equal(answer.cloudUnavailable, true, name);
      assert.match(answer.error, new RegExp(`云端 Agent 这一版还用不了 ${name}`), name);
      assert.equal(CLOUD_OPEN_TOOLS.has(name), false, `${name} 不交给模型`);
    } else assert.deepEqual(answer, { ok: true, mode: plan.mode }, name);
    // 给了一个空的、或不含它的集合,同样
    assert.deepEqual(checkCloudTool(name, new Set()), answer, name);
    assert.deepEqual(checkCloudTool(name, new Set(['get_project'])), answer, name);
  }
  assert.equal(cloudOpenTools({ look: true }), CLOUD_OPEN_TOOLS);
  assert.equal(cloudOpenTools({ look: false, provided: new Set() }), CLOUD_OPEN_TOOLS_NO_LOOK);
  assert.equal(cloudSystemNote({ look: false }), CLOUD_SYSTEM_NOTE);
  assert.equal(cloudSystemNote({ look: false, provided: new Set() }), CLOUD_SYSTEM_NOTE);
  assert.match(CLOUD_SYSTEM_NOTE, /这一版在云端还没有:\*\* 语音识别与一键流程、镜头与主体识别、运动追踪、自定义测量\(measure_audio_js\)、网页操作\(web_\*\)。/);
  assert.match(CLOUD_SYSTEM_NOTE, /网页接管和扫码登录在云端做不了/);
});

test('WIRE-TABLE 这个进程里建出了提供者的才可用:只翻建出来的那几族,别的名字给了也不算', () => {
  const web = new Set(CLOUD_PROVIDER_FAMILIES.web);
  for (const name of web) assert.deepEqual(checkCloudTool(name, web), { ok: true, mode: 'provider' });
  assert.equal(checkCloudTool('detect_shots', web).ok, false, '没建镜头那一族就仍是没接上');
  const open = cloudOpenTools({ look: false, provided: web });
  for (const name of web) assert.equal(open.has(name), true);
  assert.equal(open.has('detect_shots'), false);
  assert.equal(open.has('see_frames'), false, '看画面的口子没配时照旧不交');
  // 不在表里标过 provider 的名字混进来不起作用
  assert.deepEqual([...providedTools(['measure_audio_js', 'spawn_agent', 'no_such_tool', 'web_open'])], ['web_open']);
  assert.equal(cloudOpenTools({ look: false, provided: ['measure_audio_js', 'spawn_agent'] }), CLOUD_OPEN_TOOLS_NO_LOOK);
  assert.equal(checkCloudTool('spawn_agent', new Set(['spawn_agent'])).ok, false);
});

test('WIRE-TABLE 给模型看的那一段跟着接上的族变:接上的不再说「还没有」,并写明云端与本机不一样的地方', () => {
  const all = cloudSystemNote({ look: true, provided: CLOUD_PROVIDER_TOOLS });
  assert.match(all, /这一版在云端还没有:\*\* 自定义测量\(measure_audio_js\)。/);
  assert.doesNotMatch(all, /网页接管和扫码登录在云端做不了/);
  for (const phrase of ['语音识别、镜头识别、主体识别、运动追踪照常用', '一键流程(`auto_workflow`)在云端分五个阶段', '网页操作(`web_*`)在云节点的无头浏览器里做',
    '由他的电脑用本机的登录态代下', '登录信息只留在他的电脑上', '云端暂不支持开子 Agent', '素材的镜头拼图(`source: "media"`)云端还没有']) assert.ok(all.includes(phrase), phrase);
  // 只接上网页操作、没有反向通道(没有内部通道的进程):不说可以交给他本人
  const webOnly = cloudSystemNote({ look: false, provided: CLOUD_PROVIDER_FAMILIES.web });
  assert.match(webOnly, /这一版在云端还没有:\*\* 语音识别与一键流程、镜头与主体识别、运动追踪、自定义测量\(measure_audio_js\)。/);
  assert.ok(webOnly.includes('碰到登录墙或验证码:告诉用户,换一个不需要登录的来源。'));
  assert.match(webOnly, /网页接管和扫码登录在云端做不了/);
  assert.ok(webOnly.includes('不带任何站点的登录态(按未登录的画质)'), '采集那一条仍是原来的话');
  // 一族只接上一半不算接上(工具名不全)
  assert.equal(cloudSystemNote({ look: false, provided: ['stt_status'] }), CLOUD_SYSTEM_NOTE);
});

const CONTEXT = Object.freeze({ projectId: 'p1', conversationId: 'c1', runId: 'r1', runGrantId: 'g1', instanceId: 'i1', instanceGeneration: 1, senderAccountId: 'a1', messageId: 'm1' });
const openJobs = (file) => createToolJobs({ databasePath: file, authorize: async () => ({ allowed: true, fenceRevision: 3, grantState: 'active' }), verifyFence: async (_c, rev) => rev === 3 });

test('WIRE-JOBS 账本重开:上一个进程里排着的、在跑的都标成被中断;做完的不动;active 只列这一轮名下没结束的', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-jobs-'));
  const file = path.join(dir, 'tool-jobs.db');
  let jobs = openJobs(file);
  t.after(async () => { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const queued = await jobs.start(CONTEXT, 'shots.detect', 'a'.repeat(64), 'request-0001');
  const running = await jobs.start(CONTEXT, 'stt.transcribe', 'b'.repeat(64), 'request-0002');
  await jobs.update(CONTEXT, running.jobId, 0, { state: 'running', stage: 'transcribe', progress: 0.4 });
  const done = await jobs.start(CONTEXT, 'subject.detect', 'c'.repeat(64), 'request-0003');
  await jobs.update(CONTEXT, done.jobId, 0, { state: 'running', progress: 0.5 });
  await jobs.update(CONTEXT, done.jobId, 1, { state: 'done', progress: 1 });
  const other = { ...CONTEXT, runId: 'r2', runGrantId: 'g2', messageId: 'm2' };
  const foreign = await jobs.start(other, 'shots.detect', 'd'.repeat(64), 'request-0004');
  assert.deepEqual((await jobs.active(CONTEXT)).map((j) => [j.jobId, j.state]).sort(), [[queued.jobId, 'queued'], [running.jobId, 'running']].sort());
  assert.deepEqual((await jobs.active(other)).map((j) => j.jobId), [foreign.jobId], '别的一轮的不混进来');
  await jobs.close();

  jobs = openJobs(file);
  for (const id of [queued.jobId, running.jobId]) {
    const row = await jobs.get(CONTEXT, id);
    assert.deepEqual([row.state, row.errorCode], ['interrupted', 'INTERRUPTED_ON_RESTART'], '排着的和在跑的都如实标成被中断');
  }
  assert.equal((await jobs.get(CONTEXT, done.jobId)).state, 'done');
  assert.deepEqual(await jobs.active(CONTEXT), []);
  // 被中断是终态:旧的那一行不会复活;同一个请求号原样重发拿到的还是它,换一个请求号(新的一次工具调用)才是新作业
  await assert.rejects(jobs.update(CONTEXT, queued.jobId, 1, { state: 'running' }), { code: 'terminal-job' });
  assert.deepEqual(await jobs.start(CONTEXT, 'shots.detect', 'a'.repeat(64), 'request-0001'), { jobId: queued.jobId, state: 'interrupted' });
  const again = await jobs.start(CONTEXT, 'shots.detect', 'a'.repeat(64), 'request-0009');
  assert.notEqual(again.jobId, queued.jobId); assert.equal(again.state, 'queued');
});

test('WIRE-CONF tools 一节:只认列出的键;值要是不带换行的字符串;写了但路径不在就拒绝,没写的族是「没配」', () => {
  assert.deepEqual(validateAccountToolSettings(undefined), {});
  assert.deepEqual(validateAccountToolSettings({ PROMPTCUT_FFMPEG: '/usr/bin/ffmpeg' }), { PROMPTCUT_FFMPEG: '/usr/bin/ffmpeg' });
  for (const bad of [{ PATH: '/x' }, { PROMPTCUT_AGENT_EGRESS_TEST_ALLOW: '127.0.0.1:1' }, { PROMPTCUT_FFMPEG: 1 }, { PROMPTCUT_FFMPEG: '' }, { PROMPTCUT_FFMPEG: 'a\nb' }, ['x'], 'x'])
    assert.throws(() => validateAccountToolSettings(bad), { code: 'account-worker-settings-tools' }, JSON.stringify(bad));
  assert.ok(ACCOUNT_TOOL_SETTING_KEYS.every((key) => /^PROMPTCUT_[A-Z0-9_]+$/.test(key)));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  const empty = readAccountToolConfig({}, { root });
  assert.deepEqual([empty.shots, empty.subject, empty.stt, empty.track, empty.collect], [null, null, null, null, null]);
  assert.deepEqual(empty.browser, {});
  const missing = path.join(os.tmpdir(), 'pc-wire-no-such-dir', 'nothing.exe');
  for (const key of ['PROMPTCUT_FFMPEG', 'PROMPTCUT_AGENT_BROWSER', 'PROMPTCUT_AGENT_STT_PYTHON', 'PROMPTCUT_AGENT_TRACK_PYTHON', 'PROMPTCUT_AGENT_SUBJECT_PYTHON'])
    assert.throws(() => readAccountToolConfig({ [key]: missing }, { root }), { code: 'account-worker-settings-tools' }, key);
  assert.throws(() => readAccountToolConfig({ PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES: 'shots,nope' }, { root }), { code: 'account-worker-settings-tools' });
  const real = readAccountToolConfig({ PROMPTCUT_AGENT_BROWSER: process.execPath, PROMPTCUT_AGENT_BROWSER_ARGS: '--no-sandbox  --disable-gpu',
    PROMPTCUT_AGENT_STT_PYTHON: process.execPath, PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES: 'shots, subjects,prerender' }, { root });
  assert.deepEqual(real.browser, { executablePath: process.execPath, extraArgs: ['--no-sandbox', '--disable-gpu'] });
  assert.equal(real.stt.pythonPath, process.execPath);
  assert.deepEqual(real.workflow, { optionalStages: ['shots', 'subjects', 'prerender'] });
  // 设置文件的形状检查也认这一节(键不认的整份拒)
  const abs = process.platform === 'win32' ? (p) => `C:\\pc\\${p}` : (p) => `/pc/${p}`;
  const settings = { v: 1, expected: {}, reservation: {}, rootRecordFile: abs('r.json'), journalFile: abs('j.sqlite'), dataDir: abs('data'), stateDir: abs('state'),
    identity: { keyFile: abs('k'), certFile: abs('c'), caFile: abs('ca'), port: 0 },
    doc: { origin: 'https://127.0.0.1:1/', fingerprint256: 'a'.repeat(64), keyFile: abs('k'), certFile: abs('c'), caFile: abs('ca') },
    master: { origin: 'https://127.0.0.1:2/', fingerprint256: 'b'.repeat(64) } };
  assert.equal(validateWorkerSettings({ ...settings, tools: { PROMPTCUT_FFMPEG: abs('ffmpeg') } }).tools.PROMPTCUT_FFMPEG, abs('ffmpeg'));
  assert.throws(() => validateWorkerSettings({ ...settings, tools: { SOMETHING_ELSE: 'x' } }), { code: 'account-worker-settings-tools' });
});

/* ---------- 页面请求的内部通道 ---------- */

function pageKit() {
  const pair = generateKeyPairSync('ed25519');
  const scopePublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const binding = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', runId: 'r1', runGrantId: 'g1', instanceId: 'i1', instanceGeneration: 2, serviceKid: 'kid-worker' };
  const rootScopeRef = { rootAuthorityId: 'root-1', slotId: 'slot-a', epoch: 3, recordDigest: 'c'.repeat(64) };
  const assignmentDigest = 'd'.repeat(64);
  const workerPin = 'e'.repeat(64);
  const exporter = Buffer.alloc(32, 7);
  const envelope = (over = {}) => ({ v: 1, authorityId: 'doc-1', rootScopeRef, assignmentDigest, binding, requestId: 'request-0001',
    request: { tool: 'seek', args: { t: 1 }, timeoutMs: 15_000, initiatorPages: [{ pageId: 'page-1', live: true }] }, ...over });
  const source = (over = {}) => ({ allowed: true, assignmentDigest, rootScopeRef, scopePublicKey, scopePublicKeyDigest: digestOf(scopePublicKey), workerFingerprint256: workerPin,
    runGrant: { ...binding, accountId: 'account-initiator', state: 'active', fenceRevision: 9, readReceiptId: 'receipt-1' }, fenceRevision: 9, authorityRevision: 40,
    message: { messageId: 'm1', senderAccountId: 'account-initiator', selectionSnapshot: null }, ...over });
  const socket = (over = {}) => ({ encrypted: true, authorized: true, destroyed: false, getPeerCertificate: () => ({ fingerprint256: workerPin }),
    exportKeyingMaterial: () => exporter, ...over });
  const proofFor = (env, sock, { nonce = 'nonce-1', bodyText = canonicalJson(env), key = pair.privateKey } = {}) => {
    const payload = workerPageProofPayload({ request: workerPageRequest({ body: env, bodyText }), channelBinding: workerPageTlsBinding(sock), nonce });
    return Buffer.from(JSON.stringify({ v: 1, nonce, signature: sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64url') })).toString('base64url');
  };
  async function call(handler, { env = envelope(), sock = socket(), proof, bodyText = canonicalJson(env), method = 'POST', headers = {} } = {}) {
    const req = Object.assign((async function* () { yield Buffer.from(bodyText); })(), { url: WORKER_PAGE_PATH, method, socket: sock,
      // 缺省的签名按一条正常的连接做(导出值相同);要验的那一样不对由调用方另给
      headers: { ...(proof === null ? {} : { [WORKER_PAGE_PROOF_HEADER]: proof ?? proofFor(env, socket()) }), ...headers } });
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, status: null, body: null,
      writeHead(status) { this.status = status; }, end(text) { this.writableEnded = true; this.body = JSON.parse(text); } });
    const handled = await handler(req, res);
    return { handled, status: res.status, body: res.body, res };
  }
  return { pair, binding, envelope, source, socket, proofFor, call, workerPin };
}

test('WIRE-PAGE 信封的形状:多一个字段、少一个字段、页面号不合格,整份拒', () => {
  const kit = pageKit();
  assert.deepEqual(validateWorkerPageEnvelope(kit.envelope()).binding, kit.binding);
  assert.deepEqual(WORKER_PAGE_BINDING_FIELDS.includes('senderAccountId'), false, '发起人的账号不在请求里');
  for (const bad of [{ senderAccountId: 'x' }, { binding: { ...kit.binding, senderAccountId: 'x' } }, { binding: { ...kit.binding, projectId: undefined } }, { requestId: 'short' },
    { request: { tool: 'seek', args: { t: 1 }, timeoutMs: 15_000, initiatorPages: [{ pageId: 'bad page', live: true }] } },
    { request: { tool: 'seek', args: { t: 1 }, timeoutMs: 15_000, initiatorPages: [], pageId: 'page-x' } }, { request: { tool: 'seek', args: [], timeoutMs: 1, initiatorPages: [] } }])
    assert.throws(() => validateWorkerPageEnvelope(kit.envelope(bad)), { code: 'worker-page-envelope' }, JSON.stringify(bad).slice(0, 80));
});

test('WIRE-PAGE 鉴权通过:交给反向通道的运行上下文取自文档服务的回答;同一条连接上重放被拒', async () => {
  const kit = pageKit();
  const seen = [];
  const asked = [];
  const handler = createWorkerPageInternalHandler({ authorityId: 'doc-1', resolveWorker: async (input) => { asked.push(input); return kit.source(); },
    onRequest: async (callInput) => { seen.push(callInput); return { delivered: true, answer: { ok: true } }; } });
  const sock = kit.socket();
  const env = kit.envelope();
  const proof = kit.proofFor(env, sock);
  const ok = await kit.call(handler, { env, sock, proof });
  assert.deepEqual([ok.handled, ok.status, ok.body], [true, 200, { ok: true, result: { delivered: true, answer: { ok: true } } }]);
  assert.deepEqual(asked, [{ projectId: 'p1', runGrantId: 'g1', assignmentDigest: 'd'.repeat(64) }], '每个请求都现问文档服务');
  assert.deepEqual(seen[0].context, { projectId: 'p1', conversationId: 'c1', runId: 'r1', runGrantId: 'g1', instanceId: 'i1', instanceGeneration: 2, senderAccountId: 'account-initiator', messageId: 'm1' });
  assert.equal(Object.isFrozen(seen[0].context), true);
  assert.equal(seen[0].signal.aborted, false);
  // 同一条连接上原样再来一次:一次性随机数用过了
  const replay = await kit.call(handler, { env, sock, proof });
  assert.deepEqual([replay.status, replay.body.code], [403, 'worker-page-replay']);
  assert.equal(seen.length, 1);
});

test('WIRE-PAGE 一样不对都拒,而且不碰反向通道', async () => {
  const kit = pageKit();
  let reached = 0;
  const make = (resolveWorker) => createWorkerPageInternalHandler({ authorityId: 'doc-1', resolveWorker, onRequest: async () => { reached += 1; return {}; } });
  const good = make(async () => kit.source());
  const expectDenied = async (label, handler, options, status, code) => {
    const out = await kit.call(handler, options);
    assert.deepEqual([out.status, out.body?.code], [status, code], label);
  };
  await expectDenied('不是 POST', good, { method: 'GET' }, 405, 'method-not-allowed');
  await expectDenied('没有双向 TLS', good, { sock: kit.socket({ authorized: false }) }, 403, 'worker-page-peer');
  await expectDenied('经反向代理转来的', good, { headers: { 'x-forwarded-for': '10.0.0.1' } }, 403, 'worker-page-peer');
  await expectDenied('没带签名', good, { proof: null }, 403, 'worker-page-proof');
  // 证书不是文档服务说的那一张任务证书
  await expectDenied('别的证书', good, { sock: kit.socket({ getPeerCertificate: () => ({ fingerprint256: 'f'.repeat(64) }) }) }, 403, 'worker-page-peer');
  // 别的钥匙签的
  const stranger = generateKeyPairSync('ed25519');
  const env = kit.envelope();
  await expectDenied('别的钥匙签的', good, { env, proof: kit.proofFor(env, kit.socket(), { key: stranger.privateKey }) }, 403, 'worker-page-signature');
  // 签名是在另一条 TLS 连接上做的
  const otherChannel = kit.socket({ exportKeyingMaterial: () => Buffer.alloc(32, 9) });
  await expectDenied('换了连接', good, { env, sock: kit.socket(), proof: kit.proofFor(env, otherChannel) }, 403, 'worker-page-signature');
  // 签完以后改了请求体(工具换成别的)
  const tampered = kit.envelope({ request: { tool: 'play', args: {}, timeoutMs: 15_000, initiatorPages: [{ pageId: 'page-1', live: true }] } });
  await expectDenied('签完改了请求体', good, { env: tampered, proof: kit.proofFor(env, kit.socket()) }, 403, 'worker-page-signature');
  // 请求体里把项目、对话换成别的:文档服务回的那条任务对不上
  const wrongProject = kit.envelope({ binding: { ...kit.binding, conversationId: 'other-conversation' } });
  await expectDenied('对话对不上', good, { env: wrongProject }, 403, 'worker-page-source');
  await expectDenied('权威号对不上', good, { env: kit.envelope({ authorityId: 'doc-2' }) }, 403, 'worker-page-source');
  // 文档服务说这条任务已经被收回 / 不认;文档服务连不上
  await expectDenied('任务已被收回', make(async () => { throw Object.assign(new Error('run-revoked'), { status: 403, code: 'run-revoked' }); }), {}, 403, 'worker-page-source');
  await expectDenied('任务已结束', make(async () => kit.source({ runGrant: { ...kit.source().runGrant, state: 'finished' } })), {}, 403, 'worker-page-source');
  await expectDenied('换了一代进程', make(async () => kit.source({ runGrant: { ...kit.source().runGrant, instanceGeneration: 3 } })), {}, 403, 'worker-page-source');
  await expectDenied('文档服务连不上', make(async () => { throw Object.assign(new Error('down'), { status: 503 }); }), {}, 503, 'worker-page-authority-unavailable');
  assert.equal(reached, 0, '被拒的请求一个都没有到反向通道');
  // 别的路径不归它
  const other = await good(Object.assign((async function* () {})(), { url: '/internal/v2/worker/events/append', method: 'POST', headers: {}, socket: kit.socket() }), new EventEmitter());
  assert.equal(other, false);
});

test('WIRE-PAGE 任务进程把连接断掉:等待中的那一次收到取消信号', async () => {
  const kit = pageKit();
  let signal = null, release;
  const handler = createWorkerPageInternalHandler({ authorityId: 'doc-1', resolveWorker: async () => kit.source(),
    onRequest: ({ signal: s }) => { signal = s; return new Promise((resolve) => { release = resolve; }); } });
  const env = kit.envelope(), sock = kit.socket();
  const req = Object.assign((async function* () { yield Buffer.from(canonicalJson(env)); })(), { url: WORKER_PAGE_PATH, method: 'POST', socket: sock,
    headers: { [WORKER_PAGE_PROOF_HEADER]: kit.proofFor(env, sock) } });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } });
  const pending = handler(req, res);
  for (let i = 0; i < 50 && !signal; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal?.aborted, false);
  res.destroyed = true; res.emit('close');
  assert.equal(signal.aborted, true, '连接没了:取消信号触发,主服务据此把等待作废');
  release({ delivered: false, offline: true, why: 'run-cancelled', state: 'cancelled' });
  await pending;
  assert.equal(createHash('sha256').update('x').digest('hex').length, 64);
});
