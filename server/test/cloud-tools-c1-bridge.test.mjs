// C1:云端 Agent 的素材采集在「需要登录的站点」上委托发起人自己的电脑代为下载(`collect-bridge.mjs`、`hosted-collect.mjs`、
// `src/ai/cloud/collectBridge.ts`)。夹具里哪些是真的、哪些不是,见 `cloud-tools-c1-fixture.mjs` 文件头。
// 跑:npm test -- server/test/cloud-tools-c1-bridge.test.mjs
//
//   C1-OK      委托成了:发起页(桌面版)用本机登录态下载、直接传进本项目的素材库,云端核实后登记;云端一个子进程都没起
//   C1-ANON    不属于有登录支持的站点:不打扰发起页,云端匿名下载(缺省路径不变)
//   C1-WEB     发起页是网页版(没有本机采集):如实匿名,不假装委托
//   C1-FALL    委托不成退回匿名并注明原因:本人不在线、本机没有登录态、本机采集没就绪、本机下载失败、上传失败、超时
//   C1-CANCEL  取消:对话结束(stopAll)与这一轮结束(cancelRun)——本机的下载被叫停,什么都不登记
//   C1-LATE    回执晚到不登记:被停止、对话转私有(成员发起的被撤销;主人自己的那一份在途回执被拒)、发起人被踢出
//   C1-RESTART 重启:委托记录是「中断了」,作业表说得清;重启之后才到的回执不登记
//   C1-FORGE   伪造回执:别的项目的哈希、别的对话的请求号、改过的大小、多带字段(本机路径)——都不登记
//   C1-DUP     回执重复交:只登记一次
//   C1-LOGIN   `collect_login` / `collect_login_check`:只在本人电脑上操作,云端只拿回开没开、登没登;不在线回不在线;网页版如实说
//   C1-SECRET  云端的日志、请求记录、委托记录、作业表里查不到 cookie、请求头、用户数据目录、本机路径、站点用户标识
//   C1-TABLE   对账与守门:页面与服务端的工具表是同一组;不与 W2 的工具重名;没给扩展工具的反向通道不认这些请求
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { c1Fixture, projectId, conversationId, OTHER_PROJECT, LOCAL_ONLY, sleep, until, sha } from './cloud-tools-c1-fixture.mjs';
import { createCollectBridge, collectPageTools, COLLECT_PAGE_TOOLS, COLLECT_BRIDGE_TEXT, CollectBridgeError } from '../agent/service/collect-bridge.mjs';
import { PAGE_BRIDGE_TOOLS } from '../agent/service/page-bridge.mjs';
import { initiatorOffline } from '../agent/service/cloud-tools.mjs';
import { COLLECT_PAGE_REQUEST_TOOLS } from '../../src/ai/cloud/collectBridge.ts';
import { freePort } from './free-ports.mjs';

const SOURCE_PORT = await freePort();
const noLeak = (text, what) => { for (const [name, value] of Object.entries(LOCAL_ONLY)) assert.equal(text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)), false, `${what} 里出现了本机的 ${name}`); };
const states = (f) => f.delegationRows().map((r) => [r.state, r.reason]);

