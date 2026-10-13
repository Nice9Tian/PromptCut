/**
 * 复现用的小探针(不是验收项):依赖下层的卡下面压着一张**中途进场**的 motion 式卡时,它的依赖下层的流产不产得出来。
 *
 *   node scripts/probes/below-late-lower-probe.mjs --origin http://127.0.0.1:<dev server> [--pill-start 1] [--target-start 0.2] [--pill-text 对照卡] [--out <目录>]
 *
 * 项目(960×540):上面是毛玻璃卡(里程表),下面是 `punch-pill`,从 `--pill-start` 秒进场。本进程里起一个 `FramePipeline`,只把毛玻璃卡钉成重卡,
 * 等它的流全部满密度、或者被差分取层的自检判死(`server/bakery/capture-below.mjs`),打印一行 JSON。
 *
 * 2026-10-14 实测(`main` 合到 f3e7d5e7 以后,这台 PC,每种跑两遍结果相同):
 *   - 缺省参数(`--pill-start 1`、药丸的字是「对照卡」):稀疏那一趟截到第 51 帧(药丸进场以后的第二个截帧点)被判死,`upper-changed`
 *     (藏起目标卡再露出来以后,带目标卡的那张截图和头一张不一样);这条流此后不再产,这张卡照没有流时那样兜底;
 *   - `--pill-start 0`(下层从头就在):全部满密度;
 *   - `--pill-start 1 --pill-text 中途进场的下层`(只把字换长):全部满密度。
 * 所以不是「下层中途进场就不行」,而是和下层那张卡的画面有关,原因没有查(产的一侧,不在「贴回舞台」这一块里)。退出码恒为 0(只报事实)。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const origin = String(flagArg('origin', '', args)).replace(/\/+$/, '');
if (!origin) { console.error('要给 --origin <dev server>'); process.exit(2); }
const pillStart = Number(flagArg('pill-start', '1', args));
const targetStart = Number(flagArg('target-start', '0.2', args));
const pillText = String(flagArg('pill-text', '对照卡', args));
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-below-late-lower-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';

const project = { id: `below-late-lower-${pillStart}-${targetStart}-${pillText.length}`, name: '下层中途进场', width: 960, height: 540, fps: 30, duration: 4,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-t', name: 't', hidden: false, clips: [{ id: 'clip-t', kind: 'card', cardId: 'odometer', start: targetStart, end: 4, params: { position: 'left', value: 86420, label: 'x' },
      frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: 0.5 } }] },
    { id: 'tr-p', name: 'p', hidden: false, clips: [{ id: 'clip-p', kind: 'card', cardId: 'punch-pill', start: pillStart, end: 4, params: { text: pillText }, frame: { x: 320, y: 150, w: 560, h: 200, anchor: [0.5, 0.5] } }] },
  ] };
const pipeline = new FramePipeline({ root: path.join(OUT, 'lib'), origin: () => origin, interactive: true, playhead: () => null });
pipeline.streamPicked = (_entry, clipId) => clipId === 'clip-t';
const producer = pipeline.streamProducer();
producer.attachRoute();
await pipeline.preload(project);
const started = Date.now();
let result = null;
while (!result) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = producer.status().streams.find((x) => x.kind === 'below');
  const strides = s ? Array.from({ length: s.lastSegment + 1 }, (_, n) => s.segments[n]?.stride ?? 0) : [];
  const idle = !producer.workers.size && !producer.encoding.size;
  const done = !!s && (!!s.below?.failed || (idle && strides.every((x) => x === 1)));
  if (done || Date.now() - started > 180_000) {
    result = { pillStart, targetStart, pillText, originFrame: s?.originFrame ?? null, strides, failed: s?.below?.failed ?? null, last: s?.below?.last ?? null, checks: s?.below?.checks ?? null,
      replay: s?.replay ?? null, timedOut: !done, ms: Date.now() - started };
  }
}
try { await pipeline.close(); } catch { /* ignore */ }
dropStreamEncoderSpares();
try { await fs.rm(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
console.log(JSON.stringify(result));
process.exit(0);
