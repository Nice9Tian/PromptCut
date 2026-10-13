/**
 * 云端 Agent 的网页操作:Agent 服务进程死掉、重启之后,旧浏览器不复活
 * (`server/agent/service/hosted-browser.mjs`、`server/web/hosted/session.mjs`)。
 * 跑:npm test -- server/test/cloud-tools-w1-restart.test.mjs
 *
 * 真的:puppeteer 自带的 Chrome for Testing(无头)、一个真的被强杀的子进程(扮 Agent 服务)、本测试在 127.0.0.1:28400 上起的假站。
 * 授权是放行的桩(这里验的是进程的生死)。
 *
 *   W1-RESTART-01  服务进程被强杀(不走任何收尾):它起的浏览器整棵进程树自己退出(连浏览器的是管道,管道一断浏览器就退),
 *                  逐个进程号核;新起的服务里那个对话的浏览器「没开着」,旧清单的编号用不了,不会悄悄把旧页面接回来;
 *                  再 web_open 起的是一个新的浏览器进程,清单的版本号接着旧的往下编(不重用)
 *   W1-RESTART-02  兜底:万一有一个浏览器没跟着退、还占着对话的用户数据目录——新服务起来时把它杀掉(进程号查不到),
 *                  之后这个对话照常能打开网页;没人占着的目录不误杀
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive, until, sleep, testChromePath, hermeticResolve, TEST_CHROME_ARG_PREFIX, TEST_EXTRA_ARGS, isHeadlessShell } from './cloud-tools-w1-fixture.mjs';
import { startFakeSite } from './cloud-tools-w1-site.mjs';
import { createEgressGate } from '../agent/service/egress.mjs';
import { createHostedBrowserTools, hostedBrowserDir } from '../agent/service/hosted-browser.mjs';
import { profileHolder, browserHoldsProfile } from '../web/hosted/session.mjs';

const PORT = 28400;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloud-tools-w1-restart-child.mjs');
const context = { projectId: 'sp_restart', conversationId: 'conversation_restart', runId: 'run2', runGrantId: 'grant2', instanceId: 'instance2', instanceGeneration: 1, senderAccountId: 'sender', messageId: 'message2' };
const scope = { projectId: context.projectId, conversationId: context.conversationId };

let site;
test.before(async () => { site = await startFakeSite(PORT); });
test.after(async () => { await site?.close(); });

function freshService(t, dataDir, executablePath) {
  const log = [];
  const resources = {
    authorize: async () => ({ allowed: true, fenceRevision: 1, grantState: 'active' }),
    register: async () => ({ signal: new AbortController().signal, closed: new Promise(() => {}) }),
  };
  const gate = createEgressGate({ testAllow: [`127.0.0.1:${PORT}`], resolve: hermeticResolve });
  const tools = createHostedBrowserTools({ resources, egress: gate, dataDir, runtime: { executablePath, argPrefix: [...TEST_CHROME_ARG_PREFIX], extraArgs: [...TEST_EXTRA_ARGS] }, log: (event, fields) => log.push({ event, ...fields }) });
  t.after(async () => { await tools.close('test-end'); });
  return { tools, log };
}

async function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    for (let i = 0; i < 25 && fs.existsSync(dir); i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await sleep(200); } }
  });
  return dir;
}

test('W1-RESTART-01 服务进程被强杀:浏览器自己退出;重启后不复活,旧编号用不了', async (t) => {
  const chrome = await testChromePath();
  const dataDir = await tempDir(t, 'pc-w1-restart-');
  const child = spawn(process.execPath, [CHILD, dataDir, chrome, `${ORIGIN}/`, `127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } });
  const first = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (c) => { text += c; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
    child.once('exit', (code) => reject(new Error(`子进程提前退出 ${code}: ${stderr.slice(-400)}`)));
    setTimeout(() => reject(new Error(`子进程 60 秒没有报到: ${stderr.slice(-400)}`)), 60_000).unref();
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.rev, 1);
  assert.ok(first.pids.length >= 2 && first.pids.every(alive), '旧服务的浏览器进程树在跑');
  const dir = hostedBrowserDir(dataDir, scope);
  assert.equal(await browserHoldsProfile(first.browserPid, path.join(dir, 'profile')), true, '那个浏览器正用着这个对话的用户数据目录');

  // 强杀「Agent 服务」:不给它任何收尾的机会
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  await until(() => first.pids.every((pid) => !alive(pid)), { ms: 20_000, what: '旧浏览器的进程树自己退出' });
  assert.deepEqual(first.pids.filter(alive), []);
  await until(() => !profileHolder(path.join(dir, 'profile')).held, { ms: 10_000, what: '用户数据目录放开' });

  // 「重启」:新的服务进程(这里就是本进程)用同一个数据目录
  const { tools, log } = freshService(t, dataDir, chrome);
  assert.equal(await tools.ready, 0, '没有孤儿要清(浏览器已经自己退了)');
  assert.equal(tools.describe().open, 0, '重启不会把旧浏览器接回来');
  for (const [name, args] of [['web_view', {}], ['web_click', { u: first.uids[0] }], ['web_type', { u: first.uids[0], text: 'x' }], ['web_scroll', {}], ['web_read', {}]]) {
    const result = await tools.call(name, args, context);
    assert.equal(result.ok, false, name);
    assert.equal(result.notOpen, true, name);
  }
  assert.equal(tools.describe().open, 0);
  assert.deepEqual(first.pids.filter(alive), [], '旧进程号还是查不到');
  const reopened = await tools.call('web_open', { url: `${ORIGIN}/page2` }, context);
  assert.equal(reopened.ok, true, reopened.error);
  assert.equal(reopened.rev, first.rev + 1, '新浏览器接着旧的版本号往下编');
  assert.notEqual(tools.describe().sessions[0].browserPid, first.browserPid);
  // 旧浏览器里的编号:新页面上也有一个 e1,但版本不是同一版——不会点到新页面的元素上
  for (const u of first.uids.slice(0, 3)) {
    const stale = await tools.call('web_click', { u }, context);
    assert.equal(stale.ok, false, `旧浏览器的编号 ${u} 不该在新浏览器里点成`);
    assert.equal(stale.reason, 'old_rev');
  }
  assert.equal((await tools.call('web_read', {}, context)).title, 'W1 第二页', '页面没有被旧编号带走');
  assert.ok(log.some((e) => e.event === 'agent.web.launched'));
});

test('W1-RESTART-02 兜底:还占着用户数据目录的残留浏览器,新服务起来时杀掉', async (t) => {
  const chrome = await testChromePath();
  const dataDir = await tempDir(t, 'pc-w1-orphan-');
  const dir = hostedBrowserDir(dataDir, scope);
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // 造一个「没跟着服务退出的浏览器」:无头、不开调试口、出网指向一个不通的代理,占着这个对话的用户数据目录
  // chrome-headless-shell 不开调试口就没有事可做、会自己退;给它一个只绑回环的调试口(28401,在分给本包的端口段里)让它挂着(测试专用,产品代码从不开调试口)
  const hold = isHeadlessShell(chrome) ? ['--headless', '--remote-debugging-port=28401'] : ['--headless=new'];
  const orphan = spawn(chrome, [...TEST_CHROME_ARG_PREFIX, ...hold, `--user-data-dir=${profile}`, '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--no-first-run', '--disable-background-networking', '--mute-audio', ...TEST_EXTRA_ARGS, 'about:blank'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  orphan.unref();
  t.after(() => { try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* 已经退了 */ } });
  await until(() => browserHoldsProfile(orphan.pid, profile), { ms: 30_000, step: 500, what: '残留浏览器用上了这个对话的用户数据目录' });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ servicePid: 999999, browserPid: orphan.pid, pids: [orphan.pid], at: Date.now() }));
  // 另一个对话的目录:没人占着,只有一份过期的登记,登记的进程号是本测试进程——不许误杀
  const idleDir = hostedBrowserDir(dataDir, { projectId: 'sp_restart', conversationId: 'conversation_idle' });
  fs.mkdirSync(path.join(idleDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(idleDir, 'owner.json'), JSON.stringify({ servicePid: 999999, browserPid: process.pid, pids: [process.pid], at: Date.now() }));

  const { tools, log } = freshService(t, dataDir, chrome);
  assert.equal(await tools.ready, 1, '清掉了一个孤儿');
  assert.equal(alive(orphan.pid), false, '残留浏览器的进程号查不到了');
  assert.equal(profileHolder(profile).held, false);
  assert.equal(await browserHoldsProfile(orphan.pid, profile), false);
  assert.equal(fs.existsSync(path.join(dir, 'owner.json')), false);
  assert.equal(fs.existsSync(path.join(idleDir, 'owner.json')), false, '没人占着的目录:过期的登记清掉');
  assert.equal(alive(process.pid), true, '没有按过期登记里的进程号误杀');
  assert.ok(log.some((e) => e.event === 'agent.web.orphans-swept' && e.count === 1));
  const opened = await tools.call('web_open', { url: `${ORIGIN}/` }, context);
  assert.equal(opened.ok, true, opened.error);
  assert.equal(opened.title, 'W1 假站首页');
});
