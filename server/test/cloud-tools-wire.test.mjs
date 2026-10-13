/**
 * 0.7.18「云端 Agent 工具表接线」的单测(不起任何服务、不占端口)。
 * 跑:npm test -- server/test/cloud-tools-wire.test.mjs
 *
 *   WIRE-TABLE  工具表:没有提供者时逐项是原来的回答;这个进程里建出了提供者的才算可用、才交给模型;给模型看的那一段跟着变
 *   WIRE-JOBS   作业账本:重开时排着的、在跑的都标成被中断;`active` 只列这一轮名下没结束的;`pending` 只数数、不问文档服务
 *   WIRE-CONF   任务进程设置里的 `tools` 一节:只认列出的键;写了但路径不在就拒绝;root 入口用同一张名单,键写错在 root 启动时就拒绝
 *   WIRE-SET    一条任务的工具提供者(用替身搭,不起进程):账本打不开不拖垮对话;等后台作业时暂时性故障接着等、明确拒绝才停;
 *               浏览器数据的记号组内读得到、读不到不当成没有、由任务进程一侧照记号清;停止与关 Agent 留数据、转私有删、项目被删全删;代下缺省不开
 *   WIRE-USAGE  用量流水给同组的主服务读;读不到时报错,不拿零冒充
 *   WIRE-DEL    对话被删:记进待清的单子;任务用户一侧(任何一条任务的进程)照单子清掉浏览器目录、对话目录连同作业账本
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
import { ACCOUNT_TOOL_SETTING_KEYS, readAccountToolConfig, validateAccountToolSettings, createAccountToolset, accountToolStateDir, BROWSER_PURGE_MARK,
  readBrowserPurgeMarkIn, writeBrowserPurgeMark, removeMarkedBrowserData, TOOL_JOBS_BROKEN_TEXT, LOGIN_WITHOUT_DELEGATE_TEXT,
  CONVERSATION_PURGE_DIR, queueConversationPurge, listConversationPurges, purgeConversationData, conversationPurgeState } from '../agent/service/account-tools.mjs';
import { ACCOUNT_TOOL_SETTING_KEYS as SHARED_KEYS } from '../agent-service/account-tool-settings.mjs';
import { validateRootConfiguration } from '../agent-service/account-root-slots.mjs';
import { hostedBrowserDir } from '../agent/service/hosted-browser.mjs';
import { COLLECT_PAGE_TOOLS, COLLECT_BRIDGE_TEXT } from '../agent/service/collect-bridge.mjs';
import { queryUsage, createUsageLog } from '../agent/service/usage.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { createConversationPurger } from '../agent/service/conversation-purge.mjs';
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
  const all = cloudSystemNote({ look: true, provided: CLOUD_PROVIDER_TOOLS, collectDelegate: true });
  assert.match(all, /这一版在云端还没有:\*\* 自定义测量\(measure_audio_js\)。/);
  assert.doesNotMatch(all, /网页接管和扫码登录在云端做不了/);
  for (const phrase of ['语音识别、镜头识别、主体识别、运动追踪照常用', '一键流程(`auto_workflow`)在云端分五个阶段', '网页操作(`web_*`)在云节点的无头浏览器里做',
    '由他的电脑用本机的登录态代下', '登录信息只留在他的电脑上', '云端暂不支持开子 Agent', '素材的镜头拼图(`source: "media"`)云端还没有',
    // 等作业有上限、到点会中断;模板匹配兜底只在配了追踪的运行环境时成立
    '最多接着等一小时,到时还没做完的作业会被中断', '运动追踪要这台节点配了追踪的运行环境才能用', '配了运行环境但没装模型时走模板匹配兜底']) assert.ok(all.includes(phrase), phrase);
  // 代下缺省不开(部署配置没有显式打开):采集那一条仍说「不带登录态」,并说明登录那两个工具帮不了云端的下载;不说「由他的电脑代下」
  const plain = cloudSystemNote({ look: true, provided: CLOUD_PROVIDER_TOOLS });
  assert.ok(plain.includes('不带任何站点的登录态(按未登录的画质)'));
  assert.ok(plain.includes('云端的下载这一版用不到他电脑上的登录态'));
  assert.doesNotMatch(plain, /由他的电脑用本机的登录态代下/);
  assert.ok(plain.includes('站点登录(`collect_login`、`collect_login_check`)'), '登录那两个工具照常说可以请他本人处理');
  // 登录那一族没接上时,「代下开着」这个说法不起作用
  assert.doesNotMatch(cloudSystemNote({ look: false, provided: CLOUD_PROVIDER_FAMILIES.web, collectDelegate: true }), /代下|用不到他电脑上的登录态/);
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
  assert.deepEqual([await jobs.pending(CONTEXT), await jobs.pending(other), await jobs.pending({ ...CONTEXT, runGrantId: 'g9', runId: 'r9', messageId: 'm9' })], [2, 1, 0]);
  await jobs.close();

  jobs = openJobs(file);
  for (const id of [queued.jobId, running.jobId]) {
    const row = await jobs.get(CONTEXT, id);
    assert.deepEqual([row.state, row.errorCode], ['interrupted', 'INTERRUPTED_ON_RESTART'], '排着的和在跑的都如实标成被中断');
  }
  assert.equal((await jobs.get(CONTEXT, done.jobId)).state, 'done');
  assert.deepEqual(await jobs.active(CONTEXT), []);
  assert.equal(await jobs.pending(CONTEXT), 0);
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

/* ---------- 一条任务的工具提供者:账本、等作业、浏览器数据的去留、代下的开关 ---------- */

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`等不到:${what}`); await sleep(5); } };

