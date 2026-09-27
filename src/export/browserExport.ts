/**
 * 低内存档逐帧导出(`docs/plan/c10a-contract.md` 第 11.1 节;语义 `product/platforms.md`「面向的平台」的「导出」)。
 *
 *   能力探测 → (没有 AAC 就先问一次)→ 导出前核对(素材原尺寸 complete、重卡的预渲染原尺寸齐全;不设超时,可取消)
 *   → 提示保持前台 → 混音并编 AAC → 逐帧:合成一帧到复用的原尺寸画布 → `VideoEncoder.encode()` → `frame.close()`
 *   (`encodeQueueSize` 不超过 3)→ 封装(`mp4Mux.ts`)写出。
 *
 * 时间按帧号定(`i / fps`,导出页的钉时间办法同 `src/kernel/exportClock.ts`)。导出只用原尺寸:素材原尺寸(导出页按原片地址、
 * Range 取)、重卡的预渲染原尺寸(`originals.ts`);小尺寸在这里一张都不用。
 *
 * 这一层不认识编辑器:项目、素材服务、文档服务、提示、确认都由调用方(`src/editor/io/index.ts` 的 `exportVideo` 在线分支)注入。
 */
import type { Project } from "../kernel/project";
import { audioPlanOf } from "../kernel/audioPlan.mjs";
import { renderMix, encodeWavFloat32, type MixPlan } from "../audio/renderMix";
import { awaitingUploaderMessage, type MissingOriginal } from "../render/mediaTier";
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, audioConfigOf, probeExportCapability, videoConfigOf, type EncoderEnv } from "./capability";
import { Mp4Muxer, type MuxSink } from "./mp4Mux";
import { ExportCompositor } from "./frameCompositor";
import { fetchOriginalHtml, loadOriginalsIndex, type OriginalsDeps, type OriginalsIndex } from "./originals";
import { ONLINE_EXPORT_TEXT } from "./text";

/** 编码队列上限(契约第 11.1 节) */
export const MAX_ENCODE_QUEUE = 3;
/** 关键帧间隔(秒) */
export const KEYFRAME_SEC = 2;
/** 导出前核对没过时,多久再核一次 */
export const PRECHECK_RETRY_MS = 3000;

export interface BrowserExportDeps {
  project: Project;
  sink: MuxSink;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** 导出前核对没过:给用户看的话(null = 过了) */
  onWaiting?: (message: string | null) => void;
  confirm: (message: string) => boolean | Promise<boolean>;
  notify: (message: string, tone?: "info" | "warn") => void;
  /** 被引用的素材原尺寸里还没 complete 的(C6.6 的 `exportGate`) */
  checkMediaOriginals: () => Promise<MissingOriginal[]>;
  /** 文档服务与素材服务;null = 不取预渲染原尺寸(重卡照活渲;只给探针与桌面对照) */
  originals: OriginalsDeps | null;
  /** 还没有层表时,页面自己判重的片段 */
  fallbackHeavy?: () => string[];
  /** 素材原尺寸的地址:在线页面换成远程素材服务 + 只读票据(`mediaTier.ts` 的 `remoteMediaUrl`) */
  mediaUrl?: (url: string) => string;
  /** 导出页地址(缺省按当前页面拼) */
  exportUrl?: string;
  env?: EncoderEnv;
  /** 探针:只导前 n 帧 */
  maxFrames?: number;
}

export interface BrowserExportResult {
  frames: number;
  bytes: number;
  audio: boolean;
  videoCodec: string;
  ms: number;
  stats: Record<string, number>;
}

