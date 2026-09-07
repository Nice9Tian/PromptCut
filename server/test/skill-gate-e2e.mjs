/**
 * 端到端:闸门对**真的无头实例**管不管用。
 *
 * 前面那份自检是直接调 checkGate,证明的是函数本身。这一份起一个真的无头 PromptCut,
 * 走 /api/mcp/call 下工具,证明的是**整条链路**:闸关掉之后,agent 那边下的 add_clip
 * 一张卡都落不到项目里。
 * 跑法:node server/test/skill-gate-e2e.mjs <仓库根>。它自己起一份无头实例,不需要 dev server。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) failed++; };

const SKILL_ROOT = process.env.PROMPTCUT_SKILL_DIR || path.join(os.homedir(), "Documents", "PromptCut-Skill");
const JOB = path.join(SKILL_ROOT, "gate-e2e");
fs.rmSync(JOB, { recursive: true, force: true });
fs.mkdirSync(JOB, { recursive: true });

const proc = {
  format: "promptcut-project", version: 1, savedAt: new Date().toISOString(), thumbnail: null,
  project: {
    version: 1, name: "闸门 e2e", width: 1920, height: 1080, fps: 30, duration: 12,
    themeId: "default", media: [], tracks: [{ id: "t-1", name: "序列 1", clips: [] }],
  },
};
fs.writeFileSync(path.join(JOB, "project.proc"), JSON.stringify(proc, null, 2));
fs.writeFileSync(path.join(JOB, "base.proc"), JSON.stringify(proc, null, 2));

// 闸门状态得指向这个任务,壳/面板才知道读哪份 proc
const gate = await import("file:///" + ROOT.replace(/\\/g, "/") + "/server/skill-gate.mjs");
gate.openGate({ jobId: "gate-e2e", jobDir: JOB, procPath: path.join(JOB, "project.proc") });

console.log("起无头实例…");
const child = spawn(process.execPath, [path.join(ROOT, "scripts", "headless.mjs"), "--job", JOB, "--idle-hours", "1"], {
  cwd: ROOT, stdio: "ignore", detached: true, windowsHide: true,
});
child.unref();

let inst = null;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  try { inst = JSON.parse(fs.readFileSync(path.join(JOB, "instance.json"), "utf8")); } catch {}
  if (inst?.ready || inst?.error) break;
}
ok(inst?.ready === true, `实例就绪 port=${inst?.port} ${inst?.error || ""}`);
if (!inst?.ready) { console.log("\n起不来,后面不用测了"); process.exit(1); }

const PORT = inst.port;
const call = async (tool, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/mcp/call`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return r.json();
};
/** 直接数磁盘上那份 —— 闸关之后 get_project 也被拦,只能这样看 */
const countOnDisk = () => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(JOB, "project.proc"), "utf8"));
    return d.project.tracks.reduce((n, t) => n + (t.clips?.length ?? 0), 0);
  } catch { return -1; }
};
const clipCount = async () => {
  const p = await call("get_project");
  const tracks = p?.result?.tracks ?? [];
  return tracks.reduce((n, t) => n + (t.clips?.length ?? 0), 0);
};

// ── 闸开:能加卡 ──────────────────────────────────────────────
const before = await clipCount();
let r = await call("add_clip", { cardId: "mu-number-ticker", start: 1, duration: 2 });
ok(r?.ok === true && !r.result?.skillClosed, `闸开 → add_clip 成功(${JSON.stringify(r?.result?.id || r?.error || "").slice(0, 40)})`);
const afterOpen = await clipCount();
ok(afterOpen === before + 1, `闸开 → 卡片数 ${before} → ${afterOpen}`);

// ── 闸关:一张都加不进去 ──────────────────────────────────────
// 无头实例每秒才写一次盘。断言之前先等它把闸开时那张卡落下去,
// 否则测的是「flush 有没有跑过」,不是「闸门挡没挡住」。
await sleep(2500);
const diskBefore = countOnDisk();
ok(diskBefore === afterOpen, `闸关前磁盘上 ${diskBefore} 张,和内存一致`);

gate.closeGate("user");
await sleep(300);

r = await call("add_clip", { cardId: "mu-number-ticker", start: 5, duration: 2 });
ok(r?.result?.skillClosed === true, `闸关 → add_clip 被拦(skillClosed=${r?.result?.skillClosed})`);
ok(/SKILL 模式已经关闭/.test(r?.result?.message || ""), "拦下来时给的是「已经关闭」的说明");
ok(/不要重试/.test(r?.result?.message || ""), "说明里让它别重试");

// 再等两轮写回:就算 flush 照常在跑,磁盘上也不该多出那张被拦下的卡
await sleep(2500);
const afterClose = countOnDisk();
ok(afterClose === diskBefore, `闸关之后没有新卡落盘:还是 ${afterClose} 张(闸关前 ${diskBefore} 张)`);

// 别的会改动的工具一样拦
r = await call("remove_clip", { clipId: "whatever" });
ok(r?.result?.skillClosed === true, "闸关 → remove_clip 也被拦(不是只挡了 add_clip)");

// ── 重新打开:又能干活了 ──────────────────────────────────────
gate.openGate({ jobId: "gate-e2e", jobDir: JOB, procPath: path.join(JOB, "project.proc") });
await sleep(200);
r = await call("add_clip", { cardId: "mu-number-ticker", start: 8, duration: 2 });
ok(r?.ok === true && !r.result?.skillClosed, "重新打开 → 又能加卡了(闸门可逆)");

// 收尾
gate.closeGate("test-cleanup");
fs.writeFileSync(path.join(JOB, "stop"), "");
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  try { if (JSON.parse(fs.readFileSync(path.join(JOB, "instance.json"), "utf8")).stopped) break; } catch {}
}
fs.rmSync(JOB, { recursive: true, force: true });

console.log(failed ? `\n${failed} 项失败` : "\nALL PASS");
process.exit(failed ? 1 : 0);
