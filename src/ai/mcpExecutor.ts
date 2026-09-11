// mcp-tools.mjs 是纯数据、没有 node 依赖，前端可以直接引；它没有 .d.ts，
// 所以在这里就地声明用到的那点形状。
// @ts-expect-error 无类型声明的 .mjs
import { tools as RAW_TOOL_SPECS } from "../../server/mcp-tools.mjs";
import { webOpen, webView, webClick, webType, webScroll, webRead, webHandoff, webClose } from "./web";
import { requestAgentBrowser, closeAgentBrowser } from "./agentBrowserStore";
import * as agentBus from "./agentBus";
import { getState } from "../store/project";
import { prerenderUrl } from "../editor/prerender";
import { flushDataMirror, startDataMirror } from "../editor/dataMirror";
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
  setPosition(args: { clipId: string; space?: "world" | "local"; x?: number; y?: number; w?: number; h?: number; anchor?: [number, number]; scale?: number; rotate?: number; rotateX?: number; rotateY?: number; translateZ?: number; clear?: boolean; clamp?: boolean }): any;
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
  setClipVolume(args: { clipId: string; volume: number }): any;
  separateAudio(args: { clipId: string }): any;
  createAudio(args: { mediaId?: string; clipId?: string }): any;
  setEmphasis(args: { clipId: string; kind: string; color?: string; size?: number; opacity?: number; dx?: number; dy?: number }): any;
  listTransitions(): any;
  addTransition(args: { kind: string; clipId: string; otherClipId?: string; dur?: number }): any;
  removeTransition(args: { transitionId: string }): any;
  // 序列(轨道)。校验和门槛在 editor/right/trackTools.ts
  addTrack(args: { name?: string; index?: number }): any;
  listTracks(): any;
  removeTrack(args: { trackId?: string; trackIds?: string[]; force?: boolean; reason?: string }): any;
  updateTrack(args: { trackId: string; name?: string; hidden?: boolean; muted?: boolean; locked?: boolean }): any;
  moveTrack(args: { trackId: string; index: number }): any;
  // 滤镜库。校验和门槛在 editor/right/filterTools.ts,数值和三条管线的翻译在 kernel/filters.mjs
  listFilters(): any;
  createFilter(args: any): any;
  updateFilter(args: any): any;
  removeFilter(args: { filterId: string; force?: boolean; reason?: string }): any;
  applyFilter(args: { clipId: string; filterId: string; params?: Record<string, number> }): any;
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
  setCamera3d(args: { enabled?: boolean; fovDeg?: number }): any;
  bakeCard(args: { clipId: string; t?: number; size?: number; bg?: string }): Promise<any>;
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
  listCaptions(args: { clipId?: string }): any;
  editCaption(args: { clipId?: string; op?: string; index?: number; text?: string; en?: string; start?: number; end?: number }): any;
  importMedia(args: { url?: string; name?: string }): Promise<any>;
  // 配音:云端 TTS 生成 mp3 进素材库,给 start 就上时间轴
  voiceList(): Promise<any>;
  voiceGenerate(args: { text: string; start?: number; trackId?: string; provider?: string; voiceId?: string; speed?: number; emotion?: string; name?: string }): Promise<any>;
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
  getCardSource(args: { cardId: string; file?: string }): Promise<any>;
  editCard(args: { cardId: string; file?: string; find: string; replace: string; replaceAll?: boolean }): Promise<any>;
  /** 只读 DOM 树(inspect_card_dom):每个节点标出源码位置,改动一律走 editCard */
  inspectCardDom(args: { clipId: string; t?: number; ref?: number | string; depth?: number }): Promise<any>;
  seePreview(args: { t?: number; clipId?: string; times?: number[] }): Promise<any>;
  seeSequences(args: { mediaId: string; page?: number; perPage?: number; grid?: number; scene?: number; from?: number; to?: number }): Promise<any>;
  cardAuthoringGuide(): Promise<any>;
}

