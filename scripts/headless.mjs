/**
 * 无头 PromptCut:给 agent 用的一份独立实例。
 *
 *   node scripts/headless.mjs --job <任务目录> [--port N] [--idle-hours 8]
 *
 * 做的事:
 *   1. 在空闲端口上再起一个 vite(和用户正在用的那份完全隔离:自己的端口、自己的草稿目录、
 *      自己的依赖缓存),草稿目录就是任务目录,所以 project.proc 就是这个实例的当前项目;
 *   2. 用 puppeteer 开一张**不可见**的编辑器页面连上 MCP 桥 —— 所有工具都在页面里执行,
 *      没有页面就没有工具,这一步省不掉;
 *   3. 每秒问页面一次「脏了没」,脏了就写回 project.proc。agent 不用管保存;
 *   4. 把端口、pid、脏标记写进 <任务目录>/instance.json,pc-tool.mjs 和 Skill 对话框都读它;
 *   5. 任务目录里出现 stop 文件、或空转超过 idle-hours,就整个收掉。
 *
 * 为什么不是 Python、不是"直接对接渲染内核":这个软件的渲染内核就是 React + DOM,
 * 项目状态住在页面的 store 里,离开浏览器什么都渲不出来、什么工具都没有。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
};
const JOB = flag("--job") ? path.resolve(flag("--job")) : null;
if (!JOB || !fs.existsSync(JOB)) {
  console.error("用法:node scripts/headless.mjs --job <任务目录>");
  process.exit(1);
}
const IDLE_MS = Number(flag("--idle-hours", "8")) * 3600 * 1000;
const LOG = path.join(JOB, "headless.log");
const INSTANCE = path.join(JOB, "instance.json");
const STOP = path.join(JOB, "stop");

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
  process.stdout.write(line);
};

/**
 * 挑一个空闲端口,**必须避开「坏端口」黑名单**。
 *
 * 原来用 listen(0) 让系统随便给,结果给到过 6000(X11)—— 那一整趟就废了:
 * Node 的 fetch(undici)按 WHATWG 规范直接拒绝这些端口,报 `bad port`,连都不连;
 * Chrome 也有同一份黑名单(ERR_UNSAFE_PORT),就算 Node 放行,puppeteer 那步也打不开页面。
 * 黑名单里最大的是 10080,所以直接从 20000 以上随机挑,按构造就绕开了整份名单。
 */
function freePort(tries = 50) {
  const pick = () => 20000 + Math.floor(Math.random() * 40000);
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      if (left <= 0) return reject(new Error("找不到空闲端口"));
      const port = pick();
      const srv = net.createServer();
      srv.unref();
      srv.on("error", () => attempt(left - 1));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(port)));
    };
    attempt(tries);
  });
}

let instance = { ready: false, port: null, pid: process.pid, vitePid: null, startedAt: new Date().toISOString(), dirty: false, savedAt: null };
function writeInstance(patch = {}) {
  instance = { ...instance, ...patch, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(INSTANCE, JSON.stringify(instance, null, 2)); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给一个可能永远不返回的 promise 加硬性熔断。
 *
 * 收工路径上每一步都得有它:page.evaluate 在 puppeteer 里是**无限期等**的,页面卡死或者
 * saveDraft 挂在一个不返回的请求上,最后那次 flush 就再也回不来 —— shutdown() 永远走不到,
 * Node、隐藏的 Chrome、vite 子进程连同端口一起留在系统里,而这个实例是没人会去手动收的
 * 那一个。宁可丢掉最后一次写回,也不能留一窝僵尸进程。
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms); }),
  ]);
}

