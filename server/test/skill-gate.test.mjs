/**
 * SKILL 闸门自检。核心断言只有一条:**开关关掉之后,无头实例的工具调用不许落地**。
 *
 *   1. /api/skill-mode 默认关着
 *   2. open → active=true
 *   3. 无头进程 + 闸开 → 放行
 *   4. 无头进程 + 闸关 → 拒绝,而且给的是能读懂的说明
 *   5. 非无头进程 → 永远放行(用户自己那份不受影响)
 *   6. 状态文件写坏 / 不存在 → 按「关着」处理(默认拒绝)
 *   7. .proc 锁:非 SKILL 模式独占,SKILL 模式跳过
 *
 * 这是对**真实 dev server** 跑的集成测试,会发写请求(关、开 SKILL 模式,占、放独占锁),
 * 还会直接改写、删除 SKILL 目录里的 skill-state.json。所以只在显式开启时才跑:
 *   - `PROMPTCUT_BASE` 指向一台**自己起的** dev server;不设就跳过,永不缺省连 5190。
 *     指向 5190～5192(用户常驻的编辑台和它的舞台端口)也跳过,防止误设。
 *   - `PROMPTCUT_SKILL_DIR` 指向一个临时目录,那台 dev server 启动时也要带同一个值;
 *     不设就跳过 —— 缺省目录 ~/Documents/PromptCut-Skill 是用户的数据。
 * 不设时 `npm test` 把它计入 skipped。
 *
 * 跑法(PowerShell):
 *   $env:PROMPTCUT_SKILL_DIR = "<临时目录>"
 *   npx vite --port 5680 --strictPort --host 127.0.0.1      # 另一个窗口起,带同一个 PROMPTCUT_SKILL_DIR
 *   $env:PROMPTCUT_BASE = "http://127.0.0.1:5680"
 *   node --test server/test/skill-gate.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const RESERVED_PORTS = new Set(["5190", "5191", "5192"]);
const USER_SKILL_DIR = path.join(os.homedir(), "Documents", "PromptCut-Skill");
const OPT_IN = "对真实 dev server 跑的集成测试,设 PROMPTCUT_BASE 指向一台自己起的 dev server 才跑;永不缺省连 5190";

/** 该不该跳过:返回原因字符串,或 false 表示可以跑。 */
function skipReason() {
  const base = process.env.PROMPTCUT_BASE;
  if (!base) return OPT_IN;
  let u;
  try { u = new URL(base); } catch { return `PROMPTCUT_BASE 不是合法地址(${base});${OPT_IN}`; }
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (RESERVED_PORTS.has(port)) return `PROMPTCUT_BASE 指向 ${port}:5190～5192 是用户常驻的编辑台和它的舞台端口,拒绝对它跑`;
  const dir = process.env.PROMPTCUT_SKILL_DIR;
  if (!dir) return "还要设 PROMPTCUT_SKILL_DIR 指向临时目录(dev server 带同一个值):本测试会改写、删除其中的 skill-state.json,缺省目录是用户的数据";
  if (path.resolve(dir).toLowerCase() === path.resolve(USER_SKILL_DIR).toLowerCase()) return `PROMPTCUT_SKILL_DIR 指向用户的 ${USER_SKILL_DIR},拒绝改写`;
  return false;
}

const SKIP = skipReason();
const BASE = SKIP ? "" : process.env.PROMPTCUT_BASE.replace(/\/+$/, "");
const ROOT = process.env.PROMPTCUT_SKILL_DIR || "";
const STATE = path.join(ROOT, "skill-state.json");

