#!/usr/bin/env node
/**
 * 云端 Agent「关掉软件照常运转」的**带界面**端到端探针(任务书 `docs/plan/cloud-agent-task.md`「用户体验验收」六条,回归项)。
 * 不带界面的那一版是 `cloud-agent-ux-probe.mjs`(成员由 Node 进程扮演);这一版成员都是真实页面,发起方是真的被结束掉的进程。
 *
 * 搭法(全部真进程、真身份,只绑 127.0.0.1,数据在一个临时目录里,结束时删掉;不连任何远端;共用部分见 `cloud-agent-ui-lib.mjs`):
 *   托管组合(文档 + 素材,本机信任关着) · 渲染服务(管理进程 + 工作进程 + 它的 Chrome,服务身份 render)
 *   Agent 服务(托管档命令行入口,服务身份 agent;模型是模拟模型提供方的脚本模式)
 *   在线构建(从当前工作区现打)经本机代理:编辑器页、两个舞台源、`/hosted/`、`/media/`、`/agent/`
 *   桌面版形态的编辑器:本 worktree 的 dev server,独立进程、临时数据目录、固定设备号;它自己不当渲染节点(要看的是云节点把活干了)
 *   每个「人」一个独立的浏览器进程:创建者的桌面页面、创建者的在线页面、另一位成员 bob、被移出的 carol。
 *   项目(限定进入):创建者在桌面版形态的页面里建、放云端;成员 bob、carol。三张内置卡:两张探针重卡(`probe-slow-stepped`,每帧烧 40 毫秒,
 *   在线页面量出来就是重卡:播放时贴预渲染的快照)加一张带参数的图表卡。
 *
 *   node scripts/probes/cloud-agent-ux-ui-probe.mjs [--steps desktop,online,stop,errors[,spaced]] [--base-port 5790] [--doc-port 8798] [--asset-port 8799]
 *        [--agent-port 5741] [--render-port 5830] [--dist <在线构建目录>] [--out <截图目录>] [--keep]
 *   端口:--base-port +0 编辑器页的源、+1 / +2 两个舞台的源、+3 桌面版编辑器(+4、+5 是它的舞台端口);`--render-port` +0/+1/+2 是渲染
 *   工作进程的三个端口,+6 是管理进程的诊断口。截图存 --out(缺省 `work/four-stage/cloud-agent/ux/`)。
 *
 * 「真实结束发起方」的口径:桌面版 = 结束它的浏览器进程,并结束那台桌面 dev server 进程连同全部子孙(SIGKILL / taskkill,只按探针自己起的
 * 进程号);在线浏览器 = 结束那个浏览器进程。这是本机能做到的「完全退出软件」的等价物;真正的安装版连托盘退出在新节点的验收里做。
 *
 * 验收标准(任务书「用户体验验收」六条,逐条对应;每条断言一行 JSON,`ok` 全为 true 才算过):
 *
 * 零、搭起来
 *   X0  三个服务起来;渲染服务、Agent 服务、在线页面的代码版本相同(同一份代码);项目设置里「云端 Agent」一行缺省勾上。
 * 一、发出任务后完全退出(桌面版发起 = 步骤 desktop;在线浏览器发起 = 步骤 online;两遍各自断言 A1～A6)
 *   A1  创建者在页面里对放云端的项目选「云端」,发一个要跑一段时间(约 100 秒)、改多处并触发重卡重渲的任务:先读几遍项目(每遍之间等十几秒,
 *       像真模型那样先看、先想),再连着改 12 处(改文案、挪片段、调卡片参数各 4 次;两张重卡都被挪到)。界面上看到第 2 个工具结果
 *       (任务已被云端接下)后,发起方被真的结束:进程没了、端口没人听。文档服务按会话层的规矩把断掉的会话保留 60 秒(等它接续),
 *       期满后项目里没有任何成员连接。
 * 二、之后云端自己把事做完
 *   A2  对话照样跑到结束;12 次写入全部落在「文档服务里已经没有任何成员连接」之后、逐次落地,从那一刻起到渲染结束
 *       `members`(渲染服务的目录里看)恒为假。
 *   A3  被改动的重卡由渲染服务渲出来、产物入库(对话记录里有「渲染完成」,渲染节点做完的任务数增加,素材服务里多出文件);渲染全程没有成员在线。
 * 三、另一位成员从在线浏览器进项目(真实页面)
 *   A4  bob 进项目:页面里的项目就是 12 次改动之后的样子;「Agent 操作记录」里这一轮的工具调用都在,署名是「〈创建者〉的云端 Agent」。
 *   A5  舞台上的画面是渲好的预渲染结果:播放时两张重卡都贴着快照、没有占位;没有「需要本地 PC 渲染辅助」的图标与时间轴徽标;
 *       层表里这几层的环境指纹是云节点渲染服务的;舞台截图不是空白(颜色不止一种)。
 * 四、创建者重新打开(新进程)
 *   A6  回到同一个项目;AI 栏仍是本机驱动(桌面版)/ 云端(在线);历史列表「云端」一组里找得到这段对话,点开后完整过程与结果都在
 *       (全部工具调用、最后的回复、「云端渲染完成」);项目是最新版本;预渲染结果已在(层表有层;在线页面播放时贴快照)。
 *   A7  点「撤销这步」撤掉 Agent 的最后一处改动:创建者页面里那个参数回到上一次的值,按钮变成「已撤销」;bob 的页面也看到撤销的结果。
 * 五、中途想停、换设备(步骤 stop)
 *   B1  另起一遍更长的任务(桌面版发起),发起方同样被结束。之后 bob 从在线浏览器进项目看着:「Agent 操作记录」的条数一点点涨(改动一条条出现),
 *       署名是「〈创建者〉的云端 Agent」;成员列表里创建者那一行下有「〈创建者〉的云端 Agent」而他本人不在线(没有「编辑中」)。
 *   B2  创建者重新打开桌面版(新进程、同一台设备):AI 栏仍是本机驱动,出现「云端有一个对话正在进行」,点「接上看看」接上、看得到过程;
 *       点「停止」后 5 秒内停下,对话记录里是已停止;之后项目不再变。
 *   B3  另一台设备(另一个浏览器进程与设备号、同一创建者身份,在线页面):历史里打开同一个对话接着看(过程都在、是已停止的),
 *       接着说一句:新的一轮正常跑完,改动落地;桌面版那边开着的同一个对话也看到这一轮。
 * 六、出错不悄悄丢(步骤 errors;界面上的对话记录里要有明确的原因,项目停在完好的版本上)
 *   E1  模型调用失败(发起方发完就被结束,事后重新打开看):对话记录里有「模型调用失败」与接口给的原因;历史列表里标「出错」。
 *   E2  额度用尽:对话记录里有带已用与上限的那句话;再发被明确拒绝并说明;清掉额度后恢复。
 *   E3  创建者中途关了开关(在项目设置里取消勾选「云端 Agent」):进行中的对话被停下,记录里写明原因;AI 栏说明已关闭;勾回来恢复。
 *   E4  渲染失败(渲染服务停着):对话照常做完,对话记录里有「云端渲染失败」与原因;项目内容不受影响。
 *   E5  发起成员中途被移出:她的对话被停下;她的页面当场被阻断并写明「你已被移出名单」(她已不在项目里,对话记录她读不到了),
 *       云端的对话记录里留着「已被移出」的原因;项目停在完好的版本上。
 *   每一种都断言:项目结构完好(三张卡都在)、版本号只多了成功写入的次数、之后 1.5 秒没有新的写入。
 * 附:已知缺陷的复现(步骤 spaced,**缺省不跑**;修好之前它是红的)
 *   K1  写入之间隔得比补渲的防抖(3 秒)长时(真模型的每次往返都是几秒),Agent 服务每写一次就发一个指着当时版本的清单计划;项目接着往前走,
 *       渲染节点取不到旧版本的项目快照(文档服务只给得出当前版本),那些细任务失败,并经队列的同键合并连累最后一版的计划:
 *       对话记录里最后是「云端渲染失败:…没有项目快照」。这一步断言「最后是渲染完成」,用来在修好之后确认。
 * 最后一行是汇总 `{ summary }`,有失败退出码 1,起不来退出码 2。不打印口令、票据、私钥。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookupProject } from '../../server/auth/client.mjs';
import { joinAs, adminOp, projectOf, agentApi } from './cloud-agent-probe-lib.mjs';
import {
  ROOT, sleep, USER_PORTS, createUi, startStack, startDesktop, killDesktop, launchBrowser, killBrowser, alive, newPage, P, mockSteps, msgs, view, conversationOf,
  toolParts, lastAssistant, idle, panelText, providerOptions, sendText, joinOnline, sharedProjectOf, hostedToggle, openProjectSettings,
  creatorToggleService, closeDialogs, eventLog, membersList, clipOnStage, stageShot, pixelStats, portFree, gateSettled, clickUntil,
} from './cloud-agent-ui-lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ALL_STEPS = ['desktop', 'online', 'stop', 'errors'];
/** 已知缺陷的复现步骤:缺省不跑(修好之前是红的) */
const OPT_STEPS = ['spaced'];
const STEPS = String(arg('--steps', ALL_STEPS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const BASE = Number(arg('--base-port', 5790));
const PORTS = { site: BASE, stageA: BASE + 1, stageB: BASE + 2, desktop: BASE + 3, doc: Number(arg('--doc-port', 8798)), asset: Number(arg('--asset-port', 8799)), agent: Number(arg('--agent-port', 5741)), render: Number(arg('--render-port', 5830)) };
for (const p of USER_PORTS) if ([...Object.values(PORTS), PORTS.desktop + 1, PORTS.desktop + 2].includes(p)) { process.stderr.write(`端口段碰到了 ${p}(用户的编辑器或安装版)\n`); process.exit(2); }
const KEEP = argv.includes('--keep');
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-uxui-'));
const OUT = path.resolve(arg('--out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'cloud-agent', 'ux')));
fs.mkdirSync(OUT, { recursive: true });
const RENDER_STALL_MS = 12_000;

const { results, check, say, until } = createUi({ maxLine: 2200 });
let S = null;
const browsers = new Set();
const desktops = new Set();
const nodeConns = new Set();
const shots = [];
const timings = {};
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); const ok = await page.screenshot({ path: f }).then(() => true, () => false); if (ok) shots.push(f); return f; };
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);

/* ================================================================== 项目与脚本 */

const NAME = `云端体验-${RUN}`;
const SALT = `ux-${RUN}`;
const N = 12;
/** 「发出后退出」那两遍:开头读两遍项目(任务被接下),再读 LEAVE_READS 遍、每遍之前等 LEAVE_WAIT_MS(整段长过文档服务保留断掉的会话的 60 秒),然后连着写 */
const LEAVE_READS = 6;
const LEAVE_WAIT_MS = 14_000;
/** 一轮里的工具调用数:读(2 + LEAVE_READS)加写 N;一轮最多 24 次模型往返,这里 21 次 */
const LEAVE_TOOLS = 2 + LEAVE_READS + N;
/** 文档服务保留断掉的会话多久(`server/docservice/session.mjs` 的 `RETAIN_MS`) */
const RETAIN_MS = 60_000;
const CLIPS = { bars: 'clip-bars', stateful: 'clip-stateful', canvas: 'clip-canvas' };
const HEAVY = [CLIPS.stateful, CLIPS.canvas];
const pw = () => `pw-${randomBytes(6).toString('hex')}`;
const CRED = { creator: { username: 'alice', password: pw() }, bob: { username: 'bob', password: pw() }, carol: { username: 'carol', password: pw() } };
const CREATOR_SIGN = `${CRED.creator.username}的云端 Agent`;
let PID = null;
let PROJ = null;
let PROC_FILE = null;
const DESK_DIR = path.join(TMP, 'desktop');
const DESK_DEVICE = `uxui-desk-${RUN}`.padEnd(20, '0');

const rowsOf = (salt, i) => `微信,${50 + i}|抖音,62|${salt},${i}`;
let moveSeq = 0;
/** 第 i 次写入(从 1 起):改文案、挪片段、调卡片参数轮着来。`fixed` 的值好在后面逐个核对;别的每次都与现状不同(同值的写入不产生新版本) */
function writeStep(i, salt, fixed) {
  if (i % 3 === 1) return { tool: 'update_clip', input: { clipId: CLIPS.bars, params: { title: `${salt} 第 ${i} 次:改文案` } } };
  // 挪片段:两张重卡轮着挪(第 2、8 次挪推帧卡,第 5、11 次挪画布卡),它们都进云端的补渲清单
  if (i % 3 === 2 && fixed) return { tool: 'update_clip', input: { clipId: i % 2 ? CLIPS.canvas : CLIPS.stateful, start: 0, end: i === 2 || i === 11 ? 2 : 2.5 } };
  if (i % 3 === 2) return { tool: 'update_clip', input: { clipId: CLIPS.stateful, start: 0, end: Number((1.81 + ((moveSeq += 1) % 23) / 20).toFixed(2)) } };
  return { tool: 'update_clip', input: { clipId: CLIPS.bars, params: { rows: rowsOf(salt, i) } } };
}
/** 「发出后退出」的任务:先读、等,再连着写 12 处(连着写的那一段合成一个补渲计划) */
/** 读项目的几种工具轮着用(连着三次一模一样的调用会被驱动的「重复操作」保护停掉) */
const READ_TOOLS = ['list_media', 'get_project', 'list_transitions', 'list_cuts', 'list_media', 'get_project', 'list_transitions', 'list_cuts'];
const leaveScript = (salt) => mockSteps([
  { tool: 'get_project', input: {} }, { sleepMs: 1200 }, { tool: 'list_cuts', input: {} },
  ...Array.from({ length: LEAVE_READS }, (_, k) => [{ sleepMs: LEAVE_WAIT_MS }, { tool: READ_TOOLS[k % READ_TOOLS.length], input: {} }]).flat(),
  ...Array.from({ length: N }, (_, k) => [{ sleepMs: 1200 }, writeStep(k + 1, salt, true)]).flat(),
  { say: '都做完了' },
]);
const writeScript = (n, gapMs, salt, { fixed = false, tail = [{ say: '都做完了' }] } = {}) => mockSteps([...Array.from({ length: n }, (_, k) => [{ sleepMs: gapMs }, writeStep(k + 1, salt, fixed)]).flat(), ...tail]);
const clipIn = (project, id) => project?.tracks?.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
const intact = (project) => !!project && Array.isArray(project.tracks) && Object.values(CLIPS).every((id) => !!clipIn(project, id));
/** 页面里的项目(这个页面经文档服务同步来的那一份)里几样要核对的值 */
const pageProject = (page) => P(page, () => {
  const p = window.__pcStore.getState().project;
  const clip = (id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
  const bars = clip('clip-bars');
  return { id: p.id, title: bars?.params?.title ?? null, rows: bars?.params?.rows ?? null, statefulEnd: clip('clip-stateful')?.end ?? null, canvasEnd: clip('clip-canvas')?.end ?? null, clips: p.tracks.flatMap((t) => t.clips).map((c) => c.id), label: bars?.label ?? null };
}).catch(() => null);

/* ================================================================== 角色 */

async function openBrowser() {
  const b = await launchBrowser();
  browsers.add(b);
  return b;
}
async function closeBrowser(b) {
  if (!b) return;
  browsers.delete(b);
  try { await b.close(); } catch { /* 已关 */ }
  const pid = b.process()?.pid;
  if (pid && alive(pid)) await killBrowser(b);
}
/** 探针自己的一条创建者连接(Node,另一台设备):只在「没有成员在线」的窗口之外用,用完就关 */
async function withCreatorConn(fn) {
  const c = await joinAs(S.DOC_WS, PROJ, { username: CRED.creator.username, password: CRED.creator.password, as: 'creator' });
  if (!c) throw new Error('探针的创建者连接没建成');
  nodeConns.add(c);
  try { return await fn(c); } finally { nodeConns.delete(c); c.close(); }
}

/** 桌面版形态:起一台编辑器进程(同一个数据目录与设备号 = 同一台电脑)。只起进程,还没有任何页面、也没有任何到文档服务的连接 */
async function desktopServer() {
  const desktop = await startDesktop({ port: PORTS.desktop, dir: DESK_DIR, deviceId: DESK_DEVICE, deviceName: 'alice 的电脑' });
  desktops.add(desktop);
  return desktop;
}
/** 桌面版形态:编辑器进程(没给就现起一台)加一个浏览器进程开它的页面 */
async function desktopUp({ open = null, server = null } = {}) {
  const desktop = server ?? await desktopServer();
  const browser = await openBrowser();
  const page = await newPage(browser);
  const q = open ? `nosetup=1&aimock=1&open=${encodeURIComponent(open)}` : 'editor&nosetup=1&aimock=1';
  await page.goto(`${desktop.origin}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]'), { timeout: 300_000, polling: 500 });
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  await page.waitForSelector('[data-pc="ai-provider"]', { timeout: 60_000 }).catch(() => {});
  await gateSettled(page);
  return { desktop, browser, page };
}
/** 真实结束桌面版的发起方:浏览器进程与那台 dev server 进程连同全部子孙 */
async function desktopKill(d) {
  const b = await killBrowser(d.browser);
  browsers.delete(d.browser);
  const k = await killDesktop(d.desktop);
  desktops.delete(d.desktop);
  return { browserPid: b.pid, browserGone: b.gone, serverPids: k.pids.length, serverGone: k.gone, portsFree: k.portsFree };
}
/** 正常关掉桌面版(不是「发起后退出」的那种场合) */
async function desktopDown(d) {
  if (!d) return;
  await closeBrowser(d.browser);
  await killDesktop(d.desktop);
  desktops.delete(d.desktop);
}
/** 在线页面:一个新的浏览器进程(= 一台新设备),填开始页进项目 */
async function onlineUp(who, { asCreator = false, browser = null } = {}) {
  const b = browser ?? await openBrowser();
  const page = await newPage(b);
  await joinOnline(page, { site: S.SITE, name: NAME, username: who.username, password: who.password, asCreator });
  return { browser: b, page };
}
async function selectCloud(page) {
  await until('接入方式里有可选的「云端」', async () => { const o = (await providerOptions(page))?.options.find((x) => x.value === 'cloud'); return o && !o.disabled; }, 30_000, 200);
  if ((await providerOptions(page))?.value !== 'cloud') await page.select('[data-pc="ai-provider"]', 'cloud');
  await page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 });
  await until('云端对话就绪', async () => { const v = await view(page); return v && v.conversationId && (v.connection === 'live' || v.connection === 'idle'); }, 30_000, 100);
}
/** 发一条脚本消息,等界面上出现第 n 个成功的工具结果(任务已被云端接下) */
async function sendAndAccepted(page, prompt, n = 2) {
  const before = toolParts(await msgs(page)).filter((t) => t.ok === true).length;
  await sendText(page, prompt);
  const ok = await until(`界面上出现第 ${n} 个工具结果`, async () => { const m = await msgs(page); return toolParts(m).filter((t) => t.ok === true).length - before >= n && (await view(page))?.streaming ? true : null; }, 60_000, 80);
  return { accepted: !!ok, conversationId: await conversationOf(page) };
}
/** 从历史列表里打开一个云端对话(桌面版与在线页面同一个抽屉) */
async function openFromHistory(page, conversationId) {
  let items = null;
  for (let i = 0; i < 4 && !items; i++) {
    await page.click('[data-pc="ai-history"]').catch(() => {});
    await page.waitForSelector('.chat-history-drawer', { visible: true, timeout: 4000 }).catch(() => null);
    items = await until('历史列表「云端」一组里有对话', () => P(page, () => { const g = document.querySelector('[data-pc="chat-cloud-group"]'); const list = g ? [...g.querySelectorAll('[data-pc="chat-cloud-item"]')] : []; return list.length ? list.map((e) => ({ id: e.getAttribute('data-chat-id'), state: e.getAttribute('data-state'), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) })) : null; }), 8_000, 200);
  }
  const hit = (items ?? []).find((x) => x.id === conversationId) ?? null;
  if (hit) await clickUntil(page, `[data-pc="chat-cloud-item"][data-chat-id="${conversationId}"]`, async () => (await conversationOf(page)) === conversationId && !!(await page.$('[data-pc="cloud-ai-panel"]')));
  else await page.click('.chat-drawer-close-btn').catch(() => {});
  return { items: items ?? [], hit };
}

/* ================================================================== 看云端自己把事做完(不开任何成员连接) */

function watchMembers() {
  const w = { seen: false, samples: 0, stop: () => clearInterval(w.timer) };
  w.timer = setInterval(() => { void S.membersOnline(PID).then((m) => { w.samples += 1; if (m === true) w.seen = true; }).catch(() => {}); }, 500);
  return w;
}
const renderNode = async () => ((await S.renderStatus()).queue?.nodes ?? []).find((n) => n.projectId === PID) ?? null;
/** 等一个对话收尾;`render` 为真再等它引出的补渲有结果。全程只读 Agent 服务盘上的对话记录与渲染服务的诊断 */
async function cloudFinishes(conversationId, { runMs = 120_000, render = true, renderMs = 420_000 } = {}) {
  const t0 = Date.now();
  const done = await until(`对话 ${conversationId} 跑到收尾`, () => { const d = S.diskConversation(PID, conversationId); return d && d.meta.state !== 'running' && d.events.some((e) => e.type === 'end') ? d : null; }, runMs, 200);
  const runMsTook = Date.now() - t0;
  let disk = done;
  if (render && done) {
    disk = await until(`对话 ${conversationId} 的补渲有结果`, () => { const d = S.diskConversation(PID, conversationId); return d && d.events.some((e) => e.type === 'render' && ['done', 'failed', 'unavailable'].includes(e.state)) ? d : null; }, renderMs, 500) ?? S.diskConversation(PID, conversationId);
  }
  const events = disk?.events ?? [];
  return {
    disk, runMs: runMsTook, renderMs: Date.now() - t0,
    toolOk: events.filter((e) => e.type === 'tool_result' && e.ok === true).length,
    renderStates: events.filter((e) => e.type === 'render').map((e) => e.state),
    error: events.find((e) => e.type === 'error') ?? null,
  };
}

/** 播放着看舞台:等到几张重卡同时贴着快照、没有占位的那一刻,当场截图。回 `{ hit, seen, shot, stats }` */
async function playbackSnapshots(page, name, ms = 60_000) {
  const t0 = Date.now();
  const seen = new Set();
  let hit = null;
  let pic = null;
  await gateSettled(page);
  await store(page, 'S.actions.seek(0.2); S.actions.play(); return true;').catch(() => {});
  while (!hit && Date.now() - t0 < ms) {
    const states = {};
    for (const id of HEAVY) states[id] = await clipOnStage(page, id);
    seen.add(HEAVY.map((id) => { const x = states[id]; return !x?.wrapper ? 'none' : x.snapshot ? (x.placeholder ? `snap+ph:${x.reason}` : 'snap') : x.placeholder ? `ph:${x.reason}` : 'live'; }).join('|'));
    if (HEAVY.every((id) => states[id]?.snapshot && !states[id].placeholder)) {
      pic = await stageShot(page, path.join(OUT, `${name}.png`));
      hit = states;
      break;
    }
    const st = await store(page, 'const s = S.getState(); return { t: s.t, playing: s.playing };').catch(() => null);
    if (!st || !st.playing || st.t > 1.6) await store(page, 'S.actions.seek(0.2); S.actions.play(); return true;').catch(() => {});
    await sleep(50);
  }
  await store(page, 'S.actions.pause(); S.actions.seek(1); return true;').catch(() => {});
  if (pic) shots.push(pic.file);
  const stats = pic ? await pixelStats(page.browser(), pic.bytes).catch(() => null) : null;
  return { hit, seen: [...seen], shot: pic?.file ?? null, stats };
}
/** 在线页面此刻有没有「需要本地 PC 渲染辅助」的图标(舞台)或徽标(时间轴) */
async function localPcMarks(page) {
  const badge = await P(page, () => document.querySelectorAll('[data-pc="clip-custom-card"]').length).catch(() => -1);
  let icons = 0;
  for (const id of HEAVY) { const x = await clipOnStage(page, id); if (x?.placeholder && x.reason === 'unsupported') icons += 1; }
  return { badge, icons };
}
const onlineLayers = (page) => P(page, () => { const d = window.__pcOnlineSnapshots?.(); return d ? { layers: d.layers.map((l) => ({ clipId: l.clipId, ready: l.ready, env: l.envFingerprint })), skipped: d.skipped, stale: d.stale.map((s) => s.clipId) } : null; }).catch(() => null);

/* ================================================================== 一遍「发出任务后完全退出」 */

/**
 * `how`:'desktop'(桌面版发起)或 'online'(在线浏览器发起)。`tag` 是断言与截图的前缀。回这段对话的号。
 */
async function leavePass(how, tag, salt) {
  const label = how === 'desktop' ? '桌面版发起' : '在线浏览器发起';
  const filesBefore = S.assetFiles();
  const nodeBefore = await renderNode();

  /* ---- A1:发起、被接下、真实结束发起方 */
  let actor;
  if (how === 'desktop') {
    actor = await desktopUp({ open: PROC_FILE });
    await until(`${tag}:桌面版回到这个共享项目`, async () => (await sharedProjectOf(actor.page)) === PID, 120_000, 500);
  } else {
    actor = await onlineUp(CRED.creator, { asCreator: true });
  }
  await selectCloud(actor.page);
  const t0 = Date.now();
  const sent = await sendAndAccepted(actor.page, leaveScript(salt), 2);
  timings[`${tag}.acceptedMs`] = Date.now() - t0;
  const conv = sent.conversationId;
  const seenBeforeLeaving = toolParts(await msgs(actor.page)).length;
  const stopBtn = !!(await actor.page.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]'));
  const note = (await panelText(actor.page)).includes('在云端运行,关闭后继续');
  await shot(actor.page, `${tag}-1-accepted`);
  let gone;
  if (how === 'desktop') {
    const k = await desktopKill(actor);
    gone = { ok: k.browserGone && k.serverGone && k.portsFree, ...k };
  } else {
    const k = await killBrowser(actor.browser);
    browsers.delete(actor.browser);
    gone = { ok: k.gone, browserPid: k.pid, browserGone: k.gone };
  }
  const tGone = Date.now();
  /** 这个对话里已经落地的写入数(只数改项目的工具) */
  const okNow = () => (S.diskConversation(PID, conv)?.events ?? []).filter((e) => e.type === 'tool_result' && e.ok === true && e.name === 'update_clip').length;
  const landedAtLeave = okNow();
  // 发起方的进程已经没了;文档服务把它断掉的会话保留 60 秒,期满后才算「没有成员连接」
  const offline = await until(`${tag}:文档服务里没有任何成员连接(断掉的会话保留期满)`, async () => (await S.membersOnline(PID)) === false, RETAIN_MS + 40_000, 300);
  const offlineAfterMs = Date.now() - tGone;
  const landedAtOffline = okNow();
  timings[`${tag}.membersGoneAfterMs`] = offlineAfterMs;
  check(`${tag} A1 ${label}:任务被云端接下(界面上已有 2 个工具结果、有「停止」与「在云端运行」的说明)后,发起方被真的结束;它断掉的会话保留期满后,项目里没有任何成员连接`, sent.accepted && stopBtn && note && gone.ok && !!offline && landedAtOffline === 0, {
    accepted: sent.accepted, toolCallsSeenBeforeLeaving: seenBeforeLeaving, stopButton: stopBtn, cloudNote: note, initiator: gone, membersGoneAfterMs: offlineAfterMs, writesLanded: { whenInitiatorKilled: landedAtLeave, whenNoMemberConnection: landedAtOffline },
  });

  /* ---- A2、A3:之后只看 Agent 服务与渲染服务自己报的 */
  const watch = watchMembers();
  const fin = await cloudFinishes(conv, { runMs: 240_000 });
  watch.stop();
  timings[`${tag}.runMs`] = fin.runMs;
  timings[`${tag}.renderedMs`] = fin.renderMs;
  const writesLanded = okNow();
  check(`${tag} A2 发起方不在了,对话照样跑到结束;12 次写入全部落在已经没有任何成员连接之后、逐次落地,此后 members 恒为假`, fin.disk?.meta?.state === 'idle' && fin.toolOk === LEAVE_TOOLS && writesLanded === N && landedAtOffline === 0 && watch.seen === false && watch.samples > 5, {
    state: fin.disk?.meta?.state ?? null, toolCallsOk: fin.toolOk, writesLanded, writesAfterInitiatorKilled: writesLanded - landedAtLeave, writesAfterNoMemberConnection: writesLanded - landedAtOffline, membersEverOnlineAfterThat: watch.seen, samples: watch.samples, lastSeq: fin.disk?.meta?.lastSeq ?? null,
  });
  const nodeAfter = await renderNode();
  const filesAfter = S.assetFiles();
  check(`${tag} A3 被改动的重卡由云节点的渲染服务渲出来、产物入库(全程没有成员在线)`, fin.renderStates.includes('published') && fin.renderStates.at(-1) === 'done' && (nodeAfter?.completed ?? 0) > (nodeBefore?.completed ?? 0) && (nodeAfter?.failed ?? 0) === (nodeBefore?.failed ?? 0) && filesAfter > filesBefore && watch.seen === false, {
    renderEvents: fin.renderStates, renderNode: { completed: [nodeBefore?.completed ?? 0, nodeAfter?.completed ?? 0], failed: [nodeBefore?.failed ?? 0, nodeAfter?.failed ?? 0] }, assetFiles: [filesBefore, filesAfter], renderedMs: fin.renderMs, membersEverOnline: watch.seen,
  });

  /* ---- A4、A5:另一位成员从在线浏览器进项目 */
  const bob = await onlineUp(CRED.bob);
  const want = { title: `${salt} 第 10 次:改文案`, rows: rowsOf(salt, 12), statefulEnd: 2.5, canvasEnd: 2 };
  const got = await until(`${tag}:bob 的页面读到最新的项目`, async () => { const p = await pageProject(bob.page); return p && p.rows === want.rows ? p : null; }, 30_000, 200);
  const log = await until(`${tag}:bob 的「Agent 操作记录」里这一轮的工具调用都在`, async () => { const l = await eventLog(bob.page); return l && l.rows.length > 0 && l.count >= LEAVE_TOOLS ? l : null; }, 20_000, 200);
  const whos = [...new Set((log?.rows ?? []).map((r) => r.who))];
  check(`${tag} A4 另一位成员从在线浏览器进项目:项目是改动之后的样子,「Agent 操作记录」里每一步的署名是「${CREATOR_SIGN}」`, !!got && got.title === want.title && got.statefulEnd === want.statefulEnd && got.canvasEnd === want.canvasEnd && !!log && whos.length === 1 && whos[0] === CREATOR_SIGN, {
    project: got, eventLog: log ? { count: log.count, shown: log.rows.length, who: whos, tools: [...new Set(log.rows.map((r) => r.tool))] } : null,
  });
  await shot(bob.page, `${tag}-2-bob-sees-changes`);
  const play = await playbackSnapshots(bob.page, `${tag}-3-bob-stage-prerendered`);
  const marks = await localPcMarks(bob.page);
  const layers = await onlineLayers(bob.page);
  const heavyLayers = (layers?.layers ?? []).filter((l) => HEAVY.includes(l.clipId));
  const renderFp = S.renderFingerprint;
  check(`${tag} A5 他的舞台上是渲好的预渲染结果:播放时两张重卡都贴着快照、没有占位,没有「需要本地 PC 渲染辅助」;这几层是云节点渲染服务渲的;画面不是空白`, !!play.hit && marks.badge === 0 && marks.icons === 0
    && HEAVY.every((id) => heavyLayers.some((l) => l.clipId === id && l.ready > 0)) && (!renderFp || heavyLayers.every((l) => l.env === renderFp)) && !!play.stats && play.stats.colors >= 3 && play.stats.topShare < 0.985, {
    stage: play.hit ? Object.fromEntries(HEAVY.map((id) => [id, { snapshot: play.hit[id].snapshot, snapNodes: play.hit[id].snapNodes, placeholder: play.hit[id].placeholder }])) : null,
    statesSeenWhilePlaying: play.seen, localPcBadges: marks.badge, localPcIcons: marks.icons, layers: heavyLayers, renderServiceFingerprint: renderFp ?? null, pixels: play.stats, shot: play.shot,
  });

  /* ---- A6、A7:创建者重新打开(新进程) */
  let back;
  if (how === 'desktop') {
    back = await desktopUp({ open: PROC_FILE });
    await until(`${tag}:重新打开后回到同一个共享项目`, async () => (await sharedProjectOf(back.page)) === PID, 120_000, 500);
  } else {
    back = await onlineUp(CRED.creator, { asCreator: true });
  }
  // 「云端」一项要等成员列表到了才出现(文档服务在里面报 Agent 服务在哪)
  await until(`${tag}:重新打开后接入方式里有「云端」`, async () => (await providerOptions(back.page))?.options.some((o) => o.value === 'cloud'), 30_000, 200);
  const provider = await providerOptions(back.page);
  const sameProject = how === 'desktop' ? (await sharedProjectOf(back.page)) === PID : (await P(back.page, () => window.__pcStore.getState().project.name)) === NAME;
  const opened = await openFromHistory(back.page, conv);
  const full = await until(`${tag}:点开后完整过程都在`, async () => { const m = await msgs(back.page); return m && toolParts(m).length === LEAVE_TOOLS && (lastAssistant(m)?.text ?? '').includes('都做完了') ? m : null; }, 30_000, 200);
  const a = lastAssistant(full);
  const renderNote = await back.page.$eval('[data-pc="cloud-ai-panel"] [data-pc="cloud-render-note"]', (el) => el.textContent ?? '').catch(() => null);
  const mine = await pageProject(back.page);
  let prerender;
  if (how === 'desktop') {
    // 桌面版自己不靠层表看画面;这里只核对云端渲好的层表在文档服务里(经这个页面自己的连接取)
    const map = await P(back.page, async () => { const M = await import('/src/editor/sync/syncManager.ts'); const id = window.__pcStore.getState().project.id; const r = await M.currentSharedLink().request({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${id}` }); return { key: `layers:${id}`, found: r.type === 'content.item' && !r.missing, layers: Array.isArray(r.body?.layers) ? r.body.layers.map((l) => l.clipId) : [] }; }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
    prerender = { ok: map.found === true && HEAVY.every((id) => map.layers.includes(id)), layerMap: map };
  } else {
    const p2 = await playbackSnapshots(back.page, `${tag}-5-creator-stage-prerendered`);
    prerender = { ok: !!p2.hit, statesSeenWhilePlaying: p2.seen, pixels: p2.stats };
  }
  check(`${tag} A6 创建者重新打开(新进程):回到同一个项目,历史里找得到这段对话,完整过程与结果都在,项目是最新版本,预渲染结果已在`, sameProject && !!opened.hit && opened.hit.state === 'idle' && !!full && full.filter((x) => x.role === 'user').length === 1
    && toolParts(full).every((t) => t.ok === true) && (a?.statuses ?? []).some((s) => /云端渲染完成/.test(s)) && /云端渲染完成/.test(String(renderNote ?? '')) && mine?.rows === want.rows && mine?.title === want.title && prerender.ok
    && (how === 'desktop' ? provider?.value !== 'cloud' && provider?.options.some((o) => o.value === 'cloud') : provider?.value === 'cloud'), {
    sameProject, providerOnOpen: provider?.value ?? null, listed: opened.hit, conversations: opened.items.length, toolCalls: toolParts(full).length, users: full?.filter((x) => x.role === 'user').length ?? null,
    allToolCallsOk: toolParts(full).every((t) => t.ok === true), notOk: toolParts(full).filter((t) => t.ok !== true).map((t) => [t.name, t.ok ?? null]).slice(0, 6), providerOptions: provider?.options.map((o) => o.value) ?? null,
    reply: (a?.text ?? '').slice(0, 40), renderStatus: (a?.statuses ?? []).filter((s) => /渲染/.test(s)), renderNoteShown: renderNote, project: mine, prerender,
  });
  await shot(back.page, `${tag}-4-creator-reopened`);
  // 撤销 Agent 的最后一处改动(第 12 次写入:rows 回到第 9 次的值)
  const logBack = await until(`${tag}:创建者的「Agent 操作记录」里有可撤销的步骤`, async () => { const l = await eventLog(back.page); return l && l.rows.some((r) => r.undo === 'ready') ? l : null; }, 20_000, 200);
  const target = logBack?.rows.find((r) => r.undo === 'ready') ?? null;
  if (target) await clickUntil(back.page, `[data-pc="agent-event"][data-event-id="${target.id}"] [data-pc="agent-undo"]:not([disabled])`, async () => (await eventLog(back.page))?.rows.find((r) => r.id === target.id)?.undo === 'done');
  const undoneMine = await until(`${tag}:撤销后创建者页面里参数回到上一次的值`, async () => ((await pageProject(back.page))?.rows === rowsOf(salt, 9) ? true : null), 10_000, 150);
  const undoneBob = await until(`${tag}:bob 的页面也看到撤销的结果`, async () => ((await pageProject(bob.page))?.rows === rowsOf(salt, 9) ? true : null), 10_000, 150);
  const rowAfter = (await eventLog(back.page))?.rows.find((r) => r.id === target?.id) ?? null;
  const titleKept = (await pageProject(bob.page))?.title === want.title;
  check(`${tag} A7 「撤销这步」撤掉 Agent 的最后一处改动:参数回到上一次的值、按钮变成「已撤销」;别的成员看到撤销的结果,别的改动还在`, !!target && !!undoneMine && !!undoneBob && rowAfter?.undo === 'done' && titleKept, {
    undone: target ? { tool: target.tool, who: target.who } : null, button: rowAfter?.undo ?? null, creatorSees: !!undoneMine, otherMemberSees: !!undoneBob, otherChangesKept: titleKept,
    signOnCreatorPage: [...new Set((logBack?.rows ?? []).map((r) => r.who))],
  });
  await shot(back.page, `${tag}-6-creator-undone`);
  const errors = [...(bob.page.pageErrors ?? []), ...(back.page.pageErrors ?? [])];
  check(`${tag} 这一遍的页面没有页面错误`, errors.length === 0, { sample: errors.slice(0, 3) });

  if (how === 'desktop') await desktopDown(back); else await closeBrowser(back.browser);
  await closeBrowser(bob.browser);
  return conv;
}