/** 用替身搭一份工具提供者(不起任何进程、不连任何服务)。`authorize` 可换:等作业那几条用它演文档服务的各种回答 */
async function toolsetKit(t, { authorize = async () => ({ allowed: true, fenceRevision: 3, grantState: 'active' }), limits = {}, config = {}, pageBridge = null, prepare = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-set-'));
  const log = [];
  const resources = { authorize: (...a) => authorize(...a), register: async () => ({ signal: new AbortController().signal, closed: Promise.resolve() }),
    contextAccess: { authorize: (...a) => authorize(...a), fromGrant: () => CONTEXT }, signalFor: () => null };
  prepare?.(dataDir);
  const toolset = await createAccountToolset({ root: REPO_ROOT, dataDir, context: CONTEXT, resources,
    projectAssets: { openRead: async () => { throw new Error('no-assets'); }, verifyRef: async () => false }, workspaces: { open: () => ({}) }, ownerKey: 'owner',
    egress: { admit: async () => {}, admitUrl: async () => {} }, exec: () => ({ snapshot: async () => ({ project: {}, rev: 1 }), mutate: async () => ({}) }),
    host: async () => ({ kernel: {} }), config, pageBridge, limits, log: (event, fields) => log.push({ event, ...fields }) });
  // 收尾的次序:先关测试自己另开的东西(同一个账本文件的第二个连接),再收工具提供者,最后删目录
  const closers = [];
  t.after(async () => { for (const closer of closers.reverse()) await Promise.resolve().then(closer).catch(() => {});
    await toolset.close('test-end').catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { dataDir, toolset, log, events: (name) => log.filter((row) => row.event === name), onCleanup: (closer) => closers.push(closer) };
}
const browserDirOf = (dataDir, conversationId, projectId = 'p1') => hostedBrowserDir(dataDir, { projectId, conversationId });
const seedBrowser = (dataDir, conversationId, { mark = null, projectId = 'p1' } = {}) => {
  const dir = browserDirOf(dataDir, conversationId, projectId);
  fs.mkdirSync(path.join(dir, 'profile', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'Default', 'Cookies'), 'login-state');
  fs.writeFileSync(path.join(dir, 'rev'), '7');
  if (mark) writeBrowserPurgeMark(dir, mark);
  return dir;
};
const listing = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return null; } };

test('WIRE-SET 作业账本打不开:不拖垮这条任务;用到作业的工具回一句明确的话,网页操作照常,收尾干净', async (t) => {
  const kit = await toolsetKit(t, { prepare: (dataDir) => {
    // 账本的位置上放一个目录:数据库打不开
    fs.mkdirSync(path.join(accountToolStateDir(dataDir, 'p1', 'c1'), 'tool-jobs.db'), { recursive: true });
  } });
  assert.equal(kit.toolset.describe().ledger, false);
  assert.equal(kit.events('agent.account-tools.ledger-broken').length, 1, '日志里记了账本打不开');
  for (const tool of ['stt_status', 'transcribe_media', 'track_points', 'attach_clip_motion', 'detect_shots', 'detect_subjects', 'auto_workflow', 'background_job_status']) {
    assert.equal(kit.toolset.handles(tool), true, `${tool} 仍然算接上(由替身答)`);
    const out = await kit.toolset.call(tool, {}, { callId: `call-${tool}-0001` });
    assert.deepEqual([out.ok, out.cloudUnavailable, out.code, out.error], [false, true, 'TOOL_JOBS_UNAVAILABLE', TOOL_JOBS_BROKEN_TEXT], tool);
  }
  // 不用作业的那一族照常:浏览器没配,答的是它自己的话
  const view = await kit.toolset.call('web_view', {}, { callId: 'call-web-view-0001' });
  assert.notEqual(view?.code, 'TOOL_JOBS_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(view), /后台作业记录/);
  assert.deepEqual(await kit.toolset.settle(), { waited: true, pending: 0 }, '没有账本就没有要等的作业');
  const closed = await kit.toolset.close('run-drained');
  assert.deepEqual([closed.childrenClosed, closed.streamsClosed, closed.workPending], [true, true, 0]);
});

/** 往这份工具提供者的账本里放一条这一轮名下还在跑的作业(另开一个连接写;同一个文件) */
async function seedRunningJob(kit) {
  const jobs = createToolJobs({ databasePath: path.join(accountToolStateDir(kit.dataDir, 'p1', 'c1'), 'tool-jobs.db'),
    authorize: async () => ({ allowed: true, fenceRevision: 3, grantState: 'active' }), verifyFence: async (_c, rev) => rev === 3 });
  const job = await jobs.start(CONTEXT, 'shots.detect', 'a'.repeat(64), 'request-settle-01');
  await jobs.update(CONTEXT, job.jobId, 0, { state: 'running', progress: 0.1 });
  kit.onCleanup(() => jobs.close());
  return { jobs, finish: () => jobs.update(CONTEXT, job.jobId, 1, { state: 'done', progress: 1 }) };
}
const FAST = { settlePollMs: 5, settleAuthMs: 10, settleAuthBackoffMs: [5, 10] };

test('WIRE-SET 等后台作业:文档服务一时答不上不算拒绝,接着等、隔一会儿再核;作业做完才往下收', async (t) => {
  let mode = 'ok', asked = 0;
  const kit = await toolsetKit(t, { limits: FAST, authorize: async () => {
    asked += 1;
    if (mode === 'down') throw Object.assign(new Error('doc service unreachable'), { code: 'run-authority-unavailable' });
    return { allowed: true, fenceRevision: 3, grantState: 'active' };
  } });
  const seeded = await seedRunningJob(kit);
  mode = 'down';
  let settled = null;
  const waiting = kit.toolset.settle().then((out) => { settled = out; });
  // 文档服务连着答不上好几次:一直在等,没有把这一轮当成「不算数」
  await until(() => kit.events('agent.account-tools.settle-auth-retry').length >= 3, '核授权重试了几次');
  assert.equal(settled, null, '暂时性故障不停止等待');
  assert.deepEqual(kit.events('agent.account-tools.settle-auth-retry').slice(0, 3).map((row) => row.retryInMs), [5, 10, 10], '重试的间隔一次比一次久,到头不再涨');
  assert.equal(kit.events('agent.account-tools.settle-revoked').length, 0);
  mode = 'ok';
  await seeded.finish();
  await waiting;
  assert.deepEqual(settled, { waited: true, pending: 0 });
});

test('WIRE-SET 等后台作业:文档服务明确说这一轮不算数了才停;叫停信号、兜底时限也停', async (t) => {
  // 明确的拒绝(抛出来的)
  let denied = false;
  const a = await toolsetKit(t, { limits: FAST, authorize: async () => {
    if (denied) throw Object.assign(new Error('revoked'), { code: 'run-access-denied' });
    return { allowed: true, fenceRevision: 3, grantState: 'active' };
  } });
  await seedRunningJob(a);
  denied = true;
  assert.deepEqual(await a.toolset.settle(), { waited: false, reason: 'unauthorized', pending: 1 });
  assert.equal(a.events('agent.account-tools.settle-revoked').length, 1);

  // 明确的拒绝(回答里写着不允许)
  let allowed = true;
  const b = await toolsetKit(t, { limits: FAST, authorize: async () => ({ allowed, fenceRevision: 3, grantState: allowed ? 'active' : 'finished' }) });
  await seedRunningJob(b);
  allowed = false;
  assert.equal((await b.toolset.settle()).reason, 'unauthorized');

  // 叫停信号:马上不等了(不用等到下一次数账本)
  const c = await toolsetKit(t, { limits: { ...FAST, settlePollMs: 60_000, settleAuthMs: 60_000 } });
  await seedRunningJob(c);
  const stop = new AbortController();
  const stopped = c.toolset.settle(stop.signal);
  stop.abort();
  assert.deepEqual(await stopped, { waited: false, reason: 'cancelled' });
  // 等到一半(已经睡下去了)再叫停:同样马上醒
  const c2 = await toolsetKit(t, { limits: { ...FAST, settlePollMs: 60_000, settleAuthMs: 60_000 } });
  await seedRunningJob(c2);
  const stop2 = new AbortController();
  const stopped2 = c2.toolset.settle(stop2.signal);
  await sleep(20);
  stop2.abort();
  assert.deepEqual(await stopped2, { waited: false, reason: 'cancelled' });

  // 兜底时限
  const d = await toolsetKit(t, { limits: { ...FAST, settleMs: 1, settleAuthMs: 60_000 } });
  await seedRunningJob(d);
  assert.deepEqual(await d.toolset.settle(), { waited: false, reason: 'timeout', pending: 1 });
  assert.equal(d.events('agent.account-tools.settle-timeout').length, 1);
});

test('WIRE-SET 浏览器数据的记号:组内读得到;读不到、读不懂不当成「没有记号」;照记号清时记号最后撤', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-mark-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const make = (name) => { const d = path.join(dir, name); fs.mkdirSync(path.join(d, 'profile', 'Default'), { recursive: true }); fs.writeFileSync(path.join(d, 'profile', 'Default', 'Cookies'), 'x'); fs.writeFileSync(path.join(d, 'rev'), '3'); return d; };
  const plain = make('plain');
  assert.equal(readBrowserPurgeMarkIn(plain), null, '没有记号');
  assert.equal(readBrowserPurgeMarkIn(path.join(dir, 'no-such-dir')), null, '目录都没有也是没有记号');
  writeBrowserPurgeMark(plain, 'private', 123);
  assert.deepEqual(readBrowserPurgeMarkIn(plain), { reason: 'private', at: 123 });
  assert.deepEqual(listing(plain), ['profile', BROWSER_PURGE_MARK, 'rev'].sort(), '没有留下临时文件');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(plain, BROWSER_PURGE_MARK)).mode & 0o060, 0o060, '记号组内可读写(主服务写、任务用户读)');
  // 读不懂
  const garbled = make('garbled');
  fs.writeFileSync(path.join(garbled, BROWSER_PURGE_MARK), '{"reason":');
  assert.deepEqual(readBrowserPurgeMarkIn(garbled), { reason: 'private', unreadable: true, code: 'bad-mark' });
  // 读不到(这里用「记号的位置上是个目录」来演;生产上是别的用户按 0600 写的文件)
  const blocked = make('blocked');
  fs.mkdirSync(path.join(blocked, BROWSER_PURGE_MARK));
  const unreadable = readBrowserPurgeMarkIn(blocked);
  assert.deepEqual([unreadable.reason, unreadable.unreadable, typeof unreadable.code], ['private', true, 'string']);

  // 照记号清:留清单版本的计数,记号也撤了
  assert.equal(await removeMarkedBrowserData(plain), true);
  assert.deepEqual(listing(plain), ['rev']);
  assert.equal(await removeMarkedBrowserData(blocked), true, '读不到的记号一样清得掉');
  assert.deepEqual(listing(blocked), ['rev']);
  // 对话或项目没了:整个目录都删
  const gone = make('gone');
  writeBrowserPurgeMark(gone, 'conversation-deleted');
  assert.equal(await removeMarkedBrowserData(gone, { all: true }), true);
  assert.equal(listing(gone), null);
  // 记号已经没了(别的进程清完了):不去删它之后新建的东西
  const fresh = make('fresh');
  assert.equal(await removeMarkedBrowserData(fresh), true);
  assert.deepEqual(listing(fresh), ['profile', 'rev']);
});

