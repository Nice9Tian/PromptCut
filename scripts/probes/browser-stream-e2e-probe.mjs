/**
 * 在线浏览器产流、另一个在线页面播流的整条链(`docs/plan/browser-stream-task.md` 的七处接在一起;任务书 `render-refactor-task.md`「甲一」的集成)。
 *
 *   node scripts/probes/browser-stream-e2e-probe.mjs [--dist <在线构建目录>] [--base-port 7410] [--out <目录>] [--keep-temp] [--only off|on]
 *        端口(整段 +0～+9):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 桌面编辑器(及它的舞台端口)。都只绑 127.0.0.1。
 *        这台机器的临时端口范围从 1024 起,74xx 一带会被别的进程的临时端口碰巧占住;被占时换一段(例如 `--base-port 27410`)。
 *
 * 角色都在本机,页面用**在线构建**(隔离的跨源舞台也在链路里;进项目走「刷新后回到项目」那条产品路径,`lib/online-resume-entry.mjs`):
 *   - 文档服务 + 素材服务:进程内的托管组合,经共用的本机托管代理 `lib/hosted-proxy.mjs` 开三个同站跨源的源;
 *   - 切分方:真的桌面预渲染进程(`m8/procs.mjs` 的 `startQueueEditor`:队列模式、测试指纹、`PROMPTCUT_TEST_PLAN_ONLY=1` 只切分不认领细任务);
 *   - 甲:在线页面,当浏览器节点(认领快照与单卡流任务,压流、推素材服务、写流清单);
 *   - 乙:另一个浏览器里的在线页面,同一个项目的另一个成员,是观看的一方(甲产完之后才进来)。两个浏览器各开各的,两页都在前台。
 *
 * 两轮,各用一个新项目、重起一次桌面预渲染进程:第一轮切分方**关着流开关**(`PROMPTCUT_STREAMS=0`:它自己这一版一条流都不列,
 * 层表里的流全靠「切分给浏览器出过键」那份记录,`FramePipeline.issuedStreamSpecs`),第二轮开着。`--only` 只跑一轮。
 *
 * 每一轮的断言(任一不成立退出码 1;`<轮>` 是 off / on):
 *   A 产      甲报能压流,认领并完成了这张卡的流任务(没有失败);切分方一个细任务都没做;内容库 `render-manifest` 里每个任务一份流清单
 *             (过桌面的 `manifestMatches`,编码器 `webcodecs-avc`,分段齐);素材服务 `px` 里开头文件与每个分段都 complete、哈希对得上
 *   B 层表    内容库的层表(v 3)带 `streams`,有这张卡的一行:单卡流、候选里有甲的指纹且结果键 = 内容键 × 甲的指纹 = 甲产的那条流的键、
 *             分段范围与输入签名齐。切分方关着流开关时候选只有浏览器指纹(切分方自己不产,不列它)
 *   C 就绪    乙的在线来源认出这条流(用的候选就是甲产的那一份),播放头附近的分段就绪,没有过期的
 *   D 流在画  乙播放时:这张卡的包裹层被抑制,流播放器给它建了轨道、字节是父页推来的(`pushed`)、在出帧且跟着播放头;垫着的快照是海报
 *             (播 N 帧只换约 N/15 次,不是每拍换);没有占位符。两个舞台的源一次都没请求过 `px/`(流的字节只由编辑器页取)
 *   E 像素    乙播放中截可见舞台(同时读流播放器正画着第几帧),暂停后追到同一帧的精确活渲再截:差在编码误差以内;
 *             与往后 2 秒的精确活渲比明显更大(对照)
 *   F 甲自播  甲自己播放这张卡时,舞台上同样是它自己产的那条流在画(键相同、父页推的字节)
 *   G 改参数  甲把这张卡的文字改成空的:乙那边旧流马上不再贴(在线来源把它撤了、舞台上没有旧键的轨道);新一版的流产出来之后层表换成新的一行
 *             (内容键、输入签名都换了),乙认出新流并播它;像素同 E 那样比,且旧流那张截图里有白字、新流这张里没有(与新一版的活渲一样)
 *   H 没有页面错误
 * 已知(不判不过,只记数,见 `docs/reports/AGENT-rr-a1-integ.md`):乙是甲产完之后才进来的,它没收到过这张卡快照任务的 `task.done`,层表里快照层的候选
 *   它取第一个(切分方自己的那一份,切分方只切分、没产),所以它这里这张卡没有快照;每次起播(先放播放头再播)的头 500 毫秒,舞台给这一层盖
 *   「等快照」的沙漏,流在下面照画,兜底一过沙漏撤掉。D 里判的是「起播 0.7 秒之后没有占位符」,头 0.7 秒里出现过几次记在结果的 `placeholderEarly`。
 * 耗时只记录(`guide_files/verification.md`「耗时只记录,不当闸门」)。不打印令牌、口令。
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, rounds: { off, on } }`;截图在 `--out/<轮>/`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawnSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import dnsShim from './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from './lib/online-resume-entry.mjs';
import { startQueueEditor, viteBin, portFree } from './m8/procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const ONLY = arg('--only', null);
const BASE = Number(arg('--base-port', 7410));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, desk: BASE + 5 };
const BAND = [BASE, BASE + 9];
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bstream-e2e-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 60 * 60_000;
// 探针起的 Node 子进程(桌面编辑器与它的预渲染进程)继承它,也能解析 pc.localhost
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

/** 探针项目:1280×720、30 fps。卡从第 12 帧起(不在分段边界上),占 120 帧(全局 12～131,分段 0～8:两个流任务 0～7 与 8～8) */
const PROJECT = { width: 1280, height: 720, fps: 30, duration: 8 };
const FPS = PROJECT.fps;
const CLIP = { start: 0.4, duration: 4.0 };
const SEG = 15;
/** 项目时长跟着内容走(卡在 4.4 秒结束):一共 132 帧,最后一个分段(第 8 段)只有 12 帧 */
const TOTAL = Math.round((CLIP.start + CLIP.duration) * FPS);
const LABEL_1 = 'e2e', LABEL_2 = '';

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, rounds: {} };
let tag = '';
const check = (cond, label, extra) => { if (!cond) fails.push(`${tag}${label}` + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 700)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let debugProbe = null;

async function until(label, fn, timeoutMs, everyMs = 300) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  let last = 0;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`${tag}超时:${label}`); return null; }
    if (process.env.PROBE_DEBUG && Date.now() - last > 15_000) { last = Date.now(); say('waiting', { label, v: debugProbe ? await debugProbe().catch((e) => String(e?.message ?? e)) : null }); }
    await delay(everyMs);
  }
}

