/**
 * C10 本机真浏览器验收(`docs/plan/c10-contract.md` 第 20 节 C10-A1～A5、A10):在线浏览器模式普通档。
 *
 *   node scripts/probes/c10-browser-probe.mjs [--out <目录>] [--dist <在线构建目录>] [--keep-temp]
 *        [--a10]                 只验 A10(逐帧导出跨过票据时限):托管端的素材票据时限缩短到 --ticket-ttl-ms
 *        [--ticket-ttl-ms 20000]
 *        [--no-video]            不导入视频(只验卡片)
 *        [--only-a4]             只跑到 A4(播放、暂停追活渲)为止,跳过 A2 的重开与 A5(排障用)
 *        [--user-card]           另放一张仓库用户卡(`mu-animated-shiny-text`)。2026-10-06 起的新语义(`online-card-exec-contract.md` 第 11.3 节):它是在线包里构建时
 *                                就有的卡,本页能运行,与内置卡一样按轻重区分。成员页进来时在加载遮罩下把它测完、判轻,于是在可见舞台里直接活渲(没有快照、没有
 *                                「需要本地 PC 渲染辅助」的图标与徽标)、不在页面发布的清单计划里。旧语义(清单计划含它、桌面渲染节点渲出来写进层表、成员页贴快照)
 *                                描述的是判重的那条路,这条路对判重的内置卡在 A1~A4 里验,对判重的同步用户卡在 `online-card-exec-probe.mjs` E6 里验。
 *                                清单计划里含它的那一路(测量完成前它按重、计划先发出去)现在也可能由成员页自己的浏览器节点渲出(本页能运行的用户卡任务它认领),层的环境指纹是 cardEnvFingerprint
 *        [--base-port 5780]      端口段:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 创建者编辑器与舞台端口
 *                                (A5 里创建者关掉之后,独立渲染主机用同一段)
 *
 * 本机替身(与阿里云同形):
 *   - 托管组合(文档服务 + 素材服务,只绑 127.0.0.1);
 *   - 共用的本机托管代理 `lib/hosted-proxy.mjs`(2026-10-06 起,取代各探针自带的仿 nginx 代理),开三个同站跨源的源 pc.localhost(+0)、s1.pc.localhost(+1)、s2.pc.localhost(+2),
 *     带全套策略头(内容安全策略、OAC)、`/media-s/` 与舞台入口 `/editor/stage.html`;`/editor/runtime-config.json` 给两个舞台源(同 `deploy-hosted --stage-origins` 写的);
 *     Node 这边(探针与它起的桌面 dev server、渲染主机)靠 `lib/localhost-dns.cjs` 认得 `*.localhost`;
 *   - 创建者 = 桌面版 dev server + 它的预渲染进程(队列节点,pc),建项目、放卡、勾「多用户协作」放云端、取邀请链接、预渲染;
 *   - 成员 = 电脑浏览器(普通档)打开邀请链接进入。
 *
 * 验收:
 *   A1 两个舞台同站跨源、带 OAC(舞台成了独立的 iframe 目标);播放含重卡的 10 秒时间轴,主文档长任务 0,重层按拍换快照
 *   A2 首次打开在加载遮罩下测完,L2 有 costs;关掉再开不重测,已在 L2 的块不再请求
 *   A3 普通档取原尺寸(snap/),预渲染小尺寸请求 0;一层只出自一种环境
 *   A4 换帧预算装不下的层显示占位;暂停后追到精确活渲;占位撤下后不再盖回
 *   A5 关掉创建者(没有节点在线)时纯在线改一处:页面发布清单计划、不报错;起独立渲染主机(host 档、指纹与页面不同)→ 认领、切分、完成 → 页面取到新快照
 *   A10(--a10)逐帧导出跨过票据时限照常完成
 *
 * 不打印令牌、口令、邀请码原文。输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, … }`。
 *
 * ## 对远端跑(外网模式):--site <源>
 *
 *   node scripts/probes/c10-browser-probe.mjs --site https://8-219-80-16.sslip.io [--run <本轮 id>] [--stage-origins <源1>,<源2>]
 *        [--no-host] [--host-wait-min 15] [--timeout-min 120] [--coord <协调口基址>] [--out <目录>] [--base-port 5780]
 *
 *   - 不起本机托管组合与代理:页面取 `<源>/editor`,文档服务 `<源>/hosted/`,素材服务 `<源>/media/api/asset`;
 *     两个舞台源缺省读 `<源>/editor/runtime-config.json` 的 `stageOrigins`(`deploy-hosted --stage-origins` 写的),读不到记一条失败、
 *     退回按 `s1.<主机>`、`s2.<主机>` 核;`--stage-origins` 给了就以它为准(仍核 runtime-config 与它一致)。
 *   - 创建者 = 本机桌面版 dev server(端口 +5～+7)连远端(同 c10a-demo-probe 的创建者);成员 = 本机无头 Chrome 普通档(桌面视口)。
 *   - 判据与本机替身相同:A1 的「播放 10 秒主文档长任务 0」在外网模式同样按过 / 不过判(长任务数是不看时间的断言,
 *     `docs/semantics/guide_files/verification.md`「耗时只记录,不当闸门」;原来在外网模式只报数、标「待笔记本复核」,已去掉)。
 *   - A5 的独立渲染主机来自外部(下一节):没有节点在线时改一处、页面发布清单计划、不报错照常核;之后把本轮的项目与凭证写进协调口 KV,
 *     等外部主机报到(`--host-wait-min`,缺省 15 分钟),再等它认领并完成(至多 15 分钟)、页面取到它产的新快照(至多 10 分钟)。
 *     时限内没有主机报到:A5 的后半记「待外部主机」(`steps.a5.pendingHost`),不算失败。`--no-host` 不写 KV、不等,直接记「待外部主机」。
 *   - `--a10` 只对本机替身(要缩短托管端的票据时限)。
 *
 * ## 独立主机角色:--role host --run <id>(HT9 的跨机做法:在线页面发布带片段清单的 plan,独立渲染主机认领并完成)
 *
 *   node scripts/probes/c10-browser-probe.mjs --role host --run <id> [--coord <协调口基址>] [--port 5425] [--out <目录>]
 *        [--timeout-min 120] [--test-fingerprint <16 位十六进制>] [--keep-temp]
 *
 *   - 从协调口 KV 读本轮的配置(`c10b.<run>.config`:文档服务地址、项目 id、成员口令),起 `scripts/render-host.mjs --config … --port …`
 *     (IPC;编辑器另占 +1、+2),用成员身份、`role: 'render'` 连远端认领。起来后写 `host.ready`(nodeId、profile、环境指纹、代码版本、传输),
 *     之后每 2 秒看一次自己的 `GET /api/frames/queue`,认领 / 完成数变了就写 `host.progress`;等到 `finish`(或 `abort`、超时)经 IPC 正常退出,
 *     结果写 `host`。`--run latest`:取 `c10b.latest` 里本角色起来前 10 分钟之后写的那一轮。
 *   - `--test-fingerprint`:给主机设 `PROMPTCUT_TEST_ENV_FINGERPRINT`(本机自测时让主机与页面的环境不同;跨机不用)。
 *   - 环境变量 `PROBE_MAIL_TOKEN`:协调口开了信箱时 KV 要它(`coordClient` 自动带,不打印)。
 *
 *   - `PC_CHROME_ARGS` 只把参数原样透传给探针起的 Chrome(典型用途:云端 Linux 以 root 运行要 `--no-sandbox`);不要用它关 TLS 校验(如 `--ignore-certificate-errors`),否则对远端站点的探针在证书有问题时照样通过,掩盖真问题。
 *   - 云端 Linux 另要 `NODE_USE_ENV_PROXY=1`、`PC_CHROME_ARGS=--no-sandbox`(原样传给子进程)。主机环境里没有 ffmpeg 照常起:
 *     在线页面计划切出的是卡片快照任务(HTML 快照与 PNG 小尺寸,用 Chrome),不用 ffmpeg;轨道流(要 H.264 编码器)在
 *     render-host 缺省关着(`PROMPTCUT_STREAMS=0`),开了也会按「探不到编码器」报 `streams: false`。结果行记 `ffmpeg`(找没找到)、
 *     `capabilities`(节点报给队列的能力)、`ffmpegMentions`(主机日志里提到 ffmpeg / ENOENT 的行)。
 *   - `--host-no-ffmpeg`(本机模拟云端):主机子进程的 PATH 去掉含 ffmpeg 的目录,Windows 上 `LOCALAPPDATA` 指到空目录。
 *     `--role all` 与 `--role host` 都认。
 *
 * ## 持有任务时断一次传输:--cut proxy | external(照 ht-w-probe 的外部切断协议)
 *
 *   `--role host --cut external [--cut-wait-min 10] [--resume-timeout-s 90]`:主机手里有任务时写 KV `host.holding`
 *   (持有的任务 id、opens、resumes、传输),等 KV `cut.done`(外部在服务器上掐掉这台主机到 443 的连接后写,任意 JSON),
 *   之后判:`resumes` 恰好 +1(0 → 1)、`opens` 不变(接续不是重开)、托管端 `/healthz` 的 `sessions.resumed` 增加;
 *   到最后 `opens` 仍不变、`released` 为 0。结果写 KV `host.cut`(creator 等它,之后才写 `finish`)。
 *   `--cut proxy`:主机经本机 `render-queue-proxy.mjs --cut-once --stdin-control` 连文档服务,持有时往代理写 `cut`
 *   (本机替身 `--role all --cut proxy` 用端口 +8;`--role host --cut proxy` 用 `--proxy-port`,缺省主机端口 +3,
 *   https 的托管端要给 `--proxy-target <明文文档服务 host:port>`)。
 *   creator 一侧(`--role all --cut proxy`,或主机的 host.ready 带着 cut):起旁观节点(成员、`role: 'render'`、`node.hello`
 *   不带指纹、`queue.watch` 本项目,只收不认领)与成员页 WebSocket 入站帧的 task.done 计数(CDP;按 seq 去重),
 *   判持有的任务 taken 1 / reopened 0 / done 1、页面恰好一次 task.done、页面收到的 task.done 没有重复;A5 照旧判。
 *
 *   PC 这边的 `--role creator`(外网模式的缺省;本机替身里给它表示 A5 也等外部主机,本机自测跨机协议用)在 A5 处按上一节等外部主机。
 *   本机替身不给 --role(缺省 all):A5 照旧由探针自己起本机的独立渲染主机。
 *
 * ## E6「两种指纹」的反方向:--e6-reverse(`docs/plan/m8-plan.md` 第 2.1 节 E6 判据末句;C10 契约第 18 节第 9 条)
 *
 *   在线页面(发布方)发布带片段清单的 plan → 指纹 Y 的独立渲染主机先认领 plan、按自己的指纹切分 → 指纹 X 的节点在 Y 认领 plan
 *   之后才上线(免得它抢到 plan)→ 判:
 *     e6r:Y-claimed-plan         Y 认领了页面这一版的 plan(旁观节点见到 task.taken;Y 的持有记录里有这个 id,
 *                                或者推断:认领发生在 X 上线前、此刻能认领 plan 的只有 Y、Y 的认领计数 ≥ 1、切分方自己那份要求 Y 的指纹)
 *     e6r:derived-fingerprints   切分方自己那份细任务要求 Y 的指纹;其余只许是 M7 D1 给页面出的浏览器那份(`input.dual`、要求页面指纹)
 *     e6r:X-online-while-work    X 上线之后这一版还有细任务完成(X 确实和这一版同时在线,认领 0 才有意义)
 *     e6r:X-claimed-0            要求别的指纹(Y)的细任务 X 认领 0;要求 X 自己指纹的(同一台机器上页面的浏览器那份)X 本来就能认领,只计数
 *     e6r:J-all-done             J-全完:没被作废的细任务全部 done;作废(`superseded`,M7 D1 双份里输了的那份)的只许是 dual 的
 *     e6r:J-exactly-once         J-恰一:发布方(成员页)对 plan 与每个没被作废的细任务恰好收到一次 task.done
 *                                (CDP 读页面 WebSocket 入站帧,按 seq 去重、按 epoch 数)
 *     e6r:J-pure-layers          J-纯层:按卡(层表的内容键)汇总细任务要求的指纹与完成它的节点的指纹,没有一张卡混两种
 *     e6r:layer-map-covers-done  层表(`layers:<项目文档 id>`,v 3)每张卡的候选里含完成那一份的指纹;另记「主指纹全是 Y」(primaryAllY)
 *     e6r:X-differs-from-Y       X 与 Y 的指纹不同
 *   另记 L18(不判):桌面发布的 plan(创建者在第 0 步发布的)对 host 档认领回什么(X 节点拿 host 身份试认领一次,期望 `plan-profile`)。
 *   这一向把第 5 步(A5)的改动扩到主重卡与全部额外重卡(文字 + burnMs,`--e6-burn-ms`,缺省本机替身 120、外网 250:
 *   外网的 X 主机起来要半分钟以上),Y 的并发压到 1,好让 X 上线时这一版还没做完。
 *
 *   X 的两种(`--x-nodes`,逗号分隔):
 *     claimer  协议层节点:成员身份、`role: 'render'`、`node.hello` 报 profile host 与本机的真实指纹(= 创建者桌面节点报的那个),
 *              `queue.watch` 本项目;对旁观节点看到的每个还 open、要求别的指纹的细任务主动 `task.claim` 一次(认领成了就当场
 *              `task.release`,记为失败),记各拒绝原因;要求它自己指纹的(页面的浏览器那份)不碰 —— 认领再放回会把卡锁到
 *              X 的指纹上、把切分方那份作废,扰乱这一版(第一次本机替身就是这样)。不起进程、不占端口,Y 认领 plan 后几乎立刻在线。
 *     host     真的独立渲染主机(`scripts/render-host.mjs`,真实指纹),端口「基址 +0、+1、+2」。只在外网模式(`--site`)可用:
 *              本机替身的 10 个端口(托管组合 + 三个源占 5 个,创建者 / Y 占 3 个)放不下第二台主机。
 *   缺省:外网模式 `claimer,host`,本机替身 `claimer`。
 *
 *   命令:
 *     本机替身(一台机器跑完全部角色):
 *       node scripts/probes/c10-browser-probe.mjs --e6-reverse --base-port 5740 [--out <目录>]
 *     本机自测跨机协议(Y 经协调口 KV 报到,同一台机器):先起协调口,再起 creator 与 host 两个进程
 *       node scripts/probes/probe-coord.mjs serve --port 5748
 *       node scripts/probes/c10-browser-probe.mjs --role creator --e6-reverse --base-port 5740 --coord http://127.0.0.1:5748 --run <id>
 *       node scripts/probes/c10-browser-probe.mjs --role host --run <id> --coord http://127.0.0.1:5748 --port 5745 --test-fingerprint <Y>
 *       (Y 的端口段就是创建者编辑器的 +5～+7:config 在创建者关掉之后才写,主机拿到 config 才占端口)
 *     跨机(一台起 creator 与 X,另一台起 Y;令牌只从环境变量 PROBE_MAIL_TOKEN 取):
 *       PC:    node scripts/probes/c10-browser-probe.mjs --site https://8-219-80-16.sslip.io --e6-reverse --run <id> --base-port <PC 段起点> [--coord <协调口>]
 *       另一台:node scripts/probes/c10-browser-probe.mjs --role host --run <id> --test-fingerprint <Y> --port <那台的端口> [--coord <协调口>]
 *   结果写 `steps.e6r`:checks(每条 { name, ok, detail })、plan、细任务数、X 与 Y 的认领 / 完成、层表逐层指纹、l18。
 *   KV:不加新键;config 多一个字段 `e6Reverse`,host.progress 与 host 多一个字段 `ids`(见下一节)。
 *
 * ## KV 键(`c10b.<run>.<名>`)
 *   config         creator → host:文档服务的 ws 地址、项目 id、成员口令、项目文档 id、主重卡片段 id、页面发布的计划 id(口令只进 KV 与主机临时目录里的配置文件);
 *                  `--e6-reverse` 时另带 `e6Reverse: true`(主机并发压到 1、记认领 / 完成的任务 id)
 *   host.ready     host → creator:起来了(nodeId、profile、envFingerprint、codeVersion、transport、机器平台)
 *   host.progress  host → creator:认领、完成、失败数与传输(变了才写);`e6Reverse` 时另带 `ids`(claimed / completed / dedup / lost / failed 的任务 id)
 *   host.holding   host → 外部与 creator:--cut 时主机此刻持有的任务(可以掐了)
 *   cut.done       外部 → host:--cut external 时掐完线写
 *   host.cut       host → creator:--cut 的结果(持有的任务、前后的 opens / resumes / sessions.resumed、判据)
 *   finish         creator → host:可以退出了(页面已取到新快照,或 creator 不等了)
 *   abort          creator 出错收尾时写;host 看到就退出
 *   host           host 的结果行(`e6Reverse` 时带 `ids`,同 host.progress)
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { fork, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import dnsShim from './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { judgeAllDone, judgeExactlyOnce, judgePureLayers, layerObservations, parseTaskId } from './m8/lib.mjs';
import { clipWeight } from '../../src/render/pipelinePlan.mjs';
import { createTimings } from './probe-timings.mjs';
import { hostClaimStatusOf } from '../render-host.mjs';
import { createC10Trace, hostDidWork } from './c10-judge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const A10 = argv.includes('--a10');
const ONLY_A4 = argv.includes('--only-a4');
const USER_CARD = argv.includes('--user-card');
const KEEP = argv.includes('--keep-temp');
const VIDEO = !argv.includes('--no-video');
const BASE = Number(arg('--base-port', 5780));
// 探针起的 Node 子进程(桌面版 dev server、渲染主机、旁路代理)继承它,也能解析 pc.localhost
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);
const TTL_MS = Number(arg('--ticket-ttl-ms', 20_000));
/** 外网模式:给了 --site 就对远端跑,不起本机托管组合与代理 */
const SITE_ARG = arg('--site', null);
const REMOTE = !!SITE_ARG;
const ROLE = arg('--role', REMOTE ? 'creator' : 'all');
if (!['all', 'creator', 'host'].includes(ROLE)) { process.stderr.write('--role 只认 all | creator | host\n'); process.exit(2); }
if (REMOTE && ROLE === 'all') { process.stderr.write('外网模式没有 --role all:本机这边用 creator(缺省),独立主机在另一台机器上跑 --role host\n'); process.exit(2); }
if (REMOTE && A10) { process.stderr.write('--a10 只对本机替身(要缩短托管端的票据时限)\n'); process.exit(2); }
/** A5 的独立渲染主机来自外部(经协调口 KV):外网模式、或本机替身里给了 --role creator */
const EXTERNAL_HOST = ROLE === 'creator';
const NO_HOST = argv.includes('--no-host');
const HOST_WAIT_MS = Number(arg('--host-wait-min', 15)) * 60_000;
/** 主机持有任务时断一次传输:proxy(本机代理切,本机替身自测)| external(外部掐线,等 KV cut.done);不给就不断 */
const CUT = arg('--cut', null);
if (CUT !== null && !['proxy', 'external'].includes(CUT)) { process.stderr.write('--cut 取 proxy 或 external\n'); process.exit(2); }
if (CUT === 'external' && ROLE !== 'host') { process.stderr.write('--cut external 只对 --role host(外部掐线由主会话在服务器上做)\n'); process.exit(2); }
if (CUT !== null && ROLE === 'creator') { process.stderr.write('--role creator 不收 --cut:断不断由主机那边定(host.ready 里带着)\n'); process.exit(2); }
const CUT_WAIT_MS = Number(arg('--cut-wait-min', 10)) * 60_000;
const RESUME_TIMEOUT_MS = Number(arg('--resume-timeout-s', 90)) * 1000;
/** 主机子进程里去掉 ffmpeg(本机模拟云端没有 ffmpeg) */
const HOST_NO_FFMPEG = argv.includes('--host-no-ffmpeg');
/** E6 反方向(见文件头「E6『两种指纹』的反方向」) */
const E6R = argv.includes('--e6-reverse');
const X_NODES = String(arg('--x-nodes', REMOTE ? 'claimer,host' : 'claimer')).split(',').map((s) => s.trim()).filter(Boolean);
if (E6R) {
  const bad = (m) => { process.stderr.write(`${m}\n`); process.exit(2); };
  if (ROLE === 'host') bad('--e6-reverse 给 creator 一侧(--role all | creator);主机那边照常 --role host,由 config 里的 e6Reverse 知道');
  if (A10 || ONLY_A4) bad('--e6-reverse 不与 --a10、--only-a4 同用(反方向在第 5 步做)');
  if (CUT !== null || argv.includes('--no-host')) bad('--e6-reverse 不与 --cut、--no-host 同用');
  if (!X_NODES.length || X_NODES.some((x) => !['claimer', 'host'].includes(x))) bad('--x-nodes 取 claimer、host(逗号分隔)');
  if (!REMOTE && X_NODES.includes('host')) bad('本机替身的 X 只能是 claimer:端口段 10 个放不下第二台独立渲染主机(托管组合与三个源占 +0～+4,Y 占 +5～+7)');
}
/** E6 反方向:本轮 A5 改动的 burnMs(拉长这一版,好让 X 上线时还有细任务没做) */
const E6R_BURN_MS = Number(arg('--e6-burn-ms', REMOTE ? 250 : 120));
const COORD = String(arg('--coord', 'https://8-219-80-16.sslip.io/coord')).replace(/\/+$/, '');
if (A10 && ROLE !== 'host') process.env.PROMPTCUT_TEST_ASSET_TICKET_TTL_MS = String(TTL_MS);
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, node: BASE + 5 };
const FPS = 30;
const SECONDS = 10;
const EXTRA_HEAVY = 8;
const HOST_FP = '0c10b0e5f1a9e7d2';
const RUN_ARG = arg('--run', null);
if (RUN_ARG && RUN_ARG !== 'latest' && !/^[A-Za-z0-9_-]{1,24}$/.test(RUN_ARG)) { process.stderr.write('--run 要 1～24 个 [A-Za-z0-9_-]\n'); process.exit(2); }
const RUN = RUN_ARG && RUN_ARG !== 'latest' ? RUN_ARG : `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const SITE = REMOTE ? String(SITE_ARG).replace(/\/+$/, '') : proxyOrigins(PORTS.editor).editor;
/** 两个舞台源:本机替身是 +1、+2 两个端口;外网模式在主流程开头按 --stage-origins / runtime-config.json 定 */
let STAGE_ORIGINS = REMOTE ? [] : proxyOrigins(PORTS.editor).stages;
const HOSTED = `${SITE}/hosted/`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), ROLE === 'host' ? 'pc-c10-host-' : 'pc-c10-browser-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const deadline = started + Number(arg('--timeout-min', REMOTE || ROLE !== 'all' ? 120 : 60)) * 60_000;

const fails = [];
const out = { ok: false, run: RUN, role: ROLE, mode: A10 ? 'a10' : E6R ? 'a1-a5+e6-reverse' : 'a1-a5', target: REMOTE ? 'site' : 'local', site: SITE, stageOrigins: STAGE_ORIGINS, out: OUT, steps: {} };
/** 等外部主机而没等到的项(不算失败,只记下) */
const pending = [];
/** 耗时只记录(verification.md「耗时只记录,不当闸门」):各步用时写进 TIMINGS 行与结果的 timings,不决定过不过 */
const timings = createTimings('c10-browser-probe');
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 500)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const codeOf = (link) => String(link ?? '').split('invite=')[1] ?? '';

async function until(label, fn, timeoutMs, everyMs = 300) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}
const getJson = async (url, timeoutMs = 10_000) => (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).json();

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
function pidOnPort(port) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

/* ================================================================== 本机替身:托管组合 + 三个源的仿 nginx 代理 */

let combo = null;
let hostedProxy = null;
const docHeaders = [];
async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let DIST = arg('--dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    say('local.build-online', { dist: DIST });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  // 共用的本机托管代理(`lib/hosted-proxy.mjs`,full 策略:同站跨源的三个源、策略头、`/media-s/`、运行配置)
  hostedProxy = await startHostedProxy({ dist: DIST, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
  say('local.up', { site: SITE, stages: STAGE_ORIGINS, doc: PORTS.doc, asset: PORTS.asset, dist: DIST, ticketTtlMs: A10 ? TTL_MS : null });
}

/* ================================================================== 创建者的桌面编辑器(兼渲染节点) */

let editor = null;
const editorLog = [];
async function startEditor(sharedConfig) {
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const dir = path.join(TMP, 'editor');
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'card-overrides'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION',
    'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL', 'PROMPTCUT_CARD_SYNC', 'PROMPTCUT_LAN_HOST', 'VITE_PC_ONLINE', 'PROMPTCUT_TEST_ENV_FINGERPRINT']) delete env[key];
  Object.assign(env, {
    PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp,
    PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_SHARED_CONFIG: sharedConfig,
    PROMPTCUT_DEVICE_ID: `c10b-creator-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'c10-browser 创建者',
  });
  const child = spawn(process.execPath, [viteBin(), '--port', String(PORTS.node), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { editorLog.push(line); if (editorLog.length > 8000) editorLog.shift(); }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  editor = { child, origin: `http://127.0.0.1:${PORTS.node}` };
  const up = await until('创建者编辑器起来', async () => {
    if (child.exitCode !== null) throw new Error('exited');
    return fetch(`${editor.origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, 500);
  if (!up) throw new Error(`编辑器没起来:${editorLog.slice(-8).join(' | ').slice(0, 500)}`);
  say('editor.up', { origin: editor.origin, pid: child.pid });
}
const prerenderInfo = () => getJson(`${editor.origin}/api/prerender/info`, 3000);
const diag = async () => (await getJson(`${(await prerenderInfo()).url}/api/frames/diagnostics`, 20_000))?.queue ?? null;
async function stopEditor() {
  if (!editor?.child?.pid) return;
  const pre = await prerenderInfo().catch(() => null);
  killTree(editor.child.pid);
  const prePort = pre?.url ? Number(new URL(pre.url).port) : null;
  if (prePort) { const pid = pidOnPort(prePort); if (pid) killTree(pid); }
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  editor = null;
}

/* ================================================================== 独立渲染主机(本机替身,host 档) */

let host = null;
const hostLog = [];
async function startHost(config, extraArgs = []) {
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用(主机)`);
  const env = { ...process.env, PROMPTCUT_TEST_ENV_FINGERPRINT: HOST_FP };
  delete env.PROMPTCUT_TEST_ASSET_TICKET_TTL_MS;
  if (HOST_NO_FFMPEG) stripFfmpeg(env, TMP);
  out.hostFfmpeg = ffmpegIn(env);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'render-host.mjs'), '--config', config, '--port', String(PORTS.node), '--data', path.join(TMP, 'host'), ...extraArgs],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env });
  const keep = (c) => { for (const line of c.toString().split(/\r?\n/)) if (line) { hostLog.push(line); if (hostLog.length > 4000) hostLog.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  host = { child, origin: `http://127.0.0.1:${PORTS.node}` };
  const ready = await until('独立渲染主机起来', () => hostLog.some((l) => l.includes('[render-host] ready')), 300_000, 500);
  say('host.up', { ready: !!ready, pid: child.pid });
  return ready;
}
const hostQueue = async () => (await getJson(`${host.origin}/api/frames/queue`, 10_000).catch(() => null));
async function stopHost() {
  if (!host?.child) return;
  try { host.child.send?.({ type: 'shutdown' }); } catch { /* 已退 */ }
  await Promise.race([new Promise((r) => host.child.once('exit', r)), delay(20_000)]);
  killTree(host.child.pid);
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  host = null;
}

/**
 * 主机诊断(`GET /api/frames/queue`)里给协调口与结果行的部分:只挑计数、身份与传输,不带凭证。
 * `transport` 是实际用的传输('ws';脱开时 null),HT-a 没有 HTTP 回落(`fallbacks` 恒 0),回落原因看 `sessionLog`。
 */
function hostView(body, lines = []) {
  if (!body) return null;
  const nodes = (body.nodes ?? []).map((n) => ({
    nodeId: n.nodeId ?? null, projectId: n.projectId ?? null, connected: n.connected ?? null,
    claimed: n.claimed ?? 0, completed: n.completed ?? 0, dedup: n.dedup ?? 0, failed: n.failed ?? 0, lost: n.lost ?? 0, released: n.released ?? 0,
    transport: typeof n.transport === 'string' || n.transport === null ? n.transport : (n.transport?.transport ?? null),
    resumes: n.resumes ?? 0, legacy: n.legacy ?? null, opens: n.opens ?? null, connectFailed: n.connectFailed ?? null, assetBase: n.assetBase ?? null,
  }));
  // 会话层的日志(建成、脱开、接续、传输出错):只留事件名与几个不含凭证的字段
  const sessionLog = [];
  for (const line of lines) {
    const m = /(session\.[a-z-]+)\s*(\{.*\})?/.exec(line);
    if (!m) continue;
    let f = {};
    try { f = m[2] ? JSON.parse(m[2]) : {}; } catch { f = {}; }
    sessionLog.push({ event: m[1], ...Object.fromEntries(Object.entries(f).filter(([k]) => ['transport', 'stage', 'message', 'legacy', 'retainMs', 'gapMs', 'reason', 'code'].includes(k)).map(([k, v]) => [k, String(v).slice(0, 160)])) });
  }
  return { profile: body.profile ?? null, envFingerprint: body.envFingerprint ?? null, codeVersion: typeof body.codeVersion === 'string' ? body.codeVersion.slice(0, 12) : null,
    maxConcurrent: body.maxConcurrent ?? null, nodes, sessionLog: sessionLog.slice(-8) };
}
/** 认领了 plan(切出细任务)且至少做完一段:claimed 算上 plan 本身(与本机替身同一判据) */
const a5Trace = createC10Trace();
let a5TraceCdp = null;
let a5ObserverNumber = 0;

/* ================================================================== 主机持有任务时断一次传输(--cut,照 ht-w-probe) */

/**
 * 主机子进程的环境里去掉 ffmpeg(`--host-no-ffmpeg`,本机模拟云端没有 ffmpeg):PATH 里含 ffmpeg 可执行文件的目录去掉,
 * Windows 上 `LOCALAPPDATA` 指到空目录(`findFfmpeg` 的兜底路径在它下面)。
 */
function stripFfmpeg(env, dir) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = String(env[key] ?? '').split(sep).filter((d) => d && !fs.existsSync(path.join(d, exe))).join(sep);
  if (process.platform === 'win32') { env.LOCALAPPDATA = path.join(dir, 'no-ffmpeg-localappdata'); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true }); }
  return env;
}
/** 在给定环境里 ffmpeg 找不找得到(与 `findFfmpeg` 同一个次序:先 PATH,Windows 再兜底路径) */
function ffmpegIn(env) {
  const r = spawnSync('ffmpeg', ['-version'], { env, encoding: 'utf8', windowsHide: true });
  if (r.status === 0) return { found: true, via: 'PATH', version: String(r.stdout).split(/\r?\n/)[0].slice(0, 80) };
  if (process.platform === 'win32') {
    const fb = path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe');
    if (fs.existsSync(fb)) return { found: true, via: 'winget-fallback' };
  }
  return { found: false };
}
/** 主机日志里的节点能力(`queue.started` 那一行的 `capabilities`)与提到 ffmpeg 的行 */
function hostLogFacts(lines) {
  let capabilities = null;
  for (const l of lines) {
    if (!l.includes('queue.started')) continue;
    const m = /\{.*\}/.exec(l);
    try { capabilities = JSON.parse(m?.[0] ?? 'null')?.capabilities ?? capabilities; } catch { /* 半行 */ }
  }
  return { capabilities, ffmpegMentions: lines.filter((l) => /ffmpeg|ffprobe|ENOENT/i.test(l)).slice(-6).map((l) => l.slice(0, 240)) };
}
/** 主机报给队列的节点能力:预渲染进程诊断里 `queue.started` 事件的 `capabilities`(render-host 不一定把那一行转出来) */
async function hostCapabilities(origin) {
  try {
    const url = (await getJson(`${origin}/api/prerender/info`, 5000))?.url;
    const events = (await getJson(`${url}/api/frames/diagnostics`, 20_000))?.queue?.events ?? [];
    return events.filter((e) => e?.event === 'queue.started').at(-1)?.capabilities ?? null;
  } catch { return null; }
}
/** 本机代理(`render-queue-proxy.mjs --cut-once --stdin-control`),回 { child, lines, url } */
async function startCutProxy(listenPort, target) {
  if (!(await portFree(listenPort))) throw new Error(`代理端口 ${listenPort} 被占用`);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'probes', 'render-queue-proxy.mjs'), '--listen', `127.0.0.1:${listenPort}`, '--target', target, '--cut-once', '--stdin-control'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  const keep = (c) => { for (const l of c.toString().split(/\r?\n/)) if (l) { lines.push(l); if (lines.length > 2000) lines.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const end = Date.now() + 10_000;
  while (Date.now() < end && !lines.some((l) => l.includes('"event":"listen"'))) await delay(100);
  if (!lines.some((l) => l.includes('"event":"listen"'))) throw new Error(`代理没起来:${lines.slice(-3).join(' | ')}`);
  return { child, lines, url: `ws://127.0.0.1:${listenPort}/`, target };
}
async function stopCutProxy(p) {
  if (!p?.child) return;
  try { p.child.stdin.write('quit\n'); } catch { /* 已关 */ }
  await Promise.race([new Promise((r) => p.child.once('exit', r)), delay(5000)]);
  killTree(p.child.pid);
}
const sessionsOf = async (healthz) => { try { return (await getJson(healthz, 15_000))?.sessions ?? null; } catch { return null; } };

/**
 * 等主机手里有任务 → onHolding → doCut() → 等会话接续。判据(同 ht-w-probe):
 *   cut              断开确实发生了;
 *   session-resumed  主机 `resumes` 恰好 +1(0 → 1);
 *   not-new-session  `opens` 不变(接续,不是重开);
 *   healthz-resumed  托管端 `/healthz` 的 `sessions.resumed` 增加。
 * 回 { held, before, after, checks }。checks 由调用方记进 fails。
 */
async function cutWhileHolding({ queue, healthz, onHolding, doCut, holdTimeoutMs = 900_000, resumeTimeoutMs = RESUME_TIMEOUT_MS }) {
  const res = { held: [], checks: [] };
  const add = (name, ok, detail) => res.checks.push({ name, ok: !!ok, detail });
  let pre = null;
  let firstHeldAt = null;
  const end = Date.now() + holdTimeoutMs;
  while (Date.now() < Math.min(end, deadline)) {
    const n = (await queue())?.nodes?.[0];
    // 先见到的多半是 plan(切分时持有);再等至多 2 分钟,等手里有细任务(快照段)时断,判据落在产出任务上。等不到就按手里的 plan 断
    if (n && Array.isArray(n.held) && n.held.length > 0 && n.connected) {
      pre ??= n;
      firstHeldAt ??= Date.now();
      if (n.held.some((id) => !String(id).startsWith('plan:'))) { pre = n; break; }
      if (Date.now() - firstHeldAt > 120_000) break;
    }
    await delay(150);
  }
  if (!pre) { add('held-before-cut', false, { timeoutMs: holdTimeoutMs }); return res; }
  add('held-before-cut', true, { held: pre.held });
  const sessionsBefore = await sessionsOf(healthz);
  const before = { held: pre.held, opens: pre.opens ?? null, resumes: pre.resumes ?? 0, transport: pre.transport ?? null, sessionsResumed: sessionsBefore?.resumed ?? null };
  Object.assign(res, { held: pre.held, before });
  await onHolding?.(before);
  const cutAt = Date.now();
  const cutOk = await doCut();
  add('cut', cutOk, { cutOk });
  let resumed = null;
  const endR = Date.now() + resumeTimeoutMs;
  while (Date.now() < Math.min(endR, deadline)) {
    const n = (await queue())?.nodes?.[0];
    if (n && (n.resumes ?? 0) > before.resumes) { resumed = n; break; }
    await delay(200);
  }
  let sessionsAfter = null;
  const endH = Date.now() + 15_000;
  while (Date.now() < endH) {
    sessionsAfter = await sessionsOf(healthz);
    if ((sessionsAfter?.resumed ?? 0) > (sessionsBefore?.resumed ?? Infinity)) break;
    await delay(500);
  }
  res.after = { resumes: resumed?.resumes ?? null, opens: resumed?.opens ?? null, transport: resumed?.transport ?? null, cutToResumeMs: resumed ? Date.now() - cutAt : null, sessionsResumed: sessionsAfter?.resumed ?? null };
  add('session-resumed', resumed && resumed.resumes === before.resumes + 1, { resumes: [before.resumes, resumed?.resumes ?? null] });
  add('not-new-session', resumed && resumed.opens === before.opens, { opens: [before.opens, resumed?.opens ?? null], connectFailed: resumed?.connectFailed ?? null });
  add('healthz-resumed', (sessionsAfter?.resumed ?? 0) > (sessionsBefore?.resumed ?? Infinity), { before: sessionsBefore?.resumed ?? null, after: sessionsAfter?.resumed ?? null });
  return res;
}

/**
 * 旁观节点(--cut 时,creator 一侧):成员身份、`role: 'render'` 连项目,`node.hello`(不带指纹:前置过滤放行全部任务)后
 * `queue.watch` 本项目,只收不认领,记每个任务的 task.taken / 认领后又 task.opened / task.closed。
 */
async function startWatcher(M, { projectId, password, diagnosticOnly = false }) {
  const c = await openConn(M, { url: M.wsBaseOf(HOSTED), projectId, username: '旁观节点', password, as: 'member', role: 'render' });
  const traceChannel = `observer:${++a5ObserverNumber}`;
  const seen = new Map();
  const tasks = new Map();
  const rec = (id) => { if (!seen.has(id)) seen.set(id, { taken: 0, reopenedAfterTaken: 0, closed: [] }); return seen.get(id); };
  c.ep.onMessage((m) => {
    a5Trace.observe(m, { channel: traceChannel });
    if (m?.type === 'queue.snapshot') { tasks.clear(); for (const task of m.tasks ?? []) tasks.set(task.id, task); }
    else if (m?.type === 'task.opened' && m.task?.id) tasks.set(m.task.id, m.task);
    else if (['task.taken', 'task.closed'].includes(m?.type)) { const task = tasks.get(m.id); if (task) tasks.set(m.id, { ...task, state: m.type === 'task.taken' ? 'claimed' : m.state }); }
    if (m?.type === 'task.taken' && typeof m.id === 'string') rec(m.id).taken++;
    else if (m?.type === 'task.opened' && typeof m.task?.id === 'string') { const r = rec(m.task.id); if (r.taken > 0) r.reopenedAfterTaken++; }
    else if (m?.type === 'task.closed' && typeof m.id === 'string') rec(m.id).closed.push(m.state ?? null);
  });
  const subscribe = async () => {
    const hello = await c.rpc({ type: 'node.hello', nodeId: `c10b-watch-${RUN}`.slice(0, 64), profile: 'pc', codeVersions: [], capabilities: {}, maxConcurrent: 1 }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    const watch = await c.rpc({ type: 'queue.watch', projects: [projectId] }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    return { hello, watch };
  };
  const { hello, watch } = await subscribe();
  if (!diagnosticOnly) check(hello.type !== 'error' && watch.type === 'queue.snapshot', '--cut:旁观节点在看本项目的队列', { hello: hello.type, reason: hello.reason ?? watch.reason ?? null, watch: watch.type });
  // 会话结束后建了新会话(onOpen 只在新会话时调;接续调 onResume、订阅还在):重发 hello 与 watch。计数进结果
  const stats = { newSessions: 0, resumes: 0 };
  c.ep.onOpen(() => { stats.newSessions++; a5Trace.boundary(traceChannel, 'new-session'); void subscribe(); });
  c.ep.onResume?.(() => { stats.resumes++; a5Trace.boundary(traceChannel, 'resumed'); });
  c.ep.onClose(() => a5Trace.boundary(traceChannel));
  return { seen, stats, tasks, close: c.close };
}
/** 成员页收到的 task.done(CDP 读页面 WebSocket 的入站帧;会话层的重发按 seq 去重,同一任务不同 seq 算两次) */
async function countPageDone(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const done = new Map();
  cdp.on('Network.webSocketFrameReceived', (e) => {
    const s = e?.response?.payloadData;
    if (typeof s !== 'string' || !s.includes('task.done')) return;
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (m?.type !== 'task.done' || typeof m.id !== 'string') return;
    if (!done.has(m.id)) done.set(m.id, new Set());
    done.get(m.id).add(m.seq ?? `frame-${done.get(m.id).size}`);
  });
  return { counts: () => Object.fromEntries([...done].map(([id, s]) => [id, s.size])), detach: () => cdp.detach().catch(() => {}) };
}
/** creator 一侧对持有的任务的判据:旁观节点看到认领恰好一次、之后没再 open、关闭一次且是 done;页面恰好一次 task.done */
async function judgeHeld(held, watcher, pageDone) {
  const end = Date.now() + 300_000;
  let pageSince = null;
  while (Date.now() < Math.min(end, deadline)) {
    const pageAll = held.every((id) => (pageDone.counts()[id] ?? 0) > 0);
    if (pageAll) pageSince ??= Date.now();
    if (pageAll && held.every((id) => (watcher.seen.get(id)?.closed ?? []).length > 0)) break;
    // 页面已收到 task.done 而旁观节点 30 s 还没见到关闭:按漏看处理,不再等
    if (pageSince && Date.now() - pageSince > 30_000) break;
    await delay(1000);
  }
  await delay(1500);
  const counts = pageDone.counts();
  const perHeld = held.map((id) => { const w = watcher.seen.get(id) ?? { taken: 0, reopenedAfterTaken: 0, closed: [] }; return { id, taken: w.taken, reopened: w.reopenedAfterTaken, closed: w.closed, taskDone: counts[id] ?? 0 }; });
  // 旁观节点漏看(没见到关闭、也没见到重新 open,而页面恰好一次 task.done):单列,不判 taken / done 失败
  const missed = perHeld.filter((h) => h.closed.length === 0 && h.reopened === 0 && h.taskDone === 1);
  if (missed.length) pending.push({ item: '--cut:旁观节点漏看持有的任务的关闭(页面恰好一次 task.done)', status: '旁观节点漏看', held: missed.map((h) => ({ id: h.id, taken: h.taken })), watcher: watcher.stats });
  const judged = perHeld.filter((h) => !missed.includes(h));
  check(perHeld.length > 0 && judged.every((h) => h.taken === 1 && h.reopened === 0 && h.closed.length === 1 && h.closed[0] === 'done'), '--cut:持有的任务 taken 1 / reopened 0 / done 1', { perHeld, watcher: watcher.stats });
  check(perHeld.length > 0 && perHeld.every((h) => h.taskDone === 1), '--cut:持有的任务恰好一次 task.done(页面收到)', perHeld.map((h) => ({ id: h.id, taskDone: h.taskDone })));
  const multi = Object.entries(counts).filter(([, n]) => n > 1);
  check(multi.length === 0, '--cut:页面收到的 task.done 没有重复的', Object.fromEntries(multi));
  return { perHeld, watcher: watcher.stats, missedByWatcher: missed.map((h) => h.id), pageTaskDone: { tasks: Object.keys(counts).length, allOne: multi.length === 0 } };
}

/* ================================================================== 协调口 KV(外部主机) */

const kvKey = (run, name) => `c10b.${run}.${name}`;
async function kvOf(run) {
  const { coordClient } = await import('./probe-coord.mjs');
  const c = coordClient(COORD);
  return {
    put: (name, value) => c.put(kvKey(run, name), value),
    get: (name, waitMs = 0) => c.get(kvKey(run, name), waitMs),
    /** 等到 name 出现或到 endAt;协调口暂时连不上就退避重试;watchAbort 时 abort 出现就抛错 */
    async wait(name, endAt, { watchAbort = false } = {}) {
      let backoff = 500;
      while (Date.now() < Math.min(endAt, deadline)) {
        try {
          const v = await c.get(kvKey(run, name), Math.max(1, Math.min(20_000, Math.min(endAt, deadline) - Date.now())));
          if (v !== null) return v;
          backoff = 500;
        } catch { await delay(backoff); backoff = Math.min(backoff * 2, 10_000); }
        if (watchAbort) {
          const a = await c.get(kvKey(run, 'abort'), 0).catch(() => null);
          if (a !== null) throw new Error(`creator 已中止:${String(a.reason ?? '').slice(0, 200)}`);
        }
      }
      return null;
    },
    latest: () => c.get('c10b.latest', 0),
    putLatest: (v) => c.put('c10b.latest', v),
  };
}

/* ================================================================== E6 反方向(--e6-reverse) */

/**
 * 节点认领 / 完成了哪些任务:每秒读一次预渲染进程诊断里的节点事件(`node.claimed|completed|dedup|lost|failed`,带任务 id;
 * 诊断只留最近 80 条事件,所以要勤读,同 m8-e-probe 的 host)。`origin` 是编辑器(render-host 的 --port)地址。
 */
function trackNodeIds(origin) {
  const ids = { claimed: new Set(), completed: new Set(), dedup: new Set(), lost: new Set(), failed: new Set() };
  let pre = null;
  let stopped = false;
  const poll = async () => {
    try {
      pre ??= (await getJson(`${origin}/api/prerender/info`, 5000))?.url ?? null;
      if (!pre) return;
      const q = (await getJson(`${pre}/api/frames/diagnostics`, 20_000))?.queue ?? {};
      for (const e of q.events ?? []) {
        const m = /^node\.(claimed|completed|dedup|lost|failed)$/.exec(String(e?.event ?? ''));
        if (m && typeof e.id === 'string') ids[m[1]].add(e.id);
      }
      // 执行器不发 node.claimed 事件(task-runner 只报 completed / dedup / lost / failed / discarded):
      // 认领过的任务从此刻持有、在跑的里收(plan 切分时也在 held 里)
      const idOf = (x) => (typeof x === 'string' ? x : typeof x?.id === 'string' ? x.id : null);
      for (const x of [...(q.running ?? []), ...(q.nodes ?? []).flatMap((n) => [...(n?.held ?? []), ...(n?.running ?? [])])]) { const id = idOf(x); if (id) ids.claimed.add(id); }
      for (const id of [...ids.completed, ...ids.dedup, ...ids.failed, ...ids.lost]) ids.claimed.add(id);
    } catch { /* 下一拍再试 */ }
  };
  void (async () => { while (!stopped) { await poll(); await delay(400); } })();
  return {
    ids, poll,
    stop: () => { stopped = true; },
    view: () => Object.fromEntries(Object.entries(ids).map(([k, s]) => [k, [...s].slice(0, 400)])),
    size: () => Object.values(ids).reduce((n, s) => n + s.size, 0),
  };
}

/**
 * E6 的旁观节点:成员、`role: 'render'`、`node.hello` 不带指纹(前置过滤放行全部任务)、`queue.watch` 本项目,只收不认领。
 * 每个任务记:kind、derivedFrom、要求的指纹、结果键、最新版本号、状态、taken 次数(与时刻)、关闭状态(与时刻)。
 */
async function startE6Watcher(M, { projectId, password }) {
  const c = await openConn(M, { url: M.wsBaseOf(HOSTED), projectId, username: 'E6 旁观节点', password, as: 'member', role: 'render' });
  const tasks = new Map();
  const epochs = [];
  const rec = (id) => {
    if (!tasks.has(id)) tasks.set(id, { kind: null, derivedFrom: null, fp: undefined, resultKey: null, contentKey: null, dual: false, version: null, state: null, taken: [], closed: [], seenAt: Date.now() });
    return tasks.get(id);
  };
  const see = (t) => {
    if (typeof t?.id !== 'string') return;
    const r = rec(t.id);
    r.kind ??= t.kind ?? null;
    r.contentKey ??= typeof t.input?.contentKey === 'string' ? t.input.contentKey : null;
    if (t.input?.dual === true) r.dual = true;
    r.derivedFrom ??= t.source?.derivedFrom ?? null;
    if (r.fp === undefined) r.fp = typeof t.requires?.envFingerprint === 'string' ? t.requires.envFingerprint : null;
    r.resultKey ??= t.resultKey ?? null;
    if (typeof t.version === 'number') r.version = t.version;
    if (typeof t.state === 'string') r.state = t.state;
  };
  c.ep.onMessage((m) => {
    if (typeof m?.epoch === 'string' && !epochs.includes(m.epoch)) epochs.push(m.epoch);
    if (m?.type === 'task.opened') see(m.task);
    else if (m?.type === 'queue.snapshot') for (const t of m.tasks ?? []) see(t);
    else if (m?.type === 'task.taken' && typeof m.id === 'string') { const r = rec(m.id); r.taken.push(Date.now()); r.state = 'claimed'; if (typeof m.version === 'number') r.version = m.version; }
    else if (m?.type === 'task.closed' && typeof m.id === 'string') { const r = rec(m.id); r.closed.push({ state: m.state ?? null, at: Date.now() }); r.state = m.state ?? 'closed'; }
  });
  const stats = { newSessions: 0 };
  const subscribe = async () => {
    const hello = await c.rpc({ type: 'node.hello', nodeId: `c10b-e6w-${RUN}`.slice(0, 64), profile: 'pc', codeVersions: [], capabilities: {}, maxConcurrent: 1 }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    const watch = await c.rpc({ type: 'queue.watch', projects: [projectId] }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    return { hello: hello.type, watch: watch.type, reason: hello.reason ?? watch.reason ?? null };
  };
  const first = await subscribe();
  check(first.hello !== 'error' && first.watch === 'queue.snapshot', 'E6 反方向:旁观节点在看本项目的队列', first);
  c.ep.onOpen(() => { stats.newSessions++; void subscribe(); });
  return { tasks, epochs, stats, close: c.close };
}

/**
 * 成员页(发布方)收到的每一条 task.done 与 task.failed:CDP 读页面 WebSocket 的入站帧,同一任务同一 seq 只算一次(会话层重发),
 * 记 epoch;task.failed 记 error(`superseded` = M7 D1 双份里被作废的那一份)。
 */
async function pageDoneEvents(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const seen = new Set();
  const events = [];
  const failed = [];
  cdp.on('Network.webSocketFrameReceived', (e) => {
    const s = e?.response?.payloadData;
    if (typeof s !== 'string' || !(s.includes('task.done') || s.includes('task.failed'))) return;
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if ((m?.type !== 'task.done' && m?.type !== 'task.failed') || typeof m.id !== 'string') return;
    const key = `${m.type}\u0000${m.id}\u0000${m.seq ?? `frame-${events.length + failed.length}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (m.type === 'task.done') events.push({ id: m.id, epoch: typeof m.epoch === 'string' ? m.epoch : null, at: Date.now() });
    else failed.push({ id: m.id, error: String(m.error ?? '').slice(0, 120), at: Date.now() });
  });
  return { events, failed, detach: () => cdp.detach().catch(() => {}) };
}

/**
 * X(claimer):协议层节点,profile host、报本机真实指纹。对旁观节点看到的、还 open 的细任务各 `task.claim` 一次;
 * 认领成了当场 `task.release`(记进 claimed,判失败)。`probePlan(id)`:拿 host 身份试认领一个 plan,只记回包(L18)。
 */
async function startClaimer(M, { projectId, password, fingerprint, watcher, isRound }) {
  const c = await openConn(M, { url: M.wsBaseOf(HOSTED), projectId, username: 'E6 X 节点', password, as: 'member', role: 'render' });
  const nodeId = `c10b-e6x-${RUN}`.slice(0, 64);
  const st = { nodeId, fingerprint, hello: null, watch: null, onlineAt: null, visible: new Set(), attempts: [], claimed: [], released: [], rejected: {}, sameFp: [] };
  c.ep.onMessage((m) => {
    if (m?.type === 'task.opened' && typeof m.task?.id === 'string') st.visible.add(m.task.id);
    else if (m?.type === 'queue.snapshot') for (const t of m.tasks ?? []) if (typeof t?.id === 'string') st.visible.add(t.id);
  });
  const subscribe = async () => {
    const hello = await c.rpc({ type: 'node.hello', nodeId, profile: 'host', envFingerprint: fingerprint, codeVersions: [], capabilities: {}, maxConcurrent: 1 }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    const watch = await c.rpc({ type: 'queue.watch', projects: [projectId] }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    st.hello = { type: hello.type, reason: hello.reason ?? null, envFingerprint: hello.envFingerprint ?? null };
    st.watch = { type: watch.type, reason: watch.reason ?? null };
  };
  await subscribe();
  st.onlineAt = Date.now();
  check(st.hello?.type !== 'error' && st.watch?.type === 'queue.snapshot', 'E6 反方向:X(claimer)以 host 身份报到并看着本项目', { hello: st.hello, watch: st.watch });
  c.ep.onOpen(() => { void subscribe(); });
  const tried = new Set();
  const claimOnce = async (id, version, { plan = false } = {}) => {
    const r = await c.rpc({ type: 'task.claim', id, expectVersion: version }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    const entry = { id: id.slice(0, 120), at: Date.now(), type: r.type, reason: r.reason ?? null };
    if (r.type === 'task.claimed') {
      const rel = await c.rpc({ type: 'task.release', id, token: r.token, reason: 'e6-probe' }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
      entry.released = rel.type;
      if (!plan) { st.claimed.push(id); st.released.push({ id, type: rel.type }); }
    } else if (!plan) {
      const k = r.reason ?? r.type;
      st.rejected[k] = (st.rejected[k] ?? 0) + 1;
    }
    if (!plan) st.attempts.push(entry);
    return entry;
  };
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      for (const [id, t] of watcher.tasks) {
        if (tried.has(id) || t.kind === 'plan' || t.state !== 'open' || !isRound(t)) continue;
        tried.add(id);
        // 要求 X 自己这种指纹的(M7 D1 给同一台机器上的页面出的浏览器那一份)X 本来就可以认领:不去碰,只计数
        // (认领再放回会把卡锁在 X 的指纹上、把切分方那一份作废,扰乱这一版)
        if (t.fp === fingerprint) { st.sameFp.push(id); continue; }
        await claimOnce(id, t.version ?? 1);
      }
    })().finally(() => { busy = false; });
  }, 300);
  return {
    st,
    probePlan: (id, version = 1) => claimOnce(id, version, { plan: true }),
    view: () => ({ nodeId, fingerprint, onlineAt: st.onlineAt, hello: st.hello, visibleRound: [...st.visible].filter((id) => { const t = watcher.tasks.get(id); return t && t.kind !== 'plan' && isRound(t); }).length,
      attempts: st.attempts.length, claimed: st.claimed.slice(0, 20), released: st.released, rejected: st.rejected, sameFpSkipped: st.sameFp.length, sample: st.attempts.slice(0, 4) }),
    close: () => { clearInterval(timer); c.close(); },
  };
}

/** X(host):外网模式里再起一台真的独立渲染主机(真实指纹),端口 BASE +0～+2(外网模式不起本机托管组合,这一段空着) */
async function startXHost(config) {
  const port = BASE;
  for (const p of [port, port + 1, port + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用(X 主机)`);
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_TEST_ASSET_TICKET_TTL_MS', 'PROMPTCUT_TEST_ENV_FINGERPRINT']) delete env[key];
  const lines = [];
  const child = fork(path.join(ROOT, 'scripts', 'render-host.mjs'), ['--config', config, '--port', String(port), '--data', path.join(TMP, 'xhost')],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const keep = (c) => { for (const l of c.toString().split(/\r?\n/)) if (l) { lines.push(l); if (lines.length > 4000) lines.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const ready = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 360_000);
    child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve(m); } });
    child.once('exit', () => { clearTimeout(t); resolve(null); });
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    child, lines, origin, port, ready: !!ready, readyAt: Date.now(),
    queue: () => getJson(`${origin}/api/frames/queue`, 10_000).catch(() => null),
    async stop() {
      try { child.send?.({ type: 'shutdown' }); } catch { /* 已退 */ }
      await Promise.race([new Promise((r) => child.once('exit', r)), delay(20_000)]);
      killTree(child.pid);
      for (const p of [port, port + 1, port + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
    },
  };
}

/* ================================================================== --role host:外部独立渲染主机 */

async function runHostRole() {
  const port = Number(arg('--port', PORTS.node));
  out.port = port;
  let run = RUN;
  let store = null;
  let child = null;
  const lines = [];
  let exitLine = null;
  let proxyRef = null;
  let tracker = null;
  try {
    if (!RUN_ARG) throw new Error('--role host 要给 --run <id>(或 --run latest)');
    if (RUN_ARG === 'latest') {
      const c = await kvOf('x');
      const since = started - 10 * 60_000;
      for (;;) {
        const v = await c.latest().catch(() => null);
        if (v?.run && (v.at ?? 0) >= since) { run = v.run; break; }
        if (Date.now() > deadline) throw new Error('KV 里没有本轮 id(c10b.latest)');
        await delay(3000);
      }
    }
    out.run = run;
    store = await kvOf(run);
    say('host.waiting-config', { run, coord: COORD });
    const cfg = await store.wait('config', deadline, { watchAbort: true });
    if (!cfg) throw new Error('等 KV config(创建者的配置)超时');
    out.project = { projectId: cfg.projectId, hosted: cfg.hosted ?? null };
    for (const p of [port, port + 1, port + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
    const configFile = path.join(TMP, 'host-shared.json');
    // --cut proxy:经本机代理(端口 +3)连文档服务;https 的托管端要给 --proxy-target <明文文档服务 host:port>(代理不解 TLS)
    let docUrl = cfg.ws;
    if (CUT === 'proxy') {
      let target = arg('--proxy-target', null);
      if (!target) {
        const u = new URL(cfg.ws);
        if (u.protocol !== 'ws:') throw new Error('托管端是 wss 时 --cut proxy 要给 --proxy-target <明文文档服务 host:port>');
        target = `${u.hostname}:${u.port || 80}`;
      }
      proxyRef = await startCutProxy(Number(arg('--proxy-port', port + 3)), target);
      docUrl = proxyRef.url;
    }
    fs.writeFileSync(configFile, JSON.stringify([{ url: docUrl, projectId: cfg.projectId, username: '渲染主机', password: cfg.memberPassword, as: 'member', role: 'render',
      deviceId: `c10b-xhost-${run}`.padEnd(16, '0').slice(0, 40), deviceName: `c10-browser 外部独立渲染主机(${os.hostname()})` }]));
    const env = { ...process.env };
    for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_TEST_ASSET_TICKET_TTL_MS', 'PROMPTCUT_TEST_ENV_FINGERPRINT']) delete env[key];
    const testFp = arg('--test-fingerprint', null);
    if (testFp) env.PROMPTCUT_TEST_ENV_FINGERPRINT = testFp;
    out.testFingerprint = !!testFp;
    if (HOST_NO_FFMPEG) stripFfmpeg(env, TMP);
    out.ffmpeg = ffmpegIn(env);
    // E6 反方向(creator 给了 --e6-reverse):并发压到 1,拉长这一版,好让 X 上线时还有细任务没做
    out.e6Reverse = cfg.e6Reverse === true;
    child = fork(path.join(ROOT, 'scripts', 'render-host.mjs'), ['--config', configFile, '--port', String(port), '--data', path.join(TMP, 'data'), ...(out.e6Reverse ? ['--max-concurrent', '1'] : [])],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const keep = (c) => {
      for (const line of c.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        lines.push(line); if (lines.length > 4000) lines.shift();
        if (line.startsWith('[render-host] exit ')) { try { exitLine = JSON.parse(line.slice('[render-host] exit '.length)); } catch { /* 半行 */ } }
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 360_000);
      child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve(m); } });
      child.once('exit', () => { clearTimeout(t); resolve(null); });
    });
    if (!check(ready, '[host] render-host 起来了', lines.slice(-6))) throw new Error('render-host 没起来');
    const origin = `http://127.0.0.1:${port}`;
    // E6 反方向:记认领 / 完成的任务 id,随 host.progress 与结果行交回(creator 判 J-纯层、Y 认领了 plan)
    tracker = out.e6Reverse ? trackNodeIds(origin) : null;
    const q0 = hostView(await getJson(`${origin}/api/frames/queue`, 30_000).catch(() => ready.queue), lines);
    out.ready = q0;
    const facts0 = hostLogFacts(lines);
    await store.put('host.ready', { at: Date.now(), ...q0, platform: process.platform, arch: process.arch, node: process.version, testFingerprint: !!testFp,
      ffmpeg: out.ffmpeg, capabilities: facts0.capabilities ?? await hostCapabilities(origin), cut: CUT, cutWaitMs: CUT_WAIT_MS, resumeTimeoutMs: RESUME_TIMEOUT_MS });
    say('host.ready', { profile: q0?.profile, envFingerprint: q0?.envFingerprint, nodeId: q0?.nodes?.[0]?.nodeId, transport: q0?.nodes?.[0]?.transport });
    check(q0?.profile === 'host', '[host] 诊断里 profile 是 host', q0?.profile);
    // --cut:和下面的进度循环并行 —— 持有任务时写 host.holding,断一次(proxy 自己切;external 等 KV cut.done),等接续,结果写 host.cut
    const queueOf = async () => getJson(`${origin}/api/frames/queue`, 10_000).catch(() => null);
    const cutP = CUT ? cutWhileHolding({
      queue: queueOf, healthz: cfg.healthz ?? `${String(cfg.hosted ?? '').replace(/\/+$/, '')}/healthz`,
      onHolding: (before) => store.put('host.holding', { at: Date.now(), held: before.held, cut: CUT, opens: before.opens, resumes: before.resumes, transport: before.transport }).then(() => say('host.holding', { held: before.held })),
      doCut: async () => {
        if (CUT === 'proxy') {
          proxyRef.child.stdin.write('cut\n');
          const end = Date.now() + 10_000;
          while (Date.now() < end) { if (proxyRef.lines.some((l) => l.includes('"event":"conn.cut"'))) return true; await delay(50); }
          return false;
        }
        say('host.wait-cut-done', { key: kvKey(run, 'cut.done'), waitMin: CUT_WAIT_MS / 60_000 });
        return !!(await store.wait('cut.done', Date.now() + CUT_WAIT_MS));
      },
    }).then(async (r) => {
      out.cut = { held: r.held, before: r.before, after: r.after, checks: r.checks };
      for (const c of r.checks) check(c.ok, `[host] --cut ${CUT}:${c.name}`, c.detail);
      await store.put('host.cut', { at: Date.now(), cut: CUT, held: r.held, before: r.before, after: r.after, checks: r.checks }).catch(() => {});
      return r;
    }, async (e) => { fails.push(`[host] --cut 出错:${String(e?.message ?? e).slice(0, 300)}`); await store.put('host.cut', { at: Date.now(), cut: CUT, held: [], checks: [{ name: 'cut-error', ok: false, detail: String(e?.message ?? e).slice(0, 300) }] }).catch(() => {}); return null; }) : null;
    // 看自己的诊断,变了就写 host.progress;等 finish / abort / 超时
    let lastSig = '';
    let last = q0;
    for (;;) {
      const q = hostView(await getJson(`${origin}/api/frames/queue`, 30_000).catch(() => null), lines);
      if (q) {
        last = q;
        const sig = JSON.stringify([q.nodes.map((n) => [n.claimed, n.completed, n.failed, n.transport, n.connected]), tracker?.size() ?? null]);
        if (sig !== lastSig) { lastSig = sig; await store.put('host.progress', { at: Date.now(), ...q, ...(tracker ? { ids: tracker.view() } : {}) }).catch(() => {}); say('host.progress', { nodes: q.nodes.map((n) => ({ claimed: n.claimed, completed: n.completed, failed: n.failed, transport: n.transport })) }); }
      }
      const fin = await store.get('finish', 2000).catch(() => null);
      if (fin) { out.finish = { reason: fin.reason ?? null }; break; }
      const ab = await store.get('abort', 0).catch(() => null);
      if (ab) { out.finish = { reason: `abort:${String(ab.reason ?? '').slice(0, 200)}` }; break; }
      if (Date.now() > deadline) { fails.push('[host] 超时:没等到 finish'); break; }
      if (child.exitCode !== null) throw new Error(`render-host 中途退了(退出码 ${child.exitCode})`);
    }
    out.last = last;
    out.didWork = hostDidWork(last);
    if (tracker) { await tracker.poll(); out.ids = tracker.view(); }
    if (cutP) {
      const r = await Promise.race([cutP, delay(5000).then(() => 'pending')]);
      if (r === 'pending') fails.push('[host] --cut 还没做完就收到了 finish / abort');
      else if (r?.before) {
        const n = (await queueOf())?.nodes?.[0];
        check(n && n.opens === r.before.opens, `[host] --cut ${CUT}:same-session-to-end(到最后 opens 仍不变)`, { opens: [r.before.opens, n?.opens ?? null], resumes: n?.resumes ?? null });
        check(n && n.released === 0, `[host] --cut ${CUT}:not-released(持有的任务没被放回)`, { released: n?.released ?? null });
      }
    }
    out.ffmpegMentions = hostLogFacts(lines).ffmpegMentions;
    out.capabilities = await hostCapabilities(origin).catch(() => null);
    child.send({ type: 'shutdown' });
    out.exitCode = await new Promise((resolve) => { if (child.exitCode !== null) return resolve(child.exitCode); const t = setTimeout(() => resolve(null), 60_000); child.once('exit', (code) => { clearTimeout(t); resolve(code); }); });
    out.released = exitLine?.released ?? null;
    check(out.exitCode === 0, '[host] render-host 经 IPC 正常退出(退出码 0)', { exitCode: out.exitCode, tail: lines.slice(-4) });
    if (out.ffmpeg && !out.ffmpeg.found) out.noFfmpegNote = '主机环境里没有 ffmpeg;照常起了、做了任务(看 didWork 与 ffmpegMentions)';
  } catch (e) {
    fails.push(`[host] 出错:${String(e?.message ?? e).slice(0, 600)}`);
  } finally {
    tracker?.stop();
    if (child && child.exitCode === null) killTree(child.pid);
    await stopCutProxy(proxyRef).catch(() => {});
    for (const p of [port, port + 1, port + 2]) { const pid = pidOnPort(p); if (pid && child) killTree(pid); }
    try { fs.writeFileSync(path.join(OUT, 'render-host.log'), lines.join('\n')); } catch { /* 写不了 */ }
    if (!KEEP) { for (const d of fs.readdirSync(TMP)) { const p = path.join(TMP, d); if (path.resolve(p) !== OUT) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 句柄没放 */ } } } }
    out.ms = Date.now() - started;
    out.fails = fails;
    out.ok = fails.length === 0;
    try { await store?.put('host', out); } catch (e) { fails.push(`[host] 结果交不回协调口:${e?.message ?? e}`); out.ok = false; }
    console.log(JSON.stringify(out));
    process.exit(out.ok ? 0 : 1);
  }
}

/* ================================================================== 文档服务连接(Node 侧,创建者身份) */

async function mods() {
  const [route, client, shared, ws, endpoint, ticket, asset, fp, link] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/render-node/ws-transport.mjs'), import('../../server/render-node/endpoint.mjs'),
    import('../../server/auth/ticket-source.mjs'), import('../../server/asset-store/client.mjs'), import('../../server/render-node/fingerprint.mjs'),
    import('../../server/render-node/session-link.mjs'),
  ]);
  return { ...client, ...route, ...shared, ...ws, ...endpoint, ...ticket, ...asset, ...fp, createDocEndpoint: link.createDocEndpoint };
}
function rpcOn(ep) {
  const waiting = new Map();
  let seq = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    waiting.delete(m.reqId);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  return (message, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const reqId = `c10b-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
}
async function openConn(M, { url, projectId, username, password, as, role = 'page' }) {
  const entry = M.normalizeEntry({ url, projectId, username, password, as, role, deviceId: `c10b-chk-${randomBytes(6).toString('hex')}`, deviceName: 'c10-browser-probe 核对' });
  // 会话客户端(createDocEndpoint,同 ht-w-probe):传输断了是接续,不是换一条新连接;新会话才调 onOpen,接续调 onResume
  const ep = M.createDocEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role }), log: () => {} });
  const opened = await new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), 20_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error('核对连接连不上文档服务'); }
  return { ep, rpc: rpcOn(ep), close: () => { try { ep.close(); } catch { /* 已关 */ } } };
}
async function adminOp(M, projectId, creator, op, fields = {}) {
  const protocols = await M.buildAuthProtocols({ base: HOSTED, projectId, username: creator.username, deviceId: `c10b-admin-${RUN}`.padEnd(16, '0'), deviceName: 'c10b admin', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(M.wsBaseOf(HOSTED), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `a${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  const ch = await ask({ type: 'shared.challenge' });
  const key = await M.deriveKey(creator.password, ch.salt, ch.kdf);
  const m = await M.adminProof({ key, projectId, username: creator.username, op, nonce: ch.nonce });
  const r = await ask({ type: 'shared.admin', op, proof: { nonce: ch.nonce, m }, ...fields });
  ws.close();
  return r;
}

/* ================================================================== 页面小件 */

let browser = null;
async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  return puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--disable-gpu'],
  });
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
const textOf = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}

/** 新页面:记下素材服务请求(按命名空间与哈希,不记查询串)、各源的文档响应头、主文档长任务 */
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  page.consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && page.consoleErrors.length < 60) page.consoleErrors.push(m.text().slice(0, 240)); });
  page.assets = [];
  page.on('request', (r) => {
    let u;
    try { u = new URL(r.url()); } catch { return; }
    // 2026-10-06 隔离之后:舞台读素材走自己源上的 /media-s/<会话号>/media/<哈希>(票据在 cookie 里,地址里没有),照样记成 ns = media
    const ms = new RegExp('^/media-s/[0-9a-f]{32}/media/([0-9a-f]{64})').exec(u.pathname);
    if (ms) {
      let fo = null;
      try { fo = new URL(r.frame()?.url() ?? '').origin; } catch { /* 没有 frame */ }
      page.assets.push({ at: Date.now(), method: r.method(), origin: u.origin, frameOrigin: fo, ns: 'media', hash: ms[1], sub: '', route: 'media-s', hasTicket: /[?&]t=/.test(u.search) });
      return;
    }
    const i = u.pathname.indexOf('/media/api/asset/');
    if (i < 0) return;
    const rest = u.pathname.slice(i + '/media/api/asset/'.length).split('/');
    let frameOrigin = null;
    try { frameOrigin = new URL(r.frame()?.url() ?? '').origin; } catch { /* 没有 frame */ }
    page.assets.push({ at: Date.now(), method: r.method(), origin: u.origin, frameOrigin, ns: rest[0], hash: rest[1] ?? '', sub: rest[2] ?? '' });
  });
  page.on('response', (res) => {
    const req = res.request();
    if (req.resourceType() !== 'document') return;
    let u;
    try { u = new URL(res.url()); } catch { return; }
    if (!u.pathname.startsWith('/editor')) return;
    docHeaders.push({ origin: u.origin, stage: u.searchParams.has('stage'), oac: res.headers()['origin-agent-cluster'] ?? null });
  });
  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    window.__pcLongTasks = [];
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__pcLongTasks.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
    } catch { /* 没有 longtask */ }
  });
  return page;
}
const joinMessage = (page) => textOf(page, '[data-pc="join-message"]');
const waitMembers = (page, ms = 90_000) => page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: ms });
const previewDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcPreviewDiag?.() ?? null)); } catch { return null; } }).catch(() => null);
const onlineDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
/** 编辑器页 L2 的三张表各几条 */
const l2Counts = (page) => P(page, () => new Promise((resolve) => {
  const r = indexedDB.open('promptcut-l2');
  r.onerror = () => resolve(null);
  r.onsuccess = () => {
    const db = r.result;
    const names = ['costs', 'snapshots', 'ranges'].filter((n) => db.objectStoreNames.contains(n));
    if (names.length !== 3) { db.close(); return resolve({ stores: [...db.objectStoreNames] }); }
    const tx = db.transaction(names, 'readonly');
    const outp = {};
    let left = names.length;
    for (const n of names) {
      const q = tx.objectStore(n).count();
      q.onsuccess = () => { outp[n] = q.result; if (--left === 0) { db.close(); resolve(outp); } };
      q.onerror = () => { outp[n] = -1; if (--left === 0) { db.close(); resolve(outp); } };
    }
  };
})).catch(() => null);
/** 可见舞台的 frame(按 __pcPreviewDiag 的 frontId) */
async function frontFrame(page) {
  const d = await previewDiag(page);
  const id = d?.frontId ?? 'A';
  return page.frames().find((f) => /[?&]stage=1/.test(f.url()) && new URL(f.url()).searchParams.get('id') === id) ?? null;
}
async function stageSample(page) {
  const f = await frontFrame(page);
  if (!f) return null;
  return f.evaluate(() => {
    const d = window.__pcStageDiag?.() ?? {};
    const wraps = [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].filter((w) => !w.parentElement?.closest('[data-pc-clip]')).map((w) => {
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const plane = w.querySelector(':scope > [data-pc-snapshot-plane]');
      return {
        id: w.getAttribute('data-pc-clip'),
        suppressed: w.classList.contains('pc-suppressed'),
        settling: w.classList.contains('pc-settling'),
        plane: !!plane,
        planeSig: plane ? (() => { let h = 2166136261; const t = plane.innerHTML; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return `${t.length}:${(h >>> 0).toString(36)}`; })() : null,
        placeholder: !!slot && !slot.hidden,
      };
    });
    return { playing: !!d.beatRunning, t: d.t, wraps };
  }).catch(() => null);
}
function assetSummary(list) {
  const gets = list.filter((a) => a.method === 'GET' && !a.sub);
  return {
    px: gets.filter((a) => a.ns === 'px').length,
    snap: gets.filter((a) => a.ns === 'snap').length,
    media: gets.filter((a) => a.ns === 'media').length,
    mediaByFrameOrigin: Object.fromEntries([...new Set(gets.filter((a) => a.ns === 'media').map((a) => `${a.frameOrigin}→${a.origin}`))].map((k) => [k, gets.filter((a) => a.ns === 'media' && `${a.frameOrigin}→${a.origin}` === k).length])),
  };
}

