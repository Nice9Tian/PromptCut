import { useEffect, useState } from "react";
import { startShotDetection, waitForShots } from "../../ai/shots";
import { scenesOf, planSequences, frameTimes, transcriptFor } from "../../ai/sequences";
import { installTrack, startTracking, trackStatus, waitForTrack, type TrackResult } from "../../ai/track";
import {
  installSubject, startSubjectDetection, subjectStatus, waitForSubjects,
} from "../../ai/subject";
import { buildClipMotion } from "../../kernel/motion";
import { useLayoutMode } from "../layoutMode";
import { DockHost } from "../dock/DockHost";
import { DockPages } from "../dock/DockPages";
import { RailBar } from "../dock/RailBar";
import { useSideVisible } from "../dock/railStore";
import { connectMcpExecutor, EditorApi } from "../../ai/mcpExecutor";
import { prerenderUrl } from "../prerender";
import { getState, actions } from "../../store/project";
import { allCards, getCard } from "../../kernel/registry";
import { saveCardDefinition, applyCardDefinition } from "../../kernel/cardAuthoring.mjs";
import { cardFrameMode } from "../../render/frameMode.mjs";
import { applyEnvelope, assertNo3dOnMedia, envelopeOf, isComposite, rejectAudioVolumeKeys } from "../../kernel/envelope";
import { addPart as addPartToTree, movePart as movePartInTree, removePart as removePartFromTree, updatePart as updatePartInTree, validatePartTree } from "../../kernel/parts";
import { allParts, getPart } from "../../parts/registry";
import { COMPOSITE_CARD_ID } from "../../cards/native/composite";
import type { PartInstance } from "../../kernel/types";
import { validateCardParams, findCard } from "../../kernel/cardParams";
import { describeTransition, timingLock, transitionsOf, type TransitionKind } from "../../kernel/transitions";
import { describeEmphasis } from "../../kernel/emphasis";
import { CAPTION_CARD_ID, captionsFromTranscript, captionsOf, describeCaption, formatCaptions } from "../../kernel/captions";
import {
  findClip, subjectForRange, subjectSampleTimes, suggestPosition,
  MAX_SUBJECT_TIMES,
  type SubjectBox, type SubjectRangeInfo,
} from "../../kernel/project";
import { createClipGuard, timelineDigest, lookHint } from "./toolEcho";
import { createTrackTools } from "./trackTools";
import { createFilterTools } from "./filterTools";
import { createAudioFxTools } from "./audioFxTools";
import { createPixelMapTools } from "./pixelMapTools";
import { audioPlanOf, soundingAt } from "../../kernel/audioPlan.mjs";
import {
  framePatchFromArgs, worldOf, rectToFrame, alignToFrame, alignIsInvisible, nudgeFrame, clampToStage, rectForSafeSide,
  type Size,
} from "../../kernel/layout";
import { listCuts, resolveCut } from "../../kernel/cuts";
import { invalidateScopes, isCardVisible, loadScopes, readVisibility, usedCardIds, type ScopeEntry } from "../cardScope";
import { cameraFor, clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG } from "../../kernel/space3d";
import { generateVoice, getVoiceConfig } from "../../ai/voice";
import { VoiceSettingsDialog } from "../../voice/VoiceSettingsDialog";
import { importAudioFromServer } from "../io";

import type { ClipFrame } from "../../kernel/types";

/** 舞台尺寸:卡片级 frame 的父坐标系 */
function stageSize(): Size {
  const p = getState().project;
  return { width: p.width, height: p.height };
}

/**
 * 卡片的**实体内容**框:文字、图片、有底色的盒子这些真正画了东西的元素的并集,透明容器穿过去。
 * 判「会不会盖住人」要看它,不是画布框 —— 默认卡的画布 1920 宽,拿画布判永远是"会盖住"。
 *
 * 量的是预览 iframe 里真实渲染出来的 DOM(StageView 的 bounds),所以:
 *   - 先把当前 project 推给预览并同步渲染到播放头时刻(两者都是 flushSync),量到的是改完之后的样子;
 *   - 卡片此刻不在画面上(播放头不在它的区间)就量不到,返回 null 并说明,别当成"没内容"。
 */
function measureContentBox(clipId: string): { contentBox: { left: number; top: number; width: number; height: number } | null; contentNote?: string } {
  const s = window.__pcPreviewStage?.();
  if (!s?.bounds) return { contentBox: null, contentNote: "预览窗口没就绪,量不到内容框;稍后再 get_layout" };
  const st = getState();
  try {
    /*
     * 量之前先退出实体模式:播放中画面上是色块,量到的就是色块的框而不是内容的框。
     * Agent 拿 contentBox 判「会不会盖住人」,量错了它会去挪本来不用挪的东西。
     * 量完按当前播放状态放回去 —— 用户还在播就继续画色块。
     */
    s.setProxy?.(false);
    s.setProject(st.project);
    s.render(st.t, { jump: true });
  } catch {
    // 预览没准备好时 render 可能抛,量不到就量不到,别让整个工具失败
  }
  const box = s.bounds(clipId);
  try {
    s.setProxy?.(st.playing);
  } catch {
    // 同上,恢复失败不该让工具失败
  }
  if (!box) {
    const hit = findClip(st.project, clipId);
    const range = hit ? `${hit.clip.start}~${hit.clip.end}s` : "?";
    return { contentBox: null, contentNote: `这张卡此刻不在画面上(播放头 ${st.t}s 不在它的 ${range} 区间内),先 seek 进它的时段再读` };
  }
  const r = (v: number) => Math.round(v);
  return { contentBox: { left: r(box.left), top: r(box.top), width: r(box.width), height: r(box.height) } };
}

/**
 * 定位工具返回的布局:local 是存下来的框(没设过为 null),world 是算出来的画面绝对位置
 * (box 画布、visualBox 缩放旋转后),contentBox 是量出来的实体内容框(见 measureContentBox)。
 */
function layoutOf(clipId: string) {
  const hit = findClip(getState().project, clipId);
  const frame = (hit?.clip as { frame?: ClipFrame } | undefined)?.frame;
  return { clipId, local: frame ?? null, world: worldOf(frame, stageSize(), getState().project.camera3dFov), ...measureContentBox(clipId) };
}

/**
 * 定位工具的公共骨架:找到 clip → 用现有框算出新框 → 存 → 回 layout + look。
 * set_position / set_rect / align / nudge 四个只是 next 不同 —— 它们改的是同一个框。
 */
/**
 * 组合卡部件树工具的公共骨架:找到 clip → 确认是组合卡 → 用纯函数算新树 → 存 → 回封装 + look。
 * add_part / set_part / remove_part / move_part 只是 next 不同。
 */
function withParts<R extends { tree: PartInstance[] }>(clipId: string, next: (tree: PartInstance[]) => R, extra?: (r: R) => Record<string, unknown>) {
  const hit = findClip(getState().project, clipId);
  if (!hit) throw new Error(`找不到 clip ${clipId}`);
  if (!isComposite(hit.clip)) throw new Error(`clip ${clipId} 不是组合卡(cardId 要是 composite);先 add_composite 建一张,或 update_clip 把它换成 composite`);
  const r = next(hit.clip.parts ?? []);
  actions.setClipParts(clipId, r.tree);
  const after = findClip(getState().project, clipId)!;
  return { ok: true, clipId, ...(extra ? extra(r) : {}), envelope: envelopeOf(getState().project, after.clip, getCard(after.clip.cardId), stageSize()), look: lookHint(clipId) };
}

function withFrame(clipId: string, next: (prev: ClipFrame | undefined, stage: Size) => ClipFrame | undefined) {
  const hit = findClip(getState().project, clipId);
  if (!hit) throw new Error(`找不到 clip ${clipId}`);
  const prev = (hit.clip as { frame?: ClipFrame }).frame;
  actions.setClipFrame(clipId, next(prev, stageSize()));
  return { ok: true, clipId, layout: layoutOf(clipId), look: lookHint(clipId) };
}

/**
 * set_position 那条路上的素材三维拦截。规则本身在 kernel/envelope.ts 的 assertNo3dOnMedia,
 * 那里同时守着 set_clip 那条路 —— 两条路共用一份判断和一份措辞,免得以后只改一处。
 */
function reject3dOnMedia(clipId: string, args: { rotateX?: number; rotateY?: number; translateZ?: number }) {
  const hit = findClip(getState().project, clipId);
  if (hit) assertNo3dOnMedia(hit.clip, args as ClipFrame);
}
import { sttStatus, sttInstall, transcribeMedia } from "../io/stt";
import { importVideoFiles, importVideoFromServer } from "../io";
import { classifyFileDetailed, KIND_LABEL, registerAsset } from "../left/importAssets";
import { mediaCardUrl, isImageMedia } from "../../ai/mediaRef";
import {
  collectStatus, installCollect, probeLink, startDownload, waitForDownload, type CollectJob,
  collectLoginCheck, collectLogout, cookieStatus, searchVideos,
} from "../../ai/collect";
import { openCollectLogin } from "../../ai/collectLoginStore";
import { CollectLoginDialog } from "./CollectLoginDialog";
import { AgentBrowserFrame } from "./AgentBrowserFrame";
import { runAutoWorkflow, getAutoWorkflowStatus } from "./autoWorkflow";
import { getJob as getInstallJob } from "../../ai/sttInstallStore";
import { runSttInstall } from "../io/runSttInstall";

/** 后台 STT 任务的状态(MCP 工具立即返回 jobId,结果靠轮询) */
interface SttJob { done: boolean; ok: boolean; error?: string; logTail?: string[]; segments?: number }
/**
 * 归属表的同步快照。`list_cards` 是同步的,没法 await —— 所以模块加载时先拉一次,
 * 建卡 / 改档位之后再刷新。拉不到就是空表,而空表在 isCardVisible 里一律放行:
 * 宁可多给几张卡,也不能因为一次网络抖动让 Agent 突然一张卡都看不见。
 */
let cardScopes: Record<string, ScopeEntry> = {};
const refreshScopes = () => { invalidateScopes(); loadScopes(true).then((m) => { cardScopes = m; }).catch(() => {}); };
loadScopes().then((m) => { cardScopes = m; }).catch(() => {});
const sttJobs = new Map<string, SttJob>();

/** 素材收集拓展的安装作业。和 sttJobs 分开,理由同 trackInstallJobs。 */
const collectInstallJobs = new Map<string, { done: boolean; ok: boolean; error?: string; logTail: string[] }>();
/**
 * 下载作业:服务端那份进度 + 这边登记进素材库的结果。
 * 登记只做一次(imported 标记),collect_job 被轮询多少次都不会重复加素材。
 */
const collectJobs = new Map<string, {
  job?: CollectJob; imported: boolean; mediaIds: string[]; error?: string;
}>();

/** 时间轴工具的删除门槛。见 toolEcho.ts 头注释里那份复盘。 */
const clipGuard = createClipGuard();
/** 序列工具(list/remove/update/move_track)的校验和门槛。见 trackTools.ts 头注释 */
const trackTools = createTrackTools({ getState, actions });
/** 滤镜库工具(list/create/update/remove/apply_filter)。见 filterTools.ts 头注释 */
const filterTools = createFilterTools({ getState, actions });
/** 音频效果库工具(list/create/update/remove/apply_audio_fx)。见 audioFxTools.ts 头注释 */
const audioFxTools = createAudioFxTools({ getState, actions });
const pixelMapTools = createPixelMapTools({ getState, actions });

/**
 * 测响度(measure_audio):素材、时间轴片段、或整条时间轴的混音。ffmpeg 在服务端跑(server/vite-plugin-audio.ts),
 * 这里只把「测谁、从第几秒到第几秒」算清楚。timeline 档把 kernel/audioPlan 的清单整份发过去,回来的逐秒曲线
 * 再按同一份清单标上那一秒谁在出声 —— Agent 拿到「第 19 秒 -8 LUFS,出声的是配乐 + 配音 04」才能归因。
 */
