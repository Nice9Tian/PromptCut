/**
 * R8 轨道流在**真编辑台**里的端到端探针:父页(`Preview` / `snapshotFeed`)按就绪索引合成流平面、
 * 预渲染进程发分段字节、舞台解码贴流 —— 一整条链。
 *
 *   node scripts/probes/stream-editor-e2e.mjs --origin http://127.0.0.1:5236 [--seconds 30] [--out <dir>] [--json <file>]
 *
 * **这支探针只对打过 `r8-glue.patch` 的 dev server 有意义**(补丁把分段读口挂到 `server/vite-plugin-frames.ts`、
 * 让父页发 `setStreamPlanes` / 不把 `stream` 层当快照,见 `TASK-REPORT.md`)。没打补丁的 server 上,
 * 生产者等不到读口、一条流都不产,探针会在「等流生产完」那一步超时。
 *
 * 另外:dual 模式的编辑台今天**没有人调 `/api/frames/preload`**(只有 legacy 的 `UnifiedPreview` 调),
 * 预渲染进程的后台预渲染(锚帧、快照,以及轨道流的生产入口)不会被触发 —— 这支探针自己按
 * `{ session, localRev }` 调它,等于补上那个触发点(见报告「待用户定」)。
 *
 * 流程:开编辑台(`?preview=stage`)→ 换空项目、加一张长粒子卡(缺省 30 秒,按追帧上界判重)→
 * 反复调 preload 直到这张卡的流满密度 → 父页的就绪索引里有 `stream` 层 → 播放 2 秒:
 *   - 父页把它抑制了、发了带流键的 `setStreamPlanes`,而且**没有给它投快照**(A3c);
 *   - 可见舞台上这条流画出了帧、解码器没报错;
 * → 暂停:流平面清空,改贴快照 / 追到活渲。截图存盘。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { devOrigin, flagArg } from './probe-connect.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const SECONDS = Number(flagArg('seconds', '30', args)) || 30;
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-e2e-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, fn, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await sleep(everyMs);
  }
}

const out = { origin, seconds: SECONDS };
await fs.mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 120000, polling: 500 });
  const clipId = await page.evaluate(async (seconds) => {
    const { actions } = await import('/src/store/project.ts');
    actions.newProject('stream-e2e');
    const c = actions.addCardClip('particles', 0, { duration: seconds, params: { color: '#30ff60', quantity: 100, links: 'yes', seed: 5 } });
    actions.seek(0);
    return c?.id;
  }, SECONDS);
  out.clipId = clipId;
  check(!!clipId, '加上了粒子卡');
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  out.prerender = prerender.url;
  const key = await until('镜像键', () => page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey()), 30000, 500);
  out.mirrorKey = key;
  // 反复 preload(它自己的节奏:没 ready 就 2 秒一次),直到这张卡的流满密度
  const status = await until('轨道流生产完', async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const d = await (await fetch(prerender.url + '/api/frames/diagnostics')).json();
    const s = d.streams;
    out.streamsStatus = s ? { enabled: s.enabled, routeAttached: s.routeAttached, streams: s.streams.map((x) => ({ clipIds: x.clipIds, segs: Object.keys(x.segments).length, dense: Object.values(x.segments).filter((g) => g.stride === 1).length, first: x.firstSegment, last: x.lastSegment })) } : null;
    const mine = s?.streams?.find((x) => x.clipIds.includes(clipId));
    if (!mine) return null;
    for (let n = mine.firstSegment; n <= mine.lastSegment; n++) if (mine.segments[n]?.stride !== 1) return null;
    return mine;
  }, 600000, 2000);
  check(!!status, '这张卡的流满密度了', out.streamsStatus);
  // 父页的就绪索引里有它的 stream 层
  const layer = await until('父页收到 stream 层', () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const l = m.currentReadyIndex().get(id)?.get('stream');
    return l ? { key: l.key, ranges: l.ranges } : null;
  }, clipId), 30000, 500);
  out.parentLayer = layer;
  check(!!layer, '父页的就绪索引里有 stream 层');
  // 播放 2 秒
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(3); actions.play(); });
  await sleep(2500);
  const frontId = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const stage = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${frontId}`));
  const diag = await stage.evaluate(() => window.__pcStageDiag());
  const preview = await page.evaluate(() => window.__pcPreviewDiag());
  out.playing = { suppressed: diag.suppressed, snapshots: diag.snapshots, streamPlanes: diag.streamPlanes, streams: diag.streams, previewSuppressed: preview.suppressed };
  check(diag.suppressed.includes(clipId), '播放中这张卡被抑制', diag.suppressed);
  check(diag.streamPlanes.some((p) => p.clipIds.includes(clipId) && p.key === layer?.key), '父页发了带流键的 setStreamPlanes', diag.streamPlanes);
  check(!diag.snapshots.includes(clipId), '有流分段时父页不给它投快照(A3c)', diag.snapshots);
  const track = diag.streams.tracks.find((t) => t.id.startsWith(clipId));
  check(!!track && track.drawn > 10 && track.errors === 0, '可见舞台上这条流画出了帧、解码器没报错', track);
  const frameBox = await (await page.$('iframe[data-pc="stage-frame"]'))?.boundingBox?.();
  const shot = path.join(OUT, 'editor-playing.png');
  await page.screenshot({ path: shot });
  out.shot = shot;
  // 暂停:流平面清空
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
  await sleep(1500);
  const paused = await stage.evaluate(() => window.__pcStageDiag());
  out.paused = { suppressed: paused.suppressed, streamPlanes: paused.streamPlanes, snapshots: paused.snapshots, tracks: paused.streams.tracks.length };
  check(paused.streamPlanes.length === 0 && paused.streams.tracks.length === 0, '暂停后流平面清空、解码器关掉', out.paused);
  out.frameBox = frameBox ?? null;
  out.pageErrors = errors;
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
} finally {
  out.fails = fails;
  await browser.close().catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}
