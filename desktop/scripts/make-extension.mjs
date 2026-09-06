/**
 * PromptCut — 打「拓展库包」。
 *
 * 三层发布的第三层：
 *   完整安装包（内核换代时发） / 更新补丁（改 Node 那半边） / 拓展库包（可选能力）
 *
 * 为什么要有它：语音识别和镜头识别的依赖现在是运行时 pip install 现下载，
 * 断网、内网、或者国内网络不通就装不上，而且每台机器都要重下一遍。拓展库包
 * 把 wheel 和模型预先打好，离线也能装。
 *
 *   node scripts/make-extension.mjs shots     # 镜头识别（onnxruntime + TransNetV2）
 *   node scripts/make-extension.mjs stt       # 语音识别（faster-whisper 依赖）
 *   node scripts/make-extension.mjs shots --model <transnetv2.onnx 的路径>
 *
 * 产物：release/PromptCut-ext-<名字>-<版本>.exe，双击即装。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const STAGE_DIR = path.join(DESKTOP_DIR, ".cache", "ext-stage");

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith("-"));
const option = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

/**
 * 每个拓展要装什么。
 * requirements 走 pip download 抓成 wheel；models 是直接随包带的文件。
 */
/** 拓展依赖的是应用里那半边代码(promptcut_shots / promptcut_stt),太旧的版本没有它,
 *  所以每个拓展都要声明最低应用版本，装之前就拦住，而不是装完才自检失败。*/
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
).version;

const EXTENSIONS = {
  shots: {
    label: "镜头识别",
    version: "1.0.0",
    requiresApp: "0.2.5",  // promptcut_shots 是这一版加进去的
    requirements: path.join(PROJECT_ROOT, "python", "promptcut_shots", "requirements-shots.txt"),
    // 没有官方 ONNX，这份是从官方 TF 权重自己转的，见 tools/transnetv2/README.md
    models: [{ file: "transnetv2.onnx", from: option("--model") }],
    note: "装完后「镜头切换识别」会用 TransNetV2，认得硬切也认得溶解；不装则退回 ffmpeg scdet，只认硬切。",
  },
  stt: {
    label: "语音识别",
    version: "1.0.0",
    requiresApp: "0.1.0",  // 语音识别很早就有了
    requirements: path.join(PROJECT_ROOT, "python", "requirements-faster-whisper.txt"),
    models: [],
    note: "装完后语音转文字不再需要联网下载依赖；模型仍按需下载。",
  },
};

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
const mb = (b) => (b / 1048576).toFixed(1);

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

/** 自带的那个解释器；用它下载 wheel 才能保证 ABI 和用户机器上一致 */
function bundledPython() {
  const p = path.join(DESKTOP_DIR, "src-tauri", "runtime", "python", "python.exe");
  if (fs.existsSync(p)) return p;
  fail("找不到自带的 Python（desktop/src-tauri/runtime/python），先跑 npm run prepare-python");
}

function findMakensis() {
  const bundled = path.join(process.env.LOCALAPPDATA || "", "tauri", "NSIS", "Bin", "makensis.exe");
  if (fs.existsSync(bundled)) return bundled;
  const probe = spawnSync("makensis", ["/VERSION"], { encoding: "utf8" });
  if (probe.status === 0 || probe.stdout) return "makensis";
  fail("找不到 makensis。先跑一次 npm run build 让 Tauri 把 NSIS 装下来。");
}

function main() {
  if (!name || !Object.hasOwn(EXTENSIONS, name)) {
    fail(`用法：node scripts/make-extension.mjs <${Object.keys(EXTENSIONS).join("|")}>`);
  }
  const ext = EXTENSIONS[name];
  console.log(`PromptCut make-extension：${ext.label} ${ext.version}`);

  if (!fs.existsSync(ext.requirements)) fail(`找不到依赖清单 ${ext.requirements}`);

  const stem = `PromptCut-ext-${name}-${ext.version}`;
  rmrf(STAGE_DIR);
  const root = path.join(STAGE_DIR, stem);
  const wheelDir = path.join(root, "wheels");
  const modelDir = path.join(root, "models");
  mkdirp(wheelDir);
  mkdirp(modelDir);

  // ── wheel ──────────────────────────────────────────────────────────
  // 用自带解释器 pip download：wheel 的 ABI 标签必须和用户机器上那个
  // 解释器对得上，用开发机的 python 下出来的可能装不上。
  const python = bundledPython();
  console.log("  下载 wheel…");
  const dl = spawnSync(python, ["-m", "pip", "download", "-r", ext.requirements, "-d", wheelDir],
    { stdio: "inherit", timeout: 1_800_000 });
  if (dl.status !== 0) fail(`pip download 失败（退出码 ${dl.status}）`);
  const wheels = fs.readdirSync(wheelDir);
  if (!wheels.length) fail("一个 wheel 都没下到");
  console.log(`  wheel：${wheels.length} 个，${mb(dirSize(wheelDir))} MB`);

  // ── 模型 ───────────────────────────────────────────────────────────
  for (const m of ext.models) {
    if (!m.from) fail(`${ext.label} 需要模型文件 ${m.file}，用 --model <路径> 指定（生成方法见 tools/transnetv2/README.md）`);
    if (!fs.existsSync(m.from)) fail(`模型文件不存在：${m.from}`);
    fs.copyFileSync(m.from, path.join(modelDir, m.file));
    console.log(`  模型：${m.file}，${mb(fs.statSync(m.from).size)} MB`);
  }

  const manifest = {
    format: "promptcut-extension/1",
    name,
    label: ext.label,
    version: ext.version,
    requiresApp: ext.requiresApp,
    builtAgainstApp: APP_VERSION,
    builtAt: new Date().toISOString(),
    wheels,
    models: ext.models.map((m) => m.file),
    note: ext.note,
  };
  fs.writeFileSync(path.join(root, "extension.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(__dirname, "apply-extension.ps1"), path.join(root, "apply-extension.ps1"));

  // ── 打包 ───────────────────────────────────────────────────────────
  mkdirp(RELEASE_DIR);
  const exePath = path.join(RELEASE_DIR, `${stem}.exe`);
  rmrf(exePath);
  console.log("  用 NSIS 打成 exe…");
  const build = spawnSync(findMakensis(), [
    `-DVERSION=${ext.version}`,
    `-DLABEL=${ext.label}`,
    `-DSRCDIR=${root}`,
    `-DOUTFILE=${exePath}`,
    `-DICON=${path.join(DESKTOP_DIR, "src-tauri", "icons", "icon.ico")}`,
    path.join(__dirname, "extension-installer.nsi"),
  ], { encoding: "utf8", timeout: 1_800_000 });
  if (build.status !== 0 || !fs.existsSync(exePath)) {
    fail(`NSIS 打包失败（退出码 ${build.status}）\n${(build.stdout || "").slice(-2000)}${build.stderr || ""}`);
  }

  fs.writeFileSync(path.join(RELEASE_DIR, `ext-${name}-${ext.version}.json`), JSON.stringify(manifest, null, 2));
  rmrf(STAGE_DIR);
  console.log(`\n  拓展库包：${exePath}（${mb(fs.statSync(exePath).size)} MB）`);
}

main();
