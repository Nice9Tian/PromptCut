/**
 * 云端 Agent 界面的真实浏览器探针(任务书 `docs/plan/cloud-agent-task.md` 完成条件第 5、6 条里属于界面的部分;
 * 契约 `docs/plan/cloud-agent-contract.md` 第 5、7.4、9.5、10 节)。全程在本机,绝不连任何远端。
 *
 * 服务端是**真进程、真身份**(搭法见 `cloud-agent-ui-lib.mjs`):托管组合(文档服务 + 素材服务,本机信任关着)、云端 Agent 服务
 * (托管档命令行入口,凭服务私钥连控制连接;模型是模拟提供方的脚本模式)、在线构建 + 仿 nginx 的本机代理(编辑器页、两个舞台的源、
 * `/hosted/`、`/media/`、`/agent/`)、本 worktree 的桌面 dev server(数据都在临时目录)。页面的身份是真的:委托票据与对话委托由页面
 * 在自己到文档服务的连接上要,探针不注入任何替身;Agent 服务的地址与开关由文档服务在成员列表里下发。
 *
 *   node scripts/probes/cloud-agent-ui-probe.mjs [--base-port 5790] [--doc-port 8776] [--asset-port 8777] [--agent-port 8778]
 *        [--phases online,desktop] [--dist <在线构建目录>] [--out <截图目录>]
 *
 * 端口:--base-port 起 +0 编辑器页的源(在线构建与各代理)、+1 / +2 两个舞台的源、+3 桌面版编辑器(+4、+5 是它的舞台端口);
 * 文档服务、素材服务、Agent 服务各一个。数据目录都在系统临时目录。输出:每项断言一行 `{ check, ok, detail }`,最后一行 `{ summary }`,有失败退出码 1。
 * 截图存 --out(缺省 `work/four-stage/cloud-agent/ui2/`)。
 *
 * 验收标准:
 *
 * 在线浏览器宽屏(`online`)
 *   O0  右侧是云端 AI 栏、不是占位;接入方式下拉里只有「云端」且选中;没有任何同源 `/api/*` 请求(`__pcApiBlocked` 为空);
 *       页面打 Agent 服务的每个请求都带文档服务签的委托票据,发消息的请求体里带对话委托;
 *   O1  发一条消息(模型脚本:读项目、改文案、挪片段、调卡片参数各一次):收尾之前就能看到停止按钮、进度与工具调用(流式),
 *       最后有回复;文档服务里的项目真的被改了三处(文案、片段起止、卡片参数);「Agent 操作记录」里的署名是「你的云端 Agent」,
 *       点「撤销这步」撤掉最后一步(卡片参数回到原值,文档服务里也是);
 *   O2  停止:点「停止」后 5 秒内停下、回复没有脚本里停之后才会说的话、服务端那一轮确实不在跑了;
 *   O3  事件流被掐断(代理掐掉所有 /agent/ 的事件流连接)后自动重连、带上已看到的最大 seq 补齐:最终的工具调用数与脚本一致(不重不漏),
 *       连接状态经过「重连中」回到「已连接」;
 *   O4  关掉页面、另开一个浏览器上下文(没有本地存储)以创建者身份再进同一个项目:自动接上还在跑的对话,看得到关页面之前的工具调用,
 *       等它结束后过程完整(工具调用数、用户消息数都对);历史列表的「云端」一组里有这些对话;
 *   O5  出错不悄悄丢:模型调用失败时对话里有原因;创建者(另一台设备)关掉项目的「云端 Agent」开关时进行中的对话被停下、对话里写明原因,
 *       AI 栏说明「项目创建者已关闭云端 Agent」且发不出消息;再打开后恢复,还能再发;
 *   O6  手机仿真(低内存档):仍是占位,没有云端 AI 栏、没有发往 /agent/ 的请求;
 *   〔用户 2026-10-07 定〕以下几条:
 *   O7  成员计数写成「成员：N 人 · Agent：M 个」:N 只算真人在线(与原始成员列表各算一遍对账);成员本人关了浏览器、保持期(60 秒)过后只剩他的
 *       云端 Agent 连着时,他那一行仍在、标「离线，Agent 在跑」,不计入 N、计入 M;
 *   O8  空对话只有一条示例句「为我快速创建一个视频告诉我软件都可以做什么。」;
 *   O9  云端下一键配特效置灰并写原因;「诊断报告」可用:报告是这段云端对话的过程、出错原因、客户端与版本信息,没有票据形状的串、Bearer、Key;
 *       在线页面的「保存为文件」是浏览器下载,不请求 /api/ai/diagnostics*;
 *   O10 只在创建者关闭「云端 Agent」时给别的成员气泡,打开时不提示;
 *
 * 桌面版(`desktop`,桌面 dev server 在 `?aimock=1` 下起,本机驱动是内置假流,保证有一个本机驱动可选)
 *   D1  放本机的项目:接入方式里没有「云端」,没有任何发往 Agent 服务的请求;
 *   D2  项目放云端(桌面页面里勾「多用户协作」→ 放云端)后:接入方式里多了「云端」(地址是文档服务下发的),本机驱动仍是缺省、没有自动切;
 *       不选「云端」时发往 Agent 服务的请求只有一次 info 加一次对话列表(CA-DESK-02),带的是委托票据;
 *       项目设置里有「云端 Agent」一行、缺省勾上;创建者取消勾选(验证创建者身份 → 确认)后「云端」一项在、置灰、写原因;勾回来恢复;
 *   D3  选「云端」:页面直连 Agent 服务(跨源),没有发往本机 /api/ai/chat、/api/mcp/ 的请求;附件按钮置灰并写原因;「深度自主」置灰并写原因;
 *   D4  选「云端」发一条长一点的任务(三处改动 + 等待),确认已被云端接下后关掉桌面页面:对话在云端照跑完,项目被改了三处;
 *   D5  桌面页面重新打开回到同一个项目:AI 栏仍是本机驱动,只多一次 info 与一次对话列表;历史列表「云端」一组里找得到那个对话,点开找回完整过程;
 *   D9  桌面版云端对话里「诊断报告」可用(同 O9,不点保存为文件);D11 本机与云端的空对话都只有那一条示例句,本机模式下一键配特效不置灰。
 *   D6  云端对话还在跑时重新打开:AI 栏仍是本机驱动,出现「云端对话进行中」提示,点「接上看看」接上还在跑的对话;成员列表里自己那一行下
 *       有「〈成员名〉的云端 Agent」;跑完过程完整、改动落地。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedProject, lookupProject } from '../../server/auth/client.mjs';
import { joinAs, adminOp, projectOf, putProject } from './cloud-agent-probe-lib.mjs';
import {
  ROOT, sleep, USER_PORTS, createUi, startStack, startDesktop, killDesktop, launchBrowser, newPage, P, typeInto, mockSteps, msgs, view, conversationOf,
  toolCount, lastAssistant, idle, panelText, providerOptions, sendText, joinOnline, openDesktopEditor, sharedProjectOf, hostedToggle, openProjectSettings,
  creatorToggleService, closeDialogs, eventLog, membersList,
} from './cloud-agent-ui-lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const BASE = Number(arg('--base-port', 5790));
const PHASES = new Set(arg('--phases', 'online,desktop').split(','));
const PORTS = { site: BASE, stageA: BASE + 1, stageB: BASE + 2, desktop: BASE + 3, doc: Number(arg('--doc-port', 8776)), asset: Number(arg('--asset-port', 8777)), agent: Number(arg('--agent-port', 8778)) };
for (const p of USER_PORTS) if (Object.values(PORTS).includes(p) || PORTS.desktop + 1 === p || PORTS.desktop + 2 === p) { process.stderr.write(`端口段碰到了 ${p}(用户的编辑器或安装版)\n`); process.exit(2); }
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-ui-'));
const OUT = path.resolve(arg('--out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'cloud-agent', 'ui2')));
fs.mkdirSync(OUT, { recursive: true });

const { results, check, say, until } = createUi({ maxLine: 1600 });
let S = null;
let browser = null;
let desktop = null;
const nodeConns = [];
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
const stepsOf = mockSteps;
/** 发一条脚本消息并等到这一轮确实开始(服务端的 user 事件回来、界面进入「在跑」) */
async function startRun(page, steps) {
  await sendText(page, stepsOf(steps));
  return until('这一轮开始(界面进入在跑)', async () => (await view(page))?.streaming, 10_000, 30);
}
/** 探针自己的一条创建者连接(另一台设备):读项目、做创建者操作 */
async function creatorConn(proj) {
  const c = await joinAs(S.DOC_WS, proj, { username: proj.creator.username, password: proj.creator.password, as: 'creator' });
  if (!c) throw new Error('探针的创建者连接没建成');
  nodeConns.push(c);
  return c;
}
const clipIn = (p, id) => p?.tracks?.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
/** 发往 Agent 服务的请求(经代理的 `/agent/`;预检不算) */
const agentReqs = (page) => page.requests.filter((r) => r.url.startsWith(`${S.SITE}/agent/`) && r.method !== 'OPTIONS');
const ticketed = (reqs) => reqs.length > 0 && reqs.every((r) => r.auth === 'ticket');