test('WIRE-SET 浏览器数据的记号:有删不动的东西时记号留着,下次接着清', { skip: process.platform === 'win32' ? '要靠目录权限演「删不动」,Windows 上演不出;Linux 上两个用户之间的真情形由 scripts/probes/account-tools-perms-linux.mjs 验' : process.getuid?.() === 0 ? 'root 不受目录权限限制,演不出「删不动」' : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-stuck-'));
  const locked = path.join(dir, 'conv', 'profile', 'Default');
  t.after(() => { try { fs.chmodSync(locked, 0o700); } catch { /* 已经没了 */ } fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'Cookies'), 'x');
  fs.writeFileSync(path.join(dir, 'conv', 'rev'), '3');
  writeBrowserPurgeMark(path.join(dir, 'conv'), 'private');
  fs.chmodSync(locked, 0o500);   // 里面的文件删不掉
  assert.equal(await removeMarkedBrowserData(path.join(dir, 'conv'), { timeoutMs: 200 }), false);
  assert.ok(listing(path.join(dir, 'conv')).includes(BROWSER_PURGE_MARK), '没清干净:记号还在');
  fs.chmodSync(locked, 0o700);
  assert.equal(await removeMarkedBrowserData(path.join(dir, 'conv')), true);
  assert.deepEqual(listing(path.join(dir, 'conv')), ['rev']);
});