test('C1-OK delegated: the initiator desktop downloads with its local login, uploads straight into the project store, the cloud verifies and registers', { timeout: 60_000 }, async (t) => {
  const f = await c1Fixture(t, { cloudCollector: false });      // 云端节点连采集工具都没装:委托照样成
  const desk = f.desktop(f.initiatorPage);
  desk.attach();
  const second = f.desktop(await f.openPage('sender', 'page-second-tab'));   // 发起人的另一个页签
  const member = f.desktop(await f.openPage('other', 'page-other-member'));  // 另一个成员
  second.attach(); member.attach();

  const started = await f.cloud.tools.collect_download({ url: f.loginUrl, quality: 1080 });
  assert.equal(started.ok, true);
  const job = await f.waitJob(started.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.route, 'delegated');
  assert.deepEqual(job.mediaIds, ['m-1']);
  assert.deepEqual(job.items, [{ mediaId: 'm-1', kind: 'video', clipId: 'c-1', filename: 'clip [login-1080].mp4', title: '登录后才有的 1080p', duration: 12.5, width: 1920, height: 1080, vcodec: 'h264', bytes: desk.bytes.length }]);
  assert.ok(job.notes.some((n) => n.includes('发起人自己的电脑')), JSON.stringify(job.notes));

  // 请求只到了发起页;本机下载带的是本机查到的那份登录态
  assert.deepEqual([second.received.length, member.received.length], [0, 0]);
  assert.ok(desk.received.includes('collect_delegate_start') && desk.received.includes('collect_delegate_poll'));
  assert.deepEqual(desk.downloads, [{ url: f.loginUrl, opts: { quality: 1080, cookies: LOCAL_ONLY.cookiesPath } }]);
  // 字节真的在本项目的素材库里,别的项目的库里没有;云端向素材服务核过;登记带期望版本
  assert.equal(await f.has(projectId, desk.hash), true);
  assert.equal(await f.has(OTHER_PROJECT, desk.hash), false);
  assert.deepEqual(f.assetCalls, [{ projectId, hash: desk.hash, size: desk.bytes.length }]);
  assert.deepEqual(f.doc.commits.map((c) => [c.expectedRev, c.rev, c.by]), [[7, 8, f.grant.runId]]);
  assert.deepEqual(f.doc.media.map((m) => [m.hash, m.size, m.name, m.ext, m.sourceJobId]), [[desk.hash, desk.bytes.length, 'clip [login-1080].mp4', 'mp4', started.jobId]]);
  // 云端没有下载、没有起子进程、没有经它的入库路
  assert.deepEqual([f.cloud.imported.length, f.source.hits.length], [0, 0]);
  assert.deepEqual(states(f), [['done', null]]);
  assert.deepEqual(f.cloud.usage.map((u) => [u.model, u.units, u.ok]), [['delegate', desk.bytes.length, true]]);
  // 回执的形状:页面交回的最后一份就是 { requestId, jobId, assetRef: { projectId, hash, size }, result }
  const row = f.delegationRows()[0];
  assert.deepEqual(JSON.parse(row.refs), [{ hash: desk.hash, size: desk.bytes.length }]);
  assert.equal(row.job_id, started.jobId);
  noLeak(f.cloudText(), '云端的记录');
  noLeak(JSON.stringify(job), '给模型看的作业');
});

test('C1-ANON a link outside the login sites never touches the initiator page: the cloud downloads anonymously as before', { timeout: 60_000 }, async (t) => {
  const f = await c1Fixture(t, { sourcePort: SOURCE_PORT });
  const desk = f.desktop(f.initiatorPage);
  desk.attach();
  const job = await f.waitJob((await f.cloud.tools.collect_download({ url: f.anonymousUrl })).jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.route, 'anonymous');
  assert.deepEqual([desk.received.length, f.delegationRows().length, f.doc.media.length], [0, 0, 0]);
  assert.deepEqual(f.cloud.imported.map((i) => i.hash), [sha(f.anonymousBytes)]);
  assert.equal(f.source.hits.every((h) => h.cookie === null), true, '云端匿名:不带任何 cookie');
  assert.equal((job.notes ?? []).length, 0, '缺省路径不多话');
});

test('C1-WEB a browser page (no local collect) as the initiator: honest anonymous download, no pretend delegation', { timeout: 60_000 }, async (t) => {
  const f = await c1Fixture(t, { sourcePort: SOURCE_PORT });
  const desk = f.desktop(f.initiatorPage, { web: true });
  desk.attach();
  const job = await f.waitJob((await f.cloud.tools.collect_download({ url: f.loginSiteUrl })).jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.route, 'anonymous');
  assert.deepEqual(desk.received, ['collect_delegate_start'], '只问了一次,没有后续');
  assert.deepEqual(desk.posted.map((p) => p.ok), [true]);
  assert.deepEqual(states(f), [['fallback', 'page-without-local-collect']]);
  assert.deepEqual(job.notes, [`${COLLECT_BRIDGE_TEXT.fallback['page-without-local-collect']}${COLLECT_BRIDGE_TEXT.fallbackTail}`]);
  assert.deepEqual([f.doc.media.length, f.cloud.imported.length], [0, 1]);
  assert.deepEqual(f.cloud.imported.map((i) => i.hash), [sha(f.anonymousBytes)]);
});

