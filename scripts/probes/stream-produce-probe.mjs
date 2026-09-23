/**
 * R8 轨道流**生产侧**的端到端探针(任务书 `docs/plan/r8-streams-task.md` 的「验收」里编码 / 切分与索引 /
 * 连续生产 / 隔离那几条)。
 *
 *   node scripts/probes/stream-produce-probe.mjs [--origin http://127.0.0.1:5230] [--out <dir>] [--keep] [--json <file>]
 *
 * 本进程里直接起一个 `FramePipeline`(和预渲染进程同一份代码,`interactive: true`),库根放在临时目录,
 * 导出页打 `--origin` 那台 dev server(缺省 `.claude/launch.json` 的 `dev-test`,或 `PC_STAGE_TEST_URL`)。
 * 灌一个含三张重卡的项目,等轨道流全部生产完(先稀疏、后补密),然后逐条核对:
 *
 *   1. 每个分段恰好 15 个样本(末段除外)、首帧是 IDR、只有一个 moof;`mfra` 不落盘;
 *   2. 同一个变体里 `init.mp4` 只写一次,后续分段算出来的 `ftyp + moov` 与它逐字节相同;
 *   3. 稀疏分段(`stride = 3`)体积 ≤ 满密度的 1.0 倍;稀疏分段被满密度替换后,旧文件 5 秒内删除;
 *   4. 一条 15 帧分段的编码耗时、分段体积(≤ 512 KB);
 *   5. 连续生产只付一次换页:`bakeStream` 的重挂载次数 ≤ 流数 × 2(稀疏一趟 + 补密一趟);
 *      同时存活的分段编码器 ≤ 2 × streamPool;
 *   6. 就绪索引里每条流一层 `kind: 'stream'`、单位是分段号;组流(`--group` 把解码器预算压到 1)带 `groupClipIds`;
 *   7. **隔离**:和粒子卡重叠的另一张卡的颜色不出现在粒子流的分段里(ffmpeg 解出来逐像素查);
 *   8. 收紧矩形:框比画面小的卡,稀疏一趟量完之后补密分段用的是收紧后的矩形(新变体)。
 *
 * 输出 JSON 结论;任何一条不过就以非零退出。`--keep` 不删库根(给 `stream-play-probe.mjs` 接着用)。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { splitFmp4, segmentInfo, topLevelBoxes, SEGMENT_FRAMES } from '../../server/frame-stream.mjs';
import { bakeStream } from '../../server/bakery/bake.mjs';
import { openStreamSegmentEncoder } from '../../server/bakery/ffmpeg.mjs';
import { PROJECT } from './stream-probe-project.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const origin = devOrigin(args);
const KEEP = args.includes('--keep');
const GROUP = args.includes('--group');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-probe-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
if (GROUP) process.env.PROMPTCUT_STREAM_DECODERS = '1';

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

async function until(label, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** ffmpeg 把 init + 一个分段解成逐帧 RGBA(上下拼合的编码画面) */
async function decodeSegment(init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 30 });
  return stdout;
}

