/** Python card audio is requested in bounded, clip-local sample blocks.  This file is
 * deliberately the only browser adapter for it: consumers never substitute media.url
 * when a card audio node is pending or fails. */
import { opacityAt, type MediaAsset, type Project, type TrackClip } from "../kernel/project";

export const CARD_AUDIO_SAMPLE_RATE = 48000 as const;
export const CARD_AUDIO_MAX_BLOCK_FRAMES = 1_048_576;
export type CardAudioRequest = { project: unknown; nodeId: string; start: number; count: number; sampleRate: typeof CARD_AUDIO_SAMPLE_RATE };
export type CardAudioReply = { url: string; format: "wav"; sampleRate: number; frames: number; channels: number };
export class CardAudioError extends Error {
  constructor(public readonly code: "pending" | "invalid-reply" | "request-failed", message: string) { super(message); }
}

const projectBlocks = new WeakMap<object, Map<string, Promise<CardAudioReply>>>();
interface CachedClip { promise: Promise<string>; url?: string; refs: number; }
const projectClips = new WeakMap<object, Map<string, CachedClip>>();
const key = (x: CardAudioRequest) => `${String((x.project as { cardRuntimeRevision?: unknown }).cardRuntimeRevision ?? "")}:${x.nodeId}:${x.start}:${x.count}:${x.sampleRate}`;
const ownerOf = (project: unknown): object => {
  if (!project || (typeof project !== "object" && typeof project !== "function")) throw new CardAudioError("invalid-reply", "card audio project must be an object");
  return project as object;
};

/** True only for a Python definition explicitly declared as an audio card. */
export function isPythonAudioNode(project: Pick<Project, "cardNodes" | "cardDefinitions">, nodeId: string | undefined): nodeId is string {
  if (!nodeId) return false;
  const node = project.cardNodes?.find((x) => x.id === nodeId);
  const definition = node?.definitionId ? project.cardDefinitions?.find((x) => x.id === node.definitionId) : undefined;
  return node?.adapter === "python" && definition?.language === "python" && definition.kind === "audio";
}

export function cardAudioNodeOf(project: Pick<Project, "cardNodes" | "cardDefinitions">, clip: Pick<TrackClip, "nodeId">): string | null {
  return isPythonAudioNode(project, clip.nodeId) ? clip.nodeId : null;
}

/** A generated node owns a video-backed clip's audio too; callers must mute that native media element. */
export function shouldMuteNativeAudio(project: Project, clip: TrackClip, globallyMuted = false) {
  return globallyMuted || !!clip.audioMuted || !!cardAudioNodeOf(project, clip);
}

/** Active generated audio is independent of whether its source happened to be an audio asset, video, or no media asset. */
export function generatedCardAudioClipsAt(project: Project, t: number): { clip: TrackClip; media?: MediaAsset; volume: number }[] {
  const out: { clip: TrackClip; media?: MediaAsset; volume: number }[] = [];
  for (const track of project.tracks) for (const clip of track.clips) {
    if (track.hidden || track.muted || clip.audioMuted || !cardAudioNodeOf(project, clip) || t < clip.start || t >= clip.end) continue;
    out.push({ clip, media: clip.mediaId ? project.media.find(m => m.id === clip.mediaId) : undefined, volume: opacityAt(clip, t) * (clip.audioVolume ?? 1) });
  }
  return out;
}

function isSameOriginOrBlob(url: string): boolean {
  if (url.startsWith("/")) return true;
  if (url.startsWith("blob:")) return true;
  try { return typeof location !== "undefined" && new URL(url, location.href).origin === location.origin; } catch { return false; }
}

export async function requestCardAudio(x: CardAudioRequest, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<CardAudioReply> {
  if (!Number.isSafeInteger(x.start) || !Number.isSafeInteger(x.count) || x.count < 1 || x.count > CARD_AUDIO_MAX_BLOCK_FRAMES) throw new CardAudioError("invalid-reply", `audio range must be 1…${CARD_AUDIO_MAX_BLOCK_FRAMES} samples`);
  const owner = ownerOf(x.project), k = key(x), blocks = projectBlocks.get(owner) ?? new Map<string, Promise<CardAudioReply>>();
  projectBlocks.set(owner, blocks);
  let pending = blocks.get(k);
  if (!pending) {
    pending = fetchImpl("/api/card-runtime/audio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(x), signal }).then(async (response) => {
      if (!response.ok) throw new CardAudioError("request-failed", `card audio request failed (${response.status})`);
      const reply = await response.json() as CardAudioReply;
      if (!isSameOriginOrBlob(reply.url) || reply.format !== "wav" || reply.sampleRate !== x.sampleRate || reply.frames !== x.count || !Number.isInteger(reply.channels) || reply.channels < 1) throw new CardAudioError("invalid-reply", "invalid card audio descriptor");
      return reply;
    });
    blocks.set(k, pending); pending.catch(() => blocks.delete(k));
  }
  return pending;
}

