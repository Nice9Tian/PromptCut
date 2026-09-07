import { useEffect, useState } from "react";
import { startShotDetection, waitForShots } from "../../ai/shots";
import { startTracking, waitForTrack, type TrackResult } from "../../ai/track";
import { AiPanel } from "./AiPanel";
import { connectMcpExecutor, EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { allCards } from "../../kernel/registry";
import { validateCardParams, findCard } from "../../kernel/cardParams";
import { findClip } from "../../kernel/project";
import { sttStatus, sttInstall, transcribeMedia } from "../io/stt";
import { importVideoFiles } from "../io";
import { runAutoWorkflow, getAutoWorkflowStatus } from "./autoWorkflow";
import { getJob as getInstallJob } from "../../ai/sttInstallStore";
import { runSttInstall } from "../io/runSttInstall";

/** 后台 STT 任务的状态(MCP 工具立即返回 jobId,结果靠轮询) */
interface SttJob { done: boolean; ok: boolean; error?: string; logTail?: string[]; segments?: number }
const sttJobs = new Map<string, SttJob>();

/** 正在跑的镜头识别作业,按 mediaId 索引。结果落进 store 后就删掉。 */
const shotJobs = new Map<string, { jobId: string; percent: number; engine: string; error?: string }>();
/** 进行中的追踪作业,以及跑完的轨迹。都只在内存里,刷新页面就没了 */
const trackJobs = new Map<string, { jobId: string; percent: number; engine: string; error?: string }>();
const trackResults = new Map<string, TrackResult>();

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
        const wanted = args?.cardId ? [findCard(args.cardId)] : allCards();
        const full = args?.detail === "full" || !!args?.cardId;
        return wanted.map((c) => {
          const base = {
            id: c.id, name: c.name, description: c.description, source: c.source,
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
          path: m.path,
          url: m.url,
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
        const clip = actions.addCardClip(args.cardId, args.start, {
          duration: args.duration,
          trackId: args.trackId,
          params: args.params
        });
        if (!clip) throw new Error("添加卡片失败");
        return clip;
      },
      updateClip: (args) => {
        if (args.params || args.cardId !== undefined) {
          const hit = findClip(getState().project, args.clipId);
          if (!hit) throw new Error(`找不到 clip ${args.clipId}`);
          const clip = hit.clip as { cardId?: string; params?: Record<string, unknown> };
          // 换卡时旧参数不再适用,按空的算;只改参数时要带上 clip 已有的,
          // 免得「只改个颜色」被当成漏填了必填项。
          const switching = args.cardId !== undefined && args.cardId !== clip.cardId;
          validateCardParams(args.cardId ?? clip.cardId!, args.params, switching ? undefined : clip.params);
        }
        if (args.params) actions.setClipParams(args.clipId, args.params);
        if (args.start !== undefined || args.end !== undefined) actions.moveClip(args.clipId, { start: args.start, end: args.end });
        if (args.cardId !== undefined) actions.setClipCard(args.clipId, args.cardId);
        return { ok: true };
      },
      removeClip: (args) => { actions.removeClip(args.clipId); return { ok: true }; },
      duplicateClip: (args) => { const c = actions.duplicateClip(args.clipId); if (!c) throw new Error("复制失败"); return c; },
      splitClip: (args) => { const c = actions.splitClip(args.clipId, args.t); if (!c) throw new Error("切分失败"); return c; },
      addTrack: (args) => { const t = actions.addTrack(args.name); return t; },
      seek: (args) => { actions.seek(args.t); return { ok: true }; },
      play: () => { actions.play(); return { ok: true }; },
      pause: () => { actions.pause(); return { ok: true }; },
      setTheme: (args) => { actions.setProjectMeta({ themeId: args.themeId }); return { ok: true }; },
      setProjectMeta: (args) => { actions.setProjectMeta(args); return { ok: true }; },

      // ── 语音转文字 ────────────────────────────────────────────────
      backgroundJobStatus: ({ jobId }) => {
        const job = sttJobs.get(jobId);
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
        const name = args.name || decodeURIComponent(url.split("/").pop() || "attachment.mp4");
        const file = new File([blob], name, { type: blob.type || "video/mp4" });
        const ids = await importVideoFiles([file]);
        if (ids.length === 0) throw new Error("导入失败,没有登记成素材。");
        const media = getState().project.media.find((m) => m.id === ids[0]);
        return {
          mediaId: ids[0],
          name,
          duration: media?.duration,
          width: media?.width,
          height: media?.height,
          hint: "已装进素材库并放到视频轨上。要做字幕就先 transcribe_media,再 add_clip 建 caption-track 并用 fill_captions 灌入。",
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
        return {
          running: false,
          engine: media.shots.engine,
          // 没装拓展时只有硬切,这一句要让模型看见,免得它以为片子里真的没有溶解
          engineNote: media.shots.engine === "scdet"
            ? "当前用的是 ffmpeg scdet 兜底,只认硬切,溶解等渐变转场检测不出来"
            : "TransNetV2,硬切和溶解都认得",
          shots: media.shots.shots,
          transitions: media.shots.transitions.map(({ thumbs, ...rest }) => rest),
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
        trackJobs.set(args.mediaId, { jobId, percent: 0, engine: "bootstapir" });
        waitForTrack(jobId, (percent, engine) =>
          trackJobs.set(args.mediaId, { jobId, percent, engine }))
          .then((result) => {
            trackResults.set(args.mediaId, result);
            trackJobs.delete(args.mediaId);
          })
          .catch((e: unknown) => {
            trackJobs.set(args.mediaId, {
              jobId, percent: 0, engine: "bootstapir",
              error: e instanceof Error ? e.message : String(e),
            });
          });
        return {
          jobId, started: true, mediaId: args.mediaId, points: args.points.length,
          hint: "运动追踪已在后台开始,请用 get_track 轮询该 mediaId",
        };
      },

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
        return {
          running: false,
          engine: result.engine,
          // 降级档要让模型看见,否则它会拿模板匹配的粗结果当准数据下判断
          engineNote: result.engine === "bootstapir"
            ? "BootsTAPIR,任意点追踪,visible 为 false 表示该帧被遮挡或移出画面"
            : "当前是浏览器内的模板匹配兜底,只适合纹理清晰、无遮挡、位移平缓的场景,精度低得多",
          width: result.width,
          height: result.height,
          frames: result.frames,
          points: result.points,
        };
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

        // lines 里的秒数相对 clip 起点;只保留和 clip 时段有交集的段落,
        // 并把跨界的段落裁到 clip 边界内,免得字幕在卡片外提前亮或不消失。
        const kept = segments
          .filter((s) => s.end > clip.start && s.start < clip.end)
          .map((s) => ({
            start: Math.max(s.start, clip.start) - clip.start,
            end: Math.min(s.end, clip.end) - clip.start,
            text: s.text.trim().replace(/[\n|]/g, " "),
          }))
          .filter((s) => s.end > s.start && s.text !== "");
        if (kept.length === 0) {
          throw new Error(`文字稿里没有落在这张卡时段(${clip.start}s–${clip.end}s)内的段落,检查一下 clip 的起止时间。`);
        }

        const lines = kept.map((s) => `${s.start.toFixed(2)}|${s.end.toFixed(2)}|${s.text}|`).join("\n");
        const params = { lines, showEn: args.showEn === true ? "true" : "false" };
        validateCardParams("caption-track", params, (hit.clip as { params?: Record<string, unknown> }).params);
        actions.setClipParams(clipId, params);
        return { clipId, mediaId: media.id, lines: kept.length, from: clip.start, to: clip.end };
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
            id: args.id,
            source: args.source,
            overwrite: args.overwrite === true,
            existingIds: allCards().map((c) => c.id),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `建卡失败(HTTP ${res.status})`);
        return data;
      },
      /**
       * 读回自己建的卡的当前源码。改卡的第一步 —— 不读回来就改,等于凭记忆重写。
       */
      getCardSource: async (args) => {
        const res = await fetch(`/api/cards/source?id=${encodeURIComponent(args.cardId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `读不到卡片源码(HTTP ${res.status})`);
        return data;
      },
      /** 局部替换式改卡。整篇重写交给 createCard,那条路只该走一次(建卡)。 */
      editCard: async (args) => {
        const res = await fetch("/api/cards/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: args.cardId, find: args.find, replace: args.replace, replaceAll: args.replaceAll === true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `改卡失败(HTTP ${res.status})`);
        return data;
      },
      /**
       * 把画面渲染成图交给模型看。
       *
       * project 是从这里带过去的,不是让服务端自己去读:时间轴的真身在浏览器 store 里,
       * 服务端手上那份(上次保存的)可能已经是旧的 —— 让模型看一张过时的画面,比不给它看更糟。
       */
      seePreview: async (args) => {
        const state = getState();
        const t = typeof args?.t === "number" ? args.t : undefined;
        const res = await fetch("/api/vision/snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: state.project,
            t: t ?? (args?.clipId ? undefined : state.t),
            clipId: args?.clipId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `渲染画面失败(HTTP ${res.status})`);
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

  return <AiPanel mcpConnected={mcpConnected} />;
}
