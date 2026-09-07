/**
 * .proc 独占锁的自检。跑:node --test server/test/proc-lock.test.mjs
 *
 * 这把锁分两层,各有各的失效方式,所以两层都要单独钉:
 *
 *   Node 那半(原子 wx + pid 兜底):挡得住并发抢,但持有者被**强杀**之后锁文件留在
 *     原地,只能靠 pid 判活 —— 而 pid 会被系统回收,有误判的余地;
 *   外壳那半(Windows 共享模式 0):句柄由内核管,**进程一死内核立刻收走**,没有残留锁。
 *
 * 所以这里测的是:
 *   1. 并发抢只有一个赢(wx 的原子性,不是「先查再写」那种假原子);
 *   2. 持有者正常退出后,锁能被下一个拿到;
 *   3. 持有者被**强杀**之后,内核那层立刻放开(这一条是 Node 单独做不到的);
 *   4. 被内核握着时,别的进程连**删**都删不掉(偷不走锁);
 *   5. 锁的是旁路 .lock 文件,**不是 .proc 本体** —— 本体必须始终可读可写,
 *      否则自家 sidecar 会被自己挡在门外。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lock-"));
const PROC = path.join(TMP, "x.proc");
const LOCK = PROC + ".lock";
fs.writeFileSync(PROC, JSON.stringify({ format: "promptcut-project", version: 1 }), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个子进程,用共享模式 0 握住锁文件,一直握到被杀 */
function holder() {
  const script = `
    const fs = require('node:fs');
    // Node 没有 share_mode,用 PowerShell 那套开不了;这里用独占创建(wx)代表 Node 那层,
    // 内核那层由下面的 PowerShell 持有者测
    const fd = fs.openSync(${JSON.stringify(LOCK)}, 'wx');
    process.stdout.write('HELD\\n');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
}

/** 用 PowerShell 拿一个共享模式 0 的句柄,模拟外壳那层 */
function kernelHolder() {
  const ps = [
    "$f = [System.IO.File]::Open(" + JSON.stringify(LOCK) + ", 'OpenOrCreate', 'ReadWrite', 'None')",
    "Write-Output 'HELD'",
    "while ($true) { Start-Sleep -Milliseconds 200 }",
  ].join("; ");
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

const waitHeld = (child) =>
  new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("持有者没起来")), 15000);
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("HELD")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

const kill = (child) => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
};

test("并发抢锁只有一个赢(wx 是原子的,不是先查再写)", async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const script = `
    const fs = require('node:fs');
    try { fs.writeFileSync(${JSON.stringify(LOCK)}, String(process.pid), { flag: 'wx' }); process.stdout.write('WON'); }
    catch { process.stdout.write('LOST'); }
  `;
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      new Promise((resolve) => {
        let out = "";
        const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
        c.stdout.on("data", (b) => (out += b));
        c.on("exit", () => resolve(out));
      }),
    ),
  );
  assert.equal(results.filter((r) => r === "WON").length, 1, "恰好一个进程该抢到");
  fs.unlinkSync(LOCK);
});

test("持有者正常退出后,锁能被下一个拿到", async () => {
  const h = holder();
  await waitHeld(h);
  assert.throws(() => fs.writeFileSync(LOCK, "me", { flag: "wx" }), /EEXIST/, "持有期间抢不到");
  h.kill();
  await sleep(300);
  fs.unlinkSync(LOCK); // 正常退出这一路由调用方删锁
  fs.writeFileSync(LOCK, "next", { flag: "wx" });
  fs.unlinkSync(LOCK);
});

test("被内核句柄握着时:打不开、删不掉;强杀之后立刻放开", { skip: process.platform !== "win32" ? "只有 Windows 有共享模式" : false }, async () => {
  try { fs.unlinkSync(LOCK); } catch {}
  const h = kernelHolder();
  await waitHeld(h);

  // 1. 别的进程打不开 —— 这就是 Node 那半探测「有没有人握着」用的信号
  assert.throws(() => fs.closeSync(fs.openSync(LOCK, "r+")), (e) => e.code === "EBUSY", "该拿到 EBUSY");
  // 2. 连删都删不掉:锁偷不走
  assert.throws(() => fs.unlinkSync(LOCK), (e) => e.code === "EBUSY" || e.code === "EPERM", "该删不掉");

  // 3. 强杀持有者(进程没有机会做任何清理),内核立刻收走句柄
  kill(h);
  let freed = false;
  for (let i = 0; i < 40 && !freed; i++) {
    await sleep(250);
    try { fs.closeSync(fs.openSync(LOCK, "r+")); freed = true; } catch { /* 还握着 */ }
  }
  assert.ok(freed, "强杀之后内核该把句柄收走 —— 这正是 Node 那层做不到的");
  fs.unlinkSync(LOCK);
});

test("锁的是旁路 .lock,.proc 本体始终可读可写", { skip: process.platform !== "win32" ? "只有 Windows 有共享模式" : false }, async () => {
  const h = kernelHolder();
  await waitHeld(h);
  // 本体必须一直能读能写:它正是自家 sidecar 要操作的文件,锁住本体等于把自己挡在门外
  assert.doesNotThrow(() => fs.readFileSync(PROC, "utf8"), "本体该能读");
  assert.doesNotThrow(() => fs.appendFileSync(PROC, ""), "本体该能写");
  kill(h);
  await sleep(500);
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
