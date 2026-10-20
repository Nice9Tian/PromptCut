/**
 * 账号模式预渲染重试的端到端(AR-10):本机隔离托管组合 + 真实渲染服务 + 真实任务进程 + 真实发布通道。
 *
 * 真的:VisuHive 账号后端、文档服务托管组合(账号模式、一条任务一个进程)、素材服务进程、Agent 主服务的生产装配与内部口、
 *       任务进程里的真实运行器与工具、主服务的发布通道(Agent 服务的服务私钥、本机文档服务的控制连接、只能发布的票据)、
 *       托管方渲染服务的管理进程 `server/hosted-render/main.mjs` 与它起的常驻工作进程(无头 Chrome,`PROMPTCUT_RENDER_STREAMS=1`)。
 * 受控的:模型(脚本式模拟提供方);root 看操作系统的那一半(见 fixtures/account-runner-process.mjs 文件头)。
 *
 *   1  「生成轨道流」关着:Agent 加一张重卡 → 主服务不发;对话里是 off(「没开生成轨道流,云端没有预渲染」)
 *   2  创建者打开「生成轨道流」,成员都离线;另一条消息改这张卡 → 主服务以服务身份发清单计划 → 渲染服务认领、做完、产物入库
 *      (渲染服务报完成数增加;内容库里有这张卡的轨道流清单)→ 对话里补上「云端渲染完成」,排在那一轮收尾之后
 *
 * 要:PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,另要 PROMPTCUT_E2E_REAL_RENDER=1(起无头 Chrome,慢)。
 * 端口:渲染服务用 PROMPTCUT_E2E_RENDER_BASE(缺省 5420)起的 7 个:工作进程 +0～+2、隔离工作进程 +3～+5(不起)、管理口 +6。
 * 跑:PROMPTCUT_E2E_REAL_RENDER=1 node --test server/test/account-render-publish-e2e.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addServiceKey, generateServiceKeyPair, writeServiceKeyFile, readServiceKeyFile, newInstanceId } from '../auth/service-identity.mjs';
import { createServiceClient } from '../auth/service-client.mjs';
import { createAccountRenderPublisher, RENDER_REQUEST_EVENT } from '../agent-service/account-render-requests.mjs';
import { renderStatusText } from '../../src/ai/cloud/events.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const have = Boolean(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && process.env.PROMPTCUT_PASSWORD_ORDER_MODULE) && process.env.PROMPTCUT_E2E_REAL_RENDER === '1';
const BASE = Number(process.env.PROMPTCUT_E2E_RENDER_BASE || 5420);
const script = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v; try { v = await check(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等不到:${what}`);
    await sleep(250);
  }
}

test('AR-10 本机隔离托管组合 + 真实渲染服务:关着如实写 off;打开后成员都离线,云端 Agent 改重卡 → 渲染服务产出入库 → 对话里「云端渲染完成」',
  { skip: !have && 'need account provider env and PROMPTCUT_E2E_REAL_RENDER=1', timeout: 900_000 }, async (t) => {
    const { startRunnerProcessFixture } = await import('./fixtures/account-runner-process.mjs');
    const { runnerPorts } = await import('./free-ports.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ar10-'));
    const renderSecrets = path.join(tmp, 'render-secrets'), renderData = path.join(tmp, 'render-data');
    const logs = [], renderLog = [];
    let renderClient = null, wiring = null, docUrl = null, child = null;
    const f = await startRunnerProcessFixture({ ports: await runnerPorts(), productionMaster: true,
      render: async ({ docUrl: url, servicesFile, masterKey }) => {
        docUrl = url;
        // 渲染服务的服务身份:登记公钥、私钥写进它的私钥目录(同 keygen-render)
        const rk = generateServiceKeyPair();
        addServiceKey(servicesFile, { service: 'render', role: 'render', actsFor: 'self', kid: rk.kid, pub: rk.pub });
        writeServiceKeyFile(renderSecrets, { service: 'render', kid: rk.kid, priv: rk.priv, instanceId: newInstanceId(), instanceName: 'AR-10 渲染服务' });
        // 主服务的发布通道:主身份那把 Agent 服务私钥(组合夹具已登记它的公钥)
        const agentSecrets = path.join(tmp, 'agent-master-secrets');
        writeServiceKeyFile(agentSecrets, { service: 'agent', kid: masterKey.kid, priv: masterKey.priv, instanceId: newInstanceId(), instanceName: 'AR-10 Agent 主服务' });
        renderClient = createServiceClient({ base: url, key: readServiceKeyFile(agentSecrets), log: (e, x) => logs.push({ e, ...x }) });
        void renderClient.ready().catch(() => {});
        wiring = createAccountRenderPublisher({ client: renderClient, docUrl: url, root: ROOT, log: (e, x) => logs.push({ e, ...x }) });
        return { publisher: wiring.publisher, limits: { debounceMs: 300 } };
      } });
    let actor;
    t.after(async () => {
      // 渲染服务的日志留一份(排查用):PROMPTCUT_E2E_RENDER_LOG 指到哪就写到哪
      if (process.env.PROMPTCUT_E2E_RENDER_LOG) try { fs.writeFileSync(process.env.PROMPTCUT_E2E_RENDER_LOG, renderLog.map((x) => JSON.stringify(x)).join(String.fromCharCode(10))); } catch { /* 写不了算了 */ }
      await actor?.close().catch(() => {});
      if (child && child.exitCode === null) {
        try { child.send({ type: 'shutdown' }); } catch { /* 已经没了 */ }
        const done = await Promise.race([new Promise((r) => child.once('exit', () => r(true))), sleep(40_000).then(() => false)]);
        if (!done) { const { killTree } = await import('../hosted-render/worker.mjs'); killTree(child.pid); }
      }
      wiring?.close(); renderClient?.close();
      await f.close();
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    // ---------- 起真实的渲染服务 ----------
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^PROMPTCUT_RENDER_/.test(k)) delete env[k];
    Object.assign(env, { PROMPTCUT_RENDER_DOC_URL: docUrl, PROMPTCUT_RENDER_SECRETS: renderSecrets, PROMPTCUT_RENDER_DATA: renderData,
      PROMPTCUT_RENDER_PORT: String(BASE), PROMPTCUT_RENDER_ISO_PORT: String(BASE + 3), PROMPTCUT_RENDER_STATUS_PORT: String(BASE + 6),
      PROMPTCUT_RENDER_MAX_CONCURRENT: '2', PROMPTCUT_RENDER_SAMPLE_MS: '2000', PROMPTCUT_RENDER_MEM_LOW: '256M',
      PROMPTCUT_RENDER_USER_CARDS: 'off', PROMPTCUT_RENDER_LOOK: 'off', PROMPTCUT_RENDER_STREAMS: '1',
      PROMPTCUT_RENDER_SKIP_CHECKS: 'ffmpeg',
      // 夹具的素材服务用私有 CA 签的证书(节点上是正式证书):渲染服务推产物时要信它
      NODE_EXTRA_CA_CERTS: f.caFile, PROMPTCUT_TEST_ENV_FINGERPRINT: 'ar10ar10ar10ar10', PROMPTCUT_NO_PORT_FILE: '1' });
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'hosted-render', 'main.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let tail = '';
    const take = (chunk) => { const lines = (tail + chunk.toString()).split('\n'); tail = lines.pop() ?? '';
      for (const line of lines) { try { renderLog.push(JSON.parse(line)); } catch { renderLog.push({ raw: line.slice(0, 300) }); } } };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const status = async () => { try { const r = await fetch(`http://127.0.0.1:${BASE + 6}/status`); return r.ok ? await r.json() : null; } catch { return null; } };
    await until(async () => (await status())?.streams === true, `渲染服务起来 :: ${JSON.stringify(renderLog.slice(-8))}`, 180_000);

    actor = await f.connectActor(0);
    const send = async (conversationId, requestId, steps) => {
      const posted = await actor.agent(`/conversations/${conversationId}/messages`, { prompt: script(steps), requestId, selectionSnapshot: { pageId: actor.pageId } });
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return f.messageOf(conversationId, requestId).messageId;
    };
    const finished = (id) => f.grantOf(id)?.state === 'finished';
    const renderEvents = (conv) => f.events(conv).filter((r) => r.event.type === 'render').map((r) => r.event);

    // ---------- 1 关着:不发,对话里如实写 off ----------
    await until(async () => wiring.describe().synced, '主服务的发布通道订到目录', 30_000);
    // 夹具建的是只有 tracks/media 的空项目(没有画布与总时长),先像编辑器新建的项目那样补上元数据,渲染节点才认它是能渲的项目
    const off = await send('ar10_off', 'ar10_req_off', [
      { tool: 'set_project_meta', input: { width: 640, height: 360, fps: 30, duration: 2 } },
      { tool: 'add_track', input: { name: '主序列' } },
      { tool: 'add_clip', input: { cardId: 'blur-text', start: 0, duration: 2, params: { text: '重卡', staggerMs: 100 } } },
      { say: '加好了' }]);
    await f.scheduler.start();
    await until(async () => finished(off), '关着的那一条结清', 180_000);
    await until(async () => renderEvents('ar10_off').length > 0, '关着那一条的渲染事件', 30_000);
    assert.deepEqual(renderEvents('ar10_off').map((e) => e.state), ['off']);
    assert.match(renderStatusText(renderEvents('ar10_off')[0]), /没开「生成轨道流」/);
    const clip = (await actor.project()).project.tracks.flatMap((tr) => tr.clips).find((c) => c.cardId === 'blur-text');
    assert.ok(clip);
    const meta = (await actor.project()).project;
    t.diagnostic(`project meta: ${JSON.stringify({ width: meta.width, height: meta.height, fps: meta.fps, duration: meta.duration })}`);
    t.diagnostic('step 1 off ok');

    // ---------- 2 打开,成员都离线,改重卡 → 真渲染 → 完成 ----------
    // 「生成轨道流」只有在权限分组里的创建者能开(product/rendering.md):这里让网站后端把 dualUser0 当托管方管理员(它总在分组里)。
    // 账号后端在本进程里跑,`ACCOUNT_ADMINS` 每次现读;只改本测试进程的环境,跑完还原
    const prevAdmins = process.env.ACCOUNT_ADMINS;
    process.env.ACCOUNT_ADMINS = 'dualUser0';
    t.after(() => { if (prevAdmins === undefined) delete process.env.ACCOUNT_ADMINS; else process.env.ACCOUNT_ADMINS = prevAdmins; });
    const opened = await actor.admin({ op: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, requestId: 'ar10-streams-on' });
    assert.equal(opened.status, 200, `创建者打开生成轨道流:${JSON.stringify(opened.body)}`);
    await until(async () => wiring.publisher.availability(f.projectId).streams === true, '主服务看到生成轨道流开了', 30_000);
    const on = await send('ar10_on', 'ar10_req_on', [
      { tool: 'update_clip', input: { clipId: clip.id, params: { text: '改过的重卡' } } }, { say: '改好了' }]);
    // 发完消息就离开:成员一个都不在线
    await actor.close(); actor = null;
    await until(async () => finished(on), '开着的那一条结清', 180_000);
    const g = f.grantOf(on);
    await until(async () => renderEvents('ar10_on').some((e) => e.state === 'published'), `主服务发出计划 :: ${JSON.stringify(logs.slice(-10))}`, 60_000);
    await until(async () => renderEvents('ar10_on').some((e) => e.state === 'done' || e.state === 'failed'), `渲染有结局 :: ${JSON.stringify(renderLog.filter((x) => x.event && !/sample|worker\.line/.test(x.event)).slice(-15))}`, 600_000);
    const all = f.events('ar10_on');
    const states = renderEvents('ar10_on').map((e) => e.state);
    t.diagnostic(`ar10_on events: ${JSON.stringify(all.map((r) => [r.event.type, r.event.state ?? r.event.reason ?? null]))}`);
    assert.ok(!states.includes('failed'), `没有失败:${JSON.stringify(renderEvents('ar10_on'))}`);
    const done = all.find((r) => r.event.type === 'render' && r.event.state === 'done');
    assert.equal(done.event.runId, g.runId);
    assert.equal(renderStatusText(done.event), '云端渲染完成');
    assert.ok(all.findIndex((r) => r.event.type === 'runner_done') < all.indexOf(done), '渲染结果在那一轮收尾之后补进对话');
    // 渲染服务真的做了:它的工作进程为这个项目做完了流任务,产物分块推进了素材服务(入库)
    const completed = renderLog.map((x) => /node\.task-completed (\{.*\})/.exec(x.line ?? '')?.[1]).filter(Boolean).map((text) => JSON.parse(text))
      .filter((row) => row.projectId === f.projectId);
    t.diagnostic(`render completed: ${JSON.stringify(completed.map((row) => ({ id: row.id, push: row.push })))}`);
    assert.ok(completed.length > 0, '渲染服务为这个项目做完了任务');
    assert.ok(completed.every((row) => row.push?.pushed > 0 && row.push.pushed === row.push.blocks), '产物都推进了素材服务');
  });
