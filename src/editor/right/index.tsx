import { useEffect, useState } from "react";
import { AiPanel } from "./AiPanel";
import { connectMcpExecutor, EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { allCards } from "../../kernel/registry";
import { findClip } from "../../kernel/project";
import { sttStatus, sttInstall, transcribeMedia } from "../io/stt";
import { runAutoWorkflow, getAutoWorkflowStatus } from "./autoWorkflow";

/** 后台 STT 任务的状态(MCP 工具立即返回 jobId,结果靠轮询) */
interface SttJob { done: boolean; ok: boolean; error?: string; logTail?: string[]; segments?: number }
const sttJobs = new Map<string, SttJob>();

export function RightPanel() {
  const [mcpConnected, setMcpConnected] = useState(false);

  useEffect(() => {
    const api: EditorApi = {
      listCards: () => allCards().map(c => ({ 
        id: c.id, name: c.name, description: c.description, source: c.source, controls: c.controls, defaults: c.defaults 
      })),
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
        const clip = actions.addCardClip(args.cardId, args.start, {
          duration: args.duration,
          trackId: args.trackId,
          params: args.params
        });
        if (!clip) throw new Error("添加卡片失败");
        return clip;
      },
      updateClip: (args) => {
        if (args.params) actions.setClipParams(args.clipId, args.params);
        if (args.start !== undefined || args.end !== undefined) actions.moveClip(args.clipId, { start: args.start, end: args.end });
        if (args.cardId !== undefined) actions.setClipCard(args.clipId, args.cardId);
        return { ok: true };
      },
      removeClip: (args) => { actions.removeClip(args.clipId); return { ok: true }; },
      duplicateClip: (args) => { const c = actions.duplicateClip(args.clipId); if (!c) throw new Error("复制失败"); return c; },
      splitClip: (args) => { const c = actions.splitClip(args.clipId, args.t); if (!c) throw new Error("切分失败"); return c; },
      addTrack: (args) => { const t = actions.addTrack(args.kind, args.name); return t; },
      seek: (args) => { actions.seek(args.t); return { ok: true }; },
      play: () => { actions.play(); return { ok: true }; },
      pause: () => { actions.pause(); return { ok: true }; },
      setTheme: (args) => { actions.setProjectMeta({ themeId: args.themeId }); return { ok: true }; },
      setProjectMeta: (args) => { actions.setProjectMeta(args); return { ok: true }; },

      // ── 语音转文字 ────────────────────────────────────────────────
      sttStatus: () => sttStatus(),

      // 安装可能远超 MCP 桥的 60 秒调用超时,所以立刻返回 jobId,
      // 让 AI 用 stt_status 轮询 engines.<engine>.installed 判断是否装完。
      sttInstall: async (args) => {
        const jobId = `install-${args.engine}-${Date.now().toString(36)}`;
        const log: string[] = [];
        sttInstall(args.engine, (line) => {
          log.push(line);
          if (log.length > 200) log.shift();
        })
          .then((r) => { sttJobs.set(jobId, { done: true, ok: r.ok, logTail: r.log.slice(-20) }); })
          .catch((e: unknown) => {
            sttJobs.set(jobId, { done: true, ok: false, error: e instanceof Error ? e.message : String(e), logTail: log.slice(-20) });
          });
        sttJobs.set(jobId, { done: false, ok: false, logTail: [] });
        return { jobId, started: true, hint: "安装已在后台开始,请用 stt_status 轮询 engines 里该引擎的 installed 字段" };
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
      autoWorkflow: (args) => runAutoWorkflow(args),
      autoWorkflowStatus: (args) => getAutoWorkflowStatus(args)
    };
    
    const cleanup = connectMcpExecutor(() => api, (s) => setMcpConnected(s.connected));
    return cleanup;
  }, []);

  return <AiPanel mcpConnected={mcpConnected} />;
}