test('WIRE-SET 任务进程一侧照记号清:自己这个对话开工前清;别的对话留着记号的也顺手清;没有记号的不动', async (t) => {
  let dirs = null;
  const kit = await toolsetKit(t, { prepare: (dataDir) => {
    dirs = { own: seedBrowser(dataDir, 'c1', { mark: 'private' }), otherPrivate: seedBrowser(dataDir, 'c2', { mark: 'private' }),
      otherDeleted: seedBrowser(dataDir, 'c3', { mark: 'conversation-deleted' }), otherProject: seedBrowser(dataDir, 'c9', { mark: 'project-deleted', projectId: 'p2' }),
      kept: seedBrowser(dataDir, 'c4') };
    // 一个读不到的记号(演主服务按别的权限写的那种):也要清,并记一行日志
    dirs.blocked = seedBrowser(dataDir, 'c5');
    fs.mkdirSync(path.join(dirs.blocked, BROWSER_PURGE_MARK));
  } });
  assert.deepEqual(listing(dirs.own), ['rev'], '自己这个对话:建好之前就清了,只剩清单版本的计数');
  assert.equal(kit.events('agent.account-tools.browser-purged').length, 1);
  // 顺手清的那一趟不挡这条任务,在后面做:等它做完
  await until(() => kit.events('agent.account-tools.browser-swept').length > 0, '顺手清的那一趟做完');
  assert.deepEqual(listing(dirs.otherPrivate), ['rev']);
  assert.equal(listing(dirs.otherDeleted), null, '对话被删:整个目录没了');
  assert.equal(listing(dirs.otherProject), null, '别的项目的也一样(都是任务用户的文件)');
  assert.deepEqual(listing(dirs.blocked), ['rev']);
  assert.deepEqual(listing(dirs.kept), ['profile', 'rev'], '没有记号的不动');
  const swept = kit.events('agent.account-tools.browser-swept')[0];
  assert.deepEqual([swept.marked, swept.removed, swept.unreadable], [4, 4, 1]);
});

test('WIRE-SET 被叫停时浏览器数据的去留:停止、Agent 被关留着;对话转私有删(留计数);项目被删全删', async (t) => {
  const run = async (kind) => {
    let dir = null;
    const kit = await toolsetKit(t, { prepare: (dataDir) => { dir = seedBrowser(dataDir, 'c1'); } });
    const out = await kit.toolset.fence({ kind });
    return { left: listing(dir), browser: out.browser, fenced: kit.events('agent.account-tools.fenced')[0] };
  };
  assert.deepEqual((await run('stop')).left, ['profile', 'rev']);
  const off = await run('agent-disabled');
  assert.deepEqual(off.left, ['profile', 'rev'], '创建者关掉云端 Agent:浏览器进程关掉,数据留着(登录态还在)');
  assert.equal(off.browser.profileRemoved, false);
  assert.deepEqual((await run('private')).left, ['rev']);
  assert.equal((await run('delete')).left, null);
});

test('WIRE-SET 代下缺省不开:只交登录那两样,回给模型的话不许诺「之后由他的电脑代下」;部署配置显式打开才交代下', async (t) => {
  const asked = [];
  const bridge = () => ({ limits: { pageMs: 15_000 }, extraTools: [...COLLECT_PAGE_TOOLS], cancelRun: () => 0, close: async () => ({ childrenClosed: true, streamsClosed: true, workPending: 0 }),
    initiator: async () => ({ initiatorAccountId: 'a1', pageId: 'page-1', grantState: 'active' }),
    requestPage: async ({ tool }) => { asked.push(tool); return { delivered: true, answer: { ok: true, result: tool === 'collect_login' ? { opened: false, alreadyLoggedIn: true } : { loggedIn: true } } }; } });
  const off = await toolsetKit(t, { pageBridge: bridge() });
  assert.equal(off.toolset.delegateDownload(), false);
  assert.equal(off.toolset.describe().delegateDownload, false);
  const login = off.toolset.collectDelegate();
  assert.deepEqual(Object.keys(login).sort(), ['login', 'loginCheck'], '没有 download:采集那一侧照旧只在云端匿名下载');
  assert.equal((await login.login({ site: 'bilibili' })).hint, LOGIN_WITHOUT_DELEGATE_TEXT.already);
  assert.equal((await login.loginCheck({ site: 'bilibili' })).hint, LOGIN_WITHOUT_DELEGATE_TEXT.checked);
  for (const text of Object.values(LOGIN_WITHOUT_DELEGATE_TEXT)) assert.doesNotMatch(text, /会由他的电脑带着登录态下载/);
  assert.deepEqual(asked, ['collect_login', 'collect_login_check'], '登录那两样照常经反向通道到发起人的页面');

  const on = await toolsetKit(t, { pageBridge: bridge(), config: { collectDelegate: true } });
  assert.equal(on.toolset.delegateDownload(), true);
  const full = on.toolset.collectDelegate();
  assert.equal(typeof full.download, 'function');
  assert.equal((await full.loginCheck({ site: 'bilibili' })).hint, COLLECT_BRIDGE_TEXT.loginChecked, '开了代下:原来那句话成立,不改');
  // 没有内部通道(没有反向通道)的进程:两样都没有
  const none = await toolsetKit(t, { config: { collectDelegate: true } });
  assert.equal(none.toolset.collectDelegate(), null);
  assert.equal(none.toolset.delegateDownload(), false);
});