const cancelled = () => Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(cancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 导出前核对:两样都齐才往下走;不齐就提示、隔一会儿再核,不设超时(用户可以取消) */
async function precheck(deps: BrowserExportDeps): Promise<OriginalsIndex | null> {
  for (;;) {
    if (deps.signal.aborted) throw cancelled();
    const media = await deps.checkMediaOriginals();
    let index: OriginalsIndex | null = null;
    if (deps.originals) index = await loadOriginalsIndex(deps.project.id || null, deps.originals, { fallbackHeavy: deps.fallbackHeavy?.() ?? [] });
    const parts: string[] = [];
    if (media.length) parts.push(awaitingUploaderMessage(media));
    if (index?.missing.length) parts.push(ONLINE_EXPORT_TEXT.missingOriginals(index.missing.length));
    if (!parts.length) { deps.onWaiting?.(null); return index; }
    deps.onWaiting?.(parts.join("\n"));
    await sleep(PRECHECK_RETRY_MS, deps.signal);
  }
}

/* ---------------- 音频 ---------------- */

interface EncodedAudio { chunks: { data: Uint8Array; timestampUs: number; durationUs: number }[]; asc: Uint8Array }

/** 一段素材原尺寸按时间轴裁出来的那一截 → 48 kHz 立体声浮点 WAV(给 `renderMix` 当「裁好的 wav」) */
async function sliceWav(url: string, offset: number, dur: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`取不到声音 ${res.status}`);
  const ctx = new OfflineAudioContext(AUDIO_CHANNELS, 1, AUDIO_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
  const from = Math.max(0, Math.floor(offset * AUDIO_SAMPLE_RATE));
  const n = Math.max(1, Math.ceil(dur * AUDIO_SAMPLE_RATE));
  const chans = Array.from({ length: AUDIO_CHANNELS }, (_, c) => {
    const src = decoded.getChannelData(Math.min(c, decoded.numberOfChannels - 1));
    const out = new Float32Array(n);
    out.set(src.subarray(from, Math.min(src.length, from + n)));
    return out;
  });
  return encodeWavFloat32({ numberOfChannels: AUDIO_CHANNELS, length: n, sampleRate: AUDIO_SAMPLE_RATE, getChannelData: (c: number) => chans[c] } as unknown as AudioBuffer);
}

async function encodeAudio(deps: BrowserExportDeps, durationSec: number): Promise<EncodedAudio | null> {
  const project = deps.project;
  const entries = audioPlanOf(project).filter((e: { start: number }) => e.start < durationSec);
  if (!entries.length) return null;
  const byId = new Map(project.media.map((m) => [m.id, m]));
  const slices = new Map<string, { url: string; offset: number; dur: number }>();
  const plan: MixPlan = {
    sampleRate: AUDIO_SAMPLE_RATE,
    duration: durationSec,
    clips: entries.map((e: { clipId: string; mediaId: string; start: number; dur: number; offset: number; volume: number; fadeIn: number; fadeOut: number; fx: MixPlan["clips"][number]["fx"] }, i: number) => {
      const m = byId.get(e.mediaId)!;
      const key = `pc-slice:${i}`;
      slices.set(key, { url: deps.mediaUrl ? deps.mediaUrl(m.url) : m.url, offset: e.offset, dur: e.dur });
      return { clipId: e.clipId, url: key, start: e.start, dur: e.dur, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx };
    }),
  };
  const fetchSlice = (async (input: RequestInfo | URL) => {
    const s = slices.get(String(input));
    if (!s) throw new Error(`不认识的声音 ${String(input)}`);
    return new Response(await sliceWav(s.url, s.offset, s.dur, deps.signal));
  }) as typeof fetch;
  const { buffer } = await renderMix(plan, fetchSlice);
  if (deps.signal.aborted) throw cancelled();

  const chunks: EncodedAudio["chunks"] = [];
  let asc: Uint8Array | null = null;
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? (1024 * 1e6) / AUDIO_SAMPLE_RATE });
      const d = meta?.decoderConfig?.description;
      if (d && !asc) asc = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(audioConfigOf() as unknown as AudioEncoderConfig);
  const FRAMES = 4096;
  const planes = Array.from({ length: AUDIO_CHANNELS }, (_, c) => buffer.getChannelData(c));
  for (let at = 0; at < buffer.length; at += FRAMES) {
    if (deps.signal.aborted) { encoder.close(); throw cancelled(); }
    const n = Math.min(FRAMES, buffer.length - at);
    const data = new Float32Array(n * AUDIO_CHANNELS);
    for (let c = 0; c < AUDIO_CHANNELS; c++) data.set(planes[c].subarray(at, at + n), c * n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: AUDIO_SAMPLE_RATE, numberOfFrames: n, numberOfChannels: AUDIO_CHANNELS, timestamp: Math.round((at * 1e6) / AUDIO_SAMPLE_RATE), data });
    encoder.encode(ad);
    ad.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!asc) throw new Error("AAC 编码器没给出 AudioSpecificConfig");
  return { chunks, asc };
}

/* ---------------- 主流程 ---------------- */

