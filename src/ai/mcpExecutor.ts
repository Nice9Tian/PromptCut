// mcp-tools.mjs 是纯数据、没有 node 依赖，前端可以直接引；它没有 .d.ts，
// 所以在这里就地声明用到的那点形状。
// @ts-expect-error 无类型声明的 .mjs
import { tools as RAW_TOOL_SPECS } from "../../server/mcp-tools.mjs";
import { webOpen, webView, webClick, webType, webScroll, webRead, webHandoff, webClose } from "./web";
import { requestAgentBrowser, closeAgentBrowser } from "./agentBrowserStore";
import * as agentBus from "./agentBus";
import { getState } from "../store/project";
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
  updateClip(args: { clipId: string; start?: number; end?: number; cardId?: string; params?: any; opacity?: number; fadeIn?: number; fadeOut?: number; label?: string; trackId?: string }): any;
  /** 卡片级定位(场景图的根节点)。部件级接进来时加 node 参数,签名不用改 */
  setPosition(args: { clipId: string; space?: "world" | "local"; x?: number; y?: number; w?: number; h?: number; anchor?: [number, number]; scale?: number; rotate?: number; clear?: boolean; clamp?: boolean }): any;
  setRect(args: { clipId: string; x1: number; y1: number; x2: number; y2: number; mode?: "fit" | "canvas"; align?: [number, number] }): any;
  align(args: { clipId: string; h?: "left" | "center" | "right"; v?: "top" | "center" | "bottom"; margin?: number }): any;
  nudge(args: { clipId: string; dx?: number; dy?: number; scaleBy?: number; rotateBy?: number; clamp?: boolean }): any;
  getLayout(args?: { clipId?: string }): any;
  getClip(args: { clipId: string }): any;
  listParts(args?: { partId?: string; detail?: string }): any;
  addComposite(args: { start: number; duration?: number; trackId?: string; parts?: unknown[] }): any;
  addPart(args: { clipId: string; partId: string; params?: Record<string, unknown>; frame?: unknown; enterMs?: number; label?: string; parentId?: string; index?: number }): any;
  setPart(args: { clipId: string; partInstanceId: string; params?: Record<string, unknown>; frame?: unknown; enterMs?: number; label?: string }): any;
  removePart(args: { clipId: string; partInstanceId: string }): any;
  movePart(args: { clipId: string; partInstanceId: string; parentId?: string | null; index?: number }): any;
  setClip(args: { clipId: string; envelope: unknown }): any;
  removeClip(args: { clipId: string }): any;
  duplicateClip(args: { clipId: string }): any;
  splitClip(args: { clipId: string; t: number }): any;
  listTransitions(): any;
  addTransition(args: { kind: string; clipId: string; otherClipId?: string; dur?: number }): any;
  removeTransition(args: { transitionId: string }): any;
  addTrack(args: { name?: string }): any;
  // 多条剪辑(时间轴)。其余 clip / 序列工具都只作用于当前激活的那条
  listCuts(): any;
  switchCut(args: { cutId?: string; name?: string }): any;
  addCut(args?: { name?: string; switch?: boolean }): any;
  renameCut(args: { cutId: string; name: string }): any;
  removeCut(args: { cutId: string; force?: boolean; reason?: string }): any;
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
  collectStatus(): Promise<any>;
  collectSearch(args: { query: string; site?: string; limit?: number }): Promise<any>;
  collectInstall(): Promise<any>;
  collectProbe(args: { url: string; site?: string; quality?: number }): Promise<any>;
  collectDownload(args: { url: string; quality?: number; site?: string; audioOnly?: boolean; allParts?: boolean; cookies?: string }): Promise<any>;
  collectJob(args: { jobId: string }): Promise<any>;
  collectLogin(args: { site?: string; method?: "qr" | "browser"; force?: boolean }): Promise<any>;
  collectLoginCheck(args: { site?: string; hide?: boolean }): Promise<any>;
  collectLogout(args: { site?: string }): Promise<any>;
  createCard(args: { id: string; source: string; overwrite?: boolean }): Promise<any>;
  getCardSource(args: { cardId: string }): Promise<any>;
  editCard(args: { cardId: string; find: string; replace: string; replaceAll?: boolean }): Promise<any>;
  seePreview(args: { t?: number; clipId?: string }): Promise<any>;
  seeSequences(args: { mediaId: string; page?: number; perPage?: number; grid?: number; scene?: number; from?: number; to?: number }): Promise<any>;
  cardAuthoringGuide(): Promise<any>;
}

