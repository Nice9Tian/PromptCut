import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { FramePipeline } from '../server/frame-pipeline.mjs';
import { bakeFrames, findFfmpeg } from './export-frames.mjs';
import { exportUnified } from './export-unified.mjs';
import { captureSnapshot } from './capture-snapshot.mjs';

const origin = process.env.PC_FRAME_TEST_URL || 'http://127.0.0.1:5192';
const root = path.resolve('out', `frame-verification-${Date.now()}`);
await fs.mkdir('out/media', { recursive: true });
const name = `frame-verification-${Date.now()}.webm`;
const media = path.resolve('out/media', name);
const ffmpeg = await findFfmpeg();
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=2', '-c:v', 'libvpx-vp9', '-y', media]);
const project = { id: 'verification', width: 320, height: 180, fps: 10, duration: 1, media: [{ id: 'video', kind: 'video', name, url: '/@media/' + name }], tracks: [
  { id: 'top', clips: [{ id: 'card', cardId: 'punch-pill', start: 0, end: 1, params: { text: 'Unified' } }] },
  { id: 'bottom', clips: [{ id: 'v1', mediaId: 'video', start: 0, end: 1, mediaOffset: .4, params: {} }] },
] };
const service = new FramePipeline({ root, origin: () => origin });
let bakery;
try {
  bakery = await service.bakery(project);
  const requests = [];
  bakery.page.on('request', req => { if (req.url().includes(name)) requests.push(req.url()); });
  const snapshots = new Map();
  await bakeFrames(bakery, { out: root, frames: '0-9', snapshotOnly: true, onSnapshot: (n, html) => snapshots.set(n, html) });
  assert.equal(requests.length, 0, 'B must not load any video');
  assert.equal(snapshots.size, 10, 'B must record every frame');
  const late = await captureSnapshot(bakery, snapshots.get(8));
  await fs.writeFile(path.join(root, 'direct.png'), late);
  const first = await captureSnapshot(bakery, snapshots.get(0));
  assert.ok(requests.length > 0, 'capture must load the target video');
  assert.notDeepEqual(PNG.sync.read(first).data, PNG.sync.read(late).data, 'video must seek to different frames');
  assert.deepEqual(PNG.sync.read(late).data, PNG.sync.read(await captureSnapshot(bakery, snapshots.get(8))).data, 'random replay must be deterministic');
  await bakery.close(); bakery = null;
  const entry = await service.entry(project);
  entry.html = snapshots; await service.save(entry);
  const frames = await service.see_frames(project, [.8, 0]);
  assert.equal(frames.get(8).source, 'html');
  const aFrame = PNG.sync.read(frames.get(8).buf).data;
  const direct = PNG.sync.read(late).data;
  assert.ok(aFrame.every((v, i) => Math.abs(v - direct[i]) <= 2), "track bitmap round-trip differs by at most two channel levels");
  assert.equal((await service.see_frames(project, [.8])).get(8).source, 'rendered');
  await service.preload(project); await service.background;
  assert.equal(entry.status, 'ready', entry.error);
  const prerendered = (await service.see_frames(project, [.8])).get(8).buf;
  assert.ok(PNG.sync.read(prerendered).data.equals(aFrame), 'C must exactly match the A pipeline');
  const probe = JSON.parse(execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', path.join(entry.dir, 'preview.mp4')], { encoding: 'utf8' }));
  assert.equal(Number(probe.streams[0].nb_read_frames), 10);
  const exported = await exportUnified(project, { url: origin + '/?export=1', out: path.join(root, 'exported'), targetFrames: [8] });
  const exportedFrame = PNG.sync.read(await fs.readFile(path.join(exported.framesDir, '000008.png'))).data;
  assert.ok(exportedFrame.equals(aFrame), 'export must exactly match see_frames');
  console.log('PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.');
  console.log('Artifacts:', root);
} finally {
  await bakery?.close(); await service.close();
  await fs.rm(media, { force: true });
}