/* ================================================================== 本机站点:托管组合 + 三个源的代理 */

let combo = null, hostedProxy = null;
async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let dist = arg('--dist', null);
  if (!dist) {
    dist = path.join(TMP, 'dist-online');
    say('local.build-online', { dist });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  dist = path.resolve(dist);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  hostedProxy = await startHostedProxy({ dist, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
  say('local.up', { site: SITE, stages: ORIGINS.stages, doc: PORTS.doc, asset: PORTS.asset, dist });
  return dist;
}

/** 给刚建好的共享项目写进一份空项目(替创建者的桌面版;画幅用探针自己的) */
async function seedProject({ projectId, creator, name }) {
  const { buildAuthProtocols } = await import('../../server/auth/client.mjs');
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'bse-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `seed${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  try {
    const opened = await ask({ type: 'project.open', projectId });
    const body = { version: 1, id: `seed-${projectId.slice(-8)}`, name, ...PROJECT, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }] };
    const seeded = await ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    const bad = (m) => /error|reject/i.test(String(m?.type ?? ''));
    return { ok: !bad(opened) && !bad(seeded), opened: opened?.type, seeded: seeded?.type };
  } finally { ws.close(); }
}

/* ================================================================== 页面 */

const EVAL_TIMEOUT_MS = 30_000;
const P = (page, fn, ...a) => Promise.race([page.evaluate(fn, ...a), delay(EVAL_TIMEOUT_MS).then(() => { throw new Error('页面 30 秒没应答'); })]);
const store = (page, src, ...a) => P(page, (s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const nodeDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcBrowserNode?.() ?? null)); } catch { return null; } }).catch(() => null);
const onlineDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
const playFrom = (page, t) => store(page, `S.actions.pause(); S.actions.seek(args[0]); S.actions.play(); return true;`, t);
const pauseAt = (page, t) => store(page, `S.actions.pause(); S.actions.seek(args[0]); return true;`, t);
const stageFrames = (page) => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
async function visibleStage(page) {
  for (const f of stageFrames(page)) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (vis) return f;
  }
  return stageFrames(page)[0] ?? null;
}
/** 可见舞台此刻的样子:这张卡的包裹层(抑制、快照平面、占位符)、流播放器的各条轨道、舞台的时刻、舞台的源 */
async function stageState(page, id) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((cid) => {
    const diag = window.__pcStageDiag?.() ?? null;
    const tracks = (diag?.streams?.tracks ?? []).map((t) => ({ id: t.id, key: t.key ?? null, clips: String(t.id).split('#')[0].split(','), pushed: !!t.pushed, drawn: t.drawn, lastDrawn: t.lastDrawn,
      decoder: t.decoder, errors: t.errors, lastError: t.lastError || null }));
    const w = document.querySelector(`[data-pc-clip="${cid}"]:not([data-pc-media])`);
    let clip = { wrapper: false };
    if (w) {
      const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      clip = { wrapper: true, suppressed: w.classList.contains('pc-suppressed'), snapshot: !!snap && snap.childElementCount > 0,
        snapshotHidden: !!snap && getComputedStyle(snap).visibility === 'hidden', placeholder: !!slot && !slot.hidden,
        streamCanvas: !!w.querySelector(':scope > canvas[data-pc-stream-plane]'), stream: tracks.find((t) => t.clips.includes(cid)) ?? null };
    }
    return { t: diag?.t ?? null, clip, tracks, origin: location.origin, swaps: window.__bseSwaps ?? null };
  }, id).catch(() => null);
}
/** 截可见舞台(按舞台 iframe 的框裁);回 `{ file, png }` */
async function stageShot(page, dir, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  const file = path.join(dir, `${name}.png`);
  const buf = await page.screenshot({ path: file, clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
  return { file, png: PNG.sync.read(Buffer.from(buf)) };
}
/** 两张图的差:平均绝对差(每通道,0～255)、差得多的像素占比(任一通道差 > 48) */
function diffOf(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  let sum = 0, bad = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
      const d0 = Math.abs(a.data[i] - b.data[j]), d1 = Math.abs(a.data[i + 1] - b.data[j + 1]), d2 = Math.abs(a.data[i + 2] - b.data[j + 2]);
      sum += d0 + d1 + d2;
      if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
    }
  }
  return { mad: +(sum / (w * h * 3)).toFixed(3), bad: +(bad / (w * h)).toFixed(5), w, h };
}
/** 画面里橙块的像素占比(探针卡的块是 #f97316)与块上白字的像素占比 */
function colorsOf(png) {
  let orange = 0, white = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r > 200 && g > 80 && g < 160 && b < 90) orange++;
    else if (r > 225 && g > 215 && b > 200) white++;
  }
  const n = png.width * png.height;
  return { orange: +(orange / n).toFixed(5), white: +(white / n).toFixed(5) };
}

/** 暂停在 `sec`、等这张卡追到精确活渲(不抑制、没有快照、没有占位符、流平面撤了),截一张 */
async function liveShot(page, id, sec, dir, name) {
  // 先停下、等舞台报完最后一拍,再放播放头:刚从播放停下的那一下,舞台回报的时刻会盖掉同一刻发的 seek
  await store(page, `S.actions.pause(); return true;`);
  await delay(500);
  let ok = null, last = null;
  for (let round = 0; round < 5 && !ok; round++) {
    await pauseAt(page, sec);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !ok) {
      const s = await stageState(page, id);
      last = s ? { t: s.t, tracks: s.tracks.length, clip: { suppressed: s.clip.suppressed, snapshot: s.clip.snapshot, placeholder: s.clip.placeholder } } : null;
      if (s && Math.abs((s.t ?? -1) - sec) <= 0.5 / FPS && !s.tracks.length && s.clip.wrapper && !s.clip.suppressed && !s.clip.snapshot && !s.clip.placeholder) ok = s;
      else await delay(100);
    }
  }
  if (!ok) { fails.push(`${tag}等不到:暂停在 ${sec.toFixed(3)} 秒后追到精确活渲 :: ${JSON.stringify(last).slice(0, 400)}`); return null; }
  await delay(250);
  return stageShot(page, dir, name);
}