/* ---------- 用量流水:任务进程写、主服务读 ---------- */

test('WIRE-USAGE 流水读不到时不拿零冒充:明确报错;目录还没有才是「确实没有」;成员查用量得到 503', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const usageDir = path.join(dir, 'usage');
  // 目录还没有(这台节点还没有任务进程起来过):确实没有流水
  assert.deepEqual(queryUsage(usageDir, { projectId: 'p1', strict: true }).projects, {});
  // 任务进程按「给同组的主服务读」建:写一行,主服务一侧读得到
  const usage = createUsageLog({ dir: usageDir, shared: true, flushMs: 3_600_000 });
  t.after(() => usage.close());
  usage.append({ t: Date.now(), projectId: 'p1', userId: 'a1', username: '甲', conversationId: 'c1', runId: 'r1', kind: 'service', service: 'web', vendor: 'chromium', model: 'web_open', units: 1, unit: 'calls', ok: true, ms: 5 });
  assert.equal(queryUsage(usageDir, { projectId: 'p1', strict: true }).projects.p1.services['web/chromium'].calls, 1);
  if (process.platform !== 'win32') {
    const month = fs.readdirSync(usageDir).find((name) => name.endsWith('.jsonl'));
    assert.equal(fs.statSync(usageDir).mode & 0o050, 0o050, '目录组内可读可进');
    assert.equal(fs.statSync(path.join(usageDir, month)).mode & 0o040, 0o040, '流水组内可读');
    assert.equal(fs.statSync(usageDir).mode & 0o007, 0, '组外的人仍然读不到');
  }
  // 流水在但读不了(这里用「流水的位置上是个目录」来演;生产上是别的用户按 0600 写的文件、0700 的目录)
  fs.mkdirSync(path.join(usageDir, '1999-01.jsonl'));
  assert.throws(() => queryUsage(usageDir, { projectId: 'p1', strict: true }), { code: 'usage-unreadable' });
  assert.equal(queryUsage(usageDir, { projectId: 'p1' }).projects.p1.services['web/chromium'].calls, 1, '不带 strict 的老用法(托管档、命令行)不变:跳过读不了的');
  // 目录本身列不了(位置上是个文件)
  const notDir = path.join(dir, 'usage-file');
  fs.writeFileSync(notDir, 'x');
  assert.throws(() => queryUsage(notDir, { strict: true }), { code: 'usage-unreadable' });
  assert.deepEqual(queryUsage(notDir, {}).projects, {});

  // 成员经主服务查用量:读不到是 503 usage-unavailable,不是 200 加全零
  const client = Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map((name) => [name, async () => ({ access: 'rw' })]));
  const service = createAccountConversationService({ usageDir, conversationClient: client });
  await assert.rejects(service.usage({ accountMode: true, accountId: 'a1', projectId: 'p1', delegation: 'ticket' }), (error) => {
    assert.deepEqual([error.code, error.status, typeof error.errno], ['usage-unavailable', 503, 'string']);
    return true;
  });
  fs.rmdirSync(path.join(usageDir, '1999-01.jsonl'));
  const ok = await service.usage({ accountMode: true, accountId: 'a1', projectId: 'p1', delegation: 'ticket' });
  assert.deepEqual(ok.services.map((row) => [row.service, row.calls]), [['web', 1]]);
});

test('WIRE-USAGE 以前按 0700 / 0600 建的目录和流水:任务进程起来时补成组内可读', { skip: process.platform === 'win32' ? 'Windows 没有这一套权限位;Linux 上两个用户之间的真情形由 scripts/probes/account-tools-perms-linux.mjs 验' : false }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-usage-old-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usageDir = path.join(dir, 'usage');
  fs.mkdirSync(usageDir, { mode: 0o700 });
  fs.writeFileSync(path.join(usageDir, '2026-09.jsonl'), '', { mode: 0o600 });
  fs.chmodSync(usageDir, 0o700); fs.chmodSync(path.join(usageDir, '2026-09.jsonl'), 0o600);
  const usage = createUsageLog({ dir: usageDir, shared: true, flushMs: 3_600_000 });
  t.after(() => usage.close());
  assert.equal(fs.statSync(usageDir).mode & 0o777, 0o750);
  assert.equal(fs.statSync(path.join(usageDir, '2026-09.jsonl')).mode & 0o777, 0o640);
  // 不给 shared(旧托管档:写和读是同一个用户)照旧只有自己读得到
  const own = path.join(dir, 'own');
  const alone = createUsageLog({ dir: own, flushMs: 3_600_000 });
  t.after(() => alone.close());
  alone.append({ t: Date.now(), projectId: 'p1', userId: 'a1', vendor: 'mock', model: 'm', input: 1, output: 1, ok: true, ms: 1 });
  assert.equal(fs.statSync(own).mode & 0o077, 0);
});

/* ---------- root 入口与任务进程用同一张名单核 tools 一节 ---------- */

