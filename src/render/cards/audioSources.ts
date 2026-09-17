/**
 * 音频图卡的输入取样 —— `sources[name].block(start, count)` 的实现,以及一个节点的
 * `audio()` 求值。视觉那条路(`at()` / `pixels()`)由 `GraphCard.tsx` 自己给,这里只管声音。
 *
 * ## 导出的接口
 *
 * ```ts
 * blockOf(ctx, ref, start, count): Promise<Float32Array>
 * ```
 *
 * - `ctx: AudioSourceContext`
 *   - `graph` —— 节点表。可以是 `project.cardNodes`(生节点),也可以是
 *     `projectCardGraph()` 的返回值(`{ nodes }`);两种都认。
 *   - `project` —— 只用来按 **片段 id** 找素材:素材输入 `@clip/<id>/source` 在生
 *     `cardNodes` 里没有节点,得回片段上取 `mediaId`(→ 内容哈希)和 `mediaOffset`。
 *   - `getCard(id)` —— 卡片注册表(`src/kernel/registry`)。
 *   - `sampleRate` —— 本次求值的采样率(48000)。
 * - `ref: AudioSourceRef` —— **解析过的**输入:`{ nodeId }`(图卡节点)或 `{ clipId }`
 *   (素材片段),都可以带边上的 `offset`(秒)/ `rate`(播放速率)。
 * - 返回 **交错**(frame-major)的 `Float32Array`,长度 = `count × 声道数`,和
 *   `cardAudio.ts` 的 `wavOf` 同一口径。
 *
 * 另外导出 `audioSourcesOf(ctx, node)`(给一个节点拼 `sources`)、
 * `evaluateCardAudio(ctx, nodeId, range)`(找节点 → 定义 → `audio()`)、
 * `paramsOfAudioNode(ctx, node)`(H2 的「实例参数」口径)和 `clearAudioBlockCache()`。
 *
 * ## 为什么素材要走服务端
 *
 * 浏览器里不解整份素材文件(`renderMix.ts:9-10`:10 分钟 4K 视频就是 1 GB)。素材输入
 * 改走 `GET /@media/<hash>/pcm`(`server/vite-plugin-media.ts`),由 ffmpeg 按采样区间裁。
 * 路由没有 `offset` 参数:`clip.mediaOffset + 边.offset` 在页面里折算一次,折进 `start`。
 * 回来的字节直接当 `Float32Array` 读,**不经 `decodeAudioData`、不需要任何 `AudioContext`**
 * —— `requestCardAudio` 拿不到调用方的 context,自建一个默认 44100 Hz 的会让音高和长度全错。
 */
import type { CardDef } from "../../kernel/types";
import type { MediaAsset, Project, TrackClip } from "../../kernel/project";
import type { CardNode } from "../../kernel/cardGraph.mjs";

/** 一路输入解析后的样子。`offset` 是秒,`rate` 是播放速率(第一版只支持 1) */
export type AudioSourceRef =
  | { nodeId: string; clipId?: undefined; offset?: number; rate?: number }
  | { clipId: string; nodeId?: undefined; offset?: number; rate?: number };

export interface AudioSourceContext {
  /** `project.cardNodes`,或 `projectCardGraph()` 的返回值 */
  graph: CardNode[] | { nodes: CardNode[] } | undefined;
  /** 片段 / 素材查表用 */
  project: Pick<Project, "tracks" | "media">;
  getCard: (id: string) => CardDef<any> | undefined;
  sampleRate: number;
}

/** 声道恒定 2:路由固定 `ch=2`,和 `card-service.mjs` 那条老路一致 */
export const MEDIA_PCM_CHANNELS = 2;
/** 页面侧的块缓存上限(一块立体声 48 kHz 一秒 ≈ 384 KB) */
export const AUDIO_BLOCK_CACHE_LIMIT = 32;

const fail = (message: string): never => { throw new Error(`Card audio: ${message}`); };

function nodesOf(graph: AudioSourceContext["graph"]): CardNode[] {
  if (!graph) return [];
  return Array.isArray(graph) ? graph : (graph.nodes ?? []);
}