/* ---- 用户 2026-10-07 定的几处界面行为用的小工具 ---- */
const EXAMPLE = '为我快速创建一个视频告诉我软件都可以做什么。';
const TICKET_SHAPE = /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const CLOUD_PANEL = '[data-pc="cloud-ai-panel"]';
const LOCAL_PANEL = 'aside.ai-panel:not([data-pc="cloud-ai-panel"])';
/** 空对话里的示例句(这一栏里所有示例按钮的文字) */
const exampleSentences = (page, panel) => P(page, (sel) => [...document.querySelectorAll(`${sel} [data-pc="ai-empty-example"]`)].map((e) => (e.textContent ?? '').trim()), panel);
/** 点开「✦」菜单读一键配特效与诊断报告两项的状态(读完收起) */
async function menuState(page, panel) {
  await page.click(`${panel} [data-pc="ai-menu"]`);
  const out = await P(page, (sel) => {
    const rd = (pc) => { const b = document.querySelector(`${sel} [data-pc="${pc}"]`); return b ? { disabled: b.disabled, title: b.title } : null; };
    return { workflow: rd('ai-auto-workflow'), diagnostics: rd('ai-diagnostics') };
  }, panel);
  await page.click(`${panel} [data-pc="ai-menu"]`).catch(() => {});
  return out;
}
/**
 * 云端下点「诊断报告」:子窗口里的报告是这段云端对话的过程、出错原因、客户端与版本信息,不含任何凭证。
 * `save`:在线页面再点「保存为文件」(浏览器下载,不请求 /api/*);桌面版不点(那条路会请本机编辑器写盘并弹出文件夹)。
 */
async function diagnostics(page, { save = false, shotName = null } = {}) {
  await page.click(`${CLOUD_PANEL} [data-pc="ai-menu"]`);
  await page.click(`${CLOUD_PANEL} [data-pc="ai-diagnostics"]`);
  await page.waitForSelector('.rpt-dialog', { visible: true, timeout: 8000 });
  const text = await page.$eval('.rpt-text', (t) => t.value);
  const buttons = await P(page, () => [...document.querySelectorAll('.rpt-dialog .rpt-btn')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })));
  if (shotName) await shot(page, shotName);
  let saveMsg = null;
  const apiBefore = page.requests.filter((r) => /\/api\/ai\/diagnostics/.test(r.url)).length;
  if (save) {
    await page.evaluate(() => { [...document.querySelectorAll('.rpt-dialog .rpt-btn')].find((b) => b.textContent.trim() === '保存为文件')?.click(); });
    saveMsg = await until('诊断报告:保存为文件有回执', () => page.$eval('.rpt-dialog .rpt-msg', (e) => e.textContent ?? '').catch(() => null), 8000, 100);
  }
  const apiAfter = page.requests.filter((r) => /\/api\/ai\/diagnostics/.test(r.url)).length;
  await page.click('.rpt-dialog .rpt-x').catch(() => {});
  let report = null;
  try { report = JSON.parse(text); } catch { report = null; }
  return { text, report, buttons, saveMsg, diagApiRequests: apiAfter - apiBefore };
}
/** 自己按原始成员列表算「成员:N 人 · Agent:M 个」(与界面各写各的,互相对一遍) */
const expectedCount = (devices) => {
  let online = 0;
  let agents = 0;
  for (const d of devices.filter((x) => !x.service)) {
    if (d.conns.some((c) => c.service !== 'agent')) online++;
    agents += d.conns.filter((c) => c.role === 'agent' && c.service !== 'agent').length + (d.conns.some((c) => c.service === 'agent') ? 1 : 0);
  }
  return `成员：${Math.max(1, online)} 人 · Agent：${agents} 个`;
};

const seedBody = (name) => ({
  version: 1, id: `cloud-ui-${RUN}`, name, width: 640, height: 360, fps: 30, duration: 12, themeId: 'midnight', media: [],
  tracks: [{
    id: 't-1', name: '序列 1',
    clips: [
      { id: 'c-text', cardId: 'blur-text', start: 0, end: 4, params: { text: '原来的|标题' }, label: '标题卡' },
      { id: 'c-move', cardId: 'blur-text', start: 4, end: 7, params: { text: '要挪的|片段' }, label: '挪动的卡' },
      { id: 'c-ring', cardId: 'ring-metric', start: 7, end: 11, params: { value: 40, label: '完播率' }, label: '指标卡' },
    ],
  }, { id: 't-2', name: '序列 2', clips: [] }],
  transitions: [],
});
/** 三处改动的脚本(改文案、挪片段、调卡片参数各一次),每步之间等一小会儿,收尾之前能看到过程 */
const threeEdits = (gap = 700, say2 = '三处都改好了') => [
  { tool: 'get_project', input: {} }, { sleepMs: gap },
  { tool: 'update_clip', input: { clipId: 'c-text', params: { text: '云端改的|标题' } } }, { sleepMs: gap },
  { tool: 'update_clip', input: { clipId: 'c-move', start: 8, end: 11 } }, { sleepMs: gap },
  { tool: 'update_clip', input: { clipId: 'c-ring', params: { value: 88 } } }, { sleepMs: gap },
  { say: say2 },
];

/* ================================================================== 在线浏览器 */

