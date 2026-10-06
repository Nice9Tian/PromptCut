/** 图卡音频按片段本地的采样块取,块协议不变,只是求值搬回了页面里。这个文件刻意是它
 * 唯一的浏览器适配层:图卡音频节点还在算或者算失败时,消费方绝不拿 media.url 顶上。 */
import { opacityAt, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import type { CardDef } from "../kernel/types";
import { cyrb53 } from "../render/cyrb53.mjs";
import { evaluateCardAudio, type AudioSourceContext } from "../render/cards/audioSources";
import { syncedUserCards, onSyncedUserCardsChanged } from "../kernel/registry";
import { onlinePage } from "../online/pageFlag";
import { ONLINE_CARD_AUDIO_BLOCKED, onlineCardAudioRunnable } from "../online/soundPolicy";
import { projectCardGraph, cardJson } from "../kernel/cardGraph.mjs";
import { clipHasEmbeddedAudio, cardAudioIdentity, resolveCardAudioRendition, assertAudiovisualCardKind } from "../kernel/cardAudioRendition.mjs";

export const CARD_AUDIO_SAMPLE_RATE = 48000 as const;
export const CARD_AUDIO_MAX_BLOCK_FRAMES = 1_048_576;
export type CardAudioRequest = { project: unknown; nodeId: string; start: number; count: number; sampleRate: typeof CARD_AUDIO_SAMPLE_RATE };
/** 采样块留在内存:`samples` 是交错(frame-major)的 Float32。`url` 只有租约那条路才有 */
export type CardAudioReply = { samples: Float32Array; url?: string; format: "wav"; sampleRate: number; frames: number; channels: number };
export class CardAudioError extends Error {
  readonly code: "pending" | "invalid-reply" | "request-failed";
  constructor(code: "pending" | "invalid-reply" | "request-failed", message: string) { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ *
 * 定义和源码版本:模块级注入,不逐层传参
 * ------------------------------------------------------------------ */

export interface CardAudioHooks {
  getCard: (id: string) => CardDef<any> | undefined;
  sourceVersionOf: (id: string) => string;
}

let hooks: CardAudioHooks | null = null;
let epoch = 0;
const epochListeners = new Set<() => void>();
onSyncedUserCardsChanged(() => { epoch++; for (const listener of [...epochListeners]) listener(); });

/**
 * `src/cards/index.ts` 加载时调一次(HMR 重跑会再调)。每调一次 `cardAudioEpoch` +1 ——
 * 换卡之后 `project` 引用不变,靠它让预览的 effect 重跑、重新取块。
 */
export function configureCardAudio(next: CardAudioHooks) {
  hooks = next;
  epoch++;
  for (const listener of [...epochListeners]) listener();
}

/** `useSyncExternalStore` 的 getSnapshot */
export function getCardAudioEpoch(): number { return epoch; }

/** `useSyncExternalStore` 的 subscribe */
export function subscribeCardAudioEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => { epochListeners.delete(listener); };
}

export function requireCardAudioHooks(): CardAudioHooks {
  if (!hooks) throw new CardAudioError("request-failed", "card audio hooks not configured");
  return hooks;
}

const projectBlocks = new WeakMap<object, Map<string, Promise<CardAudioReply>>>();
interface CachedClip { promise: Promise<string>; url?: string; refs: number; }
const projectClips = new WeakMap<object, Map<string, CachedClip>>();

/**
 * 缓存键带图卡源码版本:改了图卡源码之后 `project` 对象不变,不带它就一直播旧采样块
 * 和旧 `blob:`。沿 `inputs[*]` 向上游走,只收 `adapter === 'card'` 的节点(素材节点没有源码)。
 */
function versionKeyOf(project: unknown, nodeId: string): string {
  const ready = requireCardAudioHooks();
  const nodes = projectCardGraph(project, ready.getCard).nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>(), cardIds = new Set<string>();
  const walk = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    if (node.adapter === "card" && typeof node.cardId === "string") cardIds.add(node.cardId);
    for (const ref of Object.values(node.inputs ?? {})) {
      // 生节点的 ref 可能是字符串简写(cardGraph.d.mts:11 是 CardInput | string)
      const next = typeof ref === "string" ? ref : (ref as { nodeId?: unknown } | null)?.nodeId;
      if (typeof next === "string") walk(next);
    }
  };
  walk(nodeId);
  const version = requireCardAudioHooks().sourceVersionOf;
  return cyrb53([...cardIds].sort().map((id) => `${id}\u0000${version(id)}`).join("\u0001"));
}

const key = (x: CardAudioRequest) => `${versionKeyOf(x.project, x.nodeId)}:${cyrb53(cardJson(projectCardGraph(x.project, requireCardAudioHooks().getCard)))}:${x.nodeId}:${x.start}:${x.count}:${x.sampleRate}`;
const ownerOf = (project: unknown): object => {
  if (!project || (typeof project !== "object" && typeof project !== "function")) throw new CardAudioError("invalid-reply", "card audio project must be an object");
  return project as object;
};

/** True only for a graph card node explicitly declared as an audio card. */
export function isCardAudioNode(project: Pick<Project, "cardNodes">, nodeId: string | undefined): nodeId is string {
  if (!nodeId) return false;
  const node = project.cardNodes?.find((x) => x.id === nodeId);
  return node?.adapter === "card" && (node.kind === "audio" || node.embeddedAudio === true || typeof hooks?.getCard(node.cardId ?? "")?.audio === "function");
}

export function cardAudioNodeOf(project: Pick<Project, "cardNodes">, clip: Pick<TrackClip, "nodeId"> & Partial<TrackClip>): string | null {
  if (clipHasEmbeddedAudio(project, clip, hooks?.getCard) || syncedUserCards().get(clip.cardId ?? "")?.embeddedAudio) return clip.nodeId ?? `@clip/${clip.id}/card`;
  if (typeof hooks?.getCard(clip.cardId ?? "")?.audio === "function") return clip.nodeId ?? `@clip/${clip.id}/card`;
  return isCardAudioNode(project, clip.nodeId) ? clip.nodeId : null;
}

/**
 * 在线页面:这个音频节点连同它的整条上游,本页能不能合成 —— 全是放开了的卡(第一段:内置卡,`src/online/soundPolicy.ts`)、
 * 一路上没有素材输入(在线页面取不到素材的采样块)。只回答「能不能跑」,轻重另判(`src/editor/io/onlineSoundJudge.ts`)。
 */
export function onlineCardAudioSynthesizable(project: unknown, nodeId: string): boolean {
  const ready = hooks;
  if (!ready || !nodeId) return false;
  let nodes: ReturnType<typeof projectCardGraph>["nodes"];
  try { nodes = projectCardGraph(project, ready.getCard).nodes; } catch { return false; }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const ok = (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    const node = byId.get(id);
    if (!node || node.adapter !== "card" || typeof node.cardId !== "string" || !onlineCardAudioRunnable(ready.getCard(node.cardId))) return false;
    return Object.values(node.inputs ?? {}).every((ref) => {
      const next = typeof ref === "string" ? ref : (ref as { nodeId?: unknown } | null)?.nodeId;
      return typeof next === "string" && ok(next);
    });
  };
  return ok(nodeId);
}

/** A generated node owns a video-backed clip's audio too; callers must mute that native media element. */
export function shouldMuteNativeAudio(project: Project, clip: TrackClip, globallyMuted = false) {
  return globallyMuted || !!clip.audioMuted || !!cardAudioNodeOf(project, clip);
}

/** Active generated audio is independent of whether its source happened to be an audio asset, video, or no media asset. */
export function generatedCardAudioClipsAt(project: Project, t: number): { clip: TrackClip; media?: MediaAsset; volume: number }[] {
  const out: { clip: TrackClip; media?: MediaAsset; volume: number }[] = [];
  // 在线浏览器模式:图卡(含音频图卡)在这台设备上渲染不了(C10 契约第 9 节,常驻「需要本地 PC 渲染辅助」),
  // 不求值、不发 `/@media/<hash>/pcm` 请求;这一段的原生声音照旧被 `shouldMuteNativeAudio` 静掉,不拿素材声音顶上
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

/**
 * 页内求值:找到节点 → 注册表里的定义 → `audio(sources, { start, count, sampleRate }, params)`。
 * `fetchImpl` 保留在签名里只为不动消费方(`renderMix.ts:61` 还按老样子传),块本身不再走 HTTP。
 */
export async function requestCardAudio(x: CardAudioRequest, signal?: AbortSignal, _fetchImpl: typeof fetch = fetch): Promise<CardAudioReply> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (!Number.isSafeInteger(x.start) || !Number.isSafeInteger(x.count) || x.count < 1 || x.count > CARD_AUDIO_MAX_BLOCK_FRAMES) throw new CardAudioError("invalid-reply", `audio range must be 1…${CARD_AUDIO_MAX_BLOCK_FRAMES} samples`);
  if (onlinePage() && !onlineCardAudioSynthesizable(x.project, x.nodeId)) throw new CardAudioError("request-failed", ONLINE_CARD_AUDIO_BLOCKED);
  const ready = requireCardAudioHooks();
  const owner = ownerOf(x.project), k = key(x), blocks = projectBlocks.get(owner) ?? new Map<string, Promise<CardAudioReply>>();
  projectBlocks.set(owner, blocks);
  let pending = blocks.get(k);
  if (!pending) {
    const context: AudioSourceContext = {
      graph: projectCardGraph(x.project, ready.getCard),
      project: x.project as Pick<Project, "tracks" | "media">,
      getCard: ready.getCard,
      sampleRate: x.sampleRate,
    };
    pending = (async () => {
      const samples = await evaluateCardAudio(context, x.nodeId, { start: x.start, count: x.count, sampleRate: x.sampleRate });
      const channels = samples.length / x.count;
      if (!Number.isInteger(channels) || channels < 1) throw new CardAudioError("invalid-reply", "invalid card audio descriptor");
      const reply: CardAudioReply = { samples, format: "wav", sampleRate: x.sampleRate, frames: x.count, channels };
      // 带 url 的回包(只有租约那条路会有)照旧查同源
      if (reply.url && !isSameOriginOrBlob(reply.url)) throw new CardAudioError("invalid-reply", "invalid card audio descriptor");
      return reply;
    })();
    blocks.set(k, pending); pending.catch(() => blocks.delete(k));
  }
  const reply = await pending;
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  return reply;
}

export interface CardAudioClip { project: unknown; nodeId: string; frames: number; sampleRate?: typeof CARD_AUDIO_SAMPLE_RATE; }

/** Evaluate bounded blocks in page and concatenate them exactly to the requested local range. */
export async function decodeCardAudioClip(ctx: BaseAudioContext, clip: CardAudioClip, fetchImpl: typeof fetch = fetch): Promise<AudioBuffer> {
  const sampleRate = clip.sampleRate ?? CARD_AUDIO_SAMPLE_RATE;
  if (!Number.isSafeInteger(clip.frames) || clip.frames < 1) throw new CardAudioError("invalid-reply", "card audio clip has invalid frame count");
  const requests: CardAudioRequest[] = [], replies: CardAudioReply[] = [];
  for (let start = 0; start < clip.frames; start += CARD_AUDIO_MAX_BLOCK_FRAMES) {
    const request: CardAudioRequest = { project: clip.project, nodeId: clip.nodeId, start, count: Math.min(CARD_AUDIO_MAX_BLOCK_FRAMES, clip.frames - start), sampleRate };
    requests.push(request);
    replies.push(await requestCardAudio(request, undefined, fetchImpl));
  }
  const channels = Math.max(...replies.map((reply) => reply.channels));
  const output = ctx.createBuffer(channels, clip.frames, sampleRate);
  let at = 0;
  for (const reply of replies) {
    if (reply.samples.length !== reply.frames * reply.channels) throw new CardAudioError("invalid-reply", `card audio block is ${reply.samples.length} samples, expected ${reply.frames} × ${reply.channels}`);
    for (let channel = 0; channel < channels; channel++) {
      const data = output.getChannelData(channel), source = Math.min(channel, reply.channels - 1);
      for (let frame = 0; frame < reply.frames; frame++) data[at + frame] = reply.samples[frame * reply.channels + source];
    }
    at += reply.frames;
  }
  // 拼完整条删掉:一块立体声 1_048_576 × 2 × 4 = 8 MB,不删就在 project 存活期内常驻。
  // 只摘 samples 字段不行 —— 留一份没有 samples 的回包会让下一次拿到空块。
  const blocks = projectBlocks.get(ownerOf(clip.project));
  if (blocks) for (const request of requests) blocks.delete(key(request));
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

/** Preview's <audio> needs one seekable URL, so join blocks into one local WAV once per source version + node + duration. */
export interface CardAudioLease { url: string; release(): void; }
export async function acquireCardAudioClipUrl(clip: CardAudioClip): Promise<CardAudioLease> {
  const owner = ownerOf(clip.project), sampleRate = clip.sampleRate ?? CARD_AUDIO_SAMPLE_RATE, k = `${versionKeyOf(clip.project, clip.nodeId)}:${clip.nodeId}:${clip.frames}:${sampleRate}`;
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

/** Use when a complete project preview is discarded; revokes object URLs and drops retained sample blocks. */
export function disposeProjectCardAudio(project: unknown) {
  const owner = ownerOf(project);
  projectBlocks.get(owner)?.clear();
  const urls = projectClips.get(owner); if (!urls) return;
  for (const cached of urls.values()) if (cached.url) URL.revokeObjectURL(cached.url);
  urls.clear();
}
export function clearCardAudioCache() { /* retained API; per-project disposal is explicit. */ }

/** 校验持久声音。在线端只取 WAV，不执行用户卡 audio()。 */
export function persistentCardAudio(project: Project, clip: TrackClip) {
  return resolveCardAudioRendition(project, clip, { getCard: hooks?.getCard,
    sourceVersionOf: (id) => onlinePage() && syncedUserCards().get(id)?.audioSourceVersion
      ? syncedUserCards().get(id)!.audioSourceVersion
      : hooks?.getCard(id) ? hooks.sourceVersionOf(id) : syncedUserCards().get(id)?.audioSourceVersion });
}
export function assertProjectCardAudio(project: Project) {
  for (const track of project.tracks) for (const clip of track.clips) {
    if (track.hidden || track.muted || clip.audioMuted || !(clipHasEmbeddedAudio(project, clip, hooks?.getCard) || syncedUserCards().get(clip.cardId)?.embeddedAudio)) continue;
    persistentCardAudio(project, clip);
  }
}

/** 复用已有 audio() 采样管线，逐小块让出页面。只在明确生成动作运行，预览从不自动重生成。 */
export async function renderEmbeddedCardWav(project: Project, clip: TrackClip, signal: AbortSignal,
  onProgress?: (done: number, total: number) => void): Promise<{ wav: Uint8Array; channels: number; frames: number }> {
  const ready = requireCardAudioHooks(), nodeId = cardAudioNodeOf(project, clip);
  if (onlinePage() && !(nodeId && onlineCardAudioSynthesizable(project, nodeId))) throw new Error(ONLINE_CARD_AUDIO_BLOCKED);
  if (!nodeId || !clipHasEmbeddedAudio(project, clip, ready.getCard)) throw new Error("这张卡没有内嵌声音");
  assertAudiovisualCardKind(ready.getCard(clip.cardId));
  cardAudioIdentity(project, clip, ready);
  const frames = Math.round((clip.end - clip.start) * CARD_AUDIO_SAMPLE_RATE);
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 60 * CARD_AUDIO_SAMPLE_RATE) throw new Error("卡片声音生成范围必须在 1 个采样至 60 秒内");
  let channels = 0, output: Uint8Array | undefined, view: DataView | undefined;
  const context: AudioSourceContext = { graph: projectCardGraph(project, ready.getCard), project, getCard: ready.getCard, sampleRate: CARD_AUDIO_SAMPLE_RATE, signal };
  for (let start = 0; start < frames; start += 8192) {
    signal.throwIfAborted();
    const count = Math.min(8192, frames - start);
    const samples = await evaluateCardAudio(context, nodeId, { start, count, sampleRate: CARD_AUDIO_SAMPLE_RATE });
    const blockChannels = samples.length / count;
    if (!channels) {
      channels = blockChannels;
      output = new Uint8Array(44 + frames * channels * 4); view = new DataView(output.buffer);
      const put = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view!.setUint8(at + i, text.charCodeAt(i)); };
      put(0, "RIFF"); view.setUint32(4, output.byteLength - 8, true); put(8, "WAVE"); put(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
      view.setUint32(24, CARD_AUDIO_SAMPLE_RATE, true); view.setUint32(28, CARD_AUDIO_SAMPLE_RATE * channels * 4, true);
      view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); put(36, "data"); view.setUint32(40, frames * channels * 4, true);
    } else if (blockChannels !== channels) throw new Error("卡片声音的声道数不能在生成途中改变");
    for (let i = 0; i < samples.length; i++) view!.setFloat32(44 + (start * channels + i) * 4, samples[i], true);
    onProgress?.(start + count, frames);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return { wav: output!, frames, channels };
}
