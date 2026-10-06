/**
 * 打字动画卡(mu-typing)与打字机部件(text-typing)的改前改后逐帧比对。
 *
 * 背景:0.5 期声音把 `src/cards/magicui/typing-animation.card.tsx`、`vendor/typing-animation.tsx` 重写成「按字素事件表、
 * 舞台传 t 时按 t 取字」。像素基线的演示项目里没有这张卡,全量比对测不到它,所以单独比。
 *
 *   node scripts/probes/typing-card-compare.mjs --main <main 的 worktree> [--out <目录>] [--port 5714] [--passes 2] [--reuse]
 *
 * 做法:同一份项目 JSON(下面的用例各占一段时间轴),分别用「改前」和「改后」两棵代码树的 `scripts/export-e2e.mjs`
 * 走真实导出路径(自起 dev server、逐帧截图,只有卡片层、透明底),把两边的 PNG 逐帧比像素。
 *   - 改前 = --main 给的目录(main 的提交 3da0aa0e,建议 `git worktree add --detach` 出来用完删)
 *   - 改后 = 本脚本所在的代码树
 * 每边导 --passes 趟,比对只拿最后一趟(第一趟含字体预热,见 docs/guides/compare-pitfalls.md);也报两趟之间自己和自己的差,当噪声底。
 * 一边占 3 个连号端口(编辑器 + 两个舞台):改前 --port、改后 --port+3。
 *
 * 验收标准(退出码 0 当且仅当全部成立):
 *   1. 「默认参数、普通文字」的用例(标 expect=same):改前改后逐帧逐像素相同,差异帧数 0。
 *      含:空文本、拉丁文、中文、含换行、不同的每字毫秒、打字机部件(text-typing,经组合卡)。
 *   2. 「应当不同」的用例(标 expect=differs)只做报告,不判对错,由人看图解释:
 *      emoji / 组合字符 / 国旗(改前按 UTF-16 码元计时,改后按字素计时,这是用户认可的修正);
 *      带停顿等新参数(改前没有这些参数,忽略它们);片段从中间裁切(改前每次挂载从头打,改后接着打)。
 *      脚本为每个这样的用例列出首个差异帧,并拼「改前 | 改后 | 差异×8」三联图(只裁有差异的区域)到 <out>/sheets/。
 *   3. 两边都导出成功、帧数一致。
 *
 * 比对陷阱:见 docs/guides/compare-pitfalls.md。程序报不同先看图——所以脚本会把每个有差异的用例出图。
 * 不碰用户在跑的东西:端口自选(默认 5714、5717),导出目录临时;不继承 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR。
 * 输出:过程写 stdout;最后一行 JSON `{ ok, cases: [...] }`;完整结果写 <out>/result.json。
 */
import './../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AFTER = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const BEFORE = path.resolve(arg('main', path.join(AFTER, '..', 'sound-verify-main')));
const OUT = path.resolve(arg('out', path.join(AFTER, '..', '..', 'work', 'four-stage', 'sound', 'typing-compare')));
const PORT = Number(arg('port', 5714));
const PASSES = Number(arg('passes', 2));
const REUSE = argv.includes('--reuse');
const FPS = 30, W = 1280, H = 720;
const require = createRequire(path.join(AFTER, 'package.json'));
const { PNG } = require('pngjs');

/** 用例:name、expect(same / differs)、clip 的卡与参数 */
const CASES = [
  { name: 'empty', expect: 'same', dur: 1.5, params: { text: '' } },
  { name: 'latin-default', expect: 'same', dur: 3.6, params: { text: 'Hello, PromptCut typing!' } },
  { name: 'card-default-text', expect: 'same', dur: 2.2, params: {} },
  { name: 'chinese-default', expect: 'same', dur: 2.8, params: { text: '这是一段打字机测试文字，含标点。' } },
  { name: 'multiline-default', expect: 'same', dur: 2.6, params: { text: 'Line one\nLine two' } },
  { name: 'slow-duration-200', expect: 'same', dur: 3.0, params: { text: 'Slow typing', duration: 200 } },
  { name: 'part-text-typing-default', expect: 'same', dur: 3.2, part: { text: 'Part typing, default.', size: 0, duration: 120 } },
  { name: 'part-text-typing-chinese', expect: 'same', dur: 2.6, part: { text: '部件里的中文打字。', size: 0, duration: 120 } },
  { name: 'emoji-zwj-default', expect: 'differs', dur: 3.0, params: { text: 'Hi 👩🏽‍💻🎉 ok' } },
  { name: 'combining-and-flag', expect: 'differs', dur: 3.0, params: { text: 'école 🇯🇵 été' } },
  { name: 'part-text-typing-emoji', expect: 'differs', dur: 3.0, part: { text: 'Go 👩🏽‍💻 now', size: 0, duration: 120 } },
  { name: 'pause-params', expect: 'differs', dur: 5.0, params: { text: 'Wait, what? Yes.\nOK', duration: 100, delayMs: 300, punctuationPauseMs: 400, newlinePauseMs: 300, jitterMs: 30, seed: 7, pauses: [{ afterIndex: 3, durationMs: 500 }] } },
  { name: 'crop-from-middle', expect: 'differs', dur: 3.0, mediaOffset: 0.6, params: { text: 'Cropped from the middle of typing' } },
];

