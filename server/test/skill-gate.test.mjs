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
 * 跑法:先起 dev server(npm run dev),再 node server/test/skill-gate.test.mjs <仓库根>
 * 默认打 5190。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:5190";
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) failed++; };
const j = async (u, init) => { const r = await fetch(BASE + u, init); return { status: r.status, d: await r.json().catch(() => null) }; };
const post = (u, body) => j(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

const ROOT = process.env.PROMPTCUT_SKILL_DIR || path.join(os.homedir(), "Documents", "PromptCut-Skill");
const STATE = path.join(ROOT, "skill-state.json");

// 直接 import 闸门模块来测 checkGate 的两种进程身份 —— 走 HTTP 的话没法伪装成无头实例
const gateUrl = new URL("../../../../../../Documents/PromptCut/server/skill-gate.mjs", import.meta.url).href;
const gate = await import(process.argv[2]
  ? "file:///" + process.argv[2].replace(/\\/g, "/") + "/server/skill-gate.mjs"
  : gateUrl);

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

console.log(failed ? `\n${failed} 项失败` : "\nALL PASS");
process.exit(failed ? 1 : 0);