/* ================================================================== 主流程 */

async function setup() {
  S = await startStack({ tmp: TMP, ports: PORTS, dist: arg('--dist', null), say });
  S.startRender();
  const ready = await S.waitRenderReady();
  const agentHealth = await (await fetch(`${S.AGENT_DIRECT}/healthz`)).json();
  const renderVersion = String(ready.queue.codeVersion ?? '');
  // 在线页面把代码版本嵌在构建产物里(发布清单计划时写进 requires.codeVersion):在产物里找渲染服务的那一串
  let pageHasVersion = false;
  const walk = (dir) => { for (const i of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, i.name); if (i.isDirectory()) walk(p); else if (!pageHasVersion && /\.(m?js|html)$/.test(i.name) && fs.readFileSync(p, 'utf8').includes(renderVersion)) pageHasVersion = true; } };
  if (/^[0-9a-f]{64}$/.test(renderVersion)) walk(S.DIST);
  S.renderFingerprint = ready.queue.envFingerprint ?? ready.queue.fingerprint ?? ready.worker?.fingerprint ?? null;
  check('X0 三个服务起来;渲染服务、Agent 服务、在线页面的代码版本相同(同一份代码)', /^[0-9a-f]{64}$/.test(renderVersion) && agentHealth.codeVersion === renderVersion && pageHasVersion, {
    renderCodeVersion: renderVersion.slice(0, 12), agentCodeVersion: String(agentHealth.codeVersion).slice(0, 12), onlineBuildEmbedsIt: pageHasVersion, agentAuth: S.agent.ready?.auth ?? null, renderFingerprint: S.renderFingerprint,
  });

  /* ---- 创建者在桌面版形态的页面里建项目、放云端(限定进入:bob、carol) */
  const d = await desktopUp();
  const made = await P(d.page, async (o) => {
    const [St, C] = await Promise.all([import('/src/store/project.ts'), import('/src/editor/sync/collab.ts')]);
    St.actions.newProject(o.name);
    St.actions.editCardProject((p) => ({
      ...p, width: 1920, height: 1080, fps: 30, duration: 3,
      tracks: [
        { id: 'tr-0', name: '图表', hidden: false, clips: [{ id: 'clip-bars', kind: 'card', cardId: 'rank-bars', start: 0, end: 3, params: { title: '原文案', rows: '微信,85|抖音,62', suffix: '%' } }] },
        { id: 'tr-1', name: '重卡甲', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'probe-slow-stepped', start: 0, end: 3, params: { burnMs: 40, label: '重卡甲' } }] },
        { id: 'tr-2', name: '重卡乙', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'probe-slow-stepped', start: 0, end: 3, params: { burnMs: 40, label: `重卡乙 ${o.salt}` } }] },
      ],
    }));
    St.actions.seek(0);
    return C.enableCollab({ where: 'hosted', mode: 'restricted', name: o.name, creator: o.creator, list: o.list, hostedUrl: o.hostedUrl });
  }, { name: NAME, salt: SALT, creator: CRED.creator, list: [CRED.bob, CRED.carol], hostedUrl: S.HOSTED_URL });
  if (!made?.ok) throw new Error(`桌面页面开启多用户协作没成:${JSON.stringify(made).slice(0, 200)}`);
  PID = (await lookupProject({ base: S.HOSTED_URL, name: NAME })).projectId;
  PROJ = { projectId: PID, creator: CRED.creator };
  await until('桌面页面连上这个共享项目', async () => (await sharedProjectOf(d.page)) === PID, 60_000, 300);
  // 项目文件(带协作关联):重新打开软件时按它回到同一个项目
  const text = await P(d.page, async () => { const [Sy, Pr] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts')]); await Sy.whenSaved(); return Pr.serializeProc(); });
  PROC_FILE = path.join(TMP, `${NAME}.proc`);
  fs.writeFileSync(PROC_FILE, text);
  // 项目设置里的「云端 Agent」开关
  await openProjectSettings(d.page);
  const row = await until('项目设置里出现「云端 Agent」一行', () => hostedToggle(d.page, 'agent'), 15_000, 200);
  const renderRow = await hostedToggle(d.page, 'render');
  check('X0 项目放云端:项目设置里有「云端 Agent」一行(与「托管方的渲染节点」放在一起),缺省勾上、创建者可改', !!row && row.checked && !row.disabled && !!renderRow && renderRow.checked, { agent: row, render: renderRow });
  await shot(d.page, 'X0-desktop-settings');
  await closeDialogs(d.page);
  const cloudOpt = await until('接入方式里出现「云端」', async () => (await providerOptions(d.page))?.options.find((o) => o.value === 'cloud'), 30_000, 200);
  check('X0 桌面版的 AI 栏里多了「云端」,本机驱动仍是缺省', !!cloudOpt && !cloudOpt.disabled && (await providerOptions(d.page)).value !== 'cloud', { option: cloudOpt ?? null, selected: (await providerOptions(d.page))?.value ?? null });
  await desktopDown(d);
}

async function stopStep() {
  const tag = 'S';
  const salt = `${SALT}-s`;
  /* ---- B1:桌面版发起更长的任务后退出;bob 之后进来看着 */
  const d1 = await desktopUp({ open: PROC_FILE });
  await until('S:桌面版回到这个共享项目', async () => (await sharedProjectOf(d1.page)) === PID, 120_000, 500);
  await selectCloud(d1.page);
  // 22 次写入、每次隔 8 秒(一轮最多 24 次模型往返),整轮约 3 分钟:够发起方断掉的会话保留期满、另一位成员看一会儿、创建者再重新打开软件接上
  const sent = await sendAndAccepted(d1.page, writeScript(22, 8000, salt), 2);
  const conv = sent.conversationId;
  const k = await desktopKill(d1);
  const tGone = Date.now();
  // 创建者那台电脑上的软件进程先起来(还没开页面、没有任何连接),省下后面等它启动的时间
  const server2 = await desktopServer();
  const bob = await onlineUp(CRED.bob);
  const counts = [];
  const signs = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    const l = await eventLog(bob.page);
    if (l) { if (counts.at(-1) !== l.count) counts.push(l.count); for (const r of l.rows.slice(0, 3)) signs.add(r.who); }
    await sleep(250);
  }
  // 创建者断掉的会话保留期满之后,成员列表里他那一行只剩云端 Agent
  let mem = null;
  let aliceRow = null;
  while (Date.now() - tGone < RETAIN_MS + 40_000) {
    mem = await membersList(bob.page);
    const mine = (mem?.rows ?? []).filter((r) => r.cloudTag);
    aliceRow = mine.find((r) => !r.editing) && mine.every((r) => !r.editing) ? mine[0] : null;
    if (aliceRow) break;
    await sleep(2000);
  }
  check('S B1 发起方退出后,另一位成员从在线浏览器进项目看着:改动一条条出现,署名是创建者的云端 Agent;成员列表里创建者名下有云端 Agent 而他本人不在线', sent.accepted && k.browserGone && k.serverGone
    && counts.length >= 3 && counts.every((c, i) => i === 0 || c > counts[i - 1]) && signs.size === 1 && signs.has(CREATOR_SIGN)
    && !!aliceRow && aliceRow.cloudRow === CREATOR_SIGN && !aliceRow.editing && !(mem?.rows ?? []).some((r) => r.editing && !/自己/.test(r.text)), {
    initiatorGone: k.browserGone && k.serverGone, eventLogCountsOverTime: counts, sign: [...signs], members: { button: mem?.button, rows: mem?.rows.map((r) => r.text.slice(0, 70)) },
  });
  await shot(bob.page, 'S-1-bob-watching');

  /* ---- B2:创建者重新打开桌面版(同一台设备、新进程),接上、停掉 */
  const d2 = await desktopUp({ open: PROC_FILE, server: server2 });
  await until('S:重新打开后回到共享项目', async () => (await sharedProjectOf(d2.page)) === PID, 120_000, 500);
  const banner = await until('S:本机模式下出现「云端有一个对话正在进行」', () => d2.page.$('[data-pc="cloud-running-banner"]'), 40_000, 200);
  const providerOnOpen = (await providerOptions(d2.page))?.value ?? null;
  await shot(d2.page, 'S-2-creator-reopened-banner');
  if (banner) await d2.page.click('[data-pc="cloud-running-banner"] button');
  await d2.page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 }).catch(() => {});
  const attached = await until('S:接上还在跑的对话', async () => { const v = await view(d2.page); const m = await msgs(d2.page); return v?.streaming && v.conversationId === conv && toolParts(m).length >= 2 ? { tools: toolParts(m).length } : null; }, 30_000, 100);
  const tools1 = toolParts(await msgs(d2.page)).length;
  await sleep(9500);
  const tools2 = toolParts(await msgs(d2.page)).length;
  const tStop = Date.now();
  await d2.page.click('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]').catch(() => {});
  const stopped = await until('S:点「停止」后 5 秒内停下', () => idle(d2.page), 5_000, 50);
  const stopMs = Date.now() - tStop;
  const aStop = lastAssistant(await msgs(d2.page));
  const diskStop = S.diskConversation(PID, conv);
  const p1 = await pageProject(bob.page);
  await sleep(1500);
  const p2 = await pageProject(bob.page);
  const okWrites = (diskStop?.events ?? []).filter((e) => e.type === 'tool_result' && e.ok === true).length;
  check('S B2 创建者重新打开桌面版(新进程):AI 栏仍是本机驱动,出现「云端有一个对话正在进行」,接上后接着看得到过程;点「停止」5 秒内停下,记录里是已停止,之后项目不再变', !!banner && providerOnOpen !== 'cloud'
    && !!attached && tools2 > tools1 && !!stopped && stopMs < 5000 && aStop?.outcome === 'aborted' && diskStop?.meta?.state === 'idle' && diskStop.meta.reason === 'stopped' && okWrites >= 2 && okWrites < 22 && JSON.stringify(p1) === JSON.stringify(p2), {
    providerOnOpen, attachedWithToolCalls: attached?.tools ?? null, toolCallsWhileWatching: [tools1, tools2], stopMs, outcome: aStop?.outcome ?? null, recorded: diskStop ? { state: diskStop.meta.state, reason: diskStop.meta.reason } : null, writesLanded: okWrites, quietAfter: JSON.stringify(p1) === JSON.stringify(p2),
  });
  await shot(d2.page, 'S-3-creator-stopped');

  /* ---- B3:另一台设备(在线页面、新的浏览器进程、同一创建者身份)打开同一个对话,接着看、接着说 */
  const other = await onlineUp(CRED.creator, { asCreator: true });
  const opened = await openFromHistory(other.page, conv);
  const seen = await until('S:另一台设备上看得到同一个对话的过程', async () => { const m = await msgs(other.page); return m && toolParts(m).length === toolParts(await msgs(d2.page)).length && toolParts(m).length >= 2 ? m : null; }, 30_000, 200);
  const stoppedThere = lastAssistant(seen)?.outcome === 'aborted';
  await sendText(other.page, mockSteps([{ tool: 'update_clip', input: { clipId: CLIPS.bars, label: '换了设备接着说' } }, { say: '在另一台设备上接着说的' }]));
  const said = await until('S:另一台设备上接着说的这一轮跑完', async () => { const m = await msgs(other.page); const a2 = lastAssistant(m); return a2 && !a2.pending && (a2.text ?? '').includes('在另一台设备上接着说的') ? m : null; }, 40_000, 150);
  const deskSees = await until('S:桌面版开着的同一个对话也看到这一轮', async () => { const m = await msgs(d2.page); return (lastAssistant(m)?.text ?? '').includes('在另一台设备上接着说的') ? m : null; }, 20_000, 200);
  const labelBob = await until('S:改动落地(bob 的页面看到)', async () => ((await pageProject(bob.page))?.label === '换了设备接着说' ? true : null), 10_000, 150);
  check('S B3 另一台设备(另一个浏览器进程与设备号、同一创建者身份)打开同一个对话:过程都在、是已停止的;接着说一句,新的一轮正常跑完、改动落地;桌面版那边的同一个对话也看到', !!opened.hit && !!seen && stoppedThere && !!said
    && said.filter((x) => x.role === 'user').length === 2 && !!deskSees && deskSees.filter((x) => x.role === 'user').length === 2 && !!labelBob, {
    listed: opened.hit, toolCallsSeen: seen ? toolParts(seen).length : null, stoppedShown: stoppedThere, continued: !!said, userMessages: said?.filter((x) => x.role === 'user').length ?? null, desktopSeesNewRun: !!deskSees, changeLanded: !!labelBob,
  });
  await shot(other.page, 'S-4-other-device-continued');
  await closeBrowser(other.browser);
  await desktopDown(d2);
  await closeBrowser(bob.browser);
}