test('WIRE-CONF root 入口:tools 里的键写错、值不对,启动时就拒绝并指出是哪个键;和任务进程认的是同一张名单', () => {
  const abs = (p) => `/pc/${p}`;
  const config = (tools) => ({ v: 1, master: { origin: 'https://127.0.0.1:1/', fingerprint256: 'a'.repeat(64) }, controller: { keyFile: abs('k'), certFile: abs('c'), caFile: abs('ca') },
    worker: { doc: { origin: 'https://127.0.0.1:2/', fingerprint256: 'b'.repeat(64), keyFile: abs('k'), certFile: abs('c'), caFile: abs('ca') }, dataDir: abs('data'), stateRoot: abs('state'), tools },
    slots: [{}] });
  const rejected = (tools) => { try { validateRootConfiguration(config(tools)); } catch (error) { return error; } return null; };
  // 形状像、但不在名单上的键(以前 root 只按 PROMPTCUT_ 开头的模式收,这种会放过去,然后每一代任务进程都拒绝启动)
  const typo = rejected({ PROMPTCUT_AGENT_BROWSR: '/usr/bin/chromium' });
  assert.deepEqual([typo?.code, typo?.key], ['root-configuration-worker-tools', 'PROMPTCUT_AGENT_BROWSR']);
  assert.match(typo.detail, /PROMPTCUT_AGENT_BROWSR/);
  assert.deepEqual([rejected({ PROMPTCUT_FFMPEG: '' })?.code, rejected({ PROMPTCUT_FFMPEG: '' })?.key], ['root-configuration-worker-tools', 'PROMPTCUT_FFMPEG']);
  assert.equal(rejected({ PROMPTCUT_AGENT_COLLECT_DELEGATE: 'yes' })?.key, 'PROMPTCUT_AGENT_COLLECT_DELEGATE');
  assert.equal(rejected({ PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES: 'shots,nope' })?.key, 'PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES');
  assert.equal(rejected(null)?.code, 'root-configuration-worker-tools');
  assert.equal(rejected(['x'])?.code, 'root-configuration-worker-tools');
  // 名单上的键 root 都收(这一节过了以后,后面核的是槽,这里给的是空槽,所以停在槽那一步——不是 tools)
  const all = Object.fromEntries(ACCOUNT_TOOL_SETTING_KEYS.map((key) => [key, key === 'PROMPTCUT_AGENT_COLLECT_DELEGATE' ? '1' : key === 'PROMPTCUT_AGENT_WORKFLOW_OPTIONAL_STAGES' ? 'shots,prerender' : '/opt/x']));
  assert.notEqual(rejected(all)?.code, 'root-configuration-worker-tools');
  // 两处是同一张名单:任务进程不认的键 root 一定不认,反过来也是
  for (const key of ACCOUNT_TOOL_SETTING_KEYS) assert.deepEqual(Object.keys(validateAccountToolSettings({ [key]: all[key] })), [key]);
  assert.equal(SHARED_KEYS, ACCOUNT_TOOL_SETTING_KEYS, 'account-tools.mjs 转出的就是 account-tool-settings.mjs 的那一张');
  // 代下的开关:缺省关
  assert.equal(readAccountToolConfig({}, { root: REPO_ROOT }).collectDelegate, false);
  assert.equal(readAccountToolConfig({ PROMPTCUT_AGENT_COLLECT_DELEGATE: '0' }, { root: REPO_ROOT }).collectDelegate, false);
  assert.equal(readAccountToolConfig({ PROMPTCUT_AGENT_COLLECT_DELEGATE: '1' }, { root: REPO_ROOT }).collectDelegate, true);
});

/* ---------- 对话被删:待清的单子,任务用户一侧照单子清 ---------- */

/** 一个被删的对话在共用数据目录里留着的东西:浏览器目录,和对话目录(模型历史、`tools/` 下的作业账本) */
function seedDeletedConversation(dataDir, conversationId, projectId = 'p1') {
  const browser = seedBrowser(dataDir, conversationId, { projectId });
  const conversation = path.join(dataDir, 'tenants', projectId, 'conversations', conversationId);
  fs.mkdirSync(path.join(conversation, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(conversation, 'history.json'), '[]');
  fs.writeFileSync(path.join(conversation, 'tools', 'tool-jobs.db'), 'ledger');
  return { browser, conversation, entry: () => listConversationPurges(dataDir).find((row) => row.conversationId === conversationId && row.projectId === projectId) ?? null };
}

test('WIRE-DEL 对话被删:记进待清的单子;照单子清掉浏览器目录和对话目录(连同作业账本),清完从单子上划掉;再来一遍不报错', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-del-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.deepEqual(listConversationPurges(dataDir), [], '单子还没有:空的');
  const gone = seedDeletedConversation(dataDir, 'c7');
  const kept = seedDeletedConversation(dataDir, 'c8');
  queueConversationPurge(dataDir, { projectId: 'p1', conversationId: 'c7' }, 5);
  queueConversationPurge(dataDir, { projectId: 'p1', conversationId: 'c7' }, 6);   // 重复删:只是覆盖
  assert.deepEqual(listConversationPurges(dataDir), [{ projectId: 'p1', conversationId: 'c7' }]);
  if (process.platform !== 'win32') {
    const file = path.join(dataDir, CONVERSATION_PURGE_DIR, fs.readdirSync(path.join(dataDir, CONVERSATION_PURGE_DIR))[0]);
    assert.equal(fs.statSync(file).mode & 0o060, 0o060, '单子上的条目组内可读写(主服务写、任务用户读并划掉)');
  }
  for (const bad of [{ projectId: '..', conversationId: 'c7' }, { projectId: 'p1', conversationId: 'a/b' }, { projectId: 'p1' }, null])
    assert.throws(() => queueConversationPurge(dataDir, bad), { code: 'conversation-purge-invalid' }, JSON.stringify(bad));
  assert.deepEqual(await purgeConversationData(dataDir, { projectId: 'p1', conversationId: 'c7' }), { removed: true, held: false, history: true, workspace: false, browser: true });
  assert.deepEqual([fs.existsSync(gone.browser), fs.existsSync(gone.conversation), gone.entry()], [false, false, null], '浏览器目录、对话目录(连同作业账本)都没了,单子上也划掉了');
  assert.deepEqual([fs.existsSync(kept.browser), fs.existsSync(path.join(kept.conversation, 'tools', 'tool-jobs.db'))], [true, true], '别的对话不动');
  assert.deepEqual(await purgeConversationData(dataDir, { projectId: 'p1', conversationId: 'c7' }), { removed: true, held: false, history: false, workspace: false, browser: false }, '再来一遍:什么都不剩,不报错');
  await assert.rejects(purgeConversationData(dataDir, { projectId: 'p1', conversationId: '../x' }), { code: 'conversation-purge-invalid' });
  // 单子里混进读不懂的、文件名和内容对不上的条目:照实标出来,不照着它去删东西
  fs.writeFileSync(path.join(dataDir, CONVERSATION_PURGE_DIR, `${'0'.repeat(40)}.json`), '{"projectId":');
  fs.writeFileSync(path.join(dataDir, CONVERSATION_PURGE_DIR, `${'1'.repeat(40)}.json`), JSON.stringify({ projectId: 'p1', conversationId: 'c8' }));
  assert.deepEqual(listConversationPurges(dataDir), [{ unreadable: true, code: 'bad-entry' }, { unreadable: true, code: 'bad-entry' }]);
  assert.equal(fs.existsSync(kept.browser), true);
});