test('C1-FALL every way the delegation fails falls back to the anonymous cloud download with the reason and the quality note', { timeout: 120_000 }, async (t) => {
  const cases = [
    ['initiator-offline', (f, desk) => { /* 页面没有挂事件流 */ void desk; f.initiatorPage.leaveDoc(); }],
    ['not-logged-in', (f, desk) => { desk.loggedIn = false; desk.attach(); }],
    ['local-not-ready', (f, desk) => { desk.ready = false; desk.attach(); }],
    ['local-download-failed', (f, desk) => { desk.downloadFails = true; desk.attach(); }],
    ['upload-failed', (f, desk) => { desk.uploadFails = true; desk.attach(); }],
    ['timeout', (f, desk) => { desk.uploadGate = new Promise(() => {}); desk.attach(); }, { collectLimits: { delegateMs: 300 } }],
  ];
  for (const [why, arrange, options = {}] of cases) {
    const f = await c1Fixture(t, { sourcePort: SOURCE_PORT, ...options });
    const desk = f.desktop(f.initiatorPage);
    arrange(f, desk);
    const job = await f.waitJob((await f.cloud.tools.collect_download({ url: f.loginSiteUrl })).jobId);
    assert.equal(job.status, 'done', `${why}: ${JSON.stringify(job)}`);
    assert.equal(job.route, 'anonymous', why);
    assert.deepEqual(job.notes, [`${COLLECT_BRIDGE_TEXT.fallback[why]}${COLLECT_BRIDGE_TEXT.fallbackTail}`], why);
    assert.deepEqual(states(f), [['fallback', why]], why);
    assert.deepEqual([f.doc.media.length, f.cloud.imported.length], [0, 1], `${why}: 登记的是云端匿名下载的那一份`);
    if (why === 'timeout') await until(() => desk.cancelled.length === 1 || desk.received.includes('collect_delegate_cancel'), { what: 'the desktop being told to stop' });
    noLeak(f.cloudText(), `${why} 的云端记录`);
    await f.resources.close().catch(() => {});
  }
});

test('C1-FALL no collector on the node and the delegation fails: the job says so instead of hanging', { timeout: 30_000 }, async (t) => {
  const f = await c1Fixture(t, { cloudCollector: false });
  const desk = f.desktop(f.initiatorPage);
  desk.loggedIn = false; desk.attach();
  const job = await f.waitJob((await f.cloud.tools.collect_download({ url: f.loginUrl })).jobId);
  assert.equal(job.status, 'error');
  assert.match(job.message, /没有装采集工具/);
  assert.ok(job.notes.some((n) => n.includes('还没有这个站点的登录态')));
  // 没有委托口子、节点又没装:与原来一样立刻回「没装」
  f.cloud.delegate = () => null;
  assert.equal((await f.cloud.tools.collect_download({ url: f.loginUrl })).cloudUnavailable, true);
});

test('C1-CANCEL the conversation ends or the run is cancelled while the desktop is downloading: the local job is stopped and nothing is registered', { timeout: 60_000 }, async (t) => {
  const f = await c1Fixture(t, { sourcePort: SOURCE_PORT });
  const desk = f.desktop(f.initiatorPage);
  let release; desk.downloadGate = new Promise((r) => { release = r; });
  desk.attach();
  const started = await f.cloud.tools.collect_download({ url: f.loginSiteUrl });
  await until(() => desk.received.includes('collect_delegate_poll'), { what: 'first poll' });
  f.cloud.tools.stopAll();
  const job = await f.waitJob(started.jobId);
  assert.deepEqual([job.status, job.message, job.route], ['error', '已取消', 'delegated']);
  await until(() => desk.cancelled.length === 1, { what: 'local cancel' });
  assert.deepEqual(states(f), [['cancelled', 'run-cancelled']]);
  release();
  await sleep(100);
  assert.deepEqual([f.doc.media.length, f.cloud.imported.length, f.source.hits.length], [0, 0, 0], '取消之后既不登记、也不退回去匿名下载');

  // 宿主在这一轮收尾时调 cancelRun:同样收掉
  const g = await c1Fixture(t, {});
  const d2 = g.desktop(g.initiatorPage);
  d2.downloadGate = new Promise(() => {});
  d2.attach();
  const s2 = await g.cloud.tools.collect_download({ url: g.loginUrl });
  await until(() => d2.received.includes('collect_delegate_poll'), { what: 'first poll' });
  assert.equal(g.collectBridge.cancelRun({ projectId, conversationId, runId: 'another-run' }), 0);
  assert.equal(g.collectBridge.cancelRun({ projectId, conversationId, runId: g.grant.runId }), 1);
  const j2 = await g.waitJob(s2.jobId);
  assert.deepEqual([j2.status, j2.message], ['error', '已取消']);
  assert.equal(g.doc.media.length, 0);
});