function buildProject() {
  const clips = [];
  const windows = [];
  let at = 0;
  CASES.forEach((c, i) => {
    const start = Math.round(at * FPS) / FPS, end = Math.round((at + c.dur) * FPS) / FPS;
    const common = { id: `clip-${i}`, start, end };
    if (c.part) {
      clips.push({ ...common, cardId: 'composite', params: {}, parts: [{ id: `p-${i}`, partId: 'text-typing', params: c.part, frame: { x: 200, y: 440, w: 1520, h: 200 } }] });
    } else {
      clips.push({ ...common, cardId: 'mu-typing', params: { ...c.params }, ...(c.mediaOffset ? { mediaOffset: c.mediaOffset } : {}) });
    }
    windows.push({ ...c, startFrame: Math.round(start * FPS), endFrame: Math.round(end * FPS) });
    at = end + 0.2;
  });
  const duration = Math.ceil(at * FPS) / FPS;
  return { project: { version: 1, id: 'typing-compare', name: 'typing compare', width: W, height: H, fps: FPS, duration, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips }] }, windows, frames: Math.round(duration * FPS) };
}

function runExport(label, tree, port, projectFile, work) {
  return new Promise((resolve) => {
    fs.mkdirSync(work, { recursive: true });
    const log = fs.createWriteStream(path.join(work, 'export-e2e.log'), { flags: 'a' });
    const child = spawn(process.execPath, [path.join(tree, 'scripts', 'export-e2e.mjs'), '--project', projectFile, '--work', work, '--port', String(port), '--', '--workers', '1'],
      { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('exit', (code) => { log.end(); console.log(`[${label}] 退出码 ${code}`); resolve(code ?? 1); });
  });
}

const framePath = (work, f) => path.join(work, 'export-e2e', 'frames', `${String(f).padStart(6, "0")}.png`);
function listFrames(work) {
  const dir = path.join(work, 'export-e2e', 'frames');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort() : [];
}
function readPng(file) { return PNG.sync.read(fs.readFileSync(file)); }
function diffPng(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { differing: -1, max: 255, box: null };
  let differing = 0, max = 0, x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  for (let i = 0, n = a.width * a.height; i < n; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[o + k] - b.data[o + k]));
    if (d) {
      differing++; max = Math.max(max, d);
      const x = i % a.width, y = (i / a.width) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { differing, max, box: differing ? [x0, y0, x1, y1] : null };
}
const frameFiles = (work) => listFrames(work);
function compareDirs(wa, wb, from, to) {
  const out = { frames: 0, diffFrames: 0, first: null, maxChannel: 0, maxPixels: 0, list: [] };
  for (let f = from; f < to; f++) {
    const pa = framePath(wa, f), pb = framePath(wb, f);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) { out.frames++; out.diffFrames++; out.list.push({ frame: f, missing: true }); out.first ??= f; continue; }
    out.frames++;
    const ba = fs.readFileSync(pa), bb = fs.readFileSync(pb);
    if (ba.equals(bb)) continue;
    const d = diffPng(PNG.sync.read(ba), PNG.sync.read(bb));
    if (!d.differing) continue; // 文件字节不同、像素全同(压缩差异)
    out.diffFrames++; out.first ??= f; out.maxChannel = Math.max(out.maxChannel, d.max); out.maxPixels = Math.max(out.maxPixels, d.differing);
    if (out.list.length < 400) out.list.push({ frame: f, pixels: d.differing, max: d.max, box: d.box });
  }
  return out;
}

/** 三联图:改前 | 改后 | 差异×8,只裁差异外框(外扩 24px),放大到 2x 以内。写成 PNG。 */
function sheet(wa, wb, f, box, file) {
  const a = readPng(framePath(wa, f)), b = readPng(framePath(wb, f));
  const pad = 24;
  const x0 = Math.max(0, box[0] - pad), y0 = Math.max(0, box[1] - pad), x1 = Math.min(a.width - 1, box[2] + pad), y1 = Math.min(a.height - 1, box[3] + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, gap = 8;
  const out = new PNG({ width: w * 3 + gap * 2, height: h });
  out.data.fill(60);
  const put = (src, ox, mode) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * src.width + x0 + x) * 4, di = (y * out.width + ox + x) * 4;
      const bi = ((y0 + y) * b.width + x0 + x) * 4, ai = ((y0 + y) * a.width + x0 + x) * 4;
      if (mode === 'diff') {
        for (let k = 0; k < 3; k++) out.data[di + k] = Math.min(255, Math.abs(a.data[ai + k] - b.data[bi + k]) * 8);
        out.data[di + 3] = 255;
      } else {
        // 透明底铺深灰棋盘,文字才看得见
        const al = src.data[si + 3] / 255, bg = ((x >> 4) + (y >> 4)) & 1 ? 40 : 56;
        for (let k = 0; k < 3; k++) out.data[di + k] = Math.round(src.data[si + k] * al + bg * (1 - al));
        out.data[di + 3] = 255;
      }
    }
  };
  put(a, 0, 'img'); put(b, w + gap, 'img'); put(a, (w + gap) * 2, 'diff');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(out));
}

