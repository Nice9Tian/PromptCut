/**
 * C10 本机真浏览器验收(`docs/plan/c10-contract.md` 第 20 节 C10-A1～A5、A10):在线浏览器模式普通档。
 *
 *   node scripts/probes/c10-browser-probe.mjs [--out <目录>] [--dist <在线构建目录>] [--keep-temp]
 *        [--a10]                 只验 A10(逐帧导出跨过票据时限):托管端的素材票据时限缩短到 --ticket-ttl-ms
 *        [--ticket-ttl-ms 20000]
 *        [--no-video]            不导入视频(只验卡片)
 *        [--only-a4]             只跑到 A4(播放、暂停追活渲)为止,跳过 A2 的重开与 A5(排障用)
 *        [--base-port 5420]      端口段:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 创建者编辑器与舞台端口
 *                                (A5 里创建者关掉之后,独立渲染主机用同一段)
 *
 * 本机替身(与阿里云同形):
 *   - 托管组合(文档服务 + 素材服务,只绑 127.0.0.1);
 *   - 仿 nginx 的前缀代理,开三个源:编辑器页(+0)与两个舞台(+1、+2)都给 `/editor`(在线构建)、`/hosted/` 与 `/media/` 反代,
 *     **每个响应都带 `Origin-Agent-Cluster: ?1`**;`/editor/runtime-config.json` 给两个舞台源(同 `deploy-hosted --stage-origins` 写的);
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
 *        [--no-host] [--host-wait-min 15] [--timeout-min 120] [--coord <协调口基址>] [--out <目录>] [--base-port 5420]
 *
 *   - 不起本机托管组合与代理:页面取 `<源>/editor`,文档服务 `<源>/hosted/`,素材服务 `<源>/media/api/asset`;
 *     两个舞台源缺省读 `<源>/editor/runtime-config.json` 的 `stageOrigins`(`deploy-hosted --stage-origins` 写的),读不到记一条失败、
 *     退回按 `s1.<主机>`、`s2.<主机>` 核;`--stage-origins` 给了就以它为准(仍核 runtime-config 与它一致)。
 *   - 创建者 = 本机桌面版 dev server(端口 +5～+7)连远端(同 c10a-demo-probe 的创建者);成员 = 本机无头 Chrome 普通档(桌面视口)。
 *   - 判据与本机替身相同,只有一处不同:A1 的「播放 10 秒主文档长任务 0」在外网模式只报数、标「待笔记本复核」(PC 忙,耗时类判断在 PC 上不作数)。
 *   - A5 的独立渲染主机来自外部(下一节):没有节点在线时改一处、页面发布清单计划、不报错照常核;之后把本轮的项目与凭证写进协调口 KV,
 *     等外部主机报到(`--host-wait-min`,缺省 15 分钟),再等它认领并完成(至多 15 分钟)、页面取到它产的新快照(至多 10 分钟)。
 *     时限内没有主机报到:A5 的后半记「待笔记本主机」(`steps.a5.pendingHost`),不算失败。`--no-host` 不写 KV、不等,直接记「待笔记本主机」。
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
 * ## KV 键(`c10b.<run>.<名>`)
 *   config         creator → host:文档服务的 ws 地址、项目 id、成员口令、项目文档 id、主重卡片段 id、页面发布的计划 id(口令只进 KV 与主机临时目录里的配置文件)
 *   host.ready     host → creator:起来了(nodeId、profile、envFingerprint、codeVersion、transport、机器平台)
 *   host.progress  host → creator:认领、完成、失败数与传输(变了才写)
 *   host.holding   host → 外部与 creator:--cut 时主机此刻持有的任务(可以掐了)
 *   cut.done       外部 → host:--cut external 时掐完线写
 *   host.cut       host → creator:--cut 的结果(持有的任务、前后的 opens / resumes / sessions.resumed、判据)
 *   finish         creator → host:可以退出了(页面已取到新快照,或 creator 不等了)
 *   abort          creator 出错收尾时写;host 看到就退出
 *   host           host 的结果行
 */
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const A10 = argv.includes('--a10');
const ONLY_A4 = argv.includes('--only-a4');
const KEEP = argv.includes('--keep-temp');
const VIDEO = !argv.includes('--no-video');
const BASE = Number(arg('--base-port', 5420));
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
const SITE = REMOTE ? String(SITE_ARG).replace(/\/+$/, '') : `http://127.0.0.1:${PORTS.editor}`;
/** 两个舞台源:本机替身是 +1、+2 两个端口;外网模式在主流程开头按 --stage-origins / runtime-config.json 定 */
let STAGE_ORIGINS = REMOTE ? [] : [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const HOSTED = `${SITE}/hosted/`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), ROLE === 'host' ? 'pc-c10-host-' : 'pc-c10-browser-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const deadline = started + Number(arg('--timeout-min', REMOTE || ROLE !== 'all' ? 120 : 60)) * 60_000;

