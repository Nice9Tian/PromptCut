/**
 * 导出开始时先把声音生成好(`docs/semantics/product/rendering.md`「有声动效卡」,2026-10-06 用户定):
 * 所有未生成、缺失或过期的声音先生成,再开始出画面;生成进度算进导出进度;取消导出同时取消生成;
 * 只有某段声音确实生成不出来才失败,并说明是哪个片段。桌面导出与在线浏览器导出都走这里
 * (`src/editor/io/index.ts` 的 `exportVideo`、`src/export/onlineExport.ts` 的 `exportVideoOnline`)。
 *
 * 管两种声音:
 *   - 独立音效(提示音、键盘声):片段里存着配方(`clip.soundEffect`),声音是一份普通 WAV 素材;
 *   - 有声动效卡:声音属于视觉片段(`clip.cardAudio`),由卡片的 `audio()` 生成。
 * 音频图卡(`kind: 'audio'` 的节点)不在这里:它没有持久产物,导出混音时当场合成。
 *
 * 不留半截产物:每一段都是「合成 → 入库 → 一次提交」,取消或失败发生在提交之前,项目不动;
 * 取消之前已经完整生成好的那几段留着(它们是完整的声音,下次导出直接用)。
 *
 * 在线页面:这台设备跑不了的(用户卡、图卡)、判重的、低内存档的,不在浏览器里合成(`onlineSoundJudge.ts`);
 * 它们没有产物时导出失败并指出片段。
 */
import type { Project, TrackClip } from "../../kernel/project";
import { findClip } from "../../kernel/project";
import { CardAudioRenditionError, clipHasEmbeddedAudio } from "../../kernel/cardAudioRendition.mjs";
import { getCard, syncedUserCards } from "../../kernel/registry";
import { getState } from "../../store/project";
import { persistentCardAudio } from "../../audio/cardAudio";
import { hasGeneratedAudio } from "./generatedAudioUpload";
import { generateCardAudio } from "./cardAudioGeneration";
import { restoreSoundEffectAsset } from "./soundGeneration";
import { decideClipSound, requestSoundBackfill, type SoundDecision } from "./onlineSoundJudge";

export type ExportSoundKind = "effect" | "card";
export type ExportSoundReason = "ungenerated" | "missing" | "stale";

export interface ExportSoundNeed {
  clipId: string;
  /** 给用户看的片段名 */
  label: string;
  kind: ExportSoundKind;
  reason: ExportSoundReason;
  detail: string;
}

export interface ExportSoundsDeps {
  project: () => Project;
  /** 当前素材服务里有没有这份声音的完整字节 */
  hasBytes: (hash: string, signal: AbortSignal) => Promise<boolean>;
  generateCard: (clipId: string, options: { signal: AbortSignal; onProgress: (done: number, total: number) => void }) => Promise<unknown>;
  restoreEffect: (clipId: string, options: { signal: AbortSignal; onProgress: (fraction: number) => void }) => Promise<unknown>;
  decide: (project: Project, clip: TrackClip, signal: AbortSignal) => Promise<SoundDecision>;
  backfill: (request: { project: Project; clip: TrackClip; reason: "heavy" | "low-memory" | "not-runnable" }) => Promise<boolean>;
  embedded: (project: Project, clip: TrackClip) => boolean;
  resolveCard: (project: Project, clip: TrackClip) => { media: { hash?: string } };
}

const defaultDeps: ExportSoundsDeps = {
  project: () => getState().project,
  hasBytes: hasGeneratedAudio,
  generateCard: (clipId, options) => generateCardAudio(clipId, options),
  restoreEffect: (clipId, options) => restoreSoundEffectAsset(clipId, options),
  decide: decideClipSound,
  backfill: requestSoundBackfill,
  embedded: (project, clip) => clipHasEmbeddedAudio(project, clip, getCard) || !!syncedUserCards().get(clip.cardId)?.embeddedAudio,
  resolveCard: persistentCardAudio,
};

/** 导出失败:哪一段声音生成不出来 */
export class ExportSoundError extends Error {
  readonly code = "export-sound-failed";
  readonly clipId: string;
  readonly label: string;
  constructor(need: Pick<ExportSoundNeed, "clipId" | "label">, reason: string) {
    super(`片段「${need.label}」(${need.clipId})的声音生成不出来:${reason}`);
    this.clipId = need.clipId;
    this.label = need.label;
  }
}

const cancelled = () => Object.assign(new Error("已取消导出"), { cancelled: true });
const labelOf = (clip: TrackClip) => String(clip.label || getCard(clip.cardId)?.name || syncedUserCards().get(clip.cardId)?.name || clip.cardId || clip.id);

