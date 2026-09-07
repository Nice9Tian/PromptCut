// mcp-tools.mjs 是纯数据、没有 node 依赖，前端可以直接引；它没有 .d.ts，
// 所以在这里就地声明用到的那点形状。
// @ts-expect-error 无类型声明的 .mjs
import { tools as RAW_TOOL_SPECS } from "../../server/mcp-tools.mjs";
const TOOL_SPECS = RAW_TOOL_SPECS as { name: string; inputSchema?: { required?: string[] } }[];

/**
 * 按工具自己的 inputSchema 校验必填参数。
 *
 * 为什么要在这一层拦：inputSchema 里写了 required，但**没有任何一层真的执行它**。
 * MCP 协议指望客户端自觉，而 CLI 驱动（claude / codex / agy）并不保证会校验。
 * 于是漏传参数会一路走到实现里：`seek({})` 把 t 设成 null、`set_theme({})` 把
 * themeId 设成 undefined，还都回 `{ok:true}` —— Agent 以为成功了，项目却已经坏了。
 * 沉默地改坏状态，比报错难查得多。
 *
 * API 直连那条路在 harness/agent.mjs 里已经有同样的校验；这里补的是走 MCP 的那条。
 * 只查「必填的在不在」，不做类型推断——过度校验会把合法调用也挡掉。
 */
function missingRequired(tool: string, args: unknown): string[] {
  const spec = TOOL_SPECS.find((t) => t.name === tool);
  const required = spec?.inputSchema?.required ?? [];
  if (required.length === 0) return [];
  const bag = (args ?? {}) as Record<string, unknown>;
  return required.filter((k) => bag[k] === undefined || bag[k] === null);
}

export interface EditorApi {
  backgroundJobStatus(args: { jobId: string }): any;
  listCards(args?: { cardId?: string; detail?: string }): any;
  getProject(): any;
  listMedia(): any;
  getSelection(): any;
  addClip(args: { cardId: string; start: number; duration?: number; trackId?: string; params?: any }): any;
  updateClip(args: { clipId: string; start?: number; end?: number; cardId?: string; params?: any }): any;
  removeClip(args: { clipId: string }): any;
  duplicateClip(args: { clipId: string }): any;
  splitClip(args: { clipId: string; t: number }): any;
  addTrack(args: { name?: string }): any;
  seek(args: { t: number }): any;
  play(): any;
  pause(): any;
  setTheme(args: { themeId: string }): any;
  setProjectMeta(args: any): any;
  // STT 工具
  sttStatus(): Promise<any>;
  sttInstall(args: { engine: string }): Promise<any>;
  transcribeMedia(args: { mediaId: string; engine?: string; model?: string; language?: string }): Promise<any>;
  getTranscript(args: { mediaId: string }): any;
  detectShots(args: { mediaId: string; force?: boolean }): Promise<any>;
  listShots(args: { mediaId: string }): any;
  trackPoints(args: { mediaId: string; points: number[][] }): Promise<any>;
  getTrack(args: { mediaId: string; full?: boolean }): any;
  trackStatus(): Promise<any>;
  trackInstall(): Promise<any>;
  // 主体检测：画面里的人在哪、哪一侧是空的
  detectSubjects(args: { mediaId: string; times?: number[]; prompt?: string; force?: boolean }): Promise<any>;
  listSubjects(args: { mediaId: string }): any;
  subjectStatus(): Promise<any>;
  subjectInstall(): Promise<any>;
  attachClipMotion(args: {
    clipId: string; mediaId: string; pointIndex?: number; whenHidden?: string;
  }): any;
  detachClipMotion(args: { clipId: string }): any;
  autoWorkflow(args: { mediaId: string; style?: string; maxCards?: number }): Promise<any>;
  autoWorkflowStatus(args: { jobId: string }): any;
  fillCaptions(args: { clipId?: string; mediaId?: string; showEn?: boolean }): any;
  importMedia(args: { url?: string; name?: string }): Promise<any>;
  createCard(args: { id: string; source: string; overwrite?: boolean }): Promise<any>;
  getCardSource(args: { cardId: string }): Promise<any>;
  editCard(args: { cardId: string; find: string; replace: string; replaceAll?: boolean }): Promise<any>;
  seePreview(args: { t?: number; clipId?: string }): Promise<any>;
  cardAuthoringGuide(): Promise<any>;
}