/** 这些工具改的是时间轴:做成一次,就值得给 SKILL 悬浮窗下面那张预览图刷新一次 */
const TIMELINE_TOOLS = new Set([
  "add_clip", "update_clip", "remove_clip", "duplicate_clip", "split_clip",
  "add_transition", "remove_transition",
  "set_position", "set_rect", "align", "nudge", "fill_captions", "attach_clip_motion", "detach_clip_motion",
  "add_track", "switch_cut", "add_cut", "set_theme",
]);

function isHeadlessPage(): boolean {
  try { return new URLSearchParams(location.search).has("headless"); } catch { return false; }
}

/** 同一时刻只渲染一张:agent 连着改十张卡,预览跟着渲染十次没意义,只留最后那次 */
let lastActionBusy = false;
let lastActionPending: (() => Promise<void>) | null = null;

/**
 * SKILL 模式的悬浮窗下面显示「agent 上一步做成的动作」的画面。
 *
 * 只在无头实例的页面里做(它才是被 agent 操控的那份):动作成功后按 see_preview 那条路
 * 把那一刻的整屏渲染成 png,POST 给自己的服务端写到 skillRoot/last-action.{png,json},
 * 壳的 watcher 盯着那两个文件,变了就推给悬浮窗。全程失败静默 —— 预览是锦上添花,
 * 不能反过来影响工具调用。
 */
function reportLastAction(api: EditorApi, tool: string, args: any, result: any): void {
  if (!isHeadlessPage() || !TIMELINE_TOOLS.has(tool)) return;
  const run = async () => {
    // 时间点:优先这次动作涉及的那张卡的中点(add/update 的返回里有 clip 或 timeline),
    // 都没有就让服务端用当前播放头。
    let t: number | undefined;
    const clipId: string | undefined = result?.clip?.id ?? args?.clipId ?? result?.clipId;
    const clip = result?.clip
      ?? (clipId ? (result?.timeline as any[] | undefined)?.flatMap((tr: any) => tr?.clips ?? [])?.find((c: any) => c?.id === clipId) : undefined);
    if (clip && typeof clip.start === "number" && typeof clip.end === "number") t = (clip.start + clip.end) / 2;
    else if (typeof args?.start === "number") t = args.start + 0.5;
    const shot = await api.seePreview(t == null ? {} : { t });
    const base64 = shot?.__image?.base64;
    if (!base64) return;
    await fetch("/api/skill-mode/last-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, clipId: clipId ?? null, t: shot?.t ?? t ?? null, base64 }),
    });
  };
  const kick = () => {
    if (lastActionBusy) { lastActionPending = run; return; }
    lastActionBusy = true;
    run().catch(() => {}).finally(() => {
      lastActionBusy = false;
      const next = lastActionPending;
      lastActionPending = null;
      if (next) { lastActionBusy = true; next().catch(() => {}).finally(() => { lastActionBusy = false; }); }
    });
  };
  kick();
}