async function errorsStep() {
  /** 项目内容与版本号(探针自己的创建者连接;这一步不要求「没有成员在线」) */
  const snap = () => withCreatorConn(async (c) => { const p = await projectOf(c, PID); return { rev: p.rev, project: p.project }; });
  const quiet = async () => { const a = (await snap()).rev; await sleep(1500); return (await snap()).rev === a; };
  const sane = async (before, okWrites) => { const calm = await quiet(); const after = await snap(); return { ok: after.rev === before.rev + okWrites && calm && intact(after.project), rev: [before.rev, after.rev], noWritesAfter: calm, projectIntact: intact(after.project) }; };
  /** 这个对话里序号大于 `after` 的成功写入数(同一个对话连着跑几轮时,只数这一轮的) */
  const okOf = (conv, after = 0) => (S.diskConversation(PID, conv)?.events ?? []).filter((e) => e.type === 'tool_result' && e.ok === true && e.seq > after).length;
  const seqOf = (conv) => S.diskConversation(PID, conv)?.meta?.lastSeq ?? 0;
  const errText = async (page) => { const a = lastAssistant(await msgs(page)); return { outcome: a?.outcome ?? null, error: a?.error ?? null, statuses: a?.statuses ?? [] }; };

  /* ---- E1:模型调用失败。发起方发完就被结束,事后重新打开看 */
  {
    const before = await snap();
    const c1 = await onlineUp(CRED.creator, { asCreator: true });
    await selectCloud(c1.page);
    await sendText(c1.page, mockSteps([{ sleepMs: 600 }, writeStep(1, 'm'), { sleepMs: 600 }, writeStep(4, 'm'), { sleepMs: 1500 }, { fail: '上游接口 500(探针注入)' }, writeStep(7, 'm')]));
    await until('E1:消息发出、这一轮开始', async () => (await view(c1.page))?.streaming, 15_000, 50);
    const conv = await conversationOf(c1.page);
    const k = await killBrowser(c1.browser);
    browsers.delete(c1.browser);
    await until('E1:这一轮收尾', () => { const d = S.diskConversation(PID, conv); return d && d.meta.state !== 'running' ? d : null; }, 60_000, 200);
    const s = await sane(before, 2);
    const c2 = await onlineUp(CRED.creator, { asCreator: true });
    const opened = await openFromHistory(c2.page, conv);
    await until('E1:重新打开后对话里有这一轮', async () => { const a = lastAssistant(await msgs(c2.page)); return a && !a.pending ? a : null; }, 30_000, 200);
    const e = await errText(c2.page);
    const text = await panelText(c2.page);
    check('E1 模型调用失败(发起方已退出,重新打开看):对话记录里有「模型调用失败」与接口给的原因,历史列表里标「出错」;项目停在失败前最后一次成功写入', k.gone && e.outcome === 'error' && /模型调用失败/.test(e.error ?? '') && /上游接口 500/.test(e.error ?? '') && text.includes('模型调用失败')
      && opened.hit?.state === 'failed' && /出错/.test(opened.hit.text) && s.ok && okOf(conv) === 2, { initiatorGone: k.gone, shown: e.error, listed: opened.hit, writesLanded: okOf(conv), ...s });
    await shot(c2.page, 'E1-model-failed');
    await closeBrowser(c2.browser);
  }

  // 后面三种都在创建者的同一个在线页面里做(页面开着,原因当场出现在对话里)
  const c = await onlineUp(CRED.creator, { asCreator: true });
  await selectCloud(c.page);
  const admin = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'agent-service', 'admin.mjs'), ...a], { cwd: ROOT, env: { ...process.env, PROMPTCUT_AGENT_DATA: S.D.agent }, windowsHide: true, encoding: 'utf8' });
  const runAndWait = async (prompt, ms = 60_000) => {
    const convBefore = await conversationOf(c.page);
    const usersBefore = ((await msgs(c.page)) ?? []).filter((x) => x.role === 'user').length;
    await sendText(c.page, prompt);
    // 有的轮一开始就收尾(额度用尽):看的是「对话里多了一条用户消息」,不是「此刻还在跑」
    await until('这一轮开始', async () => ((await msgs(c.page)) ?? []).filter((x) => x.role === 'user').length > usersBefore, 15_000, 50);
    await until('这一轮收尾', () => idle(c.page), ms, 100);
    return convBefore;
  };

  /* ---- E2:额度用尽 */
  {
    const before = await snap();
    const used = await withCreatorConn(async (conn) => (await agentApi(S.AGENT_DIRECT, conn).call('GET', '/v1/usage')).project?.tokens ?? 0);
    const set = admin('quota', 'set', PID, '--tokens', String(used + 1));
    await sleep(400);
    const conv = await runAndWait(mockSteps([writeStep(1, 'q'), { sleepMs: 300 }, writeStep(4, 'q'), writeStep(7, 'q'), { say: '不会到' }]));
    const e = await errText(c.page);
    const s = await sane(before, okOf(conv));
    // 再发:被明确拒绝并说明
    await sendText(c.page, mockSteps([{ say: 'x' }]));
    const notice = await until('E2:再发被拒绝并说明', () => c.page.$eval('[data-pc="cloud-notice"]', (el) => el.textContent ?? '').catch(() => null), 10_000, 100);
    admin('quota', 'clear', PID);
    await sleep(400);
    await c.page.click('[data-pc="cloud-notice"]').catch(() => {});
    await sendText(c.page, mockSteps([{ say: '额度清掉后恢复' }]));
    const again = await until('E2:清掉额度后恢复', async () => (lastAssistant(await msgs(c.page))?.text ?? '').includes('额度清掉后恢复'), 30_000, 150);
    check('E2 额度用尽:对话记录里有带已用与上限的原因,已落地的保留;再发被明确拒绝并说明;清掉额度后恢复', set.status === 0 && e.outcome === 'error' && /额度已用完\(已用 \d+ \/ 上限 \d+\)/.test(e.error ?? '') && okOf(conv) >= 1 && okOf(conv) < 3 && s.ok && /额度/.test(String(notice ?? '')) && !!again, {
      shown: e.error, writesLanded: okOf(conv), ...s, nextRequestNotice: notice, afterClear: !!again,
    });
    await shot(c.page, 'E2-quota-exceeded');
  }

  /* ---- E3:创建者中途关了开关(在项目设置里取消勾选) */
  {
    await until('E3:上一轮收尾', () => idle(c.page), 20_000, 100);
    const before = await snap();
    const conv = await conversationOf(c.page);
    const mark = seqOf(conv);
    await sendText(c.page, writeScript(30, 500, 'sw'));
    await until('E3:这一轮开始并有写入', async () => okOf(conv, mark) >= 1 && (await view(c.page))?.streaming, 20_000, 80);
    await openProjectSettings(c.page);
    await creatorToggleService(c.page, 'agent', CRED.creator.password);
    const off = await until('E3:勾选取消', async () => (await hostedToggle(c.page, 'agent'))?.checked === false, 8_000, 150);
    await closeDialogs(c.page);
    await until('E3:进行中的对话被停下', () => idle(c.page), 10_000, 50);
    const e = await errText(c.page);
    const banner = await c.page.$eval('[data-pc="cloud-off"]', (el) => el.textContent ?? '').catch(() => null);
    const landed = okOf(conv, mark);
    const s = await sane(before, landed);
    const disk = S.diskConversation(PID, conv);
    await shot(c.page, 'E3-switched-off');
    await openProjectSettings(c.page);
    await creatorToggleService(c.page, 'agent', CRED.creator.password);
    await until('E3:勾回来', async () => (await hostedToggle(c.page, 'agent'))?.checked === true, 8_000, 150);
    await closeDialogs(c.page);
    await until('E3:「已关闭」的说明撤掉', async () => !(await c.page.$('[data-pc="cloud-off"]')), 8_000, 100);
    await sendText(c.page, mockSteps([{ say: '开关打开后恢复' }]));
    const again = await until('E3:开关打开后恢复', async () => (lastAssistant(await msgs(c.page))?.text ?? '').includes('开关打开后恢复'), 30_000, 150);
    check('E3 创建者中途关了开关(项目设置里取消勾选「云端 Agent」):进行中的对话被停下,记录里写明原因,AI 栏说明已关闭;项目停在完好的版本上;勾回来恢复', !!off && e.outcome === 'error' && /已关闭云端 Agent/.test(e.error ?? '') && /项目创建者已关闭云端 Agent/.test(String(banner ?? ''))
      && disk?.meta?.state === 'revoked' && disk.meta.reason === 'disabled' && landed >= 1 && landed < 30 && s.ok && !!again, { shown: e.error, banner, recorded: disk ? { state: disk.meta.state, reason: disk.meta.reason } : null, writesLanded: landed, ...s, afterReenable: !!again });
  }

  /* ---- E4:渲染失败(渲染服务停着;Agent 服务重起一遍,把补渲「连续没有进度就放弃」的时限缩短) */
  {
    await until('E4:上一轮收尾', () => idle(c.page), 20_000, 100);
    await S.stopRender();
    await S.bootAgent({ PROMPTCUT_AGENT_RENDER_STALL_MS: String(RENDER_STALL_MS) });
    const before = await snap();
    await sleep(1500);
    await c.page.click('[data-pc="cloud-notice"]').catch(() => {});
    let conv = null;
    const mark = seqOf(await conversationOf(c.page));
    // Agent 服务刚重起:页面的事件流在重连,第一次发送可能撞上;发不出去就再发一次
    for (let i = 0; i < 3 && !conv; i++) {
      // 这一轮很短:看的是「对话里多了一条用户消息」(服务端收下了),不是「此刻还在跑」
      const usersBefore = ((await msgs(c.page)) ?? []).filter((x) => x.role === 'user').length;
      await sendText(c.page, mockSteps([writeStep(3, `rf${i}`), { sleepMs: 200 }, writeStep(2, `rf${i}`), { say: '改完了,渲染节点不在' }]));
      const started = await c.page.waitForFunction((n) => (window.__pcCloud?.main?.messages() ?? []).filter((x) => x.role === 'user').length > n, { timeout: 8000 }, usersBefore).then(() => true, () => false);
      if (started) conv = await conversationOf(c.page); else { await c.page.click('[data-pc="cloud-notice"]').catch(() => {}); await sleep(1500); }
    }
    await until('E4:对话照常做完', async () => { const a = lastAssistant(await msgs(c.page)); return a && !a.pending && (a.text ?? '').includes('改完了'); }, 40_000, 150);
    const failed = await until('E4:对话记录里出现「云端渲染失败」', async () => { const a = lastAssistant(await msgs(c.page)); return (a?.statuses ?? []).find((x) => /云端渲染失败/.test(x)) ?? null; }, RENDER_STALL_MS * 4 + 30_000, 300);
    // 气泡末尾常驻的那一行(简洁模式也看得到)
    const note = await until('E4:气泡末尾出现渲染失败的那一行', () => c.page.$eval('[data-pc="cloud-ai-panel"] [data-pc="cloud-render-note"][data-state="failed"]', (el) => el.textContent ?? '').catch(() => null), 10_000, 200);
    const s = await sane(before, 2);
    const e = await errText(c.page);
    check('E4 渲染失败(渲染服务停着):对话照常做完,对话记录里有「云端渲染失败」与原因;项目内容不受影响', !!conv && e.outcome !== 'error' && typeof failed === 'string' && /云端渲染失败:.+/.test(failed) && /云端渲染失败:.+/.test(String(note ?? '')) && okOf(conv, mark) === 2 && s.ok, {
      shown: note, outcome: e.outcome, writesLanded: conv ? okOf(conv, mark) : null, ...s,
      note: `渲染服务被探针停掉;补渲「连续没有进度」的时限在这次演练里缩成 ${RENDER_STALL_MS / 1000} 秒(生产 10 分钟,原因文字是固定的那一句)`,
    });
    await shot(c.page, 'E4-render-failed');
  }
  await closeBrowser(c.browser);

  /* ---- E5:发起成员中途被移出(carol;创建者从另一台设备改名单) */
  {
    const before = await snap();
    const carol = await onlineUp(CRED.carol);
    await selectCloud(carol.page);
    await sendText(carol.page, writeScript(30, 500, 'rm'));
    await until('E5:这一轮开始并有写入', async () => toolParts(await msgs(carol.page)).filter((t) => t.ok).length >= 1 && (await view(carol.page))?.streaming, 20_000, 80);
    const conv = await conversationOf(carol.page);
    const reply = await withCreatorConn((conn) => adminOp(conn, PROJ, 'set-list', { list: [{ username: 'bob', keep: true }] }));
    // 她被移出项目:文档服务当场断开她的页面连接,页面被阻断并说明原因;云端的那一轮随她的云端 Agent 连接被关而停下,原因记在云端的对话记录里
    const disk = await until('E5:服务端记下原因', () => { const d = S.diskConversation(PID, conv); return d && d.meta.state !== 'running' ? d : null; }, 10_000, 100);
    const blocked = await until('E5:她的页面写明被移出', () => carol.page.evaluate(() => document.body.innerText.match(/[^\n]*(移出|不在名单)[^\n]*/)?.[0] ?? null), 10_000, 100);
    const recorded = (disk?.events ?? []).find((x) => x.type === 'error') ?? null;
    const s = await sane(before, okOf(conv));
    await shot(carol.page, 'E5-member-removed');
    check('E5 发起成员中途被移出:她的对话被停下,她的页面写明「已被移出名单」,云端的对话记录里留着原因;项目停在完好的版本上', reply.type === 'shared.admin.ok' && /移出/.test(String(blocked ?? '')) && recorded?.code === 'revoked' && /移出/.test(recorded?.message ?? '') && disk?.meta?.state === 'revoked' && disk.meta.reason === 'removed' && okOf(conv) >= 1 && okOf(conv) < 30 && s.ok, {
      admin: reply.type, pageSays: blocked, cloudRecordSays: recorded?.message ?? null, recorded: disk ? { state: disk.meta.state, reason: disk.meta.reason } : null, writesLanded: okOf(conv), ...s,
    });
    await closeBrowser(carol.browser);
  }
}