/** 让发起页把回执扣着:字节已经传上去了,回执还没交 */
async function heldReceipt(t, options = {}) {
  const f = await c1Fixture(t, { sourcePort: options.sourcePort, initiator: options.initiator, limits: { pageMs: 5_000 } });
  const desk = f.desktop(f.initiatorPage);
  desk.hold = 'receipt';
  desk.attach();
  const started = await f.cloud.tools.collect_download({ url: options.sourcePort ? f.loginSiteUrl : f.loginUrl });
  const held = await until(() => desk.held[0], { what: 'the receipt held on the desktop' });
  assert.equal(await f.has(projectId, desk.hash), true, '字节已经在素材库里');
  return { f, desk, started, held };
}

test('C1-LATE stopped by the user before the receipt arrives: refused, nothing registered, the uploaded bytes stay unreferenced', { timeout: 60_000 }, async (t) => {
  const { f, desk, started, held } = await heldReceipt(t);
  f.stopRun();
  await assert.rejects(desk.post(held.answer), { code: 'page-request-run-revoked', status: 410 });
  const job = await f.waitJob(started.jobId);
  assert.deepEqual([job.status, job.route, job.message], ['error', 'delegated', COLLECT_BRIDGE_TEXT.revoked], JSON.stringify(job));
  assert.equal(f.doc.media.length, 0);
  assert.equal(f.cloud.imported.length, 0);
  assert.equal(f.cloud.usage.some((u) => u.model === 'download'), false, '被停止之后不再退回去匿名下载');
  assert.equal(await f.has(projectId, desk.hash), true, '已经传上去的字节还在库里,只是没有任何登记引用它');
  assert.equal(f.delegationRows()[0].state === 'rejected' || f.delegationRows()[0].state === 'cancelled', true, JSON.stringify(states(f)));
  // 之后再把同一份回执直接塞给核实登记的口子:这一轮已经不能写了,不登记
  const late = await f.collectBridge.settleReceipt(f.context, f.delegationRows()[0].delegation_id, held.answer.result.receipt);
  assert.equal(late.delegated, false);
  assert.equal(f.doc.media.length, 0);
});

test('C1-LATE conversation made private while a member\'s delegation is waiting: the run is revoked, the late receipt is not registered', { timeout: 60_000 }, async (t) => {
  const { f, desk, started, held } = await heldReceipt(t);          // sender 发起,对话的主人是 owner
  f.makePrivate();
  await assert.rejects(desk.post(held.answer), (e) => e.status === 410 && e.code !== 'page-request-gone');
  const job = await f.waitJob(started.jobId);
  assert.deepEqual([job.status, job.route, job.message], ['error', 'delegated', COLLECT_BRIDGE_TEXT.revoked], JSON.stringify(job));
  assert.deepEqual([f.doc.media.length, f.cloud.imported.length], [0, 0]);
  assert.equal(f.cloud.usage.some((u) => u.model === 'download'), false);
  assert.ok(['rejected', 'cancelled'].includes(f.delegationRows()[0].state));
});

test('C1-LATE the owner makes their own conversation private mid-flight: the in-flight receipt is refused and that delegation is over', { timeout: 60_000 }, async (t) => {
  const { f, desk, started, held } = await heldReceipt(t, { initiator: 'owner', sourcePort: SOURCE_PORT });
  f.makePrivate();                                                  // 主人自己的这一轮照常保留,但对话的权限版本变了
  await assert.rejects(desk.post(held.answer), { code: 'page-request-conversation-changed', status: 410 });
  const job = await f.waitJob(started.jobId);
  // 委托到此为止(晚到的回执不登记);这一轮仍然有效,所以接着在云端匿名下载
  assert.deepEqual([job.status, job.route], ['done', 'anonymous'], JSON.stringify(job));
  assert.deepEqual(states(f), [['rejected', 'late-conversation-changed']]);
  assert.equal(f.doc.media.length, 0, '发起人电脑交回的那一份没有登记');
  assert.deepEqual(f.cloud.imported.map((i) => i.hash), [sha(f.anonymousBytes)]);
  assert.equal(await f.has(projectId, desk.hash), true);
});