/** web_* 的分发。返回体里的 __image 原样往上传,让 harness 把它摘成图片块 */
async function runWebTool(tool: string, args: any): Promise<any> {
  switch (tool) {
    case "web_open": return webOpen(args);
    case "web_view": return webView();
    case "web_click": return webClick(args);
    case "web_type": return webType(args);
    case "web_scroll": return webScroll(args);
    case "web_read": return webRead(args);
    case "web_handoff": {
      const r = await webHandoff(args);
      // 桌面壳模式:agent 的浏览器是主窗口里的子 webview,Node 那边挪不动它,
      // 只回一个 shell 标记。这边**不弹窗打断用户**:点亮顶栏的「浏览器」页签(闪烁 +
      // 「有待操作」气泡),用户自己点过去时面板才把 webview 摆出来。
      if (r && (r as { shell?: boolean }).shell) {
        if (args?.hide) closeAgentBrowser();
        else requestAgentBrowser(typeof args?.reason === "string" ? args.reason : "");
      }
      return r;
    }
    case "web_close": return webClose();
    default: throw new Error(`未知的网页工具: ${tool}`);
  }
}

export function connectMcpExecutor(getApi: () => EditorApi, onStatus?: (s: { connected: boolean }) => void): () => void {
  let source: EventSource | null = null;
  let active = true;

  /*
   * 三个 URL 参数决定这个页面和 MCP 桥的关系:
   *
   *   ?view=<钥匙>   只读浏览。页面照常渲染项目,但**不连桥**。Skill 任务会把一条带这把
   *                  钥匙的完整链接交给 agent(instance.json 的 viewUrl),它照常打开就行 ——
   *                  不用记「要加什么后缀」。没有这把钥匙的话,连页面都打不开
   *                  (server/vite-plugin-view-gate.ts 那道)。
   *   ?observe=1     同一件事的老写法,留着不动。用户自己那份 PromptCut 没有钥匙这套,
   *                  想只读打开时只有它可用。
   *   ?owner=<令牌>  宣示所有权。带着它连上之后,服务端会拒绝一切没有同一把钥匙的连接,
   *                  别人抢不走。无头实例用它保住自己。
   *
   * 都不带 = 普通用户的编辑台,行为和以前一模一样(先来后到、刷新可接管)。
   */
  const params = (() => {
    try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
  })();
  const observeOnly = params.has("observe") || !!params.get("view");
  const ownerToken = params.get("owner") || "";

  if (observeOnly) {
    // 明确告诉界面「没连桥」,免得状态点显示成绿的、让人以为工具能用
    onStatus?.({ connected: false });
    return () => {};
  }

  const connect = () => {
    if (!active) return;
    source = new EventSource(
      ownerToken ? `/api/mcp/events?owner=${encodeURIComponent(ownerToken)}` : "/api/mcp/events",
    );

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
        if (ownerToken) {
          /*
           * 有令牌的页面被踢掉,只可能是同一把钥匙的另一个连接(比如自己刚重载过一次,
           * 旧连接还没断)。这种情况**要抢回来** —— 无头实例被踢就等于整个任务哑了,
           * 而它是没人会去手动刷新的那一个。等两秒再连,避开两个连接互相顶的抖动。
           */
          window.setTimeout(connect, 2000);
        } else {
          window.dispatchEvent(new CustomEvent("ai-chat-error", { detail: "另一个编辑台页面接管了 AI 连接" }));
          active = false;
        }
      } else if (ev.type === "call") {
        const id = ev.id;
        const tool = ev.tool;
        const args = ev.args as any;
        // 多 Agent:服务端把发起这次调用的 Agent 对话 ID 带过来(走 agy 或外部命令行的没有)
        const agent: string | null = typeof ev.agent === "string" && ev.agent ? ev.agent : null;
        // 时间轴操作前后各看一眼项目,算出这次改了哪几条「剪辑->序列」,记到公告板上给别的 Agent 看
        const before = TIMELINE_TOOLS.has(tool) ? getState().project : null;
        const api = getApi();
        let ok = true;
        let result: unknown;
        let error: string | undefined;

        try {
          const missing = missingRequired(tool, args);
          if (missing.length > 0) {
            throw new Error(`缺少必填参数：${missing.join("、")}。请补齐后重试。`);
          }
          // 多 Agent 协调的四个工具不碰编辑台,直接在公告板(agentBus)上办
          if (tool === "declare_scope") result = agentBus.declareScope(agent, args);
          else if (tool === "list_agents") result = agentBus.listAgents(agent);
          else if (tool === "send_message") result = agentBus.sendMessage(agent, args);
          else if (tool === "check_messages") result = agentBus.checkMessages(agent);
          else if (tool === "background_job_status") result = api.backgroundJobStatus(args);
          else if (tool === "list_cards") result = api.listCards(args);
          else if (tool === "get_project") result = api.getProject();
          else if (tool === "list_media") result = api.listMedia();
          else if (tool === "get_selection") result = api.getSelection();
          else if (tool === "add_clip") result = api.addClip(args);
          else if (tool === "update_clip") result = api.updateClip(args);
          else if (tool === "list_cuts") result = api.listCuts();
          else if (tool === "switch_cut") result = api.switchCut(args);
          else if (tool === "add_cut") result = api.addCut(args);
          else if (tool === "rename_cut") result = api.renameCut(args);
          else if (tool === "remove_cut") result = api.removeCut(args);
          else if (tool === "set_position") result = api.setPosition(args);
          else if (tool === "set_rect") result = api.setRect(args);
          else if (tool === "align") result = api.align(args);
          else if (tool === "nudge") result = api.nudge(args);
          else if (tool === "get_layout") result = api.getLayout(args);
          else if (tool === "get_clip") result = api.getClip(args);
          else if (tool === "list_parts") result = api.listParts(args);
          else if (tool === "add_composite") result = api.addComposite(args);
          else if (tool === "add_part") result = api.addPart(args);
          else if (tool === "set_part") result = api.setPart(args);
          else if (tool === "remove_part") result = api.removePart(args);
          else if (tool === "move_part") result = api.movePart(args);
          else if (tool === "set_clip") result = api.setClip(args);
          else if (tool === "remove_clip") result = api.removeClip(args);
          else if (tool === "duplicate_clip") result = api.duplicateClip(args);
          else if (tool === "split_clip") result = api.splitClip(args);
          else if (tool === "list_transitions") result = api.listTransitions();
          else if (tool === "add_transition") result = api.addTransition(args);
          else if (tool === "remove_transition") result = api.removeTransition(args);
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
          else if (tool === "collect_status") result = await api.collectStatus();
          else if (tool === "collect_search") result = await api.collectSearch(args);
          else if (tool === "collect_install") result = await api.collectInstall();
          else if (tool === "collect_probe") result = await api.collectProbe(args);
          else if (tool === "collect_download") result = await api.collectDownload(args);
          else if (tool === "collect_job") result = await api.collectJob(args);
          else if (tool === "collect_login") result = await api.collectLogin(args);
          else if (tool === "collect_login_check") result = await api.collectLoginCheck(args);
          else if (tool === "collect_logout") result = await api.collectLogout(args);
          else if (tool === "create_card") result = await api.createCard(args);
          else if (tool === "get_card_source") result = await api.getCardSource(args);
          else if (tool === "edit_card") result = await api.editCard(args);
          else if (tool === "see_preview") result = await api.seePreview(args);
          else if (tool === "see_sequences") result = await api.seeSequences(args);
          else if (tool === "card_authoring_guide") result = await api.cardAuthoringGuide();
          // 网页操作不经过 EditorApi:浏览器整个在服务端,这些工具不碰编辑台的任何状态。
          // 挂进 EditorApi 只会逼编辑台那边实现 8 个纯转发的方法。
          else if (tool.startsWith("web_")) result = await runWebTool(tool, args);
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

        // 做成了一次时间轴动作 → 给 SKILL 悬浮窗刷一张预览(只在无头实例里生效,失败静默)
        if (ok) {
          try { reportLastAction(api, tool, args, result); } catch { /* 预览是附带的,不影响结果 */ }
          if (before) {
            try { agentBus.noteToolChange(agent, tool, before, getState().project); } catch { /* 公告板是附带的 */ }
          }
        }
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