async function main() {
  if (!fs.existsSync(path.join(BEFORE, 'scripts', 'export-e2e.mjs'))) throw new Error(`--main 不是一棵代码树:${BEFORE}`);
  const { project, windows, frames } = buildProject();
  fs.mkdirSync(OUT, { recursive: true });
  const projectFile = path.join(OUT, 'project.json');
  fs.writeFileSync(projectFile, JSON.stringify(project));
  console.log(`项目 ${frames} 帧,${windows.length} 个用例;改前 ${BEFORE};改后 ${AFTER}`);
  const works = { before: [], after: [] };
  for (let p = 1; p <= PASSES; p++) {
    for (const side of ['before', 'after']) works[side].push(path.join(OUT, `${side}-pass${p}`));
  }
  if (!REUSE) {
    for (let p = 0; p < PASSES; p++) {
      for (const w of [works.before[p], works.after[p]]) fs.rmSync(w, { recursive: true, force: true });
      const codes = await Promise.all([
        runExport(`before#${p + 1}`, BEFORE, PORT, projectFile, works.before[p]),
        runExport(`after#${p + 1}`, AFTER, PORT + 3, projectFile, works.after[p]),
      ]);
      if (codes.some((c) => c !== 0)) throw new Error(`第 ${p + 1} 趟导出失败:退出码 ${codes.join('/')}`);
    }
  }
  const last = PASSES - 1;
  const nb = frameFiles(works.before[last]).length, na = frameFiles(works.after[last]).length;
  console.log(`帧数:改前 ${nb} 改后 ${na}(应为 ${frames})`);
  const result = { frames, frameCountBefore: nb, frameCountAfter: na, noise: {}, cases: [] };
  if (PASSES > 1) {
    result.noise.beforeSelf = compareDirs(works.before[0], works.before[last], 0, frames).diffFrames;
    result.noise.afterSelf = compareDirs(works.after[0], works.after[last], 0, frames).diffFrames;
    console.log(`两趟自己和自己:改前差 ${result.noise.beforeSelf} 帧,改后差 ${result.noise.afterSelf} 帧(含冷启动那一趟)`);
  }
  // 留白段(用例之间的 0.2 秒与片尾)也算:两边都应当是空画面
  const gaps = [];
  let prev = 0;
  for (const w of windows) { if (w.startFrame > prev) gaps.push([prev, w.startFrame]); prev = w.endFrame; }
  if (prev < frames) gaps.push([prev, frames]);
  let ok = nb === frames && na === frames;
  for (const w of windows) {
    const c = compareDirs(works.before[last], works.after[last], w.startFrame, w.endFrame);
    const row = { name: w.name, expect: w.expect, startFrame: w.startFrame, endFrame: w.endFrame, frames: c.frames, diffFrames: c.diffFrames, firstDiffFrame: c.first, maxChannelDiff: c.maxChannel, maxDiffPixels: c.maxPixels };
    if (w.expect === 'same' && c.diffFrames !== 0) ok = false;
    if (c.diffFrames && c.list.length) {
      const pick = c.list.find((x) => x.box) ?? null;
      if (pick) {
        const file = path.join(OUT, 'sheets', `${w.name}-frame${pick.frame}.png`);
        sheet(works.before[last], works.after[last], pick.frame, pick.box, file);
        row.sheet = file;
        // 差异最大的一帧也出图
        const big = c.list.filter((x) => x.box).sort((a, b) => b.pixels - a.pixels)[0];
        if (big && big.frame !== pick.frame) { const f2 = path.join(OUT, 'sheets', `${w.name}-frame${big.frame}-max.png`); sheet(works.before[last], works.after[last], big.frame, big.box, f2); row.sheetMax = f2; }
      }
      row.diffFramesList = c.list.map((x) => x.frame);
    }
    result.cases.push(row);
    console.log(`${w.expect === 'same' ? (c.diffFrames ? 'FAIL' : 'PASS') : 'INFO'} ${w.name} [${w.expect}] 帧 ${w.startFrame}-${w.endFrame - 1}:${c.frames} 帧,差异 ${c.diffFrames} 帧${c.first !== null ? `,首个差异帧 ${c.first},最大通道差 ${c.maxChannel}` : ''}`);
  }
  const gap = gaps.map(([a, b]) => compareDirs(works.before[last], works.after[last], a, b));
  result.gapDiffFrames = gap.reduce((s, g) => s + g.diffFrames, 0);
  console.log(`${result.gapDiffFrames ? 'FAIL' : 'PASS'} 用例之间的留白帧 ${gaps.reduce((s, [a, b]) => s + b - a, 0)} 帧,差异 ${result.gapDiffFrames} 帧`);
  if (result.gapDiffFrames) ok = false;
  result.ok = ok;
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok, cases: result.cases.map((c) => ({ name: c.name, expect: c.expect, frames: c.frames, diffFrames: c.diffFrames })) }));
  return ok ? 0 : 1;
}
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
