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
 *   在线页面量出来就是重卡:播放时贴预渲染的轨道流)加一张带参数的图表卡。
 *   渲染服务照部署模板的配置起(`PROMPTCUT_RENDER_STREAMS=1`,能产轨道流),创建者建好项目后打开「生成轨道流」。2026-10-13 起每张卡的快照作废,
 *   预渲染结果只有轨道流一档;这一项关着时托管方的渲染节点完全不为这个项目产流(语义 `product/rendering.md`「预渲染」「谁产流与托管方开关」)。
 *
 * 2026-10-21 起:桌面版那一遍以外的各步(online、stop、spaced、usercard、errors)走**账号组合**(云端项目一律走网站账号,`product/hosting.md`;
 *   在线构建只认账号项目):`cloud-agent-ui-lib.mjs` 的 `startAccountStack`——账号组合夹具(VisuHive 真账号后端、账号模式文档服务、
 *   独立素材服务进程、Agent 主服务的生产装配与一条任务一个进程的任务槽)+ 主服务的真发布通道 + 真渲染服务(照 AR-10)。桌面版那一遍跑完先把
 *   口令式的旧组合停干净,再起账号组合。创建者 = 夹具账号 dualUser0、bob = dualUser1、carol 现注册并经项目链接加入;「生成轨道流」
 *   由创建者在在线页面的项目设置里打开(网站后端的 `ACCOUNT_ADMINS` 只设在本探针进程里,让创建者在权限分组内)。要先设
 *   PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE。对话记录改读主服务的事件库与文档服务的账本。
 *   改写的断言(改前改后见 `docs/archive/agent-reports/AGENT-ux-probe-account.md`):X1(账号组合搭起来)、B1～B3(发起方与重开方都是在线页面)、
 *   K2(做完的任务数按工作进程逐任务收尾行数)、UC0(新建账号项目)、UC2(看轨道流)、E5(被踢的已读消息例外)。
 *
 *   node scripts/probes/cloud-agent-ux-ui-probe.mjs [--steps desktop,online,stop,spaced,usercard,errors] [--account-port 29003] [--base-port 5790] [--doc-port 8798] [--asset-port 8799]
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
 *   X0  三个服务起来;渲染服务、Agent 服务、在线页面的代码版本相同(同一份代码);项目设置里「云端 Agent」一行缺省勾上;
 *       创建者打开「生成轨道流」后渲染服务看到这一项开着。
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
 *   A4  bob 进项目:页面里的项目就是 12 次改动之后的样子;bob 的 AI 栏底部「Agent 操作」不混进创建者那个对话的操作(2026-10-20 起「Agent 操作」
 *       只显示自己正在看的对话,取代按项目频道列全部工具事件的「Agent 操作记录」;署名改由 B1 的成员列表核对)。
 *   A5  舞台上的画面是渲好的预渲染结果:播放时两张重卡都贴着轨道流(舞台的流播放器里含它的那条流画出了帧)、没有占位;没有「需要本地 PC 渲染辅助」的图标与时间轴徽标;
 *       层表里这几层的环境指纹是云节点渲染服务的;舞台截图不是空白(颜色不止一种)。
 * 四、创建者重新打开(新进程)
 *   A6  回到同一个项目;AI 栏仍是本机驱动(桌面版)/ 云端(在线);历史列表「云端」一组里找得到这段对话,点开后完整过程与结果都在
 *       (全部工具调用、最后的回复、「云端渲染完成」);项目是最新版本;预渲染结果已在(层表里有这几张重卡的流;在线页面播放时贴轨道流)。
 *   A7  点「撤销这步」撤掉 Agent 的最后一处改动:创建者页面里那个参数回到上一次的值,按钮变成「已撤销」;bob 的页面也看到撤销的结果。
 * 五、中途想停、换设备(步骤 stop)
 *   B1  另起一遍更长的任务(桌面版发起),发起方同样被结束。之后 bob 从在线浏览器进项目看着:页面里的项目一次次变(改动一条条出现);
 *       成员列表里创建者那一行下有「〈创建者〉的云端 Agent」而他本人不在线(没有「编辑中」)——署名在这里核对。
 *       (原先看「Agent 操作记录」的条数与每行署名;2026-10-20 那块换成只显示自己对话的「Agent 操作」,别的成员的操作不再列在 AI 栏里。)
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
 * 七、写入之间隔得比预渲染重试的防抖长(步骤 spaced,排在 errors 之前跑;真模型的每次往返都是几秒,就是这种节奏。契约 `cloud-agent-contract.md` 第 16.4 节)
 *   K1  创建者的在线页面开着,云端 Agent 连写 12 处、每次隔 9 秒(预渲染重试的防抖是 3 秒):每次写入之后 Agent 服务都按当时的版本发清单计划
 *       (中途就开始渲,不等一轮结束),项目接着往前走。预渲染重试的结局是「渲染完成」,对话记录里没有「云端渲染失败」。
 *   K2  渲染节点这一轮没有一个任务以失败收场:取不到旧版本时改按当前版本核对,内容没变的照做,已被新版本取代的记成作废
 *       (诊断里的 `superseded`,不计入 `failed`)。2026-10-06 修之前这一步渲染节点要失败 22～24 个任务(全是「文档服务上没有项目快照」)。
 *   K3  渲完之后才上线的成员(bob,新的浏览器进程):项目是最后一版,舞台上两张重卡贴的是最后一版的预渲染结果。
 * 八、用户卡(步骤 usercard,排在 errors 之前;单独一个项目,免得主项目带上卡片源码改走隔离工作进程。不带界面的那条探针 `cloud-agent-ux-probe` 的 U20 是同一件事)
 *   UC1 创建者在在线浏览器里把这个对话的创造力调到「高」,让云端 Agent 建一张用户卡(判重:`frameMode: stateful`)并用它加一个片段;
 *       界面上看到建卡成功后,发起方的浏览器进程被真的结束。之后云端把这一轮做完:卡片源码进了项目的内容库、片段在时间轴上,
 *       预渲染重试由渲染服务的**隔离工作进程**(`hosted-render-iso:` 节点)认领并渲完(对话记录里有「渲染完成」),常驻工作进程没有认领这个项目的任务。
 *   UC2 之后才上线的成员(另一个浏览器进程,真实页面):项目里有这张卡的片段;舞台上这张用户卡贴的是预渲染结果(快照层在、没有占位),
 *       层表里有它这一层;没有「需要本地 PC 渲染辅助」的图标;舞台截图不是空白;页面没有错误。
 * 最后一行是汇总 `{ summary }`,有失败退出码 1,起不来退出码 2。不打印口令、票据、私钥。
 * 排查:`--keep` 时渲染服务、Agent 服务、托管组合的输出存进临时目录的 `render.log` / `agent.log` / `hosted.log`;
 * 环境变量 `PC_PROBE_RENDER_VERBOSE=1` 让渲染服务把工作进程的输出原样转出来。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookupProject } from '../../server/auth/client.mjs';