/** 这一刻这张卡是不是流在画:有它的轨道、画过帧、包裹层被抑制;给了 `key` 还要是这条流 */
const drawing = (s, key = null) => {
  const t = s?.clip?.stream;
  return t && typeof t.lastDrawn === 'number' && s.clip.suppressed && (!key || t.key === key) ? t : null;
};

/**
 * 播放中截一张、同时记下流播放器正画着第几帧(截图前后各读一次,差得不多才算数),再与那一帧的精确活渲、往后 2 秒的精确活渲比。
 * 通过线照 `online-stream-play-probe.mjs`:平均差 ≤ 1.5、差得多的像素 ≤ 0.2%;对照至少是它的 4 倍再加 0.2%。
 */
async function comparePixels(page, id, { from, name, dir, key, until: untilSec = from + 1.4 }) {
  const res = { name, tries: 0, rejects: [] };
  let shot = null, frame = null;
  for (let round = 0; round < 10 && !shot; round++) {
    await playFrom(page, from);
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000 && !shot) {
      const before = await stageState(page, id);
      const tb = drawing(before, key);
      // 起播后的头几百毫秒这一层可能还盖着「等快照」的沙漏(见文件头「已知」):等它退下再截
      if (!tb || before.clip.placeholder || (before.t ?? 0) < from + 0.25) { await delay(40); continue; }
      if ((before.t ?? 0) > untilSec) break;
      res.tries++;
      const s = await stageShot(page, dir, `${name}-stream`);
      const after = await stageState(page, id);
      const ta = drawing(after, key);
      if (!s || !ta || after.clip.placeholder) { res.rejects.push({ shot: !!s, drawing: !!ta, placeholder: !!after?.clip?.placeholder, t: after?.t ?? null }); continue; }
      // 截图那一下落在 f0～f1 之间:只收相差不超过 3 帧的(探针卡 3 帧只挪 1 像素,不影响结论)
      if (ta.lastDrawn - tb.lastDrawn <= 3) { shot = s; frame = Math.round((tb.lastDrawn + ta.lastDrawn) / 2); res.f0 = tb.lastDrawn; res.f1 = ta.lastDrawn; }
      else res.rejects.push({ frames: ta.lastDrawn - tb.lastDrawn });
    }
  }
  if (!check(!!shot, `${name}:播放中截到流在画的一帧`, res)) { await pauseAt(page, from).catch(() => {}); return res; }
  res.frame = frame;
  res.rejects = res.rejects.slice(-6);
  const same = await liveShot(page, id, frame / FPS, dir, `${name}-live-same`);
  const far = await liveShot(page, id, (frame + 2 * FPS) / FPS, dir, `${name}-live-far`);
  if (!check(!!same && !!far, `${name}:截到精确活渲的两张参照`, { same: !!same, far: !!far })) return res;
  res.same = diffOf(shot.png, same.png);
  res.far = diffOf(shot.png, far.png);
  res.colors = { stream: colorsOf(shot.png), live: colorsOf(same.png) };
  check(res.same.mad <= 1.5 && res.same.bad <= 0.002, `${name}:流的画面与同一帧的精确活渲相符(平均差 ≤ 1.5、差得多的像素 ≤ 0.2%)`, res.same);
  check(res.far.bad >= 0.004 && res.far.bad >= res.same.bad * 4 + 0.002, `${name}:与往后 2 秒的精确活渲比,差明显更大(对照)`, { same: res.same, far: res.far });
  check(res.colors.stream.orange > 0.02 && Math.abs(res.colors.stream.orange - res.colors.live.orange) <= 0.004, `${name}:流的画面里橙块在(不透明),大小与活渲的相同`, res.colors);
  return res;
}

/** 在可见与后台两个舞台里数这张卡的快照平面换了几次(流覆盖着的层垫的是海报,一个分段才换一张) */
async function watchSwaps(page, id) {
  for (const f of stageFrames(page)) {
    await f.evaluate((cid) => {
      if (window.__bseObserver) window.__bseObserver.disconnect();
      window.__bseSwaps = 0;
      window.__bseObserver = new MutationObserver((list) => {
        for (const m of list) {
          const plane = m.target instanceof Element ? m.target.closest('[data-pc-snapshot-plane]') : null;
          if (plane?.parentElement?.getAttribute('data-pc-clip') === cid && m.type === 'childList') window.__bseSwaps++;
        }
      });
      window.__bseObserver.observe(document.documentElement, { subtree: true, childList: true });
    }, id).catch(() => {});
  }
}

/**
 * 播一段、边播边采样。回 `{ samples, drawn, frames, first, last, swaps }`:`drawn` 是这张卡的流在画的样本,`frames` 是这些样本跨过的帧数,
 * `swaps` 是从第一个流在画的样本到最后,快照平面变动的次数。播完停回 `from`。
 */
async function playAndSample(page, id, { from, to, key = null }) {
  const res = { from };
  await watchSwaps(page, id);
  await playFrom(page, from);
  const samples = [];
  const t0 = Date.now();
  let swaps0 = null;
  while (Date.now() - t0 < 25_000) {
    const s = await stageState(page, id);
    if (!s) { await delay(40); continue; }
    if ((s.t ?? 0) >= to) break;
    if (swaps0 === null && drawing(s, key)) swaps0 = s.swaps;
    samples.push(s);
    await delay(45);
  }
  const lastState = await stageState(page, id);
  await pauseAt(page, from);
  const drawn = samples.filter((s) => drawing(s, key));
  const first = drawn[0] ?? null, last = drawn[drawn.length - 1] ?? null;
  return { ...res, samples, drawn, first, last, frames: first && last ? Math.round((last.t - first.t) * FPS) : 0,
    swaps: swaps0 !== null && typeof lastState?.swaps === 'number' ? lastState.swaps - swaps0 : null };
}