/**
 * 这次导出要先生成哪些声音。口径与混音计划相同(`src/kernel/audioPlan.mjs`):隐藏、静音的序列和静音的片段不出声,不用生成。
 * 项目里记录齐全的还要问一次素材服务:字节不在(换了素材服务、内容库被清)也算缺失。
 */
export async function listExportSoundNeeds(signal: AbortSignal, overrides: Partial<ExportSoundsDeps> = {}): Promise<ExportSoundNeed[]> {
  const deps = { ...defaultDeps, ...overrides };
  const project = deps.project();
  const needs: ExportSoundNeed[] = [];
  const known = new Map<string, boolean>();
  const bytes = async (hash: string) => {
    if (!known.has(hash)) known.set(hash, await deps.hasBytes(hash, signal));
    return known.get(hash)!;
  };
  for (const track of project.tracks) {
    if (track.hidden || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.audioMuted || !(clip.end > clip.start)) continue;
      if (signal.aborted) throw cancelled();
      if (clip.soundEffect && !clip.nodeId) {
        const media = project.media.find((m) => m.id === clip.mediaId);
        const base = { clipId: clip.id, label: labelOf(clip), kind: "effect" as const, reason: "missing" as const };
        if (!media || media.kind !== "audio" || !media.hash || !media.url || media.pending) needs.push({ ...base, detail: "项目里没有这段音效的素材记录" });
        else if (!(await bytes(media.hash))) needs.push({ ...base, detail: "素材服务里没有这段音效的文件" });
        continue;
      }
      if (!deps.embedded(project, clip)) continue;
      const base = { clipId: clip.id, label: labelOf(clip), kind: "card" as const };
      try {
        const hash = deps.resolveCard(project, clip).media.hash;
        if (!hash || !(await bytes(hash))) needs.push({ ...base, reason: "missing", detail: "素材服务里没有这段卡片声音的文件" });
      } catch (error) {
        const code = error instanceof CardAudioRenditionError ? error.code : "missing";
        const message = error instanceof Error ? error.message : String(error);
        needs.push({ ...base, reason: code === "stale" ? "stale" : clip.cardAudio ? "missing" : "ungenerated", detail: message });
      }
    }
  }
  return needs;
}

export interface PrepareExportSoundsOptions {
  signal: AbortSignal;
  /** `done` 可以带小数(正在生成的那一段做到几成),`total` 是要生成的段数 */
  onProgress?: (done: number, total: number) => void;
  /** 已经列好的清单(调用方先列一遍决定要不要显示这一步时,传进来免得再问一遍素材服务) */
  needs?: ExportSoundNeed[];
  deps?: Partial<ExportSoundsDeps>;
}

/**
 * 把清单里的声音逐段生成好。全部成功才返回;取消抛 `{ cancelled: true }`;某一段生成不出来抛 `ExportSoundError`(带片段)。
 */
export async function prepareExportSounds(options: PrepareExportSoundsOptions): Promise<{ total: number; generated: string[] }> {
  const deps = { ...defaultDeps, ...options.deps };
  const { signal } = options;
  const needs = options.needs ?? await listExportSoundNeeds(signal, deps);
  const total = needs.length;
  const generated: string[] = [];
  if (!total) return { total, generated };
  options.onProgress?.(0, total);
  for (let i = 0; i < total; i++) {
    const need = needs[i];
    if (signal.aborted) throw cancelled();
    const part = (fraction: number) => options.onProgress?.(i + Math.max(0, Math.min(0.99, fraction)), total);
    try {
      const project = deps.project(), hit = findClip(project, need.clipId);
      if (!hit) throw new Error("片段已经不在项目里");
      const decision = await deps.decide(project, hit.clip, signal);
      if (!decision.synth) {
        const handed = await deps.backfill({ project, clip: hit.clip, reason: decision.reason });
        throw new Error(handed ? `${decision.message}(已交给渲染节点生成,生成好之后再导出)` : decision.message);
      }
      if (need.kind === "effect") await deps.restoreEffect(need.clipId, { signal, onProgress: part });
      else await deps.generateCard(need.clipId, { signal, onProgress: (done, all) => part(all ? done / all : 0) });
    } catch (error) {
      if (signal.aborted || (error as { cancelled?: boolean })?.cancelled || (error as Error)?.name === "AbortError") throw cancelled();
      throw new ExportSoundError(need, error instanceof Error ? error.message : String(error));
    }
    generated.push(need.clipId);
    options.onProgress?.(i + 1, total);
  }
  return { total, generated };
}