/** 这些工具改的是时间轴:做成一次,就值得给 SKILL 悬浮窗下面那张预览图刷新一次 */
const TIMELINE_TOOLS = new Set([
  "add_clip", "update_clip", "remove_clip", "duplicate_clip", "split_clip",
  "add_transition", "remove_transition", "set_clip_volume", "separate_audio", "create_audio", "set_emphasis",
  "set_position", "set_rect", "align", "nudge", "fill_captions", "edit_caption", "attach_clip_motion", "detach_clip_motion",
  "add_track", "remove_track", "update_track", "move_track",
  "create_filter", "update_filter", "remove_filter", "apply_filter",
  "switch_cut", "add_cut", "set_theme", "voice_generate",
]);

/**
 * 聊天栏的「看得见的结果」。
 *
 * 用户在简洁界面点开一个工具,原来看到的是入参和结果的 JSON —— 那是给调试看的。
 * 看图的工具该看到当时返回的那张图,加卡 / 删卡该看到那张卡,改卡该看到改了哪几个参数
 * 和前后两段动图。这些东西只有执行工具的这个页面拿得到(改之前的工程、返回的位图),
 * 所以在这里交给服务端存一份「可视化记录」,把它的 id 放在结果最前面:四家的工具结果
 * 摘要都保留开头那一截,聊天栏凭这个 id 去取记录。
 *
 * 动图不在这里渲:这里只存「怎么渲」(那张卡当时的样子),用户点开时服务端才渲。
 * 所以 Agent 调工具只多一次本地写文件;交记录最多等 3 秒,超时就不带,工具结果照常返回。
 */
const CLIP_EDIT_TOOLS = new Set([
  "update_clip", "set_clip", "set_position", "set_rect", "align", "nudge", "set_emphasis",
  "add_part", "set_part", "remove_part", "move_part",
]);
const CLIP_CREATE_TOOLS = new Set(["add_clip", "duplicate_clip", "add_composite"]);

function cloneProject<T>(p: T): T {
  try { return structuredClone(p); } catch { return JSON.parse(JSON.stringify(p)); }
}

function visualRequest(tool: string, args: any, result: any, before: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || result.ok === false) return null;
  if (tool === "see_frames") {
    const images: { mime?: string; base64: string; label: string }[] = [];
    if (result.__image?.base64) images.push({ mime: result.__image.mime, base64: result.__image.base64, label: typeof result.t === "number" ? `t=${result.t}s` : "" });
    for (const im of Array.isArray(result.__images) ? result.__images : []) {
      if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? (im.sceneIndex != null ? `镜头 ${im.sceneIndex}` : "") });
    }
    return images.length ? { tool, images } : null;
  }
  if (CLIP_CREATE_TOOLS.has(tool)) {
    const id = result.id || result.clipId;
    return id ? { tool, clipId: id, after: getState().project } : null;
  }
  if (tool === "remove_clip") return before && args?.clipId ? { tool, clipId: args.clipId, before } : null;
  if (CLIP_EDIT_TOOLS.has(tool)) return before && args?.clipId ? { tool, clipId: args.clipId, before, after: getState().project } : null;
  return null;
}