/** `playAndSample` 的结果按「这条流在画、不是快照在换」判;`who` 是断言的前缀 */
function checkStreamPlaying(who, r, { key }) {
  const a = r.first?.clip.stream, b = r.last?.clip.stream;
  const brief = { samples: r.samples.length, drawn: r.drawn.length, frames: r.frames, swaps: r.swaps, tFrom: r.first?.t ?? null, tTo: r.last?.t ?? null,
    track: b ? { key: String(b.key).slice(0, 12), pushed: b.pushed, decoder: b.decoder, drawnFrom: a.drawn, drawnTo: b.drawn, lastFrom: a.lastDrawn, lastTo: b.lastDrawn, errors: b.errors, lastError: b.lastError } : null,
    origin: r.last?.origin ?? null };
  check(r.drawn.length >= 8 && r.frames >= 15, `${who}:播放中这条流在画的时间够长(≥ 15 帧)`, brief);
  if (!a || !b) return brief;
  check(b.key === key, `${who}:舞台上画的就是这条流(轨道的键 = 层表里选中的结果键)`, { track: String(b.key).slice(0, 12), expect: String(key).slice(0, 12) });
  check(b.pushed === true, `${who}:流的字节是父页推给舞台的`, brief.track);
  check(b.drawn - a.drawn >= r.frames * 0.6 && b.lastDrawn > a.lastDrawn, `${who}:流播放器在出帧(画过的帧数跟着播放头涨)`, brief);
  check(Math.abs(b.lastDrawn - Math.round(r.last.t * FPS)) <= 3, `${who}:画着的那一帧跟着播放头(差不超过 3 帧)`, { lastDrawn: b.lastDrawn, stageFrame: Math.round(r.last.t * FPS) });
  check((b.errors ?? 0) === 0, `${who}:流播放器没有报错`, brief.track);
  check(r.drawn.every((s) => s.clip.suppressed), `${who}:播放中包裹层一直被抑制`, r.drawn.filter((s) => !s.clip.suppressed).length);
  // 起播(先放播放头再播)后的头 500 毫秒,这一帧的快照没到时舞台给这一层盖「等快照」的沙漏(`placeholderHost.ts` 的 T2,不看流在不在画);
  // 500 毫秒的兜底一过就撤。这里判:过了头 0.7 秒就不许再有占位符;头 0.7 秒里出现过几次照记(`placeholderEarly`)
  const withSlot = r.drawn.filter((s) => s.clip.placeholder);
  brief.placeholderEarly = withSlot.filter((s) => s.t <= r.from + 0.7).length;
  check(withSlot.every((s) => s.t <= r.from + 0.7), `${who}:起播 0.7 秒之后没有占位符`, withSlot.filter((s) => s.t > r.from + 0.7).map((s) => s.t));
  check(r.drawn.filter((s) => s.clip.snapshot && !s.clip.snapshotHidden).length <= 1, `${who}:流在画的时候快照平面藏着`, r.drawn.filter((s) => s.clip.snapshot && !s.clip.snapshotHidden).length);
  // 垫着的是海报:播 `frames` 帧只换约 frames / 15 次(每次换是一摘一挂,按两次变动算);每拍换的话是 frames × 2 次上下
  check(typeof r.swaps === 'number' && r.swaps <= (Math.ceil(r.frames / SEG) + 2) * 2, `${who}:不是快照在换(播 ${r.frames} 帧,快照平面只变动了 ${r.swaps} 次)`, { swaps: r.swaps, frames: r.frames });
  return brief;
}

/** 舞台的源有没有直接请求过 `px/`(流的开头文件与分段都在素材服务的这一类;`/media-s/` 那条隔离的路也算) */
const stagePxRequests = () => hostedProxy.requests.filter((r) => r.role !== 'editor' && /\/px\//.test(r.path));
const editorPxGets = () => hostedProxy.requests.filter((r) => r.role === 'editor' && r.method === 'GET' && /\/px\/[0-9a-f]{64}$/.test(r.path) && r.status === 200);

let browserA = null, browserB = null, editor = null, chk = null;
const LAUNCH_ARGS = ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', '--window-position=-32000,-32000'];

async function openMember(browser, { projectId, name, username, password, deviceId }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 240)));
  // 设备像素比取 1.25:舞台在页面里约 1020 CSS 像素宽,乘出来接近项目的 1280,截图里流的位图与活渲的文字差不多是一比一(放大了比,文字边缘会多出一圈差)
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.25 });
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name, username, password, deviceId }));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, `${username} 进入项目(刷新后回到项目那条路)`)) throw new Error(`${username} 没进去`);
  await until(`${username} 的页面双舞台握上手`, async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);
  return { ctx, page };
}

/* ================================================================== 一轮 */