test('C1-LATE initiator kicked out before the receipt arrives: refused and not registered', { timeout: 60_000 }, async (t) => {
  const { f, desk, started, held } = await heldReceipt(t);
  f.kick('sender');
  await assert.rejects(desk.post(held.answer), { code: 'page-request-submitter-denied', status: 410 });
  const job = await f.waitJob(started.jobId);
  assert.equal(f.doc.media.length, 0, JSON.stringify(job));
  assert.equal(f.delegationRows()[0].state, 'rejected');
  assert.equal(job.route === 'delegated' ? job.status : 'error', 'error', JSON.stringify(job));
  // 被踢之后这一轮按例外保留着跑:再委托一次直接是「不在线」,不再找他的页面
  const before = desk.received.length;
  const again = await f.collectBridge.delegateDownload(f.context, { id: 'collect-aaaaaaaaaaaa', url: f.loginUrl, quality: 1080, site: 'auto' });
  assert.deepEqual([again.delegated, again.why], [false, 'initiator-offline']);
  assert.equal(desk.received.length, before);
});

test('C1-RESTART after the Agent service restarts the delegation reads as interrupted, the job says so, and a receipt arriving afterwards is not registered', { timeout: 60_000 }, async (t) => {
  const { f, desk, started, held } = await heldReceipt(t);
  const id = f.delegationRows()[0].delegation_id;
  assert.equal(f.delegationRows()[0].state, 'downloading');
  // 新进程打开同一个委托库与同一个对话的作业表(旧进程没来得及收尾就没了)
  const reborn = f.openCollectBridge();
  assert.deepEqual(states(f), [['interrupted', 'agent-restart']]);
  assert.deepEqual([reborn.delegationOf({ projectId, conversationId }, started.jobId).state, reborn.delegationOf({ projectId, conversationId }, started.jobId).reason], ['interrupted', 'agent-restart']);
  assert.equal(reborn.delegationOf({ projectId: OTHER_PROJECT, conversationId }, started.jobId), null, '别的项目查不到');
  const tools = f.cloud.reopen();
  const job = await tools.collect_job({ jobId: started.jobId });
  assert.deepEqual([job.status, job.route], ['error', 'delegated']);
  assert.match(job.message, /重启过/);
  // 这时回执才到:新进程不登记
  const late = await reborn.settleReceipt(f.context, id, held.answer.result.receipt);
  assert.deepEqual([late.delegated, late.stop, late.why], [false, true, 'agent-restart']);
  assert.equal(f.doc.media.length, 0);
  assert.equal(await f.has(projectId, desk.hash), true);
  f.cloud.tools.stopAll();
  void desk;
});