async function withVisual(tool: string, args: any, result: unknown, before: unknown): Promise<unknown> {
  try {
    const body = visualRequest(tool, args, result, before);
    if (!body) return result;
    const res = await fetch(await prerenderUrl("/api/ai/visual"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok || !data.visualId) return result;
    return { visualId: data.visualId, ...(result as object) };
  } catch {
    return result; // 可视化是附带的,交不上就算了
  }
}

/** get_gif:把一张卡整段均匀抽 8 帧,用户看动图、模型看 4×2 拼图 */
async function getGif(args: { clipId: string }) {
  // 兜底路径(有数据镜像时服务端直接做,见 vite-plugin-ai 的服务端工具)。发到预渲染的源上,180 秒就放手
  const res = await fetch(await prerenderUrl("/api/ai/visual"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "get_gif", clipId: args.clipId, after: getState().project, render: true }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `做动图失败(HTTP ${res.status})`);
  return {
    visualId: data.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
    note: `拼图 4×2,第 k 格对应 times 的第 k 个时刻(按行从左到右)。用户在聊天栏点开这一步能看到动图。`,
    ...(data.grid ? { __image: { mime: "image/png", base64: data.grid } } : {}),
  };
}

function isHeadlessPage(): boolean {
  try { return new URLSearchParams(location.search).has("headless"); } catch { return false; }
}

/** 同一时刻只渲染一张:agent 连着改十张卡,预览跟着渲染十次没意义,只留最后那次 */
let lastActionBusy = false;
let lastActionPending: (() => Promise<void>) | null = null;

/**
 * SKILL 模式的悬浮窗下面显示「agent 上一步做成的动作」的画面。
 *
 * 只在无头实例的页面里做(它才是被 agent 操控的那份):动作成功后按 see_frames 那条路
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
      /*
       * 连着桥的这个页面才是「编辑台」,由它把项目镜像给服务端(数据管理的只读镜像,见 src/editor/dataMirror.ts)。
       * 只读观看页(observe / view)上面已经 return 了,不会走到这里 —— 两个页面同时推会互相覆盖。
       */
      startDataMirror();
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
        // 聊天栏要画「改之前」的那张卡:只有改卡 / 删卡的工具才拍这一份
        const visualBefore = CLIP_EDIT_TOOLS.has(tool) || tool === "remove_clip" ? cloneProject(getState().project) : null;
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
          else if (tool === "set_clip_volume") result = api.setClipVolume(args);
          else if (tool === "separate_audio") result = api.separateAudio(args);
          else if (tool === "create_audio") result = api.createAudio(args);
          else if (tool === "set_emphasis") result = api.setEmphasis(args);
          else if (tool === "list_transitions") result = api.listTransitions();
          else if (tool === "add_transition") result = api.addTransition(args);
          else if (tool === "remove_transition") result = api.removeTransition(args);
          else if (tool === "add_track") result = api.addTrack(args);
          else if (tool === "list_tracks") result = api.listTracks();
          else if (tool === "remove_track") result = api.removeTrack(args);
          else if (tool === "update_track") result = api.updateTrack(args);
          else if (tool === "move_track") result = api.moveTrack(args);
          else if (tool === "list_filters") result = api.listFilters();
          else if (tool === "create_filter") result = api.createFilter(args);
          else if (tool === "update_filter") result = api.updateFilter(args);
          else if (tool === "remove_filter") result = api.removeFilter(args);
          else if (tool === "apply_filter") result = api.applyFilter(args);
          else if (tool === "seek") result = api.seek(args);
          else if (tool === "play") result = api.play();
          else if (tool === "pause") result = api.pause();
          else if (tool === "set_theme") result = api.setTheme(args);
          else if (tool === "set_project_meta") result = api.setProjectMeta(args);
          else if (tool === "set_camera3d") result = api.setCamera3d(args);
          else if (tool === "bake_card") result = await api.bakeCard(args);
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
          else if (tool === "list_captions") result = api.listCaptions(args);
          else if (tool === "edit_caption") result = api.editCaption(args);
          else if (tool === "import_media") result = await api.importMedia(args);
          else if (tool === "voice_list") result = await api.voiceList();
          else if (tool === "voice_generate") result = await api.voiceGenerate(args);
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
          else if (tool === "inspect_card_dom") result = await api.inspectCardDom(args);
          else if (tool === "see_frames") {
            // 一个工具两种画面:成片(timeline)走 seePreview,素材镜头拼图(media)走 seeSequences
            const { source, ...rest } = (args ?? {}) as any;
            if (source === "media") {
              result = rest.mediaId
                ? await api.seeSequences(rest)
                : { ok: false, error: 'source 为 "media" 时要给 mediaId(list_media 里的素材 id)' };
            } else if (source === "timeline" || source === undefined) {
              result = await api.seePreview(rest);
            } else {
              result = { ok: false, error: `source 只能是 "timeline"(成片画面)或 "media"(素材镜头拼图),收到的是 ${JSON.stringify(source)}` };
            }
          }
          else if (tool === "get_gif") result = await getGif(args);
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

        if (ok && tool !== "get_gif") result = await withVisual(tool, args, result, visualBefore);

        /*
         * 回结果之前把这次改动推给数据镜像:Agent 改完马上 see_frames 时,服务端拿镜像去渲,
         * 必须已经是改完的那一份(读后写一致)。没改动时这一步什么都不发。
         */
        try { await flushDataMirror(); } catch { /* 推不上不影响这次结果;服务端没有新镜像时会退回经页面执行 */ }

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