/* ================================================================== 主流程 */

if (ROLE === 'host') await runHostRole();

const state = {};
let M = null;
let conn = null;
/** 外部主机:KV(本轮)与收尾时要不要写 abort */
let xstore = null;
let xfinished = false;
/** 收尾用:--cut 的旁观节点与本机代理 */
let watcherRef = null;
let cutProxyRef = null;
/** E6 反方向这一轮的状态(旁观节点、页面 task.done、Y 的任务 id、X 节点);收尾用 */
let e6 = null;

/** E6 反方向:页面发布之后、Y 起来之前 —— 旁观节点与页面 task.done 计数先起 */
async function e6Begin(planId) {
  const watcher = await startE6Watcher(M, { projectId: state.projectId, password: state.projectPassword });
  const pageDone = await pageDoneEvents(state.member);
  const s = { planId, watcher, pageDone, startedAt: Date.now(), claimer: null, xhost: null, xhostTracker: null, yTracker: null, l18: [] };
  /** 页面清单 plan(`#clips:`)、有人认领过的 */
  s.roundPlans = () => [...watcher.tasks].filter(([id, t]) => t.kind === 'plan' && id.includes('#clips:') && t.taken.length > 0).map(([id]) => id);
  /** 这一轮的细任务:由上面那种 plan 切出来的 */
  s.isRound = (t) => {
    if (!t || t.kind === 'plan' || typeof t.derivedFrom !== 'string' || !t.derivedFrom.includes('#clips:')) return false;
    return (watcher.tasks.get(t.derivedFrom)?.taken.length ?? 0) > 0;
  };
  s.roundIds = () => [...watcher.tasks].filter(([, t]) => s.isRound(t)).map(([id]) => id);
  say('e6r.begin', { planId: String(planId ?? '').slice(0, 80), xNodes: X_NODES });
  return s;
}

