/**
 * P3 包 · 追踪工具接真 run-authority(doc 一侧的任务权威,真 SQLite 账本、真实例签名)。
 *
 * 这里证明的是「授权变化时,追踪提供者的行为」,不再用受控桩:
 *   - 已读共有任务的发起人登录退出 → 任务转成 retained,在途的追踪作业**继续跑完**(作业表的 fence 迁移走 F0 的受控 checkpoint),
 *     结果照样落下、照样读得到;
 *   - 私有 / 停止 → run 被撤:资源表杀掉 Python,作业被宿主标成取消,没有结果,撤销之后的读也拒;
 *   - 读写都带着 doc 当时的授权:撤销之后 `get_track`、`readResult` 一律拒,结果表里有的也不给。
 *
 * 用例 P3-A1～P3-A3。Python 或 ffmpeg 不可用时 skip。素材传输仍是进程内直连项目素材库(没有 mTLS),
 * 这一点和 F0 的 `project-assets-client.test.mjs` 同级,不冒称端到端。
 * 跑:node --test server/test/cloud-tools-p3-authority.test.mjs
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { runFixture, projectId, servicePrincipal } from './run-authority-fixture.mjs';
import { buildTrackEnv, findTestRuntime, pidAlive, untilTracked, waitFor, writeTrackVideo } from './cloud-tools-p3-kit.mjs';

const runtime = findTestRuntime();
const skip = runtime ? false : '没有可用的 Python(带 numpy)或 ffmpeg';
let shared = null;

before(async () => {
  if (!runtime) return;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-p3-auth-'));
  shared = {
    dir,
    small: await writeTrackVideo(path.join(dir, 'small.mp4'), { ffmpeg: runtime.ffmpeg }),
    heavy: await writeTrackVideo(path.join(dir, 'heavy.mp4'), { ffmpeg: runtime.ffmpeg, width: 960, height: 540, frames: 240, x0: 100, y0: 100 }),
  };
});
after(async () => { if (shared) await fsp.rm(shared.dir, { recursive: true, force: true }); });

const asError = async (promise) => promise.then(() => null, (error) => error);

async function authorityEnv(t) {
  const authority = await runFixture();
  authority.enqueue();
  const grant = await authority.admit();
  await authority.provider.confirmRead(authority.input(grant));
  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  const resources = createRunResources({ runClient });
  const context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });
  // 宿主记得自己发过哪些 fence:撤销之后 doc 不再认它,但宿主仍能指着「这个 fence 下的作业」要求取消
  const seen = new Set([(await resources.authorize(context, 'write')).fenceRevision]);
  const verifyFence = async (ctx, revision) => {
    try {
      const ok = await resources.verifyFence(ctx, revision);
      if (ok) seen.add(revision);
      return ok;
    } catch { return seen.has(revision); }
  };
  const env = await buildTrackEnv(t, { resources, gate: { authorize: (ctx, action) => resources.authorize(ctx, action), verifyFence } });
  t.after(() => { authority.close(); });
  return { authority, resources, context, env, seen };
}

const jobRow = (env, jobId) => {
  const db = new DatabaseSync(env.jobsPath, { readOnly: true });
  try { return db.prepare('SELECT state, stage, progress, error_code, fence_revision FROM tool_jobs WHERE job_id=?').get(jobId); } finally { db.close(); }
};

test('P3-A1 真授权下的完整一轮:追踪、读结果;私有之后连读都拒,结果表里有的也不给', { skip, timeout: 240_000 }, async (t) => {
  const { authority, context, env } = await authorityEnv(t);
  await env.addMedia(projectId, 'm1', shared.small.file);
  const first = shared.small.truth[0];
  const kick = await env.tracks.call('track_points', { mediaId: 'm1', points: [[0, first[0], first[1]]] }, context);
  assert.equal(kick.started, true);
  const { result } = await untilTracked(env.tracks, context, 'm1');
  assert.equal(result.engine, 'template');
  assert.equal(result.points[0].visibleFrames, 60);
  assert.equal((await env.jobs.get(context, kick.jobId)).state, 'done');

  authority.privateFence();
  for (const [tool, args] of [['get_track', { mediaId: 'm1' }], ['track_status', {}], ['track_points', { mediaId: 'm1', points: [[0, 1, 1]], force: true }]]) {
    const error = await asError(env.tracks.call(tool, args, context));
    assert.ok(error, `${tool} 在私有之后必须拒`);
    assert.match(String(error.code), /run-access-denied|run-authority-unavailable|forbidden/, `${tool}:${error.code}`);
  }
  assert.equal(env.tracks.results.result(kick.jobId) !== null, true, '结果还躺在表里');
  assert.ok((await asError(env.tracks.readResult(context, { mediaId: 'm1' }))), '但撤销之后读不出来');
  await env.close();
});

test('P3-A2 已读共有任务的发起人登录退出:任务转成 retained,在途的追踪继续跑完并落结果', { skip, timeout: 240_000 }, async (t) => {
  const { authority, context, env, seen } = await authorityEnv(t);
  await env.addMedia(projectId, 'big', shared.heavy.file);
  const points = Array.from({ length: 8 }, () => [0, shared.heavy.truth[0][0], shared.heavy.truth[0][1]]);
  const kick = await env.tracks.call('track_points', { mediaId: 'big', points }, context);
  const python = await waitFor(() => env.spawns.find((s) => s.args.includes('track')), { what: 'Python 起来' });
  await waitFor(() => jobRow(env, kick.jobId).stage === 'track', { timeoutMs: 60_000, what: '进入追踪阶段' });
  const fenceBefore = jobRow(env, kick.jobId).fence_revision;
  assert.equal(pidAlive(python.pid), true);

  authority.provider.applyAccessEvent(authority.exit()); // 发起人的登录退出
  const now = await env.resources.authorize(context, 'write');
  assert.equal(now.grantState, 'retained');
  assert.ok(now.fenceRevision > fenceBefore, 'fence 变了');
  seen.add(now.fenceRevision);

  // 在途的追踪不被打断:一路跑完,作业推到 done(走 F0 的 checkpointRetained),结果在
  const { result } = await untilTracked(env.tracks, context, 'big', { timeoutMs: 120_000 });
  assert.equal(result.running, false);
  assert.equal(result.points.length, 8);
  const row = jobRow(env, kick.jobId);
  assert.equal(row.state, 'done');
  assert.equal(row.fence_revision, now.fenceRevision, '作业已迁到 retained 的 fence');
  assert.equal(pidAlive(python.pid), false);
  assert.ok(env.tracks.results.result(kick.jobId));
  await env.close();
});

test('P3-A3 私有打断在途追踪:资源表杀 Python,宿主取消作业,没有结果;撤销之后读不到', { skip, timeout: 240_000 }, async (t) => {
  const { authority, context, env, seen } = await authorityEnv(t);
  await env.addMedia(projectId, 'big', shared.heavy.file);
  const points = Array.from({ length: 8 }, () => [0, shared.heavy.truth[0][0], shared.heavy.truth[0][1]]);
  const kick = await env.tracks.call('track_points', { mediaId: 'big', points }, context);
  const python = await waitFor(() => env.spawns.find((s) => s.args.includes('track')), { what: 'Python 起来' });
  await waitFor(() => jobRow(env, kick.jobId).stage === 'track', { timeoutMs: 60_000, what: '进入追踪阶段' });
  const fence = jobRow(env, kick.jobId).fence_revision;
  assert.ok(seen.has(fence));

  authority.privateFence();
  // 宿主在撤销时做的三件事:资源表杀进程、作业表按 fence 取消、(这里)等进程真退出
  await env.resources.abortForFence(context, 'private');
  await waitFor(() => !pidAlive(python.pid), { what: 'Python 退出' });
  await env.jobs.cancelForFence(context, fence);
  await waitFor(() => jobRow(env, kick.jobId).state === 'cancelled', { what: '作业被标成取消' });
  assert.equal(jobRow(env, kick.jobId).error_code, 'FENCE_CANCELLED');
  assert.equal(env.tracks.results.result(kick.jobId), null, '没有迟到的产物');
  const ws = await env.workspace(context);
  const leftOf = async () => (await fsp.readdir(path.join(ws.dir(), '.tmp'))).filter((n) => n.startsWith('track-'));
  await waitFor(async () => (await leftOf()).length === 0, { what: '素材副本删净(runner 收尾)' });
  assert.ok(await asError(env.tracks.call('get_track', { mediaId: 'big' }, context)));
  const receipt = await env.resources.abortForFence(context, 'private');
  assert.equal(receipt.childrenOpen, 0);
  await env.close();
});