async function measureAudio(args: { clipId?: string; mediaId?: string; scope?: string; series?: boolean }) {
  const p = getState().project;
  const scope = args.scope || (args.clipId ? "clip" : args.mediaId ? "media" : "timeline");
  const mediaOf = (id: string) => {
    const m = p.media.find((x) => x.id === id);
    if (!m) throw new Error(`找不到素材 ${id}`);
    if (m.kind === "image") throw new Error(`「${m.name}」是图片,没有声音`);
    return { id: m.id, name: m.name, kind: m.kind, url: m.url, path: (m as { path?: string }).path };
  };
  let body: Record<string, unknown>;
  let plan: ReturnType<typeof audioPlanOf> | null = null;
  if (scope === "clip") {
    const hit = findClip(p, String(args.clipId || ""));
    if (!hit) throw new Error(`当前剪辑里没有片段 ${args.clipId || "(没给 clipId)"}`);
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error("卡片没有声音;要测的是视频 / 声音片段");
    body = { scope, media: mediaOf(hit.clip.mediaId), offset: hit.clip.mediaOffset ?? 0, duration: hit.clip.end - hit.clip.start, series: !!args.series };
  } else if (scope === "media") {
    body = { scope, media: mediaOf(String(args.mediaId || "")), series: !!args.series };
  } else {
    plan = audioPlanOf(p);
    if (!plan.length) return { ok: true, scope, empty: true, note: "时间轴上没有会出声的片段(隐藏 / 静音的序列和静音的片段不算)" };
    body = {
      scope: "timeline",
      duration: p.duration,
      entries: plan.map((e) => ({ clipId: e.clipId, media: mediaOf(e.mediaId), start: e.start, dur: e.dur, offset: e.offset, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut })),
    };
  }
  const res = await fetch("/api/audio/measure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(55000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) throw new Error(data?.error || `测响度失败(HTTP ${res.status})`);
  const notes: string[] = Array.isArray(data.notes) ? [...data.notes] : [];
  const out: Record<string, unknown> = { ...data, scope };
  if (plan) {
    if (Array.isArray(data.series)) out.series = data.series.map((s: { t: number }) => ({ ...s, sounding: soundingAt(plan!, s.t) }));
    const withFx = plan.filter((e) => e.fx).map((e) => e.clipId);
    if (withFx.length) notes.push(`${withFx.join("、")} 挂着音频效果,这里测的不含效果(效果在 Chrome 里算,导出时才混进去)`);
    out.clips = plan.map((e) => ({ clipId: e.clipId, mediaId: e.mediaId, start: e.start, end: +(e.start + e.dur).toFixed(3), volume: +e.volume.toFixed(3), ...(e.fx ? { fxId: e.fx.def.id } : null) }));
  } else if (scope === "clip") {
    notes.push("测的是这一段用到的那截素材的原声;片段音量、淡入淡出和音频效果都不含");
  }
  if (notes.length) out.notes = notes;
  return out;
}

/** 正在跑的镜头识别作业,按 mediaId 索引。结果落进 store 后就删掉。 */
const shotJobs = new Map<string, { jobId: string; percent: number; engine: string; error?: string }>();
/** 进行中的追踪作业,以及跑完的轨迹。都只在内存里,刷新页面就没了 */
// engine 可以是 undefined:哪一档在跑由 Python 侧决定,作业跑完前 Node 不知道。
// 之前这里写死 "bootstapir",于是没装拓展时会把兜底档的进度报成神经网络档。
// 拓展安装的后台作业。和 sttJobs 分开:两者的 jobId 各自生成,混在一张表里
// 只会让「找不到这个 jobId」这类问题更难查。
const trackInstallJobs = new Map<string, {
  done: boolean; ok: boolean; error?: string; logTail: string[];
}>();

const trackJobs = new Map<string, {
  jobId: string; percent: number; engine?: "bootstapir" | "template"; error?: string;
}>();
const trackResults = new Map<string, TrackResult>();

/** 正在跑的主体检测作业,按 mediaId 索引。结果落进 store(MediaAsset.subjects)后就删掉。 */
const subjectJobs = new Map<string, {
  jobId: string; percent: number; engine?: "light" | "full"; error?: string;
}>();
/** 主体检测拓展的安装作业。理由同 trackInstallJobs:jobId 各自生成,不混表 */
const subjectInstallJobs = new Map<string, {
  done: boolean; ok: boolean; error?: string; logTail: string[];
}>();

/** 一段区间上最有代表性的几个框。全量吐给模型太长,一个镜头三次采样就是三份重复的人 */
/**
 * 找那张字幕卡。不给 clipId 时:时间轴上只有一张就用它,有多张要求说清楚是哪张
 * (和 fill_captions 一个口径 —— 猜错了会改到另一段视频的字幕上,不如报错)。
 */
function findCaptionClip(clipId?: string) {
  const project = getState().project;
  if (!clipId) {
    const hits = project.tracks.flatMap((t) => t.clips.filter((c) => c.cardId === CAPTION_CARD_ID));
    if (hits.length === 0) throw new Error("时间轴上没有字幕卡。先 add_clip 建一张 caption-track,再用 fill_captions 灌进文字稿。");
    if (hits.length > 1) throw new Error(`时间轴上有 ${hits.length} 张字幕卡,请用 clipId 指明是哪一张:${hits.map((c) => c.id).join(", ")}`);
    clipId = hits[0].id;
  }
  const hit = findClip(project, clipId);
  if (!hit) throw new Error(`找不到 clip ${clipId}`);
  if (hit.clip.cardId !== CAPTION_CARD_ID) throw new Error(`clip ${clipId} 是 ${hit.clip.cardId || "素材段"},不是字幕卡。`);
  return hit;
}

function topBoxes(boxes: SubjectBox[], limit = 4): SubjectBox[] {
  return [...boxes]
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, limit)
    .map((b) => ({
      label: b.label,
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
      conf: Math.round(b.conf * 100) / 100,
    }));
}

/** 把 subjectForRange 的结果折成给模型看的形状:带能直接填进 params.position 的建议 */
function subjectDigest(info: SubjectRangeInfo | null) {
  if (!info) return null;
  const round2 = (v: number) => Math.round(v * 100) / 100;
  // suggestedPosition 是「剩下三档里最不坏的」,不等于「保证不遮」。把被选中那一侧的
  // 占用率一并报出来,占过一半就置 null 并给 warning —— 正面说话人半身镜头
  // (safeSide=top)最常见的情况是四侧全被占,以前这里会给出一个 89.5% 是人的 right,
  // 模型照着填,卡片正好压在脸上,而返回里没有任何字段透出这件事。
  const sug = suggestPosition(info.safeSide, info.occupancy);
  return {
    safeSide: info.safeSide,
    ...sug,
    // 空的那一侧直接给成矩形,喂给 set_rect 就能把任何卡放过去 —— 不再受卡片自带 position
    // 档位限制(safeSide 是 top 也能用了,以前 top 没有对应档位只能作罢)。四侧全被占(sug 置 null)
    // 时这里也 null:那一刻没有不遮人的矩形,别硬放。
    suggestedRect: sug.suggestedPosition == null ? null : rectForSafeSide(info.safeSide, stageSize(), 40),
    occupancy: {
      left: round2(info.occupancy.left), right: round2(info.occupancy.right),
      top: round2(info.occupancy.top), bottom: round2(info.occupancy.bottom),
    },
    sampledAt: info.times,
    boxCount: info.boxes.length,
    boxes: topBoxes(info.boxes),
    ...(info.approximate
      ? { approximate: true, note: "这段区间里没有采样点,数字来自时间上最近的一次采样,只是近似" }
      : null),
  };
}

