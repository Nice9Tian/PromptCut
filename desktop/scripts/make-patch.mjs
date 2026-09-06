/**
 * PromptCut — Build an update patch from the assembled runtime.
 *
 * 绝大多数改动只落在 Node 那一半（源码 + dist，有时加上依赖），Rust 壳和
 * Chrome/ffmpeg/Python 这三个大块一动不动。完整安装包因此接近 1 GB，而这些
 * 改动本身通常只有几 MB。这个脚本把 runtime/app 里真正会变的部分单独打成一个
 * 可以覆盖到已安装目录上的补丁包。
 *
 *   node scripts/make-patch.mjs                # 依赖没变就不带 node_modules
 *   node scripts/make-patch.mjs --with-deps    # 强制带上 node_modules
 *   node scripts/make-patch.mjs --no-deps      # 强制不带（依赖变了会拒绝）
 *   node scripts/make-patch.mjs --base <file>  # 指定比较基准（release 清单）
 *
 * 前提是 runtime/app 已经由 prepare-runtime 组装好。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, "..");
const RUNTIME_DIR = path.join(DESKTOP_DIR, "src-tauri", "runtime");
const APP_DIR = path.join(RUNTIME_DIR, "app");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const STAGE_DIR = path.join(DESKTOP_DIR, ".cache", "patch-stage");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

/**
 * runtime/app 里不属于构建产物的东西：用户跑起来之后自己长出来的目录。
 * 补丁绝不能碰它们 —— 导出的视频和 AI 会话历史都在这里面。
 */