test('C1-FORGE forged receipts are never registered: another project\'s hash, another conversation\'s request id, a changed size, extra fields', { timeout: 60_000 }, async (t) => {
  // (1) 多带字段(本机路径、cookie):反向通道就不收,页面交来的那一份不落盘
  {
    const { f, desk, started, held } = await heldReceipt(t, { sourcePort: SOURCE_PORT });
    const forged = structuredClone(held.answer);
    forged.result.receipt.result.items[0].path = LOCAL_ONLY.filePath;
    forged.result.receipt.cookies = LOCAL_ONLY.cookie;
    await assert.rejects(desk.post(forged), { code: 'page-result-invalid', status: 422 });
    const job = await f.waitJob(started.jobId);
    assert.deepEqual([job.status, job.route, f.doc.media.length], ['done', 'anonymous', 0], JSON.stringify(job));
    assert.deepEqual(states(f), [['rejected', 'receipt-invalid']]);
    noLeak(f.cloudText(), '云端的记录');
  }
  // (2) 别的项目的哈希:字节只在另一个项目的库里;回执说它在本项目
  {
    const { f, desk, started, held } = await heldReceipt(t, { sourcePort: SOURCE_PORT });
    const foreign = await f.putBytes(OTHER_PROJECT, randomBytes(3000));
    const forged = structuredClone(held.answer);
    const item = forged.result.receipt.result.items[0];
    item.assetRef = { projectId, hash: foreign.hash, size: foreign.size };
    forged.result.receipt.assetRef = { ...item.assetRef };
    assert.deepEqual(await desk.post(forged), { ok: true }, '形状合规,反向通道收下;核实在后面');
    const job = await f.waitJob(started.jobId);
    assert.deepEqual([job.route, f.doc.media.length], ['anonymous', 0], JSON.stringify(job));
    assert.deepEqual(states(f), [['rejected', 'asset-unverified']]);
    assert.deepEqual(f.assetCalls.at(-1), { projectId, hash: foreign.hash, size: foreign.size }, '向素材服务核的是本项目的库');
    assert.ok(job.notes[0].startsWith(COLLECT_BRIDGE_TEXT.fallback['asset-unverified']));
    // 回执直接写别的项目:同样不收
    const { f: f2, desk: d2, started: s2, held: h2 } = await heldReceipt(t, {});
    const other = structuredClone(h2.answer);
    other.result.receipt.result.items[0].assetRef.projectId = OTHER_PROJECT;
    other.result.receipt.assetRef.projectId = OTHER_PROJECT;
    await d2.post(other);
    const j2 = await f2.waitJob(s2.jobId);
    assert.deepEqual([states(f2), f2.doc.media.length, f2.assetCalls.length], [[['rejected', 'receipt-invalid']], 0, 0]);
    assert.equal(j2.status, 'error', '这个夹具的云端节点能匿名下载的站点替身没开,退回后也下不了');
  }
  // (3) 改过的大小:素材服务里那份字节的大小对不上
  {
    const { f, desk, started, held } = await heldReceipt(t, { sourcePort: SOURCE_PORT });
    const forged = structuredClone(held.answer);
    forged.result.receipt.result.items[0].assetRef.size += 1;
    forged.result.receipt.assetRef.size += 1;
    await desk.post(forged);
    const job = await f.waitJob(started.jobId);
    assert.deepEqual([job.route, f.doc.media.length], ['anonymous', 0]);
    assert.deepEqual(states(f), [['rejected', 'asset-unverified']]);
  }
  // (4) 别的对话的请求号、别的作业号
  {
    const { f, desk, started, held } = await heldReceipt(t, { sourcePort: SOURCE_PORT });
    const forged = structuredClone(held.answer);
    forged.result.receipt.requestId = 'cd-000000000000000000000000';
    await desk.post(forged);
    const job = await f.waitJob(started.jobId);
    assert.deepEqual([job.route, f.doc.media.length], ['anonymous', 0]);
    assert.deepEqual(states(f), [['rejected', 'receipt-invalid']]);
    // 把这份(真的)回执拿去别的对话的委托号上登记:不认
    const out = await f.collectBridge.settleReceipt({ ...f.context }, 'cd-ffffffffffffffffffffffff', held.answer.result.receipt);
    assert.deepEqual([out.delegated, out.why], [false, 'receipt-invalid']);
    // 别的成员拿着发起页的请求号、页面号、随机数来交:同一个 410,不影响结果
    const member = await f.openPage('other', 'page-other-member');
    await assert.rejects(desk.post(held.answer, { as: member.identity }), { code: 'page-request-gone', status: 410 });
    assert.equal(f.doc.media.length, 0);
  }
});

test('C1-DUP the same receipt handed back twice registers once', { timeout: 60_000 }, async (t) => {
  const { f, desk, started, held } = await heldReceipt(t);
  assert.deepEqual(await desk.post(held.answer), { ok: true });
  assert.deepEqual(await desk.post(held.answer), { ok: true, duplicate: true }, '页面没收到 200 又交了一次');
  const job = await f.waitJob(started.jobId);
  assert.deepEqual([job.status, job.route, job.mediaIds], ['done', 'delegated', ['m-1']]);
  const id = f.delegationRows()[0].delegation_id;
  // 同一份回执再进核实登记的口子(重试、并发):回同一个结果,不登记第二次
  const [a, b] = await Promise.all([f.collectBridge.settleReceipt(f.context, id, held.answer.result.receipt), f.collectBridge.settleReceipt(f.context, id, held.answer.result.receipt)]);
  assert.deepEqual([a.delegated, a.duplicate, a.items.map((i) => i.mediaId)], [true, true, ['m-1']]);
  assert.deepEqual(b.items.map((i) => i.mediaId), ['m-1']);
  // 内容不同的第二份回执:不采用
  const changed = structuredClone(held.answer.result.receipt);
  changed.result.items[0].name = 'other.mp4';
  assert.equal((await f.collectBridge.settleReceipt(f.context, id, changed)).delegated, false);
  assert.deepEqual([f.doc.media.length, f.doc.commits.length], [1, 1]);
});

