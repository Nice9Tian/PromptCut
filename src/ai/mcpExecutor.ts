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
  autoWorkflow(args: { mediaId: string; style?: string; maxCards?: number }): Promise<any>;
  autoWorkflowStatus(args: { jobId: string }): any;
  fillCaptions(args: { clipId?: string; mediaId?: string; showEn?: boolean }): any;
  createCard(args: { id: string; source: string; overwrite?: boolean }): Promise<any>;
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
          else if (tool === "auto_workflow") result = await api.autoWorkflow(args);
          else if (tool === "auto_workflow_status") result = api.autoWorkflowStatus(args);
          else if (tool === "fill_captions") result = api.fillCaptions(args);
          else if (tool === "create_card") result = await api.createCard(args);
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