export interface CardAudioClip { project: unknown; nodeId: string; frames: number; sampleRate?: typeof CARD_AUDIO_SAMPLE_RATE; }

async function decode(ctx: BaseAudioContext, url: string, fetchImpl: typeof fetch): Promise<AudioBuffer> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new CardAudioError("request-failed", `card audio WAV fetch failed (${response.status})`);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

/** Decode bounded server blocks and concatenate them exactly to the requested local range. */
export async function decodeCardAudioClip(ctx: BaseAudioContext, clip: CardAudioClip, fetchImpl: typeof fetch = fetch): Promise<AudioBuffer> {
  const sampleRate = clip.sampleRate ?? CARD_AUDIO_SAMPLE_RATE;
  if (!Number.isSafeInteger(clip.frames) || clip.frames < 1) throw new CardAudioError("invalid-reply", "card audio clip has invalid frame count");
  const replies: CardAudioReply[] = [];
  for (let start = 0; start < clip.frames; start += CARD_AUDIO_MAX_BLOCK_FRAMES) replies.push(await requestCardAudio({ project: clip.project, nodeId: clip.nodeId, start, count: Math.min(CARD_AUDIO_MAX_BLOCK_FRAMES, clip.frames - start), sampleRate }, undefined, fetchImpl));
  const decoded = await Promise.all(replies.map((reply) => decode(ctx, reply.url, fetchImpl)));
  const channels = Math.max(...decoded.map((buffer) => buffer.numberOfChannels));
  const output = ctx.createBuffer(channels, clip.frames, sampleRate);
  let at = 0;
  for (let i = 0; i < decoded.length; i++) {
    const input = decoded[i], expected = replies[i].frames;
    if (input.sampleRate !== sampleRate || input.length !== expected || input.numberOfChannels !== replies[i].channels) throw new CardAudioError("invalid-reply", `card audio block ${i} decoded to ${input.length} frames / ${input.numberOfChannels} channels, expected ${expected} / ${replies[i].channels}`);
    for (let channel = 0; channel < channels; channel++) output.getChannelData(channel).set(input.getChannelData(Math.min(channel, input.numberOfChannels - 1)), at);
    at += input.length;
  }
  return output;
}

function wavOf(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels, bytes = buffer.length * channels * 4, raw = new ArrayBuffer(44 + bytes), view = new DataView(raw);
  const put = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  put(0, "RIFF"); view.setUint32(4, 36 + bytes, true); put(8, "WAVE"); put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 4, true); view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); put(36, "data"); view.setUint32(40, bytes, true);
  const interleaved = new Float32Array(raw, 44, buffer.length * channels);
  for (let frame = 0; frame < buffer.length; frame++) for (let channel = 0; channel < channels; channel++) interleaved[frame * channels + channel] = buffer.getChannelData(channel)[frame];
  return new Blob([raw], { type: "audio/wav" });
}

/** Preview's <audio> needs one seekable URL, so join server blocks into one local WAV once per project revision + node + duration. */
export interface CardAudioLease { url: string; release(): void; }
export async function acquireCardAudioClipUrl(clip: CardAudioClip): Promise<CardAudioLease> {
  const owner = ownerOf(clip.project), sampleRate = clip.sampleRate ?? CARD_AUDIO_SAMPLE_RATE, k = `${String((clip.project as { cardRuntimeRevision?: unknown }).cardRuntimeRevision ?? "")}:${clip.nodeId}:${clip.frames}:${sampleRate}`;
  const urls = projectClips.get(owner) ?? new Map<string, CachedClip>(); projectClips.set(owner, urls);
  let cached = urls.get(k);
  if (!cached) {
    cached = { refs: 0, promise: (async () => { const context = new AudioContext({ sampleRate }); try { return URL.createObjectURL(wavOf(await decodeCardAudioClip(context, { ...clip, sampleRate }))); } finally { await context.close(); } })() };
    urls.set(k, cached); cached.promise.then(url => { cached!.url = url; }, () => urls.delete(k));
  }
  const url = await cached.promise; cached.refs++;
  let released = false;
  return { url, release() { if (released) return; released = true; if (--cached!.refs === 0 && cached!.url) { URL.revokeObjectURL(cached!.url); urls.delete(k); } } };
}

/** Use when a complete project preview is discarded; revokes object URLs immediately. */
export function disposeProjectCardAudio(project: unknown) {
  const urls = projectClips.get(ownerOf(project)); if (!urls) return;
  for (const cached of urls.values()) if (cached.url) URL.revokeObjectURL(cached.url);
  urls.clear();
}
export function clearCardAudioCache() { /* retained API; per-project disposal is explicit. */ }