async function runRound(streams, M) {
  tag = `[${streams}] `;
  const R = { streams };
  out.rounds[streams] = R;
  const dir = path.join(OUT, streams);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const deskFp = crypto.createHash('sha256').update(`bse-desk-${RUN}-${streams}`).digest('hex').slice(0, 16);
  let ctxA = null, ctxB = null;
  try {
    /* -------------------------------------------------------------- 0. 建项目、写进空项目、起桌面预渲染进程当切分方 */
    const projName = `整链-${streams}-${RUN}`;
    const creator = { username: 'bse-creator', password: `pw-${randomBytes(6).toString('hex')}` };
    const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
    const made = await M.createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
    const projectId = made.projectId;
    check((await seedProject({ projectId, creator, name: projName })).ok, '替创建者写进空项目');
    const editorDir = path.join(dir, 'editor');
    for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
    const sharedConfig = path.join(editorDir, 'shared.json');
    const deskDevice = `bse-desk-${streams}-${RUN}`.padEnd(16, '0');
    fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render', deviceId: deskDevice, deviceName: '整链探针 桌面' }]));
    await until('桌面编辑器的端口空着', async () => (await Promise.all([0, 1, 2].map((d) => portFree(PORTS.desk + d)))).every(Boolean), 30_000, 500);
    editor = await startQueueEditor({ port: PORTS.desk, dir: editorDir, sharedConfig, fakeFingerprint: deskFp, band: BAND, extraEnv: {
      PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
      PROMPTCUT_DEVICE_ID: deskDevice, PROMPTCUT_DEVICE_NAME: '整链探针 桌面',
      // 只切分、不认领细任务(D15 的测试开关);流开关按这一轮
      PROMPTCUT_TEST_PLAN_ONLY: '1', PROMPTCUT_STREAMS: streams === 'on' ? '1' : '0' } });
    const deskQueue = await editor.waitActive();
    check(deskQueue.envFingerprint === deskFp, '桌面预渲染进程用上了测试指纹', { envFingerprint: deskQueue.envFingerprint });
    const deskStreams = (await editor.diagnostics().catch(() => null))?.streams ?? null;
    check(deskStreams ? deskStreams.enabled === (streams === 'on') : streams === 'off', `切分方的流开关是${streams === 'on' ? '开' : '关'}着的`, deskStreams && { enabled: deskStreams.enabled });
    R.desk = { envFingerprint: deskQueue.envFingerprint, streamsEnabled: deskStreams?.enabled ?? null, upMs: Date.now() - t0 };
    say('desk.up', { round: streams, ...R.desk });

    // 核对用的连接(创建者,render 角色):内容库、票据
    const chkEntry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
      deviceId: `bse-chk-${streams}-${RUN}`.padEnd(16, '0'), deviceName: '整链探针 核对' });
    chk = M.createWsEndpoint({ url: chkEntry.url, protocols: M.sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
    await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
    const content = M.createContentClient(chk);
    const ticket = () => new Promise((resolve) => {
      const reqId = `tk-${RUN}-${Math.random().toString(36).slice(2)}`;
      chk.onMessage((msg) => { if (msg?.reqId === reqId) resolve(msg?.type === 'auth.ticket.ok' ? { Authorization: `Bearer ${msg.ticket}` } : {}); });
      chk.send({ type: 'auth.ticket', kind: 'asset', access: 'r', reqId });
    });
    const getManifest = async (resultKey, from, to) => (await content.get('render-manifest', `${resultKey}:${from}-${to}`).catch(() => null))?.body ?? null;
    const spansOf = (row) => { const o = []; for (let f = row.firstSegment; f <= row.lastSegment; f += row.segmentsPerTask) o.push([f, Math.min(row.lastSegment, f + row.segmentsPerTask - 1)]); return o; };

    /* -------------------------------------------------------------- 1. 甲进入、加一张重卡、当节点 */
    const a = await openMember(browserA, { projectId, name: projName, username: 'bse-jia', password: projectPassword, deviceId: `bse-jia-${streams}-${RUN}`.padEnd(16, '0') });
    ctxA = a.ctx;
    const pageA = a.page;
    const clipId = await store(pageA, `
      const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: args[0].start, duration: args[0].duration });
      S.actions.setClipParams(c.id, { burnMs: 40, label: args[1] });
      S.actions.seek(args[0].start + args[0].duration + 1);
      return c.id;`, CLIP, LABEL_1);
    R.clip = clipId;
    const docId = await store(pageA, `return S.getState().project.id;`);
    const ready = await until('甲当节点、报到拿到指纹、探到编码器', async () => { const d = await nodeDiag(pageA); return d?.ready === 'ready' && d.envFingerprint && d.streams?.capable ? d : null; }, 240_000, 500);
    check(ready?.eligibility?.ok && ready?.streams?.capable === true, 'A:甲当节点的条件成立,报能压流', ready && { eligibility: ready.eligibility, streams: ready.streams });
    const fpA = ready?.envFingerprint ?? null;
    R.jia = { envFingerprint: fpA, nodeId: ready?.nodeId ?? null, encoder: ready?.streams && { probe: ready.streams.probe, mode: ready.streams.mode } };
    say('jia.ready', { round: streams, ...R.jia });
    debugProbe = async () => ({ node: await P(pageA, () => { const d = window.__pcBrowserNode?.(); return d ? { ready: d.ready, state: d.state, reason: d.reason, idle: d.idle, counters: d.counters, holding: d.holding, last: d.lastError } : null; }),
      plan: await P(pageA, () => { const p = window.__pcPlanPublisher?.(); return p ? { last: p.last, log: (p.log ?? []).slice(-3) } : null; }), desk: (await editor.queue().catch(() => null))?.stats ?? null });

    /* -------------------------------------------------------------- 2. A 产:清单计划 → 桌面切分 → 甲认领快照与流 → 完成 */
    const tBake = Date.now();
    const seen = new Set();
    const produced = await until('甲做完这张卡的流任务(两个)与快照任务', async () => {
      const d = await nodeDiag(pageA);
      for (const h of d?.holding ?? []) seen.add(h.id);
      return d?.counters?.streamTasks >= 2 && d.counters.completed >= 3 && d.state !== 'baking' ? d : null;
    }, 900_000, 250);
    const diagA = produced ?? (await nodeDiag(pageA));
    R.produce = { ms: produced ? Date.now() - tBake : null, counters: diagA?.counters ?? null, streams: diagA?.streams ?? null, claimed: [...seen] };
    say('jia.produced', { round: streams, ms: R.produce.ms, counters: diagA?.counters });
    const streamIds = [...seen].filter((id) => id.startsWith('stream:')).sort();
    check(diagA?.counters?.streamTasks >= 2 && diagA?.counters?.failed === 0, 'A:甲认领并完成了流任务,没有失败', diagA?.counters);
    check(streamIds.length >= 1, 'A:甲手里出现过 stream: 任务', [...seen]);
    const deskQ = await editor.queue().catch(() => null);
    R.desk.stats = deskQ?.stats ?? null;
    check(deskQ && deskQ.stats.completed === 0 && deskQ.stats.planSplit >= 1, 'A:切分方只切分(planSplit ≥ 1),一个细任务都没做', deskQ?.stats);

    /* -------------------------------------------------------------- 3. B 层表 */
    const layerKey = `layers:${docId}`;
    const rowNow = async () => {
      const body = (await content.get('snapshot-manifest', layerKey).catch(() => null))?.body ?? null;
      return { body, row: (body?.streams ?? []).find((r) => r.topClipId === clipId) ?? null };
    };
    const briefRow = (row) => row && { topClipId: row.topClipId, kind: row.kind, plane: row.plane, clipIds: row.clipIds, contentKey: String(row.contentKey).slice(0, 12),
      candidates: (row.candidates ?? []).map((c) => ({ envFingerprint: c.envFingerprint, resultKey: String(c.resultKey).slice(0, 12) })), firstSegment: row.firstSegment, lastSegment: row.lastSegment,
      segmentsPerTask: row.segmentsPerTask, inputSig: row.inputSig ?? null };
    const got1 = await until('层表里出现这张卡的流', async () => { const x = await rowNow(); return x.row ? x : null; }, 60_000, 500);
    const map1 = got1?.body ?? (await rowNow()).body;
    const row1 = got1?.row ?? null;
    R.layerMap = { v: map1?.v ?? null, layers: (map1?.layers ?? []).map((l) => l.clipId), streams: (map1?.streams ?? []).length, row: briefRow(row1) };
    if (!check(map1?.v === 3 && !!row1, 'B:层表(v 3)带 streams,有这张卡的一行', R.layerMap)) throw new Error('层表里没有这条流');
    const candA = row1.candidates.find((c) => c.envFingerprint === fpA) ?? null;
    check(row1.kind === 'card' && row1.plane === 'local' && row1.clipIds.join() === clipId && /^s1-/.test(row1.inputSig ?? ''), 'B:这一行是这张卡的单卡流,带输入签名', R.layerMap.row);
    check(!!candA && candA.resultKey === M.resultKeyOf(row1.contentKey, fpA), 'B:候选里有甲的指纹,结果键 = 内容键 × 甲的指纹', R.layerMap.row);
    check(row1.firstSegment === 0 && row1.lastSegment === 8 && row1.segmentsPerTask === 8, 'B:分段范围 0～8,每个任务 8 段', R.layerMap.row);
    if (streams === 'off') check(row1.candidates.length === 1 && row1.candidates.every((c) => c.envFingerprint !== deskFp), 'B:切分方关着流开关、自己不产:候选只有浏览器指纹,不列切分方的', R.layerMap.row);
    else check(row1.candidates[0]?.envFingerprint === fpA, 'B:切分实际出键的浏览器指纹排在候选最前', R.layerMap.row);
    const key1 = candA?.resultKey ?? null;
    check(!!key1 && streamIds.every((id) => id.startsWith(`stream:${key1}:`)) && streamIds.length >= 1, 'B:甲做的流任务的结果键就是层表里这个候选的结果键', { streamIds: streamIds.map((s) => s.slice(0, 26) + s.slice(-4)), key: String(key1).slice(0, 12) });

    // A(续):流清单与素材服务上的块
    const auth = await ticket();
    const blocks = [];
    let manifestsOk = 0;
    for (const [from, to] of spansOf(row1)) {
      const m = key1 ? await getManifest(key1, from, to) : null;
      const segs = Object.keys(m?.segments ?? {}).map(Number).sort((x, y) => x - y);
      const inits = Object.keys(m?.inits ?? {});
      const ok = !!m && M.manifestMatches(m, { kind: 'stream', resultKey: key1, range: { from, to } }) && segs.length === to - from + 1 && segs[0] === from && inits.length >= 1
        && segs.every((n) => m.segments[n].encoder === 'webcodecs-avc' && m.segments[n].stride === 1 && m.segments[n].samples === Math.min(SEG, TOTAL - n * SEG))
        && m.header?.kind === 'card' && m.header.clipIds?.join() === clipId;
      if (ok) manifestsOk++;
      for (const id of inits) blocks.push({ hash: m.inits[id].hash, bytes: m.inits[id].bytes });
      for (const n of segs) blocks.push({ hash: m.segments[n].hash, bytes: m.segments[n].bytes });
    }
    const uniq = [...new Map(blocks.map((b) => [b.hash, b])).values()];
    check(manifestsOk === spansOf(row1).length, 'A:内容库 render-manifest 里每个任务一份流清单(过 manifestMatches、分段齐、webcodecs-avc、满密度)', { manifestsOk, of: spansOf(row1).length });
    let complete = 0, hashOk = 0;
    for (const b of uniq) {
      const c = await (await fetch(`${SITE}/media/api/asset/px/${b.hash}/chunks`, { headers: auth })).json().catch(() => null);
      if (c?.complete) complete++;
      const body = Buffer.from(await (await fetch(`${SITE}/media/api/asset/px/${b.hash}`, { headers: auth })).arrayBuffer());
      if (sha256(body) === b.hash && body.length === b.bytes) hashOk++;
    }
    R.blocks = { count: uniq.length, bytes: uniq.reduce((s, b) => s + b.bytes, 0), complete, hashOk };
    check(uniq.length >= 10 && complete === uniq.length && hashOk === uniq.length, 'A:素材服务 px 里开头文件与 9 个分段都 complete,取回的字节哈希与清单一致', R.blocks);

    /* -------------------------------------------------------------- 4. 乙进入;C 就绪 */
    const pxStageBefore = stagePxRequests().length;
    const b = await openMember(browserB, { projectId, name: projName, username: 'bse-yi', password: projectPassword, deviceId: `bse-yi-${streams}-${RUN}`.padEnd(16, '0') });
    ctxB = b.ctx;
    const pageB = b.page;
    await until('乙收到这张卡', () => store(pageB, `return S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === args[0]));`, clipId), 60_000, 300);
    await until('乙测完(加载遮罩退下)', () => P(pageB, () => !document.querySelector('[data-pc="probe-gate"]')), 300_000, 300);
    const fpB = (await until('乙的节点状态落定', async () => { const d = await nodeDiag(pageB); return d && (d.ready === 'ready' || d.eligibility?.ok === false) ? d : null; }, 120_000, 500))?.envFingerprint ?? null;
    R.yi = { envFingerprint: fpB, sameFingerprintAsJia: fpB === fpA };
    await pauseAt(pageB, 0.6);
    const readyB = await until('C:乙认出这条流、播放头附近的分段就绪', async () => {
      const d = await onlineDiag(pageB);
      const s = (d?.streams ?? []).find((x) => x.clipId === clipId);
      return s && s.ready >= 2 ? d : null;
    }, 90_000, 300);
    const sB = (readyB?.streams ?? []).find((x) => x.clipId === clipId) ?? null;
    R.ready = sB && { kind: sB.kind, ready: sB.ready, envFingerprint: sB.envFingerprint, resultKey: String(sB.resultKey).slice(0, 12), candidates: sB.candidates, stale: readyB.staleStreams, tier: readyB.tier,
      streamFetches: readyB.streamFetches, streamFailures: readyB.streamFailures, aliveKeys: readyB.aliveKeys, deadKeys: readyB.deadKeys,
      layers: (readyB.layers ?? []).map((l) => ({ clipId: l.clipId, kind: l.kind, envFingerprint: l.envFingerprint, ready: l.ready, candidates: l.candidates })) };
    check(!!sB && sB.kind === 'card' && sB.resultKey === key1 && sB.envFingerprint === fpA && readyB.staleStreams.length === 0, 'C:乙的就绪索引里有这条流,选中的就是甲产的那一份,没有过期的', R.ready ?? (await onlineDiag(pageB))?.streams);

    /* -------------------------------------------------------------- 5. D 流在画(乙) */
    const playB = await playAndSample(pageB, clipId, { from: 0.6, to: 2.1, key: key1 });
    R.playYi = checkStreamPlaying('D 乙', playB, { key: key1 });
    const stagePx = stagePxRequests().slice(pxStageBefore);
    R.px = { stage: stagePxRequests().length, stageSinceYi: stagePx.length, editorGets: editorPxGets().length };
    check(stagePxRequests().length === 0, 'D:两个舞台的源一次都没请求过 px/(甲、乙两页都算)', stagePxRequests().slice(0, 4));
    check(R.px.editorGets > 0, 'D:流的字节是编辑器页的源去素材服务取的(px/ 的 GET)', R.px);
    check(new Set(ORIGINS.stages).has(playB.last?.origin), 'D:乙的舞台在自己的源上(跨源、隔离的那一种)', { origin: playB.last?.origin ?? null });

    /* -------------------------------------------------------------- 6. E 像素(乙) */
    R.pixels = await comparePixels(pageB, clipId, { from: 0.6, name: 'e-yi', dir, key: key1, until: 2.2 });

    /* -------------------------------------------------------------- 7. F 甲自己播 */
    await pauseAt(pageA, 0.6);
    const readyA = await until('F:甲认出自己产的流、分段就绪', async () => { const d = await onlineDiag(pageA); const s = (d?.streams ?? []).find((x) => x.clipId === clipId); return s && s.ready >= 2 ? s : null; }, 90_000, 300);
    check(!!readyA && readyA.resultKey === key1, 'F:甲的就绪索引里选中的是自己产的那条流', readyA && { resultKey: String(readyA.resultKey).slice(0, 12), ready: readyA.ready });
    const playA = await playAndSample(pageA, clipId, { from: 0.6, to: 2.1, key: key1 });
    R.playJia = checkStreamPlaying('F 甲', playA, { key: key1 });
    await pauseAt(pageA, CLIP.start + CLIP.duration + 1);

    /* -------------------------------------------------------------- 8. G 改参数:旧流不再贴,新流产出来后贴新的 */
    const before = { a: (await nodeDiag(pageA))?.counters ?? null, b: (await nodeDiag(pageB))?.counters ?? null };
    await pauseAt(pageB, 0.6);
    await until('G:乙停在卡上、旧流就绪', async () => { const s = ((await onlineDiag(pageB))?.streams ?? []).find((x) => x.clipId === clipId); return s && s.resultKey === key1 && s.ready >= 2; }, 30_000, 200);
    const tEdit = Date.now();
    await store(pageA, `S.actions.setClipParams(args[0], { burnMs: 40, label: args[1] }); return true;`, clipId, LABEL_2);
    await until('G:乙收到改动', () => store(pageB, `return S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === args[0] && c.params && c.params.label === args[1]));`, clipId, LABEL_2), 30_000, 50);
    const tSeen = Date.now();
    const withdrawn = await until('G:乙把旧流撤了', async () => { const d = await onlineDiag(pageB); return d && !(d.streams ?? []).some((x) => x.resultKey === key1) ? d : null; }, 10_000, 50);
    const withdrawMs = Date.now() - tSeen;
    check(!!withdrawn, 'G:改动到乙之后,在线来源不再列旧流(输入签名过期)', withdrawn && { stale: withdrawn.staleStreams, streams: withdrawn.streams.map((x) => String(x.resultKey).slice(0, 12)) });
    // 旧流不再贴:乙马上播一小段,舞台上没有旧键的轨道在画(乙在播,不闲,这一段新任务由甲认领)
    await delay(300);
    const playOld = await playAndSample(pageB, clipId, { from: 0.6, to: 1.6, key: key1 });
    const oldSeen = playOld.samples.filter((s) => s.tracks.some((t) => t.key === key1));
    R.stale = { editToSeenMs: tSeen - tEdit, withdrawMs, samples: playOld.samples.length, oldTrackSamples: oldSeen.length,
      during: playOld.samples.slice(0, 3).map((s) => ({ t: s.t, suppressed: s.clip.suppressed, snapshot: s.clip.snapshot, placeholder: s.clip.placeholder, tracks: s.tracks.length })) };
    check(playOld.samples.length >= 5 && oldSeen.length === 0, 'G:旧流不再贴(改动后乙播放,舞台上没有旧键的轨道)', R.stale);
    await pauseAt(pageB, CLIP.start + CLIP.duration + 1);

    const tNew = Date.now();
    const got2 = await until('G:层表换成新一版的流,新流的清单齐', async () => {
      const x = await rowNow();
      if (!x.row || x.row.contentKey === row1.contentKey) return null;
      const cand = x.row.candidates.find((c) => c.envFingerprint === fpA) ?? x.row.candidates[0];
      for (const [from, to] of spansOf(x.row)) {
        const m = await getManifest(cand.resultKey, from, to);
        if (!m || Object.keys(m.segments ?? {}).length !== to - from + 1) return null;
      }
      return { ...x, cand };
    }, 900_000, 1000);
    const row2 = got2?.row ?? null;
    const key2 = got2?.cand?.resultKey ?? null;
    const after = { a: (await nodeDiag(pageA))?.counters ?? null, b: (await nodeDiag(pageB))?.counters ?? null };
    const tasksBy = { jia: (after.a?.streamTasks ?? 0) - (before.a?.streamTasks ?? 0), yi: (after.b?.streamTasks ?? 0) - (before.b?.streamTasks ?? 0) };
    R.reissue = { ms: got2 ? Date.now() - tNew : null, row: briefRow(row2), streamTasksBy: tasksBy, failed: { jia: after.a?.failed ?? null, yi: after.b?.failed ?? null } };
    say('reissued', { round: streams, ...R.reissue });
    if (check(!!row2 && !!key2 && key2 !== key1 && row2.inputSig !== row1.inputSig && /^s1-/.test(row2.inputSig ?? ''), 'G:层表换成新的一行(内容键、结果键、输入签名都换了)', { old: briefRow(row1), now: briefRow(row2) })) {
      check(tasksBy.jia + tasksBy.yi >= 2 && (after.a?.failed ?? 0) === 0 && (after.b?.failed ?? 0) === 0, 'G:新一版的两个流任务由浏览器节点做完,没有失败', R.reissue);
      if (streams === 'off') check(row2.candidates.every((c) => c.envFingerprint !== deskFp), 'G:新的一行同样不列切分方的指纹', briefRow(row2));
      await pauseAt(pageB, 0.6);
      const readyB2 = await until('G:乙认出新流、分段就绪', async () => { const s = ((await onlineDiag(pageB))?.streams ?? []).find((x) => x.clipId === clipId); return s && s.resultKey !== key1 && s.ready >= 2 ? s : null; }, 90_000, 300);
      const keyB2 = readyB2?.resultKey ?? null;
      check(!!readyB2 && row2.candidates.some((c) => c.resultKey === keyB2), 'G:乙的就绪索引换成新流(选中的是新一行的候选)', readyB2 && { resultKey: String(keyB2).slice(0, 12), ready: readyB2.ready });
      const playNew = await playAndSample(pageB, clipId, { from: 0.6, to: 2.1, key: keyB2 });
      R.playNew = checkStreamPlaying('G 乙·新流', playNew, { key: keyB2 });
      R.pixelsNew = await comparePixels(pageB, clipId, { from: 0.6, name: 'g-yi-new', dir, key: keyB2, until: 2.2 });
      // 新流画的是新参数:旧流那张截图里块上有白字(`e2e`),新流这张与新一版的活渲一样没有
      const w1 = R.pixels?.colors?.stream?.white ?? null, w2 = R.pixelsNew?.colors?.stream?.white ?? null, l2 = R.pixelsNew?.colors?.live?.white ?? null;
      R.label = { oldStreamWhite: w1, newStreamWhite: w2, newLiveWhite: l2 };
      check(typeof w1 === 'number' && typeof w2 === 'number' && typeof l2 === 'number' && w1 >= 0.0002 && w2 <= w1 * 0.15 && l2 <= w1 * 0.15, 'G:新流画的是新参数(旧流那张有白字,新流这张与新一版的活渲一样没有)', R.label);
    }

    /* -------------------------------------------------------------- 9. H 页面错误 */
    R.pageErrors = { jia: pageA.errors.slice(0, 5), yi: pageB.errors.slice(0, 5) };
    check(pageA.errors.length === 0 && pageB.errors.length === 0, 'H:两个页面都没有未捕获的错误', R.pageErrors);
    const finalA = await nodeDiag(pageA);
    R.timings = { roundMs: Date.now() - t0, pixelsMs: finalA?.streams?.pixelsMs ?? null, encodeMs: finalA?.streams?.encodeMs ?? null, stageFrameMs: finalA?.stage?.frameMs ?? null };
    check((finalA?.manifests?.failed ?? 0) === 0, '清单写内容库没有失败', finalA?.manifests);
  } catch (e) {
    fails.push(`${tag}异常:${String(e?.stack ?? e).slice(0, 800)}`);
    try { if (debugProbe) R.atFailure = await debugProbe(); } catch { /* 页面不在了 */ }
  } finally {
    debugProbe = null;
    try { chk?.close(); } catch { /* 已关 */ }
    chk = null;
    try { await ctxA?.close(); } catch { /* 已关 */ }
    try { await ctxB?.close(); } catch { /* 已关 */ }
    try { await editor?.stop(); } catch { /* 已停 */ }
    editor = null;
    say('round.done', { round: streams, ms: Date.now() - t0, fails: fails.length });
  }
}

