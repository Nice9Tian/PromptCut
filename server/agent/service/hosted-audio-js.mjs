/**
 * 云端 Agent 的自定义音频测量提供者（`measure_audio_js`；拆包表 P6 `server/agent/service/hosted-audio-js.mjs`）。
 *
 * 规矩：
 *   - 每次调用先经 `resources.authorize(context, 'read')`（或 `contextAccess.authorize(context, 'read')`）核验当前 `runGrant` 与 `fenceRevision`；
 *   - 只从当前受权项目的 `mediaId` / `clipId` / `timeline` 经 `project.getMedia` 与 `assets.openRead` 读取素材并解码 PCM，
 *     严禁读取本机任意路径、URL 或跨项目素材；
 *   - 解码子进程（`ffprobe` / `ffmpeg`）均带 `-protocol_whitelist file`，并经 `superviseChild` 登记到 `resources.register(context, { kind: 'child', ... })`；
 *   - 解出的受权 PCM 交由隔离沙箱（`server/audio-sandbox.mjs` 或 `server/hosted-render/audio-js.mjs` 签名端点）执行 `code`，
 *     返回与桌面版 `measure_audio_js` 同形的 JSON 摘要或带语法行列号（`line`、`column` 与 `(第 X 行第 Y 列)`）的错误；
 *   - 失权、取消（`abortForFence`）或 `close()` 时立即中止解码与沙箱 worker，等待真实 worker 关闭并清理临时文件。
 *
 * 纯 Node 模块，不直接 import `src/`。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnTree, superviseChild } from './perception/runner.mjs';
import { createAudioSandbox, SANDBOX_LIMITS, clampTimeout } from '../../audio-sandbox.mjs';
import {
  PCM_LIMITS,
  pcmFormat,
  sampleBudgetError,
  windowOf,
  filePcmArgs,
  timelinePcmArgs,
  deinterleave,
} from '../../audio-pcm.mjs';
import { encodePcmChannels, HOSTED_AUDIO_JS_AUTH_HEADER } from '../../hosted-render/audio-js.mjs';
import { signLookRequest } from '../../hosted-render/look.mjs';

/**
 * 片段速度(`TrackClip.speed`),不是有限正数时按 1。与 `src/kernel/clipTime.mjs` 的 clipSpeed 同一条规则
 * (Agent 服务进程这一侧不 import src/,照抄)。
 */
function speedOf(clip) {
  const s = clip?.speed;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}

export const AUDIO_JS_TOOL_NAMES = Object.freeze(['measure_audio_js']);

export const AUDIO_JS_DEFAULTS = Object.freeze({
  versionMs: 15_000,
  statusCacheMs: 15_000,
  probeMs: 25_000,
  decodeMs: 40_000,
  fetchMs: 60_000,
  maxFetchBytes: 1024 * 1024 * 1024,
  maxEntries: 200,
});

export class AudioJsToolError extends Error {
  constructor(message, code = 'audio-js-error', status = 400) {
    super(message);
    this.name = 'AudioJsToolError';
    this.code = code;
    this.status = status;
  }
}

const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const NO_SOUND_NOTE = '时间轴上没有会出声的片段(隐藏 / 静音的序列和静音的片段不算)';
const NOT_CONFIGURED = '这台云节点没有配置 ffmpeg / ffprobe，云端 Agent 无法解码音频执行 measure_audio_js。请改用其它工具或请用户在电脑上的 PromptCut 里测量。';
const NO_FFMPEG = '这台云节点上 ffmpeg / ffprobe 起不来，云端 Agent 无法解码音频执行 measure_audio_js。';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function localOnlyArgs(args) {
  const out = [];
  for (const a of args) {
    if (a === '-i') out.push('-protocol_whitelist', 'file');
    out.push(a);
  }
  return out;
}

function resolveBinaries({ ffmpeg, ffprobe, config }) {
  const ff = typeof ffmpeg === 'string' && ffmpeg ? ffmpeg : (typeof config?.ffmpeg === 'string' && config.ffmpeg ? config.ffmpeg : null);
  let fp = typeof ffprobe === 'string' && ffprobe ? ffprobe : (typeof config?.ffprobe === 'string' && config.ffprobe ? config.ffprobe : null);
  if (!fp && ff && path.isAbsolute(ff)) {
    const ext = path.extname(ff);
    const candidate = path.join(path.dirname(ff), `ffprobe${ext}`);
    if (fs.existsSync(candidate)) fp = candidate;
  }
  return {
    ffmpeg: ff,
    ffprobe: fp,
    ffmpegArgs: Array.isArray(config?.ffmpegArgs) ? config.ffmpegArgs : [],
    ffprobeArgs: Array.isArray(config?.ffprobeArgs) ? config.ffprobeArgs : [],
  };
}