/** E6 反方向:Y 起来之后 —— 等 Y 认领页面的 plan,之后 X 上线;X(claimer)顺带拿 host 身份试认领桌面 plan(L18,只记录) */
async function e6AfterYUp() {
  const taken = await until('E6 反方向:Y 认领页面发布的 plan', () => ((e6.watcher.tasks.get(e6.planId)?.taken.length ?? 0) > 0 ? true : null), 900_000, 250);
  e6.planTakenAt = taken ? Date.now() : null;
  // 此刻 Y 的认领计数(本机替身读它的诊断;外部主机读它最近一次 host.progress):plan 被认领时在线、能认领 plan 的只有 Y
  // (创建者已关,纯浏览器认领 plan 一律 plan-profile,X 还没上线)
  const yq = EXTERNAL_HOST ? await xstore.get('host.progress', 5000).catch(() => null) : hostView(await hostQueue(), hostLog);
  e6.yAtPlanTaken = { claimed: yq?.nodes?.[0]?.claimed ?? null, completed: yq?.nodes?.[0]?.completed ?? null, envFingerprint: yq?.envFingerprint ?? null };
  say('e6r.plan-taken', { ok: !!taken, afterMs: taken ? Date.now() - e6.startedAt : null, y: e6.yAtPlanTaken });
  if (X_NODES.includes('claimer')) {
    e6.claimer = await startClaimer(M, { projectId: state.projectId, password: state.projectPassword, fingerprint: state.creatorFp, watcher: e6.watcher, isRound: e6.isRound });
    for (const id of (state.desktopPlans ?? []).slice(-3)) e6.l18.push(await e6.claimer.probePlan(id));
    say('e6r.x-claimer-online', { fingerprint: state.creatorFp, l18: e6.l18.map((r) => r.reason ?? r.type) });
  }
  if (X_NODES.includes('host')) {
    const cfgFile = path.join(TMP, 'xhost.json');
    fs.writeFileSync(cfgFile, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: 'E6 X 主机', password: state.projectPassword, as: 'member', role: 'render',
      deviceId: `c10b-xh-${RUN}`.padEnd(16, '0'), deviceName: 'c10-browser E6 X 独立渲染主机' }]));
    e6.xhost = await startXHost(cfgFile);
    check(e6.xhost.ready, 'E6 反方向:X(独立渲染主机)起来了', e6.xhost.lines.slice(-6));
    e6.xhostTracker = trackNodeIds(e6.xhost.origin);
    e6.xhostView = hostView(await e6.xhost.queue(), e6.xhost.lines);
    say('e6r.x-host-online', { port: e6.xhost.port, envFingerprint: e6.xhostView?.envFingerprint ?? null });
  }
}

