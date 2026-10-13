#!/usr/bin/env node
/**
 * P3 包探针:云端 Agent 的运动追踪(track_status / track_points / get_track / track_install)端到端,可重复跑。
 *
 * 每一步都用真东西(ffmpeg 现造的视频、项目素材库真字节、F0 的 ToolJobs / run-resources / ProjectAssets、
 * 工作区的受限 Python 子进程),并且收尾时核对:
 *   - 轨迹对着真值和视频里解出的真画面;
 *   - 取消 / 超时 / 失败各一例,Python 进程真的退出了;
 *   - 没有残留进程(按工作目录的路径在系统进程表里查,Python 和 ffmpeg 都算),没有新冒出来的可见窗口;
 *   - 没装依赖 / 没配 Python 时的回应。
 *
 * 用法:node scripts/probes/cloud-tools-p3-probe.mjs
 * 输出每步一行 `PROBE <步骤> OK|FAIL <说明>`,最后一行 `PROBE-RESULT pass|fail`;失败时退出码 1。
 * 不占端口,不碰 5190～5212 与 58xx / 59xx;临时数据在系统临时目录,跑完删。
 */
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildTrackEnv, contextOf, decodeGrayFrame, findTestRuntime, nccAt, pidAlive, untilTracked, waitFor, writeTrackVideo,
} from '../../server/test/cloud-tools-p3-kit.mjs';

const runtime = findTestRuntime();
const results = [];
const note = (step, ok, text) => { results.push(ok); console.log(`PROBE ${step} ${ok ? 'OK' : 'FAIL'} ${text}`); };
const check = (step, condition, text) => note(step, !!condition, text);

