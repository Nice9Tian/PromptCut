/**
 * P1 素材拼图提供者单测：`server/agent/service/hosted-media-frames.mjs` 与 `server/vision/media-sheet.mjs`。
 * 覆盖：
 *   1. 真视频抽帧拼图（默认 6 帧/页、最多 12，grid4 / grid9，scene 单镜头放大，from/to 过滤，无 shots 时 10 秒分段 fallback）；
 *   2. 图片直读（PNG/JPEG 尺寸探查、cardUrl、base64 原图直出）；
 *   3. 音频素材拒绝并报错；
 *   4. 跨项目 mediaId 与不存在的素材拒绝；
 *   5. 缺 ffmpeg 或起不来时返回 `{ ok: false, cloudUnavailable: true, error }`；
 *   6. 取消（`abortForFence`）与 `close()` 时真实终止子进程树并清理临时文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeP1Fixture, tmpDir } from './cloud-tools-p1-fixture.mjs';
import {
  createMediaFramesTools,
  MEDIA_FRAMES_TOOL_NAMES,
  MediaFramesToolError,
  probeImageDimensions,
  scenesOf,
  planSequences,
} from '../agent/service/hosted-media-frames.mjs';

const runSync = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function findFfmpeg() {
  if (process.env.PROMPTCUT_FFMPEG && fs.existsSync(process.env.PROMPTCUT_FFMPEG)) return process.env.PROMPTCUT_FFMPEG;
  const r = runSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const first = r.stdout?.split(/\r?\n/).find(Boolean)?.trim();
  return first && fs.existsSync(first) ? first : null;
}

const FFMPEG = findFfmpeg();
const EXT = path.extname(FFMPEG ?? '');
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), `ffprobe${EXT}`) : null;
const skipFfmpeg = FFMPEG && fs.existsSync(FFPROBE) ? false : '没有找到真 ffmpeg / ffprobe';

function makeTestVideo(dir) {
  const out = path.join(dir, 'sample.mp4');
  const r = runSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'rgbtestsrc=size=320x180:rate=15:duration=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', out,
  ]);
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

function makeTestPng(dir) {
  const out = path.join(dir, 'sample.png');
  const r = runSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=0.1',
    '-frames:v', '1', out,
  ]);
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

test('P1-MF-01 工具名、导出契约与规划纯函数（默认 6、最多 12，grid4/9，fallback 10 秒）', () => {
  assert.deepEqual([...MEDIA_FRAMES_TOOL_NAMES].sort(), ['see_frames', 'see_media']);
  assert.throws(() => createMediaFramesTools({}), (e) => e instanceof MediaFramesToolError && e.code === 'media-frames-unconfigured');

  const fb = scenesOf(null, 25);
  assert.equal(fb.fallback, 'fixed-interval');
  assert.equal(fb.scenes.length, 3);
  assert.deepEqual(fb.scenes.map((s) => [s.start, s.end]), [[0, 10], [10, 20], [20, 25]]);

  const many = Array.from({ length: 15 }, (_, i) => ({
    index: i + 1, start: i * 2, end: (i + 1) * 2, inTransition: null, outTransition: null,
  }));
  const pDefault = planSequences(many, {});
  assert.equal(pDefault.perPage, 6);
  assert.equal(pDefault.grid, 4);
  assert.equal(pDefault.pages, 3);
  assert.equal(pDefault.nextPage, 2);

  const pMax = planSequences(many, { perPage: 99, grid: 9, page: 2 });
  assert.equal(pMax.perPage, 12);
  assert.equal(pMax.grid, 9);
  assert.equal(pMax.page, 2);
  assert.equal(pMax.scenes.length, 3);
  assert.equal(pMax.nextPage, null);
  assert.equal(pMax.prevPage, 1);

  const pSingle = planSequences(many, { scene: 4 });
  assert.equal(pSingle.scenes.length, 1);
  assert.equal(pSingle.scenes[0].index, 4);
  assert.equal(pSingle.grid, 9);
});

test('P1-MF-02 真视频抽帧拼图：grid4 与 grid9、单镜头放大、分页、转写折叠与临时文件清理', { skip: skipFfmpeg, timeout: 120_000 }, async (t) => {
  const work = tmpDir('pc-p1-mf-video-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const videoBytes = makeTestVideo(work);

  const fx = await makeP1Fixture(t, { extraProjects: ['proj_other'] });
  const shots = {
    engine: 'scdet',
    createdAt: new Date().toISOString(),
    transitions: [
      { kind: 'cut', start: 2, end: 2, time: 2, confidence: 0.9 },
      { kind: 'cut', start: 4, end: 4, time: 4, confidence: 0.9 },
    ],
    shots: [
      { start: 0, end: 2, inTransition: null, outTransition: 'cut' },
      { start: 2, end: 4, inTransition: 'cut', outTransition: 'cut' },
      { start: 4, end: 6, inTransition: 'cut', outTransition: null },
    ],
  };
  const transcript = {
    language: 'zh',
    segments: [
      { start: 0.2, end: 1.8, text: '第一段画面' },
      { start: 2.1, end: 3.9, text: '第二段彩条' },
    ],
  };
  await fx.addMedia({
    id: 'vid1',
    name: 'sample.mp4',
    kind: 'video',
    bytes: videoBytes,
    extra: { duration: 6, shots, transcript },
  });

  const provider = createMediaFramesTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: fx.assets,
    workspace: () => fx.ws,
    project: fx.project,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
  });
  t.after(() => provider.close());

  assert.equal(provider.handles.has('see_frames'), true);
  assert.equal(provider.handles.has('see_media'), true);

  // 1) 默认 grid=4，3 个镜头
  const res4 = await provider.call('see_frames', { source: 'media', mediaId: 'vid1' }, fx.context);
  assert.equal(res4.ok, true);
  assert.equal(res4.mediaId, 'vid1');
  assert.equal(res4.engine, 'scdet');
  assert.equal(res4.grid, 4);
  assert.equal(res4.perPage, 6);
  assert.equal(res4.scenes.length, 3);
  assert.equal(res4.__images.length, 3);
  assert.equal(res4.scenes[0].transcript, '第一段画面');
  assert.equal(res4.scenes[1].transcript, '第二段彩条');
  assert.equal(res4.scenes[0].frames.length, 4);
  for (const img of res4.__images) {
    assert.equal(img.mime, 'image/jpeg');
    const jpg = Buffer.from(img.base64, 'base64');
    const dims = probeImageDimensions(jpg);
    assert.ok(dims && dims.width >= 900 && dims.height > 100, `grid4 JPEG 尺寸应为 2x2 拼图，实际 ${JSON.stringify(dims)}`);
  }

  // 2) 单镜头放大 scene=2（默认 grid=9）
  const res9 = await provider.call('see_frames', { source: 'media', mediaId: 'vid1', scene: 2 }, fx.context);
  assert.equal(res9.ok, true);
  assert.equal(res9.grid, 9);
  assert.equal(res9.scenes.length, 1);
  assert.equal(res9.scenes[0].index, 2);
  assert.equal(res9.scenes[0].frames.length, 9);
  assert.equal(res9.__images.length, 1);
  const dims9 = probeImageDimensions(Buffer.from(res9.__images[0].base64, 'base64'));
  assert.ok(dims9 && dims9.width >= 1400 && dims9.height > 200, `grid9 JPEG 尺寸应为 3x3 拼图，实际 ${JSON.stringify(dims9)}`);

  // 3) 临时文件已清理干净
  const leftover = fx.ws.list().filter((f) => f.path.startsWith('media-frames/'));
  assert.deepEqual(leftover, [], '工作区里不应残留 media-frames 临时文件');
});

test('P1-MF-03 图片直读、音频拒绝、跨项目与不存在的 mediaId 拒绝、缺 ffmpeg 返回 cloudUnavailable', { skip: skipFfmpeg, timeout: 60_000 }, async (t) => {
  const work = tmpDir('pc-p1-mf-img-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const pngBytes = makeTestPng(work);
  const videoBytes = makeTestVideo(work);

  const fx = await makeP1Fixture(t, { extraProjects: ['proj_other'] });
  await fx.addMedia({ id: 'img1', name: 'poster.png', kind: 'image', bytes: pngBytes, extra: { url: `/@media/${'a'.repeat(64)}` } });
  await fx.addMedia({ id: 'aud1', name: 'bgm.mp3', kind: 'audio', bytes: Buffer.from('fake-audio-bytes') });
  await fx.addMedia({ id: 'vid_mine', name: 'v.mp4', kind: 'video', bytes: videoBytes, extra: { duration: 6 } });
  // 放到另一个项目 proj_other 的素材
  await fx.addMedia({ id: 'foreign_vid', name: 'foreign.mp4', kind: 'video', bytes: videoBytes, forProject: 'proj_other', extra: { duration: 6 } });

  const provider = createMediaFramesTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: fx.assets,
    workspace: () => fx.ws,
    project: fx.project,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
  });
  t.after(() => provider.close());

  // 1) 图片直读
  const imgOut = await provider.call('see_frames', { source: 'media', mediaId: 'img1' }, fx.context);
  assert.equal(imgOut.ok, true);
  assert.equal(imgOut.kind, 'image');
  assert.equal(imgOut.width, 640);
  assert.equal(imgOut.height, 360);
  assert.equal(imgOut.__images.length, 1);
  assert.equal(imgOut.__images[0].mime, 'image/png');
  assert.equal(Buffer.from(imgOut.__images[0].base64, 'base64').length, pngBytes.length);

  // 2) 音频拒绝
  await assert.rejects(
    provider.call('see_frames', { source: 'media', mediaId: 'aud1' }, fx.context),
    (err) => err instanceof MediaFramesToolError && err.code === 'media-kind' && /不是视频.*音频/.test(err.message),
  );

  // 3) 跨项目拒绝 & 不存在的素材拒绝
  await assert.rejects(
    provider.call('see_frames', { source: 'media', mediaId: 'foreign_vid' }, fx.context),
    (err) => err instanceof MediaFramesToolError && err.code === 'media-not-found',
  );
  await assert.rejects(
    provider.call('see_frames', { source: 'media', mediaId: 'nonexistent_id' }, fx.context),
    (err) => err instanceof MediaFramesToolError && err.code === 'media-not-found',
  );

  // 4) 缺 ffmpeg 时返回 cloudUnavailable
  await fx.addMedia({ id: 'vid_ok', name: 'v.mp4', kind: 'video', bytes: videoBytes, extra: { duration: 6 } });
  const noFfmpegProvider = createMediaFramesTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: fx.assets,
    workspace: () => fx.ws,
    project: fx.project,
    ffmpeg: null,
  });
  const unavail = await noFfmpegProvider.call('see_frames', { source: 'media', mediaId: 'vid_ok' }, fx.context);
  assert.equal(unavail.ok, false);
  assert.equal(unavail.cloudUnavailable, true);
  assert.match(unavail.error, /ffmpeg/);
});

test('P1-MF-04 本轮取消（abortForFence）或 close() 时真实终止抽帧子进程并清理临时文件', async (t) => {
  const work = tmpDir('pc-p1-mf-cancel-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const pidFile = path.join(work, 'child-pid.txt');
  const stubScript = path.join(work, 'slow-ffmpeg.mjs');
  fs.writeFileSync(
    stubScript,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 9.0.1-stub\\n');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );

  const fx = await makeP1Fixture(t);
  await fx.addMedia({
    id: 'vid_slow',
    name: 'slow.mp4',
    kind: 'video',
    bytes: Buffer.from('fake-video-content-for-cancel-test'),
    extra: {
      duration: 10,
      shots: {
        engine: 'scdet',
        createdAt: new Date().toISOString(),
        transitions: [],
        shots: [{ start: 0, end: 10, inTransition: null, outTransition: null }],
      },
    },
  });

  const provider = createMediaFramesTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: fx.assets,
    workspace: () => fx.ws,
    project: fx.project,
    config: {
      ffmpeg: process.execPath,
      ffmpegArgs: [stubScript],
    },
  });
  t.after(() => provider.close());

  const callPromise = provider.call('see_frames', { source: 'media', mediaId: 'vid_slow' }, fx.context);
  // 等待子进程实际启动并写出 pid
  let childPid = null;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(pidFile)) {
      childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (childPid > 0) break;
    }
    await sleep(30);
  }
  assert.ok(childPid > 0, '慢速 ffmpeg 替身子进程应当已启动');
  assert.equal(alive(childPid), true, '取消前子进程活着');

  // 触发本轮栅栏取消并等待调用因取消收尾
  await fx.resources.abortForFence(fx.context, 'turn-cancelled');
  await assert.rejects(callPromise, (err) => err instanceof MediaFramesToolError);
  const abortRes = await fx.resources.abortForFence(fx.context, 'turn-cancelled');
  assert.equal(abortRes.childrenOpen, 0, '取消收尾后所有登记的子进程已退出并 close');
  assert.equal(alive(childPid), false, '取消后子进程已真实退出');

  // 检查临时文件已被清理
  const leftover = fx.ws.list().filter((f) => f.path.startsWith('media-frames/'));
  assert.deepEqual(leftover, [], '取消后工作区临时目录已清理干净');
});

test('P1-MF-05 取素材失败时给模型人话，不把 project-assets-read-failed 这种代号原样抛出去', async (t) => {
  const fx = await makeP1Fixture(t);
  await fx.addMedia({ id: 'img_err', name: 'plan.png', kind: 'image', bytes: Buffer.from('not-a-real-png') });

  // 只换掉读字节这一步:元数据照常走真 fixture,失败发生在 openRead
  const providerWith = (error) => createMediaFramesTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: { openRead: async () => { throw error; } },
    workspace: () => fx.ws,
    project: fx.project,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
  });
  const fail = (code, status) => Object.assign(new Error(code), { code, status });

  // 1) 素材服务没放行 Agent 读取(生产上 PROMPTCUT_ASSET_RUN_ENABLED=0 就是这个):
  //    要明说重试没用,否则模型只会原样再试一遍
  const shut = providerWith(fail('project-assets-read-failed', 503));
  t.after(() => shut.close());
  await assert.rejects(
    shut.call('see_frames', { source: 'media', mediaId: 'img_err' }, fx.context),
    (err) => err instanceof MediaFramesToolError && err.code === 'media-fetch-failed' && err.status === 503
      && /读不了项目素材的字节/.test(err.message) && /重试也没用/.test(err.message),
  );

  // 2) 字节真的没了:还是原来那句「找不到」,状态 404
  const gone = providerWith(fail('asset-missing', 404));
  t.after(() => gone.close());
  await assert.rejects(
    gone.call('see_frames', { source: 'media', mediaId: 'img_err' }, fx.context),
    (err) => err instanceof MediaFramesToolError && err.status === 404 && /找不到/.test(err.message),
  );

  // 3) 没见过的代号:兜底那句照旧带上代号,别把整条错误对象倒给模型
  const odd = providerWith(fail('something-else', 500));
  t.after(() => odd.close());
  await assert.rejects(
    odd.call('see_frames', { source: 'media', mediaId: 'img_err' }, fx.context),
    (err) => err instanceof MediaFramesToolError && /取素材失败\(something-else\)/.test(err.message),
  );
});
