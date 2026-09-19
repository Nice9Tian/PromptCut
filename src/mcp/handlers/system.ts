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

export const systemHandlers: Partial<EditorApi> = {
  backgroundJobStatus: ({ jobId }) => {
        // 听写、运动追踪、主体检测各有一张作业表。只查第一张的话,track_install /
        // subject_install 返回的 jobId 拿过来一定是「找不到」,而那条消息会把人
        // 引向「是不是重启了」。
        const job = sttJobs.get(jobId) ?? trackInstallJobs.get(jobId) ?? subjectInstallJobs.get(jobId)
          ?? collectInstallJobs.get(jobId);
        if (!job) throw new Error('找不到后台任务，可能已重启。');
        return { jobId, ...job };
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
};