import { joinAs, adminOp, projectOf } from './cloud-agent-probe-lib.mjs';
import { createTimings } from './probe-timings.mjs';
import {
  ROOT, sleep, USER_PORTS, createUi, startStack, startDesktop, killDesktop, launchBrowser, killBrowser, alive, newPage, P, mockSteps, msgs, view, conversationOf,
  toolParts, lastAssistant, idle, panelText, providerOptions, sendText, joinOnline, sharedProjectOf, hostedToggle, openProjectSettings,
  creatorToggleService, closeDialogs, activity, undoLatestStep, membersList, clipOnStage, stageShot, pixelStats, portFree, gateSettled, clickUntil,
  startAccountStack, ACCOUNT_PORT_COUNT, accountLogin, acceptConsentIfAsked, buildOnline, hostedOption, creatorToggleOption,
} from './cloud-agent-ui-lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
/** 顺序固定:spaced 在 errors 之前(errors 的最后会把渲染服务停掉) */
const ALL_STEPS = ['desktop', 'online', 'stop', 'spaced', 'usercard', 'errors'];
const STEPS = String(arg('--steps', ALL_STEPS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
/** `--real-model`:只跑真实模型的那一遍(`realPass`;`--real-how desktop` 换成桌面版发起,缺省在线浏览器) */
const REAL = process.argv.includes('--real-model');
const BASE = Number(arg('--base-port', 5790));
const PORTS = { site: BASE, stageA: BASE + 1, stageB: BASE + 2, desktop: BASE + 3, doc: Number(arg('--doc-port', 8798)), asset: Number(arg('--asset-port', 8799)), agent: Number(arg('--agent-port', 5741)), render: Number(arg('--render-port', 5830)) };
/** 账号组合的端口段起点(连着 ACCOUNT_PORT_COUNT 个,见 `cloud-agent-ui-lib.mjs` 的 startAccountStack);两个舞台源与渲染服务沿用上面的 */
const ACCT_BASE = Number(arg('--account-port', 29003));
for (const p of USER_PORTS) if ([...Object.values(PORTS), PORTS.desktop + 1, PORTS.desktop + 2, ...Array.from({ length: ACCOUNT_PORT_COUNT }, (_, n) => ACCT_BASE + n)].includes(p)) { process.stderr.write(`端口段碰到了 ${p}(用户的编辑器或安装版)\n`); process.exit(2); }
/** 桌面版那一遍(口令式云端项目)以外的各步都走账号组合(云端项目一律走网站账号,语义 `product/hosting.md`) */
const NEED_ACCOUNT = REAL ? arg('--real-how', 'online') === 'online' : STEPS.some((s) => s !== 'desktop');
const NEED_OLD = REAL ? !NEED_ACCOUNT : STEPS.includes('desktop');
if (NEED_ACCOUNT && (!process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT || !process.env.PROMPTCUT_PASSWORD_ORDER_MODULE)) { process.stderr.write('在线各步走账号组合:要先设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE\n'); process.exit(2); }
const KEEP = argv.includes('--keep');
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-uxui-'));
const OUT = path.resolve(arg('--out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'cloud-agent', 'ux')));
fs.mkdirSync(OUT, { recursive: true });
/**
 * 预渲染重试「连续没有进度就放弃」的时限(生产 10 分钟):E4 要在渲染服务停着时等到它放弃。旧组合在 E4 前重起 Agent 服务把它缩短;
 * 账号组合的主服务不重起,所以整轮都用这个值(正常渲染时进度每几秒一条,远短于它)
 */
const RENDER_STALL_MS = 90_000;

const { results, check, say, until } = createUi({ maxLine: 2200 });
/** 当前这一套服务:桌面版那一遍是口令式的旧组合(startStack);之后换成账号组合(startAccountStack,带 `account: true`,接口同形) */
let S = null;
/** 账号组合里创建者的探针连接(夹具的 connectActor:网站登录 → 文档服务会话 → 页面连接) */
let ACTOR = null;
/** 在线构建的目录(两套共用一份;没给 --dist 就现打) */
let DIST = arg('--dist', null);
const browsers = new Set();
const desktops = new Set();
const nodeConns = new Set();
const shots = [];
const timings = {};
/** 耗时只记录(docs/semantics/guide_files/verification.md「耗时只记录,不当闸门」):点「停止」到停下用了多久只写进 TIMINGS 行,不决定过不过 */
const timingLog = createTimings('cloud-agent-ux-ui-probe');
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); const ok = await page.screenshot({ path: f }).then(() => true, () => false); if (ok) shots.push(f); return f; };
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);

/* ================================================================== 项目与脚本 */

let NAME = `云端体验-${RUN}`;
const SALT = `ux-${RUN}`;
const N = 12;
/** 「发出后退出」那两遍:开头读两遍项目(任务被接下),再读 LEAVE_READS 遍、每遍之前等 LEAVE_WAIT_MS(整段长过文档服务保留断掉的会话的 60 秒),然后连着写 */
const LEAVE_READS = 6;
const LEAVE_WAIT_MS = 14_000;
/** 一轮里的工具调用数:读(2 + LEAVE_READS)加写 N;一轮最多 24 次模型往返,这里 21 次 */
const LEAVE_TOOLS = 2 + LEAVE_READS + N;
/** 文档服务保留断掉的会话多久(`server/docservice/session.mjs` 的 `RETAIN_MS`) */
const RETAIN_MS = 60_000;
/** 步骤 spaced 里两次写入之间等多久(要大于预渲染重试的防抖 3 秒) */
const SPACED_GAP_MS = 9000;
const CLIPS = { bars: 'clip-bars', stateful: 'clip-stateful', canvas: 'clip-canvas' };
const HEAVY = [CLIPS.stateful, CLIPS.canvas];
const HEAVY_CLIPS = HEAVY;
const pw = () => `pw-${randomBytes(6).toString('hex')}`;
const CRED = { creator: { username: 'alice', password: pw() }, bob: { username: 'bob', password: pw() }, carol: { username: 'carol', password: pw() } };
/** 成员列表里创建者名下那一行的署名(换到账号组合后是创建者的账号名) */
const creatorSign = () => `${CRED.creator.username}的云端 Agent`;
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
  // 挪片段:两张重卡轮着挪(第 2、8 次挪推帧卡,第 5、11 次挪画布卡),它们都进云端的预渲染重试清单
  if (i % 3 === 2 && fixed) return { tool: 'update_clip', input: { clipId: i % 2 ? CLIPS.canvas : CLIPS.stateful, start: 0, end: i === 2 || i === 11 ? 2 : 2.5 } };
  if (i % 3 === 2) return { tool: 'update_clip', input: { clipId: CLIPS.stateful, start: 0, end: Number((1.81 + ((moveSeq += 1) % 23) / 20).toFixed(2)) } };
  return { tool: 'update_clip', input: { clipId: CLIPS.bars, params: { rows: rowsOf(salt, i) } } };
}
/** 「发出后退出」的任务:先读、等,再连着写 12 处(连着写的那一段合成一个预渲染重试计划) */
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
  // 账号组合:公共入口是带私有证书的 https,两个舞台源是 s1/s2.pc.localhost(与 cloud-agent-ui-probe 同)
  const b = await launchBrowser({ extraArgs: S?.account ? S.browserArgs : [] });
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
  if (S?.account) {
    // 账号组合:夹具的创建者连接(另一台设备的页面连接),用完就关;`fn` 拿到 `{ actor, project() }`
    await ACTOR.ensurePage();
    try { return await fn({ actor: ACTOR, project: async () => { const st = await ACTOR.project(); return { rev: st.rev, project: st.project }; } }); }
    finally { await ACTOR.close().catch(() => {}); }
  }
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
async function onlineUp(who, { asCreator = false, browser = null, name = NAME } = {}) {
  const b = browser ?? await openBrowser();
  const page = await newPage(b);
  if (S?.account) {
    // 排查用:`PC_PROBE_WSLOG=1` 时记下这个页面经 WebSocket 收到的消息种类与 events.* 的摘要
    if (process.env.PC_PROBE_WSLOG === '1') {
      page.wsLog = [];
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketFrameSent', (e) => { try { const m = JSON.parse(e.response.payloadData); if (/^events\./.test(m.type)) page.wsLog.push({ sent: m.type, projectId: m.projectId ?? null }); } catch { /* 不是 JSON */ } });
      cdp.on('Network.webSocketFrameReceived', (e) => { try { const m = JSON.parse(e.response.payloadData); if (/^events\./.test(m.type) || (m.type === 'error' && /projectId|事件/.test(String(m.detail ?? '')))) page.wsLog.push({ type: m.type, reason: m.reason ?? null, detail: m.detail ?? null, n: Array.isArray(m.items) ? m.items.length : null, opIds: (m.items ?? [m]).filter((x) => x.opId).length, callIds: (m.items ?? [m]).filter((x) => x.callId).length }); } catch { /* 不是 JSON */ } });
    }
    // 账号组合:用网站账号登录,在开始页的项目列表里点这个项目(创建者在「我建的」,成员在「我加入的」)
    await accountLogin(page, S.ORIGIN, who);
    const btn = await until(`${who.username} 的项目列表里有「${name}」`, async () => {
      const h = await page.evaluateHandle((n) => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row > button')].find((x) => x.textContent.trim() === n) ?? null, name);
      return h.asElement();
    }, 30_000, 300);
    if (!btn) throw new Error(`${who.username} 的项目列表里没有「${name}」`);
    await btn.click();
    await acceptConsentIfAsked(page);
    await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
    await page.waitForFunction(() => !!window.__pcStore && window.__pcStore.getState().project.tracks.length > 0, { timeout: 60_000 });
    await gateSettled(page);
    return { browser: b, page };
  }
  await joinOnline(page, { site: S.SITE, name, username: who.username, password: who.password, asCreator });
  return { browser: b, page };
}
async function selectCloud(page) {
  const can = await until('接入方式里有可选的「云端」', async () => { const o = (await providerOptions(page))?.options.find((x) => x.value === 'cloud'); return o && !o.disabled; }, 30_000, 200);
  if (!can) {
    // 排查用:当场截图,并记下 AI 栏里此刻有什么
    await shot(page, `select-cloud-missing-${Date.now().toString(36)}`);
    const seen = await P(page, () => ({ panel: !!document.querySelector('[data-pc="cloud-ai-panel"]'), agentOff: !!document.querySelector('[data-pc="online-agent-off"]'),
      wait: document.querySelector('[data-pc="cloud-permission-wait"], [data-pc="cloud-readonly-note"]')?.textContent ?? null,
      text: (document.querySelector('[data-pc="cloud-ai-panel"]') ?? document.querySelector('.ai-panel'))?.innerText?.slice(0, 300) ?? null })).catch((e) => ({ error: String(e) }));
    say('select-cloud.missing', seen);
  }
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
/** 一轮收尾的事件:旧组合的 Agent 服务记 `end`;账号组合的任务进程记 `runner_done`(收尾之后才交还任务授权) */
const isEnd = (e) => e.type === 'end' || e.type === 'runner_done';
const renderNode = async () => ((await S.renderStatus()).queue?.nodes ?? []).find((n) => n.projectId === PID) ?? null;
/** 等一个对话收尾;`render` 为真再等它引出的预渲染重试有结果。全程只读 Agent 服务盘上的对话记录与渲染服务的诊断 */
async function cloudFinishes(conversationId, { runMs = 120_000, render = true, renderMs = 420_000 } = {}) {
  const t0 = Date.now();
  const done = await until(`对话 ${conversationId} 跑到收尾`, () => { const d = S.diskConversation(PID, conversationId); return d && d.meta.state !== 'running' && d.events.some(isEnd) ? d : null; }, runMs, 200);
  const runMsTook = Date.now() - t0;
  let disk = done;
  if (render && done) {
    disk = await until(`对话 ${conversationId} 的预渲染重试有结果`, () => { const d = S.diskConversation(PID, conversationId); return d && d.events.some((e) => e.type === 'render' && ['done', 'failed', 'unavailable'].includes(e.state)) ? d : null; }, renderMs, 500) ?? S.diskConversation(PID, conversationId);
  }
  const events = disk?.events ?? [];
  return {
    disk, runMs: runMsTook, renderMs: Date.now() - t0,
    toolOk: events.filter((e) => e.type === 'tool_result' && e.ok === true).length,
    renderStates: events.filter((e) => e.type === 'render').map((e) => e.state),
    error: events.find((e) => e.type === 'error') ?? null,
  };
}

/**
 * 舞台上这个片段贴着预渲染结果、没有占位:2026-10-13 起每张卡的快照作废,预渲染结果只有轨道流一档(语义 `product/rendering.md`「预渲染」),
 * 所以看舞台的流播放器里含这个片段的那条流画出了帧;旧的快照层也认(`snapshot`),免得别的版本上误报
 */
const prerendered = (x) => !!x?.wrapper && !x.placeholder && (!!x.snapshot || (x.stream?.drawn ?? 0) > 0);
const stageLabel = (x) => (!x?.wrapper ? 'none' : x.placeholder ? `ph:${x.reason}` : (x.stream?.drawn ?? 0) > 0 ? 'stream' : x.snapshot ? 'snap' : 'live');
/** 播放着看舞台:等到几张重卡同时贴着预渲染结果(轨道流)、没有占位的那一刻,当场截图。回 `{ hit, seen, shot, stats }` */
async function playbackSnapshots(page, name, ms = 60_000, HEAVY = HEAVY_CLIPS) {
  const t0 = Date.now();
  const seen = new Set();
  let hit = null;
  let pic = null;
  await gateSettled(page);
  await store(page, 'S.actions.seek(0.2); S.actions.play(); return true;').catch(() => {});
  while (!hit && Date.now() - t0 < ms) {
    const states = {};
    for (const id of HEAVY) states[id] = await clipOnStage(page, id);
    seen.add(HEAVY.map((id) => stageLabel(states[id])).join('|'));
    if (HEAVY.every((id) => prerendered(states[id]))) {
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
/** 舞台截到的那一刻各重卡的状态(断言细节里看) */
const stageOf = (hit, ids = HEAVY_CLIPS) => (hit ? Object.fromEntries(ids.map((id) => [id, { stream: hit[id].stream, snapshot: hit[id].snapshot, placeholder: hit[id].placeholder }])) : null);
/** 在线页面此刻有没有「需要本地 PC 渲染辅助」的图标(舞台)或徽标(时间轴) */
async function localPcMarks(page, HEAVY = HEAVY_CLIPS) {
  const badge = await P(page, () => document.querySelectorAll('[data-pc="clip-custom-card"]').length).catch(() => -1);
  let icons = 0;
  for (const id of HEAVY) { const x = await clipOnStage(page, id); if (x?.placeholder && x.reason === 'unsupported') icons += 1; }
  return { badge, icons };
}
/**
 * 在线页面认下的预渲染结果(层表):每张卡的快照层(`layers`,2026-10-13 起不再产)与轨道流(`streams`,按流的顶层片段)合在一起,
 * 各带就绪的帧数(流是就绪的分段数)与出它的环境指纹;`stale` 是层表里已经过期的片段
 */
const onlineLayers = (page) => P(page, () => {
  const d = window.__pcOnlineSnapshots?.();
  if (!d) return null;
  const layers = [...(d.layers ?? []).map((l) => ({ clipId: l.clipId, kind: 'snapshot', ready: l.ready, env: l.envFingerprint })),
    ...(d.streams ?? []).map((s) => ({ clipId: s.clipId, kind: `stream:${s.kind}`, ready: s.ready, env: s.envFingerprint }))];
  return { layers, skipped: d.skipped, stale: [...(d.stale ?? []).map((s) => s.clipId), ...(d.staleStreams ?? [])] };
}).catch(() => null);

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
  // 「Agent 操作」只显示 bob 自己正在看的对话:创建者那个对话的这一轮不该出现在 bob 这里
  const bobAct = await activity(bob.page);
  check(`${tag} A4 另一位成员从在线浏览器进项目:项目是改动之后的样子;bob 的「Agent 操作」里没有混进创建者那个对话的操作`, !!got && got.title === want.title && got.statefulEnd === want.statefulEnd && got.canvasEnd === want.canvasEnd && (bobAct === null || bobAct.count < LEAVE_TOOLS), {
    project: got, bobActivity: bobAct ? { round: `${bobAct.index}/${bobAct.total}`, count: bobAct.count } : null,
  });
  await shot(bob.page, `${tag}-2-bob-sees-changes`);
  const play = await playbackSnapshots(bob.page, `${tag}-3-bob-stage-prerendered`);
  const marks = await localPcMarks(bob.page);
  const layers = await onlineLayers(bob.page);
  const heavyLayers = (layers?.layers ?? []).filter((l) => HEAVY.includes(l.clipId));
  const renderFp = S.renderFingerprint;
  check(`${tag} A5 他的舞台上是渲好的预渲染结果:播放时两张重卡都贴着轨道流、没有占位,没有「需要本地 PC 渲染辅助」;这几层是云节点渲染服务渲的;画面不是空白`, !!play.hit && marks.badge === 0 && marks.icons === 0
    && HEAVY.every((id) => heavyLayers.some((l) => l.clipId === id && l.ready > 0)) && (!renderFp || heavyLayers.every((l) => l.env === renderFp)) && !!play.stats && play.stats.colors >= 3 && play.stats.topShare < 0.985, {
    stage: stageOf(play.hit),
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
    // 桌面版自己不靠层表看画面;这里只核对云端渲好的层表在文档服务里(经这个页面自己的连接取):快照层(已作废)或轨道流里有这几张重卡
    const map = await P(back.page, async () => { const M = await import('/src/editor/sync/syncManager.ts'); const id = window.__pcStore.getState().project.id; const r = await M.currentSharedLink().request({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${id}` }); return { key: `layers:${id}`, found: r.type === 'content.item' && !r.missing, layers: [...(Array.isArray(r.body?.layers) ? r.body.layers.map((l) => l.clipId) : []), ...(Array.isArray(r.body?.streams) ? r.body.streams.flatMap((x) => (Array.isArray(x.clipIds) ? x.clipIds : [x.topClipId])) : [])] }; }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
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
  const actBack = await until(`${tag}:创建者的「Agent 操作」显示这一轮`, async () => { const a = await activity(back.page); return a && a.count > 0 ? a : null; }, 20_000, 200);
  const target = actBack ? await undoLatestStep(back.page) : null;
  const undoneMine = await until(`${tag}:撤销后创建者页面里参数回到上一次的值`, async () => ((await pageProject(back.page))?.rows === rowsOf(salt, 9) ? true : null), 10_000, 150);
  const undoneBob = await until(`${tag}:bob 的页面也看到撤销的结果`, async () => ((await pageProject(bob.page))?.rows === rowsOf(salt, 9) ? true : null), 10_000, 150);
  const titleKept = (await pageProject(bob.page))?.title === want.title;
  check(`${tag} A7 在「Agent 操作」里点「撤销这步」撤掉 Agent 的最后一处改动:参数回到上一次的值、按钮变成「已撤销」;别的成员看到撤销的结果,别的改动还在`, !!target?.done && !!undoneMine && !!undoneBob && titleKept, {
    undone: target ?? null, round: actBack ? `${actBack.index}/${actBack.total} · ${actBack.count} 次操作` : null, creatorSees: !!undoneMine, otherMemberSees: !!undoneBob, otherChangesKept: titleKept, ...(back.page.wsLog ? { wsEvents: back.page.wsLog.slice(0, 12) } : {}),
  });
  await shot(back.page, `${tag}-6-creator-undone`);
  const errors = [...(bob.page.pageErrors ?? []), ...(back.page.pageErrors ?? [])];
  check(`${tag} 这一遍的页面没有页面错误`, errors.length === 0, { sample: errors.slice(0, 3) });

  if (how === 'desktop') await desktopDown(back); else await closeBrowser(back.browser);
  await closeBrowser(bob.browser);
  return conv;
}

/* ================================================================== 真实模型的一遍(--real-model) */

/**
 * 模型换成这台电脑上桌面版已配好的 API 直连(只读地用,`server/agent-service/rehearsal-model.mjs`),任务是一句自然语言,断言只看结果:
 * 发起方的浏览器进程被结束后云端做完 → 重卡渲出来 → 另一位成员的页面看得到改动、署名对、舞台上是渲好的 → 创建者重开找得回对话 →「撤销这步」。
 * 真实模型的一轮只有二十来秒,比文档服务保留断掉会话的 60 秒短,所以这里不断言「写入落在没有任何成员连接之后」(那一条由模拟模型的跑法验)。
 */
async function realPass(how, tag) {
  const TASK = '请直接改这个项目,不用问我:1)把图表那张卡(片段 clip-bars)的标题改成「季度渠道占比」;2)把它数据里「微信」那一行的数值改成 91;3)把片段 clip-stateful 的结束时间改成第 2.5 秒(开始时间不变)。做完用一句话告诉我改了什么。';
  const filesBefore = S.assetFiles();
  let actor;
  if (how === 'desktop') {
    actor = await desktopUp({ open: PROC_FILE });
    await until(`${tag}:桌面版回到这个共享项目`, async () => (await sharedProjectOf(actor.page)) === PID, 120_000, 500);
  } else {
    actor = await onlineUp(CRED.creator, { asCreator: true });
  }
  await selectCloud(actor.page);
  const t0 = Date.now();
  await sendText(actor.page, TASK);
  const conv = await until(`${tag}:任务被云端接下`, async () => { const id = await conversationOf(actor.page); return id && S.diskConversation(PID, id)?.events.some((e) => e.type === 'user') ? id : null; }, 60_000, 100);
  timings[`${tag}.acceptedMs`] = Date.now() - t0;
  await shot(actor.page, `${tag}-1-accepted`);
  let gone;
  if (how === 'desktop') { const k = await desktopKill(actor); gone = k.browserGone && k.serverGone && k.portsFree; } else { const k = await killBrowser(actor.browser); browsers.delete(actor.browser); gone = k.gone; }
  const stateAtKill = S.diskConversation(PID, conv)?.meta?.state ?? null;
  check(`${tag} RA1 发起方用一句自然语言发出任务、被云端接下后进程被真的结束`, !!conv && gone === true, { accepted: !!conv, initiatorGone: gone, runStateWhenKilled: stateAtKill });

  const fin = await cloudFinishes(conv, { runMs: 600_000 });
  timings[`${tag}.runMs`] = fin.runMs;
  timings[`${tag}.renderedMs`] = fin.renderMs;
  const events = fin.disk?.events ?? [];
  const used = {};
  for (const e of events.filter((x) => x.type === 'tool_call')) used[e.name] = (used[e.name] ?? 0) + 1;
  const said = events.filter((e) => e.type === 'text').map((e) => e.delta ?? '').join('');
  check(`${tag} RA2 发起方不在了,对话照样跑到结束(模型自己决定怎么改),助手交代了结果`, fin.disk?.meta?.state === 'idle' && !fin.error && said.trim().length > 0 && (used.update_clip ?? 0) + (used.set_clip ?? 0) >= 1, {
    state: fin.disk?.meta?.state ?? null, tools: used, reply: said.slice(0, 200), error: fin.error ? String(fin.error.message ?? '').slice(0, 160) : null, runMs: fin.runMs,
  });
  check(`${tag} RA3 被改动的重卡由云节点的渲染服务渲出来、产物入库`, fin.renderStates.at(-1) === 'done' && S.assetFiles() > filesBefore, { renderEvents: fin.renderStates, assetFiles: [filesBefore, S.assetFiles()], renderedMs: fin.renderMs });

  const bob = await onlineUp(CRED.bob);
  const got = await until(`${tag}:bob 的页面读到改动`, async () => { const p = await pageProject(bob.page); return p && p.title === '季度渠道占比' ? p : null; }, 30_000, 200);
  const bobAct = await activity(bob.page);
  check(`${tag} RA4 另一位成员从在线浏览器进项目:三处改动都在;bob 的「Agent 操作」里没有混进创建者那个对话的操作`, !!got && /微信\s*,\s*91/.test(String(got.rows ?? '')) && got.statefulEnd === 2.5 && (bobAct === null || bobAct.count === 0), {
    project: got, bobActivity: bobAct ? { round: `${bobAct.index}/${bobAct.total}`, count: bobAct.count } : null,
  });
  await shot(bob.page, `${tag}-2-bob-sees-changes`);
  const play = await playbackSnapshots(bob.page, `${tag}-3-bob-stage-prerendered`);
  const marks = await localPcMarks(bob.page);
  check(`${tag} RA5 他的舞台上是渲好的预渲染结果:两张重卡贴着轨道流、没有占位,没有「需要本地 PC 渲染辅助」;画面不是空白`, !!play.hit && marks.badge === 0 && !!play.stats && play.stats.colors >= 3 && play.stats.topShare < 0.985, {
    stage: stageOf(play.hit), statesSeenWhilePlaying: play.seen, localPcBadges: marks.badge, pixels: play.stats, shot: play.shot,
  });

  let back;
  if (how === 'desktop') {
    back = await desktopUp({ open: PROC_FILE });
    await until(`${tag}:重新打开后回到同一个共享项目`, async () => (await sharedProjectOf(back.page)) === PID, 120_000, 500);
  } else {
    back = await onlineUp(CRED.creator, { asCreator: true });
  }
  await until(`${tag}:重新打开后接入方式里有「云端」`, async () => (await providerOptions(back.page))?.options.some((o) => o.value === 'cloud'), 30_000, 200);
  const opened = await openFromHistory(back.page, conv);
  const full = await until(`${tag}:点开后完整过程都在`, async () => { const m = await msgs(back.page); return m && toolParts(m).length >= 1 && (lastAssistant(m)?.text ?? '').trim() ? m : null; }, 30_000, 200);
  const a = lastAssistant(full);
  const mine = await pageProject(back.page);
  check(`${tag} RA6 创建者重新打开(新进程):历史里找得到这段对话,过程与结果都在,项目是最新版本,云端渲染完成的状态在`, !!opened.hit && opened.hit.state !== 'running' && !!full && toolParts(full).length === events.filter((e) => e.type === 'tool_call').length
    && (a?.statuses ?? []).some((s) => /云端渲染完成/.test(s)) && mine?.title === '季度渠道占比' && mine?.statefulEnd === 2.5, {
    listed: opened.hit, toolCalls: toolParts(full ?? []).length, reply: (a?.text ?? '').slice(0, 80), renderStatus: (a?.statuses ?? []).filter((s) => /渲染/.test(s)), project: mine,
  });
  await shot(back.page, `${tag}-4-creator-reopened`);
  const before = JSON.stringify(await pageProject(back.page));
  const actBack = await until(`${tag}:创建者的「Agent 操作」显示这一轮`, async () => { const a = await activity(back.page); return a && a.count > 0 ? a : null; }, 20_000, 200);
  const target = actBack ? await undoLatestStep(back.page) : null;
  const undoneMine = await until(`${tag}:撤销后创建者页面里项目变了`, async () => (JSON.stringify(await pageProject(back.page)) !== before ? true : null), 10_000, 150);
  const mineAfter = await pageProject(back.page);
  const undoneBob = await until(`${tag}:bob 的页面也看到撤销的结果`, async () => { const p = await pageProject(bob.page); return p && p.title === mineAfter?.title && p.rows === mineAfter?.rows && p.statefulEnd === mineAfter?.statefulEnd ? true : null; }, 10_000, 150);
  check(`${tag} RA7 在「Agent 操作」里点「撤销这步」撤掉 Agent 的一处改动:按钮变成「已撤销」,创建者与别的成员都看到撤销的结果`, !!target?.done && !!undoneMine && !!undoneBob, {
    undone: target ?? null, after: mineAfter ? { title: mineAfter.title, rows: mineAfter.rows, statefulEnd: mineAfter.statefulEnd } : null, otherMemberSees: !!undoneBob,
  });
  const errors = [...(back.errors ?? []), ...(bob.errors ?? [])];
  check(`${tag} 这一遍的页面没有页面错误`, errors.length === 0, { sample: errors.slice(0, 3) });
  if (how === 'desktop') await desktopDown(back); else await closeBrowser(back.browser);
  await closeBrowser(bob.browser);
  // 模型往返次数与 token 数(读本机这份 Agent 服务的用量流水)
  const dir = path.join(TMP, 'agent', 'usage');
  const rows = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })).filter((r) => r && r.kind !== 'service') : [];
  process.stdout.write(`${JSON.stringify({ realModel: { modelCalls: rows.length, input: rows.reduce((n, r) => n + (r.input ?? 0), 0), output: rows.reduce((n, r) => n + (r.output ?? 0), 0), model: rows[0]?.model ?? null, usageDirFound: fs.existsSync(dir) } })}\n`);
}

/* ================================================================== 主流程 */

async function setupOld() {
  // 渲染服务照部署模板的配置起:能产轨道流(`PROMPTCUT_RENDER_STREAMS=1`)。2026-10-13 起每张卡的快照作废,预渲染结果只有轨道流一档
  // (语义 `product/rendering.md`「预渲染」),云端渲染出的就是重卡的轨道流
  S = await startStack({ tmp: TMP, ports: PORTS, dist: DIST, say, renderEnv: { PROMPTCUT_RENDER_STREAMS: '1' }, ...(REAL ? { agentEnv: { PROMPTCUT_AGENT_REHEARSAL_DESKTOP_MODEL: '1' } } : {}) });
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
  // 创建者打开「生成轨道流」(语义 `product/rendering.md`「谁产流与托管方开关」:关着时托管方的渲染节点完全不为这个项目产流,
  // 「云端 Agent 改完、全程没有成员在线,重卡由云节点渲出来」就只有打开这一项才成立);照页面同一个创建者操作(`shared.admin set-hosted-option`)
  const streamsOn = await withCreatorConn((conn) => adminOp(conn, PROJ, 'set-hosted-option', { service: 'render', option: 'streams', enabled: true }));
  const renderSees = await until('渲染服务看到这个项目「生成轨道流」开着', async () => ((await S.renderStatus()).projects ?? []).find((p) => p.projectId === PID)?.streams === true, 30_000, 300);
  check('X0 创建者打开「生成轨道流」,渲染服务能产流、看到这一项开着', streamsOn?.type === 'shared.admin.ok' && !!renderSees, { reply: streamsOn?.type ?? null, reason: streamsOn?.reason ?? null, renderSees: !!renderSees });
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

/* ================================================================== 账号组合(在线各步) */

/** 主项目的内容:两张探针重卡加一张带参数的图表卡(与桌面版那一遍同一份) */
const seedProject = (id, name, salt) => ({
  version: 1, id, name, width: 1920, height: 1080, fps: 30, duration: 3, themeId: 'dark', camera3dFov: 50,
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, transitions: [],
  tracks: [
    { id: 'tr-0', name: '图表', hidden: false, clips: [{ id: 'clip-bars', kind: 'card', cardId: 'rank-bars', start: 0, end: 3, params: { title: '原文案', rows: '微信,85|抖音,62', suffix: '%' } }] },
    { id: 'tr-1', name: '重卡甲', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'probe-slow-stepped', start: 0, end: 3, params: { burnMs: 40, label: '重卡甲' } }] },
    { id: 'tr-2', name: '重卡乙', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'probe-slow-stepped', start: 0, end: 3, params: { burnMs: 40, label: `重卡乙 ${salt}` } }] },
  ],
});
/** 用户卡一步的创建者账号名(在线页面里自己新建项目;也要在「生成轨道流」的权限分组里) */
const UC_CREATOR = `ula${randomBytes(3).toString('hex')}`;

/**
 * 换到账号组合:先把口令式的旧组合停干净(端口要让出来),再起账号组合与真渲染服务,建好主项目:
 *   - 主项目就是账号夹具建的那个(创建者 dualUser0 新建、dualUser1 经项目链接加入;账号与口令都是夹具的测试值);
 *   - 内容由创建者的探针连接放进去(三张卡,同桌面版那一遍);
 *   - 创建者在在线页面的项目设置里打开「托管方的渲染节点」与「生成轨道流」(语义 `product/rendering.md`「谁产流与托管方开关」:
 *     关着时托管方的渲染节点不为成员预览产流;探针让网站后端把创建者当托管方管理员,它总在权限分组里);
 *   - 第三个账号(carol,探针现注册)在在线页面里经项目链接加入(E5 用)。
 */
async function setupAccount() {
  if (S) {
    await S.stop().catch(() => {});
    await sleep(500);
    const busy = await S.portsStillBusy().catch(() => []);
    check('换账号组合之前:口令式的旧组合退干净,端口无监听', busy.length === 0, { stillListening: busy });
    S = null;
  }
  if (!DIST) { DIST = path.join(TMP, 'dist-online'); say('build-online', { dist: DIST }); buildOnline(DIST); }
  // 账号后端在本进程里跑,`ACCOUNT_ADMINS` 每次现读;只改本探针进程的环境
  process.env.ACCOUNT_ADMINS = ['dualuser0', UC_CREATOR].join(',');
  S = await startAccountStack({ tmp: TMP, ports: { base: ACCT_BASE, stageA: PORTS.stageA, stageB: PORTS.stageB, render: PORTS.render }, dist: DIST, say, renderLimits: { stallMs: RENDER_STALL_MS } });
  S.startRender();
  const ready = await S.waitRenderReady();
  const renderVersion = String(ready.queue.codeVersion ?? '');
  let pageHasVersion = false;
  const walk = (dir) => { for (const i of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, i.name); if (i.isDirectory()) walk(p); else if (!pageHasVersion && /\.(m?js|html)$/.test(i.name) && fs.readFileSync(p, 'utf8').includes(renderVersion)) pageHasVersion = true; } };
  if (/^[0-9a-f]{64}$/.test(renderVersion)) walk(S.DIST);
  const agentVersion = (() => { try { return S.wiring?.publisher?.codeVersion?.() ?? null; } catch { return null; } })();
  S.renderFingerprint = ready.queue.envFingerprint ?? ready.queue.fingerprint ?? ready.worker?.fingerprint ?? null;
  check('X1 账号组合起来(账号后端、账号模式的文档服务、素材服务、Agent 主服务与任务槽、真渲染服务);渲染服务、云端 Agent 主服务发的计划、在线页面的代码版本相同', /^[0-9a-f]{64}$/.test(renderVersion) && agentVersion === renderVersion && pageHasVersion, {
    renderCodeVersion: renderVersion.slice(0, 12), agentPlanCodeVersion: String(agentVersion).slice(0, 12), onlineBuildEmbedsIt: pageHasVersion, renderFingerprint: S.renderFingerprint, renderStreams: ready.streams ?? null,
  });
  const f = S.fixture;
  CRED.creator = { username: f.accounts[0].name, password: f.accounts[0].password };
  CRED.bob = { username: f.accounts[1].name, password: f.accounts[1].password };
  CRED.carol = await S.register(`carol${randomBytes(3).toString('hex')}`, pw()).then((a) => ({ username: a.name, password: a.password, accountId: a.accountId }));
  PID = f.projectId;
  NAME = 'Shared dual account project';
  PROJ = { projectId: PID };
  ACTOR = await f.connectActor(0);
  const put = await ACTOR.send({ type: 'project.op', projectId: PID, opId: `seed-${RUN}`, session: 's-seed', ops: [{ op: 'set', path: '', value: seedProject(PID, NAME, SALT) }] });
  await ACTOR.close();
  if (put.type !== 'project.op.ok') throw new Error(`放主项目的内容没成:${JSON.stringify(put).slice(0, 200)}`);

  /* ---- 创建者在在线页面里打开「生成轨道流」 */
  const c = await onlineUp(CRED.creator, { asCreator: true });
  const provider = await until('X1:接入方式下拉出现', () => providerOptions(c.page), 30_000, 200);
  await openProjectSettings(c.page);
  const agentRow = await until('X1:项目设置里出现「云端 Agent」一行', () => hostedToggle(c.page, 'agent'), 15_000, 200);
  let renderRow = await hostedToggle(c.page, 'render');
  if (renderRow && !renderRow.checked) {
    await creatorToggleService(c.page, 'render');
    renderRow = await until('X1:「托管方的渲染节点」勾上', async () => { const r = await hostedToggle(c.page, 'render'); return r?.checked ? r : null; }, 15_000, 200);
  }
  const streamsBefore = await until('X1:渲染节点下面有「生成轨道流」一行', () => hostedOption(c.page, 'render', 'streams'), 15_000, 200);
  const confirmText = streamsBefore && !streamsBefore.checked ? await creatorToggleOption(c.page, 'render', 'streams') : null;
  const streamsRow = await until('X1:「生成轨道流」勾上', async () => { const r = await hostedOption(c.page, 'render', 'streams'); return r?.checked ? r : null; }, 15_000, 200);
  const renderSees = await until('X1:渲染服务看到这个项目「生成轨道流」开着', async () => ((await S.renderStatus()).projects ?? []).find((p) => p.projectId === PID)?.streams === true, 30_000, 300);
  const agentSees = await until('X1:云端 Agent 主服务的发布通道看到「生成轨道流」开着', () => S.wiring.publisher.availability(PID)?.streams === true, 30_000, 300);
  await shot(c.page, 'X1-online-settings');
  check('X1 创建者在在线页面的项目设置里打开「生成轨道流」(账号项目不再验证创建者口令,直接确认):渲染服务与云端 Agent 主服务都看到这一项开着', !!streamsBefore && !!streamsRow && !!renderSees && !!agentSees && !!renderRow?.checked, {
    before: streamsBefore, after: streamsRow, confirm: confirmText ? confirmText.slice(0, 80) : null, renderNode: renderRow, renderSees: !!renderSees, agentSees: !!agentSees,
  });
  // 在线构建里接入方式只有「云端」(原来的「桌面版的 AI 栏里多了云端、本机驱动仍是缺省」那一条只属于桌面版那一遍)
  check('X1 项目放云端(账号项目):项目设置里有「云端 Agent」一行(与「托管方的渲染节点」放在一起),勾着、创建者可改;在线页面的接入方式只有「云端」且选中', !!agentRow && agentRow.checked && !agentRow.disabled && !!provider && provider.value === 'cloud' && provider.options.length === 1, { agent: agentRow, provider });
  await closeDialogs(c.page);
  await closeBrowser(c.browser);

  /* ---- carol 经项目链接加入 */
  const cb = await openBrowser();
  const cp = await newPage(cb);
  await accountLogin(cp, S.ORIGIN, CRED.carol);
  await cp.waitForSelector('[data-pc="cloud-project-link"]', { visible: true, timeout: 30_000 });
  await typeIntoField(cp, '[data-pc="cloud-project-link"]', `${S.ORIGIN}/editor?project=${encodeURIComponent(PID)}`);
  await cp.waitForFunction(() => { const b = document.querySelector('[data-pc="cloud-join"]'); return b && !b.disabled; }, { timeout: 30_000 });
  await cp.click('[data-pc="cloud-join"]');
  await acceptConsentIfAsked(cp, 8000);
  const joined = await until('X1:carol 经项目链接进了项目', () => P(cp, () => !!document.querySelector('[data-pc="members-button"]') && (window.__pcStore?.getState().project.tracks.length ?? 0) > 0), 60_000, 300);
  check('X1 第三个账号(carol)在在线页面里经项目链接加入这个项目', !!joined, { account: CRED.carol.username });
  await closeBrowser(cb);
}
/** 清空一个输入框再打字(全选删掉) */
async function typeIntoField(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.focus(sel);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
  await page.type(sel, text);
}

/** 这一轮此刻在跑:云端 AI 栏里有「停止」按钮,或会话视图说在流式(账号模式下视图在第一条消息之前是空的,所以两样都看) */
const runningNow = async (page) => !!(await page.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]').catch(() => null)) || !!(await view(page))?.streaming;
const idleNow = async (page) => !(await runningNow(page));
/** 最后一条助手消息里给人看的几样(断言细节里记) */
const replyOf = (m) => { const a = lastAssistant(m); return a ? { outcome: a.outcome ?? null, error: a.error ?? null, statuses: a.statuses ?? [], text: (a.text ?? '').slice(0, 80), pending: a.pending ?? null } : null; };

async function stopStep() {
  const salt = `${SALT}-s`;
  /* ---- B1:创建者在在线浏览器里发起更长的任务后退出(浏览器进程被结束);bob 之后进来看着 */
  const d1 = await onlineUp(CRED.creator, { asCreator: true });
  await selectCloud(d1.page);
  // 22 次写入、每次隔 8 秒(一轮最多 24 次模型往返),整轮约 3 分钟:够发起方断掉的会话保留期满、另一位成员看一会儿、创建者再重新打开接上
  const sent = await sendAndAccepted(d1.page, writeScript(22, 8000, salt), 2);
  const conv = sent.conversationId;
  const k = await killBrowser(d1.browser);
  browsers.delete(d1.browser);
  const tGone = Date.now();
  const bob = await onlineUp(CRED.bob);
  // 改动一条条出现:bob 页面里的项目在 20 秒里变了几次
  const counts = [];
  const t0 = Date.now();
  let lastState = null;
  while (Date.now() - t0 < 20_000) {
    const p = await pageProject(bob.page).catch(() => null);
    const state = p ? JSON.stringify(p) : null;
    if (state && state !== lastState) { counts.push(counts.length + 1); lastState = state; }
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
  check('S B1 发起方(在线浏览器)退出后,另一位成员从在线浏览器进项目看着:改动一条条出现;成员列表里创建者名下有「〈创建者〉的云端 Agent」而他本人不在线', sent.accepted && k.gone
    && counts.length >= 3
    && !!aliceRow && aliceRow.cloudRow === creatorSign() && !aliceRow.editing && !(mem?.rows ?? []).some((r) => r.editing && !/自己/.test(r.text)), {
    initiatorGone: k.gone, projectChangesSeen: counts.length, members: { button: mem?.button, rows: mem?.rows.map((r) => r.text.slice(0, 70)) }, sign: creatorSign(),
  });
  await shot(bob.page, 'S-1-bob-watching');

  /* ---- B2:创建者换一个新的浏览器进程(在线页面、同一个账号)重新打开:历史列表里这个对话标着在跑,点开接上看得到过程;点「停止」后停下 */
  const d2 = await onlineUp(CRED.creator, { asCreator: true });
  const providerOnOpen = (await providerOptions(d2.page))?.value ?? null;
  const opened2 = await openFromHistory(d2.page, conv);
  await shot(d2.page, 'S-2-creator-reopened');
  const attached = await until('S:接上还在跑的对话', async () => { const m = await msgs(d2.page); return (await runningNow(d2.page)) && (await conversationOf(d2.page)) === conv && toolParts(m).length >= 2 ? { tools: toolParts(m).length } : null; }, 30_000, 100);
  const tools1 = toolParts(await msgs(d2.page)).length;
  await sleep(9500);
  const tools2 = toolParts(await msgs(d2.page)).length;
  const tStop = Date.now();
  await d2.page.click('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]').catch(() => {});
  const stopped = await until('S:点「停止」后停下', () => idleNow(d2.page), 60_000, 50); // 等待时限只为防卡死(原 5 秒)
  timingLog.record('S 点「停止」到这一轮停下', stopped ? Date.now() - tStop : null, { formerLimit: '< 5 秒' });
  const stopMs = Date.now() - tStop;
  const shown = replyOf(await msgs(d2.page));
  const diskStop = await until('S:云端记下这一轮已停下', () => { const d = S.diskConversation(PID, conv); return d && d.meta.state !== 'running' ? d : null; }, 30_000, 200);
  const p1 = await pageProject(bob.page);
  await sleep(1500);
  const p2 = await pageProject(bob.page);
  const okWrites = (diskStop?.events ?? []).filter((e) => e.type === 'tool_result' && e.ok === true).length;
  const lastWords = (diskStop?.events ?? []).filter((e) => e.type === 'text').map((e) => e.delta ?? e.text ?? '').join('');
  check('S B2 创建者换一个浏览器进程重新打开(在线页面):接入方式是「云端」,历史里找得到这个对话,点开接上后看得到它还在跑、过程接着出来;点「停止」后停下(用时只记录),云端记下这一轮停了、没说完最后那句,之后项目不再变', providerOnOpen === 'cloud'
    && !!opened2.hit && !!attached && tools2 > tools1 && !!stopped && !!diskStop && diskStop.meta.state === 'idle' && !lastWords.includes('都做完了') && okWrites >= 2 && okWrites < 22 && JSON.stringify(p1) === JSON.stringify(p2), {
    providerOnOpen, listed: opened2.hit, attachedWithToolCalls: attached?.tools ?? null, toolCallsWhileWatching: [tools1, tools2], stopMs, shown, recorded: diskStop ? { state: diskStop.meta.state, grant: diskStop.meta.grant, outcome: diskStop.meta.outcome } : null,
    lastEvents: (diskStop?.events ?? []).slice(-4).map((e) => [e.type, e.code ?? e.reason ?? e.state ?? null]), writesLanded: okWrites, quietAfter: JSON.stringify(p1) === JSON.stringify(p2),
  });
  await shot(d2.page, 'S-3-creator-stopped');

  /* ---- B3:另一台设备(又一个浏览器进程、同一个账号)打开同一个对话,接着看、接着说 */
  const other = await onlineUp(CRED.creator, { asCreator: true });
  const opened = await openFromHistory(other.page, conv);
  const seen = await until('S:另一台设备上看得到同一个对话的过程', async () => { const m = await msgs(other.page); return m && toolParts(m).length === toolParts(await msgs(d2.page)).length && toolParts(m).length >= 2 ? m : null; }, 30_000, 200);
  const shownThere = replyOf(seen);
  const stoppedThere = !!seen && opened.hit?.state !== 'running' && !(await runningNow(other.page)) && !String(shownThere?.text ?? '').includes('都做完了');
  await sendText(other.page, mockSteps([{ tool: 'update_clip', input: { clipId: CLIPS.bars, label: '换了设备接着说' } }, { say: '在另一台设备上接着说的' }]));
  const said = await until('S:另一台设备上接着说的这一轮跑完', async () => { const m = await msgs(other.page); const a2 = lastAssistant(m); return a2 && !a2.pending && (a2.text ?? '').includes('在另一台设备上接着说的') ? m : null; }, 60_000, 150);
  const deskSees = await until('S:先前那台设备开着的同一个对话也看到这一轮', async () => { const m = await msgs(d2.page); return (lastAssistant(m)?.text ?? '').includes('在另一台设备上接着说的') ? m : null; }, 20_000, 200);
  const labelBob = await until('S:改动落地(bob 的页面看到)', async () => ((await pageProject(bob.page))?.label === '换了设备接着说' ? true : null), 10_000, 150);
  check('S B3 另一台设备(另一个浏览器进程、同一个账号)打开同一个对话:过程都在、是停下的(不在跑、没有最后那句);接着说一句,新的一轮正常跑完、改动落地;先前那台设备上的同一个对话也看到', !!opened.hit && !!seen && stoppedThere && !!said
    && said.filter((x) => x.role === 'user').length === 2 && !!deskSees && deskSees.filter((x) => x.role === 'user').length === 2 && !!labelBob, {
    listed: opened.hit, toolCallsSeen: seen ? toolParts(seen).length : null, stoppedShown: stoppedThere, shownThere, continued: !!said, userMessages: said?.filter((x) => x.role === 'user').length ?? null, firstDeviceSeesNewRun: !!deskSees, changeLanded: !!labelBob,
  });
  await shot(other.page, 'S-4-other-device-continued');
  await closeBrowser(other.browser);
  await closeBrowser(d2.browser);
  await closeBrowser(bob.browser);
}

async function errorsStep() {
  /** 项目内容与版本号(探针自己的创建者连接;这一步不要求「没有成员在线」) */
  const snap = () => withCreatorConn(async (c) => { const p = S.account ? await c.project() : await projectOf(c, PID); return { rev: p.rev, project: p.project }; });
  const quiet = async () => { const a = (await snap()).rev; await sleep(1500); return (await snap()).rev === a; };
  const sane = async (before, okWrites) => { const calm = await quiet(); const after = await snap(); return { ok: after.rev === before.rev + okWrites && calm && intact(after.project), rev: [before.rev, after.rev], noWritesAfter: calm, projectIntact: intact(after.project) }; };
  /** 这个对话里序号大于 `after` 的成功写入数(同一个对话连着跑几轮时,只数这一轮的) */
  const okOf = (conv, after = 0) => (S.diskConversation(PID, conv)?.events ?? []).filter((e) => e.type === 'tool_result' && e.ok === true && e.seq > after).length;
  const seqOf = (conv) => S.diskConversation(PID, conv)?.meta?.lastSeq ?? 0;
  const errText = async (page) => { const a = lastAssistant(await msgs(page)); return { outcome: a?.outcome ?? null, error: a?.error ?? null, statuses: a?.statuses ?? [], text: (a?.text ?? '').slice(0, 120) }; };
  /** 云端记下的这个对话最近一轮的结局(断言细节里看):账本里的任务授权状态与结局、最后几条事件 */
  const recordOf = (conv) => { const d = S.diskConversation(PID, conv); return d ? { state: d.meta.state, grant: d.meta.grant ?? null, outcome: d.meta.outcome ?? null, reason: d.meta.reason ?? null, last: d.events.slice(-4).map((e) => [e.type, e.code ?? e.reason ?? e.state ?? null, String(e.message ?? '').slice(0, 60)]) } : null; };
  /** 托管方管理云端 Agent 额度的命令(只改 Agent 服务数据目录下的额度配置;账号组合是各代任务进程共用的数据目录) */
  const AGENT_DATA = S.account ? S.fixture.dataDir : S.D.agent;
  const admin = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'agent-service', 'admin.mjs'), ...a], { cwd: ROOT, env: { ...process.env, PROMPTCUT_AGENT_DATA: AGENT_DATA }, windowsHide: true, encoding: 'utf8' });

  /* ---- E1:模型调用失败。发起方发完就被结束,事后重新打开看 */
  {
    const before = await snap();
    const c1 = await onlineUp(CRED.creator, { asCreator: true });
    await selectCloud(c1.page);
    await sendText(c1.page, mockSteps([{ sleepMs: 600 }, writeStep(1, 'm'), { sleepMs: 600 }, writeStep(4, 'm'), { sleepMs: 1500 }, { fail: '上游接口 500(探针注入)' }, writeStep(7, 'm')]));
    await until('E1:消息发出、这一轮开始', async () => (await runningNow(c1.page)) || (await view(c1.page))?.streaming, 30_000, 50);
    const conv = await conversationOf(c1.page);
    const k = await killBrowser(c1.browser);
    browsers.delete(c1.browser);
    await until('E1:这一轮收尾', () => { const d = S.diskConversation(PID, conv); return d && d.meta.state !== 'running' && d.events.some(isEnd) ? d : null; }, 90_000, 200);
    const s = await sane(before, 2);
    const c2 = await onlineUp(CRED.creator, { asCreator: true });
    const opened = await openFromHistory(c2.page, conv);
    await until('E1:重新打开后对话里有这一轮', async () => { const a = lastAssistant(await msgs(c2.page)); return a && !a.pending ? a : null; }, 30_000, 200);
    const e = await errText(c2.page);
    const text = await panelText(c2.page);
    check('E1 模型调用失败(发起方已退出,重新打开看):对话记录里有「模型调用失败」与接口给的原因,历史列表里标「出错」;项目停在失败前最后一次成功写入', k.gone && e.outcome === 'error' && /模型调用失败/.test(e.error ?? '') && /上游接口 500/.test(e.error ?? '') && text.includes('模型调用失败')
      && opened.hit?.state === 'failed' && /出错/.test(opened.hit.text) && s.ok && okOf(conv) === 2, { initiatorGone: k.gone, shown: e, listed: opened.hit, writesLanded: okOf(conv), recorded: recordOf(conv), ...s });
    await shot(c2.page, 'E1-model-failed');
    await closeBrowser(c2.browser);
  }

  // 后面三种都在创建者的同一个在线页面里做(页面开着,原因当场出现在对话里)
  const c = await onlineUp(CRED.creator, { asCreator: true });
  await selectCloud(c.page);
  const runAndWait = async (prompt, ms = 90_000) => {
    const usersBefore = ((await msgs(c.page)) ?? []).filter((x) => x.role === 'user').length;
    await sendText(c.page, prompt);
    // 有的轮一开始就收尾(额度用尽):看的是「对话里多了一条用户消息」,不是「此刻还在跑」
    await until('这一轮开始', async () => ((await msgs(c.page)) ?? []).filter((x) => x.role === 'user').length > usersBefore, 30_000, 50);
    const convNow = await conversationOf(c.page);
    await until('这一轮收尾', async () => { const a = lastAssistant(await msgs(c.page)); const d = S.diskConversation(PID, convNow); return (await idleNow(c.page)) && a && !a.pending && d && d.meta.state !== 'running' ? true : null; }, ms, 100);
    return convNow;
  };

  /* ---- E2:额度用尽 */
  {
    const before = await snap();
    // 额度的起点必须是「此刻真实的已用量」:前面几步(E1 那一轮的收尾记账、渲染、后台作业)的用量流水可能晚几秒才落齐,
    // 读到的比真实的小,上限就比真实用量还低,第一条消息发出时就被发送前的额度检查拒掉,E2 要测的「一轮中途额度用完」就没了。
    // 所以:连着读到相同的两次(隔 2 秒)才算稳定;设上限后再读一次核对,变了就按新值重设。余量仍是 1 个 token(第一次模型调用放行,记账后用完)
    const readUsed = () => { const r = admin('usage', '--project', PID, '--json'); try { return JSON.parse(String(r.stdout).trim().split('\n').at(-1))?.tokens ?? 0; } catch { return 0; } };
    let used = readUsed();
    for (let i = 0; i < 10; i++) { await sleep(2000); const again = readUsed(); if (again === used) break; used = again; }
    let set;
    for (let i = 0; i < 5; i++) { set = admin('quota', 'set', PID, '--tokens', String(used + 1)); const now = readUsed(); if (now === used) break; used = now; }
    await sleep(400);
    const conv = await runAndWait(mockSteps([writeStep(1, 'q'), { sleepMs: 300 }, writeStep(4, 'q'), writeStep(7, 'q'), { say: '不会到' }]));
    const e = await errText(c.page);
    const s = await sane(before, okOf(conv));
    // 再发:被明确拒绝并说明。等的必须是这次再发引出的拒绝:点之前那一轮的助手消息已经带着「额度」,
    // 只看「最后一条助手消息带额度」会在点下去的那一刻就成立,接着清额度,再发的那条就被合法收下开跑(探针自己的竞态)
    const assistantsBefore = (await msgs(c.page)).filter((x) => x.role === 'assistant').length;
    await sendText(c.page, mockSteps([{ say: 'x' }]));
    const notice = await until('E2:再发被拒绝并说明', async () => {
      const n = await c.page.$eval('[data-pc="cloud-notice"]', (el) => el.textContent ?? '').catch(() => null);
      if (n) return n;
      const all = await msgs(c.page);
      const a = lastAssistant(all);
      return a && !a.pending && /额度/.test(String(a.error ?? '')) && all.filter((x) => x.role === 'assistant').length > assistantsBefore ? `对话里:${a.error}` : null;
    }, 30_000, 100);
    admin('quota', 'clear', PID);
    await sleep(400);
    await c.page.click('[data-pc="cloud-notice"]').catch(() => {});
    await until('E2:清掉额度前那一轮收尾', () => idleNow(c.page), 30_000, 100);
    await sendText(c.page, mockSteps([{ say: '额度清掉后恢复' }]));
    const again = await until('E2:清掉额度后恢复', async () => (lastAssistant(await msgs(c.page))?.text ?? '').includes('额度清掉后恢复'), 60_000, 150);
    check('E2 额度用尽:对话记录里有带已用与上限的原因,已落地的保留;再发被明确拒绝并说明;清掉额度后恢复', set.status === 0 && e.outcome === 'error' && /额度已用完\(已用 \d+ \/ 上限 \d+\)/.test(e.error ?? '') && okOf(conv) >= 1 && okOf(conv) < 3 && s.ok && /额度/.test(String(notice ?? '')) && !!again, {
      usedBefore: used, shown: e, writesLanded: okOf(conv), recorded: recordOf(conv), ...s, nextRequestNotice: notice, afterClear: !!again,
    });
    await shot(c.page, 'E2-quota-exceeded');
  }

  /* ---- E3:创建者中途关了开关(在项目设置里取消勾选;账号项目不再验证创建者口令,直接确认) */
  {
    await until('E3:上一轮收尾', () => idleNow(c.page), 30_000, 100);
    const before = await snap();
    const conv = await conversationOf(c.page);
    const mark = seqOf(conv);
    await sendText(c.page, writeScript(30, 500, 'sw'));
    await until('E3:这一轮开始并有写入', async () => okOf(conv, mark) >= 1 && (await runningNow(c.page)), 40_000, 80);
    await openProjectSettings(c.page);
    await creatorToggleService(c.page, 'agent', S.account ? null : CRED.creator.password);
    const off = await until('E3:勾选取消', async () => (await hostedToggle(c.page, 'agent'))?.checked === false, 8_000, 150);
    await closeDialogs(c.page);
    await until('E3:进行中的对话被停下', () => idleNow(c.page), 30_000, 50);
    const e = await errText(c.page);
    const banner = await until('E3:AI 栏说明已关闭', () => c.page.$eval('[data-pc="cloud-off"]', (el) => el.textContent ?? '').catch(() => null), 10_000, 100);
    await until('E3:云端记下这一轮收尾', () => { const d = S.diskConversation(PID, conv); return d && d.meta.state !== 'running' ? d : null; }, 30_000, 200);
    const landed = okOf(conv, mark);
    const s = await sane(before, landed);
    const rec = recordOf(conv);
    await shot(c.page, 'E3-switched-off');
    await openProjectSettings(c.page);
    await creatorToggleService(c.page, 'agent', S.account ? null : CRED.creator.password);
    await until('E3:勾回来', async () => (await hostedToggle(c.page, 'agent'))?.checked === true, 8_000, 150);
    await closeDialogs(c.page);
    await until('E3:「已关闭」的说明撤掉', async () => !(await c.page.$('[data-pc="cloud-off"]')), 15_000, 100);
    await sendText(c.page, mockSteps([{ say: '开关打开后恢复' }]));
    const again = await until('E3:开关打开后恢复', async () => (lastAssistant(await msgs(c.page))?.text ?? '').includes('开关打开后恢复'), 60_000, 150);
    check('E3 创建者中途关了开关(项目设置里取消勾选「云端 Agent」):进行中的对话被停下,对话记录里写明原因,AI 栏说明已关闭;项目停在完好的版本上;勾回来恢复', !!off && e.outcome === 'error' && /已关闭云端 Agent/.test(e.error ?? '') && /项目创建者已关闭云端 Agent/.test(String(banner ?? ''))
      && rec?.outcome?.reason === 'agent-disabled' && landed >= 1 && landed < 30 && s.ok && !!again, { shown: e, banner, recorded: rec, writesLanded: landed, ...s, afterReenable: !!again });
  }

  /* ---- E4:渲染失败(渲染服务停着) */
  {
    await until('E4:上一轮收尾', () => idleNow(c.page), 30_000, 100);
    await S.stopRender();
    if (!S.account) await S.bootAgent({ PROMPTCUT_AGENT_RENDER_STALL_MS: String(RENDER_STALL_MS) });
    const before = await snap();
    await sleep(1500);
    await c.page.click('[data-pc="cloud-notice"]').catch(() => {});
    let conv = null;
    const mark = seqOf(await conversationOf(c.page));
    // 发不出去就再发一次(旧组合在这里刚重起过 Agent 服务,页面的事件流在重连)
    for (let i = 0; i < 3 && !conv; i++) {
      const usersBefore = ((await msgs(c.page)) ?? []).filter((x) => x.role === 'user').length;
      await sendText(c.page, mockSteps([writeStep(3, `rf${i}`), { sleepMs: 200 }, writeStep(2, `rf${i}`), { say: '改完了,渲染节点不在' }]));
      const started = await c.page.waitForFunction((n) => (window.__pcCloud?.main?.messages() ?? []).filter((x) => x.role === 'user').length > n, { timeout: 15_000 }, usersBefore).then(() => true, () => false);
      if (started) conv = await conversationOf(c.page); else { await c.page.click('[data-pc="cloud-notice"]').catch(() => {}); await sleep(1500); }
    }
    await until('E4:对话照常做完', async () => { const a = lastAssistant(await msgs(c.page)); return a && !a.pending && (a.text ?? '').includes('改完了'); }, 60_000, 150);
    const failed = await until('E4:对话记录里出现「云端渲染失败」', async () => { const a = lastAssistant(await msgs(c.page)); return (a?.statuses ?? []).find((x) => /云端渲染失败/.test(x)) ?? null; }, RENDER_STALL_MS * 3 + 60_000, 500);
    // 气泡末尾常驻的那一行(简洁模式也看得到)
    const note = await until('E4:气泡末尾出现渲染失败的那一行', () => c.page.$eval('[data-pc="cloud-ai-panel"] [data-pc="cloud-render-note"][data-state="failed"]', (el) => el.textContent ?? '').catch(() => null), 10_000, 200);
    const s = await sane(before, 2);
    const e = await errText(c.page);
    check('E4 渲染失败(渲染服务停着):对话照常做完,对话记录里有「云端渲染失败」与原因;项目内容不受影响', !!conv && e.outcome !== 'error' && typeof failed === 'string' && /云端渲染失败:.+/.test(failed) && /云端渲染失败:.+/.test(String(note ?? '')) && okOf(conv, mark) === 2 && s.ok, {
      shown: note, outcome: e.outcome, writesLanded: conv ? okOf(conv, mark) : null, ...s,
      note: `渲染服务被探针停掉;预渲染重试「连续没有进度」的时限在这次演练里缩成 ${RENDER_STALL_MS / 1000} 秒(生产 10 分钟,原因文字是固定的那一句)`,
    });
    await shot(c.page, 'E4-render-failed');
  }
  await closeBrowser(c.browser);

  /* ---- E5:发起成员中途被移出(carol;创建者从另一台设备把她踢出)。
   * 现行语义(product/agent.md「改密退出与被踢的已读消息例外」,2026-10-08 用户定):共有对话里 Agent 已经读到的那条消息触发的这一轮
   * 继续跑完、改动保留;被踢的账号所有设备都进不了项目(看不了对话、发不了消息、发不起下一轮)。原先断言「她的对话被停下」按此改写。 */
  {
    const before = await snap();
    const carol = await onlineUp(CRED.carol);
    await selectCloud(carol.page);
    await sendText(carol.page, writeScript(30, 500, 'rm'));
    await until('E5:这一轮开始并有写入', async () => toolParts(await msgs(carol.page)).filter((t) => t.ok).length >= 1 && (await runningNow(carol.page)), 40_000, 80);
    const conv = await conversationOf(carol.page);
    const landedAtKick = () => okOf(conv);
    const visibility = S.account ? (S.diskConversation(PID, conv)?.row?.visibility ?? null) : null;
    // 账号项目:创建者把她踢出(移出并禁入,成员列表里「踢出」同一个管理操作);旧组合是改名单
    const reply = S.account
      ? await ACTOR.admin({ op: 'kick', accountId: CRED.carol.accountId, requestId: `uxui-kick-${RUN}` }).then((r) => ({ type: r.status === 200 && r.body?.ok ? 'shared.admin.ok' : `http-${r.status}`, body: r.body }))
      : await withCreatorConn((conn) => adminOp(conn, PROJ, 'set-list', { list: [{ username: 'bob', keep: true }] }));
    const atKick = landedAtKick();
    // 她的页面当场被阻断并说明原因
    const blocked = await until('E5:她的页面写明被踢出', () => carol.page.evaluate(() => document.body.innerText.match(/[^\n]*(踢出|移出|不在名单)[^\n]*/)?.[0] ?? null), 20_000, 100);
    const sendBox = await carol.page.$('[data-pc="cloud-ai-panel"] [data-pc="ai-send"]:not([disabled])').catch(() => null);
    await shot(carol.page, 'E5-member-removed');
    // 共有对话里已读的这一轮继续跑完,改动都落地
    const disk = await until('E5:已读的这一轮在云端跑完', () => { const d = S.diskConversation(PID, conv); return d && d.meta.state !== 'running' && d.events.some(isEnd) ? d : null; }, 600_000, 500); // 被踢之后这一轮每一步都要再核一次权限,跑得比平时慢;时限只为防卡死
    const rec = recordOf(conv);
    const landed = okOf(conv);
    const s = await sane(before, landed);
    check('E5 发起成员中途被踢出:她的页面当场被阻断并写明被踢出;她在共有对话里已经被 Agent 读到的那一轮照常跑完、改动保留(现行语义的已读消息例外);项目停在完好的版本上', reply.type === 'shared.admin.ok' && /踢出|移出/.test(String(blocked ?? '')) && (visibility === null || visibility === 'shared') && !!disk && rec?.outcome?.status === 'done' && landed > atKick && s.ok, {
      admin: reply.type, pageSays: blocked, conversationVisibility: visibility, sendStillEnabled: !!sendBox, recorded: rec, writesLanded: { atKick, atEnd: landed }, ...s,
    });
    await closeBrowser(carol.browser);
  }
}

/**
 * 写入之间隔得比预渲染重试的防抖长(见文件头 K1～K3)。创建者的在线页面在这一轮里一直开着(它自己也按每一版发清单计划,与 Agent 服务的
 * 计划同时在队列里);渲完之后另一位成员才上线看。
 */
/* ================================================================== 用户卡:云端 Agent 建卡并判重,发起方退出后,后来的成员在舞台上贴得上它的预渲染结果 */

async function usercardStep() {
  // 账号组合:两个现注册的账号;ula 在在线页面里自己新建一个云端项目(探针让网站后端把它当托管方管理员,它在「生成轨道流」的权限分组里),
  // uma 之后经项目链接加入
  const cu = {
    ula: await S.register(UC_CREATOR, pw()).then((a) => ({ username: a.name, password: a.password })),
    uma: await S.register(`uma${randomBytes(3).toString('hex')}`, pw()).then((a) => ({ username: a.name, password: a.password })),
  };
  const NAME_U = `云端体验用户卡-${RUN}`;
  const cb = await openBrowser();
  const cp = await newPage(cb);
  await accountLogin(cp, S.ORIGIN, cu.ula);
  let UID = null;
  // 项目号取自新建的回包;项目链接的口令(创建者才拿得到)取自账号接口回包里的 linkToken(页面「复制项目链接」拼的就是它)
  let LINK_TOKEN = null;
  cp.on('response', (r) => { try { const p = new URL(r.url()).pathname; if (!p.startsWith('/hosted/shared/account/') || r.status() >= 300) return; void r.json().then((b) => { if (p === '/hosted/shared/account/create' && r.status() === 201) UID = b.projectId; if (typeof b?.linkToken === 'string') LINK_TOKEN = b.linkToken; }).catch(() => {}); } catch { /* 不是这一条 */ } });
  await typeIntoField(cp, '[data-pc="cloud-project-name"]', NAME_U);
  await cp.waitForFunction(() => { const b = document.querySelector('[data-pc="cloud-create"]'); return b && !b.disabled; }, { timeout: 30_000 });
  await cp.click('[data-pc="cloud-create"]');
  await acceptConsentIfAsked(cp, 15_000);
  await cp.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until('用户卡一步:新建的云端项目回了项目号', () => UID, 30_000, 100);
  if (!UID) throw new Error('用户卡一步:新建云端项目没回项目号');
  await gateSettled(cp);
  // 内容:一条空轨道(Agent 把用户卡的片段加在这里)加一张内置图表卡;在 ula 自己的页面里改(经文档服务同步)
  await P(cp, (o) => window.__pcStore.actions.editCardProject((p) => ({
    ...p, width: 1920, height: 1080, fps: 30, duration: 2,
    tracks: [{ id: 'tr-0', name: 'tr-0', hidden: false, clips: [] }, { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-builtin', kind: 'card', cardId: 'rank-bars', start: 0, end: 2, params: { title: o.title, rows: '微信,85|抖音,62', suffix: '%' } }] }],
  })), { title: `用户卡一步 ${SALT}` });
  // 新建项目的「云端 Agent」缺省开;打开「托管方的渲染节点」与「生成轨道流」(用户卡的预渲染也只在这一项开着时由托管方产)
  await openProjectSettings(cp);
  const agentRow = await until('UC0:项目设置里出现「云端 Agent」一行', () => hostedToggle(cp, 'agent'), 15_000, 200);
  let renderRow = await hostedToggle(cp, 'render');
  if (renderRow && !renderRow.checked) {
    await creatorToggleService(cp, 'render');
    renderRow = await until('UC0:「托管方的渲染节点」勾上', async () => { const r = await hostedToggle(cp, 'render'); return r?.checked ? r : null; }, 15_000, 200);
  }
  const streams0 = await until('UC0:渲染节点下面有「生成轨道流」一行', () => hostedOption(cp, 'render', 'streams'), 15_000, 200);
  if (streams0 && !streams0.checked) await creatorToggleOption(cp, 'render', 'streams');
  const streamsRow = await until('UC0:「生成轨道流」勾上', async () => { const r = await hostedOption(cp, 'render', 'streams'); return r?.checked ? r : null; }, 15_000, 200);
  const renderSees = await until('UC0:渲染服务看到这个项目「生成轨道流」开着', async () => ((await S.renderStatus()).projects ?? []).find((p) => p.projectId === UID)?.streams === true, 30_000, 300);
  check('UC0 第二个创建者(现注册的账号)在在线页面里新建云端项目:「云端 Agent」缺省勾上;打开「托管方的渲染节点」与「生成轨道流」后渲染服务看到开着', !!agentRow?.checked && !!renderRow?.checked && !!streamsRow && !!renderSees, {
    agent: agentRow, render: renderRow, streams: streamsRow, renderSees: !!renderSees, projectId: UID ? 'sp_…' : null, linkToken: !!LINK_TOKEN,
  });
  await closeDialogs(cp);
  // 夹具:只留一个记号、什么都不探的那张用户卡(判重的写法),由云端 Agent 用 create_card 建出来
  const CARD_ID = 'overreach-marker-jia';
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'probes', 'fixtures', 'render-isolation', 'overreach-marker-jia.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const filesBefore = S.assetFiles();
  const t0 = Date.now();

  /* ---- UC1:创建者在在线浏览器里发起,建卡成功后真实结束他的浏览器 */
  const c = { browser: cb, page: cp };
  await selectCloud(c.page);
  // 建卡要「高」创造力:在 AI 栏的运行选项里给这个对话调(下拉在弹层里,不必弹出来也能选)
  await c.page.select('[data-pc="cloud-ai-panel"] [data-pc="ai-creativity"]', 'high');
  const level = await P(c.page, () => document.querySelector('[data-pc="cloud-ai-panel"] [data-pc="ai-creativity"]')?.value ?? null);
  const sent = await sendAndAccepted(c.page, mockSteps([
    { tool: 'create_card', input: { id: CARD_ID, source } },
    { sleepMs: 6000 },
    { tool: 'add_clip', input: { cardId: CARD_ID, start: 0, duration: 2, trackId: 'tr-0' } },
    { say: '建了一张卡并放上了时间轴' },
  ]), 1);
  const conv = sent.conversationId;
  await shot(c.page, 'UC1-usercard-accepted');
  const k = await killBrowser(c.browser);
  browsers.delete(c.browser);
  const disk = () => S.diskConversation(UID, conv);
  const ended = await until('UC1:建卡的对话在云端跑到结束', () => { const d = disk(); return d && d.meta.state !== 'running' && d.events.some(isEnd) ? d : null; }, 120_000, 300);
  const renderEvents = () => (disk()?.events ?? []).filter((e) => e.type === 'render');
  await until('UC1:含用户卡的预渲染重试有结局', () => (['done', 'failed', 'unavailable'].includes(renderEvents().at(-1)?.state) ? true : null), 420_000, 500);
  timings.usercardRenderedMs = Date.now() - t0;
  const results = (disk()?.events ?? []).filter((e) => e.type === 'tool_result').map((e) => `${e.name}:${e.ok ? 'ok' : `error ${String(e.summary ?? '').slice(0, 120)}`}`);
  // 工作进程每秒向管理进程交一次诊断:渲完的那一刻读到的可能还是上一拍的计数,等两拍再读
  await sleep(2500);
  const st = await S.renderStatus();
  const resident = (st.queue?.nodes ?? []).find((n) => n.projectId === UID) ?? null;
  const iso = (st.isolation?.queue?.nodes ?? []).find((n) => n.projectId === UID) ?? null;
  const states = renderEvents().map((e) => e.state);
  check('UC1 云端 Agent 建一张用户卡(判重)并用它加片段,发起方的浏览器被结束:对话照样做完,预渲染重试由隔离工作进程渲完(对话记录里有「渲染完成」)', level === 'high' && sent.accepted && k.gone && ended?.meta?.state === 'idle'
    && results.join() === 'create_card:ok,add_clip:ok' && states.at(-1) === 'done' && !states.includes('failed')
    && /^hosted-render-iso:/.test(String(iso?.nodeId ?? '')) && (iso?.claimed ?? 0) > 0 && (iso?.failed ?? 0) === 0 && (resident?.claimed ?? 0) === 0 && S.assetFiles() > filesBefore, {
    creativity: level, accepted: sent.accepted, initiatorGone: k.gone, end: ended?.meta?.state ?? null, toolResults: results, renderStates: states.join(','), renderedMs: timings.usercardRenderedMs,
    isolatedWorker: iso ? { nodeId: String(iso.nodeId).slice(0, 34), claimed: iso.claimed, completed: iso.completed, dedup: iso.dedup ?? null, failed: iso.failed } : null,
    residentWorker: resident ? { claimed: resident.claimed } : null, assetFiles: [filesBefore, S.assetFiles()],
    ...(states.at(-1) === 'done' ? {} : { isolationStatus: st.isolation ?? null, renderReasons: renderEvents().filter((e) => e.reason).map((e) => String(e.reason).slice(0, 120)) }),
  });

  /* ---- UC2:之后才上线的成员(另一个浏览器进程):舞台上贴得上这张用户卡的预渲染结果 */
  // uma 经项目链接加入(之后才上线的成员:新的浏览器进程)
  const ub = await openBrowser();
  const up = await newPage(ub);
  await accountLogin(up, S.ORIGIN, cu.uma);
  await typeIntoField(up, '[data-pc="cloud-project-link"]', `${S.ORIGIN}/editor?project=${encodeURIComponent(UID)}${LINK_TOKEN ? `&token=${encodeURIComponent(LINK_TOKEN)}` : ''}`);
  await up.waitForFunction(() => { const b = document.querySelector('[data-pc="cloud-join"]'); return b && !b.disabled; }, { timeout: 30_000 });
  await up.click('[data-pc="cloud-join"]');
  await acceptConsentIfAsked(up, 8000);
  await up.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await gateSettled(up);
  const uma = { browser: ub, page: up };
  const clip = await until('UC2:uma 的页面读到带用户卡的片段', () => P(uma.page, (cardId) => { const x = window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((y) => y.cardId === cardId); return x ? { id: x.id, cardId: x.cardId, start: x.start, end: x.end } : null; }, CARD_ID), 30_000, 200);
  const ids = clip ? [clip.id] : [];
  const play = clip ? await playbackSnapshots(uma.page, 'UC2-uma-stage-usercard', 90_000, ids) : { hit: null, seen: [], shot: null, stats: null };
  const marks = clip ? await localPcMarks(uma.page, ids) : { badge: -1, icons: -1 };
  const layers = await onlineLayers(uma.page);
  const mine = (layers?.layers ?? []).filter((l) => l.clipId === clip?.id);
  check('UC2 之后才上线的成员(真实浏览器):项目里有这张用户卡的片段,舞台上贴的是它的预渲染结果(轨道流画出了帧、没有占位),层表里有这一层,没有「需要本地 PC 渲染辅助」', !!clip && !!play.hit && prerendered(play.hit[clip.id]) && play.hit[clip.id]?.placeholder === false
    && mine.some((l) => l.ready > 0) && !(layers?.stale ?? []).includes(clip.id) && marks.icons === 0 && !!play.stats && play.stats.colors >= 2, {
    clip, stage: clip && play.hit ? { stream: play.hit[clip.id].stream, snapshot: play.hit[clip.id].snapshot, snapNodes: play.hit[clip.id].snapNodes ?? null, placeholder: play.hit[clip.id].placeholder } : null, statesSeenWhilePlaying: play.seen,
    layers: mine, staleLayers: layers?.stale ?? null, localPcIcons: marks.icons, customCardBadges: marks.badge, pixels: play.stats, shot: play.shot,
  });
  const errors = [...(uma.page.pageErrors ?? [])];
  check('UC 这一步的页面没有页面错误', errors.length === 0, { sample: errors.slice(0, 3) });
  await closeBrowser(uma.browser);
}

async function spacedStep() {
  const c = await onlineUp(CRED.creator, { asCreator: true });
  await selectCloud(c.page);
  const salt = `${SALT}-k`;
  const nodeBefore = await renderNode();
  const logsBefore = S.render?.logs.length ?? 0;
  await sendText(c.page, mockSteps([...Array.from({ length: N }, (_, k) => [{ sleepMs: SPACED_GAP_MS }, writeStep(k + 1, salt, true)]).flat(), { say: '隔着写完了' }]));
  await until('K1:这一轮开始', async () => (await view(c.page))?.streaming, 15_000, 50);
  const conv = await conversationOf(c.page);
  const fin = await cloudFinishes(conv, { runMs: 240_000, renderMs: 400_000 });
  // 一轮结束时补发的那一个计划渲完才算数:等「最后一条预渲染重试事件是结局、并且它之后 8 秒没有新的预渲染重试事件」
  const renderEvents = () => (S.diskConversation(PID, conv)?.events ?? []).filter((e) => e.type === 'render');
  let quietSince = Date.now();
  let lastCount = -1;
  await until('K1:预渲染重试收尾(最后一条是结局,之后 8 秒没有新的预渲染重试事件)', () => {
    const ev = renderEvents();
    if (ev.length !== lastCount) { lastCount = ev.length; quietSince = Date.now(); }
    return ['done', 'failed', 'unavailable'].includes(ev.at(-1)?.state) && Date.now() - quietSince >= 8000 ? true : null;
  }, 400_000, 500);
  const states = renderEvents().map((e) => ({ state: e.state, ...(e.reason ? { reason: String(e.reason).slice(0, 80) } : {}) }));
  const node = await renderNode();
  const delta = (k) => (node?.[k] ?? 0) - (nodeBefore?.[k] ?? 0);
  // 渲染节点逐任务的收尾行:失败与作废各是什么原因(作废 = 这份内容已被新版本取代,不计入失败)
  const reasons = {};
  let completedInLog = 0;
  for (const l of (S.render?.logs ?? []).slice(logsBefore)) {
    const m = l?.event === 'worker.line' ? /node\.task-(failed|superseded|completed) (\{.*\})/.exec(String(l.line ?? '')) : null;
    if (!m) continue;
    // 渲染节点为这个项目做完的任务数:数工作进程逐任务的收尾行(它的诊断计数在工作进程重起后从零开始,前后相减会是负的)
    if (m[1] === 'completed') { try { if (JSON.parse(m[2]).projectId === PID) completedInLog += 1; } catch { /* 这一行被截断了 */ } continue; }
    try { const j = JSON.parse(m[2]); const k = `${m[1]}|${String(j.id).split(':')[0]}|${String(j.error ?? j.why ?? '').replace(/[0-9a-f]{8,}|sp_[A-Za-z0-9_-]+|clip-[a-z]+|@\d+/g, '~').slice(0, 60)}`; reasons[k] = (reasons[k] ?? 0) + 1; } catch { /* 这一行被截断了 */ }
  }
  check(`K1 写入之间隔 ${SPACED_GAP_MS / 1000} 秒(大于预渲染重试的防抖 3 秒)、连写 ${N} 次:中途就按当时的版本发计划(不等一轮结束),预渲染重试的结局是「渲染完成」,对话记录里没有渲染失败`, fin.toolOk === N && states.filter((x) => x.state === 'published').length >= 3 && states.at(-1)?.state === 'done' && !states.some((x) => x.state === 'failed' || x.state === 'unavailable'), {
    writesLanded: fin.toolOk, published: states.filter((x) => x.state === 'published').length, last: states.at(-1) ?? null, failed: states.filter((x) => x.state === 'failed'), states: states.map((x) => x.state).join(','),
  });
  check('K2 渲染节点这一轮没有一个任务以失败收场;被新版本取代的旧任务记成作废(不计入失败)', completedInLog + Math.max(0, delta('dedup')) > 0 && !Object.keys(reasons).some((k) => k.startsWith('failed|')), {
    completedInLog, renderNode: { failed: delta('failed'), superseded: delta('superseded'), completed: delta('completed'), dedup: delta('dedup'), lost: delta('lost'), discarded: delta('discarded') }, reasons,
  });
  await shot(c.page, 'K1-spaced-writes');
  await closeBrowser(c.browser);

  /* ---- K3:渲完之后才上线的成员 */
  const bob = await onlineUp(CRED.bob);
  const want = { title: `${salt} 第 10 次:改文案`, rows: rowsOf(salt, 12), statefulEnd: 2.5, canvasEnd: 2 };
  const got = await until('K3:bob 的页面读到最后一版项目', async () => { const p = await pageProject(bob.page); return p && p.rows === want.rows ? p : null; }, 30_000, 200);
  const play = await playbackSnapshots(bob.page, 'K3-bob-stage-prerendered');
  const marks = await localPcMarks(bob.page);
  const layers = await onlineLayers(bob.page);
  const heavyLayers = (layers?.layers ?? []).filter((l) => HEAVY.includes(l.clipId));
  check('K3 之后才上线的成员:项目是最后一版,舞台上两张重卡贴的是最后一版的预渲染结果(层表里这几层没有一层是旧输入的),没有占位、没有「需要本地 PC 渲染辅助」', !!got && got.title === want.title && got.statefulEnd === want.statefulEnd && got.canvasEnd === want.canvasEnd
    && !!play.hit && marks.badge === 0 && marks.icons === 0 && HEAVY.every((id) => heavyLayers.some((l) => l.clipId === id && l.ready > 0)) && !(layers?.stale ?? []).some((id) => HEAVY.includes(id))
    && !!play.stats && play.stats.colors >= 3, {
    project: got, stage: stageOf(play.hit), statesSeenWhilePlaying: play.seen,
    // 这几层是谁渲的不限:创建者的页面那一轮开着,它自己也是纯浏览器节点,先认领的得卡(渲染服务的指纹见 renderServiceFingerprint)
    renderServiceFingerprint: S.renderFingerprint ?? null, layers: heavyLayers, staleLayers: layers?.stale ?? null, localPcBadges: marks.badge, localPcIcons: marks.icons, pixels: play.stats, shot: play.shot,
  });
  const errors = [...(bob.page.pageErrors ?? [])];
  check('K 这一步的页面没有页面错误', errors.length === 0, { sample: errors.slice(0, 3) });
  await closeBrowser(bob.browser);
}

let code = 0;
try {
  for (const s of STEPS) if (!ALL_STEPS.includes(s)) throw new Error(`不认识的步骤 ${s}`);
  if (NEED_OLD) await setupOld();
  if (REAL) {
    if (NEED_ACCOUNT) await setupAccount();
    await realPass(arg('--real-how', 'online'), 'R');
  } else {
    if (STEPS.includes('desktop')) await leavePass('desktop', 'D', `${SALT}-d`);
    // 桌面版那一遍之后换到账号组合(云端项目一律走网站账号;在线构建只认账号项目)
    if (NEED_ACCOUNT) await setupAccount();
    if (STEPS.includes('online')) await leavePass('online', 'O', `${SALT}-o`);
    if (STEPS.includes('stop')) await stopStep();
    if (STEPS.includes('spaced')) await spacedStep();
    if (STEPS.includes('usercard')) await usercardStep();
    if (STEPS.includes('errors')) await errorsStep();
  }
} catch (err) {
  code = 2;
  check('探针自己没出错', false, { error: String(err?.stack ?? err).slice(0, 1200), agentLogTail: S?.agent ? S.agent.text().slice(-600) : null });
} finally {
  for (const b of [...browsers]) await closeBrowser(b).catch(() => {});
  for (const d of [...desktops]) await killDesktop(d).catch(() => {});
  for (const c of [...nodeConns]) { try { c.close(); } catch { /* 已关 */ } }
  await ACTOR?.close().catch(() => {});
  // `--keep`:几个服务自己的日志一并留在临时目录里(排查用;日志里没有口令与票据原文)
  if (KEEP && S) {
    if (S.account) { try { fs.writeFileSync(path.join(TMP, 'account-fixture.log'), S.fixture.log.map((x) => JSON.stringify(x)).join(String.fromCharCode(10))); fs.writeFileSync(path.join(TMP, 'publisher.log'), S.publisherLogs.map((x) => JSON.stringify(x)).join(String.fromCharCode(10))); } catch { /* 留不下就算了 */ } }
    for (const [name, proc] of [['render', S.render], ['agent', S.agent], ['hosted', S.hosted]]) {
      try { if (proc?.text) fs.writeFileSync(path.join(TMP, `${name}.log`), proc.text()); } catch { /* 留不下就算了 */ }
    }
  }
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
for (const [k, v] of Object.entries(timings)) if (typeof v === 'number') timingLog.record(k, v);
timingLog.print();
console.log(JSON.stringify({ summary: { ok: code === 0, total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check), timings, shots, ...(KEEP ? { tmp: TMP } : {}) } }));
process.exit(code);