/** 可见窗口里的相关进程(任务书的查法) */
function visibleWindows() {
  const script = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg|python' } | ForEach-Object { $_.Id.ToString() + ':' + $_.ProcessName }";
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return new Set(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

/** 命令行里带这个路径片段的进程(Python 和它的 ffmpeg 孙进程) */
function processesUnder(marker) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { $_.ProcessId.ToString() + ':' + $_.Name }`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/powershell/i.test(l));
}

const hooks = [];
const t = { after: (fn) => hooks.push(fn) };

if (!runtime) {
  console.log('PROBE 环境 FAIL 没有可用的 Python(带 numpy)或 ffmpeg');
  console.log('PROBE-RESULT fail');
  process.exit(1);
}

const windowsBefore = visibleWindows();
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-p3-probe-'));
let exitCode = 0;
try {
  note('环境', true, `python=${runtime.python} ffmpeg=${runtime.ffmpeg}`);
  const small = await writeTrackVideo(path.join(work, 'small.mp4'), { ffmpeg: runtime.ffmpeg });
  const heavy = await writeTrackVideo(path.join(work, 'heavy.mp4'), { ffmpeg: runtime.ffmpeg, width: 960, height: 540, frames: 240, x0: 100, y0: 100 });
  note('造视频', true, `small ${small.width}x${small.height}x${small.frames} heavy ${heavy.width}x${heavy.height}x${heavy.frames}`);
  const heavyPoints = Array.from({ length: 8 }, () => [0, heavy.truth[0][0], heavy.truth[0][1]]);

  /* 1. 状态 + 真追踪 + 真值 + 真画面 */
  {
    const env = await buildTrackEnv(t, { dir: path.join(work, 'env1'), keep: true });
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'm1', small.file);
    const status = await env.tracks.call('track_status', {}, ctx);
    check('状态', status.engine === 'template' && status.ready === false && status.model.exists === false && !JSON.stringify(status).includes(env.root),
      `engine=${status.engine} ready=${status.ready} 权重在=${status.model.exists} runtime.torch=${status.runtime.installed}(BootsTAPIR 档要权重在才算就绪;路径未外露)`);
    const first = small.truth[0];
    const kick = await env.tracks.call('track_points', { mediaId: 'm1', points: [[0, first[0], first[1]]] }, ctx);
    const { result, progress } = await untilTracked(env.tracks, ctx, 'm1');
    const full = await env.tracks.call('get_track', { mediaId: 'm1', full: true }, ctx);
    const errors = full.points[0].xy.map((p, i) => Math.hypot(p[0] - small.truth[i][0], p[1] - small.truth[i][1]));
    check('追踪', result.engine === 'template' && result.frames === 60 && Math.max(...errors) < 1.5,
      `job=${kick.jobId} engine=${result.engine} 帧数=${result.frames} 最大误差=${Math.max(...errors).toFixed(2)}px 可见=${result.points[0].visibleFrames}/${result.points[0].totalFrames} 进度采样=${JSON.stringify(progress)}`);
    const frame0 = decodeGrayFrame(runtime.ffmpeg, small.file, 0, 320, 200);
    const template = [];
    for (let y = -12; y <= 12; y += 1) for (let x = -12; x <= 12; x += 1) template.push(frame0[(first[1] + y) * 320 + first[0] + x]);
    const ncc = [0, 30, 59].map((i) => {
      const [x, y] = full.points[0].xy[i];
      return nccAt(decodeGrayFrame(runtime.ffmpeg, small.file, i, 320, 200), 320, x, y, template, 25);
    });
    check('真画面复核', ncc.every((v) => v > 0.85), `第 0/30/59 帧轨迹位置上的目标相似度 ${ncc.map((v) => v.toFixed(3)).join('/')}`);
    const job = await env.jobs.get(ctx, kick.jobId);
    check('作业表', job.state === 'done' && job.progress === 1 && job.outputRefs[0]?.id === kick.jobId, `state=${job.state} outputRefs=${JSON.stringify(job.outputRefs)}`);
    await env.close();
  }

  /* 2. 取消 */
  {
    const env = await buildTrackEnv(t, { dir: path.join(work, 'env2'), keep: true });
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'big', heavy.file);
    const kick = await env.tracks.call('track_points', { mediaId: 'big', points: heavyPoints }, ctx);
    const python = await waitFor(() => env.spawns.find((s) => s.args.includes('track')), { what: 'Python 起来' });
    await waitFor(async () => (await env.jobs.get(ctx, kick.jobId)).stage === 'track', { timeoutMs: 60_000, what: '进入追踪阶段' });
    const alive = pidAlive(python.pid);
    await env.resources.abortForFence(ctx, 'stop');
    const failure = await untilTracked(env.tracks, ctx, 'big', { timeoutMs: 60_000 }).then(() => null, (e) => e);
    check('取消', alive && failure?.errorCode === 'RUN_CANCELLED' && !pidAlive(python.pid) && env.tracks.results.result(kick.jobId) === null,
      `取消前 pid=${python.pid} 活着=${alive};取消后 errorCode=${failure?.errorCode} 进程已退出=${!pidAlive(python.pid)} 无结果`);
    await env.close();
  }

  /* 3. 超时 */
  {
    const env = await buildTrackEnv(t, { dir: path.join(work, 'env3'), keep: true, limits: { jobTimeoutMs: 1500 } });
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'big', heavy.file);
    const kick = await env.tracks.call('track_points', { mediaId: 'big', points: heavyPoints }, ctx);
    const failure = await untilTracked(env.tracks, ctx, 'big', { timeoutMs: 60_000 }).then(() => null, (e) => e);
    const python = env.spawns.find((s) => s.args.includes('track'));
    await waitFor(() => !pidAlive(python.pid), { what: 'Python 退出' });
    check('超时', failure?.code === 'TRACK_TIMEOUT' && env.tracks.results.result(kick.jobId) === null, `limit=1500ms code=${failure?.code} 进程已退出 无结果`);
    await env.close();
  }

  /* 4. 失败(字节不是视频)+ 非视频素材 */
  {
    const env = await buildTrackEnv(t, { dir: path.join(work, 'env4'), keep: true });
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'junk', Buffer.from('this is definitely not an mp4 file at all, but long enough to be read'), { kind: 'video', ext: 'mp4' });
    await env.addMedia('proj_a', 'song', Buffer.from('audio bytes'), { kind: 'audio', ext: 'mp3' });
    await env.tracks.call('track_points', { mediaId: 'junk', points: [[0, 10, 10]] }, ctx);
    const junk = await untilTracked(env.tracks, ctx, 'junk').then(() => null, (e) => e);
    await env.tracks.call('track_points', { mediaId: 'song', points: [[0, 10, 10]] }, ctx);
    const song = await untilTracked(env.tracks, ctx, 'song').then(() => null, (e) => e);
    check('失败', junk?.code === 'TRACK_FAILED' && !/[A-Za-z]:[\\/]/.test(junk.message) && song?.code === 'TRACK_NOT_VIDEO',
      `坏字节 code=${junk?.code}(消息不带路径);音频素材 code=${song?.code}`);
    await env.close();
  }

  /* 5. 没装模型 / 依赖 */
  {
    const bare = await buildTrackEnv(t, { dir: path.join(work, 'env5'), keep: true, python: null });
    const ctx = bare.access.trust(contextOf());
    const status = await bare.tracks.call('track_status', {}, ctx);
    const err = await bare.tracks.call('track_points', { mediaId: 'm', points: [[0, 1, 1]] }, ctx).then(() => null, (e) => e);
    const install = await bare.tracks.call('track_install', {}, ctx);
    check('没配 Python', status.engine === null && err?.code === 'TRACK_UNCONFIGURED' && install.code === 'TRACK_INSTALL_DISABLED',
      `status.engine=${status.engine} track_points→${err?.code} track_install→${install.code}`);
    await bare.close();
  }

  /* 6. 残留:进程表里不该再有指着这次工作目录的 Python / ffmpeg,也不该冒出新的可见窗口 */
  await new Promise((r) => setTimeout(r, 1500));
  const leftovers = processesUnder(work);
  check('无残留进程', leftovers.length === 0, leftovers.length ? `残留 ${leftovers.join(', ')}` : '工作目录下没有任何 Python / ffmpeg 进程');
  const windowsAfter = visibleWindows();
  const fresh = [...windowsAfter].filter((w) => !windowsBefore.has(w));
  check('无新窗口', fresh.length === 0, fresh.length ? `新冒出 ${fresh.join(', ')}` : '没有新冒出来的可见窗口');
} catch (error) {
  note('探针本身', false, String(error?.stack ?? error).slice(0, 600));
} finally {
  for (const hook of hooks.reverse()) { try { await hook(); } catch { /* 清理尽力而为 */ } }
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  exitCode = results.every(Boolean) ? 0 : 1;
  console.log(`PROBE-RESULT ${exitCode === 0 ? 'pass' : 'fail'}`);
}
process.exit(exitCode);
