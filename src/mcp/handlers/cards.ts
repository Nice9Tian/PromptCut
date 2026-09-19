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

export const cardsHandlers: Partial<EditorApi> = {
  listCards: (args) => {
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
        return wanted.map((c) => {
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
        });
      },
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
        refreshScopes();
        return data;
      },
  getCardSource: async (args) => {
        const q = new URLSearchParams({ id: args.cardId, ...(args.file ? { file: args.file } : {}) });
        const res = await fetch(`/api/cards/source?${q}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `读不到卡片源码(HTTP ${res.status})`);
        return data;
      },
  editCard: async (args) => {
        const res = await fetch("/api/cards/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: args.cardId, file: args.file, find: args.find, replace: args.replace, replaceAll: args.replaceAll === true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `改卡失败(HTTP ${res.status})`);
        return data;
      },
  applyCard: (args) => {
        let instance: { clipId: string; nodeId: string } | undefined;
        actions.editCardProject(project => {
          const result = applyCardDefinition(project, args, getCard); instance = { clipId: result.clipId, nodeId: result.nodeId }; return result.project;
        });
        return { ok: true, ...instance };
      },
};
