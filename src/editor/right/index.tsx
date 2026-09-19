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
import { applyCardDefinition } from "../../kernel/cardAuthoring.mjs";
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
  framePatchFromArgs, worldOf, rectToFrame, alignToFrame, alignIsInvisible, nudgeFrame, clampToStage, rectForSafeSide, frameBox,
  type Size,
} from "../../kernel/layout";
import { backRole, backStage, syncProject } from "../stageBridge";
import type { RectWithBounds } from "../../render/solid";
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

type ContentBox = { left: number; top: number; width: number; height: number } | null;
const roundBox = (b: { left: number; top: number; width: number; height: number }): ContentBox =>
  ({ left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) });

/**
 * 卡片的**实体内容**框:文字、图片、有底色的盒子这些真正画了东西的元素的并集,透明容器穿过去。
 * 判「会不会盖住人」要看它,不是画布框 —— 默认卡的画布 1920 宽,拿画布判永远是"会盖住"。
 *
 * **批量、一次往返**(D4 页面侧):把全部 clipId 一起问后台舞台(pinned 架构 4:用户交互的查询
 * 跑在自己的离屏舞台,不打预渲染;第 3 步只有一个舞台,先对它测)——
 *   先把当前 project 同步过去、setTime 到播放头,再 rectsWithBounds({ pixels: 'all' }) 一次拿回全部实体框。
 * 素材段的 contentBox 一律等于其 frameCss 框(不在舞台里,按项目数据算)。
 * 卡片此刻不在画面上(播放头不在它的区间)就量不到:contentBox 为 null 并附 contentNote,别当成"没内容"。
 */
async function measureContentBoxes(clipIds: string[]): Promise<Map<string, { contentBox: ContentBox; contentNote?: string }>> {
  const st = getState();
  const out = new Map<string, { contentBox: ContentBox; contentNote?: string }>();
  const stage = stageSize();
  const cardIds: string[] = [];
  for (const id of clipIds) {
    const hit = findClip(st.project, id);
    if (!hit) { out.set(id, { contentBox: null, contentNote: `找不到 clip ${id}` }); continue; }
    if (!hit.clip.cardId) { out.set(id, { contentBox: roundBox(frameBox(hit.clip.frame, stage)) }); continue; }
    cardIds.push(id);
  }
  if (!cardIds.length) return out;
  const s = backStage();
  if (!s) {
    for (const id of cardIds) out.set(id, { contentBox: null, contentNote: "预览窗口没就绪,量不到内容框;稍后再 get_layout" });
    return out;
  }
  let list: RectWithBounds[] = [];
  try {
    await syncProject(backRole(), st.project);
    // 量之前先退出实体模式:播放中画面上是色块,量到的就是色块的框而不是内容的框(只在 ?proxy=1 的页面有效)
    await s.setProxy(false);
    await s.setTime(st.t);
    list = await s.rectsWithBounds({ pixels: "all", clipIds: cardIds });
  } catch (err) {
    for (const id of cardIds) out.set(id, { contentBox: null, contentNote: `舞台没回应,量不到内容框:${err instanceof Error ? err.message : String(err)}` });
    return out;
  } finally {
    try { await s.setProxy(st.playing); } catch { /* 恢复失败不该让工具失败 */ }
  }
  for (const id of cardIds) {
    const r = list.find((x) => x.clipId === id);
    if (!r) {
      const hit = findClip(st.project, id);
      const range = hit ? `${hit.clip.start}~${hit.clip.end}s` : "?";
      out.set(id, { contentBox: null, contentNote: `这张卡此刻不在画面上(播放头 ${st.t}s 不在它的 ${range} 区间内),先 seek 进它的时段再读` });
      continue;
    }
    out.set(id, { contentBox: roundBox(r.bounds ?? r.rect) });
  }
  return out;
}

/**
 * 定位工具返回的布局(**纯计算**,不打舞台):local 是存下来的框(没设过为 null),world 是算出来的画面
 * 绝对位置(box 画布、visualBox 缩放旋转后)。写工具(set_position / set_rect / align / nudge)只回这个;
 * 实体内容框 contentBox 要另调 get_layout(contentLayoutOf)。
 */
function frameLayoutOf(clipId: string) {
  const hit = findClip(getState().project, clipId);
  const frame = (hit?.clip as { frame?: ClipFrame } | undefined)?.frame;
  return { clipId, local: frame ?? null, world: worldOf(frame, stageSize(), getState().project.camera3dFov) };
}

/** frameLayoutOf + 量出来的 contentBox(一次往返量全部 clipIds,见 measureContentBoxes) */
async function contentLayoutOf(clipIds: string[]) {
  const measured = await measureContentBoxes(clipIds);
  const out: Record<string, ReturnType<typeof frameLayoutOf> & { contentBox: ContentBox; contentNote?: string }> = {};
  for (const id of clipIds) out[id] = { ...frameLayoutOf(id), ...(measured.get(id) ?? { contentBox: null }) };
  return out;
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
  return { ok: true, clipId, layout: frameLayoutOf(clipId), look: lookHint(clipId) };
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

import { editorApi } from "../../mcp/api";

export function RightPanel() {
  const [mcpConnected, setMcpConnected] = useState(false);

  useEffect(() => {
;
    
    const cleanup = connectMcpExecutor(() => editorApi, (s) => setMcpConnected(s.connected));
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