export function connectMcpExecutor(getApi: () => EditorApi, onStatus?: (s: { connected: boolean }) => void): () => void {
  let source: EventSource | null = null;
  let active = true;

  const connect = () => {
    if (!active) return;
    source = new EventSource("/api/mcp/events");

    source.onopen = () => {
      onStatus?.({ connected: true });
    };

    source.onmessage = async (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }

      if (ev.type === "hello") {
        // hello
      } else if (ev.type === "replaced") {
        if (source) source.close();
        source = null;
        onStatus?.({ connected: false });
        window.dispatchEvent(new CustomEvent("ai-chat-error", { detail: "另一个编辑台页面接管了 AI 连接" }));
        active = false;
      } else if (ev.type === "call") {
        const id = ev.id;
        const tool = ev.tool;
        const args = ev.args as any;
        const api = getApi();
        let ok = true;
        let result: unknown;
        let error: string | undefined;

        try {
          const missing = missingRequired(tool, args);
          if (missing.length > 0) {
            throw new Error(`缺少必填参数：${missing.join("、")}。请补齐后重试。`);
          }
          if (tool === "background_job_status") result = api.backgroundJobStatus(args);
          else if (tool === "list_cards") result = api.listCards(args);
          else if (tool === "get_project") result = api.getProject();
          else if (tool === "list_media") result = api.listMedia();
          else if (tool === "get_selection") result = api.getSelection();
          else if (tool === "add_clip") result = api.addClip(args);
          else if (tool === "update_clip") result = api.updateClip(args);
          else if (tool === "remove_clip") result = api.removeClip(args);
          else if (tool === "duplicate_clip") result = api.duplicateClip(args);
          else if (tool === "split_clip") result = api.splitClip(args);
          else if (tool === "add_track") result = api.addTrack(args);
          else if (tool === "seek") result = api.seek(args);
          else if (tool === "play") result = api.play();
          else if (tool === "pause") result = api.pause();
          else if (tool === "set_theme") result = api.setTheme(args);
          else if (tool === "set_project_meta") result = api.setProjectMeta(args);
          else if (tool === "stt_status") result = await api.sttStatus();
          else if (tool === "stt_install") result = await api.sttInstall(args);
          else if (tool === "transcribe_media") result = await api.transcribeMedia(args);
          else if (tool === "get_transcript") result = api.getTranscript(args);
          else if (tool === "detect_shots") result = await api.detectShots(args);
          else if (tool === "list_shots") result = api.listShots(args);
          else if (tool === "track_points") result = await api.trackPoints(args);
          else if (tool === "get_track") result = api.getTrack(args);
          else if (tool === "track_status") result = await api.trackStatus();
          else if (tool === "track_install") result = await api.trackInstall();
          else if (tool === "detect_subjects") result = await api.detectSubjects(args);
          else if (tool === "list_subjects") result = api.listSubjects(args);
          else if (tool === "subject_status") result = await api.subjectStatus();
          else if (tool === "subject_install") result = await api.subjectInstall();
          else if (tool === "attach_clip_motion") result = api.attachClipMotion(args);
          else if (tool === "detach_clip_motion") result = api.detachClipMotion(args);
          else if (tool === "auto_workflow") result = await api.autoWorkflow(args);
          else if (tool === "auto_workflow_status") result = api.autoWorkflowStatus(args);
          else if (tool === "fill_captions") result = api.fillCaptions(args);
          else if (tool === "import_media") result = await api.importMedia(args);
          else if (tool === "create_card") result = await api.createCard(args);
          else if (tool === "get_card_source") result = await api.getCardSource(args);
          else if (tool === "edit_card") result = await api.editCard(args);
          else if (tool === "see_preview") result = await api.seePreview(args);
          else if (tool === "card_authoring_guide") result = await api.cardAuthoringGuide();
          else throw new Error(`未知工具: ${tool}`);
        } catch (err: unknown) {
          ok = false;
          if (err instanceof Error) {
            error = err.message;
          } else {
            error = String(err);
          }
        }

        fetch("/api/mcp/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ok, result, error })
        }).catch(() => {});
      }
    };

    source.onerror = () => {
      onStatus?.({ connected: false });
      if (source) source.close();
      if (active) {
        setTimeout(connect, 3000);
      }
    };
  };

  connect();

  return () => {
    active = false;
    if (source) {
      source.close();
      source = null;
    }
  };
}