async function waitHttp(url, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (pred(data)) return data;
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`${label} 超时(${Math.round(timeoutMs / 1000)}s)`);
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
  } else {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

let vite = null;
let browser = null;
let stopping = false;

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`收工:${reason}`);
  writeInstance({ ready: false, stopped: true, stopReason: reason });
  // browser.close() 也会等页面把 beforeunload 之类跑完,同样可能不返回;超时就直接往下走,
  // 反正 Chrome 是 puppeteer 起的子进程,killTree 收得掉
  try { if (browser) await withTimeout(browser.close(), 8000, "关闭浏览器"); } catch (e) { log(`关浏览器没成:${e.message}`); }
  try { killTree(browser?.process()?.pid); } catch {}
  killTree(vite?.pid);
  // 给 taskkill 一点时间,然后退出
  await sleep(600);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  const port = Number(flag("--port")) || (await freePort());
  log(`任务目录 ${JOB},端口 ${port}`);

  /*
   * 两把钥匙,**在起 vite 之前就生成**,因为要通过环境变量交给服务端 —— 服务端拿到之后
   * 才能在页面这一层就做判断,而不是等到某个请求打进来再说。
   *
   *   ownerToken  谁是编辑台。带着它连 MCP 桥的那个页面是主人,别人抢不走(a8a6ee8)。
   *               无头实例自己用。
   *   viewToken   只读浏览。带着它能把编辑台**打开看**,但保存会被服务端拒掉。
   *               这一把是给 agent 的:它拿到的是一条完整链接,不需要记住「要加什么后缀」。
   *
   * 为什么要分成两把而不是一把当两用:同一把的话,把 view= 改成 owner= 就能变成主人。
   * agent 不是敌人,但它会照着自己的理解改 URL —— 两把钥匙让这件事做不到。
   */
  const rnd = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  const ownerToken = `own-${process.pid}-${rnd()}`;
  const viewToken = `view-${process.pid}-${rnd()}`;
  const viewUrl = `http://127.0.0.1:${port}/?draft=project&view=${encodeURIComponent(viewToken)}`;
  writeInstance({ port, ownerToken, viewToken, viewUrl });

  // ── 1. vite ──────────────────────────────────────────────────────
  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const env = {
    ...process.env,
    PROMPTCUT_OWNER_TOKEN: ownerToken,
    PROMPTCUT_VIEW_TOKEN: viewToken,
    PROMPTCUT_HEADLESS: "1",
    // 草稿目录 = 任务目录:project.proc 就是这个实例的当前项目
    PROMPTCUT_PROJECTS_DIR: JOB,
    BROWSER: "none",
  };
  const out = fs.openSync(path.join(JOB, "vite.log"), "a");
  vite = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  writeInstance({ vitePid: vite.pid });
  vite.on("exit", (code) => {
    if (!stopping) {
      log(`vite 意外退出(code ${code})`);
      shutdown("vite 退出");
    }
  });

  await waitHttp(`http://127.0.0.1:${port}/api/mcp/status`, (d) => d && typeof d.port === "number", 90000, "等 vite 起来");
  log("vite 就绪");

  // ── 2. 不可见的编辑器页面 ────────────────────────────────────────
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: [
      "--window-position=-32000,-32000",
      "--hide-scrollbars",
      "--no-first-run",
      "--disable-gpu",
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 960 });
  page.on("pageerror", (e) => log(`页面错误:${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") log(`页面 console.error:${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) log(`页面请求 ${r.status()} ${r.request().method()} ${r.url()}`); });

  /*
   * ?owner=<令牌> 宣示所有权:带着它连上 MCP 桥之后,服务端会拒绝一切没有同一把钥匙的
   * 连接。没有这一步,agent 拿自己的浏览器打开这个端口「看一眼」就会把这个页面踢掉,
   * 之后它自己的所有工具调用全部失败 —— 而被踢的一方不会自己回来。
   * 两把钥匙都在上面 main() 开头生成,并已经通过环境变量交给了服务端。
   */
  log(`只读链接:${viewUrl}`);

  // ?draft=project 由 Shell 打开任务目录里的 project.proc 并直接进编辑器;
  // ?headless=1 让页面装上 window.__pcHeadless(自动写回用)
  await page.goto(`http://127.0.0.1:${port}/?draft=project&headless=1&owner=${encodeURIComponent(ownerToken)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitHttp(`http://127.0.0.1:${port}/api/mcp/status`, (d) => d && d.editorConnected === true, 90000, "等编辑器连上 MCP 桥");
  await page.waitForFunction(() => !!window.__pcHeadless, { timeout: 30000 });
  log("编辑器页面已连上 MCP 桥");
  writeInstance({ ready: true });

  // ── 3. 写回循环 ──────────────────────────────────────────────────
  let lastActivity = Date.now();
  let lastFingerprint = "";
  while (!stopping) {
    if (fs.existsSync(STOP)) {
      // 最后再 flush 一次,别把 agent 最后一步改动丢了 —— 但收工不能被它拖住,见 withTimeout
      try { await withTimeout(page.evaluate(() => window.__pcHeadless.flush()), 5000, "收工前最后一次写回"); }
      catch (e) { log(`收工前的写回没成:${e.message}`); }
      try { fs.unlinkSync(STOP); } catch {}
      return shutdown("收到 stop");
    }
    try {
      const st = await page.evaluate(() => window.__pcHeadless.flush());
      const fp = `${st.name}|${st.clips}|${st.savedAt}`;
      if (st.saved || fp !== lastFingerprint) lastActivity = Date.now();
      lastFingerprint = fp;
      if (st.saved) log(`写回 project.proc(${st.clips} 张卡)`);
      if (st.error) log(`写回失败:${st.error}`);
      // 页面重载过的话 savedAt 会变回 null,别把 instance.json 里的旧值冲掉
      writeInstance({ dirty: st.dirty, savedAt: st.savedAt || instance.savedAt, name: st.name, clips: st.clips, lastError: st.error || null });
    } catch (e) {
      log(`页面没响应:${e.message}`);
      // 多半是页面重载了(开发期改源码触发)。等它把 __pcHeadless 装回来,而不是每秒报一次错
      try {
        await page.waitForFunction(() => !!window.__pcHeadless, { timeout: 30000 });
        log("页面重载后已恢复");
      } catch {
        log("页面 30 秒内没恢复");
      }
    }
    if (Date.now() - lastActivity > IDLE_MS) return shutdown(`空转超过 ${IDLE_MS / 3600000} 小时`);
    await sleep(1000);
  }
}

main().catch(async (e) => {
  log(`启动失败:${e.stack || e.message}`);
  writeInstance({ ready: false, error: e.message });
  await shutdown("启动失败");
  process.exit(1);
});