async function onlinePhase() {
  const NAME = `cloud-ui-${RUN}`;
  const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
  const PW = `pw-${randomBytes(6).toString('hex')}`;
  const shared = await createSharedProject({ base: S.DOC_DIRECT, name: NAME, mode: 'free', creator, password: PW });
  const proj = { projectId: shared.projectId, creator };
  const PID = shared.projectId;
  const obs = await creatorConn(proj);
  const seeded = await putProject(obs, PID, seedBody(NAME)).catch((e) => String(e?.message ?? e));
  check('在线:共享项目建好并写进内容(托管组合在本机)', !!PID && Number.isSafeInteger(seeded), { rev: seeded });
  const readProject = async () => (await projectOf(obs, PID)).project;
  // 在线页面里的成员以创建者身份进入(「我是创建者」):对话归「项目 + 创建者」,换设备能找回(契约 7.2)
  const join = (page) => joinOnline(page, { site: S.SITE, name: NAME, username: creator.username, password: creator.password, asCreator: true });

  const ctxA = await browser.createBrowserContext();
  const A = await newPage(ctxA);
  await join(A);
  await A.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 30_000 }).catch(() => {});

  /* ---- O0 */
  const opts0 = await providerOptions(A);
  const placeholder0 = await P(A, () => !!document.querySelector('[data-pc="online-agent-off"]'));
  const panel0 = await P(A, () => !!document.querySelector('[data-pc="cloud-ai-panel"]'));
  await until('云端对话接上(info 回来、事件流连上)', async () => { const v = await view(A); return v && (v.connection === 'live' || v.connection === 'idle') && v.conversationId; }, 30_000);
  check('O0:右侧是云端 AI 栏、不是占位', panel0 && !placeholder0, { panel0, placeholder0 });
  check('O0:接入方式下拉里只有「云端」且选中', opts0 && opts0.value === 'cloud' && opts0.options.length === 1 && opts0.options[0].text === '云端', opts0);
  await until('O0:进入项目时问了 info', () => S.agentLog.some((r) => r.path.startsWith('/agent/v1/info')), 15_000);
  const infoReq = S.agentLog.filter((r) => r.path.startsWith('/agent/v1/info'));
  check('O0:进入项目时问了 info(同源 /agent/v1/info)', infoReq.length >= 1, { infoReq: infoReq.length });
  const noIdentityNotice = !(await panelText(A)).includes('还没有取得身份证明');
  check('O0:页面的身份是真的:发往 Agent 服务的请求都带文档服务签的委托票据(不是替身),没有「还没有取得身份证明」', ticketed(agentReqs(A)) && noIdentityNotice, { requests: agentReqs(A).length, kinds: [...new Set(agentReqs(A).map((r) => r.auth))] });
  await shot(A, 'O0-online-ai-panel');
  // 〔用户 2026-10-07 定〕空对话只留一条示例句;云端下一键配特效置灰并写原因
  const ex0 = await exampleSentences(A, CLOUD_PANEL);
  check('O8:空对话只有一条示例句,原文照抄「为我快速创建一个视频告诉我软件都可以做什么。」', ex0.length === 1 && ex0[0] === EXAMPLE, { ex0 });
  await shot(A, 'O8-online-empty-example');
  const menu0 = await menuState(A, CLOUD_PANEL);
  check('O9:云端下「一键配特效」在菜单里、置灰、悬停写原因;「诊断报告」不隐藏', !!menu0.workflow && menu0.workflow.disabled === true && /暂不支持一键配特效/.test(menu0.workflow.title) && !!menu0.diagnostics, menu0);

  /* ---- O1:三处改动,流式 */
  await sendText(A, stepsOf(threeEdits()));
  const sawStop = await until('O1:收尾之前出现「停止」按钮', () => A.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]'), 10_000, 50);
  const mid = await until('O1:收尾之前就看到工具调用与回复气泡', async () => { const m = await msgs(A); const v = await view(A); return v?.streaming && toolCount(m) >= 1 ? { tools: toolCount(m), total: (m ?? []).length } : null; }, 10_000, 50);
  check('O1:流式:收尾之前有「停止」按钮、已能看到工具调用', !!sawStop && !!mid, mid ?? {});
  await shot(A, 'O1-online-streaming');
  await until('O1:这一轮结束', () => idle(A), 60_000, 100);
  const m1 = await msgs(A);
  const a1 = lastAssistant(m1);
  check('O1:回复里有最后那句话,工具调用四次(读项目 + 三处改动),都成功', a1?.text?.includes('三处都改好了') && toolCount(m1) === 4 && (a1.parts ?? []).filter((p) => p.kind === 'tool').every((t) => t.ok === true), { text: a1?.text, tools: (a1?.parts ?? []).filter((p) => p.kind === 'tool').map((t) => [t.name, t.ok]) });
  const p1 = await readProject();
  check('O1:文档服务里的项目被改了三处(文案、挪片段、卡片参数)', clipIn(p1, 'c-text').params.text === '云端改的|标题' && clipIn(p1, 'c-move').start === 8 && clipIn(p1, 'c-move').end === 11 && clipIn(p1, 'c-ring').params.value === 88, { text: clipIn(p1, 'c-text').params.text, move: [clipIn(p1, 'c-move').start, clipIn(p1, 'c-move').end], value: clipIn(p1, 'c-ring').params.value });
  const pageSees = await P(A, () => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).map((c) => [c.id, c.start, c.end, c.params?.text ?? c.params?.value]));
  check('O1:这个页面的编辑区也看到了改动', JSON.stringify(pageSees).includes('云端改的|标题') && JSON.stringify(pageSees).includes('88'), pageSees);
  const bodyText = await panelText(A);
  check('O1:AI 栏里能读到回复文字与「在云端运行」说明', bodyText.includes('三处都改好了') && bodyText.includes('在云端运行,关闭后继续'), { head: bodyText.slice(0, 160) });
  const post1 = agentReqs(A).filter((r) => r.method === 'POST' && /\/messages$/.test(new URL(r.url).pathname));
  check('O1:发消息的请求带委托票据,请求体里带这一轮的对话委托', post1.length === 1 && post1[0].auth === 'ticket' && post1[0].grant === true, { posts: post1.length, auth: post1[0]?.auth ?? null, grant: post1[0]?.grant ?? null });
  const log1 = await until('O1:Agent 操作记录里出现这四步', async () => { const l = await eventLog(A); return l && l.count >= 4 ? l : null; }, 15_000, 200);
  check('O1:「Agent 操作记录」里这几步的署名是「你的云端 Agent」(发起的这台设备上)', !!log1 && log1.rows.length >= 4 && log1.rows.every((r) => r.who === '你的云端 Agent'), { count: log1?.count, who: [...new Set((log1?.rows ?? []).map((r) => r.who))] });
  await shot(A, 'O1-online-done');
  // 撤销最后一步(调卡片参数):以页面自己的身份提交逆操作
  const undoRow = (log1?.rows ?? []).find((r) => r.undo === 'ready');
  if (undoRow) await A.click(`[data-pc="agent-event"][data-event-id="${undoRow.id}"] [data-pc="agent-undo"]`);
  const undone = await until('O1:撤销后卡片参数回到原值', async () => (clipIn(await readProject(), 'c-ring')?.params?.value === 40 ? true : null), 10_000, 200);
  const rowAfter = (await eventLog(A))?.rows.find((r) => r.id === undoRow?.id) ?? null;
  check('O1:点「撤销这步」撤掉云端 Agent 的最后一步:文档服务里卡片参数回到 40,按钮变成「已撤销」,别的改动还在', !!undoRow && !!undone && rowAfter?.undo === 'done' && clipIn(await readProject(), 'c-text').params.text === '云端改的|标题', { tool: undoRow?.tool ?? null, undo: rowAfter?.undo ?? null });

  /* ---- O9:云端下「诊断报告」可用:云端对话的过程、客户端与版本信息,不含凭证;在线页面「保存为文件」是浏览器下载 */
  const diagA = await diagnostics(A, { save: true, shotName: 'O9-online-diagnostics' });
  const rep = diagA.report;
  const toolNames = (rep?.rounds ?? []).flatMap((r) => (r.reply?.tools ?? []).map((t) => t.name));
  check('O9:云端下「诊断报告」可用:报告是这段云端对话的(对话 id、四个工具调用、回复、客户端模式 online、代码版本)', rep?.format === 'PromptCut cloud conversation debug v1' && rep.conversation?.id === (await conversationOf(A)) && toolNames.filter((n) => n === 'update_clip').length === 3 && toolNames.includes('get_project') && JSON.stringify(rep.rounds).includes('三处都改好了') && rep.client?.mode === 'online' && typeof rep.client?.userAgent === 'string' && 'codeVersion' in rep.client, { format: rep?.format, tools: toolNames, client: rep?.client, rounds: rep?.rounds?.length });
  check('O9:报告里没有任何凭证:没有票据形状的串(v1.…)、没有 Bearer、没有 sk- 形状的 Key', !TICKET_SHAPE.test(diagA.text) && !/Bearer\s+[A-Za-z0-9]/.test(diagA.text) && !/\bsk-[A-Za-z0-9_-]{12,}/.test(diagA.text) && !/grant|delegation/i.test(Object.keys(rep?.conversation ?? {}).join(',')), { chars: diagA.text.length });
  check('O9:在线页面的「保存为文件」是浏览器下载(有回执),没有请求 /api/ai/diagnostics*;三个出口都在', /已下载/.test(String(diagA.saveMsg ?? '')) && diagA.diagApiRequests === 0 && diagA.buttons.map((b) => b.text).join() === '复制,保存为文件,提交', { saveMsg: diagA.saveMsg, diagApi: diagA.diagApiRequests, buttons: diagA.buttons });

  /* ---- O2:停止 */
  await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 30000 }, { say: '这句话不该出现' }]);
  await sleep(800);
  const conv2 = await conversationOf(A);
  const t0 = Date.now();
  await A.click('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]');
  const stopped = await until('O2:停止后 5 秒内停下', () => idle(A), 5_000, 50);
  const stopMs = Date.now() - t0;
  const m2 = await msgs(A);
  const a2 = lastAssistant(m2);
  check('O2:点「停止」后 5 秒内停下,回复里没有停之后才会说的话,outcome 是 aborted', !!stopped && stopMs < 5000 && !(a2?.text ?? '').includes('不该出现') && a2?.outcome === 'aborted', { stopMs, outcome: a2?.outcome, text: a2?.text });
  const disk2 = await until('O2:服务端记下这一轮已停', () => { const d = S.diskConversation(PID, conv2); return d && d.meta.state !== 'running' ? d : null; }, 5_000, 100);
  check('O2:服务端那一轮确实不在跑了(对话记录:idle / stopped)', disk2?.meta?.state === 'idle' && disk2.meta.reason === 'stopped', { state: disk2?.meta?.state ?? null, reason: disk2?.meta?.reason ?? null });
  await shot(A, 'O2-online-stopped');

  /* ---- O3:事件流被掐断后自动重连、补齐 */
  await P(A, () => { window.__connLog = []; const t = setInterval(() => { const v = window.__pcCloud?.main?.view(); if (v) { const l = window.__connLog; if (l.at(-1) !== v.connection) l.push(v.connection); } }, 30); window.__connTimer = t; });
  const eventsBefore = S.agentLog.filter((r) => /\/events/.test(r.path)).length;
  const base3 = toolCount(await msgs(A));
  await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 1800 }, { tool: 'update_clip', input: { clipId: 'c-text', label: 'r1' } }, { sleepMs: 1800 }, { tool: 'update_clip', input: { clipId: 'c-text', label: 'r2' } }, { sleepMs: 1800 }, { say: '重连完成' }]);
  await until('O3:这一轮的第二个工具调用出现', async () => toolCount(await msgs(A)) - base3 >= 2 || null, 10_000, 50);
  const tBefore = toolCount(await msgs(A)) - base3;
  const dropped = S.dropAgentStreams();
  await until('O3:这一轮结束(断流之后页面自己重连补齐)', () => idle(A), 40_000, 100);
  const m3 = await msgs(A);
  const connLog = await P(A, () => { clearInterval(window.__connTimer); return window.__connLog; });
  const a3 = lastAssistant(m3);
  const tools3 = (a3?.parts ?? []).filter((p) => p.kind === 'tool');
  const eventReqs = S.agentLog.filter((r) => /\/events/.test(r.path)).slice(eventsBefore);
  const afters = eventReqs.map((r) => Number(new URL(r.path, S.SITE).searchParams.get('after')));
  check('O3:代理确实掐断了在跑的事件流', dropped >= 1, { dropped, toolsBefore: tBefore });
  check('O3:重连后工具调用数与脚本一致(读项目 + 两次改标签,不重不漏),回复在', tools3.length === 3 && tools3.every((t) => t.ok === true) && (a3?.text ?? '').includes('重连完成'), { tools: tools3.map((t) => [t.name, t.ok]), text: a3?.text });
  check('O3:连接状态经过「重连中」回到「已连接」', connLog.includes('reconnecting') && connLog.at(-1) === 'live', { connLog });
  check('O3:重连的请求带了已看到的最大 seq(after > 0)', afters.length >= 1 && afters.every((n) => n > 0), { afters });
  const labelNow = clipIn(await readProject(), 'c-text').label;
  check('O3:断流期间服务端的改动照常落地(标签是 r2)', labelNow === 'r2', { labelNow });

  /* ---- O4:关掉页面,另一台设备再进:自动接上还在跑的对话 */
  await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 5000 }, { tool: 'update_clip', input: { clipId: 'c-text', label: 'reopened' } }, { sleepMs: 5000 }, { say: '接上了' }]);
  const base4 = toolCount(await msgs(A));
  await until('O4:关页面之前先看到这一轮的第一个工具调用', async () => toolCount(await msgs(A)) > base4 || (await view(A))?.streaming, 10_000, 50);
  await sleep(500);
  const toolsBeforeClose = toolCount(await msgs(A));
  const convA = await conversationOf(A);
  await A.close();
  await sleep(1500);
  const ctxB = await browser.createBrowserContext();
  const B = await newPage(ctxB);
  const tJoin = Date.now();
  await join(B);
  // 记下 B 页面上出现过的所有气泡文字(O5 查「只在关闭时有气泡」)
  await P(B, () => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('[data-pc="sync-toasts"]')?.textContent?.trim(); if (t && !window.__toasts.includes(t)) window.__toasts.push(t); }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
  const attached = await until('O4:新设备进项目后自动接上还在跑的对话,补齐关页面之前的过程', async () => {
    const v = await view(B);
    const m = await msgs(B);
    return v && v.conversationId === convA && toolCount(m) >= toolsBeforeClose ? { v, m } : null;
  }, 30_000, 100);
  const stillRunning = await view(B);
  check('O4:另一台设备(没有本地存储、同一位创建者)进同一个项目,自动打开了那个对话', !!attached && attached.v.conversationId === convA, { conv: attached?.v?.conversationId, convA, ms: Date.now() - tJoin });
  check('O4:接上时看得到关页面之前的工具调用,而且这一轮还在跑(有「停止」)', toolCount(attached?.m) >= toolsBeforeClose && (stillRunning?.streaming === true || (await B.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]'))), { toolsBeforeClose, toolsNow: toolCount(attached?.m), streaming: stillRunning?.streaming });
  await shot(B, 'O4-online-reopened-running');
  await until('O4:这一轮在新设备上结束', () => idle(B), 40_000, 100);
  const m4 = await msgs(B);
  const a4 = lastAssistant(m4);
  const users4 = m4.filter((x) => x.role === 'user');
  const lastRunTools = (a4?.parts ?? []).filter((p) => p.kind === 'tool');
  check('O4:过程完整:最后一轮两个工具调用、回复「接上了」;整段对话里每轮一条用户消息,没有重复', lastRunTools.length === 2 && (a4?.text ?? '').includes('接上了') && users4.length === m4.filter((x) => x.role === 'assistant').length, { tools: lastRunTools.length, users: users4.length, text: a4?.text });
  check('O4:改动落地(标签是 reopened)', clipIn(await readProject(), 'c-text').label === 'reopened');
  await B.click('[data-pc="ai-history"]');
  const hist = await until('O4:历史列表的「云端」一组里有对话', () => P(B, () => { const g = document.querySelector('[data-pc="chat-cloud-group"]'); return g ? [...g.querySelectorAll('[data-pc="chat-cloud-item"]')].map((e) => ({ id: e.textContent.trim().slice(0, 40), state: e.getAttribute('data-state') })) : null; }), 10_000, 100);
  check('O4:历史列表的「云端」一组里列出这个项目里的云端对话(这位成员的)', Array.isArray(hist) && hist.length >= 1, { hist });
  await shot(B, 'O4-online-history');
  await B.click('.chat-drawer-close-btn').catch(() => {});

  /* ---- O5:出错不悄悄丢 */
  await sendText(B, stepsOf([{ fail: '模拟的模型错误' }]));
  await until('O5:模型失败的那一轮结束', async () => { const a = lastAssistant(await msgs(B)); return a?.outcome === 'error' && !a.pending; }, 20_000, 100);
  const a5 = lastAssistant(await msgs(B));
  check('O5:模型调用失败时对话里有原因(含模型接口给的话)', a5?.outcome === 'error' && String(a5?.error ?? '').includes('模拟的模型错误'), { outcome: a5?.outcome, error: a5?.error });
  await shot(B, 'O5-online-model-error');
  // 创建者(探针的另一台设备)关掉项目的「云端 Agent」开关:进行中的对话被停下
  await startRun(B, [{ tool: 'get_project', input: {} }, { sleepMs: 20000 }, { say: '不该出现2' }]);
  await sleep(600);
  const revBefore = (await projectOf(obs, PID)).rev;
  const offReply = await adminOp(obs, proj, 'set-hosted-service', { service: 'agent', enabled: false });
  await until('O5:开关关掉后对话停下', () => idle(B), 10_000, 50);
  const a5b = lastAssistant(await msgs(B));
  check('O5:创建者关掉开关时进行中的对话被停下,对话里写明原因,项目不动', offReply.type === 'shared.admin.ok' && a5b?.outcome === 'error' && /已关闭云端 Agent/.test(String(a5b?.error ?? '')) && !(a5b?.text ?? '').includes('不该出现2') && (await projectOf(obs, PID)).rev === revBefore, { admin: offReply.type, outcome: a5b?.outcome, error: a5b?.error });
  const offBanner = await until('O5:AI 栏出现「已关闭」的说明', () => B.$eval('[data-pc="cloud-off"]', (el) => el.textContent ?? '').catch(() => null), 8_000, 100);
  const postsBefore = agentReqs(B).filter((r) => r.method === 'POST' && /\/messages$/.test(new URL(r.url).pathname)).length;
  await sendText(B, '开关关着时发的这一句不该发出去').catch(() => {});
  await sleep(1200);
  const postsAfter = agentReqs(B).filter((r) => r.method === 'POST' && /\/messages$/.test(new URL(r.url).pathname)).length;
  check('O5:开关关着时 AI 栏说明「项目创建者已关闭云端 Agent」,消息发不出去', /项目创建者已关闭云端 Agent/.test(String(offBanner ?? '')) && postsAfter === postsBefore, { banner: offBanner, posts: [postsBefore, postsAfter] });
  await shot(B, 'O5-online-revoked');
  const offToast = await until('O10:创建者关闭开关时,别的成员的页面上出现气泡', async () => (await P(B, () => window.__toasts)).find((t) => /创建者关闭了云端 Agent/.test(t)) ?? null, 8_000, 100);
  const onReply = await adminOp(obs, proj, 'set-hosted-service', { service: 'agent', enabled: true });
  await until('O5:开关打开后「已关闭」的说明撤掉', async () => !(await B.$('[data-pc="cloud-off"]')), 8_000, 100);
  await sleep(2500);
  const toastsAll = await P(B, () => window.__toasts);
  check('O10:只在创建者关闭云端 Agent 时给别的成员气泡:关闭时有,打开时没有(气泡持续 6 秒,这里观察了打开之后的 2.5 秒以上)', !!offToast && !toastsAll.some((t) => /创建者打开了云端 Agent/.test(t)), { offToast, toasts: toastsAll });
  await P(B, () => { const ta = document.querySelector('[data-pc="cloud-ai-panel"] [data-pc="ai-input"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sendText(B, stepsOf([{ tool: 'get_project', input: {} }, { say: '重开之后还能再发' }]));
  await until('O5:开关重开之后再发一条,有回复', async () => (lastAssistant(await msgs(B))?.text ?? '').includes('重开之后还能再发'), 20_000, 100);
  check('O5:开关重开之后还能再发消息、有回复', onReply.type === 'shared.admin.ok' && (lastAssistant(await msgs(B))?.text ?? '').includes('重开之后还能再发'));

  /* ---- O7:成员计数分开写「成员:N 人 · Agent:M 个」;本人不在线、只有他的云端 Agent 在跑的成员标「离线,Agent 在跑」
   * 这位成员(dave,自由进入的成员)发一个长任务就关掉浏览器;文档服务把他的页面连接留 60 秒保持期,保持期过了他的行里只剩云端 Agent 的连接 */
  const ctxC = await browser.createBrowserContext();
  const Cc = await newPage(ctxC);
  await joinOnline(Cc, { site: S.SITE, name: NAME, username: 'dave', password: PW });
  await until('O7:dave 的云端对话接上', async () => (await view(Cc))?.conversationId, 30_000);
  await startRun(Cc, [{ tool: 'get_project', input: {} }, { sleepMs: 55000 }, { tool: 'update_clip', input: { clipId: 'c-text', label: 'dave-run' } }, { sleepMs: 50000 }, { say: 'dave 的云端 Agent 做完了' }]);
  await sleep(800);
  const tClose = Date.now();
  await ctxC.close();
  const rawNow = async () => (await obs.ask({ type: 'shared.members' })).devices ?? [];
  let snap = null;
  let rawAt = [];
  await until('O7:保持期过后 dave 那一行标出「离线,Agent 在跑」', async () => {
    snap = await membersList(B);
    rawAt = await rawNow();
    return snap?.rows.some((r) => r.name?.startsWith('dave') && r.offlineTag) ? snap : null;
  }, 140_000, 3000);
  const dave = rawAt.find((d) => d.username === 'dave');
  const daveRow = snap?.rows.find((r) => r.name?.startsWith('dave'));
  // 用同一时刻的原始成员列表算期望(界面与探针各算各的);等一轮让界面追上
  snap = await membersList(B, { shot: path.join(OUT, 'O7-online-members-offline-agent.png') });
  rawAt = await rawNow();
  const personsOnline = rawAt.filter((d) => !d.service && d.conns.some((c) => c.service !== 'agent')).length;
  check('O7:dave 关了浏览器、只剩他的云端 Agent 连着:他那一行仍在,标「离线,Agent 在跑」', !!dave && dave.conns.length >= 1 && dave.conns.every((c) => c.service === 'agent') && daveRow?.offlineTag === '[离线，Agent 在跑]', { waited: Math.round((Date.now() - tClose) / 1000), rawDave: dave?.conns, tag: daveRow?.offlineTag ?? null });
  check('O7:顶栏的字是「成员:N 人 · Agent:M 个」,N 不含 dave(只算真人在线)、M 含他的云端 Agent;与原始成员列表算出来的一致', snap?.count === expectedCount(rawAt) && /^成员：\d+ 人 · Agent：\d+ 个$/.test(snap?.count ?? '') && Number((/成员：(\d+) 人/.exec(snap?.count ?? '') ?? [])[1]) === personsOnline && Number((/Agent：(\d+) 个/.exec(snap?.count ?? '') ?? [])[1]) >= 1, { label: snap?.count, expected: expectedCount(rawAt), personsOnline, devices: rawAt.map((d) => ({ u: d.username, conns: d.conns.map((c) => `${c.role}${c.service ? ':' + c.service : ''}`) })) });
  check('O7:成员列表的按钮文字就是这个口径(旧的「成员: N 人」不再出现)', /^成员：\d+ 人 · Agent：\d+ 个$/.test(snap?.button ?? '') && !/成员: /.test(snap?.button ?? ''), { button: snap?.button });

  /* ---- O0 补:同源 /api/* 一个都没有 */
  const apiBlocked = await P(B, () => window.__pcApiBlocked ?? []);
  const apiReq = [...(A.requests ?? []), ...(B.requests ?? [])].filter((r) => { try { return new URL(r.url).origin === S.SITE && /^\/(editor\/)?api\//.test(new URL(r.url).pathname); } catch { return false; } });
  // 在线页面本来就有几条与桌面共用的 /api/ 调用被守卫就地拦下(棘轮清单里的那几条,运行期一个字节都不出去);云端 AI 栏不该多出任何一条
  const ratchet = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'test', 'c10a-online-api-paths.json'), 'utf8')).paths;
  const foreign = apiBlocked.filter((p) => !ratchet.includes(p) || /^\/api\/(ai|chats|mcp|agent)/.test(p));
  check('O0:整个在线对话过程中没有同源 /api/* 请求发出去;守卫拦下的只有棘轮清单里原有的,没有 /api/ai、/api/chats、/api/mcp', apiReq.length === 0 && foreign.length === 0, { apiBlocked, foreign, apiReq: apiReq.slice(0, 3) });
  check('O0:整个在线过程发往 Agent 服务的请求都带委托票据', ticketed(agentReqs(B)) && ticketed(agentReqs(A)), { A: agentReqs(A).length, B: agentReqs(B).length });
  check('O0:在线页面没有页面错误', B.pageErrors.length === 0 && A.pageErrors.length === 0, { A: A.pageErrors.slice(0, 3), B: B.pageErrors.slice(0, 3) });

  /* ---- O6:手机仿真仍是占位 */
  const ctxM = await browser.createBrowserContext();
  const Mo = await newPage(ctxM, { mobile: true });
  const agentBefore = S.agentLog.length;
  await joinOnline(Mo, { site: S.SITE, name: NAME, username: 'carol', password: PW });
  await sleep(3000);
  const mob = await P(Mo, () => ({ placeholder: !!document.querySelector('[data-pc="online-agent-off"]'), panel: !!document.querySelector('[data-pc="cloud-ai-panel"]'), text: document.querySelector('[data-pc="online-agent-off"]')?.textContent?.trim().slice(0, 60) ?? null }));
  const mobAgentReq = Mo.requests.filter((r) => r.url.includes('/agent/'));
  check('O6:手机仿真(低内存档)仍是占位,没有云端 AI 栏', mob.placeholder && !mob.panel, mob);
  check('O6:手机仿真没有发往 /agent/ 的请求', mobAgentReq.length === 0 && S.agentLog.length === agentBefore, { mobAgentReq: mobAgentReq.length, proxyDelta: S.agentLog.length - agentBefore });
  await shot(Mo, 'O6-mobile-placeholder');
  await ctxM.close().catch(() => {});
  await ctxB.close().catch(() => {});
  await ctxA.close().catch(() => {});
}

/* ================================================================== 桌面版 */

const localAiReqs = (page) => page.requests.filter((r) => { try { const u = new URL(r.url); return u.origin === desktop.origin && /^\/api\/(ai\/(chat|abort)|mcp\/call)/.test(u.pathname); } catch { return false; } });

async function desktopPhase() {
  desktop = await startDesktop({ port: PORTS.desktop, dir: path.join(TMP, 'desktop'), deviceId: `cloud-ui-desk-${RUN}`.padEnd(20, '0') });
  say('desktop.up', { origin: desktop.origin });
  const ctx = await browser.createBrowserContext();
  const page = await newPage(ctx);
  await openDesktopEditor(page, desktop.origin);

  /* ---- D1:放本机的项目 */
  const NAME = `云端界面-${RUN}`;
  const clips = await P(page, async (name) => {
    const St = await import('/src/store/project.ts');
    St.actions.newProject(name);
    St.actions.seek(0);
    const a = St.actions.addClipOnNewTrack({ index: 0, cardId: 'blur-text', start: 0, duration: 4 });
    St.actions.setClipParams(a.id, { text: '原来的|标题' });
    const b = St.actions.addClipOnNewTrack({ index: 0, cardId: 'blur-text', start: 4, duration: 3 });
    St.actions.setClipParams(b.id, { text: '要挪的|片段' });
    const c = St.actions.addClipOnNewTrack({ index: 0, cardId: 'ring-metric', start: 7, duration: 4 });
    St.actions.setClipParams(c.id, { value: 40, label: '完播率' });
    return { text: a.id, move: b.id, ring: c.id };
  }, NAME);
  await sleep(2500);
  const local = await providerOptions(page);
  check('D1:放本机的项目:接入方式里没有「云端」(本机驱动都在)', local && local.options.length >= 2 && !local.options.some((o) => o.value === 'cloud'), local);
  check('D1:放本机的项目没有任何发往 Agent 服务的请求', agentReqs(page).length === 0 && S.agentLog.filter((r) => r.origin === desktop.origin).length === 0, { n: agentReqs(page).length });
  const exLocal = await exampleSentences(page, LOCAL_PANEL);
  check('D11:本机 AI 栏的空对话也只有这一条示例句(本机与云端同一份)', exLocal.length === 1 && exLocal[0] === EXAMPLE, { exLocal });
  const menuLocal = await menuState(page, LOCAL_PANEL);
  check('D11:本机模式下一键配特效不置灰(只有云端下才置灰)', !!menuLocal.workflow && menuLocal.workflow.disabled === false, menuLocal);

  /* ---- 放云端:桌面页面里勾「多用户协作」→ 放云端 */
  await openProjectSettings(page);
  check('D1:没开协作时项目设置里没有「云端 Agent」一行', !(await page.$('[data-pc="collab-hosted-agent"]')));
  await page.click('[data-pc="collab-toggle"]');
  await page.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  await until('创建者用户名的缺省值填上', () => page.$eval('#pc-collab-creator', (i) => i.value.trim()).catch(() => ''), 10_000, 200);
  const creator = { username: await page.$eval('#pc-collab-creator', (i) => i.value), password: await page.$eval('#pc-collab-cpw', (i) => i.value) };
  await page.click('[data-pc="collab-where-hosted"]');
  await typeInto(page, '[data-pc="collab-hosted-url"]', S.HOSTED_URL);
  await page.click('.pc-dialog-foot .pc-btn--primary');
  const enabled = await until('放云端开启完成', async () => { const t = await page.$eval('[data-pc="collab-status"]', (el) => el.textContent ?? '').catch(() => ''); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  check('D2:桌面页面开启「多用户协作」放云端', enabled?.includes('多用户协作已开启。'), { status: enabled, failures: page.failures.slice(-6), consoleErrors: page.consoleErrors.slice(-4) });
  const found = await lookupProject({ base: S.HOSTED_URL, name: NAME });
  const PID = found.projectId;
  const proj = { projectId: PID, creator };
  const obs = await creatorConn(proj);
  const readProject = async () => (await projectOf(obs, PID)).project;

  /* ---- D2:项目设置里的「云端 Agent」开关(设置面板还开着) */
  const row0 = await until('D2:项目设置里出现「云端 Agent」一行', () => hostedToggle(page, 'agent'), 15_000, 200);
  const rowText = await page.$eval('[data-pc="collab-hosted-agent"]', (el) => el.textContent ?? '').catch(() => '');
  check('D2:项目设置里有「云端 Agent」一行:缺省勾上、创建者可改、带一行说明', !!row0 && row0.checked === true && row0.disabled === false && rowText.includes('云端 Agent') && /AI 栏里选「云端」/.test(rowText), { state: row0, text: rowText.slice(0, 80) });
  await shot(page, 'D2-desktop-settings-agent-row');
  await closeDialogs(page);
  await sleep(2500);

  const cloudOpt = await providerOptions(page);
  const co = cloudOpt?.options.find((o) => o.value === 'cloud');
  check('D2:项目放云端后,接入方式里多了「云端」', !!co && co.text === '云端' && !co.disabled, cloudOpt);
  check('D2:本机驱动仍是缺省,没有自动切到云端', cloudOpt && cloudOpt.value !== 'cloud' && cloudOpt.value !== '', { value: cloudOpt?.value });
  const preSel = agentReqs(page);
  check('D2:不选「云端」时发往 Agent 服务的请求只有一次 info 加一次对话列表', preSel.length === 2 && preSel.some((r) => r.url.endsWith('/v1/info')) && preSel.some((r) => r.url.endsWith('/v1/conversations')), preSel.map((r) => `${r.method} ${r.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`));
  check('D2:页面的身份是真的:这两个请求打的是文档服务下发的地址(经代理的 /agent/v1,跨源),带的是委托票据', ticketed(preSel) && preSel.every((r) => r.url.startsWith(`${S.AGENT_PUBLIC}/`)) && S.agentLog.some((r) => r.origin === desktop.origin), { kinds: [...new Set(preSel.map((r) => r.auth))] });
  // 创建者取消勾选(验证创建者身份 → 确认):「云端」一项在、置灰、写原因
  await openProjectSettings(page);
  const offDialog = await creatorToggleService(page, 'agent', creator.password);
  const offState = await until('D2:勾选取消', async () => { const s = await hostedToggle(page, 'agent'); return s && s.checked === false ? s : null; }, 8_000, 150);
  const offHint = await page.$eval('[data-pc="collab-hosted-agent-hint"]', (el) => el.textContent ?? '').catch(() => '');
  check('D2:创建者在项目设置里取消勾选「云端 Agent」(验证创建者身份后确认)', !!offState && /已关闭/.test(offHint) && /进行中的云端对话会被立刻停下/.test(offDialog), { state: offState, hint: offHint.slice(0, 60), dialog: offDialog.slice(0, 80) });
  await shot(page, 'D2-desktop-settings-agent-off');
  await closeDialogs(page);
  const offOpt = await until('D2:「云端」一项置灰', async () => { const o = (await providerOptions(page))?.options.find((x) => x.value === 'cloud'); return o?.disabled ? o : null; }, 8_000, 150);
  check('D2:创建者关了开关时「云端」一项在、置灰、写原因', !!offOpt && offOpt.disabled && /项目创建者已关闭云端 Agent/.test(offOpt.title), offOpt ?? {});
  await openProjectSettings(page);
  await creatorToggleService(page, 'agent', creator.password);
  await until('D2:勾回来', async () => (await hostedToggle(page, 'agent'))?.checked === true, 8_000, 150);
  await closeDialogs(page);
  const onOpt = await until('D2:「云端」一项恢复可选', async () => { const o = (await providerOptions(page))?.options.find((x) => x.value === 'cloud'); return o && !o.disabled ? o : null; }, 8_000, 150);
  check('D2:勾回来之后「云端」一项恢复可选', !!onOpt, onOpt ?? {});

  /* ---- D3:选「云端」 */
  await page.select('[data-pc="ai-provider"]', 'cloud');
  await page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 });
  await until('D3:云端页接上', async () => { const v = await view(page); return v && v.conversationId; }, 20_000);
  const attach = await P(page, () => { const b = document.querySelector('[data-pc="cloud-ai-panel"] [data-pc="ai-attach"]'); return b ? { disabled: b.disabled, title: b.title } : null; });
  check('D3:云端下附件按钮置灰并写原因', attach?.disabled === true && /暂不支持附文件/.test(attach.title), attach);
  await page.click('[data-pc="cloud-ai-panel"] [data-pc="ai-run-options"]');
  const deep = await P(page, () => { const b = document.querySelector('[data-pc="cloud-ai-panel"] [data-pc="deep-auto"]'); return b ? { disabled: b.disabled, title: b.title } : null; });
  check('D3:云端下「深度自主」置灰并写原因(含审查环路)', deep?.disabled === true && /深度自主与审查环路/.test(deep.title), deep);
  await page.click('[data-pc="cloud-ai-panel"] [data-pc="ai-run-options"]').catch(() => {});
  await shot(page, 'D3-desktop-cloud-selected');
  const exCloudD = await exampleSentences(page, CLOUD_PANEL);
  const menuCloudD = await menuState(page, CLOUD_PANEL);
  check('D11:桌面版云端对话的空对话只有那一条示例句;云端下一键配特效置灰并写原因,诊断报告不隐藏', exCloudD.length === 1 && exCloudD[0] === EXAMPLE && menuCloudD.workflow?.disabled === true && /暂不支持一键配特效/.test(menuCloudD.workflow.title) && !!menuCloudD.diagnostics, { exCloudD, menuCloudD });
  await shot(page, 'D11-desktop-empty-example');

  /* ---- D4:发长任务,确认被接下后关页面 */
  const DESK_STEPS = [
    { tool: 'get_project', input: {} }, { sleepMs: 2500 },
    { tool: 'update_clip', input: { clipId: clips.text, params: { text: '桌面云端改的|标题' } } }, { sleepMs: 2500 },
    { tool: 'update_clip', input: { clipId: clips.move, start: 8, end: 11 } }, { sleepMs: 2500 },
    { tool: 'update_clip', input: { clipId: clips.ring, params: { value: 88 } } }, { sleepMs: 2500 },
    { say: '桌面发起的三处改动做完了' },
  ];
  await sendText(page, stepsOf(DESK_STEPS));
  const taken = await until('D4:云端接下了任务(第一个工具调用出现)', async () => toolCount(await msgs(page)) >= 1 && (await view(page))?.streaming, 20_000, 100);
  const convD = await conversationOf(page);
  const localAi = localAiReqs(page);
  const agentCross = agentReqs(page).filter((r) => r.method === 'POST' && r.url.includes('/messages'));
  check('D3:选「云端」后页面直连 Agent 服务(跨源 POST,带委托票据与对话委托),没有发往本机 /api/ai/chat、/api/mcp/ 的请求', agentCross.length === 1 && agentCross[0].auth === 'ticket' && agentCross[0].grant === true && localAi.length === 0, { agentPosts: agentCross.length, auth: agentCross[0]?.auth ?? null, grant: agentCross[0]?.grant ?? null, localAi: localAi.map((r) => r.url) });
  await shot(page, 'D4-desktop-streaming');
  check('D4:云端接下了任务', !!taken, {});
  // 关掉桌面页面:标签页离开编辑器(页面里的一切、事件流连接都没了);同一个标签页稍后再打开,共享项目的恢复信息在标签页的会话存储里
  await page.goto('about:blank');
  say('desktop.page-closed');
  const doneOnCloud = await until('D4:桌面页面关掉之后,云端对话照跑完', () => { const d = S.diskConversation(PID, convD); return d && d.meta.state === 'idle' && d.events.some((e) => e.type === 'end') ? d.meta : null; }, 60_000, 500);
  check('D4:桌面页面关掉后云端对话跑完(服务端状态 idle)', !!doneOnCloud, doneOnCloud ? { state: doneOnCloud.state, lastSeq: doneOnCloud.lastSeq } : {});
  const pD = await readProject();
  check('D4:桌面页面不在时三处改动照样落地', clipIn(pD, clips.text)?.params?.text === '桌面云端改的|标题' && clipIn(pD, clips.move)?.start === 8 && clipIn(pD, clips.ring)?.params?.value === 88, { text: clipIn(pD, clips.text)?.params?.text, move: clipIn(pD, clips.move)?.start, ring: clipIn(pD, clips.ring)?.params?.value });

  /* ---- D5:重新打开 */
  const markReq = page.requests.length;
  await page.goto(`${desktop.origin}/?editor&nosetup=1&aimock=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const back = await until('D5:桌面页面回到同一个共享项目', () => sharedProjectOf(page), 120_000, 500);
  check('D5:桌面页面重新打开后回到同一个共享项目', back === PID, { back, PID });
  await until('D5:测量门放开', () => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 180_000, 300);
  await until('D5:AI 栏出来', () => page.$('[data-pc="ai-provider"]'), 60_000, 200);
  await sleep(2500);
  const reopened = await providerOptions(page);
  check('D5:重新打开后 AI 栏仍是本机驱动(云端从不自动选中)', reopened && reopened.value !== 'cloud' && reopened.options.some((o) => o.value === 'cloud'), reopened);
  const preSel2 = page.requests.slice(markReq).filter((r) => r.url.startsWith(`${S.SITE}/agent/`) && r.method !== 'OPTIONS');
  check('D5:重新打开时只多一次 info 与一次对话列表', preSel2.length === 2, preSel2.map((r) => r.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')));
  // 打开历史列表(点一下;没开出来就再点,最多三次)
  for (let i = 0; i < 3; i++) {
    await page.click('[data-pc="ai-history"]');
    if (await page.waitForSelector('.chat-history-drawer', { visible: true, timeout: 4000 }).catch(() => null)) break;
  }
  const group = await until('D5:历史列表「云端」一组里有刚才的对话', () => P(page, () => { const g = document.querySelector('[data-pc="chat-cloud-group"]'); const items = g ? [...g.querySelectorAll('[data-pc="chat-cloud-item"]')] : []; return items.length ? items.map((e) => e.textContent.trim().slice(0, 60)) : null; }), 15_000, 200);
  check('D5:历史列表的「云端」一组里找得到桌面页面关掉前发起的对话', Array.isArray(group) && group.length >= 1, { group, consoleErrors: page.consoleErrors.slice(-3), failures: page.failures.slice(-3) });
  await shot(page, 'D5-desktop-history-cloud-group');
  await page.click('[data-pc="chat-cloud-item"]');
  const panelUp = await page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 }).catch(() => null);
  if (!panelUp) {
    await shot(page, 'D5-click-failed');
    const diag = await P(page, async () => { const T = await import('/src/ai/cloud/tabMode.ts'); return { tab: T.getCloudTab('main'), drawer: !!document.querySelector('.chat-history-drawer'), panels: [...document.querySelectorAll('aside.ai-panel')].map((a) => a.className + '|' + (a.getAttribute('data-inactive') ?? '')) }; });
    check('D5:点了历史列表里的云端对话后云端 AI 栏出现', false, { diag, consoleErrors: page.consoleErrors.slice(-4) });
    throw new Error('云端 AI 栏没出现');
  }
  const found5 = await until('D5:点开后找回完整过程', async () => { const m = await msgs(page); return m && toolCount(m) === 4 && (lastAssistant(m)?.text ?? '').includes('桌面发起的三处改动做完了') ? m : null; }, 30_000, 200);
  check('D5:点开后找回完整过程(用户消息、四个工具调用、最后的回复)', !!found5 && found5.filter((x) => x.role === 'user').length === 1, { tools: toolCount(found5), users: found5?.filter((x) => x.role === 'user').length });
  await shot(page, 'D5-desktop-cloud-recovered');
  // 〔用户 2026-10-07 定〕桌面版云端对话里「诊断报告」可用(不点「保存为文件」:那条路请本机编辑器写盘并弹出文件夹)
  const diagD = await diagnostics(page, { shotName: 'D9-desktop-diagnostics' });
  const toolNamesD = (diagD.report?.rounds ?? []).flatMap((r) => (r.reply?.tools ?? []).map((t) => t.name));
  check('D9:桌面版云端下「诊断报告」可用:报告是这段云端对话的(四个工具调用、回复、客户端模式 desktop),不含任何凭证', diagD.report?.format === 'PromptCut cloud conversation debug v1' && diagD.report.conversation?.id === convD && toolNamesD.length === 4 && JSON.stringify(diagD.report.rounds).includes('桌面发起的三处改动做完了') && diagD.report.client?.mode === 'desktop' && !TICKET_SHAPE.test(diagD.text) && !/Bearer\s+[A-Za-z0-9]/.test(diagD.text) && !/\bsk-[A-Za-z0-9_-]{12,}/.test(diagD.text) && diagD.diagApiRequests === 0, { tools: toolNamesD, client: diagD.report?.client, chars: diagD.text.length });

  /* ---- D6:云端对话还在跑时重新打开:有「进行中」提示,点了接上 */
  await startRun(page, [{ tool: 'get_project', input: {} }, { sleepMs: 45000 }, { tool: 'update_clip', input: { clipId: clips.text, label: 'D6 接上后' } }, { say: 'D6 做完了' }]);
  await sleep(1500);
  await page.goto('about:blank');
  await page.goto(`${desktop.origin}/?editor&nosetup=1&aimock=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('D6:桌面页面回到共享项目', () => sharedProjectOf(page), 120_000, 500);
  await until('D6:测量门放开', () => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 180_000, 300);
  const banner = await until('D6:本机模式下出现「云端对话进行中」提示', () => page.$('[data-pc="cloud-running-banner"]'), 30_000, 200);
  const optsD6 = await providerOptions(page);
  check('D6:云端对话还在跑时重新打开:AI 栏仍是本机驱动,出现「云端对话进行中」提示', !!banner && optsD6 && optsD6.value !== 'cloud', { value: optsD6?.value });
  await shot(page, 'D6-desktop-running-banner');
  const mem = await membersList(page);
  const mine = mem?.rows.find((r) => r.cloudTag) ?? null;
  // 列表里另一行是探针自己的那条创建者连接(另一台设备):成员数 2 = 两台设备,云端 Agent 不占数
  check('D6:成员列表里自己那一行下有「〈成员名〉的云端 Agent」(不另起一行、不计入成员数)', !!mine && mine.cloudRow === `${creator.username}的云端 Agent` && mem.rows.filter((r) => r.cloudTag).length === 1 && mem.count === '成员：2 人 · Agent：1 个' && mem.button === mem.count, { button: mem?.button, count: mem?.count, rows: mem?.rows.map((r) => r.text.slice(0, 60)) });
  await page.click('[data-pc="cloud-running-banner"] button');
  await page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 });
  const attachedD6 = await until('D6:点了「接上看看」后接上还在跑的对话', async () => { const v = await view(page); return v?.streaming ? v : null; }, 20_000, 100);
  check('D6:接上后看到「停止」(这一轮还在跑)', !!attachedD6 && !!(await page.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]')), {});
  await until('D6:这一轮结束', () => idle(page), 90_000, 200);
  const mD6 = await msgs(page);
  const pD6 = await readProject();
  check('D6:接上后过程完整、回复在,改动落地', (lastAssistant(mD6)?.text ?? '').includes('D6 做完了') && clipIn(pD6, clips.text)?.label === 'D6 接上后', { text: lastAssistant(mD6)?.text, tools: toolCount(mD6) });
  await shot(page, 'D6-desktop-attached');
  check('D5:桌面页面没有页面错误', page.pageErrors.length === 0, page.pageErrors.slice(0, 3));
  await ctx.close().catch(() => {});
  await killDesktop(desktop);
  desktop = null;
}

/* ================================================================== 主流程 */

let exitCode = 0;
try {
  S = await startStack({ tmp: TMP, ports: PORTS, dist: arg('--dist', null), say });
  const health = await (await fetch(`${S.AGENT_DIRECT}/healthz`, { signal: AbortSignal.timeout(10_000) })).json().catch((e) => ({ error: String(e?.message ?? e) }));
  check('Agent 服务(托管档,本机,真身份)/healthz', health?.ok === true && S.agent.ready?.auth !== undefined, { ok: health?.ok, version: health?.version, auth: S.agent.ready?.auth ?? null });
  browser = await launchBrowser({ extraArgs: ['--disable-gpu'] });
  if (PHASES.has('online')) await onlinePhase();
  if (PHASES.has('desktop')) await desktopPhase();
} catch (err) {
  check('探针自己没出错', false, { error: String(err?.stack ?? err).slice(0, 800), agentLogTail: S?.agent ? S.agent.text().slice(-500) : null });
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  if (desktop) await killDesktop(desktop).catch(() => {});
  for (const c of nodeConns) { try { c.close(); } catch { /* 已关 */ } }
  await S?.stop().catch(() => {});
  await sleep(300);
  const busy = S ? await S.portsStillBusy().catch(() => []) : [];
  if (busy.length) say('ports.still-busy', { busy });
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* 占着就留着 */ }
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check) } }));
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);
