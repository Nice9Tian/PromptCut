/**
 * 在线浏览器模式:一段声音在本页合成、还是用已有产物(`docs/semantics/product/platforms.md`「卡片声音的平台边界」;
 * 做法 `mechanism/rendering.md`「声音的轻重」)。
 *
 *   - 这台设备跑不了它的代码(用户卡、图卡,第二段再放开) → 不合成;
 *   - 低内存档 → 不合成(它现有的规则:不活渲、没有成本记录的一律按重;本模块不改它);
 *   - 其余:测一次合成耗时(不出声,`src/audio/soundCost.ts`),判轻才在浏览器里合成,判重用已有产物。
 *
 * 桌面运行环境不走这里的判定:桌面一律能合成(`decideClipSound` 直接回「合成」)。
 *
 * 记录存在页面内快照库 L2 的 `costs` 表(与画面的成本记录同一张表,键与字段都不相撞,见 `soundCost.ts`;由 `onlineSoundBoot.ts` 接上);
 * L2 打不开时退回页面内存。第一次要用这段声音(预览挂上、生成、导出)时才测,不盖遮罩。
 */
import type { Project, TrackClip } from "../../kernel/project";
import { renderSoundEffectBlock, soundEffectReuseKey, type SoundEffectRecipe } from "../../kernel/soundEffects";
import { cardAudioIdentity } from "../../kernel/cardAudioRendition.mjs";
import { cardJson, projectCardGraph } from "../../kernel/cardGraph.mjs";
import { cyrb53 } from "../../render/cyrb53.mjs";
import { evaluateCardAudio, type AudioSourceContext } from "../../render/cards/audioSources";
import { CARD_AUDIO_SAMPLE_RATE, cardAudioNodeOf, onlineCardAudioSynthesizable, requireCardAudioHooks } from "../../audio/cardAudio";
import { createMemorySoundCostStore, createSoundJudge, soundCostStoreKey, soundDeviceString, type SoundCostRecord, type SoundCostStore, type SoundJudge, type SoundJudgeTarget, type SoundVerdict } from "../../audio/soundCost";
import { onlinePage } from "../../online/pageFlag";
import { ONLINE_CARD_AUDIO_BLOCKED } from "../../online/soundPolicy";

export type SoundDecision =
  | { synth: true; verdict?: SoundVerdict }
  | { synth: false; reason: "not-runnable" | "low-memory" | "heavy"; message: string; verdict?: SoundVerdict };

export const ONLINE_SOUND_LOW_MEMORY = "这台设备(低内存档)不合成声音,只用已经同步的声音;请在电脑上的 PromptCut 里生成后同步";
export const ONLINE_SOUND_HEAVY = "这段声音在这台设备上合成太慢(判重),要用已经生成的声音;请在电脑上的 PromptCut 里生成后同步";

interface Env {
  online: () => boolean;
  lowMemory: () => boolean;
  store: () => SoundCostStore | Promise<SoundCostStore>;
  device: () => string;
}

const memory = createMemorySoundCostStore();
const RUN_MODE = typeof import.meta.env !== "undefined" && import.meta.env.DEV === false ? "build" : "dev";
const defaults: Env = {
  online: onlinePage,
  // 档位与 L2 的成本表由 `onlineSoundBoot.ts` 在页面里接上(那两个模块在 Node 单测里载不进来);不接时按普通档、只记在页面内存
  lowMemory: () => false,
  store: () => memory,
  device: () => soundDeviceString({
    ua: typeof navigator === "undefined" ? "" : navigator.userAgent,
    cores: typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency,
    mode: RUN_MODE,
  }),
};
let env: Env = defaults;
let judge: SoundJudge | null = null;

/** 单测与探针换环境(存取、设备串、档位);不给的项用缺省。回一个还原函数 */
export function configureOnlineSoundJudge(next: Partial<Env>): () => void {
  const before = env, beforeJudge = judge;
  env = { ...env, ...next };
  judge = null;
  return () => { env = before; judge = beforeJudge; };
}

function theJudge(): SoundJudge {
  judge ??= createSoundJudge({
    device: () => env.device(),
    store: {
      async getCost(key) { return (await env.store()).getCost(key); },
      async putCost(key, record) { return (await env.store()).putCost(key, record); },
    },
  });
  return judge;
}

/** 一份独立音效配方在判定里的目标 */
export function recipeSoundTarget(recipe: SoundEffectRecipe): SoundJudgeTarget {
  return {
    soundKey: `effect:${cyrb53(soundEffectReuseKey(recipe))}`, kind: "effect", frames: recipe.frames, sampleRate: recipe.sampleRate,
    renderBlock: (start, count) => renderSoundEffectBlock(recipe, { start, count }),
  };
}