/* ================================================================== 开跑 */

try {
  const dist = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  const { frameCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const embedded = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')).some((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8').includes(codeVersion));
  check(embedded, '在线构建嵌的代码版本与本进程算的一致(--dist 要是当前这份源码构建的)', { codeVersion: codeVersion.slice(0, 12) });
  check(fs.existsSync(path.join(dist, 'stage.html')), '在线构建里有舞台入口 stage.html(隔离的跨源舞台用它)');

  const M = {
    createSharedProject: (await import('../../server/auth/client.mjs')).createSharedProject, wsBaseOf: (await import('../../server/auth/route.mjs')).wsBaseOf,
    normalizeEntry: (await import('../../server/auth/shared-config.mjs')).normalizeEntry, sharedProtocols: (await import('../../server/auth/shared-config.mjs')).sharedProtocols,
    createWsEndpoint: (await import('../../server/render-node/ws-transport.mjs')).createWsEndpoint, createContentClient: (await import('../../server/render-node/content-client.mjs')).createContentClient,
    manifestMatches: (await import('../../server/artifact-transfer.mjs')).manifestMatches, resultKeyOf: (await import('../../server/render-node/fingerprint.mjs')).resultKeyOf,
  };
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  const launch = () => puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, ...LAUNCH_ARGS] });
  // 两个浏览器各开各的:同一个浏览器里只有一个标签页在前台,另一页是隐藏的(不播放、节点也让路)
  [browserA, browserB] = await Promise.all([launch(), launch()]);

  for (const streams of ONLY ? [ONLY] : ['off', 'on']) await runRound(streams, M);
  tag = '';
  out.ok = fails.length === 0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  try { await browserA?.close(); } catch { /* 已关 */ }
  try { await browserB?.close(); } catch { /* 已关 */ }
  try { await editor?.stop(); } catch { /* 已停 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
