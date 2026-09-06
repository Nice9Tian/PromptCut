/**
 * PromptCut — Assemble the desktop runtime directory.
 *
 * Copies Node sidecar, app source, Chrome for Testing, and ffmpeg into
 * desktop/src-tauri/runtime/ so that `tauri build` can bundle them.
 *
 * Usage:
 *   node scripts/prepare-runtime.mjs          # full assembly
 *   node scripts/prepare-runtime.mjs --check  # verify only, no copy
 */
import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
/**
 * 源码从哪里来。默认是本仓库工作区；发布时由 build-release 传 --source 指向
 * 一棵 HEAD 的 worktree,好让产物对应一个已提交的状态,而不是把工作区里
 * 别人没提交完的改动一起打进去。
 *
 * 只换源码这一处:Chrome / ffmpeg / Python / Rust 编译缓存仍然用 desktop/ 下
 * 原来那份,不必为一次发布重下重编。
 */
const SOURCE_ARG = process.argv.indexOf("--source");
const PROJECT_ROOT = SOURCE_ARG >= 0
  ? path.resolve(process.argv[SOURCE_ARG + 1])
  : path.resolve(DESKTOP_DIR, "..");
const RUNTIME_DIR = path.resolve(DESKTOP_DIR, "src-tauri", "runtime");
const BINARIES_DIR = path.resolve(DESKTOP_DIR, "src-tauri", "binaries");

const CHECK_ONLY = process.argv.includes("--check");
const t0 = Date.now();

// ── Utilities ───────────────────────────────────────────────────────────

function elapsed() {
  return ((Date.now() - t0) / 1000).toFixed(1);
}

function dirSizeMB(dir) {
  let total = 0;
  try {
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else {
          try { total += fs.statSync(full).size; } catch { /* skip */ }
        }
      }
    };
    walk(dir);
  } catch { /* dir may not exist */ }
  return (total / 1048576).toFixed(1);
}

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
}

