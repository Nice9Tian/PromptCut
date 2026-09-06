/**
 * PromptCut — 出一个完整版本：安装包 + 更新补丁。
 *
 * 一次发布产出两个东西，放在 desktop/release/ 下：
 *   PromptCut-<版本>-setup.exe   完整安装包（约 1 GB，第一次装或者外壳变了用它）
 *   PromptCut-patch-<版本>.zip   更新补丁（只有 Node 那半边，通常几 MB）
 *
 *   node scripts/build-release.mjs                # 全套
 *   node scripts/build-release.mjs --from-head    # 源码取自 HEAD，忽略未提交改动
 *   node scripts/build-release.mjs --patch-only   # 只出补丁，跳过 Rust 编译
 *   node scripts/build-release.mjs --skip-runtime # runtime 已就绪，直接编译打包
 *   node scripts/build-release.mjs --with-deps    # 补丁强制带上 node_modules
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const BUNDLE_DIR = path.join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle", "nsis");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0);

function run(label, cmd, args, opts = {}) {
  console.log(`\n── ${label} ──`);
  const r = spawnSync(cmd, args, { cwd: DESKTOP_DIR, stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`[FAIL] ${label} 失败（退出码 ${r.status}）`);
    process.exit(1);
  }
}

const shellVersion = JSON.parse(
  fs.readFileSync(path.join(DESKTOP_DIR, "src-tauri", "tauri.conf.json"), "utf-8")
).version;

console.log("PromptCut build-release");
console.log(`  外壳版本：${shellVersion}（Rust 那半边，只在需要重编时才变）`);

/**
 * --from-head：源码取自 HEAD 的一棵临时 worktree，而不是当前工作区。
 *
 * 好几个人共用一个工作区时，别人没提交完的改动就躺在那里；直接打包会把它们
 * 一起发出去，而且事后无从判断产物到底对应哪一版代码。从 HEAD 取源码，产物
 * 就一定对得上一个 commit。
 *
 * 只有源码走 worktree：Chrome / ffmpeg / Python / Rust 编译缓存仍然用
 * desktop/ 下原来那份，所以不会因此多花下载和编译时间。
 */
let sourceArgs = [];
let worktree = null;
if (has("--from-head")) {
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: PROJECT_ROOT, encoding: "utf8" }).stdout || "";
  const head = (spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).stdout || "").trim();
  worktree = path.join(DESKTOP_DIR, ".cache", "release-src");
  console.log(`\n── 从 HEAD (${head}) 取源码 ──`);
  const excluded = dirty.split(/\r?\n/).filter((l) => l.trim() && !/^\?\?/.test(l));
  if (excluded.length) {
    console.log(`  工作区有 ${excluded.length} 个文件未提交，本次发布不包含它们：`);
    for (const l of excluded.slice(0, 12)) console.log(`    ${l.trim()}`);
    if (excluded.length > 12) console.log(`    …还有 ${excluded.length - 12} 个`);
  }
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: PROJECT_ROOT, stdio: "ignore" });
  spawnSync("git", ["worktree", "prune"], { cwd: PROJECT_ROOT, stdio: "ignore" });
  const add = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: PROJECT_ROOT, stdio: "inherit" });
  if (add.status !== 0) {
    console.error("[FAIL] 建不出 worktree");
    process.exit(1);
  }
  sourceArgs = ["--source", worktree];
}

function cleanupWorktree() {
  if (!worktree) return;
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: PROJECT_ROOT, stdio: "ignore" });
  spawnSync("git", ["worktree", "prune"], { cwd: PROJECT_ROOT, stdio: "ignore" });
  worktree = null;
}
process.on("exit", cleanupWorktree);

if (!has("--skip-runtime") && !has("--patch-only")) {
  run("组装 runtime", "node", ["scripts/prepare-runtime.mjs", ...sourceArgs]);
} else {
  run("检查 runtime", "node", ["scripts/prepare-runtime.mjs", "--check", ...sourceArgs]);
}
// runtime/app 已经拷好，worktree 的使命就完成了；后面的步骤都不再读源码。
cleanupWorktree();

// 版本号以 runtime/app 里那份为准 —— 它才是真正被打进产物的源码。
const appVersion = JSON.parse(
  fs.readFileSync(path.join(DESKTOP_DIR, "src-tauri", "runtime", "app", "package.json"), "utf-8")
).version;
console.log(`\n  应用版本：${appVersion}`);

if (!has("--patch-only")) {
  run("构建安装包（Rust 编译 + NSIS）", "npx", ["tauri", "build"]);
}

// 补丁要在安装包之后出：两者用的是同一份 runtime/app，顺序反了会对不上。
const patchArgs = ["scripts/make-patch.mjs"];
if (has("--with-deps")) patchArgs.push("--with-deps");
if (has("--no-deps")) patchArgs.push("--no-deps");
if (has("--from-head")) patchArgs.push("--skip-source-check");
if (has("--zip")) patchArgs.push("--zip");
run("打更新补丁", "node", patchArgs);

// ── 收集产物 ──────────────────────────────────────────────────────────
fs.mkdirSync(RELEASE_DIR, { recursive: true });
const results = [];

if (!has("--patch-only")) {
  // tauri 按外壳版本命名，这里按应用版本另存一份，免得两个不同内容的
  // 安装包重名（外壳不动、应用升级时就会这样）。
  const src = path.join(BUNDLE_DIR, `PromptCut_${shellVersion}_x64-setup.exe`);
  if (!fs.existsSync(src)) {
    console.error(`[FAIL] 找不到安装包：${src}`);
    process.exit(1);
  }
  const dest = path.join(RELEASE_DIR, `PromptCut-${appVersion}-setup.exe`);
  fs.copyFileSync(src, dest);
  results.push(dest);
}

for (const ext of ["exe", "zip"]) {
  const p = path.join(RELEASE_DIR, `PromptCut-patch-${appVersion}.${ext}`);
  if (fs.existsSync(p)) results.push(p);
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(RELEASE_DIR, `manifest-${appVersion}.json`), "utf-8")
);

console.log(`\n══ 完成（${elapsed()}s）══`);
for (const f of results) {
  console.log(`  ${(fs.statSync(f).size / 1048576).toFixed(1).padStart(8)} MB  ${path.basename(f)}`);
}
console.log(`\n  补丁含依赖：${manifest.includesDeps ? "是" : "否"}（${manifest.depsReason}）`);
console.log(`  补丁适用于：外壳 ${manifest.minShellVersion} 或更新`);
console.log(`  产物目录：${RELEASE_DIR}`);
