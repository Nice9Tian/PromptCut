/**
 * 手按着标尺不动时,快照要贴得上(出处 `docs/plan/render-refactor-task.md`「己」的「先要修的两处」第 2 条)。
 *
 *   node scripts/probes/scrub-hold-snapshot-probe.mjs [--port 7487] [--out <目录>] [--json <文件>] [--hold 2000]
 *   node scripts/probes/scrub-hold-snapshot-probe.mjs --origin http://127.0.0.1:7480 …   # 接一台已经起好的 dev server,不自己起
 *
 * 不带 `--origin` 时自己起一台隔离的编辑器(`preview-stop-lib.mjs` 的 `startIsolatedEditor`;舞台端口是 +1、+2,三个连号都要空着),
 * 跑完结束它。Chrome 无头。
 *
 * 毛病是什么。拖到一处时父页发 `setTime`,这一帧的快照字节手里没有就当场去取;取到之后补投一次。换帧有 33 毫秒的节流
 * (`snapshotFeed.ts` 的 `SNAPSHOT_THROTTLE_MS`),节流的起点就是发 `setTime` 的那一刻 —— 字节在 33 毫秒内到货,补投被节流挡掉;
 * 手按着不动就再没有别的事件来投,这一层一直贴不上(藏 500 毫秒后露出活组件,或者一直挂着上一处的旧快照)。
 *
 * 流程:
 *   0. 新建项目,放一张粒子卡(0～6 秒),等它的成本记录,钉成重卡,触发预渲染,等每一帧的快照都就绪、轨道流的分段全部满帧,
 *      再等就绪索引安静下来(连着 5 秒没有变化)。预渲染还在产流的时候每来一条就绪消息父页都会重投一次,会把这个毛病盖住:
 *      没修的代码上那几处会在几百到一千多毫秒后被顺带救回来,量出来的就不是这个毛病了。
 *   1. 换一个快照来源(`snapshotFeed.ts` 的 `setSnapshotSource`,给测试和探针留的口子):包住原来的 HTTP 来源,记下每次取字节
 *      的时刻;给了延时就让字节正好在「开始取之后那么多毫秒」到货(先把这一帧预取进里层缓存,到货时刻就只由延时定)。
 *   2. **照实际速度**(不控制到货时刻):在标尺上按住鼠标,依次挪到 12 处、每处按住不动 `--hold` 毫秒(缺省 2000)。
 *   3. **控制到货时刻**:再挪 12 处,字节分别在开始取之后 1、5、9、13、17、21、25、28 毫秒(都在节流窗口里;实际落点会晚两三毫秒,
 *      所以最晚的一处留了 5 毫秒余量)和 45、60、100、200 毫秒(窗口外,作对照)到货。
 *   每一处都是之前没取过字节的帧(挪过去之前核对父页缓存里没有)。断言:
 *     - 落点就是目标帧,发给舞台的 `setTime` 不带 settle,拖动标志一直在;
 *     - 按住的这段时间里快照贴上了:舞台的快照表里有这张卡、包裹层里有快照平面,平面里那张图就是**这一帧**的快照
 *       (和父页取到的这一帧的字节比图的签名;挂着上一处的旧快照不算);
 *     - 到这一处按住结束时仍然贴着。
 *   4. 松手:这张卡回到精确活渲(只记录)。
 *
 * 验收:退出码 0,结果里 `fails: []`。耗时只记录(`verification.md`「耗时只记录,不当闸门」):每一处从发 `setTime` 到贴上的毫秒数
 * 写进 `timings` 和结果。等待时限只为防卡死。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';
import { costRecordOf, openEditorPage, sleep, startIsolatedEditor, waitFor } from './preview-stop-lib.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '7487', args)) || 7487;
const HOLD_MS = Number(flagArg('hold', '2000', args)) || 2000;
const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-scrub-hold-${RUN}`);
const OUT = path.resolve(flagArg('out', null, args) || path.join(WORK, 'out'));
const JSON_OUT = flagArg('json', null, args);
const FPS = 30;
const SECONDS = 6;
const FRAMES = SECONDS * FPS;
/** 按下的位置 */
const START_FRAME = 10;
/** 照实际速度的 12 处(互不相同,含往回的) */
const NATURAL = [31, 47, 62, 78, 23, 91, 105, 55, 119, 133, 84, 147];
/** 控制到货时刻的 12 处:[帧, 开始取之后多少毫秒到货] */
const CONTROLLED = [[36, 1], [52, 5], [67, 9], [83, 13], [28, 17], [96, 21], [110, 25], [59, 28], [124, 45], [138, 60], [89, 100], [152, 200]];
const THROTTLE_MS = 33;