function copyRecursive(src, dest, filter) {
  mkdirp(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, ent.name);
    const destPath = path.join(dest, ent.name);
    if (filter && !filter(ent.name, srcPath, ent.isDirectory())) continue;
    if (ent.isDirectory()) {
      copyRecursive(srcPath, destPath, filter);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

// ── Step 1: Sidecar (node) ──────────────────────────────────────────────

function stepSidecar() {
  const stepT = Date.now();
  console.log("\n── Step 1: Sidecar (node) ──");
  const dest = path.join(BINARIES_DIR, "node-x86_64-pc-windows-msvc.exe");
  if (CHECK_ONLY) {
    assert(fs.existsSync(dest), `Sidecar not found: ${dest}`);
    console.log(`  ✓ Sidecar exists (${dirSizeMB(BINARIES_DIR)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return;
  }
  mkdirp(BINARIES_DIR);
  console.log(`  Copying ${process.execPath} → ${dest}`);
  fs.copyFileSync(process.execPath, dest);
  console.log(`  Done (${dirSizeMB(BINARIES_DIR)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
}

// ── Step 2: App ─────────────────────────────────────────────────────────

/** Names/patterns to skip when copying the app. */
const SKIP_DIRS = new Set([
  "node_modules", "out", "dist", ".git", ".vite", "desktop",
]);
const SKIP_FILE_PATTERNS = [
  /^AGY-TASK-.*\.md$/,
  /^left-probe\.html$/,
  /^probe-data\.html$/,
  /^probe-timeline\.html$/,
  /^proto\.html$/,
  /\.log$/,
  /\.mp4$/,
  /\.mov$/,
  /\.webm$/,
];
const SKIP_PATH_PATTERNS = [
  /[/\\]src[/\\]__probe-/,
  /[/\\]scripts[/\\]_mgr-/,
  /[/\\]scripts[/\\]_tmp-/,
  /[/\\]scripts[/\\]__tmp-/,
];

function shouldCopyApp(name, fullPath, isDir) {
  if (isDir && SKIP_DIRS.has(name)) return false;
  if (!isDir) {
    for (const re of SKIP_FILE_PATTERNS) {
      if (re.test(name)) return false;
    }
    for (const re of SKIP_PATH_PATTERNS) {
      if (re.test(fullPath)) return false;
    }
  }
  return true;
}

function stepApp() {
  const stepT = Date.now();
  console.log("\n── Step 2: App ──");
  const appDir = path.join(RUNTIME_DIR, "app");

  if (CHECK_ONLY) {
    // Verify dist exists
    const distIndex = path.join(appDir, "dist", "index.html");
    assert(fs.existsSync(distIndex), `dist/index.html not found: ${distIndex}`);
    // Verify node_modules essentials
    const viteJs = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
    assert(fs.existsSync(viteJs), `vite.js not found: ${viteJs}`);
    const rolldown = path.join(appDir, "node_modules", "@rolldown", "binding-win32-x64-msvc");
    assert(fs.existsSync(rolldown), `rolldown binding not found: ${rolldown}`);
    console.log(`  ✓ App exists (${dirSizeMB(appDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return { appDir };
  }

  // Clean and copy
  rmrf(appDir);
  console.log(`  Copying source from ${PROJECT_ROOT} → ${appDir}`);
  copyRecursive(PROJECT_ROOT, appDir, shouldCopyApp);

  // npm ci
  console.log("  Running npm ci…");
  const ciResult = spawnSync("npm", ["ci"], {
    cwd: appDir,
    shell: true,
    stdio: "inherit",
    timeout: 300_000,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
  });
  if (ciResult.status !== 0) {
    console.error(`[FAIL] npm ci exited with code ${ciResult.status}`);
    process.exit(1);
  }

  // Assert critical paths
  const viteJs = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
  const rolldown = path.join(appDir, "node_modules", "@rolldown", "binding-win32-x64-msvc");
  if (!fs.existsSync(viteJs) || !fs.existsSync(rolldown)) {
    console.error(
      `[FAIL] Critical paths missing after npm ci.\n` +
      `       vite.js: ${fs.existsSync(viteJs)}\n` +
      `       rolldown: ${fs.existsSync(rolldown)}\n` +
      `       This usually means npm blocked install scripts.\n` +
      `       Run "npm approve-scripts" in ${appDir} then re-run this script.`
    );
    process.exit(1);
  }

  // vite build (not npm run build — skip tsc)
  const ptyCheck = spawnSync(process.execPath, [path.join(appDir, 'server', 'runners', 'agy-login.mjs'), '--self-test'], {
    cwd: appDir, windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  assert(ptyCheck.status === 0 && ptyCheck.stdout.includes('PROMPTCUT_PTY_OK'),
    `Background CLI login component failed verification: ${ptyCheck.stderr || ptyCheck.error || ptyCheck.status}`);
  console.log("  Running vite build…");
  const buildResult = spawnSync("npx.cmd", ["vite", "build"], {
    cwd: appDir,
    shell: true,
    stdio: "inherit",
    timeout: 300_000,
  });
  if (buildResult.status !== 0) {
    console.error(`[FAIL] vite build exited with code ${buildResult.status}`);
    process.exit(1);
  }
  const distIndex = path.join(appDir, "dist", "index.html");
  assert(fs.existsSync(distIndex), `dist/index.html not found after vite build: ${distIndex}`);

  console.log(`  Done (${dirSizeMB(appDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return { appDir };
}

// ── Step 3: Chrome ──────────────────────────────────────────────────────

function parseChromeVersion(appDir) {
  // Look for chrome revision in puppeteer-core's revisions.js
  const candidates = [
    path.join(appDir, "node_modules", "puppeteer-core", "lib", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer-core", "lib", "esm", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer-core", "lib", "cjs", "puppeteer", "revisions.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      const m = content.match(/chrome:\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
  }
  // Fallback: also check puppeteer (non-core)
  const fallbacks = [
    path.join(appDir, "node_modules", "puppeteer", "lib", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer", "lib", "esm", "puppeteer", "revisions.js"),
    path.join(appDir, "node_modules", "puppeteer", "lib", "cjs", "puppeteer", "revisions.js"),
  ];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      const m = content.match(/chrome:\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
  }
  return null;
}

function stepChrome(appDir) {
  const stepT = Date.now();
  console.log("\n── Step 3: Chrome ──");
  const effectiveAppDir = appDir || path.join(RUNTIME_DIR, "app");
  const version = parseChromeVersion(effectiveAppDir);
  assert(version, "Could not parse Chrome version from puppeteer-core revisions.js");
  console.log(`  Chrome for Testing version: ${version}`);

  const chromeDir = path.join(RUNTIME_DIR, "chrome");
  const destVersionDir = path.join(chromeDir, "chrome", `win64-${version}`);
  const chromeExe = path.join(destVersionDir, "chrome-win64", "chrome.exe");

  if (CHECK_ONLY) {
    assert(fs.existsSync(chromeExe), `Chrome exe not found: ${chromeExe}`);
    console.log(`  ✓ Chrome exists (${dirSizeMB(chromeDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return version;
  }

  // Try copying from puppeteer cache first
  const userProfile = process.env.USERPROFILE || "";
  const cacheDir = path.join(userProfile, ".cache", "puppeteer", "chrome", `win64-${version}`);
  let copied = false;

  if (fs.existsSync(cacheDir)) {
    console.log(`  Copying from cache: ${cacheDir}`);
    mkdirp(destVersionDir);
    copyRecursive(cacheDir, destVersionDir, (name, fullPath) => {
      // Skip headless shell to save ~200 MB
      return !fullPath.includes("chrome-headless-shell");
    });
    copied = true;
  }

  if (!copied) {
    console.log("  Cache not found, downloading via puppeteer…");
    const dlResult = spawnSync("npx.cmd", [
      "puppeteer", "browsers", "install", `chrome@${version}`,
      "--path", chromeDir,
    ], {
      cwd: effectiveAppDir,
      shell: true,
      stdio: "inherit",
      timeout: 600_000,
    });
    if (dlResult.status !== 0) {
      console.error(`[FAIL] puppeteer browsers install failed (code ${dlResult.status})`);
      process.exit(1);
    }
  }

  // Remove other Chrome versions
  const chromeParent = path.join(chromeDir, "chrome");
  if (fs.existsSync(chromeParent)) {
    for (const ent of fs.readdirSync(chromeParent, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name !== `win64-${version}`) {
        console.log(`  Removing old version: ${ent.name}`);
        rmrf(path.join(chromeParent, ent.name));
      }
    }
  }

  assert(fs.existsSync(chromeExe), `Chrome exe not found after install: ${chromeExe}`);
  console.log(`  Done (${dirSizeMB(chromeDir)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return version;
}

// ── Step 4: FFmpeg ──────────────────────────────────────────────────────

function findFfmpegDir() {
  // Try PATH first
  try {
    const which = execSync("where ffmpeg", { encoding: "utf-8", timeout: 5000 }).trim().split(/\r?\n/)[0];
    if (which) {
      const binDir = path.dirname(which);
      if (fs.existsSync(path.join(binDir, "ffprobe.exe"))) {
        return binDir;
      }
    }
  } catch { /* not in PATH */ }

  // Scan WinGet packages
  const localAppData = process.env.LOCALAPPDATA || "";
  const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(packagesDir)) {
    for (const ent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.startsWith("Gyan.FFmpeg_")) {
        const pkgDir = path.join(packagesDir, ent.name);
        // Look for ffmpeg-*/bin
        for (const sub of fs.readdirSync(pkgDir, { withFileTypes: true })) {
          if (sub.isDirectory() && sub.name.startsWith("ffmpeg-")) {
            const binDir = path.join(pkgDir, sub.name, "bin");
            if (fs.existsSync(path.join(binDir, "ffmpeg.exe")) &&
                fs.existsSync(path.join(binDir, "ffprobe.exe"))) {
              return binDir;
            }
          }
        }
      }
    }
  }
  return null;
}

function stepFfmpeg() {
  const stepT = Date.now();
  console.log("\n── Step 4: FFmpeg ──");
  const ffmpegDest = path.join(RUNTIME_DIR, "ffmpeg");

  if (CHECK_ONLY) {
    assert(
      fs.existsSync(path.join(ffmpegDest, "ffmpeg.exe")),
      `ffmpeg.exe not found in ${ffmpegDest}`
    );
    assert(
      fs.existsSync(path.join(ffmpegDest, "ffprobe.exe")),
      `ffprobe.exe not found in ${ffmpegDest}`
    );
    // Get version
    let ver = "unknown";
    try {
      const out = execSync(`"${path.join(ffmpegDest, "ffmpeg.exe")}" -version`, {
        encoding: "utf-8", timeout: 5000,
      });
      ver = out.split(/\r?\n/)[0];
    } catch { /* ignore */ }
    console.log(`  ✓ FFmpeg exists: ${ver} (${dirSizeMB(ffmpegDest)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    return ver;
  }

  const binDir = findFfmpegDir();
  if (!binDir) {
    console.error(
      "[FAIL] ffmpeg not found.\n" +
      "       Please install it: winget install --id Gyan.FFmpeg -e"
    );
    process.exit(1);
  }
  console.log(`  Source: ${binDir}`);

  mkdirp(ffmpegDest);
  fs.copyFileSync(path.join(binDir, "ffmpeg.exe"), path.join(ffmpegDest, "ffmpeg.exe"));
  fs.copyFileSync(path.join(binDir, "ffprobe.exe"), path.join(ffmpegDest, "ffprobe.exe"));

  // Copy LICENSE/README from parent dir
  const parentDir = path.dirname(binDir);
  for (const ent of fs.readdirSync(parentDir)) {
    if (/^(LICENSE|README)/i.test(ent)) {
      fs.copyFileSync(path.join(parentDir, ent), path.join(ffmpegDest, ent));
    }
  }

  let ver = "unknown";
  try {
    const out = execSync(`"${path.join(ffmpegDest, "ffmpeg.exe")}" -version`, {
      encoding: "utf-8", timeout: 5000,
    });
    ver = out.split(/\r?\n/)[0];
  } catch { /* ignore */ }

  console.log(`  FFmpeg version: ${ver}`);
  console.log(`  Done (${dirSizeMB(ffmpegDest)} MB) [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
  return ver;
}

// ── Step 5: Python (detect only) ────────────────────────────────────────

function stepPython() {
  const stepT = Date.now();
  console.log("\n── Step 5: Python (detect only) ──");
  const pythonExe = path.join(RUNTIME_DIR, "python", "python.exe");
  let ver = null;

  if (fs.existsSync(pythonExe)) {
    try {
      const out = execSync(`"${pythonExe}" -V`, { encoding: "utf-8", timeout: 5000 });
      ver = out.trim(); // "Python 3.11.x"
      console.log(`  Python found: ${ver} [${((Date.now() - stepT) / 1000).toFixed(1)}s]`);
    } catch (e) {
      console.warn(`  Python exe exists but failed to run: ${e.message}`);
    }
  } else {
    console.warn(
      "  [WARN] runtime/python 还没就绪，语音识别功能不可用；" +
      "跑 npm run prepare-python 组装"
    );
  }

  return ver;
}

// ── Step 6: VERSIONS.json ───────────────────────────────────────────────

function computeAppSrcHash(appDir) {
  // Collect all files with rel path, size, mtimeMs — same filter as copy
  const entries = [];
  const walk = (dir, base) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of items) {
      const fullPath = path.join(dir, ent.name);
      const rel = path.join(base, ent.name);
      if (ent.isDirectory()) {
        if (!shouldCopyApp(ent.name, fullPath, true)) continue;
        walk(fullPath, rel);
      } else {
        if (!shouldCopyApp(ent.name, fullPath, false)) continue;
        try {
          const st = fs.statSync(fullPath);
          entries.push(`${rel}|${st.size}|${Math.floor(st.mtimeMs)}`);
        } catch { /* skip */ }
      }
    }
  };
  walk(PROJECT_ROOT, "");
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function stepVersions(nodeVer, chromeVer, ffmpegVer, pythonVer) {
  console.log("\n── Step 6: VERSIONS.json ──");
  const versionsPath = path.join(RUNTIME_DIR, "VERSIONS.json");

  // Read root package.json for app version
  let appVer = "0.0.1";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    appVer = pkg.version || appVer;
  } catch { /* ignore */ }

  const appSrcHash = computeAppSrcHash(path.join(RUNTIME_DIR, "app"));

  if (CHECK_ONLY) {
    // Verify hash matches
    if (fs.existsSync(versionsPath)) {
      const existing = JSON.parse(fs.readFileSync(versionsPath, "utf-8"));
      if (existing.appSrcHash !== appSrcHash) {
        console.error(
          `[FAIL] runtime/app 落后于源码，请重跑 npm run prepare-runtime\n` +
          `       Expected hash: ${appSrcHash}\n` +
          `       Got: ${existing.appSrcHash}`
        );
        process.exit(1);
      }
      console.log("  ✓ VERSIONS.json hash matches");
    } else {
      console.error(`[FAIL] VERSIONS.json not found: ${versionsPath}`);
      process.exit(1);
    }
    return;
  }

  const data = {
    node: nodeVer,
    chrome: chromeVer,
    ffmpeg: ffmpegVer,
    python: pythonVer,
    app: appVer,
    appSrcHash,
    builtAt: new Date().toISOString(),
  };

  // Log if python status changed
  if (fs.existsSync(versionsPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(versionsPath, "utf-8"));
      if (old.python && !pythonVer) {
        console.log(`  [info] Previous VERSIONS.json had python="${old.python}", now detected null`);
      }
    } catch { /* ignore */ }
  }

  mkdirp(RUNTIME_DIR);
  fs.writeFileSync(versionsPath, JSON.stringify(data, null, 2));
  console.log(`  Written: ${versionsPath}`);
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  console.log(`PromptCut prepare-runtime ${CHECK_ONLY ? "(--check)" : ""}`);
  console.log(`  Project root: ${PROJECT_ROOT}`);
  console.log(`  Runtime dir:  ${RUNTIME_DIR}`);

  stepSidecar();
  const { appDir } = stepApp() || { appDir: path.join(RUNTIME_DIR, "app") };
  const chromeVer = stepChrome(appDir);
  const ffmpegVer = stepFfmpeg();
  const pythonVer = stepPython();

  // Node version
  let nodeVer = "unknown";
  try {
    nodeVer = execSync(`"${process.execPath}" --version`, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch { /* ignore */ }

  stepVersions(nodeVer, chromeVer, ffmpegVer, pythonVer);

  const sizes = {
    sidecar: dirSizeMB(BINARIES_DIR),
    app: dirSizeMB(path.join(RUNTIME_DIR, "app")),
    chrome: dirSizeMB(path.join(RUNTIME_DIR, "chrome")),
    ffmpeg: dirSizeMB(path.join(RUNTIME_DIR, "ffmpeg")),
    python: dirSizeMB(path.join(RUNTIME_DIR, "python")),
    total: dirSizeMB(RUNTIME_DIR),
  };

  console.log(`\n── Done in ${elapsed()}s ──`);
  console.log(`PREPARE_RESULT_JSON ${JSON.stringify({
    node: nodeVer, chrome: chromeVer, ffmpeg: ffmpegVer, python: pythonVer,
    sizes,
  })}`);
}

main();
