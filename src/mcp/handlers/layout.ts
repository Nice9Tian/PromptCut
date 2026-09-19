import { useEffect, useState } from "react";
import { startShotDetection, waitForShots } from "../../ai/shots";
import { scenesOf, planSequences, frameTimes, transcriptFor } from "../../ai/sequences";
import { installTrack, startTracking, trackStatus, waitForTrack, type TrackResult } from "../../ai/track";
import {
  installSubject, startSubjectDetection, subjectStatus, waitForSubjects,
} from "../../ai/subject";
import { buildClipMotion } from "../../kernel/motion";
import { useLayoutMode } from "../../editor/layoutMode";
import { DockHost } from "../../editor/dock/DockHost";
import { DockPages } from "../../editor/dock/DockPages";
import { RailBar } from "../../editor/dock/RailBar";
import { useSideVisible } from "../../editor/dock/railStore";
import { connectMcpExecutor, EditorApi } from "../../ai/mcpExecutor";
import { prerenderUrl } from "../../editor/prerender";
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
import { createClipGuard, timelineDigest, lookHint } from "../../editor/right/toolEcho";
import { createTrackTools } from "../../editor/right/trackTools";
import { createFilterTools } from "../../editor/right/filterTools";
import { createAudioFxTools } from "../../editor/right/audioFxTools";
import { createPixelMapTools } from "../../editor/right/pixelMapTools";
import { audioPlanOf, soundingAt } from "../../kernel/audioPlan.mjs";
import {
  framePatchFromArgs, worldOf, rectToFrame, alignToFrame, alignIsInvisible, nudgeFrame, clampToStage, rectForSafeSide, frameBox,
  type Size,
} from "../../kernel/layout";
import { backRole, backStage, syncProject } from "../../editor/stageBridge";
import type { RectWithBounds } from "../../render/solid";
import { listCuts, resolveCut } from "../../kernel/cuts";
import { invalidateScopes, isCardVisible, loadScopes, readVisibility, usedCardIds, type ScopeEntry } from "../../editor/cardScope";
import { cameraFor, clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG } from "../../kernel/space3d";
import { generateVoice, getVoiceConfig } from "../../ai/voice";
import { VoiceSettingsDialog } from "../../voice/VoiceSettingsDialog";
import { importAudioFromServer } from "../../editor/io";
import type { ClipFrame } from "../../kernel/types";
import { sttStatus, sttInstall, transcribeMedia } from "../../editor/io/stt";
import { importVideoFiles, importVideoFromServer } from "../../editor/io";
import { classifyFileDetailed, KIND_LABEL, registerAsset } from "../../editor/left/importAssets";
import { mediaCardUrl, isImageMedia } from "../../ai/mediaRef";
import {
  collectStatus, installCollect, probeLink, startDownload, waitForDownload, type CollectJob,
  collectLoginCheck, collectLogout, cookieStatus, searchVideos,
} from "../../ai/collect";
import { openCollectLogin } from "../../ai/collectLoginStore";
import { CollectLoginDialog } from "../../editor/right/CollectLoginDialog";
import { AgentBrowserFrame } from "../../editor/right/AgentBrowserFrame";
import { runAutoWorkflow, getAutoWorkflowStatus } from "../../editor/right/autoWorkflow";
import { getJob as getInstallJob } from "../../ai/sttInstallStore";
import { runSttInstall } from "../../editor/io/runSttInstall";

import {
  stageSize,
  roundBox,
  frameLayoutOf,
  withParts,
  withFrame,
  reject3dOnMedia,
  cardScopes,
  refreshScopes,
  sttJobs,
  collectInstallJobs,
  collectJobs,
  clipGuard,
  trackTools,
  filterTools,
  audioFxTools,
  pixelMapTools,
  shotJobs,
  trackInstallJobs,
  trackJobs,
  trackResults,
  subjectJobs,
  subjectInstallJobs,
  findCaptionClip,
  topBoxes,
  subjectDigest,
  contentLayoutOf,
} from "../common";

export const layoutHandlers: Partial<EditorApi> = {
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
  getLayout: async (args) => {
        const p = getState().project;
        if (args?.clipId) {
          if (!findClip(p, args.clipId)) throw new Error(`找不到 clip ${args.clipId}`);
          return (await contentLayoutOf([args.clipId]))[args.clipId];
        }
        // 全部卡片和素材段,一次往返(素材段的 contentBox = 它的 frameCss 框)
        const ids = p.tracks.flatMap((tr) => tr.clips.map((c) => c.id));
        return { stage: stageSize(), clips: await contentLayoutOf(ids) };
      },
};
