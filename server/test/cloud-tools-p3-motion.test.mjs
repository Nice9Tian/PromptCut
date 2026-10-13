/**
 * P3 包 · `attach_clip_motion`(把追踪轨迹绑到卡片段上)接真东西:
 *   真视频 + 真 Python 追出的轨迹(P3 追踪四件套)→ 真项目副本上的真 handler(vite ssrLoadModule 载入 `src/mcp/handlers`)
 *   → 真文档服务(WebSocket)里的真提交,身份是 Agent 对话、带期望版本。
 *
 * 画面复核:不渲染舞台(渲染那一带这一包不碰),而是对着视频里解出的真画面,在每个时刻找目标的真实位置,
 * 把「目标位移 × 舞台缩放」和提交进项目的逐帧位移比对。
 *
 * 用例 P3-M1～P3-M4。Python 或 ffmpeg 不可用时整份 skip。
 * 跑:node --test server/test/cloud-tools-p3-motion.test.mjs
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentSide } from '../agent/agent-side.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { createMotionTools } from '../agent/service/hosted-motion.mjs';
import { wsClient, waitFor as waitForFake } from './fake-ws-kit.mjs';
import {
  REPO_ROOT, buildTrackEnv, contextOf, decodeGrayFrame, findTestRuntime, untilTracked, writeTrackVideo,
} from './cloud-tools-p3-kit.mjs';

const runtime = findTestRuntime();
const skip = runtime ? false : '没有可用的 Python(带 numpy)或 ffmpeg';
let shared = null;

before(async () => {
  if (!runtime) return;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-p3-motion-'));
  shared = { dir, video: await writeTrackVideo(path.join(dir, 'v.mp4'), { ffmpeg: runtime.ffmpeg, width: 320, height: 200, frames: 60, fps: 30 }) };
});
after(async () => { if (shared) await fsp.rm(shared.dir, { recursive: true, force: true }); });

const asError = async (promise) => promise.then(() => null, (error) => error);

/** 在 frame 里、around 附近 ±radius 搜 template(25×25)最像的位置;回 [x, y, 相似度] */
function locate(frame, width, template, around, radius = 14) {
  const size = 25; const half = 12;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const mt = mean(template);
  const dt = Math.sqrt(template.reduce((s, x) => s + (x - mt) ** 2, 0));
  let best = [0, 0, -2];
  for (let cy = around[1] - radius; cy <= around[1] + radius; cy += 1) {
    for (let cx = around[0] - radius; cx <= around[0] + radius; cx += 1) {
      const a = [];
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) a.push(frame[(cy - half + y) * width + (cx - half + x)]);
      const ma = mean(a);
      let num = 0; let da = 0;
      for (let i = 0; i < a.length; i += 1) { num += (a[i] - ma) * (template[i] - mt); da += (a[i] - ma) ** 2; }
      const r = num / Math.sqrt(da * dt * dt);
      if (r > best[2]) best = [cx, cy, r];
    }
  }
  return best;
}