/** 这个片段的声音在判定里的目标(身份、长度、怎么合成一块);不是会出声的片段回 null */
export function soundTargetOf(project: Project, clip: TrackClip): SoundJudgeTarget | null {
  if (clip.soundEffect) return recipeSoundTarget(clip.soundEffect.recipe);
  const nodeId = cardAudioNodeOf(project, clip);
  if (!nodeId) return null;
  const hooks = requireCardAudioHooks();
  const frames = Math.max(1, Math.round((clip.end - clip.start) * CARD_AUDIO_SAMPLE_RATE));
  const identity = cardJson(cardAudioIdentity(project, clip, hooks));
  let context: AudioSourceContext | null = null;
  return {
    soundKey: `card:${cyrb53(`${identity}\n${frames}`)}`, kind: "card", frames, sampleRate: CARD_AUDIO_SAMPLE_RATE,
    renderBlock: (start, count) => {
      context ??= { graph: projectCardGraph(project, hooks.getCard), project, getCard: hooks.getCard, sampleRate: CARD_AUDIO_SAMPLE_RATE };
      return evaluateCardAudio(context, nodeId, { start, count, sampleRate: CARD_AUDIO_SAMPLE_RATE });
    },
  };
}

/** 在线页面里这个片段的声音代码这台设备能不能跑(不看轻重)。独立音效只有配方、没有卡片代码,恒能跑 */
export function clipSoundRunnable(project: Project, clip: TrackClip): boolean {
  if (clip.soundEffect) return true;
  const nodeId = cardAudioNodeOf(project, clip);
  return !!nodeId && onlineCardAudioSynthesizable(project, nodeId);
}

/**
 * 这个片段的声音此刻要不要在本页合成。桌面运行环境恒回「合成」;在线页面按文件头的三条判。
 * 判定要测量时在这里等它测完(测量不出声)。
 */
export async function decideClipSound(project: Project, clip: TrackClip, signal?: AbortSignal): Promise<SoundDecision> {
  if (!env.online()) return { synth: true };
  if (!clipSoundRunnable(project, clip)) return { synth: false, reason: "not-runnable", message: ONLINE_CARD_AUDIO_BLOCKED };
  if (env.lowMemory()) return { synth: false, reason: "low-memory", message: ONLINE_SOUND_LOW_MEMORY };
  const target = soundTargetOf(project, clip);
  if (!target) return { synth: false, reason: "not-runnable", message: ONLINE_CARD_AUDIO_BLOCKED };
  const verdict = await theJudge().judge(target, signal);
  return verdict.heavy ? { synth: false, reason: "heavy", message: ONLINE_SOUND_HEAVY, verdict } : { synth: true, verdict };
}

/** 一份独立音效配方(还没有片段时:新加提示音、键盘声)此刻要不要在本页合成 */
export async function decideRecipeSound(recipe: SoundEffectRecipe, signal?: AbortSignal): Promise<SoundDecision> {
  if (!env.online()) return { synth: true };
  if (env.lowMemory()) return { synth: false, reason: "low-memory", message: ONLINE_SOUND_LOW_MEMORY };
  const verdict = await theJudge().judge(recipeSoundTarget(recipe), signal);
  return verdict.heavy ? { synth: false, reason: "heavy", message: ONLINE_SOUND_HEAVY, verdict } : { synth: true, verdict };
}

/** 判重、又没有产物的声音交给渲染节点的接口。第一段没有接收方(见报告「没做成的」),不接时回 false,调用方照「没有产物」提示 */
type SoundBackfill = (request: { project: Project; clip: TrackClip; reason: "heavy" | "low-memory" | "not-runnable" }) => Promise<boolean>;
let backfill: SoundBackfill | null = null;
export function setSoundBackfillHandler(handler: SoundBackfill | null): void { backfill = handler; }
export async function requestSoundBackfill(request: Parameters<SoundBackfill>[0]): Promise<boolean> {
  if (!backfill) return false;
  try { return await backfill(request); } catch { return false; }
}

/** 探针与诊断:判定统计、设备串、某个片段的记录键;`seed` 按真实的记录形状写一条(用来验「判重的走产物」) */
export function onlineSoundJudgeDebug() {
  return {
    stats: () => theJudge().stats(),
    device: () => env.device(),
    keyOf: (project: Project, clip: TrackClip) => soundTargetOf(project, clip)?.soundKey ?? null,
    async seed(record: Pick<SoundCostRecord, "soundKey" | "kind" | "blockMs"> & Partial<SoundCostRecord>) {
      const device = env.device();
      const full: SoundCostRecord = { blockMaxMs: record.blockMs, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: Date.now(), ...record, device };
      await (await env.store()).putCost(soundCostStoreKey(record.soundKey, device), full);
      return full;
    },
    async read(soundKey: string) { return (await env.store()).getCost(soundCostStoreKey(soundKey, env.device())); },
  };
}
if (typeof window !== "undefined") (window as unknown as { __pcSoundJudge?: unknown }).__pcSoundJudge = onlineSoundJudgeDebug();