test("SKILL 闸门:闸关之后无头实例的工具调用不落地", { skip: SKIP }, async () => {
  let failed = 0;
  const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) failed++; };
  const j = async (u, init) => { const r = await fetch(BASE + u, init); return { status: r.status, d: await r.json().catch(() => null) }; };
  const post = (u, body) => j(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  // 显式开启了却连不上:算失败,不静默跳过(开了就是要跑)。
  const probe = await fetch(BASE + "/api/skill-mode").catch((e) => e);
  assert.ok(!(probe instanceof Error), `PROMPTCUT_BASE=${BASE} 连不上:${probe?.message}`);

  // 直接 import 闸门模块来测 checkGate 的两种进程身份 —— 走 HTTP 的话没法伪装成无头实例。
  // 按本文件的位置算(server/test/ 的上一层就是 server/)。
  const gate = await import(new URL("../skill-gate.mjs", import.meta.url).href);

  // 1. 默认关着
  await post("/api/skill-mode/close", { by: "test-reset" });
  let r = await j("/api/skill-mode");
  ok(r.d?.ok && r.d.state.active === false, `默认关着 → active=${r.d?.state?.active}`);

  // 2. open
  r = await post("/api/skill-mode/open", { jobId: "gate-test", jobDir: ROOT, procPath: null });
  ok(r.d?.ok && r.d.state.active === true && r.d.state.jobId === "gate-test", `open → active=${r.d?.state?.active} job=${r.d?.state?.jobId}`);
  ok(fs.existsSync(STATE), `状态文件落盘:${STATE}`);

  // 3. 无头 + 闸开 → 放行
  process.env.PROMPTCUT_HEADLESS = "1";
  ok(gate.checkGate("add_clip").ok === true, "无头 + 闸开 → 放行");

  // 4. 无头 + 闸关 → 拒绝
  await post("/api/skill-mode/close", { by: "user" });
  const denied = gate.checkGate("add_clip");
  ok(denied.ok === false, "无头 + 闸关 → 拒绝");
  ok(/SKILL 模式已经关闭/.test(denied.message || ""), "拒绝时给了「已经关闭」的说明");
  ok(/不要重试/.test(denied.message || ""), "说明里让它别重试(不然会死循环)");
  ok(/add_clip/.test(denied.message || ""), "说明里点名是哪个工具");
  ok(/没有\*\*任何改动|没有.{0,4}改动/.test(denied.message || ""), "说明里讲清楚项目没被改");

  // 5. 非无头 → 永远放行
  delete process.env.PROMPTCUT_HEADLESS;
  ok(gate.checkGate("add_clip").ok === true, "非无头(用户自己那份)→ 放行,不受闸门影响");

  // 6. 状态文件坏了 → 按关着处理
  process.env.PROMPTCUT_HEADLESS = "1";
  const backup = fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf8") : null;
  fs.writeFileSync(STATE, "{ 这不是 JSON");
  ok(gate.readState().active === false, "状态文件坏了 → 按关着处理");
  ok(gate.checkGate("add_clip").ok === false, "坏文件时默认拒绝(而不是默认放行)");
  fs.unlinkSync(STATE);
  ok(gate.readState().active === false, "状态文件不存在 → 按关着处理");
  if (backup) fs.writeFileSync(STATE, backup);
  delete process.env.PROMPTCUT_HEADLESS;

  // 6b. 无头实例不许自己开闸 —— 这是实测踩出来的:少了这道拦,agent 那份页面会把
  //     用户刚关掉的闸又打开,继续往项目里写(端到端里多落了一张卡)
  process.env.PROMPTCUT_HEADLESS = "1";
  await post("/api/skill-mode/close", { by: "user" });
  const refused = gate.openGate({ jobId: "sneaky" });
  ok(refused.active === false, "无头实例调 openGate → 闸还是关着");
  ok(/无头实例不能自己打开/.test(refused.refused || ""), "而且说明了为什么拒绝");
  ok(gate.checkGate("add_clip").ok === false, "被拒之后工具调用照样拦得住");
  delete process.env.PROMPTCUT_HEADLESS;

  // 7. .proc 锁
  const tmpProc = path.join(ROOT, "lock-test.proc");
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(tmpProc, "{}");
  await post("/api/skill-mode/close", { by: "test" });
  r = await post("/api/skill-lock/acquire", { path: tmpProc });
  ok(r.d?.ok === true && !r.d.skipped, "非 SKILL 模式 → 拿到独占锁");
  ok(fs.existsSync(tmpProc + ".lock"), "锁文件建出来了");

  // 伪造一个「别的活着的进程」持锁 —— 用当前测试进程的 pid,它显然活着
  fs.writeFileSync(tmpProc + ".lock", JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: "other" }));
  r = await post("/api/skill-lock/acquire", { path: tmpProc });
  ok(r.status === 409 && r.d?.ok === false && /被另一个 PromptCut 打开/.test(r.d.error || ""), `别人持锁 → 409 拒绝(${r.d?.error?.slice(0, 30)}…)`);

  // 死进程的锁应该能被接管,否则用户下次永远打不开
  fs.writeFileSync(tmpProc + ".lock", JSON.stringify({ pid: 999999, at: "2020-01-01T00:00:00Z", host: "dead" }));
  r = await post("/api/skill-lock/acquire", { path: tmpProc });
  ok(r.d?.ok === true && r.d.stolen === true, "持锁进程已死 → 接管(不然锁会永久卡住)");

  await post("/api/skill-mode/open", { jobId: "lock-test" });
  await post("/api/skill-lock/release", { path: tmpProc });
  r = await post("/api/skill-lock/acquire", { path: tmpProc });
  ok(r.d?.ok === true && r.d.skipped === "skill-mode", "SKILL 模式 → 跳过独占(壳和用户那份都要读)");

  // 收尾
  await post("/api/skill-mode/close", { by: "test-cleanup" });
  try { fs.unlinkSync(tmpProc); } catch {}
  try { fs.unlinkSync(tmpProc + ".lock"); } catch {}


  assert.equal(failed, 0, `${failed} 项失败(见上面的 FAIL 行)`);
});
