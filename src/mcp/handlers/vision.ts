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

export const visionHandlers: Partial<EditorApi> = {
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
  cardAuthoringGuide: async () => {
        const res = await fetch("/api/cards/guide");
        if (!res.ok) throw new Error(`拿不到建卡指南(HTTP ${res.status})`);
        return { guide: await res.text() };
      },
};