/** E6 反方向:等这一轮的 plan 与细任务都关闭(至多 15 分钟) */
async function e6Settle() {
  const W = e6.watcher;
  const ok = await until('E6 反方向:这一轮的 plan 与细任务都关闭了', () => {
    const plans = e6.roundPlans();
    if (!plans.length || plans.some((id) => !W.tasks.get(id).closed.length)) return null;
    const ids = e6.roundIds();
    return ids.length && ids.every((id) => W.tasks.get(id).closed.length) ? true : null;
  }, 900_000, 1000);
  await delay(3000);
  await e6.yTracker?.poll();
  await e6.xhostTracker?.poll();
  return !!ok;
}

/**
 * E6 反方向的判据(文件头的 e6r:* 各条)。yIds = Y 认领 / 完成的任务 id,yFp = Y 的指纹。
 *
 * M7 D1:页面(纯浏览器节点、与 plan 同一用户)在线时,切分方给纯浏览器做得了的卡另出一份页面指纹的(`input.dual`),
 * 谁先认领这张卡的任一段谁得锁,另一份作废(`superseded`:订阅者收 task.failed、旁观者收 task.closed failed)。所以:
 *   - 这一版的细任务 = Y 自己那份(要求 Y)+ 浏览器那份(要求页面指纹、dual);
 *   - J-全完 / J-恰一 按「没被作废的」判,作废的只许是 dual 的;
 *   - X 与页面在同一台机器上时指纹相同,浏览器那份 X 本来就可以认领(同环境同产物):X-claimed-0 判的是
 *     「要求别的指纹(Y)的细任务 X 认领 0」,要求 X 自己指纹的那几份只计数;
 *   - J-纯层按卡(内容键)判:一张卡没作废的段只出自一种指纹;层表 v 3 的候选要含完成那一份的指纹。
 */