function nodeOf(ctx: AudioSourceContext, id: string): CardNode | undefined {
  return nodesOf(ctx.graph).find((node) => node.id === id);
}

function clipOf(project: Pick<Project, "tracks">, clipId: string): TrackClip | undefined {
  for (const track of project.tracks ?? []) for (const clip of track.clips ?? []) if (clip.id === clipId) return clip;
  return undefined;
}

/** 片段 id 从 `@clip/<id>/source` 里取回来(节点 id 的写法见 cardGraph.mjs:121) */
const CLIP_SOURCE = /^@clip\/(.+)\/source$/;

/**
 * 把一条 `inputs[name]` 解析成 `blockOf` 认的引用。生 `cardNodes` 里没有
 * `@clip/<id>/source` 这种节点,所以它被翻成 `{ clipId }`;其余按 `{ nodeId }`。
 */
export function resolveAudioRef(ctx: AudioSourceContext, input: unknown): AudioSourceRef {
  const raw = typeof input === "string" ? { nodeId: input } : (input ?? {}) as { nodeId?: string; offset?: number; rate?: number };
  const nodeId = raw.nodeId;
  if (typeof nodeId !== "string" || !nodeId) fail("input must reference a node");
  const offset = raw.offset ?? 0, rate = raw.rate ?? 1;
  const clipSource = CLIP_SOURCE.exec(nodeId!);
  // 图里已经合成过这个节点时(projectCardGraph 的返回值)照 nodeId 走,没有才回片段上找
  if (clipSource && !nodeOf(ctx, nodeId!)) return { clipId: clipSource[1], offset, rate };
  return { nodeId: nodeId!, offset, rate };
}

/* ------------------------------------------------------------------ *
 * 素材块:服务端 ffmpeg 裁,页面按 (hash, position, count) 缓存
 * ------------------------------------------------------------------ */

const blockCache = new Map<string, Promise<Float32Array>>();

export function clearAudioBlockCache() { blockCache.clear(); }

async function mediaBlock(hash: string, position: number, count: number, sampleRate: number): Promise<Float32Array> {
  const cacheKey = `${hash}:${position}:${count}:${sampleRate}`;
  const hit = blockCache.get(cacheKey);
  if (hit) {
    // 命中的挪到表尾:LRU 的淘汰顺序靠 Map 的插入序
    blockCache.delete(cacheKey); blockCache.set(cacheKey, hit);
    return hit;
  }
  const pending = (async () => {
    const url = `/@media/${hash}/pcm?start=${position}&count=${count}&sampleRate=${sampleRate}&ch=${MEDIA_PCM_CHANNELS}`;
    const response = await fetch(url);
    if (!response.ok) fail(`media PCM request failed (${response.status})`);
    const bytes = await response.arrayBuffer();
    const expected = count * MEDIA_PCM_CHANNELS * 4;
    if (bytes.byteLength !== expected) fail(`media PCM returned ${bytes.byteLength} bytes, expected ${expected}`);
    return new Float32Array(bytes);
  })();
  blockCache.set(cacheKey, pending);
  pending.catch(() => blockCache.delete(cacheKey));
  while (blockCache.size > AUDIO_BLOCK_CACHE_LIMIT) {
    const oldest = blockCache.keys().next();
    if (oldest.done) break;
    blockCache.delete(oldest.value);
  }
  return pending;
}

function mediaOf(ctx: AudioSourceContext, clip: TrackClip): MediaAsset {
  const media = clip.mediaId ? (ctx.project.media ?? []).find((m) => m.id === clip.mediaId) : undefined;
  if (!media) fail(`clip ${clip.id} has no media input`);
  if (!media!.hash) fail(`素材「${media!.name || media!.id}」还没有内容哈希,重新导入一次再用它喂音频图卡`);
  return media!;
}

/* ------------------------------------------------------------------ *
 * 实例参数(H2):节点存一份,片段指向的那个节点以 clip.params 为准
 * ------------------------------------------------------------------ */

export function paramsOfAudioNode(ctx: AudioSourceContext, node: CardNode): Record<string, unknown> {
  const def = typeof node.cardId === "string" ? ctx.getCard(node.cardId) : undefined;
  for (const track of ctx.project.tracks ?? []) for (const clip of track.clips ?? []) {
    if (clip.nodeId === node.id) return { ...def?.defaults, ...clip.params };
  }
  return { ...def?.defaults, ...(node.params ?? {}) };
}