async function startDocEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: REPO_ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const sides = [];
  const clients = [];
  t.after(async () => {
    for (const s of sides) s.close();
    for (const c of clients) c.close();
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);

  async function page(projectId, session = 'page-1') {
    const c = wsClient(url);
    clients.push(c);
    await c.opened;
    let seq = 0;
    return {
      c,
      async open() {
        c.send({ type: 'project.open', projectId, reqId: `open-${++seq}` });
        return c.next((m) => m.type === 'project.state', 5000);
      },
      async commit(ops) {
        const opId = `${session}-op-${++seq}`;
        c.send({ type: 'project.op', projectId, opId, session, ops, reqId: opId });
        return c.next((m) => m.reqId === opId, 5000);
      },
      ops: () => c.all.filter((m) => m.type === 'project.ops'),
    };
  }
  async function stateOf(projectId) {
    const p = await page(projectId, 'reader');
    const st = await p.open();
    if (st.project === undefined && Number.isSafeInteger(st.parts)) {
      await p.c.next((m) => m.type === 'project.state.end' && m.rev === st.rev, 5000);
      const parts = p.c.all.filter((m) => m.type === 'project.state.part' && m.rev === st.rev).sort((x, y) => x.index - y.index);
      st.project = JSON.parse(parts.map((m) => m.data).join(''));
    }
    p.c.close();
    return st;
  }
  function agentSide(projectId) {
    const side = createAgentSide({
      projectId, url, protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`],
      tools, toolGroups, loadHost: () => loadSsrHost(load),
      callPage: async () => { throw new Error('这个测试里没有页面'); },
    });
    sides.push(side);
    return side;
  }
  return { page, stateOf, agentSide };
}

/** 项目:舞台 1280×720;素材 m1(320×200、2 秒)的素材段 v1 铺满 0～2 秒;卡 c1 在 0.5～1.5 秒,c2 在 1.0～1.8 秒,c_far 在 3～4 秒(没有素材段和它重叠) */
function motionProject(media) {
  return {
    version: 1, id: 'p-motion', name: '追踪绑定', width: 1280, height: 720, fps: 30, duration: 4, themeId: 'midnight',
    media: [
      { id: 'm1', kind: 'video', name: '街景', url: `/@media/${media.hash}`, hash: media.hash, size: media.size, width: 320, height: 200, duration: 2 },
      { id: 'm_junk', kind: 'video', name: '坏素材', url: '/@media/junk', width: 320, height: 200, duration: 2 },
      { id: 'm_heavy', kind: 'video', name: '大素材', url: '/@media/heavy', width: 960, height: 540, duration: 8 },
    ],
    tracks: [
      { id: 't1', name: '序列 1', clips: [
        { id: 'c1', cardId: 'title', start: 0.5, end: 1.5, params: {}, label: '跟随' },
        { id: 'c2', cardId: 'title', start: 1.0, end: 1.8, params: {}, label: '隐藏型' },
        { id: 'c_far', cardId: 'title', start: 3, end: 4, params: {}, label: '太远' },
      ] },
      { id: 't2', name: '序列 2', clips: [{ id: 'v1', mediaId: 'm1', start: 0, end: 2, mediaOffset: 0 }] },
    ],
  };
}

async function setup(t) {
  const docs = await startDocEnv(t);
  const trackEnv = await buildTrackEnv(t, { readProject: null });
  const media = await trackEnv.addMedia('proj_motion', 'm1', shared.video.file);
  await trackEnv.addMedia('proj_motion', 'm_junk', Buffer.from('definitely not a video file, long enough to read as bytes'), { kind: 'video', ext: 'mp4' });
  const projectId = 'p-motion';
  const seeder = await docs.page(projectId, 'seeder');
  await seeder.open();
  const seeded = await seeder.commit([{ op: 'set', path: '', value: motionProject(media) }]);
  assert.equal(seeded.type, 'project.op.ok', JSON.stringify(seeded));
  const side = docs.agentSide(projectId);
  const ctx = trackEnv.access.trust(contextOf({ projectId: 'proj_motion', conversationId: 'conv_motion' }));
  // 项目视图(只读副本)
  const readProject = async (c) => (await side.executor.snapshot(c.conversationId)).project;
  const tracks = trackEnv.openTracks({ readProject });
  const motion = createMotionTools({
    contextAccess: { authorize: trackEnv.access.authorize },
    tracks,
    commit: ({ context, fenceRevision, tool, apply }) => {
      assert.equal(fenceRevision, trackEnv.access.state.fence, '提交时带着此刻核过的 fence');
      return side.executor.mutate(tool, context.conversationId, {}, apply);
    },
  });
  t.after(async () => { await motion.close('end'); await tracks.close('end'); });
  return { docs, trackEnv, media, projectId, seeder, side, ctx, tracks, motion };
}

test('P3-M1 真轨迹绑到真项目:逐帧位移对得上视频里目标的真实位置,提交身份是 Agent 对话', { skip, timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  const { ctx, tracks, motion, projectId, docs } = env;
  const first = shared.video.truth[0];
  const kick = await tracks.call('track_points', { mediaId: 'm1', points: [[0, first[0], first[1]]] }, ctx);
  assert.equal(kick.started, true);
  const { result: summary } = await untilTracked(tracks, ctx, 'm1');
  assert.equal(summary.engine, 'template');

  const before = (await docs.stateOf(projectId)).rev;
  const watcher = await docs.page(projectId, 'watcher');
  await watcher.open();
  const out = await motion.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.engine, 'template');
  assert.equal(out.pointIndex, 0);
  assert.equal(out.whenHidden, 'hold');
  assert.ok(out.rev > before, '提交让文档服务的版本前进了');
  assert.ok(out.movedX > 20 && out.movedY > 10, `目标真的在走:${out.movedX}×${out.movedY}`);
  assert.equal(out.visibleFrames, out.frames);

  const st = await docs.stateOf(projectId);
  assert.equal(st.rev, out.rev);
  const clip = st.project.tracks[0].clips.find((c) => c.id === 'c1');
  assert.equal(clip.motion.mediaId, 'm1');
  assert.equal(clip.motion.whenHidden, 'hold');
  const { offsets, frameStep } = clip.motion;
  assert.ok(Math.abs(frameStep - 2 / 60) < 1e-9);
  assert.equal(offsets.length, 31, '卡片 1 秒 ÷ 每帧 1/30 秒 + 1');
  assert.deepEqual(offsets[0], [0, 0], '锚点归零:卡片留在设计时摆的位置');

  // 对着真画面复核:卡片 0.5 秒起,对应素材第 15 帧。在视频第 15、25、35、45 帧里各找目标的真实位置,
  // 位移 × 舞台缩放(1280/320 = 4)应当等于提交进项目的逐帧位移
  const scale = 4;
  const frame0 = decodeGrayFrame(runtime.ffmpeg, shared.video.file, 0, 320, 200);
  const template = [];
  for (let y = -12; y <= 12; y += 1) for (let x = -12; x <= 12; x += 1) template.push(frame0[(first[1] + y) * 320 + first[0] + x]);
  const at = (index) => {
    const frame = decodeGrayFrame(runtime.ffmpeg, shared.video.file, index, 320, 200);
    return locate(frame, 320, template, shared.video.truth[index]);
  };
  const origin = at(15);
  assert.ok(origin[2] > 0.85, `第 15 帧里找得到目标(相似度 ${origin[2]})`);
  for (const k of [10, 20, 30]) {
    const found = at(15 + k);
    assert.ok(found[2] > 0.85, `第 ${15 + k} 帧里找得到目标`);
    const realDx = (found[0] - origin[0]) * scale;
    const realDy = (found[1] - origin[1]) * scale;
    assert.ok(Math.abs(offsets[k][0] - realDx) <= 4 && Math.abs(offsets[k][1] - realDy) <= 4,
      `第 ${k} 个位移 ${offsets[k]} 对不上画面里目标的真实位移 [${realDx}, ${realDy}]`);
  }
  // 卡片确实在动,不是 0 位移的白绑
  assert.ok(Math.hypot(offsets[30][0], offsets[30][1]) > 40);

  // 提交的身份:Agent 对话,不是页面,也不是创建者
  await waitForFake(() => watcher.ops().length >= 1, 5000, '页面收到这次提交');
  const op = watcher.ops().at(-1);
  assert.equal(op.actor.role, 'agent');
  assert.equal(op.actor.conversation, env.side.conversationNumber('conv_motion'));
  assert.equal(op.actor.session, 'agent:conv_motion');
  assert.match(op.opId, /^agent:conv_motion:/);
  assert.equal(op.rev, out.rev);
  assert.ok(op.ops.some((o) => /motion/.test(o.path)), `提交里改的是片段的 motion:${JSON.stringify(op.ops).slice(0, 200)}`);
  const events = env.side.describe();
  assert.equal(events.stats.committed, 1);
  const last = events.conversations.find((c) => c.key === 'conv_motion');
  assert.equal(last.session, 'agent:conv_motion');
  assert.equal(last.lastRead, out.rev);
});

test('P3-M2 没有轨迹不伪造 motion:没追过、还在跑、追失败、轨迹过期各回明确原因,项目版本不动', { skip, timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  const { ctx, tracks, motion, projectId, docs, trackEnv } = env;
  const revOf = async () => (await docs.stateOf(projectId)).rev;
  const base = await revOf();

  // 没追过
  const none = await asError(motion.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' }, ctx));
  assert.equal(none.code, 'TRACK_NONE');

  // 追失败(字节不是视频)
  await tracks.call('track_points', { mediaId: 'm_junk', points: [[0, 10, 10]] }, ctx);
  const failed = await asError(untilTracked(tracks, ctx, 'm_junk'));
  assert.equal(failed.code, 'TRACK_FAILED');
  const afterFail = await asError(motion.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm_junk' }, ctx));
  assert.equal(afterFail.code, 'TRACK_FAILED');

  // 还在跑:对重素材起一个追踪,趁它没跑完就绑
  const heavy = await writeTrackVideo(path.join(shared.dir, 'heavy-motion.mp4'), { ffmpeg: runtime.ffmpeg, width: 960, height: 540, frames: 240, x0: 100, y0: 100 });
  await trackEnv.addMedia('proj_motion', 'm_heavy', heavy.file);
  await tracks.call('track_points', { mediaId: 'm_heavy', points: Array.from({ length: 8 }, () => [0, 100, 100]) }, ctx);
  const running = await asError(motion.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm_heavy' }, ctx));
  assert.equal(running.code, 'TRACK_RUNNING');
  await trackEnv.resources.abortForFence(ctx, 'stop');

  assert.equal(await revOf(), base, '以上全部没有提交');
  assert.equal((await docs.stateOf(projectId)).project.tracks[0].clips[0].motion, undefined);
});

test('P3-M3 校验:卡片类型、时间重叠、点序号、whenHidden、素材换版、只读成员、并发改动;失败一律不提交', { skip, timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  const { ctx, tracks, motion, projectId, docs, seeder, trackEnv, media } = env;
  const first = shared.video.truth[0];
  await tracks.call('track_points', { mediaId: 'm1', points: [[0, first[0], first[1]], [0, first[0] + 100, first[1] + 100]] }, ctx);
  await untilTracked(tracks, ctx, 'm1');
  const revOf = async () => (await docs.stateOf(projectId)).rev;
  const base = await revOf();
  const attach = (args, context = ctx) => asError(motion.call('attach_clip_motion', args, context));

  // 参数
  assert.equal((await attach({ mediaId: 'm1' })).code, 'MOTION_BAD_ARGS');
  assert.equal((await attach({ clipId: 'c1' })).code, 'MOTION_BAD_ARGS');
  assert.equal((await attach({ clipId: 'c1', mediaId: 'm1', pointIndex: -1 })).code, 'MOTION_BAD_ARGS');
  assert.equal((await attach({ clipId: 'c1', mediaId: 'm1', pointIndex: 1.5 })).code, 'MOTION_BAD_ARGS');
  assert.equal((await attach({ clipId: 'c1', mediaId: 'm1', whenHidden: 'vanish' })).code, 'MOTION_BAD_ARGS');
  assert.equal((await attach({ clipId: 'c1', mediaId: 'm1', pointIndex: 2 })).code, 'MOTION_BAD_POINT');
  // 现成 handler 的校验:素材段不是卡片段、找不到片段、时间不重叠
  assert.match((await attach({ clipId: 'v1', mediaId: 'm1' })).message, /是素材段,不是卡片段/);
  assert.match((await attach({ clipId: 'ghost', mediaId: 'm1' })).message, /找不到片段/);
  assert.match((await attach({ clipId: 'c_far', mediaId: 'm1' })).message, /在时间上重叠/);
  assert.equal(await revOf(), base, '校验失败不提交');

  // 只读成员:读得到轨迹,写不了
  trackEnv.access.state.writeAllowed = false;
  assert.equal((await attach({ clipId: 'c1', mediaId: 'm1' })).code, 'run-access-denied');
  trackEnv.access.state.writeAllowed = true;
  // 没被信任的上下文
  assert.equal((await attach({ clipId: 'c1', mediaId: 'm1' }, { ...ctx, runId: 'forged' })).code, 'tool-context-untrusted');
  assert.equal(await revOf(), base);

  // 素材换版:项目里这段素材的哈希变了 → 拒绝,要求重追
  const moved = await seeder.commit([{ op: 'set', path: '/media/@m1/hash', value: 'e'.repeat(64) }]);
  assert.equal(moved.type, 'project.op.ok', JSON.stringify(moved));
  await env.side.link.replica.waitRev(moved.rev, 5000);
  await tracks.call('get_track', { mediaId: 'm1' }, ctx); // 读一次,让这个对话读到最新版本
  const stale = await attach({ clipId: 'c1', mediaId: 'm1' });
  assert.equal(stale.code, 'TRACK_STALE');
  assert.match(stale.message, /force: true/);
  const restore = await seeder.commit([{ op: 'set', path: '/media/@m1/hash', value: media.hash }]);
  assert.equal(restore.type, 'project.op.ok');
  await env.side.link.replica.waitRev(restore.rev, 5000);
  const baseAfter = await revOf();

  // 并发改动:Agent 读过之后用户又改了项目,绑定带的期望版本过期 → 文档服务拒绝,不覆盖用户的改动
  await tracks.call('get_track', { mediaId: 'm1' }, ctx);
  const edit = await seeder.commit([{ op: 'set', path: '/name', value: '用户在这期间改了名' }]);
  assert.equal(edit.type, 'project.op.ok');
  const conflict = await attach({ clipId: 'c1', mediaId: 'm1' });
  assert.equal(conflict.code, 'stale');
  assert.match(conflict.message, /项目在你上次读取之后被改过/);
  const st = await docs.stateOf(projectId);
  assert.equal(st.project.name, '用户在这期间改了名');
  assert.equal(st.project.tracks[0].clips.find((c) => c.id === 'c1').motion, undefined);
  assert.equal(st.rev, baseAfter + 1, '只有用户那一次提交');

  // 重新读一下之后:成功;换个点、whenHidden 为 hide
  await tracks.call('get_track', { mediaId: 'm1' }, ctx);
  const ok = await motion.call('attach_clip_motion', { clipId: 'c2', mediaId: 'm1', pointIndex: 1, whenHidden: 'hide' }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(ok.pointIndex, 1);
  assert.equal(ok.whenHidden, 'hide');
  const final = await docs.stateOf(projectId);
  const c2 = final.project.tracks[0].clips.find((c) => c.id === 'c2');
  assert.equal(c2.motion.pointIndex, 1);
  assert.equal(c2.motion.whenHidden, 'hide');
  assert.equal(final.project.tracks[0].clips.find((c) => c.id === 'c1').motion, undefined, '另一张卡没被碰');
});

test('P3-M4 服务重启之后:轨迹在结果表里,绑定照样成功;关停时等进行中的提交落地', { skip, timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  const { ctx, tracks, trackEnv, projectId, docs, side } = env;
  const first = shared.video.truth[0];
  await tracks.call('track_points', { mediaId: 'm1', points: [[0, first[0], first[1]]] }, ctx);
  await untilTracked(tracks, ctx, 'm1');
  await tracks.close('restart');

  const readProject = async (c) => (await side.executor.snapshot(c.conversationId)).project;
  const reopened = trackEnv.openTracks({ readProject });
  const motion = createMotionTools({
    contextAccess: { authorize: trackEnv.access.authorize }, tracks: reopened,
    commit: ({ context, tool, apply }) => side.executor.mutate(tool, context.conversationId, {}, apply),
  });
  const out = await motion.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' }, ctx);
  assert.equal(out.ok, true);
  const st = await docs.stateOf(projectId);
  assert.ok(st.project.tracks[0].clips.find((c) => c.id === 'c1').motion.offsets.length > 1);

  const receipt = await motion.close('shutdown');
  assert.equal(receipt.workPending, 0);
  assert.equal((await asError(motion.call('attach_clip_motion', { clipId: 'c1', mediaId: 'm1' }, ctx))).code, 'TRACK_CLOSED');
  await reopened.close('end');
  void waitForFake;
});