test('WIRE-DEL 任务进程开工时照单子清:被删的对话再也没有任务,它留下的东西也由别的对话的任务进程清掉', async (t) => {
  let seeded = null;
  const kit = await toolsetKit(t, { prepare: (dataDir) => {
    seeded = { deleted: seedDeletedConversation(dataDir, 'c7'), otherProject: seedDeletedConversation(dataDir, 'c9', 'p2'), alive: seedDeletedConversation(dataDir, 'c8') };
    queueConversationPurge(dataDir, { projectId: 'p1', conversationId: 'c7' });
    queueConversationPurge(dataDir, { projectId: 'p2', conversationId: 'c9' });
  } });
  await until(() => kit.events('agent.account-tools.browser-swept').length > 0, '顺手清的那一趟做完');
  for (const row of [seeded.deleted, seeded.otherProject]) assert.deepEqual([fs.existsSync(row.browser), fs.existsSync(row.conversation), row.entry()], [false, false, null]);
  // 任务用户一侧清完,单子上那一条换成回执:主服务(够不到这些目录)凭它才向文档服务确认
  assert.deepEqual([conversationPurgeState(kit.dataDir, { projectId: 'p1', conversationId: 'c7' }), conversationPurgeState(kit.dataDir, { projectId: 'p2', conversationId: 'c9' }),
    conversationPurgeState(kit.dataDir, { projectId: 'p1', conversationId: 'c8' })], ['done', 'done', 'none']);
  assert.deepEqual([fs.existsSync(seeded.alive.browser), fs.existsSync(seeded.alive.conversation)], [true, true], '没被删的对话不动');
  const swept = kit.events('agent.account-tools.browser-swept')[0];
  assert.deepEqual([swept.conversations, swept.conversationsRemoved], [2, 2]);
  assert.deepEqual(listConversationPurges(kit.dataDir), []);
});

/* ---------- 删对话:主服务删不动任务用户的目录时(两个用户的生产) ---------- */

/**
 * 演「这一方没有权限删」:把 `fs.rmSync` 换成对指定目录一律抛 EACCES 的桩(别的路径照常)。
 * 生产上是主服务去删任务用户 0700 的目录;两个用户之间的真情形由 scripts/probes/account-tools-perms-linux.mjs 在 Linux 上验。
 */
function denyDeletesUnder(t, roots) {
  const real = fs.rmSync;
  let denied = 0;
  fs.rmSync = (target, options) => {
    if (roots.some((root) => String(target) === root || String(target).startsWith(root + path.sep))) { denied += 1; throw Object.assign(new Error(`EACCES: permission denied, rm '${target}'`), { code: 'EACCES' }); }
    return real(target, options);
  };
  const restore = () => { fs.rmSync = real; };
  t.after(restore);
  return { restore, count: () => denied };
}