/** 已知缺陷的复现:写入之间隔得比补渲的防抖长(见文件头 K1)。创建者的在线页面一直开着,只看补渲最后的结果 */
async function spacedStep() {
  const c = await onlineUp(CRED.creator, { asCreator: true });
  await selectCloud(c.page);
  const salt = `${SALT}-k`;
  await sendText(c.page, mockSteps([...Array.from({ length: 6 }, (_, k) => [{ sleepMs: 9000 }, writeStep(k + 1, salt, true)]).flat(), { say: '隔着写完了' }]));
  await until('K1:这一轮开始', async () => (await view(c.page))?.streaming, 15_000, 50);
  const conv = await conversationOf(c.page);
  const fin = await cloudFinishes(conv, { runMs: 180_000, renderMs: 300_000 });
  // 最后一版的计划发出之后可能还有迟到的结果:再等一小会儿取最终的
  await sleep(8000);
  const states = (S.diskConversation(PID, conv)?.events ?? []).filter((e) => e.type === 'render').map((e) => ({ state: e.state, ...(e.reason ? { reason: String(e.reason).slice(0, 80) } : {}) }));
  const node = await renderNode();
  check('K1(已知缺陷的复现)写入之间隔 9 秒:补渲最后是「渲染完成」,没有因为取不到旧版本的项目快照而失败', fin.toolOk === 6 && states.at(-1)?.state === 'done' && !states.some((s) => s.state === 'failed'), {
    writesLanded: fin.toolOk, published: states.filter((s) => s.state === 'published').length, last: states.at(-1) ?? null, failed: states.filter((s) => s.state === 'failed'), renderNode: node ? { completed: node.completed, failed: node.failed } : null,
  });
  await shot(c.page, 'K1-spaced-writes');
  await closeBrowser(c.browser);
}

