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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let instance = { ready: false, port: null, pid: process.pid, vitePid: null, startedAt: new Date().toISOString(), dirty: false, savedAt: null };
function writeInstance(patch = {}) {
  instance = { ...instance, ...patch, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(INSTANCE, JSON.stringify(instance, null, 2)); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  try { if (browser) await browser.close(); } catch {}
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
  writeInstance({ port });

  // ── 1. vite ──────────────────────────────────────────────────────
  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const env = {
    ...process.env,
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

  // ?draft=project 由 Shell 打开任务目录里的 project.proc 并直接进编辑器;
  // ?headless=1 让页面装上 window.__pcHeadless(自动写回用)
  await page.goto(`http://127.0.0.1:${port}/?draft=project&headless=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitHttp(`http://127.0.0.1:${port}/api/mcp/status`, (d) => d && d.editorConnected === true, 90000, "等编辑器连上 MCP 桥");
  await page.waitForFunction(() => !!window.__pcHeadless, { timeout: 30000 });
  log("编辑器页面已连上 MCP 桥");
  writeInstance({ ready: true });

  // ── 3. 写回循环 ──────────────────────────────────────────────────
  let lastActivity = Date.now();
  let lastFingerprint = "";
  while (!stopping) {
    if (fs.existsSync(STOP)) {
      // 最后再 flush 一次,别把 agent 最后一步改动丢了
      try { await page.evaluate(() => window.__pcHeadless.flush()); } catch {}
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
      writeInstance({ dirty: st.dirty, savedAt: st.savedAt, name: st.name, clips: st.clips, lastError: st.error || null });
    } catch (e) {
      log(`页面没响应:${e.message}`);
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