test('WIRE-DEL 删不动(没有权限)时:清理的那几步都会有结果(不悬着),如实回「没清掉」,记号和单子上那一条都还在', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-deny-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const seeded = seedDeletedConversation(dataDir, 'c7');
  writeBrowserPurgeMark(seeded.browser, 'conversation-deleted');
  queueConversationPurge(dataDir, { projectId: 'p1', conversationId: 'c7' });
  const deny = denyDeletesUnder(t, [seeded.browser, seeded.conversation]);
  // 每一步都限时:悬着不回就是毛病(主服务会有一个请求永远挂着)
  const settled = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} 一直没有结果`)), 15_000))]);
  assert.equal(await settled(removeMarkedBrowserData(seeded.browser, { all: true, timeoutMs: 300 }), '照记号清'), false);
  assert.ok(listing(seeded.browser).includes(BROWSER_PURGE_MARK), '没清干净:记号还在');
  const out = await settled(purgeConversationData(dataDir, { projectId: 'p1', conversationId: 'c7' }, { timeoutMs: 300 }), '照单子清');
  assert.deepEqual([out.removed, out.held], [false, false]);
  assert.ok(deny.count() >= 2, '确实是删的时候被拒的');
  assert.equal(conversationPurgeState(dataDir, { projectId: 'p1', conversationId: 'c7' }), 'queued', '没清掉:单子上那一条还在,也没有留回执');
  assert.equal(fs.existsSync(path.join(seeded.conversation, 'tools', 'tool-jobs.db')), true);
  // 权限恢复(换成删得动的那一方)以后照样清得掉
  deny.restore();
  assert.equal((await purgeConversationData(dataDir, { projectId: 'p1', conversationId: 'c7' }, { receipt: true })).removed, true);
  assert.equal(conversationPurgeState(dataDir, { projectId: 'p1', conversationId: 'c7' }), 'done');
});

test('WIRE-DEL 删对话的整套(主服务删不动任务用户的目录):这次删除照样办完、不回 503;清完自己的库、其余记进单子;任务用户一侧清完留回执,对账那一轮才回执', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-delflow-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const seeded = seedDeletedConversation(dataDir, 'c7');
  const work = path.join(dataDir, 'work', 'p1', 'ownerkey00000001', 'c7');
  fs.mkdirSync(path.join(work, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(work, 'attachments', 'a.txt'), 'x');
  const deny = denyDeletesUnder(t, [seeded.browser, seeded.conversation, work]);
  // 文档服务的替身:删掉以后墓碑上记着「Agent 一侧还没确认清理」,回执了才不再列
  const unpurged = new Set();
  const acks = [];
  const client = { ...Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map((name) => [name, async () => ({ access: 'rw' })])),
    remove: async ({ conversationId }) => { unpurged.add(conversationId); return { removed: [conversationId] }; },
    purges: async () => [...unpurged].map((conversationId) => ({ projectId: 'p1', conversationId })),
    purgeAck: async ({ conversationId }) => { acks.push(conversationId); unpurged.delete(conversationId); } };
  const ownStore = [];   // 主服务自己的库(事件库):当场清
  const log = [];
  const seam = [];
  const service = createAccountConversationService({ conversationClient: client, sleep: async () => {},
    purger: createConversationPurger({ sharedDataDir: dataDir, timeoutMs: 100, log: (event, fields) => log.push({ event, ...fields }),
      eventStore: { purgeConversation: async (scope) => { ownStore.push(scope.conversationId); return { rows: 3 }; } } }),
    onConversationDeleted: async (scope) => { seam.push(scope.conversationId); } });
  const identity = { accountMode: true, accountId: 'a1', projectId: 'p1', delegation: 'ticket' };

  // 1) 删除这次请求:办完了(不抛 503)
  await service.remove(identity, 'c7', 'delete-1');
  assert.deepEqual(ownStore, ['c7'], '主服务自己的库当场清了');
  assert.deepEqual(seam, ['c7'], '后面的接缝照常调到');
  assert.deepEqual(listConversationPurges(dataDir), [{ projectId: 'p1', conversationId: 'c7' }], '删不动的那几处记进了待清的单子');
  assert.equal(log.filter((row) => row.event === 'agent.conversation.purge-deferred').length, 1, '如实记下「留给任务用户一侧」');
  assert.equal(log.filter((row) => row.event === 'agent.conversation.purged').length, 0, '没有装作清完了');
  assert.deepEqual(acks, [], '任务用户一侧还没清:不向文档服务回执');
  assert.equal(fs.existsSync(path.join(seeded.conversation, 'history.json')), true);
  // 2) 对账来问(每 60 秒一次):还没清,照旧不回执、不报错
  assert.equal(await service.reconcilePurges(), 0);
  assert.equal(await service.reconcilePurges(), 0);
  assert.deepEqual(acks, []);
  assert.deepEqual([...unpurged], ['c7']);
  // 3) 任务用户一侧(删得动)照单子清,留回执
  deny.restore();
  const cleaned = await purgeConversationData(dataDir, { projectId: 'p1', conversationId: 'c7' }, { receipt: true });
  assert.deepEqual([cleaned.removed, cleaned.history, cleaned.workspace, cleaned.browser], [true, true, true, true]);
  assert.deepEqual([fs.existsSync(seeded.browser), fs.existsSync(seeded.conversation), fs.existsSync(work)], [false, false, false]);
  assert.equal(conversationPurgeState(dataDir, { projectId: 'p1', conversationId: 'c7' }), 'done');
  // 这以后主服务又够不到那些目录了(两个用户下它一直够不到):凭回执就够
  const again = denyDeletesUnder(t, [path.join(dataDir, 'tenants'), path.join(dataDir, 'web'), path.join(dataDir, 'work')]);
  assert.equal(await service.reconcilePurges(), 1, '看到回执的这一轮才算清完');
  assert.deepEqual(acks, ['c7']);
  assert.deepEqual([...unpurged], []);
  assert.equal(conversationPurgeState(dataDir, { projectId: 'p1', conversationId: 'c7' }), 'none', '回执用过就撤掉,单子空了');
  assert.equal(await service.reconcilePurges(), 0);
  again.restore();
});

test('WIRE-DEL 主服务自己就删得动(同一个用户:旧托管档、进程内老路)时行为不变:当场清完、当场回执,单子上不留东西', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wire-delsame-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const seeded = seedDeletedConversation(dataDir, 'c7');
  const acks = [];
  const client = { ...Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map((name) => [name, async () => ({ access: 'rw' })])),
    remove: async ({ conversationId }) => ({ removed: [conversationId] }), purgeAck: async ({ conversationId }) => { acks.push(conversationId); } };
  const purger = createConversationPurger({ sharedDataDir: dataDir });
  const service = createAccountConversationService({ conversationClient: client, purger, sleep: async () => {} });
  await service.remove({ accountMode: true, accountId: 'a1', projectId: 'p1', delegation: 'ticket' }, 'c7', 'delete-1');
  assert.deepEqual([fs.existsSync(seeded.browser), fs.existsSync(seeded.conversation)], [false, false]);
  assert.deepEqual(acks, ['c7']);
  assert.deepEqual(listConversationPurges(dataDir), []);
  assert.equal(conversationPurgeState(dataDir, { projectId: 'p1', conversationId: 'c7' }), 'none');
  const out = await purger.purge({ projectId: 'p1', conversationId: 'c7' });
  assert.deepEqual([out.pending, out.history, out.workspace], [false, false, false], '再来一遍:什么都不剩,不报错');
  // 单子都记不下、东西又还在:这才是没办成(503)
  const stuck = seedDeletedConversation(dataDir, 'c9');
  fs.rmSync(path.join(dataDir, CONVERSATION_PURGE_DIR), { recursive: true, force: true });
  fs.writeFileSync(path.join(dataDir, CONVERSATION_PURGE_DIR), 'not-a-directory');
  denyDeletesUnder(t, [stuck.conversation, stuck.browser]);
  await assert.rejects(createConversationPurger({ sharedDataDir: dataDir, timeoutMs: 100 }).purge({ projectId: 'p1', conversationId: 'c9' }), { code: 'purge-failed', status: 503 });
});