const RUNTIME_STATE = new Set([
  "node_modules",   // 单独处理：依赖变了才随包发出去
  "exports",        // 用户导出的视频
  ".pc-chats",      // AI 会话历史
  ".pc-work",       // 每个会话的附件工作目录
  "out",
  ".vite",
]);

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function sha256File(p) {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** app 目录里所有构建产物文件的相对路径（正斜杠），不含运行期状态和依赖。 */
function listPayloadFiles(dir = APP_DIR, base = "") {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (base === "" && RUNTIME_STATE.has(ent.name)) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listPayloadFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * 复制整棵目录树。node_modules 有几万个文件、嵌套很深，Windows 上用 robocopy
 * 比逐个 copyFileSync 快得多，也不会撞上 260 字符的路径上限。
 */
function copyTree(src, dest) {
  const r = spawnSync("robocopy.exe", [src, dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"], {
    stdio: "inherit", timeout: 1_800_000,
  });
  // robocopy 用退出码表示做了什么，0–7 都算成功，≥8 才是真出错。
  if (r.error || r.status === null || r.status >= 8) {
    fail(`复制 ${src} 失败（robocopy 代码 ${r.status}${r.error ? `，${r.error.message}` : ""}）`);
  }
}

function countTree(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else { files++; try { bytes += fs.statSync(full).size; } catch { /* skip */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

/**
 * 上一次发布的清单，用来判断依赖有没有变、哪些文件被删了。
 *
 * 必须排掉「本次这个版本自己的清单」：重跑一遍 make-patch 时它已经躺在
 * release/ 里了，拿它当基准就是和自己比——依赖当然一致，于是产出一个不带
 * node_modules 的补丁，装到真正的上一版上要么被 lock 校验拦下，要么(万一
 * 绕过了)缺包跑不起来。
 */
function findBaseManifest(appVersion) {
  const explicit = option("--base");
  if (explicit) {
    if (!fs.existsSync(explicit)) fail(`--base 指定的清单不存在：${explicit}`);
    return { path: explicit, data: JSON.parse(fs.readFileSync(explicit, "utf-8")) };
  }
  if (!fs.existsSync(RELEASE_DIR)) return null;
  const candidates = fs.readdirSync(RELEASE_DIR)
    .filter((n) => /^manifest-.*\.json$/.test(n))
    .map((n) => path.join(RELEASE_DIR, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const p of candidates) {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data.appVersion === appVersion) continue; // 自己，不能当基准
    return { path: p, data };
  }
  return null;
}

function main() {
  console.log("PromptCut make-patch");

  if (!fs.existsSync(APP_DIR)) fail(`runtime/app 不存在，先跑 npm run prepare-runtime`);
  const distIndex = path.join(APP_DIR, "dist", "index.html");
  if (!fs.existsSync(distIndex)) fail(`runtime/app/dist/index.html 不存在，先跑 npm run prepare-runtime`);

  const appPkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf-8"));
  // 防的是「改完源码忘了重跑 prepare-runtime，拿旧的 app 打补丁」。
  // --from-head 的发布刚刚在同一次调用里组装过 runtime/app，源码来自 HEAD 而不是
  // 工作区，跟工作区比反而会误报，所以那条路径跳过这一检查。
  if (!flag("--skip-source-check")) {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    if (appPkg.version !== rootPkg.version) {
      fail(`runtime/app 落后于源码（app ${appPkg.version} ≠ 源码 ${rootPkg.version}），先重跑 prepare-runtime`);
    }
  }
  const appVersion = appPkg.version;
  const shellVersion = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_DIR, "src-tauri", "tauri.conf.json"), "utf-8")
  ).version;

  const lockHash = sha256File(path.join(APP_DIR, "package-lock.json"));
  const base = findBaseManifest(appVersion);
  if (base) console.log(`  基准清单：${path.basename(base.path)}（app ${base.data.appVersion}）`);
  else console.log("  没有找到上一次发布的清单");

  // 依赖是否要随包发出去。lock 一样就不带，这才是「只改 Node 代码」的常见情形。
  let includesDeps;
  let depsReason;
  if (flag("--with-deps")) {
    includesDeps = true; depsReason = "命令行指定 --with-deps";
  } else if (flag("--no-deps")) {
    includesDeps = false; depsReason = "命令行指定 --no-deps";
  } else if (!base) {
    includesDeps = true; depsReason = "没有基准清单可比，保守起见带上依赖";
  } else if (base.data.lockHash !== lockHash) {
    includesDeps = true; depsReason = "package-lock.json 与基准不同";
  } else {
    includesDeps = false; depsReason = "package-lock.json 与基准一致";
  }
  console.log(`  依赖：${includesDeps ? "随包发出" : "不发"}（${depsReason}）`);
  if (!includesDeps && base && base.data.lockHash !== lockHash) {
    fail("依赖有变化，--no-deps 会产出一个装上去就跑不起来的补丁");
  }

  // ── 收集载荷 ──────────────────────────────────────────────────────
  const files = listPayloadFiles();
  const hashes = {};
  let payloadBytes = 0;
  for (const rel of files) {
    const full = path.join(APP_DIR, rel);
    hashes[rel] = sha256File(full);
    payloadBytes += fs.statSync(full).size;
  }
  console.log(`  构建产物：${files.length} 个文件，${mb(payloadBytes)} MB`);

  // 上一版有、这一版没有的文件。只删构建产物，用户数据不在这个集合里。
  const removed = base?.data?.files
    ? Object.keys(base.data.files).filter((rel) => !(rel in hashes))
    : [];
  if (removed.length) console.log(`  需要删除的旧文件：${removed.length} 个`);

  // ── 组装补丁目录 ──────────────────────────────────────────────────
  const stem = `PromptCut-patch-${appVersion}`;
  rmrf(STAGE_DIR);
  const root = path.join(STAGE_DIR, stem);
  const payloadDir = path.join(root, "payload");
  mkdirp(payloadDir);

  for (const rel of files) {
    const dest = path.join(payloadDir, rel);
    mkdirp(path.dirname(dest));
    fs.copyFileSync(path.join(APP_DIR, rel), dest);
  }

  let deps = null;
  if (includesDeps) {
    const src = path.join(APP_DIR, "node_modules");
    if (!fs.existsSync(src)) fail("要带依赖，但 runtime/app/node_modules 不存在");
    console.log("  复制 node_modules…");
    copyTree(src, path.join(payloadDir, "node_modules"));
    deps = countTree(path.join(payloadDir, "node_modules"));
    console.log(`  依赖：${deps.files} 个文件，${mb(deps.bytes)} MB`);
  }

  const manifest = {
    format: "promptcut-patch/1",
    appVersion,
    // 补丁不重编 Rust，所以只声明它需要的最低壳版本；壳没动时这一版和上一版一样。
    minShellVersion: shellVersion,
    builtAt: new Date().toISOString(),
    includesDeps,
    depsReason,
    lockHash,
    baseAppVersion: base?.data?.appVersion ?? null,
    baseLockHash: base?.data?.lockHash ?? null,
    payloadFiles: files.length,
    payloadBytes,
    depsFiles: deps?.files ?? 0,
    depsBytes: deps?.bytes ?? 0,
    removed,
    files: hashes,
  };
  fs.writeFileSync(path.join(root, "patch.json"), JSON.stringify(manifest, null, 2));

  fs.copyFileSync(path.join(__dirname, "apply-patch.ps1"), path.join(root, "apply-patch.ps1"));
  fs.copyFileSync(path.join(__dirname, "apply-patch.cmd"), path.join(root, "安装更新.cmd"));
  fs.writeFileSync(path.join(root, "README.txt"), readmeText(manifest));

  // ── 打包 ──────────────────────────────────────────────────────────
  mkdirp(RELEASE_DIR);
  const zipPath = path.join(RELEASE_DIR, `${stem}.zip`);
  rmrf(zipPath);
  console.log("  打包 zip…");
  // Windows 自带的 bsdtar 比 Compress-Archive 快得多，node_modules 那种
  // 几万个小文件的情况差距尤其明显。
  // hdrcharset=UTF-8 不能省：默认按 CP437 存文件名，「安装更新.cmd」会被直接
  // 丢掉（只在 stderr 留一行警告），用户拿到的补丁包就没有那个双击入口了。
  const tarExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  const zip = spawnSync(fs.existsSync(tarExe) ? tarExe : "tar",
    ["-a", "-c", "--options", "hdrcharset=UTF-8", "-f", zipPath, stem], {
      cwd: STAGE_DIR, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8", timeout: 1_800_000,
    });
  if (zip.status !== 0) fail(`打包失败（退出码 ${zip.status}）${zip.stderr || ""}`);
  // bsdtar 遇到存不下的文件名只警告不报错，静默漏文件比打包失败更难发现。
  if (zip.stderr && zip.stderr.trim()) fail(`打包时有文件被跳过：\n${zip.stderr.trim()}`);

  // 逐个核对压缩包内容，确认该进去的都进去了。
  const listed = spawnSync(fs.existsSync(tarExe) ? tarExe : "tar", ["-tf", zipPath], {
    cwd: STAGE_DIR, encoding: "utf8", timeout: 600_000,
  });
  if (listed.status !== 0) fail("压缩包读不出来，打包结果不可信");
  const inZip = new Set(listed.stdout.split(/\r?\n/).map((l) => l.replace(/\/$/, "")).filter(Boolean));
  const mustHave = [`${stem}/patch.json`, `${stem}/apply-patch.ps1`, `${stem}/安装更新.cmd`, `${stem}/README.txt`,
    ...files.map((rel) => `${stem}/payload/${rel}`)];
  const missing = mustHave.filter((p) => !inZip.has(p));
  if (missing.length) fail(`压缩包里少了 ${missing.length} 个文件，例如 ${missing[0]}`);
  console.log(`  压缩包核对通过：${inZip.size} 个条目`);

  // 清单单独放一份，下一次构建拿它当基准算差异
  fs.writeFileSync(path.join(RELEASE_DIR, `manifest-${appVersion}.json`), JSON.stringify(manifest, null, 2));
  rmrf(STAGE_DIR);

  const zipMB = mb(fs.statSync(zipPath).size);
  console.log(`\n  补丁：${zipPath}（${zipMB} MB）`);
  return { zipPath, manifest };
}

function readmeText(m) {
  return [
    `PromptCut 更新补丁 ${m.appVersion}`,
    ``,
    `这个补丁只更新程序里 Node 那一部分（界面和后端逻辑）${m.includesDeps ? "以及依赖" : ""}，`,
    `不动 Chrome、ffmpeg、Python 和外壳，所以比完整安装包小很多。`,
    ``,
    `用法：双击「安装更新.cmd」。`,
    ``,
    `它会做这些事：`,
    `  1. 找到已安装的 PromptCut（默认 %LOCALAPPDATA%\\PromptCut）`,
    `  2. 确认版本对得上（外壳需要 ${m.minShellVersion} 或更新）`,
    `  3. 请你关掉正在运行的 PromptCut`,
    `  4. 备份当前版本，然后覆盖更新`,
    `  5. 出任何问题都会自动回滚到备份`,
    ``,
    `不会动的东西：导出的视频（exports）、AI 会话历史（.pc-chats）、`,
    `设置和密钥（%LOCALAPPDATA%\\promptcut）、下载的语音模型。`,
    ``,
    `如果补丁装不上，用完整安装包覆盖安装即可，效果一样。`,
  ].join("\r\n");
}

main();
