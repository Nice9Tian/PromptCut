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
  subjectDigest
} from "../common";

export const effectsHandlers: Partial<EditorApi> = {
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
};