async function e6Judge({ yIds, yFp }) {
  const W = e6.watcher;
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); check(ok, `E6 反方向:${name}`, detail); };
  const plans = e6.roundPlans();
  const ids = e6.roundIds();
  const idSet = new Set(ids);
  const T = (id) => W.tasks.get(id);
  const short = (id) => String(id).slice(0, 90);
  const yClaimed = yIds?.claimed ?? [];
  const yDone = [...(yIds?.completed ?? []), ...(yIds?.dedup ?? [])];
  const xFp = state.creatorFp;
  const xhostFp = e6.xhostView?.envFingerprint ?? null;
  const pageFp = state.pageFp ?? null;
  const superseded = new Set(e6.pageDone.failed.filter((f) => f.error === 'superseded' && idSet.has(f.id)).map((f) => f.id));
  const live = ids.filter((id) => !superseded.has(id));
  const own = ids.filter((id) => T(id).fp === yFp);
  const others = ids.filter((id) => T(id).fp !== yFp);
  const xOnlineAt = Math.min(...[e6.claimer?.st.onlineAt, e6.xhost?.readyAt].filter(Number.isFinite));
  const planTaken = T(e6.planId)?.taken ?? [];
  // 1. Y 认领了页面这一版的 plan
  const byIds = yClaimed.includes(e6.planId);
  const byInference = planTaken.length > 0 && planTaken[0] < xOnlineAt && own.length > 0 && (e6.yAtPlanTaken?.claimed ?? 0) >= 1;
  add('Y-claimed-plan', plans.includes(e6.planId) && (byIds || byInference), {
    planId: short(e6.planId), watcherTaken: planTaken.length, takenBeforeX: planTaken.length > 0 ? planTaken[0] < xOnlineAt : null,
    inYHeld: byIds, yAtPlanTaken: e6.yAtPlanTaken ?? null, ownCopiesRequireY: own.length, roundPlans: plans.length,
    how: byIds ? 'Y 的持有记录里有这个 plan' : '推断:plan 被认领时只有 Y 能认领 plan(创建者已关、纯浏览器认领 plan 回 plan-profile、X 未上线),且切分方自己那份要求 Y 的指纹',
  });
  // 2. 细任务的指纹:切分方自己那份要求 Y;其余只许是 M7 D1 给页面的浏览器那份(dual、要求页面指纹)
  const byFp = {};
  for (const id of ids) { const k = `${T(id).fp ?? '(none)'}${T(id).dual ? '/dual' : ''}`; byFp[k] = (byFp[k] ?? 0) + 1; }
  add('derived-fingerprints', own.length > 0 && others.every((id) => T(id).dual && T(id).fp === pageFp), { tasks: ids.length, yFp, pageFp, byFp, badOthers: others.filter((id) => !(T(id).dual && T(id).fp === pageFp)).slice(0, 3).map(short) });
  // 3. X 上线之后这一版还有细任务完成
  const doneAt = (id) => T(id).closed.find((c) => c.state === 'done')?.at ?? null;
  const after = (at) => (at ? live.filter((id) => (doneAt(id) ?? 0) > at).length : 0);
  const online = {};
  if (e6.claimer) online.claimer = { onlineAt: e6.claimer.st.onlineAt, doneAfter: after(e6.claimer.st.onlineAt) };
  if (e6.xhost) online.host = { onlineAt: e6.xhost.readyAt, doneAfter: after(e6.xhost.readyAt) };
  add('X-online-while-work', Object.keys(online).length > 0 && Object.values(online).every((o) => o.doneAfter > 0), { ...online, tasks: live.length });
  // 4. X 对要求别的指纹(Y)的细任务认领 0;要求 X 自己指纹的(浏览器那份)只计数
  const xDetail = {};
  let xBad = 0;
  if (e6.claimer) {
    const v = e6.claimer.view();
    xDetail.claimer = { fingerprint: v.fingerprint, attempts: v.attempts, rejected: v.rejected, claimed: v.claimed.length, sameFpSkipped: v.sameFpSkipped, visibleRound: v.visibleRound, sample: v.sample };
    xBad += v.claimed.length;
  }
  let xhostDone = [];
  if (e6.xhost) {
    const view = e6.xhostTracker?.view() ?? {};
    const q = hostView(await e6.xhost.queue(), e6.xhost.lines);
    const claimedRound = (view.claimed ?? []).filter((id) => idSet.has(id));
    const claimedOther = claimedRound.filter((id) => T(id).fp !== xhostFp);
    xhostDone = [...(view.completed ?? []), ...(view.dedup ?? [])].filter((id) => idSet.has(id));
    xDetail.host = { envFingerprint: q?.envFingerprint ?? xhostFp, nodeClaimed: q?.nodes?.[0]?.claimed ?? null, claimedRound: claimedRound.length, claimedOtherFp: claimedOther.map(short).slice(0, 5), sameFpClaimed: claimedRound.length - claimedOther.length, connected: q?.nodes?.[0]?.connected ?? null };
    xBad += claimedOther.length;
  }
  add('X-claimed-0', Object.keys(xDetail).length > 0 && xBad === 0, xDetail);
  // 5. J-全完:没被作废的细任务全部 done;作废的只许是 dual 的
  const states = Object.fromEntries(live.map((id) => [id, T(id).closed.at(-1)?.state ?? T(id).state]));
  const all = judgeAllDone(live, states);
  const badSuperseded = [...superseded].filter((id) => !T(id).dual);
  add('J-all-done', all.ok && badSuperseded.length === 0, { ...all, notDone: all.notDone.slice(0, 5).map((x) => ({ ...x, id: short(x.id), fp: T(x.id)?.fp ?? null, dual: T(x.id)?.dual ?? null })), superseded: superseded.size, badSuperseded: badSuperseded.map(short) });
  // 6. J-恰一(发布方 = 成员页;plan 与没被作废的细任务)
  const once = judgeExactlyOnce([...plans, ...live], e6.pageDone.events);
  add('J-exactly-once', once.ok, { ...once, missing: once.missing.slice(0, 5).map(short), dup: once.dup.slice(0, 5) });
  // 层表(v 3:每层 contentKey、主指纹、candidates)
  let layers = null;
  try {
    const r = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${state.docId}` });
    layers = r?.type === 'content.item' && !r.missing ? { v: r.body?.v ?? null, list: r.body?.layers ?? [] } : null;
  } catch { layers = null; }
  const cardOf = new Map();
  for (const l of layers?.list ?? []) {
    const card = l.contentKey ?? l.resultKey;
    for (const c of [{ resultKey: l.resultKey, envFingerprint: l.envFingerprint }, ...(l.candidates ?? [])]) if (c?.resultKey) cardOf.set(c.resultKey, { card, layer: l });
  }
  const layerOfId = (id) => { const rk = T(id).resultKey ?? parseTaskId(id)?.resultKey ?? id; return cardOf.get(rk)?.card ?? T(id).contentKey ?? rk; };
  // 7. J-纯层:按卡汇总没被作废的细任务要求的指纹与完成它的节点的指纹(Y / X 主机按各自的认领记录;其余由页面完成,页面指纹为探针独立算的 pageFp)
  const completedBy = {};
  for (const id of yDone) if (idSet.has(id)) completedBy[id] ??= 'Y';
  for (const id of xhostDone) completedBy[id] ??= 'X';
  let inferredPage = 0;
  for (const id of live) if (!completedBy[id] && states[id] === 'done') { completedBy[id] = 'page'; inferredPage += 1; }
  const obs = layerObservations(live.map((id) => ({ id, layer: layerOfId(id), requires: { envFingerprint: T(id).fp ?? undefined } })), completedBy, { Y: yFp, X: xhostFp ?? xFp, page: pageFp }, (t) => t.layer);
  const pure = judgePureLayers(obs);
  const attributed = live.filter((id) => completedBy[id]).length;
  const byNode = {};
  for (const n of Object.values(completedBy)) byNode[n] = (byNode[n] ?? 0) + 1;
  add('J-pure-layers', pure.ok && attributed === live.length, { ...pure, mixed: pure.mixed.slice(0, 3), attributed, tasks: live.length, byNode, inferredPage });
  // 8. 层表:这一版每张卡都有一层,候选里含完成那一份的指纹
  const doneFpByCard = new Map();
  for (const id of live) if (states[id] === 'done') doneFpByCard.set(layerOfId(id), T(id).fp);
  const layerRows = (layers?.list ?? []).map((l) => ({ clip: String(l.clipId ?? '').slice(0, 14), fp: l.envFingerprint ?? null, candidates: (l.candidates ?? []).map((c) => c.envFingerprint), doneFp: doneFpByCard.get(l.contentKey ?? l.resultKey) ?? null }));
  const uncovered = [...doneFpByCard].filter(([card, fp]) => { const l = (layers?.list ?? []).find((x) => (x.contentKey ?? x.resultKey) === card); return !l || !((l.candidates ?? []).some((c) => c.envFingerprint === fp) || l.envFingerprint === fp); });
  add('layer-map-covers-done', !!layers && doneFpByCard.size > 0 && uncovered.length === 0, { v: layers?.v ?? null, cards: doneFpByCard.size, uncovered: uncovered.length, primaryAllY: layerRows.length > 0 && layerRows.every((r) => r.fp === yFp), layers: layerRows });
  // 9. X 与 Y 的指纹不同
  add('X-differs-from-Y', !!yFp && !!xFp && xFp !== yFp && (!xhostFp || xhostFp !== yFp), { yFp, xClaimerFp: e6.claimer ? xFp : null, xHostFp: xhostFp, pageFp });
  const doneByFp = {};
  for (const id of live) if (states[id] === 'done') doneByFp[T(id).fp ?? '(none)'] = (doneByFp[T(id).fp ?? '(none)'] ?? 0) + 1;
  return {
    checks, planId: short(e6.planId), roundPlans: plans.length, tasks: ids.length, live: live.length, superseded: superseded.size, doneByFp, epochs: W.epochs.length,
    y: { fp: yFp, claimedSeen: yClaimed.length, done: yDone.filter((id) => idSet.has(id)).length },
    x: xDetail, pageFp, pageDoneEvents: e6.pageDone.events.length, pageFailedEvents: e6.pageDone.failed.length,
    l18: {
      note: '只记录不判(C10 契约第 18 节第 9 条、M8 计划 L18):桌面发布的 plan 不带片段清单,requires 带发布方指纹与 preferNode;host 档认领回 plan-profile,环境不同的主机领不到',
      desktopPlans: (state.desktopPlans ?? []).length, desktopFingerprint: state.creatorFp ?? null,
      hostClaim: e6.l18.map((r) => ({ id: r.id.slice(0, 80), type: r.type, reason: r.reason, released: r.released ?? null })),
    },
  };
}
/** 外网模式:两个舞台源(--stage-origins 优先;否则 runtime-config.json;都没有就 s1./s2. 子域) */
async function resolveStageOrigins() {
  const given = arg('--stage-origins', null);
  let cfg = null;
  let why = null;
  try {
    const r = await fetch(`${SITE}/editor/runtime-config.json`, { signal: AbortSignal.timeout(15_000) });
    const ct = r.headers.get('content-type') ?? '';
    if (r.ok && /json/.test(ct)) cfg = await r.json(); else why = `status ${r.status} ${ct}`;
  } catch (e) { why = String(e?.message ?? e); }
  const fromCfg = Array.isArray(cfg?.stageOrigins) ? cfg.stageOrigins.map((o) => String(o).replace(/\/+$/, '')) : null;
  const u = new URL(SITE);
  const fallback = [`${u.protocol}//s1.${u.host}`, `${u.protocol}//s2.${u.host}`];
  const list = given ? given.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean) : (fromCfg ?? fallback);
  check(fromCfg?.length === 2, '外网:/editor/runtime-config.json 给出两个舞台源', { v: cfg?.v ?? null, stageOrigins: fromCfg, why });
  if (given && fromCfg) check(fromCfg.length === list.length && fromCfg.every((o, i) => o === list[i]), '外网:runtime-config.json 的舞台源与 --stage-origins 一致', { runtime: fromCfg, given: list });
  out.runtimeConfig = cfg ? { v: cfg.v ?? null, stageOrigins: fromCfg } : { missing: why };
  return list;
}
try {
  M = await mods();
  if (REMOTE) {
    STAGE_ORIGINS = await resolveStageOrigins();
    out.stageOrigins = STAGE_ORIGINS;
    say('site', { site: SITE, stageOrigins: STAGE_ORIGINS, role: ROLE, externalHost: EXTERNAL_HOST, noHost: NO_HOST });
  } else {
    await startLocalSite();
  }
  if (EXTERNAL_HOST && !NO_HOST) {
    xstore = await kvOf(RUN);
    await xstore.putLatest({ run: RUN, at: Date.now() }).catch((e) => fails.push(`协调口写不进 c10b.latest:${e?.message ?? e}`));
    say('run', { run: RUN, coord: COORD, hint: `另一台机器:node scripts/probes/c10-browser-probe.mjs --role host --run ${RUN}` });
  }
  const health = await getJson(`${SITE}/hosted/healthz`).catch((e) => ({ error: String(e?.message ?? e) }));
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');

  /* ---------------------------------------------------------------- 0. 创建者建项目、放云端、预渲染 */
  const t0 = Date.now();
  const sharedConfig = path.join(TMP, 'creator-shared.json');
  await startEditor(sharedConfig);
  const pre0 = await until('预渲染进程就绪', async () => { const i = await prerenderInfo(); return i?.ready && i.url ? i.url : null; }, 240_000, 500);
  if (!pre0) throw new Error('预渲染进程没起来');
  browser = await launchBrowser();
  const creatorCtx = await browser.createBrowserContext();
  const creator = await newPage(creatorCtx);
  state.creator = creator;
  await creator.goto(`${editor.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('创建者页面舞台起来', () => P(creator, () => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  await P(creator, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  const projName = `c10浏览器-${RUN}`;
  await P(creator, async (name) => { const S = await import('/src/store/project.ts'); S.actions.newProject(name); S.actions.seek(0); }, projName);
  if (VIDEO) {
    const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
    const ffmpeg = await findFfmpeg();
    const video = path.join(TMP, `c10b-${RUN}.mp4`);
    const ff = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', String(SECONDS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=c10b-${RUN}`, video], { encoding: 'utf8', windowsHide: true });
    if (ff.status !== 0) throw new Error(`ffmpeg 出样本失败:${ff.stderr}`);
    const input = await creator.$('[data-pc="library"] input[type=file]');
    if (!input) throw new Error('找不到素材库的文件输入');
    await input.uploadFile(video);
    state.media = await until('视频入库、生成小尺寸', () => P(creator, async (fname) => {
      const S = await import('/src/store/project.ts');
      const m = S.getState().project.media.find((x) => x.name === fname && x.hash && x.tiers?.original && x.tiers?.small);
      return m ? { id: m.id, original: m.tiers.original, small: m.tiers.small } : null;
    }, path.basename(video)), 240_000, 500);
    if (!state.media) throw new Error('视频没入库');
  }
  const clips = await P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    if (spec.mediaId) S.actions.addMediaClip(spec.mediaId, 0, { duration: spec.seconds });
    const light = S.actions.addClipOnNewTrack({ index: 0, cardId: 'chapter-bar', start: 8, duration: 2 });
    // 独立的轻卡:测量的快照趟会推出探针帧(验「大块产出压成可转移的 ArrayBuffer」)
    S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-typewriter', start: 0, duration: 2 });
    // 打字机在快 PC 上整段追帧能落进 (a) 档，不能假定它会经过播放态互换的 (b) 档。
    // 另放一张较长的推帧卡；其它轻卡不与它重叠，避免 K2 按位置贪心把跳转夹具挤成重卡。
    // 0～1 秒的九重卡压力、主重卡和十秒播放保持；核对实测档位与实际轻管线，不改成本或阈值。
    const playEntry = S.actions.addClipOnNewTrack({ index: 0, cardId: 'chapter-bar', start: 2, duration: 6 });
    const main = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: spec.seconds });
    S.actions.setClipParams(main.id, { burnMs: 40, label: 'main' });
    const extras = [];
    for (let i = 0; i < spec.extra; i++) {
      const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: 1 });
      /*
       * padNodes:把这一层的快照做到约 70 KB(swap-tuning:在线换帧成本按快照大小估,`0.8 + 0.04 × KB` ≈ 3.6 ms;
       * 原来这几层快照约 12 KB、只有 1.3 ms,9 层加起来装得下一拍,A4 的「装不下显示占位」就验不到了)。
       * 9 层 ≈ 1.3 + 8 × 3.6 ms > 23.3 ms:装得下 7 层、2 层占位,与改之前按一律 3 ms 算的一样。
       */
      S.actions.setClipParams(c.id, { burnMs: 40, label: 'x', padNodes: 60 });
      extras.push(c.id);
    }
    // --user-card:一张仓库用户卡(在线页面跑不了它的代码,只能贴渲染节点的产物)
    const user = spec.userCard ? S.actions.addClipOnNewTrack({ index: 0, cardId: 'mu-animated-shiny-text', start: 0, duration: spec.seconds }) : null;
    S.actions.seek(1);
    return { light: light?.id ?? null, playEntry: playEntry?.id ?? null, main: main?.id ?? null, extras, userClip: user?.id ?? null };
  }, { mediaId: state.media?.id ?? null, seconds: SECONDS, extra: EXTRA_HEAVY, userCard: USER_CARD });
  Object.assign(state, clips);
  check(state.main && state.extras.length === EXTRA_HEAVY, '创建者放好卡片', clips);
  state.docId = await P(creator, async () => (await import('/src/store/project.ts')).getState().project.id);
  await until('创建者页面测量测完', async () => P(creator, async () => { const R = await import('/src/editor/probeRunner.ts'); return !R.probeProgress().running && !document.querySelector('[data-pc="probe-gate"]'); }), 300_000, 500);
  // 放云端
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  // 创建者用户名的缺省值(设备名)是异步填的:等它填上;填不上就自己写一个(不然提交时报「创建者用户名和密码不能为空」)
  const nameFilled = await until('创建者用户名的缺省值填上', () => creator.$eval('#pc-collab-creator', (i) => i.value.trim()).catch(() => ''), 10_000, 200);
  if (!nameFilled) { fails.pop(); await typeInto(creator, '#pc-collab-creator', `c10b-creator-${RUN}`.slice(0, 32)); }
  const creatorCred = { username: await creator.$eval('#pc-collab-creator', (i) => i.value), password: await creator.$eval('#pc-collab-cpw', (i) => i.value) };
  state.creatorCred = creatorCred;
  state.projectPassword = await creator.$eval('#pc-collab-ppw', (i) => i.value);
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', HOSTED);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const enabled = await until('放云端开启完成', async () => { const t = await textOf(creator, '[data-pc="collab-status"]'); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  check(enabled?.includes('多用户协作已开启。'), '创建者开启「多用户协作」放云端', { status: enabled });
  await creator.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  state.link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  await creator.keyboard.press('Escape');
  const found = await M.lookupProject({ base: HOSTED, name: projName });
  state.projectId = found.projectId;
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: creatorCred.username, password: creatorCred.password,
    as: 'creator', role: 'render', deviceId: `c10b-node-${RUN}`.padEnd(16, '0'), deviceName: 'c10-browser 渲染节点' }]));
  const oldPid = pidOnPort(Number(new URL(pre0).port));
  killTree(oldPid);
  await until('预渲染进程重启、就绪', async () => { const i = await prerenderInfo(); return i?.ready && i.url && i.url !== pre0 ? i.url : null; }, 180_000, 500);
  const q0 = await until('创建者的渲染节点连上托管端', async () => { const q = await diag(); return q?.active ? q : null; }, 180_000, 1000);
  state.creatorFp = q0?.envFingerprint ?? null;
  conn = await openConn(M, { url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: creatorCred.username, password: creatorCred.password, as: 'creator' });
  // 层表 v 2:主重卡那一层带 contentKey、envFingerprint,各段清单的原尺寸齐
  const layer0 = await until('层表 v 2 列着主重卡、各段原尺寸齐', async () => {
    const r = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${state.docId}` });
    if (r?.type !== 'content.item' || r.missing) return null;
    const l = (r.body?.layers ?? []).find((x) => x.clipId === state.main);
    const ex = (r.body?.layers ?? []).filter((x) => state.extras.includes(x.clipId));
    if (!l || ex.length < EXTRA_HEAVY) return null;
    let frames = 0;
    for (let from = 0; from < l.count; from += r.body.span) {
      const m = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `${l.resultKey}:${from}-${Math.min(l.count - 1, from + r.body.span - 1)}` });
      if (m?.type !== 'content.item' || m.missing) return null;
      frames += (m.body?.frames ?? []).length;
    }
    return frames === l.count ? { v: r.body.v, contentKey: !!l.contentKey, envFingerprint: l.envFingerprint, resultKey: l.resultKey, count: l.count, extras: ex.length } : null;
  }, 1_200_000, 3000);
  // M7 D12 起层表是 v 3(v 2 加每层的 candidates),普通档 v 2、v 3 都认
  check(layer0?.v >= 2 && layer0.contentKey && layer0.envFingerprint, '层表 v 2 或 v 3,重层带 contentKey 与 envFingerprint', layer0);
  check(layer0 && layer0.envFingerprint === state.creatorFp, '层的产出环境 = 创建者节点的指纹', { layer: layer0?.envFingerprint, node: state.creatorFp });
  state.layer0 = layer0;
  out.steps.creator = { ms: Date.now() - t0, projectId: state.projectId, clips: { main: state.main, extras: state.extras.length, light: state.light }, creatorFp: state.creatorFp, layer: layer0 };
  say('step0.done', out.steps.creator);

  /* ---------------------------------------------------------------- 1. 成员(电脑浏览器,普通档)凭邀请链接进入 */
  const t1 = Date.now();
  const memberCtx = await browser.createBrowserContext();
  const member = await newPage(memberCtx);
  state.member = member;
  docHeaders.length = 0;
  await member.goto(`${EDITOR}#invite=${codeOf(state.link)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await member.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
  await typeInto(member, '[data-pc="join-username"]', '电脑成员');
  await member.click('[data-pc="join-submit"]');
  if (!check(await waitMembers(member).then(() => true, () => false), '成员凭邀请链接进入', { message: await joinMessage(member) })) throw new Error('成员没进去');
  // A2 第一句:首次打开在加载遮罩下测完
  let gateSeen = false;
  const gateDone = await until('成员页的加载遮罩出现又退下(测完)', async () => {
    const g = await P(member, () => !!document.querySelector('[data-pc="probe-gate"]'));
    if (g) gateSeen = true;
    const d = await previewDiag(member);
    return gateSeen && !g && d?.dual ? true : null;
  }, 300_000, 200);
  check(gateSeen && gateDone, 'A2:首次打开在加载遮罩下测完才进入编辑', { gateSeen });
  const costs1 = await l2Counts(member);
  check(costs1?.costs > 0, 'A2:L2 有 costs(成本记录以 mode=build 进 L2)', costs1);
  const costMode = await P(member, () => new Promise((resolve) => {
    const r = indexedDB.open('promptcut-l2');
    r.onsuccess = () => { const q = r.result.transaction('costs').objectStore('costs').getAll(); q.onsuccess = () => { resolve(q.result.map((x) => x.record?.mode)); r.result.close(); }; };
    r.onerror = () => resolve(null);
  })).catch(() => null);
  check(Array.isArray(costMode) && costMode.length && costMode.every((m) => m === 'build'), 'A2:成本记录 mode=build', costMode);
  const entryRecord = await P(member, (clipId) => new Promise((resolve) => {
    const job = window.__pcPreviewDiag?.()?.probeRun?.probed?.find((j) => j.clipId === clipId);
    const r = indexedDB.open('promptcut-l2');
    r.onsuccess = () => { const db = r.result; const q = db.transaction('costs').objectStore('costs').getAll(); q.onsuccess = () => { resolve(q.result.find((x) => x.record?.identityKey === job?.identityKey)?.record ?? null); db.close(); }; };
    r.onerror = () => resolve(null);
  }), state.playEntry);
  const entryWeight = entryRecord ? clipWeight(entryRecord, 'stateful', FPS) : null;
  out.steps.playEntryFixture = { cardId: 'chapter-bar', start: 2, duration: 6, stepMs: entryRecord?.stepMs ?? null, catchUpMs: entryRecord?.catchUpMs ?? null, vtOk: entryRecord?.vtOk ?? null, tier: entryWeight?.tier ?? null };
  check(entryRecord?.vtOk === false && entryWeight?.tier === 'catchup-b', '任务 C 夹具:实际测量为 (b) 档且 vtOk=false', out.steps.playEntryFixture);
  const entryPipeline = await until('任务 C 夹具在 3 秒实际判轻', async () => {
    const f = await frontFrame(member);
    return f?.evaluate(id => window.__pcStagePipelineAt?.(id, 3) === 'light', state.playEntry).catch(() => false);
  }, 15_000, 100);
  out.steps.playEntryFixture.pipelineAt3 = entryPipeline === true ? 'light' : 'not-confirmed';
  check(entryPipeline === true, '任务 C 夹具:3 秒处的实际舞台管线为轻卡', out.steps.playEntryFixture);
  // 第 3 节 + 第 18 节第 7 条(集成接线):在线普通档测完的记录当场转写进文档服务(onCostRecords → publishSharedCosts)
  // 等在途的转写都回了(calls = ok + failed)、条数够了再判;只看 ok > 0 会在外网延迟下读到还在途的那一条
  const costPublish = await until('成员页测完的成本记录写进了文档服务', () => P(member, (costs) => { const d = window.__pcCostPublish?.(); return d && d.calls > 0 && d.ok + d.failed === d.calls && d.records >= costs ? d : null; }, costs1?.costs ?? 0), 30_000, 500);
  check(costPublish && costPublish.failed === 0 && costPublish.records >= costs1?.costs, '第 3 节:在线普通档测完写进文档服务(当场转写,没有失败)', { publish: costPublish, relay: await P(member, () => window.__pcSharedCosts?.() ?? null).catch(() => null) });
  state.costPublish = costPublish;

  // A1:两个舞台同站跨源、带 OAC
  const d1 = await previewDiag(member);
  const frames = await P(member, () => [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || '').filter((s) => /[?&]stage=1/.test(s)));
  const origins = frames.map((s) => { try { return new URL(s).origin; } catch { return null; } });
  check(d1?.dual === true && frames.length === 2, 'A1:普通档开两个舞台', { dual: d1?.dual, frames: frames.length, stages: d1?.onlineStages });
  check(origins.includes(STAGE_ORIGINS[0]) && origins.includes(STAGE_ORIGINS[1]) && !origins.includes(SITE), 'A1:两个舞台与编辑器页同站跨源(各用一个源)', origins);
  const editorDoc = docHeaders.find((h) => h.origin === SITE && !h.stage);
  const stageDocs = docHeaders.filter((h) => h.stage);
  check(editorDoc?.oac === '?1' && stageDocs.length >= 2 && stageDocs.every((h) => h.oac === '?1'), 'A1:编辑器页与两个舞台页都带 Origin-Agent-Cluster: ?1', { editor: editorDoc, stages: stageDocs });
  const cdp = await member.createCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const iframeTargets = targetInfos.filter((t) => t.type === 'iframe').map((t) => new URL(t.url).origin);
  check(STAGE_ORIGINS.every((o) => iframeTargets.includes(o)), 'A1:两个舞台各成独立的 iframe 目标(进了独立进程)', iframeTargets);
  const caps = d1?.hostCaps ?? {};
  check(['A', 'B'].every((id) => caps[id]?.measure === true && caps[id]?.catchUp === true && caps[id]?.prerender === false && caps[id]?.lowMemory === false),
    'A1:宿主能力表照实报(能测量、能追活渲,prerender 为假)', caps);
  state.pageFp = await P(member, () => {
    const c = document.createElement('canvas').getContext('webgl');
    const ext = c?.getExtension('WEBGL_debug_renderer_info');
    return { platform: navigator.platform, renderer: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '', vendor: ext ? c.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '', ua: navigator.userAgent };
  }).then((e) => M.describeEnvironment({ platform: e.platform, renderer: e.renderer, vendor: e.vendor, chromeVersion: e.ua }).fingerprint).catch(() => null);

  // A3:普通档取原尺寸
  const ready = await until('成员页主重卡的原尺寸就绪(层表 v 2 / v 3、snap/ 进 L2)', async () => {
    const o = await onlineDiag(member);
    const l = o?.layers?.find((x) => x.clipId === state.main);
    return o?.tier === 'original' && o.mapVersion >= 2 && l && l.ready > 0 ? { o, l } : null;
  }, 180_000, 1000);
  check(ready, 'A3:在线来源取原尺寸一档,主重卡有就绪区间', ready?.l);
  await member.bringToFront();
  await P(member, () => { const s = window.__pcStore; s.actions.seek(0); });
  await delay(4000);
  const snapBeforePlay = new Set(member.assets.filter((a) => a.ns === 'snap').map((a) => a.hash));

  // A1:播放含重卡的 10 秒时间轴:主文档长任务 0,重层按拍换快照
  await P(member, () => { window.__pcLongTasks.length = 0; });
  const beatBefore = (await previewDiag(member))?.beatSwap ?? {};
  // 任务 C(swap-tuning):播放前记下播放态互换的发起判断,播完核「自然进场不发起」
  const entryBefore = (await previewDiag(member))?.swapPlaying ?? null;
  await P(member, () => { const s = window.__pcStore; s.actions.seek(0); s.actions.play(); });
  const samples = [];
  let placeholderSeen = null;
  const tPlay = Date.now();
  while (Date.now() - tPlay < 11_500) {
    const x = await stageSample(member);
    const d = await previewDiag(member);
    if (x) samples.push({ ...x, beat: d?.beatSwap?.last ?? null });
    if (!placeholderSeen && x && x.t < 1 && d?.beatSwap?.last?.placeholder?.length) {
      const ids = d.beatSwap.last.placeholder;
      const shown = x.wraps.filter((w) => ids.includes(w.id) && w.placeholder && !w.plane);
      if (shown.length) { placeholderSeen = { t: x.t, fit: d.beatSwap.last.fit, deadMs: d.beatSwap.last.deadMs, placeholder: ids, shown: shown.map((w) => w.id) }; await shot(member, 'a4-placeholder-while-playing'); }
    }
    await delay(150);
  }
  const longTasks = await P(member, () => window.__pcLongTasks.slice());
  const beatAfter = (await previewDiag(member))?.beatSwap ?? {};
  {
    /*
     * 任务 C(swap-tuning):从 0 秒连续播放,夹具轻卡(入点 2 秒、实测 (b) 档、vtOk = false)逐拍自然进场,
     * 不该发起播放态互换,也不该走估时(以前在它的入点附近估一次、记 skip-rate)。起播那一刻已经挂着的卡(入点 0)照旧走估时,只报不判。
     */
    const sp = (await previewDiag(member))?.swapPlaying ?? null;
    const beforeAt = entryBefore?.lastPlan?.at ?? -1;
    const plansInPlay = (sp?.plans ?? []).filter((x) => x.at > beforeAt);
    const entryPlanned = plansInPlay.filter((x) => (x.ids ?? []).includes(state.playEntry));
    out.steps.playEntry = { natural: { clip: state.playEntry, naturalSkipped: sp?.naturalSkipped ?? null, naturalSkips: sp?.naturalSkips ?? null, playRun: sp?.playRun ?? null,
      plansInPlay: plansInPlay.map((x) => ({ t: x.t, ids: x.ids, ok: x.ok, reason: x.reason ?? null })) } };
    check(state.playEntry && (sp?.naturalSkipped ?? []).includes(state.playEntry) && entryPlanned.length === 0 && sp?.playRun?.breaks === 0,
      '任务 C:从 0 秒连续播放,自然进场的 (b) 档轻卡不发起播放态互换、不走估时(拍序号连续、没有断开)', out.steps.playEntry.natural);
  }
  const playing = samples.filter((s) => s.playing);
  const mainSigs = playing.filter((s) => s.t >= 1).map((s) => s.wraps.find((w) => w.id === state.main)).filter((w) => w?.suppressed && w.plane).map((w) => w.planeSig);
  const worstLong = longTasks.slice().sort((a, b) => b.ms - a.ms).slice(0, 3);
  check(longTasks.length === 0, 'A1:播放 10 秒,主文档长任务 0', { count: longTasks.length, worst: worstLong });
  check(playing.length >= 10, 'A1:播放中采到可见舞台的样子', { samples: samples.length, playing: playing.length });
  check(new Set(mainSigs).size >= 5, 'A1:重层按拍换快照(播放中主重卡的快照平面一直在换帧)', { distinct: new Set(mainSigs).size, of: mainSigs.length });
  const deliveries = (beatAfter.deliveries ?? 0) - (beatBefore.deliveries ?? 0);
  check(deliveries >= 100 && (beatAfter.underThrottle ?? 0) > (beatBefore.underThrottle ?? 0), 'A1/L4:播放中每拍投递、不受 33 ms 节流', { deliveries, underThrottle: (beatAfter.underThrottle ?? 0) - (beatBefore.underThrottle ?? 0) });
  // A4:装不下的层显示占位
  check(placeholderSeen, 'A4:换帧预算装不下的层显示占位(0～1 秒 9 张重卡)', placeholderSeen ?? samples.filter((s) => s.t < 1).slice(0, 2).map((s) => ({ t: s.t, beat: s.beat })));
  out.steps.play = { ms: Date.now() - t1, longTasks: longTasks.length, samples: samples.length, mainDistinctFrames: new Set(mainSigs).size, deliveries, placeholder: placeholderSeen };

  // A4:暂停后追到精确活渲,占位撤下后不再盖回
  await until('播放到头停下', () => P(member, () => !window.__pcStore.getState().playing), 20_000, 300);
  const stopAt = await P(member, () => Math.round(performance.now()));
  await P(member, () => window.__pcStore.actions.seek(0.5));
  const seekAt = await P(member, () => Math.round(performance.now()));
  const settled = await until('暂停后 0.5 秒处追到精确活渲(重层不抑制、没有快照平面、没有占位)', async () => {
    const x = await stageSample(member);
    if (!x || x.playing) return null;
    const heavy = x.wraps.filter((w) => w.id === state.main || state.extras.includes(w.id));
    return heavy.length >= EXTRA_HEAVY + 1 && heavy.every((w) => !w.suppressed && !w.plane && !w.placeholder && !w.settling) ? x : null;
  }, 120_000, 500);
  check(settled, 'A4:暂停后追到精确活渲(与桌面同判据:停下就撤兜底)');
  // 排障:--hold-min N 在这里停 N 分钟,浏览器的调试地址写在 stderr(puppeteer.connect 连上去看)
  if (Number(arg('--hold-min', 0)) > 0) { say('hold', { minutes: Number(arg('--hold-min', 0)), ws: browser.wsEndpoint() }); await delay(Number(arg('--hold-min', 0)) * 60_000); }
  if (!settled) {
    const pdx = await previewDiag(member);
    out.steps.settleDiag = {
      preview: { swapInFlight: pdx?.swapInFlight, swapLog: pdx?.swapLog, swapTrace: pdx?.swapTrace, setTimeLog: pdx?.setTimeLog, setTimeError: pdx?.setTimeError, backWork: pdx?.backWork, frontId: pdx?.frontId, feedSettled: pdx?.snapshotFeed?.settled, settledAll: pdx?.snapshotFeed?.settledAll, settledLog: pdx?.snapshotFeed?.settledLog, mounted: pdx?.snapshotFeed?.mounted?.length, heavy: pdx?.snapshotFeed?.heavy?.length },
      stages: await Promise.all(member.frames().filter((f) => /[?&]stage=1/.test(f.url())).map((f) => f.evaluate(() => { const d = window.__pcStageDiag?.() ?? {}; return { id: new URLSearchParams(location.search).get('id'), role: d.role, job: d.job, t: d.t, settling: d.settling, suppressed: d.suppressed, snapshots: d.snapshots, catchUps: d.catchUps, beatRunning: d.beatRunning }; }).catch((e) => String(e)))),
      costs: await P(member, () => new Promise((resolve) => { const r = indexedDB.open('promptcut-l2'); r.onsuccess = () => { const q = r.result.transaction('costs').objectStore('costs').getAll(); q.onsuccess = () => { resolve(q.result.map((x) => ({ k: x.record?.identityKey?.slice(0, 10), step: x.record?.stepMs, capped: x.record?.capped, vtOk: x.record?.vtOk, seekOk: x.record?.seekOk, kind: x.record?.kind }))); r.result.close(); }; }; r.onerror = () => resolve(null); })).catch(() => null),
    };
  }
  out.steps.settleTrace = (await previewDiag(member))?.swapTrace ?? null;
  {
    // 「点停到精确活渲」:点到 0.5 秒(页面 performance.now)到 0.5 秒那次暂停态互换做完(swapLog 的 at)
    const pdx = await previewDiag(member);
    const done = (pdx?.swapLog ?? []).find((e) => Math.abs(e.t - 0.5) < 1e-6 && e.swapped && e.at >= seekAt);
    // 播放态互换估时用到的成本记录(按身份键去重;排障看速率 / 积压对不对得上实测)
    const costs = await P(member, () => new Promise((resolve) => { const r = indexedDB.open('promptcut-l2'); r.onsuccess = () => { const q = r.result.transaction('costs').objectStore('costs').getAll(); q.onsuccess = () => { resolve(q.result.map((x) => ({ k: x.record?.identityKey?.slice(0, 10), step: x.record?.stepMs, stepMax: x.record?.stepMaxMs, catchUp: x.record?.catchUpMs, capped: x.record?.capped, vtOk: x.record?.vtOk, kind: x.record?.kind }))); r.result.close(); }; }; r.onerror = () => resolve(null); })).catch(() => null);
    out.steps.settleTiming = { stopAt, seekAt, swappedAt: done?.at ?? null, seekToPreciseMs: done ? done.at - seekAt : null, swapPlaying: pdx?.swapPlaying ?? null, costs };
    say('a4.timing', out.steps.settleTiming);
  }
  await shot(member, 'a4-settled-live');
  await delay(3000);
  const stillLive = await stageSample(member);
  check(stillLive && stillLive.wraps.filter((w) => w.id === state.main || state.extras.includes(w.id)).every((w) => !w.suppressed && !w.plane && !w.placeholder),
    'A4:占位撤下后不再盖回(3 秒后仍是活渲)', stillLive?.wraps?.slice(0, 4));
  {
    // 任务 C(swap-tuning):跳到夹具轻卡中间(3 秒)再播，照旧交给估时。
    const before = (await previewDiag(member))?.swapPlaying ?? null;
    const seekAt3 = await P(member, () => { window.__pcStore.actions.seek(3); return Math.round(performance.now()); });
    // 等 3 秒处的暂停态第二路做完再播(它跑着时父页不判播放态互换:`swapInFlight`)
    await until('跳到 3 秒后暂停态第二路做完', async () => {
      const d = await previewDiag(member);
      return d && !d.swapInFlight && (d.swapLog ?? []).some((e) => Math.abs(e.t - 3) < 1e-6 && e.at >= seekAt3) ? true : null;
    }, 90_000, 300);
    await P(member, () => window.__pcStore.actions.play());
    const seekPlan = await until('跳到卡中间再播:第一拍附近走估时', async () => {
      const sp = (await previewDiag(member))?.swapPlaying ?? null;
      const lp = (sp?.plans ?? []).find((x) => x.at > (before?.lastPlan?.at ?? -1) && (x.ids ?? []).includes(state.playEntry));
      return lp && lp.t >= 3 && lp.t < 3.5 ? { ...sp, lastPlan: lp } : null;
    }, 5_000, 100);
    await P(member, () => window.__pcStore.actions.pause());
    await until('停下', () => P(member, () => !window.__pcStore.getState().playing), 5_000, 100);
    out.steps.playEntry = { ...(out.steps.playEntry ?? {}), seekMiddle: { lastPlan: seekPlan?.lastPlan ?? null, playRun: seekPlan?.playRun ?? null, naturalSkips: seekPlan?.naturalSkips ?? null } };
    check(seekPlan, '任务 C:跳到卡中间再播,夹具轻卡照旧按估时决定(发起判断的 t 在 3～3.5 秒)', out.steps.playEntry.seekMiddle);
    say('play-entry', out.steps.playEntry);
  }
  const pd = await previewDiag(member);
  out.steps.settle = { settled: !!settled, stillLive: !!stillLive, feedSettled: pd?.snapshotFeed?.settled?.length ?? null, backWork: pd?.backWork, probeFrames: pd?.probeFrames };
  check(pd?.probeFrames?.gzFrames > 0 && pd.probeFrames.htmlBytes === 0, 'A1/第 2 节:后台舞台的探针帧压成可转移的 ArrayBuffer 交出', pd?.probeFrames);
  check(pd?.backWork?.sent > 0 && pd.backWork.on === true, '第 2 节:后台活由父页判空闲经 RPC 发开始 / 停止', pd?.backWork);

  // A3:网络记录
  const sum1 = assetSummary(member.assets);
  check(sum1.snap > 0 && sum1.px === 0, 'A3:普通档取 snap/ 原尺寸、预渲染小尺寸请求 0', sum1);
  if (VIDEO) check(Object.keys(sum1.mediaByFrameOrigin).some((k) => STAGE_ORIGINS.some((o) => k === `${o}→${o}`)) && !Object.keys(sum1.mediaByFrameOrigin).some((k) => STAGE_ORIGINS.some((o) => k.startsWith(`${o}→`) && !k.endsWith(o))),
    '第 2 节(2026-10-06 隔离后):跨源舞台用相对地址读自己源上的 /media-s/<会话号>/media/<哈希>(不再是 /media)', sum1.mediaByFrameOrigin);
  if (VIDEO) check(member.assets.some((a) => a.route === 'media-s') && !member.assets.some((a) => a.hasTicket), '第 2 节(2026-10-06 隔离后):舞台取素材的地址里没有票据(?t=),票据在舞台读不到的 cookie 里', { mediaS: member.assets.filter((a) => a.route === 'media-s').length });
  const o3 = await onlineDiag(member);
  // 2026-10-06 起:本页能运行的仓库用户卡的任务,成员页自己的后台舞台(纯浏览器节点)也认领,它的那一层出自浏览器环境(cardEnvFingerprint),与桌面节点的环境本来就不同;每一层仍只出自一种环境。内置卡的层仍都出自创建者的桌面节点
  check(o3?.layers?.length && o3.layers.filter((l) => l.clipId !== state.userClip).every((l) => l.envFingerprint === state.creatorFp), 'A3:一层只出自一种环境(层表记录的那一种;仓库用户卡那一层另论:它可能出自成员页自己的浏览器节点)', o3?.layers?.map((l) => ({ clip: l.clipId.slice(0, 6), fp: l.envFingerprint })));
  out.steps.member = { ms: Date.now() - t1, stages: origins, iframeTargets, caps, requests: sum1, l2: costs1, pageFp: state.pageFp, costPublish: state.costPublish,
    publisher: await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null) };
  say('step1.done', out.steps.member);

  if (USER_CARD) {
    /* ---------------------------------------------------------------- 用户卡端到端(C10 契约第 9 节,2026-09-29 用户改语义) */
    const tU = Date.now();
    check(!!state.userClip, '用户卡:创建者放好了用户卡片段', state.userClip);
    /*
     * 新语义(2026-10-06,契约 11.3 的 1757、1776~1777 两处):仓库用户卡在在线页面里本页能运行,与内置卡一样按轻重区分。
     * 成员页进来时在加载遮罩下已把它测完;判轻的卡在可见舞台里直接活渲、不进页面发布的清单计划、时间轴不挂徽标。
     * 旧断言「清单计划含它」「桌面渲染节点渲出来、成员页贴上快照、那一层出自创建者的桌面节点」说的是判重那条路,在这里不再成立。
     */
    const userStage = async () => {
      const f = await frontFrame(member);
      return f ? f.evaluate((id) => {
        const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
        const slot = w?.querySelector(':scope > [data-pc-placeholder-slot]');
        const plane = w?.querySelector(':scope > [data-pc-snapshot-plane]');
        const liveChildren = w ? [...w.children].filter((c) => !c.matches('[data-pc-placeholder-slot],[data-pc-snapshot-plane]')) : [];
        return w ? { snapshot: !!plane && plane.childElementCount > 0, placeholder: !!slot && !slot.hidden, reason: slot?.getAttribute('data-pc-placeholder-reason') ?? null,
          // 活组件的子树露着才算 live:包裹层带着「贴快照 / 抑制 / 等快照 / 追帧」任何一个类时子树是藏起来的(`planeStyle.ts`)
          live: !['pc-snapshot', 'pc-suppressed', 'pc-awaiting', 'pc-settling'].some((c) => w.classList.contains(c)) && liveChildren.some((c) => (c.textContent ?? '').trim().length > 0), text: liveChildren.map((c) => (c.textContent ?? '').trim()).join('|').slice(0, 40) } : null;
      }, state.userClip).catch(() => null) : null;
    };
    const badgeOf = () => P(member, (id) => !!document.querySelector(`[data-clip-id="${id}"] [data-pc="clip-custom-card"]`), state.userClip).catch(() => null);
    await P(member, () => { const s2 = window.__pcStore; s2.actions.seek(1); });
    /*
     * 先看它在不在成员页发布的清单计划里,再决定断言哪一路(2026-10-07 改:以前「直接活渲、没有快照」那一条不分路、先断言)。
     * 这个探针的项目里,用户卡与主重卡加若干张额外重卡叠在同一段时间上:每张重卡每拍都要计一份换帧的固定成本,加起来就超出一拍的预算,
     * 轻卡在这个位置被挤出轻管线(K2 逐位置贪心,`pipelinePlan.mjs`)——它自己的成本记录是轻的(实测 stepMs 0.3、seekOk),
     * 但整段进预渲染集合、由渲染节点渲出、舞台贴快照。这台 PC 上第二段合并提交(21b02329)与四段合流后连跑都是这一路(清单计划 12 张卡全在)。
     * 判重的一路舞台贴着快照是对的,旧的不分路断言把它判成了不过。判轻直接活渲那一路由 `online-user-cards-probe.mjs` 与
     * `online-card-exec-probe.mjs` 验(那里的项目不拥挤)。
     */
    const planU0 = await until('用户卡:成员页发布了清单计划', async () => { const d = await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null); return d?.lastClips?.length ? d : null; }, 60_000, 1000);
    const inPlanFirst = !!planU0?.lastClips?.includes(state.userClip);
    const liveU = inPlanFirst ? null : await until('用户卡:成员页在可见舞台里直接活渲仓库用户卡(判轻),没有快照与图标', async () => {
      await P(member, () => { const s2 = window.__pcStore; s2.actions.seek(1); }).catch(() => {});
      const st = await userStage();
      return st?.live && !st.snapshot && !st.placeholder ? st : null;
    }, 120_000, 1000);
    const lastU = { stage: await userStage(), badge: await badgeOf() };
    lastU.diag = await P(member, (id) => { const d = window.__pcPreviewDiag?.(); const j = d?.probeRun?.probed?.filter((x) => x.clipId === id) ?? []; return { probedN: j.length, identityKey: j.at(-1)?.identityKey ?? null, suppressed: (d?.suppressed ?? []).includes(id), pending: d?.probeRun?.running ?? null }; }, state.userClip).catch(() => null);
    lastU.layer = (await onlineDiag(member))?.layers?.find((x) => x.clipId === state.userClip) ?? null;
    // 排障:这张卡在本页的成本记录(判轻判重的依据),按身份键从 L2 里取
    lastU.cost = await P(member, (key) => new Promise((resolve) => {
      if (!key) { resolve(null); return; }
      const r = indexedDB.open('promptcut-l2');
      r.onsuccess = () => { const q = r.result.transaction('costs').objectStore('costs').getAll(); q.onsuccess = () => { resolve(q.result.filter((x) => JSON.stringify(x).includes(key)).map((x) => JSON.stringify(x.record ?? x).slice(0, 500))); r.result.close(); }; q.onerror = () => resolve(null); };
      r.onerror = () => resolve(null);
    }), lastU.diag?.identityKey ?? null).catch(() => null);
    if (!inPlanFirst) check(!!liveU, '用户卡(新语义,判轻的一路):成员页在可见舞台里直接看得到仓库用户卡的活画面(没有快照、没有「需要本地 PC 渲染辅助」图标)', { liveU, last: lastU });
    check(lastU.badge === false, '用户卡(新语义):时间轴上它没有「需要本地 PC 渲染辅助」徽标', lastU);
    const planU = await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
    /*
     * 页面按测量结果给这张卡定轻重:判轻的不进清单计划(上面已断言活渲、没有图标与徽标);判重的与内置重卡同一条路 ——
     * 进清单计划、由创建者的桌面渲染节点渲出来写进层表、成员页贴上快照。两条路都要成立,走哪一条看这台机器上它的实测结果(本机忙闲会让同一张卡落在两边),
     * 所以按「它在不在清单计划里」分流断言。
     */
    const inPlan = !!planU?.lastClips?.includes(state.userClip);
    lastU.inPlan = inPlan;
    if (!inPlan) {
      check(true, '用户卡(新语义):判轻的仓库用户卡不在成员页发布的清单计划里(不进预渲染集合)', planU?.lastClips);
    } else {
      const gotU = await until('用户卡(在清单计划里的一路):渲染节点把它渲出来写进层表(出自桌面节点或成员页自己的浏览器节点),图标与徽标始终没有', async () => {
        await P(member, () => { window.__pcStore.actions.seek(1); }).catch(() => {});
        const o = await onlineDiag(member);
        const l = o?.layers?.find((x) => x.clipId === state.userClip);
        const st = await userStage();
        return l && l.ready > 0 && (st?.snapshot || st?.live) && !st.placeholder && (await badgeOf()) === false ? { layer: l, stage: st } : null;
      }, 420_000, 5000);
      check(!!gotU, '用户卡(在清单计划里的一路):渲染节点渲出、层表里有这一层(就绪帧 > 0),舞台上是快照或活画面,没有图标与徽标', { gotU, plan: planU?.lastClips?.length, last: { stage: await userStage(), layer: (await onlineDiag(member))?.layers?.find((x) => x.clipId === state.userClip) ?? null } });
      if (gotU) check(!!gotU.layer.envFingerprint, '用户卡(在清单计划里的一路):那一层记着它的环境指纹(创建者的桌面节点是 ' + state.creatorFp + ',成员页自己的浏览器节点是它的 cardEnvFingerprint,两者都合法)', { layer: gotU.layer.envFingerprint, creator: state.creatorFp });
    }
    await shot(member, 'user-card-live');
    out.steps.userCard = { ms: Date.now() - tU, clip: state.userClip, planClips: planU?.lastClips ?? null, live: liveU, last: lastU };
    say('user-card.done', out.steps.userCard);
  }

  if (A10) {
    /* ---------------------------------------------------------------- A10. 逐帧导出跨过票据时限 */
    const t10 = Date.now();
    const frames10 = Number(arg('--export-frames', SECONDS * FPS));
    /*
     * 导出前核对要所有重卡的原尺寸齐(每段清单盖满);创建者此时可能还在补齐主重卡的后几段。
     * 核对没过(提示「没有预渲染原尺寸」、导出被取消)就等 15 秒再导,至多 15 分钟;用最后那一次的结果判。
     */
    let exported = null;
    let originalsWaits = 0;
    const tWait = Date.now();
    for (;;) {
      exported = await P(member, async (n) => {
        const t = performance.now();
        const r = await window.__pcIo.exportVideoBrowser({ maxFrames: n, originals: true });
        return { ms: performance.now() - t, frames: r.result?.frames ?? null, error: r.error ?? null, waits: r.waits, renewal: r.renewal ?? null, stats: r.result?.stats ?? null };
      }, frames10);
      const missing = exported?.frames == null && (exported?.waits ?? []).some((w) => /没有预渲染原尺寸/.test(String(w)));
      if (!missing || Date.now() - tWait > 900_000) break;
      originalsWaits++;
      say('a10.wait-originals', { tries: originalsWaits, waits: exported.waits?.length ?? 0 });
      await delay(15_000);
    }
    check(exported?.frames === frames10, 'A10:逐帧导出照常完成', exported);
    // 耗时只记录:原来「导出时长 > 票据时限 × 1.2」是通过条件(机器快了反而不过)。跨没跨过时限由下一条「途中续签过」来判
    timings.record('A10 逐帧导出用时', exported?.ms ?? null, { formerLimit: `> 票据时限 × 1.2(${Math.round(TTL_MS * 1.2)} ms)` });
    check(exported?.renewal?.renewals >= 1, 'A10:导出途中提前续签了票据', exported?.renewal);
    if (VIDEO) check(exported?.stats?.ticketSwaps > 0, 'A10:素材地址的票据跟着换', exported?.stats);
    out.steps.a10 = { ms: Date.now() - t10, ttlMs: TTL_MS, originalsWaits, export: exported };
    say('a10.done', out.steps.a10);
  } else if (!ONLY_A4) {
    /* ---------------------------------------------------------------- A2. 关掉再开:不重测,已在 L2 的块不再请求 */
    const t2 = Date.now();
    await P(member, () => window.__pcStore.actions.seek(1));
    await delay(4000);
    const snapHave = new Set(member.assets.filter((a) => a.ns === 'snap').map((a) => a.hash));
    const markA2 = member.assets.length;
    await member.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    const back = await until('成员刷新后回到共享项目、双舞台就位', async () => { const d = await previewDiag(member); return d?.dual && (await P(member, () => !!document.querySelector('[data-pc="members-button"]'))) ? d : null; }, 120_000, 500);
    let gateAgain = false;
    for (let i = 0; i < 40; i++) { if (await P(member, () => !!document.querySelector('[data-pc="probe-gate"]')).catch(() => false)) gateAgain = true; await delay(250); }
    await P(member, () => window.__pcStore.actions.seek(1));
    await delay(6000);
    const refetched = member.assets.slice(markA2).filter((a) => a.ns === 'snap' && snapHave.has(a.hash));
    const costs2 = await l2Counts(member);
    check(back && !gateAgain, 'A2:关掉再开不重测(加载遮罩不再出现)', { back: !!back, gateAgain });
    check(costs2?.costs === costs1?.costs, 'A2:costs 条数不变', { before: costs1, after: costs2 });
    check(refetched.length === 0 && snapHave.size > 0, 'A2:已在 L2 的块不再请求', { have: snapHave.size, refetched: refetched.length });
    const o2 = await onlineDiag(member);
    check(o2?.l2Hits > 0, 'A2:块从 L2 读回', { l2Hits: o2?.l2Hits, snapFetches: o2?.snapFetches });
    out.steps.reopen = { ms: Date.now() - t2, gateAgain, costs: costs2, refetched: refetched.length, l2Hits: o2?.l2Hits ?? null };
    say('step2.done', out.steps.reopen);

    /* ---------------------------------------------------------------- A5. 没有节点在线时改一处不报错;独立渲染主机认领、切分、完成 */
    a5TraceCdp = await member.createCDPSession();
    await a5TraceCdp.send('Network.enable');
    a5TraceCdp.on('Network.webSocketFrameReceived', event => {
      try { a5Trace.observe(JSON.parse(event.response?.payloadData), { channel: `publisher:${event.requestId}` }); } catch { /* 非 JSON 帧 */ }
    });
    a5TraceCdp.on('Network.webSocketClosed', event => a5Trace.boundary(`publisher:${event.requestId}`));
    const t5 = Date.now();
    // E6 反方向:记下创建者(桌面)发布过的 plan,X 上线后拿 host 身份试认领一次(L18,只记录)
    if (E6R) state.desktopPlans = ((await diag().catch(() => null))?.published ?? []).map((p) => p?.planId).filter((id) => typeof id === 'string');
    await creator.close().catch(() => {});
    await stopEditor();
    say('a5.creator-stopped');
    const keyBefore = (await onlineDiag(member))?.layers?.find((l) => l.clipId === state.main)?.resultKey ?? null;
    const errorsBefore = member.pageErrors.length;
    const edited = await P(member, (id) => { const s = window.__pcStore; s.actions.setClipParams(id, { label: 'main-v2' }); return s.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.params?.label; }, state.main);
    check(edited === 'main-v2', 'A5:纯在线改一处(主重卡的文字)', { edited });
    if (E6R) {
      // E6 反方向:全部重卡都改(文字 + burnMs),这一版的层全换成 Y 的;每帧更慢,好让 X 上线时这一版还没做完
      const changed = await P(member, (spec) => {
        const s = window.__pcStore;
        s.actions.setClipParams(spec.main, { burnMs: spec.burn });
        for (const id of spec.extras) s.actions.setClipParams(id, { label: 'x-e6r', burnMs: spec.burn });
        const clips = s.getState().project.tracks.flatMap((t) => t.clips);
        return [spec.main, ...spec.extras].filter((id) => clips.find((c) => c.id === id)?.params?.burnMs === spec.burn).length;
      }, { main: state.main, extras: state.extras, burn: E6R_BURN_MS });
      check(changed === EXTRA_HEAVY + 1, 'E6 反方向:全部重卡改了文字与 burnMs', { changed, burnMs: E6R_BURN_MS });
    }
    const published = await until('A5:页面发布清单计划(测量落定后、防抖)', async () => {
      const d = await P(member, () => window.__pcPlanPublisher?.() ?? null);
      const hit = d?.log?.filter((e) => e.ok).at(-1);
      return hit && d.log.filter((e) => e.ok).length >= 2 ? { ...hit, all: d.log.length } : null;
    }, 90_000, 500);
    const pubDiag = await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
    check(published && published.id.includes('#clips:') && published.state === 'open', 'A5:页面发布清单计划(plan:<项目>@<版本>#clips:…),没有节点时 open 等着', published ?? pubDiag);
    out.steps.publisher = pubDiag;
    await delay(8000);
    const toasts = await P(member, () => [...document.querySelectorAll('[data-pc="toast"], .pc-toast')].map((t) => t.textContent)).catch(() => []);
    check(member.pageErrors.length === errorsBefore && !toasts.some((t) => /失败|出错|错误/.test(t ?? '')), 'A5:没有节点在线时不报错', { pageErrors: member.pageErrors.slice(errorsBefore), toasts });
    if (E6R) {
      if (!published?.id) throw new Error('E6 反方向:页面没发布清单计划,做不下去');
      e6 = await e6Begin(published.id);
    }
    let claimed = null;
    /** --cut:本机代理、旁观节点、页面收到的 task.done、断开的结果(本机替身自己断;外部主机经 KV host.cut 报) */
    let cutProxy = null;
    let watcher = null;
    let pageDone = null;
    let cutResult = null;
    let hostFp = HOST_FP;
    let hostPending = null;
    if (!EXTERNAL_HOST) {
      // 独立渲染主机(本机替身:host 档、测试指纹,与页面的环境不同)
      const hostConfig = path.join(TMP, 'host.json');
      // --cut proxy:主机经本机代理(+8)连文档服务的端口,持有任务时由代理切一次
      if (CUT === 'proxy') {
        cutProxy = await startCutProxy(BASE + 8, `127.0.0.1:${PORTS.doc}`);
        cutProxyRef = cutProxy;
        watcher = await startWatcher(M, { projectId: state.projectId, password: state.projectPassword });
        watcherRef = watcher;
        pageDone = await countPageDone(member);
      }
      if (!watcher) {
        watcher = await startWatcher(M, { projectId: state.projectId, password: state.projectPassword, diagnosticOnly: true }).catch(() => null);
        watcherRef = watcher;
      }
      fs.writeFileSync(hostConfig, JSON.stringify([{ url: cutProxy ? cutProxy.url : M.wsBaseOf(HOSTED), projectId: state.projectId, username: '渲染主机', password: state.projectPassword,
        as: 'member', role: 'render', deviceId: `c10b-host-${RUN}`.padEnd(16, '0'), deviceName: 'c10-browser 独立渲染主机' }]));
      await startHost(hostConfig, E6R ? ['--max-concurrent', '1'] : []);
      if (e6) {
        e6.yTracker = trackNodeIds(host.origin);
        await e6AfterYUp();
      }
      const cutP = CUT === 'proxy' ? cutWhileHolding({
        queue: hostQueue, healthz: `${SITE}/hosted/healthz`,
        doCut: async () => {
          cutProxy.child.stdin.write('cut\n');
          const end = Date.now() + 10_000;
          while (Date.now() < end) { if (cutProxy.lines.some((l) => l.includes('"event":"conn.cut"'))) return true; await delay(50); }
          return false;
        },
      }) : null;
      const claimDiagnostics = [];
      let nextDiagnosticAt = 0, lastDiagnosticKey = '';
      claimed = await until('A5:独立渲染主机认领清单计划并切分完成', async () => {
        const body = await hostQueue();
        if (Date.now() >= nextDiagnosticAt) {
          nextDiagnosticAt = Date.now() + 5000;
          const info = await getJson(`${host.origin}/api/prerender/info`, 5000).catch(() => null);
          const events = info?.url ? (await getJson(`${info.url}/api/frames/diagnostics`, 5000).catch(() => null))?.queue?.events ?? [] : [];
          const diagnostic = hostClaimStatusOf(body, events, watcher ? [...watcher.tasks.values()] : null);
          const key = JSON.stringify(diagnostic);
          if (key !== lastDiagnosticKey) {
            lastDiagnosticKey = key;
            const sample = { at: Date.now(), ...diagnostic };
            claimDiagnostics.push(sample);
            if (claimDiagnostics.length > 100) claimDiagnostics.splice(1, 1);
            say('a5.claim-diagnostic', sample);
            fs.writeFileSync(path.join(OUT, 'host-claim-diagnostics.json'), JSON.stringify(claimDiagnostics, null, 2));
          }
        }
        fs.writeFileSync(path.join(OUT, 'a5-task-evidence.json'), JSON.stringify(a5Trace.snapshot(), null, 2));
        const v = hostView(body, hostLog);
        return hostDidWork(v) ? v : null;
      }, 900_000, 2000);
      out.hostClaimDiagnostics = claimDiagnostics;
      check(claimed, 'A5:独立渲染主机(host 档)认领、切分、完成', claimed ?? hostLog.slice(-12));
      check(claimed?.envFingerprint === HOST_FP && HOST_FP !== state.pageFp && HOST_FP !== state.creatorFp, 'A5:认领的节点与页面发布方环境不同(主机用测试指纹)', { host: claimed?.envFingerprint, page: state.pageFp, creator: state.creatorFp });
      if (cutP) {
        cutResult = await cutP;
        for (const c of cutResult.checks) check(c.ok, `--cut proxy:${c.name}`, c.detail);
      }
      out.hostFacts = { ...hostLogFacts(hostLog), capabilities: await hostCapabilities(host.origin) };
    } else if (NO_HOST) {
      hostPending = '待外部主机(--no-host:没有等外部主机)';
    } else {
      // 外部独立渲染主机(另一台机器上的 --role host):本轮的项目与凭证写进 KV,等它报到、认领、完成
      // 旁观节点与页面 task.done 计数先起(主机认领之前),主机要是带 --cut,持有的任务按它们判
      watcher = await startWatcher(M, { projectId: state.projectId, password: state.projectPassword });
      watcherRef = watcher;
      pageDone = await countPageDone(member);
      await xstore.put('config', { at: Date.now(), hosted: HOSTED, healthz: `${SITE}/hosted/healthz`, ws: M.wsBaseOf(HOSTED), projectId: state.projectId, memberPassword: state.projectPassword,
        docId: state.docId, mainClip: state.main, planId: published?.id ?? null, ...(E6R ? { e6Reverse: true } : {}) });
      say('a5.waiting-external-host', { run: RUN, waitMin: HOST_WAIT_MS / 60_000 });
      const tReady = Date.now();
      const ready = await xstore.wait('host.ready', Date.now() + HOST_WAIT_MS);
      if (!ready) {
        hostPending = `待外部主机(${HOST_WAIT_MS / 60_000} 分钟内没有外部主机报到)`;
      } else {
        hostFp = ready.envFingerprint ?? null;
        const readyMs = Date.now() - tReady;
        say('a5.external-host-ready', { profile: ready.profile, envFingerprint: ready.envFingerprint, nodeId: ready.nodes?.[0]?.nodeId, transport: ready.nodes?.[0]?.transport, platform: ready.platform, readyMs });
        if (e6) await e6AfterYUp();
        const endClaim = Date.now() + 900_000;
        // 时限:报到之后 15 分钟内认领并做完至少一段(与本机替身同一时限)
        let lastProgress = null;
        let early = null;
        while (Date.now() < Math.min(endClaim, deadline)) {
          const p = await xstore.get('host.progress', 10_000).catch(() => null);
          if (p) lastProgress = p;
          if (hostDidWork(lastProgress)) break;
          const done = await xstore.get('host', 0).catch(() => null);
          if (done) { lastProgress = done.last ?? lastProgress; early = { exitedEarly: true, fails: done.fails ?? [] }; break; }
        }
        claimed = hostDidWork(lastProgress) ? lastProgress : null;
        check(claimed, 'A5:外部独立渲染主机(host 档)15 分钟内认领、切分、完成', { nodes: lastProgress?.nodes ?? null, ...(early ?? {}) });
        check(ready.profile === 'host', 'A5:认领方是独立渲染主机(profile host)', { profile: ready.profile });
        out.steps.a5host = { readyMs, platform: ready.platform ?? null, arch: ready.arch ?? null, testFingerprint: ready.testFingerprint ?? null, profile: ready.profile ?? null,
          envFingerprint: ready.envFingerprint ?? null, codeVersion: ready.codeVersion ?? null, differsFromPage: hostFp !== state.pageFp, differsFromCreator: hostFp !== state.creatorFp,
          cut: ready.cut ?? null, ffmpeg: ready.ffmpeg ?? null, capabilities: ready.capabilities ?? null };
        // 主机带 --cut:等它报断开的结果(持有 → 掐线 → 接续);时限 = 主机的等掐线时限 + 接续时限 + 5 分钟
        if (ready.cut) {
          const hc = await xstore.wait('host.cut', Date.now() + (ready.cutWaitMs ?? CUT_WAIT_MS) + (ready.resumeTimeoutMs ?? RESUME_TIMEOUT_MS) + 300_000);
          cutResult = hc;
          if (!hc) fails.push(`--cut ${ready.cut}:没等到主机的断开结果(KV host.cut)`);
          else for (const c of hc.checks ?? []) check(c.ok, `--cut ${ready.cut}(主机):${c.name}`, c.detail);
        }
      }
    }
    if (hostPending) {
      pending.push({ item: 'A5:独立渲染主机认领、切分、完成,页面取到新快照', status: hostPending });
      out.steps.a5 = { ms: Date.now() - t5, published, pendingHost: hostPending };
      if (e6) pending.push({ item: 'E6 反方向:Y 认领页面的 plan、X 认领 0、J-全完 / J-恰一 / J-纯层', status: hostPending });
      say('a5.pending', out.steps.a5);
    } else {
    const fresh = await until('A5:页面取到主机产的新快照(层换了新键、环境是主机的,snap/ 就绪)', async () => {
      const o = await onlineDiag(member);
      const l = o?.layers?.find((x) => x.clipId === state.main);
      // M7 D1:页面在线时切分方给这张卡另出一份页面指纹的,谁先认领谁得卡 —— 新层出自主机或页面自己都算页面取到了新快照(记下是谁)
      return l && l.resultKey !== keyBefore && (l.envFingerprint === hostFp || (state.pageFp && l.envFingerprint === state.pageFp)) && l.ready > 0 ? l : null;
    }, 600_000, 2000);
    const layersNow = async () => ((await onlineDiag(member))?.layers ?? []).map((l) => ({ clip: l.clipId, main: l.clipId === state.main, fp: l.envFingerprint, ready: l.ready, candidates: l.candidates, newKey: l.clipId === state.main ? l.resultKey !== keyBefore : undefined }));
    check(fresh, 'A5:页面取到新快照', fresh ?? { main: (await layersNow()).find((l) => l.main) ?? null, hostFp, pageFp: state.pageFp, layers: (await layersNow()).length });
    if (!fresh) out.steps.a5FreshDiag = { hostFp, pageFp: state.pageFp, keyBefore: String(keyBefore ?? '').slice(0, 12), layers: await layersNow() };
    await P(member, () => window.__pcStore.actions.seek(2));
    await P(member, () => { const s = window.__pcStore; s.actions.seek(2); s.actions.play(); });
    let newShown = null;
    for (let i = 0; i < 20 && !newShown; i++) {
      await delay(200);
      const x = await stageSample(member);
      const w = x?.playing ? x.wraps.find((y) => y.id === state.main) : null;
      if (w?.plane && w.suppressed) newShown = { t: x.t, planeSig: w.planeSig };
    }
    await P(member, () => window.__pcStore.actions.pause());
    const newHtml = await (await frontFrame(member))?.evaluate((id) => document.querySelector(`[data-pc-clip="${CSS.escape(id)}"] [data-pc-snapshot-plane]`)?.textContent ?? '', state.main).catch(() => '');
    check(newShown, 'A5:播放中主重卡贴着新快照', newShown);
    // 认领方:nodeId、profile、环境指纹、实际用的传输(外部主机的由它经 KV 报,本机替身的读它的诊断)
    const claimant = claimed ? { profile: claimed.profile, envFingerprint: claimed.envFingerprint, codeVersion: claimed.codeVersion,
      nodes: claimed.nodes.map((n) => ({ nodeId: n.nodeId, claimed: n.claimed, completed: n.completed, failed: n.failed, transport: n.transport, resumes: n.resumes, legacy: n.legacy, opens: n.opens, connectFailed: n.connectFailed })),
      sessionLog: claimed.sessionLog } : null;
    check(!claimant || claimant.nodes.some((n) => n.transport === 'ws'), 'A5:认领方经 WebSocket 连着文档服务(没有回落)', claimant?.nodes);
    // --cut:持有的任务按旁观节点与页面收到的 task.done 判;本机替身另判「到最后 opens 仍不变」(外部主机自己判)
    let cutJudge = null;
    if (cutResult?.held?.length && watcher && pageDone) {
      cutJudge = await judgeHeld(cutResult.held, watcher, pageDone);
      if (!EXTERNAL_HOST) {
        const n = (await hostQueue())?.nodes?.[0];
        check(n && n.opens === cutResult.before?.opens, '--cut proxy:same-session-to-end(到最后 opens 仍不变)', { opens: [cutResult.before?.opens ?? null, n?.opens ?? null], resumes: n?.resumes ?? null, released: n?.released ?? null });
        check(n && n.released === 0, '--cut proxy:not-released(持有的任务没被放回)', { released: n?.released ?? null });
      }
    }
    // E6 反方向:等这一轮的细任务都关闭(外部主机要在 finish 之前做完)
    const e6Settled = e6 ? await e6Settle() : null;
    out.steps.a5 = { ms: Date.now() - t5, published, external: EXTERNAL_HOST, claimant, cut: cutResult ? { held: cutResult.held, before: cutResult.before, after: cutResult.after, judge: cutJudge } : null, newLayer: fresh ? { resultKey: fresh.resultKey.slice(0, 12), envFingerprint: fresh.envFingerprint, by: fresh.envFingerprint === hostFp ? 'host' : 'page', ready: fresh.ready } : null, shown: newShown, planeText: newHtml?.slice(0, 40) ?? null };
    let hostIds = null;
    if (xstore) {
      await xstore.put('finish', { at: Date.now(), reason: fresh ? 'fresh' : 'gave-up' }).catch(() => {});
      xfinished = true;
      const hostResult = await xstore.wait('host', Date.now() + 120_000);
      out.steps.a5.hostResult = hostResult ? { ok: hostResult.ok, fails: hostResult.fails, exitCode: hostResult.exitCode ?? null, released: hostResult.released ?? null, ms: hostResult.ms ?? null } : null;
      check(hostResult?.ok, 'A5:外部主机的结果行 ok(正常退出、放回认领)', out.steps.a5.hostResult);
      hostIds = hostResult?.ids ?? null;
      if (e6) check(hostIds, 'E6 反方向:外部主机交回了认领 / 完成的任务 id(结果行 ids)', { keys: hostResult ? Object.keys(hostResult).slice(0, 30) : null });
    }
    say('a5.done', out.steps.a5);
    if (e6) {
      out.steps.e6r = await e6Judge({ yIds: EXTERNAL_HOST ? hostIds : e6.yTracker?.view(), yFp: hostFp });
      out.steps.e6r.settled = e6Settled;
      say('e6r.done', { checks: out.steps.e6r.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.name}`), tasks: out.steps.e6r.tasks });
    }
    }
  }
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
  for (const [name, page] of [['creator', state.creator], ['member', state.member]]) if (page) await shot(page, `fatal-${name}`).catch(() => {});
} finally {
  try { fs.writeFileSync(path.join(OUT, 'a5-task-evidence.json'), JSON.stringify(a5Trace.snapshot(), null, 2)); } catch { /* 不改变原探针结果 */ }
  await a5TraceCdp?.detach().catch(() => {});
  try { watcherRef?.close(); } catch { /* 已关 */ }
  await stopCutProxy(cutProxyRef).catch(() => {});
  if (e6) {
    try { e6.claimer?.close(); } catch { /* 已关 */ }
    try { e6.watcher?.close(); } catch { /* 已关 */ }
    e6.yTracker?.stop();
    e6.xhostTracker?.stop();
    await e6.pageDone?.detach();
    if (e6.xhost) { try { fs.writeFileSync(path.join(OUT, 'x-host.log'), e6.xhost.lines.join('\n')); } catch { /* 写不了 */ } await e6.xhost.stop().catch(() => {}); }
  }
  if (xstore && !xfinished) await xstore.put('abort', { at: Date.now(), reason: fails.length ? fails[0].slice(0, 200) : 'creator 结束' }).catch(() => {});
  out.pending = pending;
  if (state.member) out.memberDiag = { pageErrors: state.member.pageErrors?.slice(-8), consoleErrors: state.member.consoleErrors?.slice(-8) };
  let deleted = null;
  if (M && state.projectId && state.creatorCred) {
    const r = await adminOp(M, state.projectId, state.creatorCred, 'delete').catch((err) => ({ type: 'error', reason: String(err?.message ?? err) }));
    deleted = r?.type ?? null;
  }
  try { conn?.close(); } catch { /* 已关 */ }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { fs.writeFileSync(path.join(OUT, 'creator-editor.log'), editorLog.join('\n')); fs.writeFileSync(path.join(OUT, 'host.log'), hostLog.join('\n')); } catch { /* 写不了 */ }
  await stopHost().catch(() => {});
  await stopEditor().catch(() => {});
  // 升级过的 WebSocket 连接不归 http 服务器管:代理的 close 先把它们全部掐掉再关(限时等,以前会在这里挂住、不出结果行)
  const within = (p, ms) => Promise.race([p, delay(ms)]);
  try { await within(hostedProxy?.close(), 10_000); } catch { /* 已关 */ }
  try { await within(combo?.close(), 10_000); } catch { /* 已关 */ }
  out.cleanup = { deleted, listening: [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.node, PORTS.node + 1, PORTS.node + 2].filter((p) => pidOnPort(p)) };
  if (!KEEP) {
    for (const d of fs.readdirSync(TMP)) {
      const p = path.join(TMP, d);
      if (path.resolve(p) === OUT) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 句柄还没放 */ }
    }
  }
  out.ms = Date.now() - started;
  for (const [name, label] of [['creator', '创建者建项目、放云端'], ['member', '成员加入到两个舞台就绪'], ['play', 'A1 播放 10 秒这一步'], ['userCard', '用户卡一步'], ['reopen', 'A2 关掉再开'], ['a5', 'A5 独立渲染主机一步'], ['a10', 'A10 票据续签一步']]) {
    if (out.steps[name]?.ms != null) timings.record(label, out.steps[name].ms);
  }
  if (out.steps.settleTiming) timings.record('A4 定位到换上精确帧', out.steps.settleTiming.seekToPreciseMs);
  timings.record('整支探针', out.ms);
  out.timings = timings.list;
  timings.print();
  out.fails = fails;
  out.ok = fails.length === 0;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