const fails = [];
const out = { ok: false, run: RUN, role: ROLE, mode: A10 ? 'a10' : 'a1-a5', target: REMOTE ? 'site' : 'local', site: SITE, stageOrigins: STAGE_ORIGINS, out: OUT, steps: {} };
/** 待笔记本复核 / 待笔记本主机的项(不算失败,只记下) */
const pending = [];
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
const proxies = [];
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
    docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const OAC = { 'origin-agent-cluster': '?1' };
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
  const makeProxy = (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const forward = (req, res, upstream, strip) => {
      const target = req.url.slice(strip.length) || '/';
      const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC });
        r.pipe(res);
      });
      up.on('error', () => { res.writeHead(502, OAC); res.end('bad gateway'); });
      req.pipe(up);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, PORTS.doc, '/hosted');
      if (url.pathname.startsWith('/media/')) return forward(req, res, PORTS.asset, '/media');
      const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
      const sendFile = (file, cache) => {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
        fs.createReadStream(file).pipe(res);
      };
      if (url.pathname === '/editor/runtime-config.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec });
        return res.end(runtimeConfig);
      }
      const index = path.join(DIST, 'index.html');
      if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
      if (url.pathname.startsWith('/editor/assets/')) {
        const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
        if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404, sec); return res.end('not found'); }
        return sendFile(f, 'public, max-age=31536000, immutable');
      }
      if (url.pathname.startsWith('/editor/')) return sendFile(index, 'no-store');
      res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC });
      res.end('not found');
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, origin);
      if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      const up = net.connect(PORTS.doc, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    proxies.push(server);
    return new Promise((r) => server.listen(port, '127.0.0.1', r));
  };
  await Promise.all([makeProxy(PORTS.editor), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
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
async function startHost(config) {
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用(主机)`);
  const env = { ...process.env, PROMPTCUT_TEST_ENV_FINGERPRINT: HOST_FP };
  delete env.PROMPTCUT_TEST_ASSET_TICKET_TTL_MS;
  if (HOST_NO_FFMPEG) stripFfmpeg(env, TMP);
  out.hostFfmpeg = ffmpegIn(env);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'render-host.mjs'), '--config', config, '--port', String(PORTS.node), '--data', path.join(TMP, 'host')],
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
const hostDidWork = (view) => (view?.nodes ?? []).some((n) => (n.completed ?? 0) > 0 && (n.claimed ?? 0) > (n.completed ?? 0) - 1);

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
  const end = Date.now() + holdTimeoutMs;
  while (Date.now() < Math.min(end, deadline)) {
    const n = (await queue())?.nodes?.[0];
    if (n && Array.isArray(n.held) && n.held.length > 0 && n.connected) { pre = n; break; }
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
async function startWatcher(M, { projectId, password }) {
  const c = await openConn(M, { url: M.wsBaseOf(HOSTED), projectId, username: '旁观节点', password, as: 'member', role: 'render' });
  const seen = new Map();
  const rec = (id) => { if (!seen.has(id)) seen.set(id, { taken: 0, reopenedAfterTaken: 0, closed: [] }); return seen.get(id); };
  c.ep.onMessage((m) => {
    if (m?.type === 'task.taken' && typeof m.id === 'string') rec(m.id).taken++;
    else if (m?.type === 'task.opened' && typeof m.task?.id === 'string') { const r = rec(m.task.id); if (r.taken > 0) r.reopenedAfterTaken++; }
    else if (m?.type === 'task.closed' && typeof m.id === 'string') rec(m.id).closed.push(m.state ?? null);
  });
  const hello = await c.rpc({ type: 'node.hello', nodeId: `c10b-watch-${RUN}`.slice(0, 64), profile: 'pc', codeVersions: [], capabilities: {}, maxConcurrent: 1 }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
  const watch = await c.rpc({ type: 'queue.watch', projects: [projectId] }).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
  check(hello.type !== 'error' && watch.type === 'queue.snapshot', '--cut:旁观节点在看本项目的队列', { hello: hello.type, reason: hello.reason ?? watch.reason ?? null, watch: watch.type });
  return { seen, close: c.close };
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
  while (Date.now() < Math.min(end, deadline)) {
    if (held.every((id) => (watcher.seen.get(id)?.closed ?? []).length > 0 && (pageDone.counts()[id] ?? 0) > 0)) break;
    await delay(1000);
  }
  await delay(1500);
  const counts = pageDone.counts();
  const perHeld = held.map((id) => { const w = watcher.seen.get(id) ?? { taken: 0, reopenedAfterTaken: 0, closed: [] }; return { id, taken: w.taken, reopened: w.reopenedAfterTaken, closed: w.closed, taskDone: counts[id] ?? 0 }; });
  check(perHeld.length > 0 && perHeld.every((h) => h.taken === 1 && h.reopened === 0 && h.closed.length === 1 && h.closed[0] === 'done'), '--cut:持有的任务 taken 1 / reopened 0 / done 1', perHeld);
  check(perHeld.length > 0 && perHeld.every((h) => h.taskDone === 1), '--cut:持有的任务恰好一次 task.done(页面收到)', perHeld.map((h) => ({ id: h.id, taskDone: h.taskDone })));
  const multi = Object.entries(counts).filter(([, n]) => n > 1);
  check(multi.length === 0, '--cut:页面收到的 task.done 没有重复的', Object.fromEntries(multi));
  return { perHeld, pageTaskDone: { tasks: Object.keys(counts).length, allOne: multi.length === 0 } };
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
    child = fork(path.join(ROOT, 'scripts', 'render-host.mjs'), ['--config', configFile, '--port', String(port), '--data', path.join(TMP, 'data')],
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
    const q0 = hostView(await getJson(`${origin}/api/frames/queue`, 30_000).catch(() => ready.queue), lines);
    out.ready = q0;
    const facts0 = hostLogFacts(lines);
    await store.put('host.ready', { at: Date.now(), ...q0, platform: process.platform, arch: process.arch, node: process.version, testFingerprint: !!testFp,
      ffmpeg: out.ffmpeg, capabilities: facts0.capabilities, cut: CUT, cutWaitMs: CUT_WAIT_MS, resumeTimeoutMs: RESUME_TIMEOUT_MS });
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
        const sig = JSON.stringify(q.nodes.map((n) => [n.claimed, n.completed, n.failed, n.transport, n.connected]));
        if (sig !== lastSig) { lastSig = sig; await store.put('host.progress', { at: Date.now(), ...q }).catch(() => {}); say('host.progress', { nodes: q.nodes.map((n) => ({ claimed: n.claimed, completed: n.completed, failed: n.failed, transport: n.transport })) }); }
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
    if (cutP) {
      const r = await Promise.race([cutP, delay(5000).then(() => 'pending')]);
      if (r === 'pending') fails.push('[host] --cut 还没做完就收到了 finish / abort');
      else if (r?.before) {
        const n = (await queueOf())?.nodes?.[0];
        check(n && n.opens === r.before.opens, `[host] --cut ${CUT}:same-session-to-end(到最后 opens 仍不变)`, { opens: [r.before.opens, n?.opens ?? null], resumes: n?.resumes ?? null });
        check(n && n.released === 0, `[host] --cut ${CUT}:not-released(持有的任务没被放回)`, { released: n?.released ?? null });
      }
    }
    Object.assign(out, hostLogFacts(lines));
    child.send({ type: 'shutdown' });
    out.exitCode = await new Promise((resolve) => { if (child.exitCode !== null) return resolve(child.exitCode); const t = setTimeout(() => resolve(null), 60_000); child.once('exit', (code) => { clearTimeout(t); resolve(code); }); });
    out.released = exitLine?.released ?? null;
    check(out.exitCode === 0, '[host] render-host 经 IPC 正常退出(退出码 0)', { exitCode: out.exitCode, tail: lines.slice(-4) });
    if (out.ffmpeg && !out.ffmpeg.found) out.noFfmpegNote = '主机环境里没有 ffmpeg;照常起了、做了任务(看 didWork 与 ffmpegMentions)';
  } catch (e) {
    fails.push(`[host] 出错:${String(e?.message ?? e).slice(0, 600)}`);
  } finally {
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
  const [route, client, shared, ws, endpoint, ticket, asset, fp] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/render-node/ws-transport.mjs'), import('../../server/render-node/endpoint.mjs'),
    import('../../server/auth/ticket-source.mjs'), import('../../server/asset-store/client.mjs'), import('../../server/render-node/fingerprint.mjs'),
  ]);
  return { ...client, ...route, ...shared, ...ws, ...endpoint, ...ticket, ...asset, ...fp };
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
  const ep = M.createWsEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role }), log: () => {} });
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
  return puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--disable-gpu'],
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
    const light = S.actions.addClipOnNewTrack({ index: 0, cardId: 'chapter-bar', start: 0, duration: spec.seconds });
    // 独立的轻卡:测量的快照趟会推出探针帧(验「大块产出压成可转移的 ArrayBuffer」)
    S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-typewriter', start: 2, duration: 4 });
    const main = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: spec.seconds });
    S.actions.setClipParams(main.id, { burnMs: 40, label: 'main' });
    const extras = [];
    for (let i = 0; i < spec.extra; i++) {
      const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: 1 });
      S.actions.setClipParams(c.id, { burnMs: 40, label: 'x' });
      extras.push(c.id);
    }
    S.actions.seek(1);
    return { light: light?.id ?? null, main: main?.id ?? null, extras };
  }, { mediaId: state.media?.id ?? null, seconds: SECONDS, extra: EXTRA_HEAVY });
  Object.assign(state, clips);
  check(state.main && state.extras.length === EXTRA_HEAVY, '创建者放好卡片', clips);
  state.docId = await P(creator, async () => (await import('/src/store/project.ts')).getState().project.id);
  await until('创建者页面测量测完', async () => P(creator, async () => { const R = await import('/src/editor/probeRunner.ts'); return !R.probeProgress().running && !document.querySelector('[data-pc="probe-gate"]'); }), 300_000, 500);
  // 放云端
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
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
  check(layer0?.v === 2 && layer0.contentKey && layer0.envFingerprint, '层表 v 2,重层带 contentKey 与 envFingerprint', layer0);
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
  // 第 3 节 + 第 18 节第 7 条(集成接线):在线普通档测完的记录当场转写进文档服务(onCostRecords → publishSharedCosts)
  const costPublish = await until('成员页测完的成本记录写进了文档服务', () => P(member, () => { const d = window.__pcCostPublish?.(); return d && d.ok > 0 ? d : null; }), 30_000, 500);
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
  const ready = await until('成员页主重卡的原尺寸就绪(层表 v 2、snap/ 进 L2)', async () => {
    const o = await onlineDiag(member);
    const l = o?.layers?.find((x) => x.clipId === state.main);
    return o?.tier === 'original' && o.mapVersion === 2 && l && l.ready > 0 ? { o, l } : null;
  }, 180_000, 1000);
  check(ready, 'A3:在线来源取原尺寸一档,主重卡有就绪区间', ready?.l);
  await member.bringToFront();
  await P(member, () => { const s = window.__pcStore; s.actions.seek(0); });
  await delay(4000);
  const snapBeforePlay = new Set(member.assets.filter((a) => a.ns === 'snap').map((a) => a.hash));

  // A1:播放含重卡的 10 秒时间轴:主文档长任务 0,重层按拍换快照
  await P(member, () => { window.__pcLongTasks.length = 0; });
  const beatBefore = (await previewDiag(member))?.beatSwap ?? {};
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
  const playing = samples.filter((s) => s.playing);
  const mainSigs = playing.filter((s) => s.t >= 1).map((s) => s.wraps.find((w) => w.id === state.main)).filter((w) => w?.suppressed && w.plane).map((w) => w.planeSig);
  const worstLong = longTasks.slice().sort((a, b) => b.ms - a.ms).slice(0, 3);
  if (REMOTE) pending.push({ item: 'A1:播放 10 秒,主文档长任务 0', status: '待笔记本复核', count: longTasks.length, worst: worstLong });
  else check(longTasks.length === 0, 'A1:播放 10 秒,主文档长任务 0', { count: longTasks.length, worst: worstLong });
  check(playing.length >= 10, 'A1:播放中采到可见舞台的样子', { samples: samples.length, playing: playing.length });
  check(new Set(mainSigs).size >= 5, 'A1:重层按拍换快照(播放中主重卡的快照平面一直在换帧)', { distinct: new Set(mainSigs).size, of: mainSigs.length });
  const deliveries = (beatAfter.deliveries ?? 0) - (beatBefore.deliveries ?? 0);
  check(deliveries >= 100 && (beatAfter.underThrottle ?? 0) > (beatBefore.underThrottle ?? 0), 'A1/L4:播放中每拍投递、不受 33 ms 节流', { deliveries, underThrottle: (beatAfter.underThrottle ?? 0) - (beatBefore.underThrottle ?? 0) });
  // A4:装不下的层显示占位
  check(placeholderSeen, 'A4:换帧预算装不下的层显示占位(0～1 秒 9 张重卡)', placeholderSeen ?? samples.filter((s) => s.t < 1).slice(0, 2).map((s) => ({ t: s.t, beat: s.beat })));
  out.steps.play = { ms: Date.now() - t1, longTasks: longTasks.length, samples: samples.length, mainDistinctFrames: new Set(mainSigs).size, deliveries, placeholder: placeholderSeen };

  // A4:暂停后追到精确活渲,占位撤下后不再盖回
  await until('播放到头停下', () => P(member, () => !window.__pcStore.getState().playing), 20_000, 300);
  await P(member, () => window.__pcStore.actions.seek(0.5));
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
  await shot(member, 'a4-settled-live');
  await delay(3000);
  const stillLive = await stageSample(member);
  check(stillLive && stillLive.wraps.filter((w) => w.id === state.main || state.extras.includes(w.id)).every((w) => !w.suppressed && !w.plane && !w.placeholder),
    'A4:占位撤下后不再盖回(3 秒后仍是活渲)', stillLive?.wraps?.slice(0, 4));
  const pd = await previewDiag(member);
  out.steps.settle = { settled: !!settled, stillLive: !!stillLive, feedSettled: pd?.snapshotFeed?.settled?.length ?? null, backWork: pd?.backWork, probeFrames: pd?.probeFrames };
  check(pd?.probeFrames?.gzFrames > 0 && pd.probeFrames.htmlBytes === 0, 'A1/第 2 节:后台舞台的探针帧压成可转移的 ArrayBuffer 交出', pd?.probeFrames);
  check(pd?.backWork?.sent > 0 && pd.backWork.on === true, '第 2 节:后台活由父页判空闲经 RPC 发开始 / 停止', pd?.backWork);

  // A3:网络记录
  const sum1 = assetSummary(member.assets);
  check(sum1.snap > 0 && sum1.px === 0, 'A3:普通档取 snap/ 原尺寸、预渲染小尺寸请求 0', sum1);
  if (VIDEO) check(Object.keys(sum1.mediaByFrameOrigin).some((k) => STAGE_ORIGINS.some((o) => k === `${o}→${o}`)) && !Object.keys(sum1.mediaByFrameOrigin).some((k) => STAGE_ORIGINS.some((o) => k.startsWith(`${o}→`) && !k.endsWith(o))),
    '第 2 节:跨源舞台用相对地址读自己源上反代的 /media', sum1.mediaByFrameOrigin);
  const o3 = await onlineDiag(member);
  check(o3?.layers?.length && o3.layers.every((l) => l.envFingerprint === state.creatorFp), 'A3:一层只出自一种环境(层表记录的那一种)', o3?.layers?.map((l) => ({ clip: l.clipId.slice(0, 6), fp: l.envFingerprint })));
  out.steps.member = { ms: Date.now() - t1, stages: origins, iframeTargets, caps, requests: sum1, l2: costs1, pageFp: state.pageFp, costPublish: state.costPublish,
    publisher: await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null) };
  say('step1.done', out.steps.member);

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
    check(exported && exported.ms > TTL_MS * 1.2, 'A10:导出时长跨过票据时限', { ms: exported?.ms, ttl: TTL_MS });
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
    const t5 = Date.now();
    await creator.close().catch(() => {});
    await stopEditor();
    say('a5.creator-stopped');
    const keyBefore = (await onlineDiag(member))?.layers?.find((l) => l.clipId === state.main)?.resultKey ?? null;
    const errorsBefore = member.pageErrors.length;
    const edited = await P(member, (id) => { const s = window.__pcStore; s.actions.setClipParams(id, { label: 'main-v2' }); return s.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.params?.label; }, state.main);
    check(edited === 'main-v2', 'A5:纯在线改一处(主重卡的文字)', { edited });
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
      fs.writeFileSync(hostConfig, JSON.stringify([{ url: cutProxy ? cutProxy.url : M.wsBaseOf(HOSTED), projectId: state.projectId, username: '渲染主机', password: state.projectPassword,
        as: 'member', role: 'render', deviceId: `c10b-host-${RUN}`.padEnd(16, '0'), deviceName: 'c10-browser 独立渲染主机' }]));
      await startHost(hostConfig);
      const cutP = CUT === 'proxy' ? cutWhileHolding({
        queue: hostQueue, healthz: `${SITE}/hosted/healthz`,
        doCut: async () => {
          cutProxy.child.stdin.write('cut\n');
          const end = Date.now() + 10_000;
          while (Date.now() < end) { if (cutProxy.lines.some((l) => l.includes('"event":"conn.cut"'))) return true; await delay(50); }
          return false;
        },
      }) : null;
      claimed = await until('A5:独立渲染主机认领清单计划并切分完成', async () => {
        const v = hostView(await hostQueue(), hostLog);
        return hostDidWork(v) ? v : null;
      }, 900_000, 2000);
      check(claimed, 'A5:独立渲染主机(host 档)认领、切分、完成', claimed ?? hostLog.slice(-12));
      check(claimed?.envFingerprint === HOST_FP && HOST_FP !== state.pageFp && HOST_FP !== state.creatorFp, 'A5:认领的节点与页面发布方环境不同(主机用测试指纹)', { host: claimed?.envFingerprint, page: state.pageFp, creator: state.creatorFp });
      if (cutP) {
        cutResult = await cutP;
        for (const c of cutResult.checks) check(c.ok, `--cut proxy:${c.name}`, c.detail);
      }
      out.hostFacts = hostLogFacts(hostLog);
    } else if (NO_HOST) {
      hostPending = '待笔记本主机(--no-host:没有等外部主机)';
    } else {
      // 外部独立渲染主机(另一台机器上的 --role host):本轮的项目与凭证写进 KV,等它报到、认领、完成
      // 旁观节点与页面 task.done 计数先起(主机认领之前),主机要是带 --cut,持有的任务按它们判
      watcher = await startWatcher(M, { projectId: state.projectId, password: state.projectPassword });
      watcherRef = watcher;
      pageDone = await countPageDone(member);
      await xstore.put('config', { at: Date.now(), hosted: HOSTED, healthz: `${SITE}/hosted/healthz`, ws: M.wsBaseOf(HOSTED), projectId: state.projectId, memberPassword: state.projectPassword,
        docId: state.docId, mainClip: state.main, planId: published?.id ?? null });
      say('a5.waiting-external-host', { run: RUN, waitMin: HOST_WAIT_MS / 60_000 });
      const tReady = Date.now();
      const ready = await xstore.wait('host.ready', Date.now() + HOST_WAIT_MS);
      if (!ready) {
        hostPending = `待笔记本主机(${HOST_WAIT_MS / 60_000} 分钟内没有外部主机报到)`;
      } else {
        hostFp = ready.envFingerprint ?? null;
        const readyMs = Date.now() - tReady;
        say('a5.external-host-ready', { profile: ready.profile, envFingerprint: ready.envFingerprint, nodeId: ready.nodes?.[0]?.nodeId, transport: ready.nodes?.[0]?.transport, platform: ready.platform, readyMs });
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
      say('a5.pending', out.steps.a5);
    } else {
    const fresh = await until('A5:页面取到主机产的新快照(层换了新键、环境是主机的,snap/ 就绪)', async () => {
      const o = await onlineDiag(member);
      const l = o?.layers?.find((x) => x.clipId === state.main);
      return l && l.resultKey !== keyBefore && l.envFingerprint === hostFp && l.ready > 0 ? l : null;
    }, 600_000, 2000);
    check(fresh, 'A5:页面取到新快照', fresh ?? (await onlineDiag(member))?.layers);
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
    out.steps.a5 = { ms: Date.now() - t5, published, external: EXTERNAL_HOST, claimant, cut: cutResult ? { held: cutResult.held, before: cutResult.before, after: cutResult.after, judge: cutJudge } : null, newLayer: fresh ? { resultKey: fresh.resultKey.slice(0, 12), envFingerprint: fresh.envFingerprint, ready: fresh.ready } : null, shown: newShown, planeText: newHtml?.slice(0, 40) ?? null };
    if (xstore) {
      await xstore.put('finish', { at: Date.now(), reason: fresh ? 'fresh' : 'gave-up' }).catch(() => {});
      xfinished = true;
      const hostResult = await xstore.wait('host', Date.now() + 120_000);
      out.steps.a5.hostResult = hostResult ? { ok: hostResult.ok, fails: hostResult.fails, exitCode: hostResult.exitCode ?? null, released: hostResult.released ?? null, ms: hostResult.ms ?? null } : null;
      check(hostResult?.ok, 'A5:外部主机的结果行 ok(正常退出、放回认领)', out.steps.a5.hostResult);
    }
    say('a5.done', out.steps.a5);
    }
  }
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
  for (const [name, page] of [['creator', state.creator], ['member', state.member]]) if (page) await shot(page, `fatal-${name}`).catch(() => {});
} finally {
  try { watcherRef?.close(); } catch { /* 已关 */ }
  await stopCutProxy(cutProxyRef).catch(() => {});
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
  for (const s of proxies) await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  try { await combo?.close(); } catch { /* 已关 */ }
  out.cleanup = { deleted, listening: [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.node, PORTS.node + 1, PORTS.node + 2].filter((p) => pidOnPort(p)) };
  if (!KEEP) {
    for (const d of fs.readdirSync(TMP)) {
      const p = path.join(TMP, d);
      if (path.resolve(p) === OUT) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 句柄还没放 */ }
    }
  }
  out.ms = Date.now() - started;
  out.fails = fails;
  out.ok = fails.length === 0;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