test('C1-LOGIN collect_login / collect_login_check only operate on the initiator\'s own computer; the cloud learns opened / logged-in and nothing else', { timeout: 60_000 }, async (t) => {
  const f = await c1Fixture(t, {});
  const tools = f.cloud.tools;
  // 发起页不在线:现成的「发起方不在线」那句
  assert.deepEqual(await tools.collect_login({ site: 'bilibili' }), initiatorOffline('collect_login'));
  assert.deepEqual(await tools.collect_login_check({}), initiatorOffline('collect_login_check'));
  const desk = f.desktop(f.initiatorPage);
  desk.loggedIn = false;
  desk.attach();
  const opened = await tools.collect_login({ method: 'browser' });
  assert.deepEqual(opened, { ok: true, site: 'bilibili', visible: true, onInitiatorComputer: true, hint: COLLECT_BRIDGE_TEXT.loginOpened });
  assert.deepEqual(desk.loginCalls, [{ site: 'bilibili', method: 'browser' }], '打开的是本机现成的登录窗口');
  assert.deepEqual(await tools.collect_login_check({}), { ok: true, site: 'bilibili', loggedIn: false, onInitiatorComputer: true, hint: COLLECT_BRIDGE_TEXT.loginMissing });
  desk.loggedIn = true;
  assert.deepEqual(await tools.collect_login_check({ hide: false }), { ok: true, site: 'bilibili', loggedIn: true, onInitiatorComputer: true, hint: COLLECT_BRIDGE_TEXT.loginChecked });
  assert.deepEqual(desk.checkCalls, [{ site: 'bilibili' }, { site: 'bilibili', hide: false }]);
  assert.deepEqual(await tools.collect_login({}), { ok: true, site: 'bilibili', alreadyLoggedIn: true, onInitiatorComputer: true, hint: COLLECT_BRIDGE_TEXT.loginAlready });
  noLeak(f.cloudText(), '云端的记录');
  // 本机多回了东西(用户标识、路径):答案由页面逐字段拼,带不出来;页面被改过、硬塞进来的也被拒
  desk.hold = 'collect_login_check';
  const pending = tools.collect_login_check({});
  const held = await until(() => desk.held[0], { what: 'held login check' });
  await assert.rejects(desk.post({ ...held.answer, result: { loggedIn: true, userId: LOCAL_ONLY.userId, path: LOCAL_ONLY.cookiesPath } }), { code: 'page-result-invalid', status: 422 });
  assert.deepEqual(await pending, initiatorOffline('collect_login_check'));
  noLeak(f.cloudText(), '云端的记录');

  // 发起页是网页版:如实说只能在电脑上做
  const g = await c1Fixture(t, {});
  g.desktop(g.initiatorPage, { web: true }).attach();
  assert.deepEqual(await g.cloud.tools.collect_login({}), { ok: false, initiatorOnly: true, error: COLLECT_BRIDGE_TEXT.webPage('collect_login') });
  assert.deepEqual(await g.cloud.tools.collect_login_check({}), { ok: false, initiatorOnly: true, error: COLLECT_BRIDGE_TEXT.webPage('collect_login_check') });
  // 没有委托口子(没接线):如实说只能在本人电脑上操作
  g.cloud.delegate = () => null;
  const plain = await g.cloud.tools.collect_login({});
  assert.deepEqual([plain.ok, plain.initiatorOnly], [false, true]);
  assert.match(plain.error, /只能在发起人自己的电脑上操作/);
  assert.match((await g.cloud.tools.collect_login_check({})).error, /只能在发起人自己的电脑上操作/);
});