/* ------------------------------------------------------------------ *
 * 取样
 * ------------------------------------------------------------------ */

/**
 * 取 `[start, start + count)` 这段采样(交错多声道)。`start` 是**下游**的本地采样序号;
 * 边上的 `offset`(秒)和素材的 `mediaOffset` 在这里一次折进请求位置。
 */
export async function blockOf(ctx: AudioSourceContext, ref: AudioSourceRef, start: number, count: number): Promise<Float32Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1) fail("audio block range must be whole samples");
  const rate = ref.rate ?? 1;
  if (rate !== 1) fail("音频图卡输入边上的播放速率第一版不支持(rate ≠ 1)");
  const edge = Math.round((ref.offset ?? 0) * ctx.sampleRate);
  if (ref.clipId !== undefined) {
    const clip = clipOf(ctx.project, ref.clipId);
    if (!clip) fail(`audio input clip ${ref.clipId} is missing`);
    const media = mediaOf(ctx, clip!);
    // 服务端没有 offset 参数:clip.mediaOffset + 边.offset 折算一次,折进 start
    const position = start + edge + Math.round((clip!.mediaOffset ?? 0) * ctx.sampleRate);
    return mediaBlock(media.hash!.toLowerCase(), position, count, ctx.sampleRate);
  }
  const node = nodeOf(ctx, ref.nodeId!);
  if (!node) fail(`audio input node ${ref.nodeId} is missing`);
  if (node!.adapter === "media") {
    // projectCardGraph 已经合成过的素材节点:offset 就在节点上(cardGraph.mjs:121-122)
    const media = node!.media as MediaAsset | undefined;
    if (!media?.hash) fail(`素材节点 ${node!.id} 没有内容哈希,重新导入一次素材`);
    const position = start + edge + Math.round((Number(node!.offset) || 0) * ctx.sampleRate);
    return mediaBlock(media!.hash!.toLowerCase(), position, count, ctx.sampleRate);
  }
  // 图卡节点:递归调它的 audio()
  return evaluateCardAudio(ctx, ref.nodeId!, { start: start + edge, count, sampleRate: ctx.sampleRate });
}

/** 一个节点的 `sources`。音频求值只用得上 `block()`,视觉两路在这里是明确的报错 */
export function audioSourcesOf(ctx: AudioSourceContext, node: CardNode): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, input] of Object.entries(node.inputs ?? {})) {
    const ref = resolveAudioRef(ctx, input);
    out[name] = {
      nodeId: ref.nodeId ?? `@clip/${ref.clipId}/source`,
      at() { return fail("音频图卡的 sources 只支持 block(),没有画面"); },
      pixels() { return Promise.reject(new Error("Card audio: 音频图卡的 sources 只支持 block(),没有画面")); },
      block: (start: number, count: number) => blockOf(ctx, ref, start, count),
    };
  }
  return out;
}

export interface AudioRange { start: number; count: number; sampleRate: number }

/** 找节点 → 注册表里的定义 → `def.audio(sources, range, params)`。返回交错的采样块 */
export async function evaluateCardAudio(ctx: AudioSourceContext, nodeId: string, range: AudioRange): Promise<Float32Array> {
  const node = nodeOf(ctx, nodeId);
  if (!node) fail(`audio node ${nodeId} is missing`);
  const cardId = typeof node!.cardId === "string" ? node!.cardId : "";
  const def = cardId ? ctx.getCard(cardId) : undefined;
  if (!def?.audio) fail(`card ${cardId || node!.id} has no audio()`);
  const samples = await def!.audio!(audioSourcesOf(ctx, node!), range, paramsOfAudioNode(ctx, node!) as any);
  if (!(samples instanceof Float32Array)) fail(`card ${cardId} audio() must return a Float32Array`);
  if (samples.length < 1 || samples.length % range.count !== 0) {
    fail(`card ${cardId} audio() returned ${samples.length} samples for ${range.count} frames (not a whole number of channels)`);
  }
  return samples;
}
