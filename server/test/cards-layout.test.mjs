/*
 * D4(b) `/api/cards/layout`(预渲染的整场景实体框)。
 *
 * 纯计算那部分直接测(素材段的框、回包成型);要开浏览器的那部分把
 * `bakeFrames` / `captureSnapshot` 两个模块替掉,只验「一次请求只渲一遍」
 * 和 `{ screenshot: false }` + 钩子确实传下去了。
 *
 * 跑法:`node --experimental-test-module-mocks --test server/test/cards-layout.test.mjs`
 * 带 `PC_STAGE_TEST_URL` 时最后一条会真打一台 dev server(不带就整条跳过)。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const bakeCalls = [];
const captureCalls = [];
let measured = [];

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('openBakery is not used by the layout path'); },
    findFfmpeg: async () => 'ffmpeg',
    bakeFrames: async (_bakery, opts) => {
      bakeCalls.push(opts);
      for (const frame of opts.snapshotFrames || []) await opts.onSnapshot?.(frame, `<div data-pc-scene="" data-frame="${frame}"></div>`, []);
    },
  },
});
mock.module(new URL('../bakery/capture-snapshot.mjs', import.meta.url).href, {
  exports: {
    captureSnapshot: async (_bakery, html, screenshot, options = {}) => {
      captureCalls.push({ html, screenshot, options });
      // 真实实现在 fonts.ready 之后 prepareFrameMedia 之前跑钩子;这里只把返回值透出来
      return options.afterFonts ? await options.afterFonts({ evaluate: async () => measured }) : Buffer.alloc(0);
    },
  },
});

const { FramePipeline, layoutClips, frameContentBox } = await import('../frame-pipeline.mjs');

const stage = { width: 1920, height: 1080 };

test('素材段的 contentBox 就是它的 frameCss 框', () => {
  // 没有 frame = 铺满舞台(resolveFrameSize 的默认值)
  assert.deepEqual(frameContentBox(undefined, stage), { left: 0, top: 0, width: 1920, height: 1080 });
  // 锚点在左上角:(x, y) 就是左上角
  assert.deepEqual(frameContentBox({ x: 100, y: 50, w: 640, h: 360 }, stage), { left: 100, top: 50, width: 640, height: 360 });
  // 锚点在正中:左上角 = (x, y) 减去半个框
  assert.deepEqual(frameContentBox({ x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5] }, stage), { left: 640, top: 360, width: 640, height: 360 });
  // 只给了一边的宽高:另一边铺满
  assert.deepEqual(frameContentBox({ w: 800 }, stage), { left: 0, top: 0, width: 800, height: 1080 });
  // 取整,和页面侧 roundBox 一致
  assert.deepEqual(frameContentBox({ x: 10.4, y: 10.6, w: 100.5, h: 99.4 }, stage), { left: 10, top: 11, width: 101, height: 99 });
});

const project = {
  width: 1920, height: 1080, fps: 30, duration: 4,
  tracks: [{ id: 't1', clips: [
    { id: 'card-a', cardId: 'scene-3d', start: 0, end: 2, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
    { id: 'card-b', cardId: 'odometer', start: 2, end: 4, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
    { id: 'media-a', start: 0, end: 4, frame: { x: 200, y: 100, w: 800, h: 450 } },
  ] }],
};

test('回包成型:卡片按量到的实体框,素材段按项目数据,找不到 / 不在画面上都带 contentNote', () => {
  const list = [{ clipId: 'card-a', rect: { left: 0, top: 0, width: 1920, height: 1080 }, bounds: { left: 704.2, top: 268.8, width: 512.4, height: 541.1 } }];
  const { stage: st, clips, cardIds } = layoutClips(project, ['card-a', 'card-b', 'media-a', 'nope'], list, 1);
  assert.deepEqual(st, stage);
  assert.deepEqual(cardIds, ['card-a', 'card-b']);
  // 量到了:bounds 优先于包裹层 rect,且取整
  assert.deepEqual(clips['card-a'].contentBox, { left: 704, top: 269, width: 512, height: 541 });
  assert.equal(clips['card-a'].contentNote, undefined);
  // 这一刻不在画面上:null + 说明,别被当成「没内容」
  assert.equal(clips['card-b'].contentBox, null);
  assert.match(clips['card-b'].contentNote, /不在画面上/);
  // 素材段:不进快照,等于它的 frameCss 框
  assert.deepEqual(clips['media-a'].contentBox, { left: 200, top: 100, width: 800, height: 450 });
  assert.equal(clips['nope'].contentBox, null);
  assert.match(clips['nope'].contentNote, /找不到 clip nope/);
});

test('量不到实体范围时退回包裹层外框;不传 clipIds 返回全部片段(卡片 + 素材段)', () => {
  const list = [{ clipId: 'card-a', rect: { left: 1, top: 2, width: 3, height: 4 }, bounds: null }];
  const { clips } = layoutClips(project, null, list, 0);
  assert.deepEqual(Object.keys(clips).sort(), ['card-a', 'card-b', 'media-a']);
  assert.deepEqual(clips['card-a'].contentBox, { left: 1, top: 2, width: 3, height: 4 });
});

/** 只挡住磁盘和浏览器,layout / layoutNow 本身跑真的 */
function stubbed(entryProject, html = new Map()) {
  const service = new FramePipeline({ root: '.', origin: () => '' });
  const entry = { key: 'k', project: entryProject, dir: '.', html, controls: new Map(), recordVersion: 0 };
  const bakery = { page: { evaluate: async () => measured } };
  service.entry = async () => entry;
  service.acquire = async () => bakery;
  service.release = () => {};
  service.save = async () => {};
  return { service, entry };
}