const fails = [];
const notes = [];
const timings = createTimings('scrub-hold-snapshot-probe');
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); return !!cond; };
const frameOf = (t) => Math.round(t * FPS);

const out = { origin: null, ownEditor: !GIVEN_ORIGIN, holdMs: HOLD_MS, out: OUT };
let editor = null;
let browser = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  if (!GIVEN_ORIGIN) editor = await startIsolatedEditor({ port: PORT, work: WORK });
  const origin = (GIVEN_ORIGIN || editor.origin).replace(/\/+$/, '');
  out.origin = origin;
  const ed = await openEditorPage(origin);
  browser = ed.browser;
  const { page, store, frontFrame, parentDiag } = ed;
  const storeT = () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
  const scrubbing = () => page.evaluate(async () => (await import('/src/editor/timeline/useScrub.ts')).isScrubbing());

  /* ---------------------------------------------------------------- 0. 项目:一张钉成重卡的粒子卡,快照铺满 */
  const clipId = await store(`actions.newProject(args[0]);
    const c = actions.addCardClip('particles', 0, { duration: args[1], params: { color: '#30ff60', quantity: 120, links: 'yes', seed: 5 } });
    actions.pause(); actions.seek(0);
    return c?.id;`, `scrub-hold-${RUN}`, SECONDS);
  out.clipId = clipId;
  if (!check(!!clipId, '加上了粒子卡')) throw new Error('没有粒子卡');
  if (!(await waitFor(() => costRecordOf(page, clipId), 120000, 500))) notes.push('120 秒没等到成本记录');
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  const covered = (ranges, n) => { let c = 0; for (let i = 0; i < n; i++) if ((ranges ?? []).some((r) => r[0] <= i && i <= r[1])) c++; return c; };
  const htmlLayer = () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const layer = m.currentReadyIndex().get(id)?.get('html');
    return layer ? { key: layer.key, ranges: layer.ranges } : null;
  }, clipId);
  const startedPrerender = Date.now();
  const layer = await waitFor(async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    // 每一轮都重钉、重存:页面测完第二趟会把这条成本记录整条重写,钉重卡那一位会被冲掉,预渲染进程就不产它了
    await costRecordOf(page, clipId, { pinnedHeavy: true }, true);
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const l = await htmlLayer();
    return l && covered(l.ranges, FRAMES) >= FRAMES ? l : null;
  }, 900000, 2000);
  if (!check(!!layer, '这张卡每一帧的快照都就绪(15 分钟)', await htmlLayer())) throw new Error('快照没铺满');
  timings.record('粒子卡 180 帧快照就绪(从触发预渲染起)', Date.now() - startedPrerender);
  // 等轨道流的分段全部满帧(清单里每段 stride = 1),再等就绪索引安静下来:流还在产的时候每来一条就绪消息父页都会重投一次,
  // 被节流挡掉的那一次会被它顺带救回来
  {
    const segCount = Math.ceil(FRAMES / 15);
    const startedStream = Date.now();
    const full = await waitFor(async () => {
      const l = await page.evaluate(async (id) => {
        const m = await import('/src/editor/snapshotFeed.ts');
        const layer2 = m.currentReadyIndex().get(id)?.get('stream');
        return layer2 ? { key: layer2.key, ranges: layer2.ranges } : null;
      }, clipId);
      if (!l || covered(l.ranges, segCount) < segCount) return null;
      const manifest = await fetch(`${prerender.url}/api/frames/stream/${encodeURIComponent(l.key)}/manifest`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);
      if (!manifest) return null;
      for (let n = 0; n < segCount; n++) if ((manifest.segments?.[n]?.stride ?? 0) !== 1) return null;
      return true;
    }, 600000, 2000);
    out.streamFull = { full: !!full, ms: Date.now() - startedStream };
    // 流没产出来不算这支探针的失败(它验的是快照);只是没修的代码上可能被顺带救回几处,记一笔
    if (!full) notes.push('10 分钟没等到轨道流的分段全部满帧:预渲染可能还在干活');
    timings.record('快照就绪之后等轨道流满帧', Date.now() - startedStream);
  }
  const readySig = () => page.evaluate(async () => {
    const m = await import('/src/editor/snapshotFeed.ts');
    return JSON.stringify([...m.currentReadyIndex()].map(([id, kinds]) => [id, [...kinds].map(([k, l]) => [k, l.key, l.ranges])]));
  });
  {
    const startedQuiet = Date.now();
    let last = await readySig();
    let since = Date.now();
    let quiet = false;
    while (Date.now() - startedQuiet < 600000) {
      await sleep(500);
      const now = await readySig();
      if (now !== last) { last = now; since = Date.now(); continue; }
      if (Date.now() - since >= 5000) { quiet = true; break; }
    }
    out.readyQuiet = { quiet, ms: Date.now() - startedQuiet };
    check(quiet, '就绪索引安静下来了(连着 5 秒没有变化;等了 10 分钟)', out.readyQuiet);
    timings.record('快照就绪之后等就绪索引安静', Date.now() - startedQuiet);
  }
  await costRecordOf(page, clipId, { pinnedHeavy: true });
  await sleep(500);
  check((await parentDiag())?.snapshotFeed?.heavy?.includes(clipId), '父页的分派表里这张卡判重', (await parentDiag())?.snapshotFeed?.heavy);

  /* ---------------------------------------------------------------- 1. 换一个记时刻、能控制到货时刻的快照来源 */
  await page.evaluate(async () => {
    const feed = await import('/src/editor/snapshotFeed.ts');
    const { HttpSnapshotSource } = await import('/src/render/snapshotSource.ts');
    const inner = new HttpSnapshotSource();
    const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
    /** 快照里那几张内嵌图的签名(舞台那边对快照平面里的图用同一个算式) */
    const sigOf = (html) => {
      const t = document.createElement('template');
      t.innerHTML = html;
      const srcs = [...t.content.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '').filter((s) => s.startsWith('data:image/'));
      const joined = srcs.join('|');
      return `${srcs.length}:${joined.length}:${hash(joined)}`;
    };
    const ctl = window.__probeFeed = { delayMs: null, log: [], sig: {}, inner };
    feed.setSnapshotSource({
      subscribeReady: (...a) => inner.subscribeReady(...a),
      fetchSnapshot: async (kind, key, frame, signal) => {
        const askedAt = performance.now();
        const want = ctl.delayMs;
        const html = await inner.fetchSnapshot(kind, key, frame, signal);
        const fetchedMs = performance.now() - askedAt;
        if (want !== null) {
          // 到货时刻 = 开始取之后 `want` 毫秒(里层已经预取过,`fetchedMs` 远小于它)。
          // 定时器的粒度有四五毫秒:离得远用定时器,最后几毫秒改用消息通道一圈一圈让出去,落点能准到一毫秒以内
          const turn = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
          for (;;) {
            const left = askedAt + want - performance.now();
            if (left <= 0) break;
            if (left > 10) await new Promise((r) => setTimeout(r, left - 8));
            else await turn();
          }
        }
        ctl.sig[frame] = sigOf(html);
        ctl.log.push({ frame, kind, askedAt, fetchedMs, arrivedMs: performance.now() - askedAt, delay: want, bytes: html.length });
        return html;
      },
    });
  });

  /* ---------------------------------------------------------------- 标尺:帧 → 屏幕坐标 */
  const ruler = await page.evaluate(() => {
    const el = document.querySelector('[data-pc="ruler"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ticks = [...el.querySelectorAll('.pc-tl-tick.is-major')].map((t) => {
      const label = t.querySelector('.pc-tl-tick-label')?.textContent ?? '';
      const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(label.trim());
      return m ? { sec: Number(m[1]) * 60 + Number(m[2]), x: t.getBoundingClientRect().left } : null;
    }).filter(Boolean);
    return { left: r.left, right: r.right, y: r.top + r.height / 2, ticks };
  });
  if (!ruler || ruler.ticks.length < 2) throw new Error('量不到标尺的刻度');
  const t0 = ruler.ticks[0], t1 = ruler.ticks[ruler.ticks.length > 2 ? 2 : 1];
  const pxPerSec = (t1.x - t0.x) / (t1.sec - t0.sec);
  // 零点按播放头此刻的位置定(它的中线就是 store.t 那一刻)
  await store('actions.pause(); actions.seek(args[0]);', 3);
  await sleep(300);
  const head = await page.evaluate(async () => {
    const el = document.querySelector('[data-pc="playhead"]');
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, t: (await import('/src/store/project.ts')).getState().t } : null;
  });
  let xZero = head ? head.x - head.t * pxPerSec : t0.x - t0.sec * pxPerSec;
  out.ruler = { pxPerSec: +pxPerSec.toFixed(3), xZero: +xZero.toFixed(2), left: ruler.left, right: ruler.right };
  check(pxPerSec / FPS >= 2, '标尺上一帧至少 2 像素(指针落得准)', out.ruler);
  check(xZero + SECONDS * pxPerSec < ruler.right - 4, '整张卡都在标尺的可见范围里', out.ruler);
  // 瞄这一帧所占那一格的正中
  const xOf = (frame) => xZero + ((frame + 0.5) / FPS) * pxPerSec;
  /** 鼠标挪到这一帧;落点差一两像素没对上帧格就左右各试一下。回真的落到的帧 */
  const moveToFrame = async (frame, { down = false } = {}) => {
    let landed = null;
    for (const dx of [0, 1, -1, 2, -2]) {
      await page.mouse.move(Math.round(xOf(frame)) + dx, ruler.y);
      if (down && landed === null) await page.mouse.down();
      const ok = await waitFor(async () => (frameOf(await storeT()) === frame ? true : null), 600, 20);
      landed = frameOf(await storeT());
      if (ok) { if (dx) xZero += dx; break; }
    }
    return landed;
  };

  /* ---------------------------------------------------------------- 舞台侧:这张卡此刻贴着什么 */
  const stageState = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((id) => {
      const d = window.__pcStageDiag?.();
      if (!d) return null;
      const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
      const plane = wrap?.querySelector(':scope > [data-pc-snapshot-plane]') ?? null;
      const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
      let sig = null;
      if (plane) {
        const srcs = [...plane.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '').filter((s) => s.startsWith('data:image/'));
        const joined = srcs.join('|');
        sig = `${srcs.length}:${joined.length}:${hash(joined)}`;
      }
      return { t: d.t, cls: wrap?.className ?? null, inTable: d.snapshots.includes(id), awaiting: d.awaiting.includes(id), plane: !!plane, sig,
        at: (window.__pcRealNow ?? (() => Date.now()))() };
    }, clipId).catch(() => null);
  };
  const feedOf = (frame) => page.evaluate(async (id, frame2, fps) => {
    const feed = await import('/src/editor/snapshotFeed.ts');
    const { getState } = await import('/src/store/project.ts');
    const head = { project: getState().project, t: frame2 / fps, playing: false };
    const pick = feed.planFeed(head).picks.get(id) ?? null;
    const dbg = feed.snapshotFeedDebug(head).picks.find((p) => p.clipId === id) ?? null;
    return { pick: pick && { kind: pick.kind, key: pick.key, localFrame: pick.localFrame }, cached: dbg?.cached ?? null, flying: dbg?.flying ?? null };
  }, clipId, frame, FPS);
  const fetchLog = (frame) => page.evaluate((frame2) => {
    const ctl = window.__probeFeed;
    const hit = [...ctl.log].reverse().find((e) => e.frame === frame2) ?? null;
    return { sig: ctl.sig[frame2] ?? null, entry: hit && { fetchedMs: +hit.fetchedMs.toFixed(1), arrivedMs: +hit.arrivedMs.toFixed(1), delay: hit.delay, bytes: hit.bytes } };
  }, frame);

  /** 挪到一处、按住不动,看快照贴没贴上 */
  const holdAt = async (frame, delayMs, label) => {
    const step = { label, frame, delayMs };
    const pre = await feedOf(frame);
    step.pick = pre.pick;
    if (!check(pre.pick && pre.pick.localFrame === frame, `${label}:第 ${frame} 帧选得出这一帧的快照`, pre)) return step;
    if (!check(pre.cached === false && pre.flying === false, `${label}:第 ${frame} 帧的字节事先不在父页手里(这一处要现取)`, pre)) return step;
    await page.evaluate(async (pick, delay) => {
      const ctl = window.__probeFeed;
      // 控制到货时刻的那几处:先预取进里层缓存,到货时刻就只由延时定
      if (delay !== null) await ctl.inner.fetchSnapshot(pick.kind, pick.key, pick.localFrame);
      ctl.delayMs = delay;
    }, pre.pick, delayMs);
    const landed = await moveToFrame(frame);
    step.landed = landed;
    if (!check(landed === frame, `${label}:落在第 ${frame} 帧`, { landed })) return step;
    const movedAt = Date.now();
    let attachedAt = null;
    let last = null;
    while (Date.now() - movedAt < HOLD_MS) {
      const s = await stageState();
      const log = await fetchLog(frame);
      last = { s, log };
      const attached = !!s && Math.abs(s.t - frame / FPS) < 1e-6 && s.inTable && s.plane && !!log.sig && s.sig === log.sig;
      if (attached && attachedAt === null) attachedAt = Date.now();
      if (!attached && attachedAt !== null) { step.lost = true; attachedAt = null; }
      await sleep(attachedAt === null ? 15 : 100);
    }
    const pd = await parentDiag();
    const sent = [...(pd?.setTimeLog ?? [])].reverse().find((e) => Math.abs(e.sec - frame / FPS) < 1e-6) ?? null;
    step.scrubbing = await scrubbing();
    step.setTimeSettle = sent ? sent.settle : null;
    step.fetch = last?.log?.entry ?? null;
    step.attached = attachedAt !== null;
    step.attachMs = attachedAt !== null ? attachedAt - movedAt : null;
    step.end = last?.s && { cls: last.s.cls, inTable: last.s.inTable, plane: last.s.plane, awaiting: last.s.awaiting, sameFrame: !!last.log.sig && last.s.sig === last.log.sig };
    check(step.scrubbing, `${label}:第 ${frame} 帧按住时拖动标志在`);
    check(sent && sent.settle === false, `${label}:第 ${frame} 帧发给舞台的 setTime 不带 settle`, sent);
    check(!!step.fetch, `${label}:第 ${frame} 帧的字节是这一处现取的`, step.fetch);
    if (delayMs !== null && step.fetch) {
      // 定在节流窗口里的要真的落在窗口里,定在窗口外的要真的落在窗口外(主线程忙的时候落点会晚几毫秒,照实记)
      const inside = step.fetch.arrivedMs < THROTTLE_MS;
      check(inside === (delayMs < THROTTLE_MS), `${label}:第 ${frame} 帧的字节定在开始取之后 ${delayMs} 毫秒到货,落点仍在节流窗口的同一侧`, step.fetch);
    }
    check(step.attached, `${label}:第 ${frame} 帧按住 ${HOLD_MS} 毫秒,这一帧的快照贴上了(字节 ${step.fetch ? step.fetch.arrivedMs + ' 毫秒' : '没'}到货)`, step.end);
    check(!step.lost, `${label}:第 ${frame} 帧的快照贴上之后没有又掉下来`, step.end);
    return step;
  };

  /* ---------------------------------------------------------------- 2、3. 按住拖 */
  // 先停在一处、追到精确活渲(起步是「停着」的样子)
  await store('actions.pause(); actions.seek(args[0]);', 2 / FPS);
  await waitFor(async () => { const s = await stageState(); const pd = await parentDiag(); return s && !s.inTable && !s.awaiting && !pd?.swapInFlight ? true : null; }, 20000, 50);
  await sleep(300);
  await page.keyboard.down('Alt');   // 不吸附到整秒 / 片段边界,落在哪一帧由坐标定
  const landedStart = await moveToFrame(START_FRAME, { down: true });
  check(landedStart === START_FRAME, `按下的位置落在第 ${START_FRAME} 帧`, { landedStart });
  check(await scrubbing(), '按下之后拖动标志在');
  await sleep(600);

  out.natural = [];
  for (let i = 0; i < NATURAL.length; i++) out.natural.push(await holdAt(NATURAL[i], null, `照实际速度第 ${i + 1} 处`));
  out.controlled = [];
  for (let i = 0; i < CONTROLLED.length; i++) out.controlled.push(await holdAt(CONTROLLED[i][0], CONTROLLED[i][1], `控制到货第 ${i + 1} 处`));
  await page.evaluate(() => { window.__probeFeed.delayMs = null; });

  /* ---------------------------------------------------------------- 4. 松手 */
  const releasedAt = Date.now();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const live = await waitFor(async () => {
    const s = await stageState();
    const pd = await parentDiag();
    return s && !s.inTable && !s.plane && !s.awaiting && !/pc-(settling|snapshot|suppressed|awaiting)/.test(s.cls ?? '') && !pd?.swapInFlight ? true : null;
  }, 30000, 50);
  out.release = { live: !!live, ms: Date.now() - releasedAt };
  if (live) timings.record('松手到回到精确活渲', out.release.ms);
  else notes.push('松手后 30 秒没回到精确活渲(只记录)');

  const all = [...out.natural, ...out.controlled];
  out.summary = {
    natural: { total: out.natural.length, attached: out.natural.filter((s) => s.attached).length,
      inWindow: out.natural.filter((s) => s.fetch && s.fetch.arrivedMs < THROTTLE_MS).length,
      inWindowAttached: out.natural.filter((s) => s.fetch && s.fetch.arrivedMs < THROTTLE_MS && s.attached).length },
    controlled: { total: out.controlled.length, attached: out.controlled.filter((s) => s.attached).length,
      inWindow: out.controlled.filter((s) => s.fetch && s.fetch.arrivedMs < THROTTLE_MS).length,
      inWindowAttached: out.controlled.filter((s) => s.fetch && s.fetch.arrivedMs < THROTTLE_MS && s.attached).length },
  };
  check(all.length >= 24, '按住了 24 处', { n: all.length });
  check(out.summary.controlled.inWindow >= 8, '控制到货的那一遍里有 8 处字节在节流窗口里到货', out.summary.controlled);
  for (const s of all) if (s.attachMs !== null && s.attachMs !== undefined) timings.record(`${s.label}(第 ${s.frame} 帧,字节 ${s.fetch?.arrivedMs ?? '?'} 毫秒到货):挪到位到贴上`, s.attachMs);
  out.pageErrors = ed.pageErrors.slice(0, 10);
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  try { editor?.stop(); } catch { /* 已经停了 */ }
}

out.notes = notes;
out.fails = fails;
out.timings = timings.list;
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
const row = (s) => `  ${s.label} 第 ${s.frame} 帧:字节 ${s.fetch ? s.fetch.arrivedMs + ' 毫秒到货' : '没取'}${s.delayMs !== null && s.delayMs !== undefined ? `(定的 ${s.delayMs})` : ''} → ${s.attached ? `贴上了(${s.attachMs} 毫秒)` : '没贴上'}${s.end ? ` [表里${s.end.inTable ? '有' : '无'}/平面${s.end.plane ? '有' : '无'}/这一帧${s.end.sameFrame ? '是' : '否'}/等待${s.end.awaiting ? '是' : '否'}]` : ''}`;
for (const s of [...(out.natural ?? []), ...(out.controlled ?? [])]) console.log(row(s));
console.log('汇总 ' + JSON.stringify(out.summary ?? null) + ' 松手 ' + JSON.stringify(out.release ?? null));
timings.print();
console.log(JSON.stringify({ probe: 'scrub-hold-snapshot-probe', out: OUT, summary: out.summary ?? null, notes, fails }, null, 2));
process.exit(fails.length ? 1 : 0);