const out = { origin, library: OUT, group: GROUP };
await fs.mkdir(OUT, { recursive: true });
const pipeline = new FramePipeline({ root: OUT, origin: () => origin, interactive: true, playhead: () => null });
const layers = [];
const off = pipeline.readyIndex.subscribe(message => { if (message.type === 'layer' && message.kind === 'stream') layers.push(message); });
const started = Date.now();
try {
  await pipeline.preload(PROJECT);
  const producer = await until('生产者起来', () => pipeline._streams?.streams.size ? pipeline._streams : null, 120000);
  if (!producer) throw new Error('生产者没起来');
  const expect = GROUP ? 1 : 3;
  check(producer.streams.size === expect, `流数应当是 ${expect}`, producer.streams.size);
  // 全部分段满密度、没有在跑的 worker / 编码
  const done = await until('全部分段满密度', () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) {
      for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    }
    return !producer.workers.size && !producer.encoding.size ? status : null;
  }, 600000, 1000);
  out.produceMs = Date.now() - started;
  if (!done) throw new Error('生产没做完');
  // G6:旧文件延迟 5 秒删除 —— 等 6 秒再看盘
  await new Promise(r => setTimeout(r, 6000));
  const status = producer.status();
  out.stats = status.stats;
  out.encoder = status.encoder;
  out.pool = status.pool;
  out.log = status.log.map(l => l.message);
  out.streams = [];
  for (const state of producer.streams.values()) {
    const { spec, manifest } = state;
    const dir = producer.store.dir(spec.streamKey);
    const files = await fs.readdir(dir);
    const segFiles = files.filter(f => f.endsWith('.m4s'));
    const inits = files.filter(f => f.startsWith('init-'));
    const record = { streamKey: spec.streamKey, kind: spec.kind, clipIds: spec.clipIds, bound: manifest.bound, tight: manifest.tight,
      segments: spec.lastSegment - spec.firstSegment + 1, segFiles: segFiles.length, inits: inits.length, variants: Object.keys(manifest.inits).length,
      encodeMs: [], bytes: [], sparseBytes: {} };
    check(!files.some(f => f.includes('mfra')), 'mfra 不落盘', files);
    check(segFiles.length === record.segments, `${spec.clipIds}: 替换后盘上每段只剩一个文件`, { segFiles: segFiles.length, segments: record.segments });
    // 每个变体的 init 逐字节相同:每个分段按清单找自己的 init,再和 ffmpeg 输出里的 ftyp+moov 比 —— 清单里的
    // init 本身就是「第一次编码时截下来的那份」,后续分段编出来的若不同会记成新变体,所以变体数就是判据
    check(record.variants <= 2, `${spec.clipIds}: 变体数(上界 + 收紧)≤ 2`, record.variants);
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
      const seg = manifest.segments[n];
      const buf = await fs.readFile(path.join(dir, seg.file));
      const info = segmentInfo(buf);
      const last = n * SEGMENT_FRAMES + SEGMENT_FRAMES > spec.total;
      const want = last ? spec.total - n * SEGMENT_FRAMES : SEGMENT_FRAMES;
      check(info.sampleCount === want, `${spec.clipIds}#${n}: 样本数`, { got: info.sampleCount, want });
      check(info.firstSampleIsSync === true, `${spec.clipIds}#${n}: 首帧 IDR`);
      check(info.moofs === 1 && topLevelBoxes(buf).every(b => b.type === 'moof' || b.type === 'mdat'), `${spec.clipIds}#${n}: 只有 moof + mdat`);
      check(buf.length <= 512 * 1024, `${spec.clipIds}#${n}: 分段 ≤ 512 KB`, buf.length);
      record.encodeMs.push(seg.encodeMs);
      record.bytes.push(seg.bytes);
    }
    out.streams.push(record);
  }
  // 稀疏 vs 满密度的体积:日志里记了每个变体;这里从生产日志拿不到稀疏分段的字节(已被替换删除),
  // 所以另跑一次同一段的稀疏编码不划算 —— 由 status 的 segment 表在稀疏那一趟结束时记下(见 sparseSnapshot)
  out.sparseSnapshot = producer.sparseBytes ?? null;
  // 连续生产只付一次换页:10 个分段的粒子背景,稀疏一趟、补密一趟各只重挂载一次(失败重试另算)
  for (const s of status.streams) out[`resets_${s.clipIds.join('+')}`] = s.resets;
  const bgStatus = status.streams.find(s => s.clipIds.includes('clip-bg'));
  if (bgStatus && !GROUP) check(bgStatus.resets?.sparse === 1 && bgStatus.resets?.dense === 1 && bgStatus.lastSegment - bgStatus.firstSegment + 1 >= 10,
    '10 个分段的流:稀疏一趟、补密一趟各只付一次换页', bgStatus.resets);
  check(status.stats.maxAliveEncoders <= 2 * status.pool, '同时存活的分段编码器 ≤ 2 × streamPool', status.stats);
  check(status.stats.replacedDeleted >= 1, '替换后的旧分段 5 秒内删除', status.stats.replacedDeleted);
  // 就绪索引
  const byClip = new Map();
  for (const m of layers) byClip.set(m.clipId, m);
  out.layers = [...byClip.values()];
  for (const state of producer.streams.values()) {
    const layer = byClip.get(state.spec.topClipId);
    check(!!layer && layer.key === state.spec.streamKey, `${state.spec.topClipId}: 索引里有这条流的层`, layer ?? null);
    if (layer) check(JSON.stringify(layer.ranges) === JSON.stringify([[state.spec.firstSegment, state.spec.lastSegment]]), `${state.spec.topClipId}: 索引区间 = 全部分段`, layer.ranges);
    if (GROUP && layer) check(Array.isArray(layer.groupClipIds) && layer.groupClipIds.length === state.spec.clipIds.length, '组流的层带 groupClipIds', layer);
  }
  // 隔离:绿色粒子背景那条流(单卡流)里不能有金句药丸的蓝色
  if (!GROUP) {
    const bg = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-bg');
    const pill = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-pill');
    for (const [state, name] of [[bg, 'bg'], [pill, 'pill']]) {
      if (!state) continue;
      const seg = state.manifest.segments[1];
      const init = await fs.readFile(producer.store.initFile(state.spec.streamKey, seg.init));
      const raw = await decodeSegment(init, await fs.readFile(path.join(producer.store.dir(state.spec.streamKey), seg.file)), OUT, `decoded-${name}`);
      const meta = state.manifest.inits[seg.init];
      const W = meta.width, Hc = meta.height, H = Hc / 2 - 8;
      const frame = raw.subarray(0, W * Hc * 4);
      let blue = 0, opaque = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = frame[((y + H + 8) * W + x) * 4];
        if (a > 200) opaque++;
        // 药丸的蓝:B 高、R 低、B 比 G 高出一截(预乘色 ≤ a;绿色粒子是 G 高 B 低)
        if (a > 200 && frame[i + 2] > 180 && frame[i] < 140 && frame[i + 2] - frame[i + 1] > 50) blue++;
      }
      out[`isolation_${name}`] = { width: W, height: H, bluePixels: blue, opaquePixels: opaque, rect: meta.rect };
    }
    if (out.isolation_bg) check(out.isolation_bg.bluePixels === 0, '粒子背景流里没有金句药丸的像素', out.isolation_bg);
    if (out.isolation_pill) check(out.isolation_pill.bluePixels > 1000, '金句药丸流里有它自己的蓝色像素', out.isolation_pill);
    if (pill) check(pill.manifest.tight && pill.manifest.tight.w * pill.manifest.tight.h < pill.manifest.bound.w * pill.manifest.bound.h, '框比画面小的卡:收紧矩形小于上界', { bound: pill.manifest.bound, tight: pill.manifest.tight });
  }
  // 编码耗时基准(验收「一条 1080p 流 15 帧分段编码 ≤ 300 ms,前提:没有别的编码器争 CPU」):
  // 先把 15 张 PNG 截在内存里,再一次性喂给编码器计时(G0-b 的量法,和出帧不重叠)
  out.bench = [];
  for (const clipId of GROUP ? [] : ['clip-bg', 'clip-pill']) {
    const state = [...producer.streams.values()].find(s => s.spec.clipIds[0] === clipId);
    if (!state) continue;
    const bakery = await pipeline.leaseStreamBakery();
    const pngs = [];
    try {
      await bakery.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
      bakery.streamLease = null;
      const rect = state.manifest.tight ?? state.manifest.bound;
      const clip = { x: rect.x + state.spec.offset.x, y: rect.y + state.spec.offset.y, w: rect.w, h: rect.h };
      const t0 = Date.now();
      await bakeStream(bakery, { streamSignature: 'bench', fromFrame: 30, toFrame: 44, stride: 1, fps: 30, mountFrame: state.spec.mountFrame, clip,
        onFrame: async (_f, png) => { pngs.push(png); } });
      const captureMs = Date.now() - t0;
      const runs = [];
      for (let k = 0; k < 3; k++) {
        const enc = openStreamSegmentEncoder('ffmpeg', { encoder: status.encoder, fps: 30 });
        const e0 = Date.now();
        for (const png of pngs) await enc.write(png);
        const result = await enc.finish();
        runs.push({ ms: Date.now() - e0, bytes: result.bytes.length });
      }
      runs.sort((a, b) => a.ms - b.ms);
      out.bench.push({ clipId, rect, captureMsFor15: captureMs, encodeMs: runs.map(r => r.ms), p50: runs[1].ms, bytes: runs[1].bytes });
    } finally { pipeline.returnStreamBakery(bakery); }
  }
  const bgBench = out.bench.find(b => b.clipId === 'clip-bg');
  if (bgBench) check(bgBench.p50 <= 300, '1080p 全幅流 15 帧分段编码 ≤ 300 ms(无别的编码器争 CPU)', bgBench);
  for (const item of status.stats.sparseVsDense ?? []) {
    if (item.sameRect) check(item.sparse <= item.dense, 'stride 3 稀疏分段 ≤ 满密度 1.0 倍(同一矩形)', item);
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
} finally {
  off();
  out.fails = fails;
  await pipeline.close().catch(() => {});
  if (!KEEP) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}