export function RightPanel() {
  const [mcpConnected, setMcpConnected] = useState(false);

  useEffect(() => {
    const api: EditorApi = {
      /**
       * 两档详略。默认摘要:每张卡只给 id/名字/干什么/什么时候用/参数名,
       * 一次调用就能把二十几张卡扫完并选定用哪张。真要建卡时再带 cardId
       * 取那一张的完整 schema —— 以前无论要哪张都得把所有卡的 controls
       * 和 defaults 全量拉一遍,又贵又淹没重点。
       */
      listCards: (args) => {
        const pythonDefinitions = getState().project.cardDefinitions?.filter(def => def.language === 'python') || [];
        const python = pythonDefinitions.filter(def => !args?.cardId || def.id === args.cardId).map(def => ({ ...def, source: 'project', language: 'python', hint: '用apply_card创建实例；get_card_source读取Python源码' }));
        if (args?.cardId && python.length) return python;
        /*
         * 卡片库对 Agent 暴露多少,由 editor/cardScope.ts 那三档决定 ——
         * 内置卡按组开关,用户卡看「是不是本项目建的 / 有没有标共享」。
         * 从前这里是全给,于是给 A 项目建的定制卡会出现在 B 项目里(用户原话:
         * 「ThreeJS 的资产又从上一个项目泄露给他了」)。
         *
         * 点名要某一张卡时(带 cardId)**不过滤**:那是明确的指名道姓,
         * 藏起来只会让它拿到一句「没有这张卡」而不知道为什么。
         */
        const wanted = args?.cardId
          ? [findCard(args.cardId)]
          : allCards().filter((c) => isCardVisible(c, readVisibility(), cardScopes, getState().project.id ?? null, usedCardIds(getState().project)));
        const full = args?.detail === "full" || !!args?.cardId;
        return [...python, ...wanted.map((c) => {
          const base = {
            id: c.id, name: c.name, description: c.description, source: c.source,
            frameMode: cardFrameMode(c),
            ...(c.useWhen ? { useWhen: c.useWhen } : {}),
            ...(c.tags?.length ? { tags: c.tags } : {}),
          };
          if (full) return { ...base, controls: c.controls, defaults: c.defaults };
          return {
            ...base,
            params: c.controls.map((ct) => (ct.required ? `${ct.key}*` : ct.key)),
            hint: "带 * 的是必填。要完整 schema 就用 list_cards({ cardId })。",
          };
        })];
      },
      getProject: () => {
        const p = getState().project;
        return {
          ...p,
          media: p.media.map(m => {
            if (m.transcript) {
              return {
                ...m,
                transcript: {
                  engine: m.transcript.engine,
                  model: m.transcript.model,
                  language: m.transcript.language,
                  createdAt: m.transcript.createdAt,
                  segments: m.transcript.segments.length,
                  hint: "完整文字稿请用 get_transcript"
                }
              };
            }
            return m;
          })
        };
      },
      listMedia: () => {
        const p = getState().project;
        return p.media.map(m => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          duration: m.duration,
          width: m.width,
          height: m.height,
          // 卡片里引用用 cardUrl。不再给 url:导入的素材那是 blob: 开头的编辑器私有地址,
          // 模型拿去填卡片只会得到空白画面(见 src/ai/mediaRef.ts)
          cardUrl: mediaCardUrl(m),
          path: m.path,
          hasTranscript: !!m.transcript,
          transcriptSegments: m.transcript ? m.transcript.segments.length : 0
        }));
      },
      getSelection: () => {
        const state = getState();
        if (state.selection.length === 0) return null;
        const clipId = state.selection[0];
        const hit = findClip(state.project, clipId);
        if (!hit) return null;
        return { id: clipId, trackId: hit.track.id, clip: hit.clip };
      },
      addClip: (args) => {
        // 先校验再落库:参数错了当场报错,而不是建出一张播默认值的空壳卡
        validateCardParams(args.cardId, args.params);
        // 字幕卡没指定序列时统一去「字幕」序列(没有就建一条,建在最上层):
        // 字幕要压在画面之上,而且单独一条轨才看得清哪句话在什么时候
        const trackId =
          args.trackId ?? (args.cardId === CAPTION_CARD_ID ? actions.ensureCaptionTrack().id : undefined);
        const clip = actions.addCardClip(args.cardId, args.start, {
          duration: args.duration,
          trackId,
          params: args.params
        });
        if (!clip) throw new Error("添加卡片失败");
        clipGuard.noteCreated(clip.id);
        // look:去看这张卡真实画面的现成调用;timeline:当前全部 clip 的 id 和起止,
        // 之后模型引用 clipId 以它为准,不再凭几步前的记忆。理由见 toolEcho.ts。
        return { ...clip, look: lookHint(clip.id), timeline: timelineDigest(getState().project) };
      },
      updateClip: (args) => {
        rejectAudioVolumeKeys(args, "update_clip");
        if (args.params || args.cardId !== undefined) {
          const hit = findClip(getState().project, args.clipId);
          if (!hit) throw new Error(`找不到 clip ${args.clipId}`);
          const clip = hit.clip as { cardId?: string; params?: Record<string, unknown> };
          // 换卡时旧参数不再适用,按空的算;只改参数时要带上 clip 已有的,
          // 免得「只改个颜色」被当成漏填了必填项。
          const switching = args.cardId !== undefined && args.cardId !== clip.cardId;
          validateCardParams(args.cardId ?? clip.cardId!, args.params, switching ? undefined : clip.params);
        }
        /*
         * 挂着转场的片段:相对时间关系是转场的一部分。
         *   - 整组平移(只给 start,或 start+end 保持时长)照做,同组的会跟着一起走;
         *   - 改时长、换序列、手改转场管着的那一侧淡化 —— 拒绝,并告诉它先 remove_transition。
         */
        const lock = timingLock(getState().project, args.clipId);
        if (lock) {
          const cur = findClip(getState().project, args.clipId)!.clip;
          const wantStart = args.start ?? cur.start;
          const wantEnd = args.end ?? cur.end;
          if (Math.abs(wantEnd - wantStart - (cur.end - cur.start)) > 1e-3) {
            throw new Error(`改不了时长:${lock.message}`);
          }
          if (args.trackId !== undefined && args.trackId !== findClip(getState().project, args.clipId)!.track.id) {
            throw new Error(`换不了序列:${lock.message}`);
          }
          for (const side of ["fadeIn", "fadeOut"] as const) {
            if (args[side] !== undefined && lock.transitions.some((tr) =>
              (tr.kind === "crossfade" && ((side === "fadeOut" && tr.aId === args.clipId) || (side === "fadeIn" && tr.bId === args.clipId))) ||
              (tr.kind === side && tr.aId === args.clipId))) {
              throw new Error(`${side} 是转场的时长,不能单独改:${lock.message}`);
            }
          }
        }
        if (args.params) actions.setClipParams(args.clipId, args.params);
        // 不透明度 / 淡入淡出 / 标签:store 早就支持,以前只是没暴露给模型 —— 系统提示词让它
        // 「遮到人就降不透明度」,它却没有工具能做。
        const patch: { opacity?: number; fadeIn?: number; fadeOut?: number; label?: string } = {};
        for (const k of ["opacity", "fadeIn", "fadeOut"] as const) {
          const v = args[k];
          if (v === undefined) continue;
          if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(v)}`);
          if (k === "opacity" && (v < 0 || v > 1)) throw new Error(`opacity 是 0~1,收到 ${v}`);
          if (k !== "opacity" && v < 0) throw new Error(`${k} 是秒数,不能为负,收到 ${v}`);
          patch[k] = v;
        }
        if (args.label !== undefined) patch.label = String(args.label);
        if (Object.keys(patch).length) actions.updateClip(args.clipId, patch);
        if (args.trackId !== undefined && !getState().project.tracks.some((t) => t.id === args.trackId)) {
          throw new Error(`找不到序列 ${args.trackId};get_project 里 tracks 的 id 才是有效值`);
        }
        if (args.start !== undefined || args.end !== undefined || args.trackId !== undefined) {
          actions.moveClip(args.clipId, { start: args.start, end: args.end, trackId: args.trackId });
        }
        if (args.cardId !== undefined) actions.setClipCard(args.clipId, args.cardId);
        clipGuard.noteMutation();
        return {
          ok: true, clipId: args.clipId, look: lookHint(args.clipId), timeline: timelineDigest(getState().project),
          ...(lock ? { movedGroup: lock.members, note: "这段挂着转场,整组一起挪了" } : {}),
        };
      },
      setPosition: (args) => {
        reject3dOnMedia(args.clipId, args);
        const r = withFrame(args.clipId, (prev, stage) => {
          if (args.clear) return undefined;
          // 只改传了的字段,其余保留;world→local 的换算在 framePatchFromArgs 里(卡片级恒等)。
          // 第一次设且没给 x/y 时补 0,免得存下一个没有位置的框。
          const next = { x: 0, y: 0, ...prev, ...framePatchFromArgs(args, stage) };
          return args.clamp ? clampToStage(next, stage, getState().project.camera3dFov) : next;
        });
        clipGuard.noteMutation();
        return r;
      },
      setRect: (args) => {
        const r = withFrame(args.clipId, (prev, stage) =>
          rectToFrame({ x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 }, { mode: args.mode, align: args.align }, prev, stage));
        clipGuard.noteMutation();
        return r;
      },
      align: (args) => {
        let invisible = false;
        const r = withFrame(args.clipId, (prev, stage) => {
          const next = alignToFrame(args.h, args.v, args.margin ?? 0, prev, stage);
          invisible = alignIsInvisible(next, stage);
          return next;
        });
        clipGuard.noteMutation();
        return invisible
          ? { ...r, note: "这张卡的画布铺满舞台、也没缩小,对齐看不出效果。先 set_rect(放进一个矩形)或 nudge({ scaleBy: 0.6 })缩小,再对齐。" }
          : r;
      },
      nudge: (args) => {
        const r = withFrame(args.clipId, (prev, stage) => {
          const next = nudgeFrame(args, prev, stage);
          return args.clamp ? clampToStage(next, stage, getState().project.camera3dFov) : next;
        });
        clipGuard.noteMutation();
        return r;
      },
      // 部件库 + 组合卡:Agent 用部件搭卡,操作的仍然是封装(clip.parts 那棵实例树)
      listParts: (args) => {
        const wanted = args?.partId ? [getPart(args.partId)].filter(Boolean) : allParts();
        if (args?.partId && wanted.length === 0) throw new Error(`没有 id 为 "${args.partId}" 的部件。可用的:${allParts().map((p) => p.id).join(", ")}`);
        const full = args?.detail === "full" || !!args?.partId;
        return wanted.map((p) => {
          const base = {
            id: p!.id, name: p!.name, description: p!.description, role: p!.role,
            ...(p!.useWhen ? { useWhen: p!.useWhen } : {}), ...(p!.tags?.length ? { tags: p!.tags } : {}), ...(p!.from ? { from: p!.from } : {}),
          };
          if (full) return { ...base, controls: p!.controls, defaults: p!.defaults, defaultFrame: p!.defaultFrame ?? null, after: p!.after ?? "hold" };
          return { ...base, params: p!.controls.map((c) => (c.required ? `${c.key}*` : c.key)), hint: "带 * 的是必填。要完整 schema 就用 list_parts({ partId })。" };
        });
      },
      addComposite: (args) => {
        if (typeof args.start !== "number" || !Number.isFinite(args.start)) throw new Error("start 要是秒数");
        if (args.parts !== undefined && !Array.isArray(args.parts)) throw new Error("parts 要是数组,每项 { partId, params?, frame?, enterMs?, children? }");
        // 没给 id 的实例补一个;validatePartTree 要求有 id,所以先补再校验
        const withIds = (list: unknown[]): unknown[] => list.map((raw) => {
          const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
          return { ...r, id: r.id ?? ("p" + Math.random().toString(36).slice(2, 8)), ...(Array.isArray(r.children) ? { children: withIds(r.children) } : {}) };
        });
        const parts = args.parts !== undefined ? validatePartTree(withIds(args.parts as unknown[]), getPart) : [];
        // 没给 frame 的实例用部件的 defaultFrame
        const fillFrames = (list: PartInstance[]): PartInstance[] => list.map((n) => ({
          ...n,
          ...(!n.frame && getPart(n.partId)?.defaultFrame ? { frame: { ...getPart(n.partId)!.defaultFrame! } } : {}),
          ...(n.children ? { children: fillFrames(n.children) } : {}),
        }));
        if (args.trackId !== undefined && !getState().project.tracks.some((t) => t.id === args.trackId)) throw new Error(`找不到序列 ${args.trackId}`);
        const clip = actions.addCardClip(COMPOSITE_CARD_ID, args.start, { trackId: args.trackId, duration: args.duration, parts: fillFrames(parts) });
        if (!clip) throw new Error("没有序列可放,先 add_track");
        clipGuard.noteCreated(clip.id);
        return { ok: true, clipId: clip.id, envelope: envelopeOf(getState().project, clip, getCard(COMPOSITE_CARD_ID), stageSize()), look: lookHint(clip.id), timeline: timelineDigest(getState().project) };
      },
      addPart: (args) => withParts(args.clipId, (tree) => addPartToTree(tree, { partId: args.partId, params: args.params, frame: args.frame as any, enterMs: args.enterMs, label: args.label }, getPart, { parentId: args.parentId ?? null, index: args.index }), (r) => ({ partInstanceId: r.node.id })),
      setPart: (args) => {
        // schema 里 type 只能是单一字符串(Gemini 不认数组 type),所以「清掉框」用 { clear: true } 表示,这里翻成 null
        const frame = args.frame && typeof args.frame === "object" && (args.frame as { clear?: boolean }).clear === true ? null : (args.frame as any);
        return withParts(args.clipId, (tree) => updatePartInTree(tree, args.partInstanceId, { params: args.params, frame, enterMs: args.enterMs, label: args.label }, getPart));
      },
      removePart: (args) => withParts(args.clipId, (tree) => ({ tree: removePartFromTree(tree, args.partInstanceId) })),
      movePart: (args) => withParts(args.clipId, (tree) => ({ tree: movePartInTree(tree, args.partInstanceId, { parentId: args.parentId || null, index: args.index }) })),
      // 约定封装:Agent 看到和改的都是它(kernel/envelope.ts),不是原始 clip 也不是组件源码
      getClip: (args) => {
        const hit = findClip(getState().project, args.clipId);
        if (!hit) throw new Error(`找不到 clip ${args.clipId}`);
        return envelopeOf(getState().project, hit.clip, getCard(hit.clip.cardId), stageSize());
      },
      setClip: (args) => {
        const hit = findClip(getState().project, args.clipId);
        if (!hit) throw new Error(`找不到 clip ${args.clipId}`);
        const report = applyEnvelope(
          getState().project, args.clipId, args.envelope, getCard(hit.clip.cardId), stageSize(),
          {
            setClipCard: (id, cardId) => actions.setClipCard(id, cardId),
            setClipParams: (id, params, opts) => actions.setClipParams(id, params, opts),
            moveClip: (id, patch) => actions.moveClip(id, patch),
            setClipFrame: (id, frame) => actions.setClipFrame(id, frame),
            updateClip: (id, patch) => actions.updateClip(id, patch),
            setClipParts: (id, parts) => actions.setClipParts(id, parts),
          },
          getCard,
        );
        if (report.changed.length) clipGuard.noteMutation();
        const after = findClip(getState().project, args.clipId)!;
        return {
          ok: true, clipId: args.clipId, changed: report.changed,
          envelope: envelopeOf(getState().project, after.clip, getCard(after.clip.cardId), stageSize()),
          look: lookHint(args.clipId), timeline: timelineDigest(getState().project),
        };
      },
      getLayout: (args) => {
        const p = getState().project;
        if (args?.clipId) {
          if (!findClip(p, args.clipId)) throw new Error(`找不到 clip ${args.clipId}`);
          return layoutOf(args.clipId);
        }
        const clips: Record<string, ReturnType<typeof layoutOf>> = {};
        for (const tr of p.tracks) for (const c of tr.clips) if (c.cardId) clips[c.id] = layoutOf(c.id);
        return { stage: stageSize(), clips };
      },
      removeClip: (args) => {
        // 门槛:删自己刚建的卡、或一口气连删一串,要 force + reason。理由回显给用户。见 toolEcho.ts。
        const a = args as { clipId: string; force?: boolean; reason?: string };
        const { reason } = clipGuard.checkRemove(a);
        actions.removeClip(a.clipId);
        clipGuard.noteRemoved(a.clipId);
        return { ok: true, removed: a.clipId, ...(reason ? { reason } : null), timeline: timelineDigest(getState().project) };
      },
      duplicateClip: (args) => { const c = actions.duplicateClip(args.clipId); if (!c) throw new Error("复制失败"); clipGuard.noteCreated(c.id); return c; },
      splitClip: (args) => {
        const lock = timingLock(getState().project, args.clipId);
        if (lock) throw new Error(`切不开:${lock.message}`);
        const c = actions.splitClip(args.clipId, args.t);
        if (!c) throw new Error("切分失败");
        clipGuard.noteCreated(c.id);
        return c;
      },
      setEmphasis: (args) => {
        const clipId = String(args.clipId ?? "");
        const kind = String(args.kind ?? "");
        if (!clipId) throw new Error("要 clipId");
        if (kind === "none") {
          const r = actions.setClipEmphasis(clipId, null);
          if (!r.ok) throw new Error(r.error ?? "去不掉");
          clipGuard.noteMutation();
          return { ok: true, clipId, emphasis: null, note: "强调去掉了" };
        }
        if (kind !== "shadow" && kind !== "outline") {
          throw new Error(`kind 只能是 shadow(阴影)/ outline(描边)/ none(去掉),收到 ${JSON.stringify(args.kind)}`);
        }
        const r = actions.setClipEmphasis(clipId, {
          kind, color: args.color, size: args.size, opacity: args.opacity, dx: args.dx, dy: args.dy,
        });
        if (!r.ok) throw new Error(r.error ?? "加不上");
        clipGuard.noteMutation();
        return {
          ok: true, clipId, emphasis: r.emphasis, describe: describeEmphasis(r.emphasis),
          look: lookHint(clipId),
          note: "强调沿着画面里不透明部分的边缘走(按 alpha 算),透明底的卡片、抠好的人物最明显;整块不透明的画面只会在方框外圈看到一条边。",
        };
      },
      setClipVolume: (args) => {
        const result = actions.setClipVolume(String(args.clipId), args.volume);
        if (!result.ok) throw new Error(result.error);
        clipGuard.noteMutation();
        return { ...result, timeline: timelineDigest(getState().project) };
      },
      separateAudio: (args) => {
        const result = actions.separateAudio(String(args.clipId));
        if (!result.ok) throw new Error(result.error);
        clipGuard.noteMutation();
        return { ...result, timeline: timelineDigest(getState().project) };
      },
      createAudio: (args) => {
        const mediaId = args.mediaId ? String(args.mediaId) : "";
        const clipId = args.clipId ? String(args.clipId) : "";
        if (!mediaId && !clipId) throw new Error("给 mediaId(素材库里派生一份声音)或 clipId(把时间轴上这一段就地转成声音)");
        if (mediaId && clipId) throw new Error("mediaId 和 clipId 只给一个:给 clipId 就是把那一段转成声音,顺带也会在素材库留一份");
        if (clipId) {
          const r = actions.convertClipToAudio(clipId);
          if (!r.ok) throw new Error(r.error);
          clipGuard.noteMutation();
          const p = getState().project;
          const m = p.media.find((x) => x.id === r.mediaId);
          return {
            ok: true, clipId, mediaId: r.mediaId, name: m?.name,
            note: r.already ? "这段本来就是声音,没动" : "这段现在只剩声音(画面没了),位置、长度、淡入淡出都留着;素材库里也多了这份声音",
            timeline: timelineDigest(p),
          };
        }
        const r = actions.audioFromVideo(mediaId);
        if (!r.ok) throw new Error(r.error);
        return {
          ok: true, mediaId: r.media.id, name: r.media.name, created: r.created,
          note: r.created
            ? "素材库里多了一份只有声音的素材(和源视频同一个文件,没转码),add_clip 传这个 mediaId 就是纯音频段"
            : "这段视频的声音素材早就派生过了,直接用这个 mediaId",
        };
      },
      listTransitions: () => {
        const p = getState().project;
        return {
          ok: true,
          transitions: transitionsOf(p).map((tr) => ({ ...tr, describe: describeTransition(p, tr) })),
          hint: "转场把它引用的片段绑成一组:那几段的相对时间关系锁住了,单独改时长 / 换序列 / 切开都会被拒。整组平移不受限制。要单独调先 remove_transition。",
        };
      },
      addTransition: (args) => {
        const kind = String(args.kind ?? "") as TransitionKind;
        if (!["crossfade", "fadeIn", "fadeOut"].includes(kind)) {
          throw new Error(`kind 只能是 crossfade / fadeIn / fadeOut,收到 ${JSON.stringify(args.kind)}`);
        }
        const r = actions.addTransition({ kind, clipId: args.clipId, otherClipId: args.otherClipId, dur: args.dur });
        if (!r.ok) throw new Error(r.error);
        clipGuard.noteMutation();
        const p = getState().project;
        return {
          ok: true, transition: r.transition, describe: describeTransition(p, r.transition),
          group: [r.transition.aId, ...(r.transition.bId ? [r.transition.bId] : [])],
          note: "这几段现在绑成一组:相对时间关系锁住了(整组平移仍然可以)。要单独调先 remove_transition。",
          timeline: timelineDigest(p),
        };
      },
      removeTransition: (args) => {
        const r = actions.removeTransition(String(args.transitionId ?? ""));
        if (!r.ok) throw new Error(r.error);
        clipGuard.noteMutation();
        return { ok: true, ...(r.note ? { note: r.note } : {}), timeline: timelineDigest(getState().project) };
      },
      /* ---------- 剪辑(多条时间轴) ---------- */
      listCuts: () => ({ activeCutId: getState().project.activeCutId, cuts: listCuts(getState().project) }),
      switchCut: (args) => {
        const cut = resolveCut(getState().project, args);
        actions.switchCut(cut.id);
        clipGuard.noteMutation();
        const p = getState().project;
        return { ok: true, activeCutId: p.activeCutId, cuts: listCuts(p), timeline: timelineDigest(p) };
      },
      addCut: (args) => {
        const cut = actions.addCut(args?.name, { switchTo: args?.switch !== false });
        clipGuard.noteMutation();
        const p = getState().project;
        return { ok: true, cut: { id: cut.id, name: cut.name }, activeCutId: p.activeCutId, cuts: listCuts(p) };
      },
      renameCut: (args) => {
        const cut = resolveCut(getState().project, { cutId: args.cutId });
        actions.renameCut(cut.id, args.name);
        return { ok: true, cuts: listCuts(getState().project) };
      },
      removeCut: (args) => {
        const p = getState().project;
        const cut = resolveCut(p, { cutId: args.cutId });
        const info = listCuts(p).find((c) => c.id === cut.id)!;
        // 门槛和 remove_clip 一个道理:有内容的剪辑不能一句话删掉,要 force + reason,理由回显给用户
        if (info.clipCount > 0 && !args.force) {
          throw new Error(`「${cut.name}」里有 ${info.clipCount} 段内容,不能直接删;确实要删就传 force:true 并在 reason 里写明理由`);
        }
        if (args.force && !(args.reason && args.reason.trim())) throw new Error("force 删除必须在 reason 里写明理由");
        const before = p.activeCutId;
        actions.removeCut(cut.id);
        clipGuard.noteMutation();
        const q = getState().project;
        return {
          ok: true, removed: cut.id,
          ...(before === cut.id ? { switchedTo: q.activeCutId } : null),
          ...(args.reason ? { reason: args.reason } : null),
          cuts: listCuts(q),
        };
      },
      addTrack: (args) => { const r = trackTools.addTrack(args); clipGuard.noteMutation(); return r; },
      listTracks: () => trackTools.listTracks(),
      removeTrack: (args) => { const r = trackTools.removeTrack(args); clipGuard.noteMutation(); return r; },
      updateTrack: (args) => { const r = trackTools.updateTrack(args); clipGuard.noteMutation(); return r; },
      moveTrack: (args) => { const r = trackTools.moveTrack(args); clipGuard.noteMutation(); return r; },
      listFilters: () => filterTools.listFilters(),
      createFilter: (args) => { const r = filterTools.createFilter(args); clipGuard.noteMutation(); return r; },
      updateFilter: (args) => { const r = filterTools.updateFilter(args); clipGuard.noteMutation(); return r; },
      removeFilter: (args) => { const r = filterTools.removeFilter(args); clipGuard.noteMutation(); return r; },
      applyFilter: (args) => { const r = filterTools.applyFilter(args); clipGuard.noteMutation(); return r; },
      listPixelMaps: () => pixelMapTools.listPixelMaps(),
      createPixelMap: (args) => { const r = pixelMapTools.createPixelMap(args); clipGuard.noteMutation(); return r; },
      updatePixelMap: (args) => { const r = pixelMapTools.updatePixelMap(args); clipGuard.noteMutation(); return r; },
      removePixelMap: (args) => { const r = pixelMapTools.removePixelMap(args); clipGuard.noteMutation(); return r; },
      applyPixelMap: (args) => { const r = pixelMapTools.applyPixelMap(args); clipGuard.noteMutation(); return r; },
      listMediaEffects: (args) => pixelMapTools.listMediaEffects(args),
      listAudioFx: () => audioFxTools.listAudioFx(),
      createAudioFx: (args) => { const r = audioFxTools.createAudioFx(args); clipGuard.noteMutation(); return r; },
      updateAudioFx: (args) => { const r = audioFxTools.updateAudioFx(args); clipGuard.noteMutation(); return r; },
      removeAudioFx: (args) => { const r = audioFxTools.removeAudioFx(args); clipGuard.noteMutation(); return r; },
      applyAudioFx: (args) => { const r = audioFxTools.applyAudioFx(args); clipGuard.noteMutation(); return r; },
      measureAudio: (args) => measureAudio(args),
      seek: (args) => { actions.seek(args.t); return { ok: true }; },
      play: () => { actions.play(); return { ok: true }; },
      pause: () => { actions.pause(); return { ok: true }; },
      setTheme: (args) => { actions.setProjectMeta({ themeId: args.themeId }); return { ok: true }; },
      setProjectMeta: (args) => { actions.setProjectMeta(args); return { ok: true }; },
      /**
       * 三维总开关。**只认 fov,不收相机距离** —— 距离是 fov 和画布高度推出来的,
       * 让人填距离的话换个画幅透视强度就变了(见 kernel/space3d.ts 里的那张表)。
       * 关掉时把字段整个删掉而不是设 0:老项目没有这个字段,存盘结果要和从没开过三维一样。
       */
      setCamera3d: (args) => {
        const hasFov = args?.fovDeg !== undefined && args.fovDeg !== null;
        /*
         * 非数字直接抛,不走 clampFov。
         * clampFov 对 NaN 返回默认值 40,于是 set_camera3d({fovDeg:"很强"}) 会得到
         * 「fovDeg 被夹到 40(允许 5~120)」—— Agent 以为自己传的数字越界了,
         * 其实是**类型**就错了,它会去调数字而不是去改类型。
         * 同一个仓库里 framePatchFromArgs 对非数字就是直接抛,两处要一个标准。
         */
        if (hasFov && (typeof args.fovDeg !== "number" || !Number.isFinite(args.fovDeg))) {
          throw new Error(`fovDeg 必须是有限数字(${MIN_FOV_DEG}~${MAX_FOV_DEG}),收到 ${JSON.stringify(args.fovDeg)}`);
        }
        const turnOff = args?.enabled === false;
        if (turnOff) {
          /*
           * 关掉时把调过的 fov 记在一边。不记的话「关掉看看对比、再打开」会静悄悄
           * 退回默认 40 —— 用户调到 60 的那个感觉没了,而且没有任何提示。
           * 记在 store 之外的模块变量里:它不该进项目文件(存盘结果要和从没开过三维一样)。
           */
          const remembered = getState().project.camera3dFov ?? getState().lastCamera3dFov ?? undefined;
          actions.setProjectMeta({ camera3dFov: undefined });
          actions.rememberCamera3dFov(remembered ?? null);
          return {
            ok: true,
            enabled: false,
            hint: `三维已关。卡片上的 rotateX/rotateY/translateZ 还在,只是不再有透视${remembered ? `;再打开(enabled:true)会回到 ${remembered}°` : ""}`,
          };
        }
        if (!hasFov && args?.enabled !== true) {
          const cur = getState().project;
          return {
            ok: true,
            enabled: !!cur.camera3dFov,
            fovDeg: cur.camera3dFov ?? null,
            hint: "什么都没传,这里只是报了下当前状态。要打开传 fovDeg(或 enabled:true),要关掉传 enabled:false",
          };
        }
        const fov = clampFov(hasFov ? args.fovDeg : (getState().project.camera3dFov ?? getState().lastCamera3dFov ?? DEFAULT_FOV_DEG));
        actions.setProjectMeta({ camera3dFov: fov });
        const cur = getState().project;
        const cam = cameraFor({ width: cur.width, height: cur.height }, fov);
        return {
          ok: true,
          enabled: true,
          fovDeg: fov,
          ...(hasFov && fov !== args.fovDeg
            ? { clamped: `fovDeg 被夹到 ${fov}(允许 ${MIN_FOV_DEG}~${MAX_FOV_DEG})` }
            : null),
          cameraDistancePx: Math.round(cam.distance),
          hint: "现在 set_position 的 rotateX / rotateY / translateZ 会走真透视了。改完用 see_frames 看一眼 —— 透视强度只能看,算不出来",
        };
      },

      // ── 语音转文字 ────────────────────────────────────────────────
      backgroundJobStatus: ({ jobId }) => {
        // 听写、运动追踪、主体检测各有一张作业表。只查第一张的话,track_install /
        // subject_install 返回的 jobId 拿过来一定是「找不到」,而那条消息会把人
        // 引向「是不是重启了」。
        const job = sttJobs.get(jobId) ?? trackInstallJobs.get(jobId) ?? subjectInstallJobs.get(jobId)
          ?? collectInstallJobs.get(jobId);
        if (!job) throw new Error('找不到后台任务，可能已重启。');
        return { jobId, ...job };
      },
      /**
       * 把用户用「+」发进来的附件装进素材库。
       *
       * 附件落在对话的工作目录(.pc-work)里,那和项目素材库是两回事 ——
       * 模型能在提示词里看到附件的地址和磁盘路径,却没有任何工具能把它搬过去,
       * 于是 list_media 一直是空的,只能回一句「请你先手动导入」。这个工具补上那一步。
       *
       * 实现上取回文件再走 importVideoFiles,也就是用户拖拽导入走的同一条路:
       * 同样探测时长宽高、同样登记 MediaAsset、同样落到视频轨、同样上传拿到磁盘路径。
       * 多一次取回的开销,换的是「AI 导入」和「人工导入」结果完全一致。
       */
      // ── 素材收集:从网页链接抓视频 ──────────────────────────────────
      collectStatus: () => collectStatus(),

      // 站内搜索:给「从 B 站找素材」用。每条要单独探测,limit 封顶 10
      collectSearch: async (args) => {
        if (!args.query) throw new Error("要传 query(关键词)");
        const r = await searchVideos(args.query, { site: args.site, limit: args.limit });
        if (!r.ok) {
          throw new Error(
            (r.error || "搜索失败")
            + (r.notInstalled ? "(拓展没装,先 collect_install)" : "")
            + (r.notes?.length ? `;过程:${r.notes.join(" / ")}` : ""),
          );
        }
        const results = r.results ?? [];
        return {
          query: r.query, site: r.site, count: results.length, results, notes: r.notes,
          hint: results.length
            ? "按标题、时长、播放量挑一条,把它的 url 交给 collect_probe(看清晰度)或直接 collect_download。"
            : "没搜到可下载的视频,换个关键词再搜;B 站搜索结果里的课程、番剧不算。",
        };
      },

      // 安装是 pip 装 yt-dlp,几十秒,立刻回 jobId,和 subject_install 一个路数
      collectInstall: async () => {
        const jobId = `collect-${Date.now().toString(36)}`;
        collectInstallJobs.set(jobId, { done: false, ok: false, logTail: [] });
        void installCollect((line) => {
          const job = collectInstallJobs.get(jobId);
          if (job) job.logTail = [...job.logTail, line].slice(-20);
        })
          .then(({ ok }) => {
            const job = collectInstallJobs.get(jobId);
            collectInstallJobs.set(jobId, { done: true, ok, logTail: job?.logTail ?? [] });
          })
          .catch((e: unknown) => {
            const job = collectInstallJobs.get(jobId);
            collectInstallJobs.set(jobId, {
              done: true, ok: false,
              error: e instanceof Error ? e.message : String(e),
              logTail: job?.logTail ?? [],
            });
          });
        return {
          jobId, started: true,
          hint: "yt-dlp 正在后台安装(约 3 MB)。用 background_job_status 查这个 jobId,或用 collect_status 看 ready 有没有变 true。不要重复启动。",
        };
      },

      collectProbe: async (args) => {
        if (!args.url) throw new Error("要传 url(视频页链接、BV 号或短链)");
        const info = await probeLink(args.url, { site: args.site, quality: args.quality });
        if (!info.ok) {
          throw new Error(
            (info.error || "探测失败")
            + (info.notInstalled ? "(拓展没装,先 collect_install)" : "")
            + (info.notes?.length ? `;过程:${info.notes.join(" / ")}` : ""),
          );
        }
        return {
          ...info,
          hint: info.parts
            ? `这是多 P 稿件(${info.parts.length} P),collect_download 默认只取链接指定的那一 P,要全部就传 allParts: true。`
            : "可以 collect_download 了;不指定 quality 就是 1080。",
        };
      },

      // 下载几十秒到几分钟,立刻回 jobId,结果用 collect_job 轮询;下完自动登记进素材库
      collectDownload: async (args) => {
        if (!args.url) throw new Error("要传 url(视频页链接、BV 号或短链)");
        const { jobId, reused } = await startDownload(args.url, {
          quality: args.quality, site: args.site,
          audioOnly: args.audioOnly, allParts: args.allParts, cookies: args.cookies,
        });
        if (!collectJobs.has(jobId)) {
          collectJobs.set(jobId, { imported: false, mediaIds: [] });
          waitForDownload(jobId, (job) => {
            const rec = collectJobs.get(jobId);
            if (rec) rec.job = job;
          })
            .then(async (job) => {
              const rec = collectJobs.get(jobId);
              if (!rec || rec.imported) return;
              rec.imported = true;
              rec.job = job;
              for (const item of job.items) {
                try {
                  rec.mediaIds.push(await importVideoFromServer({ url: item.url, path: item.path, name: item.filename }));
                } catch (e: unknown) {
                  rec.error = `下载好了但登记素材失败:${e instanceof Error ? e.message : String(e)}`;
                }
              }
            })
            .catch((e: unknown) => {
              const rec = collectJobs.get(jobId);
              if (rec) rec.error = e instanceof Error ? e.message : String(e);
            });
        }
        return {
          jobId, started: true, reused: !!reused,
          hint: reused
            ? "这条链接已经在下了,直接用 collect_job 轮询这个 jobId。"
            : "下载已在服务端后台开始。用 collect_job 轮询(隔 3 秒问一次),done 且带 mediaIds 才算收进素材库。",
        };
      },

      collectJob: async ({ jobId }) => {
        const rec = collectJobs.get(jobId);
        if (!rec) throw new Error("找不到这个下载作业。它不是本页发起的,或者页面刷新过 —— 重新 collect_download 一次(已下好的文件会被复用)。");
        const job = rec.job;
        if (rec.error) {
          return { jobId, status: "error", message: rec.error, notes: job?.notes ?? [], stage: job?.stage };
        }
        if (!job) return { jobId, status: "running", stage: "starting", percent: 0 };
        const base = {
          jobId, status: job.status, stage: job.stage, percent: job.percent,
          speed: job.speed, eta: job.eta, info: job.info, notes: job.notes,
        };
        if (job.status === "error") return { ...base, message: job.message };
        if (job.status !== "done" || !rec.imported) {
          return { ...base, status: "running", hint: job.status === "done" ? "文件下好了,正在登记进素材库" : undefined };
        }
        const media = getState().project.media;
        return {
          ...base,
          mediaIds: rec.mediaIds,
          items: job.items.map((it, i) => {
            const m = media.find((x) => x.id === rec.mediaIds[i]);
            return {
              mediaId: rec.mediaIds[i], title: it.title, path: it.path, bytes: it.bytes,
              duration: m?.duration ?? it.duration, width: m?.width ?? it.width, height: m?.height ?? it.height,
              vcodec: it.vcodec, transcoded: !!it.transcoded, uploader: it.uploader, webpage_url: it.webpage_url,
            };
          }),
          hint: "已装进素材库并放到视频轨上。要做字幕就 transcribe_media,要配动效先 detect_shots。",
        };
      },

      // ── 登录:把站点登录页挪到用户面前扫码,扫完取 cookie 存盘,之后下载自动带上 ──
      // 登录框弹在编辑台里:扫码(二维码就画在框里)或浏览器(站点自己的登录页,账号密码也行)
      collectLogin: async (args) => {
        const site = args.site || "bilibili";
        const method = args.method === "browser" ? "browser" : "qr";
        if (!args.force) {
          const saved = (await cookieStatus().catch(() => ({} as Record<string, never>)))[site];
          if (saved?.loggedIn) {
            return {
              ok: true, alreadyLoggedIn: true, site, userId: saved.userId, expiresAt: saved.expiresAt,
              hint: `已经登录(用户 ${saved.userId ?? "?"},${saved.expiresAt ? `到 ${saved.expiresAt} 过期` : "会话有效"}),不用再登;要换账号传 force: true。`,
            };
          }
        }
        openCollectLogin(site, method);
        return {
          ok: true, site, method, opened: true,
          hint: method === "qr"
            ? "登录框已经在编辑台里弹出来,二维码在框里。**现在停下来**,用中文告诉用户:用手机客户端扫框里的二维码并确认;想用账号密码就点框里的「账号密码 / 短信」。登录完回一句,之后再调 collect_login_check。不要替用户输账号密码和验证码。"
            : "登录框已经弹出来,用户点「打开登录页」后会出现站点自己的登录页。**现在停下来**,告诉用户在那里登录(账号密码 / 短信 / 扫码都行),登录完回一句,之后再调 collect_login_check。不要替用户输账号密码和验证码。",
        };
      },

      collectLoginCheck: async (args) => {
        const r = await collectLoginCheck(args.site || "bilibili", args.hide !== false);
        if (!r.ok) throw new Error(r.error || "读不到浏览器里的登录态");
        if (!r.loggedIn) {
          return { ...r, hint: `${r.hint ?? "还没登录"}。缺:${(r.missing ?? []).join(", ") || "无"}。让用户在窗口里完成登录后回话,再查一次;不要连着轮询。` };
        }
        return {
          ...r,
          hint: `登录态已存盘(用户 ${r.userId ?? "?"},${r.expiresAt ? `到 ${r.expiresAt} 过期` : "会话有效"}),窗口已藏回。之后 collect_probe / collect_download 会自动带上,不用传 cookies。`,
        };
      },

      collectLogout: async (args) => {
        const r = await collectLogout(args.site || "bilibili");
        return { ...r, hint: r.removed ? "登录态已删除,之后按未登录画质下载。" : "本来就没有存盘的登录态。" };
      },

      importMedia: async (args) => {
        const url = args.url;
        if (!url) throw new Error("要传附件的站内地址(url,形如 /@pcwork/<会话id>/<文件名>)。用户消息末尾的附件清单里有。");
        let res: Response;
        try {
          res = await fetch(url);
        } catch (e) {
          throw new Error(`取附件失败:${e instanceof Error ? e.message : String(e)}`);
        }
        if (!res.ok) throw new Error(`取附件失败(HTTP ${res.status}),地址可能不对或附件已过期:${url}`);
        const blob = await res.blob();
        let name = args.name || decodeURIComponent(url.split("?")[0].split("/").pop() || "attachment");
        // 网图直链常常不带扩展名(images.unsplash.com/photo-123…):按 MIME 补一个,
        // 落盘后 /@media 才给得出对的 Content-Type,素材库里也分得清是什么
        const MIME_EXT: Record<string, string> = {
          "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
          "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav",
        };
        const mimeExt = MIME_EXT[blob.type.split(";")[0].trim().toLowerCase()];
        if (mimeExt && !/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${mimeExt}`;
        const file = new File([blob], name, { type: blob.type || "" });
        const detected = classifyFileDetailed(file);
        if (!detected.kind) {
          throw new Error(detected.reason || `无法识别文件“${name}”的类型，请使用视频、音频或图片文件。`);
        }
        const kind = detected.kind;
        if (kind !== "video") {
          const id = await registerAsset(file, kind);
          const media = getState().project.media.find((m) => m.id === id);
          return {
            mediaId: id,
            name,
            kind,
            kindLabel: KIND_LABEL[kind],
            ...(kind === "image" ? { width: media?.width, height: media?.height } : { duration: media?.duration }),
            cardUrl: media ? mediaCardUrl(media) : "",
            hint: kind === "image"
              ? "图片已进“图片”素材库(没放到时间轴)。卡片参数里要用这张图就填 cardUrl;想看它长什么样用 see_frames({ source: \"media\", mediaId })。"
              : "音频已进素材库(没放到时间轴)。",
          };
        }
        const ids = await importVideoFiles([file]);
        if (ids.length === 0) throw new Error("导入失败,没有登记成素材。");
        const media = getState().project.media.find((m) => m.id === ids[0]);
        return {
          mediaId: ids[0],
          name,
          kind,
          kindLabel: KIND_LABEL[kind],
          duration: media?.duration,
          width: media?.width,
          height: media?.height,
          cardUrl: media ? mediaCardUrl(media) : "",
          hint: "已装进素材库并放到视频轨上。要做字幕就先 transcribe_media,再 add_clip 建 caption-track 并用 fill_captions 灌入。",
        };
      },

      voiceList: async () => {
        const { config, presets } = await getVoiceConfig();
        return {
          provider: config.provider,
          apiKeySet: config.apiKey.set,
          defaults: { minimax: config.minimax, kling: config.kling, vidu: config.vidu },
          systemVoices: presets.systemVoices,
          customVoices: config.customVoices.map((v) => ({ provider: v.provider, voiceId: v.voiceId, name: v.name, kind: v.kind, note: v.note })),
          textLimits: presets.textLimits,
          hint: config.apiKey.set
            ? "voice_generate 的 voiceId 从 systemVoices / customVoices 里挑(customVoices 要配对 provider)。"
            : "还没配 API Key,voice_generate 会失败。告诉用户去「配音设置」(开始页的配音卡、编辑台顶栏都能打开)里填 API Key。",
        };
      },

      voiceGenerate: async (args) => {
        if (!args.text || !String(args.text).trim()) throw new Error("text 不能是空的");
        const r = await generateVoice({
          text: args.text, provider: args.provider, voiceId: args.voiceId,
          speed: args.speed, emotion: args.emotion, name: args.name,
        });
        const mediaId = await importAudioFromServer({ url: r.url, path: r.path, name: r.name });
        const media = getState().project.media.find((m) => m.id === mediaId);
        let clipId: string | undefined;
        if (typeof args.start === "number") {
          const clip = actions.addMediaClip(mediaId, Math.max(0, args.start), { trackId: args.trackId });
          if (!clip) throw new Error(`语音已进素材库(mediaId ${mediaId}),但放上时间轴失败 —— trackId 不对?`);
          clipId = clip.id;
        }
        return {
          mediaId, name: r.name, duration: media?.duration, clipId,
          provider: r.provider, model: r.model, voiceId: r.voiceId, chars: r.chars,
          hint: clipId
            ? "已进素材库并放到时间轴。下一段的 start 接在这段 start + duration 后面。"
            : "已进素材库(没放时间轴)。要上时间轴就传 start 再生成,或者用户可以自己从素材库拖。",
        };
      },

      sttStatus: () => sttStatus(),

      // 安装可能远超 MCP 桥的 60 秒调用超时,所以立刻返回 jobId,
      // 让 AI 用 stt_status 轮询 engines.<engine>.installed 判断是否装完。
      sttInstall: async (args) => {
        // 和启动时那个缺依赖提示走同一条路径(含「同时只许一个安装」的互斥),
        // 所以不管谁发起的,界面上的进度控件表现完全一致。
        const { jobId, engine, finished } = runSttInstall(args.engine || "faster-whisper");
        sttJobs.set(jobId, { done: false, ok: false, logTail: [] });
        finished.then(({ ok, error }) => {
          const job = getInstallJob(jobId);
          sttJobs.set(jobId, { done: true, ok, error, logTail: job?.logTail.slice(-20) ?? [] });
        });
        return {
          jobId, started: true, engine,
          hint: "安装已在后台开始,用户界面上会显示带进度的安装动画。用 background_job_status 查这个 jobId,或用 stt_status 看该引擎的 installed 字段。不要重复启动。",
        };
      },

      // 同理:转写通常超过 60 秒,立刻返回 jobId,结果用 get_transcript 轮询。
      transcribeMedia: async (args) => {
        const jobId = `stt-${args.mediaId}-${Date.now().toString(36)}`;
        transcribeMedia(args.mediaId, { engine: args.engine, model: args.model, language: args.language })
          .then((t) => { sttJobs.set(jobId, { done: true, ok: true, segments: t.segments.length }); })
          .catch((e: unknown) => {
            sttJobs.set(jobId, { done: true, ok: false, error: e instanceof Error ? e.message : String(e) });
          });
        sttJobs.set(jobId, { done: false, ok: false });
        return { jobId, started: true, mediaId: args.mediaId, hint: "转写已在后台开始,请用 get_transcript 轮询该 mediaId" };
      },

      // 镜头识别:5 分钟素材约 36 秒,同样立刻返回 jobId,结果用 list_shots 轮询。
      detectShots: async (args) => {
        const media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        if (media.kind !== "video") throw new Error(`${media.name} 不是视频,没有镜头可分`);
        if (!media.path) throw new Error(`${media.name} 没有服务端可读的路径,重新导入一次再试`);
        if (media.shots && !args.force) {
          return {
            reused: true, mediaId: args.mediaId, engine: media.shots.engine,
            shots: media.shots.shots.length, transitions: media.shots.transitions.length,
            hint: "这个素材已经检测过了,直接用 list_shots 取结果;要重测传 force:true",
          };
        }
        const jobId = await startShotDetection(media.path, media.id);
        shotJobs.set(args.mediaId, { jobId, percent: 0, engine: "scdet" });
        waitForShots(jobId, (percent, engine) => shotJobs.set(args.mediaId, { jobId, percent, engine }))
          .then((result) => {
            actions.setMediaShots(args.mediaId, result);
            shotJobs.delete(args.mediaId);
          })
          .catch((e: unknown) => {
            shotJobs.set(args.mediaId, {
              jobId, percent: 0, engine: "scdet",
              error: e instanceof Error ? e.message : String(e),
            });
          });
        return {
          jobId, started: true, mediaId: args.mediaId,
          hint: "镜头识别已在后台开始,请用 list_shots 轮询该 mediaId",
        };
      },

      listShots: (args) => {
        const media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        const pending = shotJobs.get(args.mediaId);
        if (pending?.error) throw new Error(pending.error);
        if (!media.shots) {
          if (pending) return { running: true, percent: pending.percent, engine: pending.engine };
          return null;
        }
        // 每个镜头带上这段区间里的主体情况。**这是「别遮住人脸」那条路的落点**:
        // 模型拿到 suggestedPosition 就能直接填进卡片的 position,不用靠看图猜。
        // 没检测过就是 null,并在返回里给一句 hint 指向 detect_subjects ——
        // 不给这句的话模型只会看到一堆 subject: null,以为「这素材里没有人」。
        const subjectPending = subjectJobs.get(args.mediaId);
        return {
          running: false,
          engine: media.shots.engine,
          // 没装拓展时只有硬切,这一句要让模型看见,免得它以为片子里真的没有溶解
          engineNote: media.shots.engine === "scdet"
            ? "当前用的是 ffmpeg scdet 兜底,只认硬切,溶解等渐变转场检测不出来"
            : "TransNetV2,硬切和溶解都认得",
          shots: media.shots.shots.map((s) => ({
            ...s,
            subject: subjectDigest(subjectForRange(media.subjects, s.start, s.end)),
          })),
          transitions: media.shots.transitions.map(({ thumbs, ...rest }) => rest),
          // 顺序有讲究(复查实测):
          //   1. 上次作业失败 —— 不管手里有没有旧结果都先说。失败的作业留在表里,以前会一直回
          //      「正在跑(0%)」,模型照着无限轮询一个死掉的作业;有旧结果时以前还会回成功那套话,
          //      和 list_subjects 抛错的口径对不上。
          //   2. 作业在跑 —— 有旧结果时下面的 subject 是旧批次的,要说明。
          //   3. 没检测过。
          //   4. 有结果但每个镜头都是 null —— 整批采样全抽帧失败,这不是「画面里没有人」。
          //   5. 有结果。
          ...(subjectPending?.error
            ? {
                subjectHint: `上次主体检测失败:${subjectPending.error}。`
                  + (media.subjects ? "下面每个镜头的 subject 来自更早成功的那一批,不是这次的。" : "")
                  + "先调 subject_status 看 engine:为 null 说明这台机器上两档都用不了(没有兜底档),"
                  + "退回 see_frames({ source: 'timeline', t }) 看真实画面判断人在哪,**不要继续轮询本工具**;"
                  + "engine 不为 null 才值得调 detect_subjects 并传 force:true 重试。",
              }
            : subjectPending
              ? {
                  subjectHint: `主体检测正在跑(${subjectPending.percent}%),跑完再调一次本工具就能看到每个镜头的人物位置`
                    + (media.subjects ? ";下面的 subject 是上一批的结果,新一批跑完会替换" : ""),
                }
              : !media.subjects
                ? {
                    subjectHint: "这些镜头还没做主体检测,所以每个 subject 都是 null。要决定卡片放哪边、"
                      + "别遮住人物的脸,先调 detect_subjects 拿人物位置。",
                  }
                : media.shots.shots.every((s) => subjectForRange(media.subjects, s.start, s.end) === null)
                  ? {
                      subjectEngine: media.subjects.engine,
                      subjectFailedCount: media.subjects.failedCount ?? 0,
                      subjectHint: `主体检测跑完了,但这一批 ${media.subjects.samples.length} 个采样没有一个可用`
                        + "(全部抽帧失败,见 subjectFailedCount),所以每个 subject 都是 null —— 这不是「画面里没有人」。"
                        + "换几个时刻用 detect_subjects 传 times 重测,或退回 see_frames({ source: 'timeline', t }) 看图。",
                    }
                  : {
                      subjectEngine: media.subjects.engine,
                      ...(media.subjects.failedCount
                        ? { subjectFailedCount: media.subjects.failedCount }
                        : null),
                      ...(media.subjects.fellBackFrom
                        ? {
                            subjectFellBackFrom: media.subjects.fellBackFrom,
                            subjectFallbackNote: `本来要跑 full 档,中途退回了 light:${media.subjects.fallbackReason ?? "原因未知"}。`
                              + "所以 prompt 没生效,label 只可能是 person / face。",
                          }
                        : null),
                      subjectHint: "每个镜头的 subject.suggestedPosition 可以直接填进卡片的 params.position"
                        + "(只会是 left / right / bottom,不会返回 center);boxes 是原始视频像素的人物框。"
                        + "suggestedPosition 为 null 表示四档全被人物占住(看 suggestedOccupancy 和 warning),"
                        + "那个镜头没有不遮人的位置,别硬填。"
                        + "能不能填以 list_cards({cardId}) 的 controls 为准,卡片不支持这个值就换一张卡,"
                        + "不要退回默认的居中 —— 居中正是人脸所在。",
                    }),
        };
      },

      // 运动追踪:250 帧约 26 秒,同样立刻返回 jobId,结果用 get_track 轮询。
      // 结果不写进项目文档——查询点是每次现指的,同一段素材能追很多组,
      // 塞进 project 只会让工程文件无限膨胀,所以只留在内存里。
      trackPoints: async (args) => {
        const media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        if (media.kind !== "video") throw new Error(`${media.name} 不是视频,没有运动可追`);
        if (!media.path) throw new Error(`${media.name} 没有服务端可读的路径,重新导入一次再试`);
        if (!Array.isArray(args.points) || args.points.length === 0) {
          throw new Error("points 至少要有一个点,写成 [[帧号, x, y], ...]");
        }

        const jobId = await startTracking(media.path, media.id, args.points);
        trackJobs.set(args.mediaId, { jobId, percent: 0 });
        waitForTrack(jobId, (percent, engine) =>
          trackJobs.set(args.mediaId, { jobId, percent, engine }))
          .then((result) => {
            trackResults.set(args.mediaId, result);
            trackJobs.delete(args.mediaId);
          })
          .catch((e: unknown) => {
            trackJobs.set(args.mediaId, {
              jobId, percent: 0,
              error: e instanceof Error ? e.message : String(e),
            });
          });
        return {
          jobId, started: true, mediaId: args.mediaId, points: args.points.length,
          hint: "运动追踪已在后台开始,请用 get_track 轮询该 mediaId",
          // 装没装拓展决定用哪一档,也决定要等多久:同样 250 帧,
          // 神经网络档约 26 秒,模板匹配约 1 秒。
          engineHint: "哪一档在跑要等结果出来才知道,看 get_track 返回的 engine",
        };
      },

      /**
       * 默认只回摘要,不回逐帧坐标。
       *
       * 一段 30 秒 30fps 的片子,每个点是 900 组坐标 —— 原样吐给模型是好几万
       * token,而模型通常根本不需要它们:要让卡片跟着走就调 attach_clip_motion,
       * 数据在应用内部直接流转,不必绕模型一圈。full:true 是留给「模型真的要
       * 自己算点什么」的口子,不是默认路径。
       */
      getTrack: (args) => {
        const media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        const pending = trackJobs.get(args.mediaId);
        if (pending?.error) throw new Error(pending.error);
        const result = trackResults.get(args.mediaId);
        if (!result) {
          if (pending) return { running: true, percent: pending.percent, engine: pending.engine };
          return null;
        }
        const head = {
          running: false,
          engine: result.engine,
          // 降级档要让模型看见,否则它会拿模板匹配的粗结果当准数据下判断
          engineNote: result.engine === "bootstapir"
            ? "BootsTAPIR,任意点追踪,visible 为 false 表示该帧被遮挡或移出画面"
            : "当前是模板匹配兜底(未装运动追踪拓展)。刚体、纹理清晰、不转向的目标能追得很准,"
              + "但目标一旦转向、缩放或长时间被挡就会跟丢;某个点带 note 字段表示它压根没追成",
          width: result.width,
          height: result.height,
          frames: result.frames,
        };
        if (args.full) return { ...head, points: result.points };
        return {
          ...head,
          points: result.points.map((p, i) => {
            const vis = p.visible.filter(Boolean).length;
            const xs = p.xy.map((q) => q[0]);
            const ys = p.xy.map((q) => q[1]);
            return {
              index: i,
              query: p.query,
              visibleFrames: vis,
              totalFrames: p.visible.length,
              // 位移范围:接近 0 说明目标基本没动,绑上去也看不出效果
              movedX: Math.round(Math.max(...xs) - Math.min(...xs)),
              movedY: Math.round(Math.max(...ys) - Math.min(...ys)),
              from: p.xy[0]?.map((v) => Math.round(v)),
              to: p.xy[p.xy.length - 1]?.map((v) => Math.round(v)),
              ...(p.note ? { note: p.note } : {}),
            };
          }),
          hint: "只给了摘要。要让卡片跟着某个点走就调 attach_clip_motion(不用把坐标读出来);"
            + "确实需要逐帧坐标时传 full:true,但那会是很长一串数字。",
        };
      },

      trackStatus: async () => {
        const s = await trackStatus();
        return {
          ...s,
          hint: s.engine === "bootstapir"
            ? "已装拓展,走 BootsTAPIR。"
            : s.engine === "template"
              ? "未装拓展,走模板匹配兜底 —— 能追,但目标转向、形变或长时间被挡时会跟丢。"
                + "用户要更稳的结果就用 track_install 装拓展(约 400 MB)。"
              : "两档都用不了(通常是找不到 Python),这台机器上追不了。",
        };
      },

      // 400 MB 的下载,远超 MCP 桥的调用超时,所以立刻返回 jobId。
      trackInstall: async () => {
        const jobId = `track-${Date.now().toString(36)}`;
        trackInstallJobs.set(jobId, { done: false, ok: false, logTail: [] });
        void installTrack((line) => {
          const job = trackInstallJobs.get(jobId);
          if (job) job.logTail = [...job.logTail, line].slice(-20);
        })
          .then(({ ok }) => {
            const job = trackInstallJobs.get(jobId);
            trackInstallJobs.set(jobId, { done: true, ok, logTail: job?.logTail ?? [] });
          })
          .catch((e: unknown) => {
            const job = trackInstallJobs.get(jobId);
            trackInstallJobs.set(jobId, {
              done: true, ok: false,
              error: e instanceof Error ? e.message : String(e),
              logTail: job?.logTail ?? [],
            });
          });
        return {
          jobId, started: true,
          hint: "运动追踪拓展正在后台安装(torch + 权重约 400 MB,要几分钟)。"
            + "用 background_job_status 查这个 jobId,或用 track_status 看 engine 有没有变成 bootstapir。不要重复启动。",
        };
      },

      // ── 主体检测 ────────────────────────────────────────────────
      // 「别让卡片遮住人物的脸」这类要求的正路:抽几帧看人在哪、哪边是空的,
      // 结果按镜头折进 list_shots 的 suggestedPosition。

      /**
       * 抽帧检测。采样时刻默认按镜头算(每镜头 20%/50%/80%,短镜头只取中点),
       * 没做过镜头识别就每 2 秒一点 —— 见 sampleTimesFor。
       *
       * 结果写进项目文档,同一素材默认复用,要重测才传 force:true。
       * 换了 prompt 也当成要重测:提示词变了,上一批结果里根本没有那个类别。
       */
      detectSubjects: async (args) => {
        const media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        if (media.kind === "audio") throw new Error(`${media.name} 是音频,没有画面可看`);
        if (!media.path) throw new Error(`${media.name} 没有服务端可读的路径,重新导入一次再试`);

        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        const promptChanged = !!media.subjects && prompt !== (media.subjects.prompt ?? "");
        // 复用不能只比 prompt 字符串,还要看已存结果**有没有能力**回答这个 prompt。
        // light 档带 prompt 跑出来的结果 label 只可能是 person/face;用户之后装上
        // full 拓展包再问同一句,只比字符串的话仍然 reused:true + engine light,
        // 模型于是继续拿一份根本没找过猫的结果回答「画面里没有猫」。
        // 但还要看**这台机器现在**能不能跑到 full。只装了 light 的机器上,已存结果是 light、
        // 现在也只能跑出 light,重测毫无意义 —— 只看已存结果的档位的话,同一句 prompt 每问
        // 一次全量重测一次,模型会「重测→还是 light→再重测」地绕圈(复查实测)。
        // 所以 subjectStatus 提前到这里查:复用判据和后面算 ETA 共用这一次。
        const st = await subjectStatus().catch(() => null);
        const staleEngine = !!media.subjects && !!prompt
          && media.subjects.engine !== "full" && st?.engine === "full";
        if (media.subjects && !args.force && !promptChanged && !staleEngine) {
          const cannotAnswerPrompt = !!prompt && media.subjects.engine !== "full";
          return {
            reused: true, mediaId: args.mediaId, engine: media.subjects.engine,
            samples: media.subjects.samples.length,
            failedCount: media.subjects.failedCount ?? 0,
            prompt: media.subjects.prompt,
            ...(cannotAnswerPrompt
              ? { engineNote: "已有结果是 light 档跑的,label 只有 person / face,答不了提示词里别的名词;"
                  + "这台机器现在也只能跑 light,所以没有重测。装了 full 拓展包之后再传 force:true 重测。" }
              : null),
            hint: "这个素材已经检测过了,直接用 list_subjects 取结果,或用 list_shots 看每个镜头的 suggestedPosition;要重测传 force:true",
          };
        }

        // 上限夹在 kernel 里(MAX_SUBJECT_TIMES,和服务端同一个常数)。
        // 拿「不设限时会排出多少点」一比,就知道这次降没降精度 —— 降过要说出来,
        // 不然模型会拿一份被抽稀过的结论当满精度用。
        const autoRaw = subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length;
        const times = Array.isArray(args.times) && args.times.length > 0
          ? args.times.map(Number).filter((t) => Number.isFinite(t) && t >= 0)
          : subjectSampleTimes(media);
        if (times.length === 0) throw new Error("算不出采样时刻,素材可能没有时长信息;可以自己传 times");
        const sampledNote = !args.times && autoRaw > times.length
          ? `素材偏长或镜头偏碎,采样已从 ${autoRaw} 点降到 ${times.length} 点`
            + `(上限 ${MAX_SUBJECT_TIMES});镜头级的结论会更粗,approximate 为 true 的镜头会变多。`
          : undefined;

        // engine 用上面复用判据查到的那一次:轮询之前就让模型知道跑的是哪一档,以及大概要等多久。
        // 两档差一个数量级(实测 light 约 0.5 s/帧、full 约 3 s/帧),按同一个节奏
        // 轮询的话不是白问几十次就是等得莫名其妙。查不到不算错,给 undefined。
        const engine = st?.engine ?? null;
        const msPerFrame = engine === "full" ? 3000 : engine === "light" ? 500 : 0;
        const etaSeconds = engine ? Math.ceil((times.length * msPerFrame) / 1000) + 5 : undefined;

        const jobId = await startSubjectDetection(media.path, media.id, times, prompt || undefined);
        // 旧的 error 记录要先清掉:不清的话新作业和上一次的失败状态串味,
        // list_shots 会拿着一条陈年错误报「上次主体检测失败」。
        subjectJobs.delete(args.mediaId);
        subjectJobs.set(args.mediaId, { jobId, percent: 0 });
        waitForSubjects(jobId, (percent, engine) =>
          subjectJobs.set(args.mediaId, { jobId, percent, engine }))
          .then((result) => {
            actions.setMediaSubjects(args.mediaId, result);
            subjectJobs.delete(args.mediaId);
          })
          .catch((e: unknown) => {
            subjectJobs.set(args.mediaId, {
              jobId, percent: 0,
              error: e instanceof Error ? e.message : String(e),
            });
          });
        return {
          jobId, started: true, mediaId: args.mediaId,
          samples: times.length,
          sampledFrom: media.shots ? "按镜头(每个镜头 20%/50%/80%)" : "每 2 秒一点(这段素材还没做镜头识别)",
          ...(sampledNote ? { sampledNote } : null),
          engine,
          ...(etaSeconds ? { etaSeconds } : null),
          ...(staleEngine
            ? { staleEngine: true, engineNote: "上一批结果是 light 档跑的,答不了提示词,所以这次重测(不是复用)" }
            : null),
          hint: "主体检测已在后台开始,用 list_subjects 轮询该 mediaId;"
            + (etaSeconds
              ? `预计 ${etaSeconds} 秒左右(engine=${engine},实测 light 约 0.5 秒/帧、full 约 3 秒/帧)。`
                + `${engine === "full" ? "full 档慢,隔 10 秒问一次就够" : "隔 3 秒问一次就够"},别每秒都问。`
              : "engine 为 null 表示两档都用不了,这个作业多半会失败;先调 subject_status 确认。")
            + "跑完之后 list_shots 的每个镜头会带上 subject 和 suggestedPosition。",
        };
      },

      listSubjects: (args) => {
        const media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        const pending = subjectJobs.get(args.mediaId);
        if (pending?.error) throw new Error(pending.error);
        // 有作业在跑就先报在跑 —— 哪怕手里还有上一批结果。以前是「有旧结果就直接回旧结果」,
        // 换了 prompt 重测期间模型读到的是旧 prompt 的样本,还以为新的已经跑完了(复查实测)。
        if (pending) {
          return {
            running: true, percent: pending.percent, engine: pending.engine,
            ...(media.subjects
              ? { stale: true, staleNote: "上一批结果还在,但新一次检测正在跑,这里不给样本;跑完再调一次本工具" }
              : null),
          };
        }
        if (!media.subjects) return null;
        const s = media.subjects;
        return {
          running: false,
          engine: s.engine,
          // 哪一档决定了 label 里能出现什么。不说清楚的话,模型会把 light 档
          // 「只有 person/face」读成「画面里没有猫」。
          engineNote: s.engine === "full"
            ? "Grounding DINO,label 是提示词里的名词;prompt 为空时按 person . face . 找"
            : "YuNet + RT-DETR 的 light 档,只认 person 和 face,提示词不生效(原样回显在 prompt 里)",
          ...(s.fellBackFrom
            ? {
                fellBackFrom: s.fellBackFrom,
                fallbackNote: `本来要跑 full 档,中途退回了 light:${s.fallbackReason ?? "原因未知"}。`
                  + "所以 prompt 没生效,label 只可能是 person / face。",
              }
            : null),
          prompt: s.prompt,
          width: s.width,
          height: s.height,
          // 抽帧失败的采样单独报个数。它们在 JSON 里和「这一帧真的没有人」逐字段相同
          // (boxes 空、occupancy 四个 0),不点出来的话模型会把「没抽到」读成「没有人」。
          failedCount: s.failedCount ?? s.samples.filter((sm) => sm.failed).length,
          samples: s.samples.map((sm) => ({
            t: sm.t,
            ...(sm.failed
              ? { failed: true, reason: sm.reason ?? "这一帧没抽出来", boxes: [], boxCount: 0 }
              : {
                  safeSide: sm.safeSide,
                  ...suggestPosition(sm.safeSide, sm.occupancy),
                  occupancy: sm.occupancy,
                  boxes: topBoxes(sm.boxes),
                  boxCount: sm.boxes.length,
                }),
          })),
          hint: "坐标是原始视频像素(和 width/height 同一套)。要按镜头排卡片就直接看 list_shots,"
            + "那边每个镜头已经把这些采样折好了。suggestedPosition 可直接填进卡片的 params.position"
            + "(只会是 left / right / bottom,不会返回 center);为 null 表示四档都被人物占住,"
            + "看 suggestedOccupancy 和 warning,那一刻没有不遮人的位置。"
            + "failed 为 true 的采样是抽帧失败,不是「这一帧没有人」,不要拿它下结论。",
        };
      },

      subjectStatus: async () => {
        const s = await subjectStatus();
        return {
          ...s,
          hint: s.engine === "full"
            ? "full 档:YuNet + RT-DETR + Grounding DINO,能按任意文字提示找目标(prompt 生效)。"
            : s.engine === "light"
              ? "light 档:YuNet(人脸) + RT-DETR(人体),只认 person 和 face,prompt 不生效。"
                + "要按任意词找目标(猫、手机、红色的车)得装 full 档拓展库包。"
              // 这里没有兜底档,和运动追踪不一样 —— 不能让模型以为还有个降级引擎在跑。
              : "两档都用不了,这台机器上检测不了主体。"
                + "位置和遮挡的判断退回 see_frames 看图,不要凭空猜「人在左边」。"
                + "用户想要就用 subject_install 装 light 档(约 30 MB)。",
        };
      },

      // 在线装的是 light 档(onnxruntime,约 30 MB)。full 档是 torch + transformers
      // 加 690 MB 权重,只随拓展库包发,在线装中断一次就得从头来。
      subjectInstall: async () => {
        const jobId = `subject-${Date.now().toString(36)}`;
        subjectInstallJobs.set(jobId, { done: false, ok: false, logTail: [] });
        void installSubject((line) => {
          const job = subjectInstallJobs.get(jobId);
          if (job) job.logTail = [...job.logTail, line].slice(-20);
        })
          .then(({ ok }) => {
            const job = subjectInstallJobs.get(jobId);
            subjectInstallJobs.set(jobId, { done: true, ok, logTail: job?.logTail ?? [] });
          })
          .catch((e: unknown) => {
            const job = subjectInstallJobs.get(jobId);
            subjectInstallJobs.set(jobId, {
              done: true, ok: false,
              error: e instanceof Error ? e.message : String(e),
              logTail: job?.logTail ?? [],
            });
          });
        return {
          jobId, started: true,
          hint: "主体检测 light 档正在后台安装(onnxruntime,约 30 MB)。"
            + "用 background_job_status 查这个 jobId,或用 subject_status 看 engine 有没有变成 light。不要重复启动。"
            + "装完还可能缺权重文件(yunet.onnx / rtdetr_r18vd.onnx),那要跑拓展库包的 .exe 才有。",
        };
      },

      /**
       * 把一张卡绑到一条轨迹上,让它跟着画面里的目标走。
       *
       * 这是追踪功能真正的落点 —— 在此之前,追出来的坐标只是一串数字,
       * 没有任何东西消费它。
       *
       * 数据不经过模型:模型只说「clip X 跟 point 0」,逐帧坐标在应用内部
       * 从 trackResults 直接烘进 clip。让模型把 900 组坐标读进来再写回去,
       * 既烧上下文又必然出错。
       */
      attachClipMotion: (args) => {
        const p = getState().project;
        const hit = findClip(p, args.clipId);
        if (!hit) throw new Error(`找不到片段 ${args.clipId}`);
        if (!hit.clip.cardId) throw new Error(`${args.clipId} 是素材段,不是卡片段,没有「跟着走」这回事`);

        const media = p.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);

        const result = trackResults.get(args.mediaId);
        if (!result) {
          throw new Error(trackJobs.get(args.mediaId)
            ? `${media.name} 的追踪还没跑完,先用 get_track 等它出结果`
            : `${media.name} 还没追过,先调 track_points`);
        }
        const idx = args.pointIndex ?? 0;
        const point = result.points[idx];
        if (!point) throw new Error(`这次追踪只有 ${result.points.length} 个点,没有第 ${idx} 个`);
        if (point.note) throw new Error(`第 ${idx} 个点没追成:${point.note}`);

        // 画面来自哪一段素材:必须和卡片在时间上真的重叠,否则卡片会跟着
        // 一个当时根本没在播的画面走。
        const source = p.tracks
          .flatMap((t) => t.clips)
          .filter((c) => c.mediaId === args.mediaId)
          .find((c) => c.start < hit.clip.end && c.end > hit.clip.start);
        if (!source) {
          throw new Error(`时间轴上没有一段 ${media.name} 和这张卡在时间上重叠 —— `
            + `卡片放在 ${hit.clip.start.toFixed(2)}~${hit.clip.end.toFixed(2)}s,那段时间画面上没有这个素材`);
        }

        const built = buildClipMotion({
          xy: point.xy,
          visible: point.visible,
          media: {
            id: media.id,
            width: media.width ?? 0,
            height: media.height ?? 0,
            duration: media.duration ?? 0,
          },
          stage: { width: p.width, height: p.height },
          card: { start: hit.clip.start, end: hit.clip.end },
          clipOfMedia: { start: source.start, mediaOffset: source.mediaOffset ?? 0 },
          pointIndex: idx,
          whenHidden: args.whenHidden === "hide" ? "hide" : "hold",
        });

        if (!actions.setClipMotion(args.clipId, built.motion)) {
          throw new Error(`绑定失败:写不进片段 ${args.clipId}`);
        }

        const { frames, visibleFrames, rangeX, rangeY } = built.summary;
        return {
          ok: true,
          clipId: args.clipId,
          mediaId: args.mediaId,
          pointIndex: idx,
          engine: result.engine,
          frames,
          visibleFrames,
          movedX: rangeX,
          movedY: rangeY,
          whenHidden: built.motion.whenHidden,
          // 两种「绑了等于没绑」要当场说破,不能让用户自己去预览里发现
          ...(rangeX < 2 && rangeY < 2
            ? { warning: "这个点几乎没动(位移不到 2 像素),绑上去看不出跟随效果" }
            : {}),
          ...(visibleFrames < frames * 0.5
            ? { warning2: `一半以上的帧(${frames - visibleFrames}/${frames})目标不可见,`
                + `跟随会大段停住${built.motion.whenHidden === "hide" ? "或整张卡消失" : ""}` }
            : {}),
        };
      },

      detachClipMotion: (args) => {
        const hit = findClip(getState().project, args.clipId);
        if (!hit) throw new Error(`找不到片段 ${args.clipId}`);
        if (!hit.clip.motion) return { ok: true, clipId: args.clipId, changed: false, hint: "这张卡本来就没绑轨迹" };
        actions.setClipMotion(args.clipId, undefined);
        return { ok: true, clipId: args.clipId, changed: true };
      },

      getTranscript: (args) => {
        const media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        const t = media.transcript;
        if (!t) return null;
        // 契约:超过 200 段时只返回前 200 段 + 总数
        if (t.segments.length > 200) {
          return { ...t, segments: t.segments.slice(0, 200), total: t.segments.length, truncated: true };
        }
        return { ...t, total: t.segments.length, truncated: false };
      },
      /**
       * 把素材文字稿直接灌进一张字幕卡。
       *
       * 字幕内容是纯搬运,让模型把几十上百条 `起|止|文字` 一条条重打一遍
       * 既贵又容易错行、错时间、漏段。这里在本地一次算完,模型只需要说
       * "给这段配字幕",拿到的是已经填好的结果。
       */
      fillCaptions: (args) => {
        const project = getState().project;
        const media = args.mediaId
          ? project.media.find((m) => m.id === args.mediaId)
          : project.media.find((m) => m.transcript && m.transcript.segments.length > 0);
        if (!media) throw new Error(args.mediaId ? `找不到素材 ${args.mediaId}` : "素材库里没有已转写的素材,先用 transcribe_media 转写。");
        const segments = media.transcript?.segments;
        if (!segments || segments.length === 0) throw new Error(`素材「${media.name}」还没有文字稿,先用 transcribe_media 转写。`);

        // 没指定 clip 就找时间轴上唯一那张字幕卡;有多张时要求说清楚是哪一张
        let clipId = args.clipId;
        if (!clipId) {
          const hits = project.tracks.flatMap((t) => t.clips.filter((c) => (c as { cardId?: string }).cardId === "caption-track"));
          if (hits.length === 0) throw new Error("时间轴上没有 caption-track 卡片。先 add_clip 建一张,或直接传 clipId。");
          if (hits.length > 1) throw new Error(`时间轴上有 ${hits.length} 张字幕卡,请用 clipId 指明是哪一张:${hits.map((c) => c.id).join(", ")}`);
          clipId = hits[0].id;
        }
        const hit = findClip(project, clipId);
        if (!hit) throw new Error(`找不到 clip ${clipId}`);
        const clip = hit.clip as { start: number; end: number; cardId?: string };
        if (clip.cardId !== "caption-track") throw new Error(`clip ${clipId} 是 ${clip.cardId},不是字幕卡。`);

        /*
         * 文字稿的秒数是**素材内**的,得先按这份素材在时间轴上的位置换算过去
         * (素材被挪到第 30 秒、或者修掉了开头,不换算字幕就整体错位),
         * 再减去字幕卡起点变成相对秒。跨出卡片的段落裁到边界内,
         * 免得字幕在卡片外提前亮或不消失。
         */
        const placed = project.tracks.flatMap((t) => t.clips);
        const plan = captionsFromTranscript(placed, media.id, segments, { from: clip.start, to: clip.end });
        if (plan.lines.length === 0) {
          const onTimeline = placed.some((c) => c.mediaId === media.id);
          throw new Error(
            onTimeline
              ? `文字稿里没有落在这张卡时段(${clip.start}s–${clip.end}s)内的段落,检查一下 clip 的起止时间。`
              : `素材「${media.name}」还没放到时间轴上,字幕对不上时间。先 add_clip 把它放上去。`,
          );
        }

        const kept = plan.lines;
        const params = { lines: formatCaptions(kept), showEn: args.showEn === true ? "true" : "false" };
        validateCardParams("caption-track", params, (hit.clip as { params?: Record<string, unknown> }).params);
        actions.setClipParams(clipId, params);
        return { clipId, mediaId: media.id, lines: kept.length, from: clip.start, to: clip.end };
      },
      /**
       * 字幕卡里到底有哪几条:下标 + 相对秒 + 绝对秒 + 文字。
       * 改字幕前先看这个,index 以它为准(按时间排,和时间轴上画出来的顺序一致)。
       */
      listCaptions: (args) => {
        const hit = findCaptionClip(args.clipId);
        const clip = hit.clip as { start: number; end: number; params?: Record<string, unknown> };
        const lines = captionsOf(clip);
        return {
          clipId: hit.clip.id,
          from: clip.start,
          to: clip.end,
          count: lines.length,
          captions: lines.map((l, index) => ({
            index,
            start: l.start,
            end: l.end,
            // 相对秒容易和时间轴上的秒搞混,两个都给
            absStart: clip.start + l.start,
            absEnd: clip.start + l.end,
            text: l.zh,
            ...(l.en ? { en: l.en } : {}),
          })),
        };
      },
      /**
       * 单条字幕的增删改。整份重灌走 fill_captions,这里是给「第 3 条说错了」用的。
       *
       * 时间由 kernel/captions 夹在左右邻居之间,所以 Agent 写一个越界的秒数不会
       * 弄出两条抢同一秒的字幕 —— 会贴到边上,并在返回里告诉它实际落在哪。
       */
      editCaption: (args) => {
        const hit = findCaptionClip(args.clipId);
        const clipId = hit.clip.id;
        const op = args.op ?? "edit";

        if (op === "remove") {
          if (args.index == null) throw new Error("remove 要给 index(list_captions 里的下标)");
          const lines = captionsOf(hit.clip as { params?: Record<string, unknown> });
          const gone = lines[args.index];
          if (!gone) throw new Error(`这张字幕卡只有 ${lines.length} 条,没有第 ${args.index} 条`);
          if (!actions.removeCaption(clipId, args.index)) throw new Error("删除失败");
          return { clipId, removed: describeCaption(gone, args.index), count: lines.length - 1 };
        }

        if (op === "insert") {
          if (args.start == null) throw new Error("insert 要给 start(相对字幕卡起点的秒)");
          if (!args.text) throw new Error("insert 要给 text");
          const at = actions.addCaption(clipId, { start: args.start, end: args.end, zh: args.text, en: args.en });
          if (at < 0) throw new Error(`${args.start}s 附近没有放得下的空当了 —— 先用 list_captions 看看哪儿是空的,或者把邻近那条改短。`);
          const now = captionsOf(findCaptionClip(clipId).clip as { params?: Record<string, unknown> });
          return { clipId, index: at, caption: describeCaption(now[at], at), count: now.length };
        }

        if (args.index == null) throw new Error("edit 要给 index(list_captions 里的下标)");
        if (args.text === undefined && args.en === undefined && args.start === undefined && args.end === undefined) {
          throw new Error("edit 至少要给 text / en / start / end 里的一个");
        }
        const at = actions.editCaption(clipId, args.index, {
          start: args.start,
          end: args.end,
          zh: args.text,
          en: args.en,
        });
        if (at < 0) throw new Error(`改不了第 ${args.index} 条,先用 list_captions 确认下标`);
        const now = captionsOf(findCaptionClip(clipId).clip as { params?: Record<string, unknown> });
        return { clipId, index: at, caption: describeCaption(now[at], at), count: now.length };
      },
      /**
       * 现场建一张新卡片。源码落到 src/cards/user/<id>.tsx,vite HMR 编译后
       * 自动注册,list_cards 立刻能看到 —— 不用重启,也不用改任何注册表文件。
       */
      createCard: async (args) => {
        const res = await fetch("/api/cards/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...args,
            id: args.id,
            source: args.source,
            overwrite: args.overwrite === true,
            existingIds: allCards().map((c) => c.id),
            // 盖归属戳:定制卡默认只属于建它的这个项目(见 editor/cardScope.ts)
            projectId: getState().project.id ?? undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `建卡失败(HTTP ${res.status})`);
        if (data.definition?.language === 'python') {
          let instance: { clipId: string; nodeId: string } | undefined;
          actions.editCardProject(project => {
            const next = saveCardDefinition(project, data.definition, { overwrite: args.overwrite });
            if (!args.apply) return next;
            const result = applyCardDefinition(next, { ...args.apply, cardId: args.id });
            instance = { clipId: result.clipId, nodeId: result.nodeId };
            return result.project;
          });
          return { ...data, ...(instance || {}), savedWithProject: true };
        }
        refreshScopes();
        return data;
      },
      /**
       * 读回一张卡的源码(用户卡和内置卡都行)。改卡的第一步 —— 不读回来就改,等于凭记忆重写。
       * 带 file 读这张卡用到的某个部件 / vendor 文件。
       */
      getCardSource: async (args) => {
        const definition = getState().project.cardDefinitions?.find(def => def.id === args.cardId);
        if (definition?.language === 'python') return { ok: true, id: definition.id, language: 'python', definition,
          source: definition.source, entry: definition.entry, savedWithProject: true };
        const q = new URLSearchParams({ id: args.cardId, ...(args.file ? { file: args.file } : {}) });
        const res = await fetch(`/api/cards/source?${q}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `读不到卡片源码(HTTP ${res.status})`);
        return data;
      },
      /** 局部替换式改卡(带 file 改部件文件)。整篇重写交给 createCard,那条路只该走一次(建卡)。 */
      editCard: async (args) => {
        const definition = getState().project.cardDefinitions?.find(def => def.id === args.cardId);
        const res = await fetch("/api/cards/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: args.cardId, file: args.file, find: args.find, replace: args.replace, replaceAll: args.replaceAll === true,
            ...(definition?.language === 'python' ? { definition, metadata: args.metadata } : {}) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `改卡失败(HTTP ${res.status})`);
        if (data.definition) actions.editCardProject(project => {
          if (project.cardDefinitions?.find(def => def.id === args.cardId)?.source !== definition?.source) throw new Error('Card changed while editing; read current source again');
          return saveCardDefinition(project, data.definition, { overwrite: true });
        });
        return data;
      },
      applyCard: (args) => {
        let instance: { clipId: string; nodeId: string } | undefined;
        actions.editCardProject(project => {
          const result = applyCardDefinition(project, args); instance = { clipId: result.clipId, nodeId: result.nodeId }; return result.project;
        });
        return { ok: true, ...instance };
      },
      /**
       * 只读地看一张卡某一刻的 DOM 树(每个节点标出源码位置)。project 从这里带过去,理由和 see_frames 一样:
       * 时间轴的真身在浏览器 store 里,服务端手上那份(上次保存的)可能已经是旧的。
       */
      inspectCardDom: async (args) => {
        const ref = typeof args.ref === "string" ? Number(String(args.ref).replace(/^ref_/, "")) : args.ref;
        // 兜底路径:有数据镜像时服务端直接问预渲染。这里也发到预渲染的源上,60 秒(工具上限)就放手
        const res = await fetch(await prerenderUrl("/api/cards/dom"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: getState().project, clipId: args.clipId, t: args.t, ref, depth: args.depth }),
          signal: AbortSignal.timeout(60000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `读不到 DOM 树(HTTP ${res.status})`);
        return data;
      },
      /**
       * 把画面渲染成图交给模型看。
       *
       * project 是从这里带过去的,不是让服务端自己去读:时间轴的真身在浏览器 store 里,
       * 服务端手上那份(上次保存的)可能已经是旧的 —— 让模型看一张过时的画面,比不给它看更糟。
       */
      /**
       * 看素材:按镜头拼图分页交给模型(规划在 src/ai/sequences.ts,拼图由 /api/vision/sheet 用 ffmpeg 做)。
       * 没跑过镜头识别就在这里跑并等它 —— 模型要看的是画面,别让它先学一套「起作业、轮询」的流程;
       * 识别失败退回固定 10 秒一段,返回里标 fallback 让它知道边界不是真镜头。
       */
      seeSequences: async (args) => {
        let media = getState().project.media.find((m) => m.id === args.mediaId);
        if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
        /*
         * 图片直接把图本身交回去。以前只认视频:图片要么被拒,要么(被错登记成 video 的老 jpg)
         * 跑一遍镜头识别得到一个 0.04 秒的「镜头」—— 模型认定「抽不出画面」,转头去 Read 磁盘路径。
         * 在编辑器页面里取,blob: 和 /@media 都取得到;长边缩到 1280,够看清又不撑爆上下文。
         */
        if (isImageMedia(media)) {
          const src = media.url || mediaCardUrl(media);
          if (!src) throw new Error(`${media.name} 没有可取的地址(上传没完成?),稍后再试`);
          const r = await fetch(src);
          if (!r.ok) throw new Error(`取图片失败(HTTP ${r.status}):${media.name}`);
          const bmp = await createImageBitmap(await r.blob());
          const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(bmp.width * scale));
          canvas.height = Math.max(1, Math.round(bmp.height * scale));
          canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
          return {
            ok: true,
            mediaId: media.id,
            name: media.name,
            kind: "image",
            width: bmp.width,
            height: bmp.height,
            cardUrl: mediaCardUrl(media),
            note: "这是一张图片,下面就是它本身(长边缩到 1280 以内)。卡片参数里要用它就填 cardUrl。",
            __images: [{ sceneIndex: 1, label: "原图", mime: "image/jpeg", base64 }],
          };
        }
        if (media.kind !== "video") throw new Error(`${media.name} 不是视频,没有画面可看`);
        // 刚导入的素材,服务端路径要等上传完才写进来(import_media 一返回模型就可能接着调这里):最多等 15 秒
        for (let i = 0; i < 30 && !media.path; i++) {
          await new Promise((r) => setTimeout(r, 500));
          media = getState().project.media.find((m) => m.id === args.mediaId) ?? media;
        }
        if (!media.path) throw new Error(`${media.name} 没有服务端可读的路径(上传没完成或失败),稍后再试或重新导入`);
        const notes: string[] = [];
        let shots = media.shots ?? null;
        if (!shots) {
          const pending = shotJobs.get(args.mediaId);
          try {
            let jobId = pending && !pending.error ? pending.jobId : "";
            if (!jobId) {
              jobId = await startShotDetection(media.path, media.id);
              shotJobs.set(args.mediaId, { jobId, percent: 0, engine: "scdet" });
            }
            const result = await waitForShots(jobId, (percent, engine) => shotJobs.set(args.mediaId, { jobId, percent, engine }));
            actions.setMediaShots(args.mediaId, result);
            shotJobs.delete(args.mediaId);
            shots = result;
            notes.push(`刚跑完镜头识别(${result.engine}),共 ${result.shots.length} 个镜头。`);
          } catch (e) {
            notes.push(`镜头识别没成功(${e instanceof Error ? e.message : String(e)}),下面按每 10 秒一段切,边界不是真镜头。`);
          }
        }
        const { scenes: all, fallback } = scenesOf(shots, media.duration ?? 0);
        if (!all.length) throw new Error(`${media.name} 没有可看的画面(时长为 0?)`);
        const plan = planSequences(all, args);
        // 拼图一张一张要,最多 3 张并行:每张是一次 ffmpeg,全开会把机器压死
        const results: any[] = new Array(plan.scenes.length);
        let cursor = 0;
        const worker = async () => {
          for (;;) {
            const i = cursor++;
            if (i >= plan.scenes.length) return;
            const sc = plan.scenes[i];
            try {
              const r = await fetch(await prerenderUrl("/api/vision/sheet"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ media: { id: media.id, name: media.name, kind: media.kind, url: media.url, path: media.path }, start: sc.start, end: sc.end, grid: plan.grid }),
              });
              const d = await r.json().catch(() => ({}));
              if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
              results[i] = d;
            } catch (e) {
              results[i] = { error: e instanceof Error ? e.message : String(e) };
            }
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        const images: { sceneIndex: number; mime: string; base64: string }[] = [];
        const scenesOut = plan.scenes.map((sc, i) => {
          const r = results[i];
          if (r?.__image?.base64) images.push({ sceneIndex: sc.index, mime: r.__image.mime || "image/jpeg", base64: r.__image.base64 });
          const text = transcriptFor(media.transcript, sc.start, sc.end);
          return {
            index: sc.index,
            start: sc.start,
            end: sc.end,
            duration: Math.round((sc.end - sc.start) * 100) / 100,
            in: sc.inTransition,
            out: sc.outTransition,
            frames: r?.frames ?? frameTimes(sc.start, sc.end, plan.grid),
            ...(text ? { transcript: text } : {}),
            subject: subjectDigest(subjectForRange(media.subjects, sc.start, sc.end)),
            ...(r?.error ? { imageError: r.error } : {}),
          };
        });
        return {
          ok: true,
          mediaId: media.id,
          name: media.name,
          engine: shots?.engine ?? null,
          ...(fallback ? { fallback } : {}),
          page: plan.page, pages: plan.pages, perPage: plan.perPage, grid: plan.grid,
          nextPage: plan.nextPage, prevPage: plan.prevPage,
          matched: plan.matched, totalScenes: plan.totalScenes,
          scenes: scenesOut,
          note: [
            ...notes,
            `每张拼图对应 scenes 里同序号的镜头,格子按行从左到右对应 frames 里的秒数。`,
            plan.nextPage ? `还有 ${plan.pages - plan.page} 页:see_frames({ source: "media", mediaId, page: ${plan.nextPage} })。` : "这是最后一页。",
            "某个镜头看不清:see_frames({ source: 'media', mediaId, scene: 序号, grid: 9 })。",
            !media.transcript ? "这个素材还没转写,想对照说了什么先 transcribe_media。" : "",
          ].filter(Boolean).join(" "),
          __images: images,
        };
      },
      seePreview: async (args) => {
        const state = getState();
        /*
         * 这条是兜底:有数据镜像时 see_frames 由服务端直接问预渲染(vite-plugin-ai 的服务端工具),
         * 根本不经过这个页面。走到这里时也发到预渲染的源上,并且和工具上限一样 180 秒就放手 ——
         * 放手之后连接断开,预渲染会把还在排队的活摘掉,不会白占一个 Chrome。
         */
        const snap = async (t: number | undefined) => {
          const res = await fetch(await prerenderUrl("/api/vision/snapshot"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project: state.project,
              t: t ?? (args?.clipId ? undefined : state.t),
              clipId: args?.clipId,
            }),
            signal: AbortSignal.timeout(180000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `渲染画面失败(HTTP ${res.status})`);
          return data;
        };
        /*
         * times:一次看多个时刻。reviewer 判断镜头节奏要对比好几个时刻,一张一张调太慢,
         * 也容易看漏。**一次请求、服务端一趟渲完**(从第 0 帧顺推,沿途截这几帧),每张标上时刻。
         * 以前逐个时刻各请求一次,每张都从第 0 帧重推,推进的成本按时刻数成倍涨。
         * 上限 10 张,和 harness 里保留的截图数对齐 —— 多了前面的会被挤掉。
         */
        const times = Array.isArray(args?.times) ? args.times.filter((x: unknown) => typeof x === "number").slice(0, 10) : [];
        if (times.length) {
          const res = await fetch(await prerenderUrl("/api/vision/snapshot"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project: state.project, times, clipId: args?.clipId }),
            signal: AbortSignal.timeout(180000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `渲染画面失败(HTTP ${res.status})`);
          return { ok: true, frames: data.frames, note: data.note, __images: data.__images };
        }
        return snap(typeof args?.t === "number" ? args.t : undefined);
      },
      bakeCard: async (args) => {
        // 兜底路径:有数据镜像时 bake_card 由服务端直接问预渲染。这里也发到预渲染的源上,150 秒(工具上限)就放手
        const res = await fetch(await prerenderUrl("/api/vision/bake"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: getState().project,
            clipId: args.clipId,
            t: args.t,
            size: args.size,
            bg: args.bg,
          }),
          signal: AbortSignal.timeout(150000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `烘焙失败(HTTP ${res.status})`);
        return data;
      },
      cardAuthoringGuide: async () => {
        const res = await fetch("/api/cards/guide");
        if (!res.ok) throw new Error(`拿不到建卡指南(HTTP ${res.status})`);
        return { guide: await res.text() };
      },
      autoWorkflow: (args) => runAutoWorkflow(args),
      autoWorkflowStatus: (args) => getAutoWorkflowStatus(args)
    };
    
    const cleanup = connectMcpExecutor(() => api, (s) => setMcpConnected(s.connected));
    return cleanup;
  }, []);

  // 右栏整列:左边一张宿主卡片(显示右侧 rail 选中项的页面),右边贴窗口边缘的竖向 rail(侧边自由布局,editor/dock/)。
  // 对话式布局下右侧一个 AI 类项都没有时整列不显示 —— 只是 display:none,RightPanel 和里面的一切照旧挂着
  const mode = useLayoutMode();
  const showRight = useSideVisible("right", mode);

  return (
    <>
      <div className="pc-right" data-pc="right" style={{ display: showRight ? undefined : "none" }}>
        <DockHost side="right" />
        <RailBar side="right" />
      </div>
      {/*
        所有页面(五个分区、剧本页、各 AiPanel)在这里各渲染一次,portal 进各自的固定节点,两侧宿主只挪 DOM 节点。
        RightPanel 在 Editor 网格里永远占同一个兄弟槽位、从不卸载,所以拖动 / 切换 / 收起 / 换布局模式都不会让 AiPanel 卸载重建。
        排在宿主后面:宿主的布局效应先跑、先登记,页面内容的布局效应跑的时候节点已经挂进文档
      */}
      <DockPages mcpConnected={mcpConnected} />
      {/* 站点登录框:开始页的卡和 collect_login 工具都会打开它,挂在这里才能在编辑台里出现 */}
      <CollectLoginDialog />
      {/* 配音设置子窗口:顶栏的「配音设置」按钮开它 */}
      <VoiceSettingsDialog />
      {/* 桌面壳模式下 agent 交出浏览器时的浮层(Chrome 方案下永远不会打开) */}
      <AgentBrowserFrame />
    </>
  );
}