export async function runBrowserExport(deps: BrowserExportDeps): Promise<BrowserExportResult> {
  const t0 = performance.now();
  const project = deps.project;
  const fps = Math.max(1, project.fps || 30);
  const total = Math.max(1, Math.min(deps.maxFrames ?? Infinity, Math.floor(project.duration * fps)));
  const durationSec = total / fps;

  const cap = await probeExportCapability({ width: project.width, height: project.height, fps }, deps.env);
  if (!cap.ok || !cap.videoCodec) throw new Error(cap.message || ONLINE_EXPORT_TEXT.unsupportedSize);
  const wantsAudio = audioPlanOf(project).some((e: { start: number }) => e.start < durationSec);
  if (wantsAudio && !cap.audio && !(await deps.confirm(ONLINE_EXPORT_TEXT.noAudio))) throw cancelled();

  const index = await precheck(deps);
  deps.notify(ONLINE_EXPORT_TEXT.start, "info");

  const audio = wantsAudio && cap.audio ? await encodeAudio(deps, durationSec) : null;

  // 重卡的原尺寸:当前这一帧要用时才取,不攒
  const originals = deps.originals && index?.map ? {
    htmlFor: async (clipId: string, frame: number) => {
      const hash = index.hashAt(clipId, frame);
      if (hash === undefined) return undefined;
      if (hash === null) throw new Error(ONLINE_EXPORT_TEXT.missingOriginals(1));
      return fetchOriginalHtml(hash, deps.originals!, deps.signal);
    },
  } : null;

  const exportProject: Project = deps.mediaUrl
    ? { ...project, media: project.media.map((m) => ({ ...m, url: m.url ? deps.mediaUrl!(m.url) : m.url })) }
    : project;
  const compositor = await ExportCompositor.open({ project: exportProject, exportUrl: deps.exportUrl, originals, signal: deps.signal });

  let muxer: Mp4Muxer | null = null;
  let failure: unknown = null;
  const pendingVideo: { data: Uint8Array; timestampUs: number; key: boolean }[] = [];
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (!muxer) {
        const d = meta?.decoderConfig?.description;
        if (!d) { pendingVideo.push({ data, timestampUs: chunk.timestamp, key: chunk.type === "key" }); return; }
        const avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
        muxer = new Mp4Muxer({
          sink: deps.sink,
          video: { codec: cap.videoCodec!, width: project.width, height: project.height, fps, avcC },
          audio: audio ? { codec: "mp4a.40.2", sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS, asc: audio.asc } : null,
        });
        // 音频先写(块小、已经编好了):mdat 里音频在前、视频在后,偏移表各记各的
        for (const a of audio?.chunks ?? []) muxer.addAudioChunk(a.data, { timestampUs: a.timestampUs, durationUs: a.durationUs });
        for (const v of pendingVideo.splice(0)) muxer.addVideoChunk(v.data, { timestampUs: v.timestampUs, key: v.key });
      }
      muxer.addVideoChunk(data, { timestampUs: chunk.timestamp, key: chunk.type === "key" });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(videoConfigOf(cap.videoCodec, project.width, project.height, fps) as unknown as VideoEncoderConfig);

  const waitQueue = async () => {
    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE - 1) {
      await new Promise<void>((resolve) => {
        const done = () => { encoder.removeEventListener("dequeue", done); resolve(); };
        encoder.addEventListener("dequeue", done);
        setTimeout(done, 50);
      });
      if (failure) throw failure;
    }
  };

  try {
    const keyEvery = Math.max(1, Math.round(KEYFRAME_SEC * fps));
    for (let i = 0; i < total; i++) {
      if (deps.signal.aborted) throw cancelled();
      if (failure) throw failure;
      const canvas = await compositor.frame(i);
      await waitQueue();
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      try { encoder.encode(frame, { keyFrame: i % keyEvery === 0 }); } finally { frame.close(); }
      deps.onProgress?.(i + 1, total);
    }
    await encoder.flush();
    if (failure) throw failure;
    if (!muxer) throw new Error("编码器一帧都没给出");
    const bytes = await (muxer as Mp4Muxer).finalize();
    return { frames: total, bytes, audio: !!audio, videoCodec: cap.videoCodec, ms: performance.now() - t0, stats: { ...compositor.stats } };
  } finally {
    try { if (encoder.state !== "closed") encoder.close(); } catch { /* 已经关了 */ }
    compositor.close();
  }
}
