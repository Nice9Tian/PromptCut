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

export const collectHandlers: Partial<EditorApi> = {
  collectStatus: () => collectStatus(),
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
};