test('一次请求只渲一遍,和问了几个 clipId 无关;第二次命中 entry.html 不再渲', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  const clips = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, cardId: 'odometer', start: 0, end: 4, frame: { x: i, y: 0, w: 100, h: 100 } }));
  const big = { ...project, tracks: [{ id: 't1', clips }] };
  measured = clips.map((c, i) => ({ clipId: c.id, rect: { left: i, top: 0, width: 100, height: 100 }, bounds: { left: i + 10, top: 10, width: 40, height: 40 } }));
  const { service, entry } = stubbed(big);

  const first = await service.layout(big, { t: 1, clipIds: clips.map(c => c.id) });
  assert.equal(bakeCalls.length, 1, '30 个 clipId 只触发一次预渲染渲染');
  assert.equal(captureCalls.length, 1, '一次请求只注一次快照');
  assert.deepEqual([...bakeCalls[0].snapshotFrames], [30], 'round(1 × 30)');
  assert.equal(bakeCalls[0].snapshotOnly, true, 'layout 不产 PNG');
  assert.equal(first.frame, 30);
  assert.equal(first.t, 1);
  assert.equal(first.baked, true);
  assert.deepEqual(first.stage, stage);
  assert.equal(Object.keys(first.clips).length, 30);
  assert.deepEqual(first.clips['c0'].contentBox, { left: 10, top: 10, width: 40, height: 40 });
  // 钩子和 screenshot: false 确实传到了 captureSnapshot
  assert.equal(captureCalls[0].options.screenshot, false);
  assert.equal(typeof captureCalls[0].options.afterFonts, 'function');
  // 冻出来的这一帧被 record 进 entry.html,下一次就该命中
  assert.equal(entry.html.has(30), true);

  const second = await service.layout(big, { t: 1, clipIds: ['c0'] });
  assert.equal(bakeCalls.length, 1, '命中 entry.html 就不再 bake');
  assert.equal(captureCalls.length, 2, '还是要注一次快照才量得到');
  assert.equal(second.baked, false);
  assert.deepEqual(second.clips['c0'].contentBox, { left: 10, top: 10, width: 40, height: 40 });
});

test('像素已经有了也不短路:entry.html 没有这一帧照样冻一张出来量', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  measured = [{ clipId: 'card-a', rect: { left: 0, top: 0, width: 1920, height: 1080 }, bounds: { left: 8, top: 8, width: 64, height: 64 } }];
  const { service, entry } = stubbed(project);
  // MOV 命中的那条路只喂像素,这里连 mov 都不看
  entry.mov = { lookup: async () => Buffer.alloc(10), ready: Promise.resolve() };
  const out = await service.layout(project, { t: 0, clipIds: ['card-a'] });
  assert.equal(bakeCalls.length, 1);
  assert.deepEqual(out.clips['card-a'].contentBox, { left: 8, top: 8, width: 64, height: 64 });
});

test('只问素材段时一趟浏览器都不开', async () => {
  bakeCalls.length = 0; captureCalls.length = 0;
  const { service } = stubbed(project);
  const out = await service.layout(project, { t: 1, clipIds: ['media-a'] });
  assert.equal(bakeCalls.length, 0);
  assert.equal(captureCalls.length, 0);
  assert.deepEqual(out.clips['media-a'].contentBox, { left: 200, top: 100, width: 800, height: 450 });
});

test('t 夹在项目时长内,帧号按 round(t × fps)', async () => {
  bakeCalls.length = 0;
  measured = [];
  const { service } = stubbed(project);
  assert.equal((await service.layout(project, { t: -5, clipIds: ['card-a'] })).frame, 0);
  assert.equal((await service.layout(project, { t: 999, clipIds: ['card-a'] })).frame, 119, 'floor(4 × 30) - 1');
  assert.equal((await service.layout(project, { t: 1.49, clipIds: ['card-a'] })).frame, 45);
});

/* 真打一台 dev server(PC_STAGE_TEST_URL=http://127.0.0.1:5214);不设就跳过。 */
test('集成:/api/cards/layout 对真实项目返回整数框', { skip: !process.env.PC_STAGE_TEST_URL }, async () => {
  const origin = process.env.PC_STAGE_TEST_URL.replace(/\/+$/, '');
  const live = {
    width: 1920, height: 1080, fps: 30, duration: 3, tracks: [{ id: 't1', clips: [
      { id: 'live-card', cardId: 'odometer', start: 0, end: 3, frame: { x: 0, y: 0, w: 1920, h: 1080 } },
      { id: 'live-media', start: 0, end: 3, frame: { x: 120, y: 60, w: 640, h: 360 } },
    ] }], media: [],
  };
  const res = await fetch(`${origin}/api/cards/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: live, t: 1, clipIds: ['live-card', 'live-media'] }) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const data = JSON.parse(text);
  assert.deepEqual(data.stage, { width: 1920, height: 1080 });
  assert.equal(data.frame, 30);
  assert.deepEqual(data.clips['live-media'].contentBox, { left: 120, top: 60, width: 640, height: 360 });
  const box = data.clips['live-card'].contentBox;
  assert.ok(box && Object.values(box).every(Number.isInteger), `contentBox 要是整数:${JSON.stringify(data.clips['live-card'])}`);
});
