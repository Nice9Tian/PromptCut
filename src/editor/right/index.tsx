import { useEffect, useState } from "react";
import { AiPanel } from "./AiPanel";
import { connectMcpExecutor, EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { allCards } from "../../kernel/registry";
import { validateCardParams, findCard } from "../../kernel/cardParams";
import { findClip } from "../../kernel/project";
import { sttStatus, sttInstall, transcribeMedia } from "../io/stt";
import { runAutoWorkflow, getAutoWorkflowStatus } from "./autoWorkflow";
import { getJob as getInstallJob } from "../../ai/sttInstallStore";
import { runSttInstall } from "../io/runSttInstall";

/** 后台 STT 任务的状态(MCP 工具立即返回 jobId,结果靠轮询) */
interface SttJob { done: boolean; ok: boolean; error?: string; logTail?: string[]; segments?: number }
const sttJobs = new Map<string, SttJob>();

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