test('C1-SECRET nothing from the initiator\'s computer but hash, size and plain metadata reaches cloud logs and records', { timeout: 60_000 }, async (t) => {
  const f = await c1Fixture(t, { sourcePort: SOURCE_PORT });
  const desk = f.desktop(f.initiatorPage);
  desk.attach();
  await f.cloud.tools.collect_login({});
  await f.cloud.tools.collect_login_check({});
  const ok = await f.waitJob((await f.cloud.tools.collect_download({ url: f.loginSiteUrl, quality: 720 })).jobId);
  assert.equal(ok.route, 'delegated');
  desk.downloadFails = true;                                        // 本机报错的那句话里有路径与 cookie
  const failed = await f.waitJob((await f.cloud.tools.collect_download({ url: `${f.loginSiteUrl}?again` })).jobId);
  assert.equal(failed.route, 'anonymous');
  const text = f.cloudText();
  noLeak(text, '云端的记录');
  // 「这次带没带登录态」是回执里的一个真假值(cookiesUsed),除它之外不许出现这些字眼
  const scanned = text.replaceAll('cookiesUsed', '');
  for (const word of ['cookie', 'Cookie', 'SESSDATA', 'AppData', 'web-profile', 'stderrTail']) assert.equal(scanned.includes(word), false, `云端的记录里出现了 ${word}`);
  assert.equal(text.includes(f.loginSiteUrl) && !text.includes('"url"'), false, '链接只在作业表里(原来就有),委托记录只存摘要');
  for (const row of f.delegationRows()) assert.deepEqual(Object.keys(row).sort(), ['conversation_id', 'created_at', 'delegation_id', 'grant_id', 'initiator_account_id', 'job_id', 'media', 'project_id', 'reason', 'receipt_digest', 'refs', 'run_id', 'site', 'state', 'updated_at', 'url_digest']);
  // 页面发给云端的每一份答案:逐份看过,没有本机的东西
  noLeak(JSON.stringify(desk.posted), '页面交回的答案');
  // 日志只有事件名、项目、这一轮、状态与原因的代号
  for (const line of f.logs.filter((l) => l.event.startsWith('agent.collect.delegate'))) assert.deepEqual(Object.keys(line).filter((k) => !['event', 'projectId', 'runId', 'state', 'why', 'items', 'reason', 'code'].includes(k)), []);
});

test('C1-TABLE the page and server tool tables match; no clash with the W2 tools; a bridge without the extension refuses these requests', async (t) => {
  assert.deepEqual([...COLLECT_PAGE_REQUEST_TOOLS].sort(), [...COLLECT_PAGE_TOOLS].sort());
  assert.deepEqual(Object.keys(collectPageTools()).sort(), [...COLLECT_PAGE_TOOLS].sort());
  assert.equal(COLLECT_PAGE_TOOLS.some((name) => PAGE_BRIDGE_TOOLS.includes(name)), false);
  assert.deepEqual([...PAGE_BRIDGE_TOOLS], ['seek', 'play', 'pause', 'web_handoff'], 'W2 的工具表没有动');
  const f = await c1Fixture(t, {});
  assert.deepEqual([...f.bridge.extraTools].sort(), [...COLLECT_PAGE_TOOLS].sort());
  const plain = f.openBridge();                                     // W2 原样的反向通道
  assert.deepEqual(plain.extraTools, []);
  const who = await plain.initiator(f.context);
  await assert.rejects(plain.requestPage({ run: f.context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool: 'collect_login', args: { site: 'bilibili' }, requestId: 'request-c1-0001' }), { code: 'page-tool-unknown', status: 404 });
  assert.throws(() => createCollectBridge({ bridge: plain, databasePath: f.delegationsPath, assets: f.assets, authorize: async () => ({}), register: async () => ({}) }),
    (e) => e instanceof CollectBridgeError && e.code === 'collect-bridge-configuration' && e.status === 503, '没带扩展工具的反向通道接不了委托');
  assert.throws(() => f.openBridge({ extraTools: { seek: { args: () => ({}) } } }), { code: 'page-bridge-configuration' }, '扩展工具不能顶替 W2 的工具');
  // 发给页面的参数:模型或宿主多带的字段(页面号、cookie、路径)一律拒绝,不是丢掉
  const tools = collectPageTools();
  const good = { delegationId: 'cd-0123456789abcdef01234567', jobId: 'collect-0123456789ab', projectId, url: 'https://example.com/v', site: 'bilibili', quality: 1080 };
  assert.deepEqual(tools.collect_delegate_start.args(good), good);
  for (const extra of [{ cookies: 'x' }, { pageId: 'p' }, { quality: 999 }, { url: '' }]) assert.throws(() => tools.collect_delegate_start.args({ ...good, ...extra }), { code: 'bad-args' });
  assert.throws(() => tools.collect_login.args({ site: 'nowhere' }), { code: 'bad-args' });
  // 页面交回的答案:没做成只留代号,不留它写的那句话
  assert.deepEqual(tools.collect_delegate_poll.answer({ ok: false, error: `失败 ${LOCAL_ONLY.filePath}`, code: 'local-failed' }), { ok: false, code: 'local-failed' });
  assert.throws(() => tools.collect_delegate_poll.answer({ ok: true, result: { state: 'done', receipt: { requestId: 'x' } } }));
});