/**
 * @param {object} d
 * @param {object} [d.contextAccess] F0 `createToolRunContextAccess`
 * @param {object} d.resources F0 `createRunResources`
 * @param {object} d.assets F0 `createProjectAssets`
 * @param {object} d.project `{ getMedia(context, mediaId), getTimeline?(context), getClip?(context, clipId), getProject?(context) }`
 * @param {((context: object) => object | Promise<object>) | object} [d.workspace] 对话工作区
 * @param {string | null} [d.ffmpeg]
 * @param {string | null} [d.ffprobe]
 * @param {object | null} [d.config]
 * @param {Function | null} [d.runSandbox] 可选：自定义沙箱调用器 `(payload, { signal, context }) => Promise<result>`
 * @param {object | null} [d.sandbox] 可选：`createAudioSandbox` 或 `createHostedAudioJsHandler` 实例
 * @param {string | null} [d.endpointUrl] 可选：渲染服务 `/api/audio/measure-js` 签名端点地址
 * @param {object | null} [d.serviceKey] 可选：Agent 服务签名私钥（配 `endpointUrl` 使用）
 */
export function createAudioJsTools({
  contextAccess = null,
  resources = null,
  assets,
  project,
  workspace = null,
  ffmpeg = null,
  ffprobe = null,
  config = null,
  runSandbox = null,
  sandbox: injectedSandbox = null,
  endpointUrl = null,
  serviceKey = null,
  signRequest = signLookRequest,
  limits: limitsIn = {},
  pcmLimits = PCM_LIMITS,
  sandboxLimits: sandboxLimitsIn = {},
  now = Date.now,
  log = () => {},
} = {}) {
  const authProvider = resources && typeof resources.authorize === 'function'
    ? resources
    : (contextAccess && typeof contextAccess.authorize === 'function' ? contextAccess : null);
  if (!authProvider) throw new AudioJsToolError('音频自定义测量缺少依赖:resources/contextAccess', 'audio-js-unconfigured');
  if (!assets || typeof assets.openRead !== 'function') throw new AudioJsToolError('音频自定义测量缺少依赖:assets', 'audio-js-unconfigured');
  if (!project || typeof project.getMedia !== 'function') throw new AudioJsToolError('音频自定义测量缺少依赖:project.getMedia', 'audio-js-unconfigured');

  const limits = { ...AUDIO_JS_DEFAULTS, ...limitsIn };
  const sbLimits = { ...SANDBOX_LIMITS, ...sandboxLimitsIn };
  const bins = resolveBinaries({ ffmpeg, ffprobe, config });
  const say = (event, fields = {}) => { try { log(event, fields); } catch {} };

  let ownedSandbox = null;
  const getSandbox = () => {
    if (injectedSandbox) return injectedSandbox;
    if (!ownedSandbox) ownedSandbox = createAudioSandbox({ limits: sbLimits });
    return ownedSandbox;
  };

  let closing = false;
  let ffmpegCache = null;
  const children = new Set();
  const activeStreams = new Set();
  const activeDirs = new Set();
  const activeSandboxAborts = new Set();
  const inFlight = new Set();

  async function authorize(context, action = 'read') {
    if (closing) throw new AudioJsToolError('云端 Agent 服务正在关闭,不再接新活。', 'audio-js-closing', 503);
    if (!context || typeof context !== 'object' || typeof context.projectId !== 'string' || typeof context.runGrantId !== 'string') {
      throw new AudioJsToolError('缺少可信的运行上下文', 'tool-context-untrusted', 403);
    }
    try {
      return await authProvider.authorize(context, action);
    } catch (error) {
      if (error instanceof AudioJsToolError) throw error;
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw new AudioJsToolError('文档服务暂时联系不上,没法确认这一轮的权限。稍后再试。', 'authority-unavailable', 503);
      }
      throw new AudioJsToolError('这一轮没有读项目的权限(被停止、转私有或权限已撤)。', 'audio-js-forbidden', 403);
    }
  }

  function scrub(text, wsDir = null) {
    let out = String(text ?? '');
    if (wsDir) out = out.split(wsDir).join('<工作目录>');
    for (const secret of [bins.ffmpeg, bins.ffprobe].filter(Boolean)) {
      out = out.split(secret).join('<节点目录>');
    }
    return out.replace(/[A-Za-z]:\\[^\s'",)]+/g, '<节点目录>');
  }

  async function resolveWorkspace(context) {
    if (typeof workspace === 'function') return await workspace(context);
    if (workspace && typeof workspace === 'object') return workspace;
    return null;
  }

  async function runChild(context, ws, command, args, { timeoutMs, cwd = null, onStdout = () => {}, onStderr = () => {} } = {}) {
    await authorize(context, 'read');
    const child = ws && typeof ws.spawn === 'function'
      ? ws.spawn(command, args, {})
      : spawnTree(command, args, { cwd: cwd || os.tmpdir() });
    const stderrTail = [];
    let run;
    try {
      run = await superviseChild(child, {
        resources: resources && typeof resources.register === 'function' ? resources : null,
        context,
        timeoutMs,
        onStdout: (d) => onStdout(d),
        onStderr: (d) => {
          const text = d.toString('utf8');
          onStderr(text);
          for (const l of text.split(/\r?\n/)) {
            if (l.trim()) {
              stderrTail.push(l.trim().slice(0, 300));
              if (stderrTail.length > 20) stderrTail.shift();
            }
          }
        },
      });
    } catch {
      throw new AudioJsToolError('这一轮已经没有权限继续(被停止、转私有或 Agent 关闭),解码进程没有启动。', 'audio-js-forbidden', 403);
    }
    const done = run.done.then((end) => ({
      code: end.spawnError ? -1 : (end.code ?? -1),
      timedOut: end.timedOut,
      aborted: end.aborted,
      stderrTail,
      spawnError: end.spawnError ?? null,
    }));
    const entry = { kill: run.kill, closed: done.then(() => undefined) };
    children.add(entry);
    void entry.closed.then(() => children.delete(entry));
    if (closing) entry.kill();
    return { done, kill: entry.kill, signal: run.signal, closed: entry.closed };
  }

  async function checkFfmpeg(context, ws) {
    if (!bins.ffmpeg) return { ok: false, reason: NOT_CONFIGURED };
    if (ffmpegCache && now() - ffmpegCache.at < (ffmpegCache.value.ok ? limits.statusCacheMs : 2000)) {
      return ffmpegCache.value;
    }
    let value;
    try {
      let out = '';
      const run = await runChild(context, ws, bins.ffmpeg, [...bins.ffmpegArgs, '-hide_banner', '-nostdin', '-version'], {
        timeoutMs: limits.versionMs,
        onStdout: (d) => { if (out.length < 400) out += d.toString('utf8'); },
      });
      const end = await run.done;
      await run.closed;
      if (end.aborted || closing) throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
      const version = out.split(/\r?\n/)[0]?.match(/ffmpeg version (\S+)/)?.[1];
      value = end.code === 0 && (version || bins.ffmpegArgs.length > 0) ? { ok: true, version: version ?? 'stub' } : { ok: false, reason: NO_FFMPEG };
    } catch (error) {
      if (error instanceof AudioJsToolError) throw error;
      value = { ok: false, reason: NO_FFMPEG };
    }
    ffmpegCache = { at: now(), value };
    return value;
  }

  async function probeChannels(context, ws, filePath, cwd) {
    if (!bins.ffprobe) return 2;
    let out = '';
    const run = await runChild(context, ws, bins.ffprobe, [
      ...bins.ffprobeArgs,
      '-v', 'error', '-protocol_whitelist', 'file',
      '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', filePath,
    ], {
      timeoutMs: limits.probeMs,
      cwd,
      onStdout: (d) => { if (out.length < 256) out += d.toString('utf8'); },
    });
    const end = await run.done;
    await run.closed;
    if (end.aborted || closing) throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
    if (end.code !== 0) return 0;
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async function decodePcmSupervised(context, ws, ffmpegArgs, { channels, sampleRate, cwd, wsDir }) {
    const maxBytes = pcmLimits.maxSamples * 4;
    const chunks = [];
    let bytes = 0;
    let overBudgetMsg = null;
    let run;
    run = await runChild(context, ws, bins.ffmpeg, [...bins.ffmpegArgs, ...localOnlyArgs(ffmpegArgs)], {
      timeoutMs: limits.decodeMs,
      cwd,
      onStdout: (d) => {
        if (overBudgetMsg) return;
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
        bytes += buf.length;
        if (bytes > maxBytes) {
          const maxSec = Math.floor(pcmLimits.maxSamples / (sampleRate * channels));
          overBudgetMsg = `要测的声音超过样本上限 ${pcmLimits.maxSamples}(${sampleRate} Hz、${channels} 声道下最多 ${maxSec} 秒)。降 sampleRate、传 mono: true,或用 start / duration 只测一段。`;
          run?.kill?.();
          return;
        }
        chunks.push(buf);
      },
    });
    const end = await run.done;
    await run.closed;
    if (end.aborted || closing) throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
    if (overBudgetMsg) return { ok: false, kind: 'too-many-samples', error: overBudgetMsg };
    if (end.timedOut) return { ok: false, kind: 'decode', error: `解码超时(${Math.round(limits.decodeMs / 1000)} 秒)` };
    if (end.code !== 0) {
      const tail = scrub(end.stderrTail.slice(-3).join(' '), wsDir).slice(0, 300);
      return { ok: false, kind: 'decode', error: `ffmpeg 解码失败: ${tail || `退出码 ${end.code}`}` };
    }
    return { ok: true, pcm: deinterleave(Buffer.concat(chunks), channels) };
  }

  async function readTimeline(context) {
    if (typeof project.getTimeline === 'function') {
      const tl = await project.getTimeline(context);
      if (tl && Array.isArray(tl.tracks)) return tl;
    }
    if (typeof project.getProject === 'function') {
      const p = await project.getProject(context);
      if (p && Array.isArray(p.tracks)) return { tracks: p.tracks, duration: p.duration };
    }
    return { tracks: [], duration: undefined };
  }

  async function findClipInProject(context, clipId) {
    if (typeof project.getClip === 'function') {
      const c = await project.getClip(context, clipId);
      if (c) return c;
    }
    const tl = await readTimeline(context);
    for (const track of tl.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip && clip.id === clipId) return clip;
      }
    }
    return null;
  }

  async function resolveTarget(context, args) {
    const scope = args.scope || (args.clipId ? 'clip' : args.mediaId ? 'media' : 'timeline');
    if (scope === 'media') {
      const mediaId = args.mediaId;
      if (typeof mediaId !== 'string' || !MEDIA_ID_RE.test(mediaId)) {
        throw new AudioJsToolError('mediaId 必填,是素材的 id(可用 list_media 查看)', 'bad-args');
      }
      const media = await project.getMedia(context, mediaId);
      if (!media) {
        throw new AudioJsToolError(`找不到素材 ${String(mediaId).slice(0, 80)}(没有这个 id,或它不在当前项目里)`, 'media-not-found', 404);
      }
      if (media.kind === 'image') throw new AudioJsToolError(`「${media.name}」是图片,没有声音`, 'media-kind');
      if (media.pending) throw new AudioJsToolError(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`, 'media-pending');
      return { scope: 'media', media, meta: { mediaId: media.id } };
    }
    if (scope === 'clip') {
      const clipId = String(args.clipId || '');
      if (!clipId) throw new AudioJsToolError('当前剪辑里没有片段 (没给 clipId)', 'clip-not-found', 404);
      const clip = await findClipInProject(context, clipId);
      if (!clip) throw new AudioJsToolError(`当前剪辑里没有片段 ${clipId}`, 'clip-not-found', 404);
      if (!clip.mediaId || clip.cardId) throw new AudioJsToolError('卡片没有声音;要测的是视频 / 声音片段', 'clip-kind');
      const media = await project.getMedia(context, clip.mediaId);
      if (!media) throw new AudioJsToolError(`找不到素材 ${clip.mediaId}(没有这个 id,或它不在当前项目里)`, 'media-not-found', 404);
      if (media.kind === 'image') throw new AudioJsToolError(`「${media.name}」是图片,没有声音`, 'media-kind');
      if (media.pending) throw new AudioJsToolError(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`, 'media-pending');
      return {
        scope: 'clip',
        media,
        offset: Number(clip.mediaOffset) || 0,
        // 变速段:量的是这一段用到的那截素材(时间轴时长 × 片段速度;与 src/kernel/clipTime.mjs 的 mediaSpanOf 同一个式子)
        duration: Math.max(0, (Number(clip.end) || 0) - (Number(clip.start) || 0)) * speedOf(clip),
        meta: { clipId: clip.id, mediaId: media.id },
      };
    }
    if (scope === 'timeline') {
      const tl = await readTimeline(context);
      const entries = [];
      const withFx = [];
      for (const track of tl.tracks ?? []) {
        if (track?.hidden || track?.muted || track?.sourceOnly) continue;
        for (const clip of track?.clips ?? []) {
          if (!clip || !clip.mediaId || clip.cardId || clip.muted) continue;
          const vol = clip.volume === undefined ? 1 : Number(clip.volume);
          if (!(vol > 0)) continue;
          const dur = (Number(clip.end) || 0) - (Number(clip.start) || 0);
          if (!(dur > 0)) continue;
          const media = await project.getMedia(context, clip.mediaId);
          if (!media || media.kind === 'image' || media.pending) continue;
          // 〔裁〕变速的视频段第一版不出原声(src/kernel/clipTime.mjs 的 speedMutesSource);变速的声音段照常出声、随倍率变调
          if (speedOf(clip) !== 1 && media.kind !== 'audio') continue;
          if (clip.audioFx || clip.fx) withFx.push(clip.id);
          entries.push({
            clipId: clip.id,
            media,
            start: Number(clip.start) || 0,
            dur,
            offset: Number(clip.mediaOffset) || 0,
            ...(speedOf(clip) !== 1 ? { speed: speedOf(clip) } : null),
            volume: vol,
            fadeIn: Number(clip.fadeIn) || 0,
            fadeOut: Number(clip.fadeOut) || 0,
          });
        }
      }
      if (!entries.length) {
        return { scope: 'timeline', empty: true };
      }
      if (entries.length > limits.maxEntries) {
        throw new AudioJsToolError(`时间轴上出声的片段超过 ${limits.maxEntries} 段,云端一次量不了这么多;请按片段(clipId)分开量。`, 'too-many-entries');
      }
      const maxEnd = Math.max(...entries.map((e) => e.start + e.dur));
      const total = Number(tl.duration) > 0 ? Number(tl.duration) : maxEnd;
      return { scope: 'timeline', entries, total, withFx, meta: {} };
    }
    return { scope, invalidScope: true };
  }

  async function executeInSandbox(context, payload) {
    const ac = new AbortController();
    activeSandboxAborts.add(ac);
    const handle = new EventEmitter();
    let settled = false;
    const finishHandle = () => {
      if (settled) return;
      settled = true;
      handle.emit('exit');
      handle.emit('close');
    };
    handle.kill = () => {
      ac.abort();
      if (ownedSandbox) {
        void ownedSandbox.close().finally(finishHandle);
      } else if (injectedSandbox && typeof injectedSandbox.close === 'function') {
        void injectedSandbox.close().finally(finishHandle);
      } else {
        finishHandle();
      }
    };

    let registration = null;
    if (resources && typeof resources.register === 'function') {
      try {
        registration = await resources.register(context, { kind: 'child', resource: handle });
      } catch {
        handle.kill();
        throw new AudioJsToolError('这一轮已经没有权限继续(被停止、转私有或 Agent 关闭),沙箱没有启动。', 'audio-js-forbidden', 403);
      }
    }
    const onRegAbort = () => handle.kill();
    if (registration?.signal) {
      if (registration.signal.aborted) onRegAbort();
      else registration.signal.addEventListener('abort', onRegAbort, { once: true });
    }

    try {
      if (typeof runSandbox === 'function') {
        const res = await runSandbox(payload, { signal: ac.signal, context });
        if (ac.signal.aborted || closing) throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
        return res?.body ?? res;
      }
      if (endpointUrl && serviceKey) {
        const bodyText = JSON.stringify({
          code: payload.code,
          pcm: encodePcmChannels(payload.channels),
          sampleRate: payload.sampleRate,
          duration: payload.duration,
          timeoutMs: payload.timeoutMs,
          meta: payload.meta,
          source: payload.source,
          notes: payload.notes,
        });
        const sig = signRequest(serviceKey, bodyText, { now: now() });
        const resp = await fetch(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [HOSTED_AUDIO_JS_AUTH_HEADER]: sig,
          },
          body: bodyText,
          signal: ac.signal,
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data) {
          throw new AudioJsToolError(data?.error || `音频测量沙箱请求失败(HTTP ${resp.status})`, 'sandbox-http-error', resp.status);
        }
        return data;
      }
      const sb = getSandbox();
      if (typeof sb.handle === 'function' && typeof sb.run === 'function' && sb.limits) {
        // createHostedAudioJsHandler 实例或 createAudioSandbox 实例
        const out = await sb.run(payload, { signal: ac.signal });
        if (ac.signal.aborted || closing) throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
        if (out && typeof out === 'object' && 'status' in out && 'body' in out) return out.body;
        const input = {
          sampleRate: payload.sampleRate,
          numberOfChannels: payload.channels.length,
          frames: payload.channels[0]?.length ?? 0,
          duration: payload.duration,
          ...payload.source,
        };
        if (!out.ok) {
          if (out.kind === 'cancelled') throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
          return {
            ok: false,
            kind: out.kind,
            error: out.error,
            ...(Number.isInteger(out.line) ? { line: out.line, column: out.column } : null),
            input,
            ...(out.blockedRequests ? { blockedRequests: out.blockedRequests } : null),
            ...(payload.notes?.length ? { notes: payload.notes } : null),
          };
        }
        return {
          ok: true,
          value: out.value,
          elapsedMs: out.elapsedMs,
          input,
          ...(out.blockedRequests ? { blockedRequests: out.blockedRequests } : null),
          ...(payload.notes?.length ? { notes: payload.notes } : null),
        };
      }
      const r = await sb.run({
        code: payload.code,
        channels: payload.channels,
        sampleRate: payload.sampleRate,
        duration: payload.duration,
        meta: { ...payload.meta, scope: payload.source.scope, start: payload.source.start },
        timeoutMs: payload.timeoutMs,
        signal: ac.signal,
      });
      if (ac.signal.aborted || closing || r?.kind === 'cancelled') {
        throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
      }
      const input = {
        sampleRate: payload.sampleRate,
        numberOfChannels: payload.channels.length,
        frames: payload.channels[0]?.length ?? 0,
        duration: payload.duration,
        ...payload.source,
      };
      if (!r.ok) {
        return {
          ok: false,
          kind: r.kind,
          error: r.error,
          ...(Number.isInteger(r.line) ? { line: r.line, column: r.column } : null),
          input,
          ...(r.blockedRequests ? { blockedRequests: r.blockedRequests } : null),
          ...(payload.notes?.length ? { notes: payload.notes } : null),
        };
      }
      return {
        ok: true,
        value: r.value,
        elapsedMs: r.elapsedMs,
        input,
        ...(r.blockedRequests ? { blockedRequests: r.blockedRequests } : null),
        ...(payload.notes?.length ? { notes: payload.notes } : null),
      };
    } finally {
      if (registration?.signal) registration.signal.removeEventListener('abort', onRegAbort);
      finishHandle();
      if (registration?.closed) await registration.closed.catch(() => {});
      activeSandboxAborts.delete(ac);
    }
  }

  async function measureAudioJs(context, args) {
    await authorize(context, 'read');
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, kind: 'invalid', error: '请求体不对' };
    }
    // 严禁模型或调用方传入本地路径或任意 URL
    if (args.path || args.file || args.url || args.media?.path || args.media?.url) {
      throw new AudioJsToolError('measure_audio_js 只允许通过当前项目的 mediaId 或 clipId 读取受权素材,不接受路径或 URL', 'bad-args', 400);
    }
    const code = args.code;
    if (typeof code !== 'string' || !code.trim()) {
      return { ok: false, kind: 'invalid', error: 'code 是空的:写一个函数体,收到 input(channels、sampleRate、duration……),用 return 返回结果' };
    }
    const maxCodeChars = sandboxLimitsIn.maxCodeChars ?? SANDBOX_LIMITS.maxCodeChars;
    if (code.length > maxCodeChars) {
      return { ok: false, kind: 'invalid', error: `code 有 ${code.length} 个字符,超过上限 ${maxCodeChars}` };
    }

    const target = await resolveTarget(context, args);
    if (target.invalidScope) {
      return { ok: false, kind: 'invalid', error: '无效的 scope' };
    }
    if (target.empty) {
      return { ok: true, scope: target.scope, empty: true, note: NO_SOUND_NOTE };
    }

    const ws = await resolveWorkspace(context);
    const ff = await checkFfmpeg(context, ws);
    if (!ff.ok) {
      return { ok: false, cloudUnavailable: true, error: ff.reason };
    }

    const { sampleRate, mono } = pcmFormat(args, pcmLimits);
    const notes = [];
    const callId = `aj_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const relDir = `audio-js/${callId}`;
    const absDir = ws && typeof ws.resolve === 'function'
      ? ws.resolve(relDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), `pc-audio-js-${callId}-`));
    fs.mkdirSync(absDir, { recursive: true });
    activeDirs.add(absDir);
    const wsDir = ws && typeof ws.dir === 'function' ? ws.dir() : absDir;

    try {
      let budget = limits.maxFetchBytes;
      const fetchedByMediaId = new Map();

      const fetchMediaToLocal = async (media) => {
        if (fetchedByMediaId.has(media.id)) return fetchedByMediaId.get(media.id);
        let read;
        try {
          read = await assets.openRead(context, media.id);
        } catch (error) {
          if (error?.status === 404 || error?.code === 'asset-missing' || error?.message === 'asset-missing') {
            fetchedByMediaId.set(media.id, null);
            return null;
          }
          throw new AudioJsToolError(
            `取素材失败(${scrub(error?.code ?? error?.message ?? error, wsDir).slice(0, 120)})`,
            error?.status === 403 ? 'audio-js-forbidden' : 'media-fetch-failed',
            error?.status === 403 ? 403 : 500,
          );
        }
        const ext = typeof read.assetRef?.ext === 'string' && /^[a-z0-9]{1,8}$/.test(read.assetRef.ext) ? read.assetRef.ext : 'bin';
        const safeId = String(media.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
        const relFile = `${relDir}/${safeId}.${ext}`;
        const absFile = ws && typeof ws.resolve === 'function' ? ws.resolve(relFile) : path.join(absDir, `${safeId}.${ext}`);
        activeStreams.add(read.stream);
        const writer = ws && typeof ws.writer === 'function' ? ws.writer(relFile) : null;
        const fd = !writer ? fs.openSync(absFile, 'w') : null;
        let size = 0;
        let fetchErr = null;
        const timer = setTimeout(() => {
          fetchErr = new AudioJsToolError('取素材超时', 'fetch-timeout');
          read.stream.destroy();
        }, limits.fetchMs);
        timer.unref?.();
        try {
          for await (const chunk of read.stream) {
            if (closing) throw new AudioJsToolError('音频测量已取消', 'cancelled', 499);
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (size > budget) {
              throw new AudioJsToolError('要测的素材太大了,云端一次量不了;请只量其中一段(clipId)。', 'too-large');
            }
            if (writer) writer.write(buf);
            else fs.writeSync(fd, buf);
          }
          if (fetchErr) throw fetchErr;
          if (writer) writer.end();
          else if (fd !== null) fs.closeSync(fd);
        } catch (error) {
          if (writer) writer.abort();
          else if (fd !== null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(absFile, { force: true }); } catch {} }
          read.stream.destroy();
          await read.closed?.catch?.(() => {});
          throw error;
        } finally {
          clearTimeout(timer);
          activeStreams.delete(read.stream);
        }
        await read.closed?.catch?.(() => {});
        budget -= size;
        fetchedByMediaId.set(media.id, absFile);
        return absFile;
      };

      let ffmpegArgs;
      let channels;
      let expected;
      let source;

      if (target.scope === 'clip' || target.scope === 'media') {
        const file = await fetchMediaToLocal(target.media);
        if (!file) return { ok: false, scope: target.scope, kind: 'no-media', error: '素材文件不存在' };
        const n = await probeChannels(context, ws, file, absDir);
        if (!n) return { ok: false, scope: target.scope, kind: 'no-audio', error: '该文件没有音频流' };
        channels = mono ? 1 : Math.min(pcmLimits.maxChannels, n);
        if (!mono && n > pcmLimits.maxChannels) notes.push(`源有 ${n} 个声道,混成了立体声`);
        let win;
        try {
          win = windowOf({
            baseOffset: target.scope === 'clip' ? num(target.offset) ?? 0 : 0,
            baseDuration: target.scope === 'clip' ? num(target.duration) : undefined,
            start: args.start,
            duration: args.duration ?? args.length,
          });
        } catch (error) {
          return { ok: false, scope: target.scope, kind: 'invalid', error: error.message };
        }
        expected = win.duration;
        ffmpegArgs = filePcmArgs({ file, offset: win.offset, duration: win.duration, sampleRate, channels, sourceChannels: n });
        source = { scope: target.scope, start: win.offset, ...(win.duration !== undefined ? { requestedDuration: +win.duration.toFixed(3) } : null) };
      } else {
        const resolvedEntries = [];
        const skipped = [];
        let monoSources = 0;
        for (const e of target.entries) {
          const file = await fetchMediaToLocal(e.media);
          const n = file ? await probeChannels(context, ws, file, absDir) : 0;
          if (!n) {
            skipped.push(e.media?.name || e.clipId || '未知片段');
            continue;
          }
          if (n === 1) monoSources += 1;
          resolvedEntries.push({ ...e, file });
        }
        if (skipped.length) notes.push(`有 ${skipped.length} 段没有音频流或文件不存在,已跳过:${skipped.join('、')}`);
        if (!resolvedEntries.length) return { ok: false, scope: 'timeline', kind: 'no-audio', error: '时间轴上没有能解码的声音' };
        channels = mono ? 1 : 2;
        if (monoSources) notes.push(`混音按导出的做法是立体声:${monoSources} 段单声道素材摊到两个声道,每路低 3 dB(ffmpeg 缺省的中置混音系数)`);
        if (target.withFx?.length) notes.push(`${target.withFx.join('、')} 挂着音频效果,这里测的不含效果`);
        const total = num(target.total) > 0 ? num(target.total) : undefined;
        let win;
        try {
          win = windowOf({ baseOffset: 0, baseDuration: total, start: args.start, duration: args.duration ?? args.length });
        } catch (error) {
          return { ok: false, scope: 'timeline', kind: 'invalid', error: error.message };
        }
        expected = win.duration;
        ffmpegArgs = timelinePcmArgs(resolvedEntries, { total, offset: win.offset, duration: win.duration, sampleRate, channels });
        source = { scope: 'timeline', start: win.offset, ...(win.duration !== undefined ? { requestedDuration: +win.duration.toFixed(3) } : null) };
      }

      const over = sampleBudgetError({ duration: expected, sampleRate, channels }, pcmLimits);
      if (over) return { ok: false, scope: target.scope, kind: 'too-many-samples', error: over };

      const dec = await decodePcmSupervised(context, ws, ffmpegArgs, { channels, sampleRate, cwd: absDir, wsDir });
      if (!dec.ok) {
        return { ok: false, scope: target.scope, kind: dec.kind, error: dec.error };
      }
      const pcm = dec.pcm;
      const frames = pcm[0]?.length ?? 0;
      if (!frames) return { ok: false, scope: target.scope, kind: 'no-audio', error: '解码出来是空的(这一段没有声音样本)' };
      const duration = +(frames / sampleRate).toFixed(6);

      // 进沙箱前重核当前授权
      await authorize(context, 'read');

      const sbOut = await executeInSandbox(context, {
        code,
        channels: pcm,
        sampleRate,
        duration,
        timeoutMs: clampTimeout(args.timeoutMs, sbLimits),
        meta: target.meta ?? {},
        source,
        notes,
      });

      // 出沙箱后重核当前授权
      await authorize(context, 'read');

      return { ...sbOut, scope: target.scope };
    } finally {
      activeDirs.delete(absDir);
      try { fs.rmSync(absDir, { recursive: true, force: true }); } catch {
        say('agent.audio-js.cleanup-failed', { dir: '<temp>' });
      }
    }
  }

  return Object.freeze({
    handles: new Set(AUDIO_JS_TOOL_NAMES),
    call(name, args, context, _options = {}) {
      if (name !== 'measure_audio_js') {
        return Promise.reject(new AudioJsToolError(`音频自定义测量不处理 ${String(name).slice(0, 60)}`, 'unknown-tool'));
      }
      const p = Promise.resolve().then(() => measureAudioJs(context, args ?? {}));
      inFlight.add(p);
      void p.then(() => inFlight.delete(p), () => inFlight.delete(p));
      return p;
    },
    async close(reason = 'close') {
      closing = true;
      for (const s of activeStreams) {
        try { s.destroy(); } catch {}
      }
      for (const ac of activeSandboxAborts) {
        try { ac.abort(); } catch {}
      }
      for (const child of children) {
        try { child.kill(); } catch {}
      }
      if (ownedSandbox) {
        try { await ownedSandbox.close(); } catch {}
      }
      if (injectedSandbox && typeof injectedSandbox.close === 'function') {
        try { await injectedSandbox.close(); } catch {}
      }
      const outcomes = await Promise.allSettled([
        ...[...children].map((c) => c.closed),
        ...inFlight,
      ]);
      for (const dir of activeDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      activeDirs.clear();
      return {
        childrenClosed: outcomes.every((o) => o.status === 'fulfilled') && children.size === 0 && !ownedSandbox?.alive,
        streamsClosed: activeStreams.size === 0,
        workPending: inFlight.size,
        reason,
      };
    },
  });
}