let code = 0;
try {
  for (const s of STEPS) if (!ALL_STEPS.includes(s) && !OPT_STEPS.includes(s)) throw new Error(`不认识的步骤 ${s}`);
  await setup();
  if (STEPS.includes('desktop')) await leavePass('desktop', 'D', `${SALT}-d`);
  if (STEPS.includes('online')) await leavePass('online', 'O', `${SALT}-o`);
  if (STEPS.includes('stop')) await stopStep();
  if (STEPS.includes('errors')) await errorsStep();
  if (STEPS.includes('spaced')) await spacedStep();
} catch (err) {
  code = 2;
  check('探针自己没出错', false, { error: String(err?.stack ?? err).slice(0, 1200), agentLogTail: S?.agent ? S.agent.text().slice(-600) : null });
} finally {
  for (const b of [...browsers]) await closeBrowser(b).catch(() => {});
  for (const d of [...desktops]) await killDesktop(d).catch(() => {});
  for (const c of [...nodeConns]) { try { c.close(); } catch { /* 已关 */ } }
  await S?.stop().catch(() => {});
  await sleep(500);
  const busy = S ? await S.portsStillBusy().catch(() => []) : [];
  const deskBusy = [];
  for (const p of [PORTS.desktop, PORTS.desktop + 1, PORTS.desktop + 2]) if (!(await portFree(p))) deskBusy.push(p);
  check('收尾:探针起的进程都退了,端口无监听', busy.length === 0 && deskBusy.length === 0, { stillListening: [...busy, ...deskBusy] });
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 有文件还被占着,留给系统清 */ } }
}
const failed = results.filter((r) => !r.ok);
if (code === 0 && failed.length) code = 1;
console.log(JSON.stringify({ summary: { ok: code === 0, total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check), timings, shots, ...(KEEP ? { tmp: TMP } : {}) } }));
process.exit(code);
