import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { overLimit } from './http-guard.mjs';
import { stagePortsOf } from './stage-ports.mjs';
import { createCallPairing } from './agent/call-pairing.mjs';
import { createAgentSessions } from './agent/agent-sessions.mjs';
import { createDesktopActivity } from './agent/desktop-activity.mjs';
import { createAgentBoards } from './agent/agent-board.mjs';
import { attachLink, createMultiAgent } from './agent/multi-agent.mjs';
import { createPresenceBridge } from './agent/presence-bridge.mjs';
import { loadRole } from './agent/agent-roles.mjs';
import { annotateError, annotateResult, createUserEditingBoard, userEditingFor } from './agent/user-editing.mjs';
import { effectiveIsFile } from './card-overrides.mjs';
import { CREATIVITY_HINT, CREATIVITY_LABEL, normalizeCreativity, projectCreativity } from '../src/kernel/creativity.mjs';
/*
 * 必须静态 import:vite 打包配置时,别的插件静态引入的 prerender-client.mjs 被打进同一个包里,
 * 状态(预渲染的地址、就绪没有)在那一份上。这里要是换成 import(new URL(...)) 动态加载,拿到的是
 * 磁盘上的另一份模块实例,状态永远是空的 —— 实测服务端 see_frames 在 whenPrerenderReady 里干等 60 秒。
 */
import { prerenderPost } from './prerender-client.mjs';
// 镜像的存储本体在镜像插件里(两个进程都挂);这里只读当前编辑页 session 的最新一版
import { latestMirror, latestPlayhead } from './vite-plugin-mirror';


/**
 * 在文件管理器里打开一个目录。
 * explorer 打开目录时退出码就是 1,所以这里不看退出码,也不等它。
 */
function revealInFileManager(dir: string) {
  const opener = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了,文件已经写好了,路径也会回给界面 */
  }
}

function sendJson(res: ServerResponse, code: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/* 请求体超限的 413:实现挪去 server/http-guard.mjs 了,vision 那边也要用同一份 */

export default function vitePluginAi(): Plugin {
  let editorRes: ServerResponse | null = null;
  let nextCallId = 1;
  const pendingCalls = new Map<number, (result: any) => void>();
  const activeRuns = new Map<string, { abort: () => void, finished: boolean, provider?: string, fail?: (message: string) => void }>();
  /**
   * codex、agy 两路的 callId 配对(server/agent/call-pairing.mjs):runner 在输出流里看到工具调用就报到,
   * /api/mcp/call 进来的同一次调用按 mcp-server.mjs 转来的线索认领,拿到和聊天记录里同一个 callId。
   */
  const callPairing = createCallPairing();
  /**
   * CLI 额度熔断(server/runners/quota.mjs):对话开始前 gate,结束后按新增字节记账、到线后台重查;
   * 重查发现超线就把同一路正在跑的对话全部掐掉。模块懒加载,和别的 runner 一样。
   */
  let quotaGuardPromise: Promise<any> | null = null;
  const getQuotaGuard = () => {
    quotaGuardPromise ??= import(new URL('./runners/quota.mjs', import.meta.url).href).then((m: any) => ({ guard: m.createQuotaGuard(), mod: m }));
    return quotaGuardPromise;
  };
  const failProviderRuns = (provider: string, message: string) => {
    for (const [id, st] of activeRuns) {
      if (st.finished || st.provider !== provider) continue;
      try { st.fail?.(message); } catch {}
      try { st.abort(); } catch {}
      st.finished = true;
      activeRuns.delete(id);
    }
  };

  return {
    name: 'vite-plugin-ai',
    configureServer(server) {
      server.httpServer?.on('listening', () => {
        // 这个文件是桌面 APP 的会话(server/mcp-server.mjs)找「用户正在用的那个实例」的依据,被别的实例盖掉就会
        // 把用户的桌面 APP 引到错误的端口上。测试与探针起的编辑器(PROMPTCUT_NO_PORT_FILE=1)不写:公共入口
        // scripts/lib/no-user-dirs.mjs 与 npm test 的全局准备把它设上;桌面版和用户自己 `npm run dev` 起的编辑器照旧写
        if (process.env.PROMPTCUT_NO_PORT_FILE === '1') return;
        try {
          const addr = server.httpServer?.address();
          if (addr && typeof addr !== 'string') {
            const port = addr.port;
            let host = addr.address;
            if (host === '::' || host === '0.0.0.0') {
              host = '127.0.0.1';
            }
            const tmpDir = path.join(os.tmpdir(), 'promptcut');
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'port.json'), JSON.stringify({
              port,
              host,
              /*
               * 两个舞台端口(E1)。编辑器端口 +1 / +2 的反向代理,舞台 iframe 从它们加载 ——
               * 写进来是给**页面之外**的人看的:桌面壳要按它给 WebView2 放行 / 探端口占用,
               * 探针脚本不用再自己推算。页面不读这里(端口表由 vite-plugin-stage-ports 注入)。
               * 代理没起来(端口被占)时页面退回同源单舞台,这张表仍然是「本该是哪两个」。
               */
              stagePorts: stagePortsOf(port),
              pid: process.pid,
              startedAt: Date.now()
            }));
          }
        } catch {}
      });

      async function getRunner() {
        let runnerUrl;
        if (process.env.PROMPTCUT_AI_FAKE_RUNNER === '1') {
          runnerUrl = new URL('./test/fake-runner.mjs', import.meta.url).href;
        } else {
          const mod = process.env.PROMPTCUT_AI_RUNNER_MODULE || './runners/index.mjs';
          runnerUrl = new URL(mod, import.meta.url).href;
        }
        try {
          return await import(runnerUrl);
        } catch (e: any) {
          throw new Error(`Runner 尚未就绪或加载失败: ${e.message}`);
        }
      }

      /**
       * agent:发起这次调用的 Agent 对话 ID(多 Agent 分页)。CLI 那条路由 mcp-server 从环境变量
       * PROMPTCUT_AGENT 带上来,API 直连那条路由 startRun 的 callTool 闭包带;编辑台拿它记「谁改了哪儿」。
       */
      /*
       * 数据管理的只读镜像(docs/archive/topics/decoupling-plan.md 第 3.2 节,阶段 4;A7)。
       *
       * 编辑页把项目(带版本号)推给**镜像插件**(server/vite-plugin-mirror.ts,两个进程都挂),
       * 播放头走它的 /api/data/playhead。这里只读:Agent 的读和渲染 —— get_project /
       * see_frames(成片)/ get_gif / bake_card / inspect_card_dom —— 直接拿镜像去问预渲染进程,
       * **完全不经过编辑器页面**:以前这些调用要经 SSE 转给页面,页面再发渲染请求,请求一挂几分钟,
       * 占的是编辑器那个源的连接,界面因此卡死而 CPU 一点都不忙。
       * 写操作仍然经过页面(撤销 / 重做都在那边),页面在回结果之前会先把改动推过来,读后写一致。
       * 页面关掉之后镜像还留在内存里,Agent 照样能读、能看画面。
       *
       * 镜像本身(存储、版本窗口、两层 diff、转发给预渲染)搬到镜像插件里了 —— ai 插件只在
       * 编辑器那一端挂,而预渲染进程也要按键取项目。
       */

      /**
       * 这几个工具在服务端就地执行(有镜像时);其余照旧经编辑器页面。
       * C6.5 D4:绑了项目副本(见下面 bindAgent)时不再用镜像 —— 这几个加上 get_layout 由 server/agent/agent-exec.mjs
       * 读**副本**执行,回包带 rev;这张表只管没绑副本时的老路。
       */
      const MIRRORED_TOOLS = new Set(['get_project', 'see_frames', 'get_gif', 'bake_card', 'inspect_card_dom']);

      /**
       * 服务端执行一个读 / 渲染类工具。返回 undefined = 这里不接,交给编辑器页面。
       * 出错就抛(和经页面那条路一样:桥把 error 原样交给 Agent)。
       */
      async function runMirroredTool(tool: string, args: any, toolDef: any): Promise<any> {
        const mirror = latestMirror();
        if (!MIRRORED_TOOLS.has(tool) || !mirror) return undefined;
        const required: string[] = toolDef?.inputSchema?.required ?? [];
        const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
        if (missing.length) throw new Error(`缺少必填参数：${missing.join('、')}。请补齐后重试。`);
        const project = mirror.project;
        const timeoutMs = toolDef?.timeoutMs || 60000;

        if (tool === 'get_project') {
          // 和编辑器页面的 getProject 同一个形状:文字稿只给摘要,全文走 get_transcript
          return {
            ...project,
            media: (project.media || []).map((m: any) => m?.transcript ? {
              ...m,
              transcript: {
                engine: m.transcript.engine, model: m.transcript.model, language: m.transcript.language,
                createdAt: m.transcript.createdAt, segments: m.transcript.segments?.length ?? 0,
                hint: '完整文字稿请用 get_transcript',
              },
            } : m),
          };
        }

        if (tool === 'see_frames') {
          const { source, ...rest } = args || {};
          // 素材镜头拼图要跑镜头识别、写回项目,留给编辑器页面
          if (source !== undefined && source !== 'timeline') return undefined;
          const times = Array.isArray(rest.times) ? rest.times.filter((x: unknown) => typeof x === 'number').slice(0, 10) : [];
          const body = times.length
            ? { project, times, clipId: rest.clipId }
            : { project, t: typeof rest.t === 'number' ? rest.t : (rest.clipId ? undefined : (latestPlayhead()?.t ?? 0)), clipId: rest.clipId };
          const data = await prerenderPost('/api/vision/snapshot', body, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '渲染画面失败');
          let result: any = times.length ? { ok: true, frames: data.frames, note: data.note, __images: data.__images } : data;
          // 聊天栏里「看得见的工具结果」:和编辑器页面的 withVisual 同一份记录
          const images: any[] = [];
          if (data.__image?.base64) images.push({ mime: data.__image.mime, base64: data.__image.base64, label: typeof data.t === 'number' ? `t=${data.t}s` : '' });
          for (const im of Array.isArray(data.__images) ? data.__images : []) if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? '' });
          if (images.length) {
            const v = await prerenderPost('/api/ai/visual', { tool: 'see_frames', images }, { timeoutMs: 5000 }).catch(() => null);
            if (v?.ok && v.visualId) result = { visualId: v.visualId, ...result };
          }
          return result;
        }

        if (tool === 'get_gif') {
          // 两步(cloud-task.md 决议 12):Agent 这一侧只写规格(`'agent'`),像素渲染交给 `user` 那一侧的 `/render`
          const spec = await prerenderPost('/api/ai/visual', { tool: 'get_gif', clipId: args.clipId, after: project }, { timeoutMs });
          if (!spec?.ok) throw new Error(spec?.error || '做动图失败');
          if (!spec.gifKey) throw new Error(`时间轴上没有 id 为 ${args.clipId} 的片段。`);
          const data = await prerenderPost('/api/ai/visual/render', { key: spec.gifKey }, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '做动图失败');
          return {
            visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
            note: '拼图 4×2,第 k 格对应 times 的第 k 个时刻(按行从左到右)。用户在聊天栏点开这一步能看到动图。',
            ...(data.grid ? { __image: { mime: 'image/png', base64: data.grid } } : {}),
          };
        }

        if (tool === 'bake_card') {
          const data = await prerenderPost('/api/vision/bake', { project, clipId: args.clipId, t: args.t, size: args.size, bg: args.bg }, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '渲染失败');
          return data;
        }

        if (tool === 'inspect_card_dom') {
          const ref = typeof args.ref === 'string' ? Number(String(args.ref).replace(/^ref_/, '')) : args.ref;
          const data = await prerenderPost('/api/cards/dom', { project, clipId: args.clipId, t: args.t, ref, depth: args.depth }, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '读不到 DOM 树');
          return data;
        }
        return undefined;
      }

      /*
       * ---------------- C6.5:Agent 服务端的项目副本(D1、D2、D4;docs/plan/c65-design.md 第 5、7 节) ----------------
       *
       * 页面接上文档服务后调 POST /api/agent/bind 告诉这里「我在编辑哪个项目、连的是哪个文档服务」。绑上之后:
       *   - side: "agent" 的工具在这里、在项目副本上执行(server/agent/agent-exec.mjs),写入以 Agent 对话的身份、
       *     带期望版本提交给文档服务,不再经页面;get_project / get_layout / see_frames 等读副本;
       *   - 每个工具调用(不论在哪一侧执行)向文档服务的 events 模块发创建 / 完成两条事件,文字回复整条完成时发一条。
       * 没绑(页面没接文档服务、无头实例停用了文档服务)时一切照旧:写工具经 SSE 送页面执行,读工具读数据镜像。
       *
       * 凭证按对话号给(server/agent/doc-link.mjs 一个对话一条连接):
       *   - mode "local":本机 local 空间,回环 + promptcut.role.agent.<n>;
       *   - mode "lan-host":局域网主机上创建者自己的共享项目,本机声明 promptcut.tenant.<projectId> + promptcut.role.agent.<n>;
       *   - mode "ticket":共享项目(托管端、局域网成员),经 SSE 向页面要一张连接票据(k:'conn', r:'agent', c:<n>),
       *     页面用 POST /api/agent/ticket 交回。
       */
      /*
       * 「用户正在编辑」(计划 agent-workflow-plan.md A2):编辑页把正在编辑的片段节流推到 POST /api/agent/editing,
       * 这里记下(带过期时刻)。Agent 读或写到这些片段时工具结果带 userEditing 和一句提示;只提示,不拦。
       */
      const userEditingBoard = createUserEditingBoard();
      /** 对话 id → 给人看的厂商名(覆盖提示里「Agent <身份>(<厂商>)刚改过」用;桌面 APP 的会话用「Claude Code」这样的名字;登记表在下面) */
      const agentLabelOf = (key: string): string | null => {
        try { const e = agentSessions.get(key); return e?.label ?? e?.vendor ?? null; } catch { return null; }
      };

      type AgentBinding = { projectId: string; mode: string; url: string; side: any; detachBoard?: () => void };
      let agentBinding: AgentBinding | null = null;
      let ticketSeq = 0;
      const ticketWaiters = new Map<string, { resolve: (ticket: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const AGENT_MODES = new Set(["local", "lan-host", "ticket"]);
      const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
      const editorPortOf = () => (server.httpServer?.address() as any)?.port || 5195;
      const agentLog = (event: string, fields: object = {}) => {
        try { console.info("[agent]", event, JSON.stringify(fields)); } catch { console.info("[agent]", event); }
      };

      /** 向页面要一张 agent 角色的连接票据(页面凭它在文档服务上的身份签) */
      function requestTicket(projectId: string, conversation: number): Promise<string> {
        return new Promise((resolve, reject) => {
          if (!editorRes) return reject(new Error("编辑台没有打开,要不到连接票据"));
          const reqId = `t${++ticketSeq}`;
          const timer = setTimeout(() => {
            ticketWaiters.delete(reqId);
            reject(new Error("页面 10 秒内没有交回连接票据"));
          }, 10_000);
          ticketWaiters.set(reqId, { resolve, reject, timer });
          editorRes.write(`data: ${JSON.stringify({ type: "agent.ticket", reqId, projectId, role: "agent", conversation })}\n\n`);
        });
      }

      async function bindAgent(input: any): Promise<AgentBinding> {
        const projectId = typeof input?.projectId === "string" && PROJECT_ID_RE.test(input.projectId) ? input.projectId : null;
        if (!projectId) throw new Error("projectId 不合法");
        const mode = typeof input?.mode === "string" ? input.mode : "local";
        if (!AGENT_MODES.has(mode)) throw new Error(`mode 只能是 ${[...AGENT_MODES].join(" / ")}`);
        let url = `ws://127.0.0.1:${editorPortOf()}/docservice`;
        if (mode === "ticket") {
          if (typeof input?.url !== "string" || !/^wss?:\/\//.test(input.url)) throw new Error("mode 为 ticket 时要给文档服务的 ws(s):// 地址");
          url = input.url;
        }
        if (agentBinding && agentBinding.projectId === projectId && agentBinding.mode === mode && agentBinding.url === url) return agentBinding;
        unbindAgent("rebind");
        const [{ createAgentSide }, { loadSsrHost }, { tools, toolGroups }] = await Promise.all([
          import(new URL("./agent/agent-side.mjs", import.meta.url).href),
          import(new URL("./agent/ssr-host.mjs", import.meta.url).href),
          import(new URL("./mcp-tools.mjs", import.meta.url).href),
        ]);
        const protocolsFor = async (n: number) => {
          if (mode === "local") return ["promptcut.v1", `promptcut.role.agent.${n}`];
          if (mode === "lan-host") return ["promptcut.v1", `promptcut.tenant.${projectId}`, `promptcut.role.agent.${n}`];
          return ["promptcut.v1", `promptcut.ticket.${await requestTicket(projectId, n)}`];
        };
        // 分派(side: agent / page / server)与事件都在 server/agent/agent-side.mjs 里,测试用同一份
        const side = createAgentSide({
          projectId,
          url,
          protocolsFor,
          tools,
          toolGroups,
          loadHost: () => loadSsrHost((id: string) => server.ssrLoadModule(id), { apiBase: `http://127.0.0.1:${editorPortOf()}` }),
          prerenderPost,
          playhead: () => latestPlayhead()?.t ?? 0,
          log: agentLog,
          pageResult: "wrapped",
          callPage: async (tool: string, args: any, ctx: any) => {
            const def = tools.find((t: any) => t.name === tool);
            const out = await callEditorPage(tool, args, ctx?.agent || undefined, def?.timeoutMs || (tool === "__page_state" ? 10_000 : 60_000));
            if (!out.ok) throw new Error(out.error);
            return { result: out.result || out, opIds: out.opIds };
          },
          callServer: (tool: string, args: any, ctx: any) => runServerTool(tool, args, ctx?.agent || ''),
          userEditing: () => userEditingBoard.current(),
          agentLabel: agentLabelOf,
          onPageWrites: (agent: string, opIds: string[]) => boards.boardFor(projectId).attributeOps(agent, opIds),
        });
        // 公告板的改动记录由这条连接的提交流喂;发给各对话连接的 project.overwritten 记给被覆盖的那个 Agent(A3)
        const detachLink = attachLink(side.link, () => boards.boardFor(projectId));
        /*
         * 跨设备(A3 第二阶段):经文档服务的在场状态收别的成员正在编辑的片段(进 A2 看板)、别的成员那边 Agent 的范围与消息
         * (进公告板),发本机 Agent 的范围与发给他们的消息。旧版文档服务不认识这些消息就停发,不报错。
         */
        const bridge = createPresenceBridge({
          link: side.link,
          board: () => boards.boardFor(projectId),
          editing: userEditingBoard,
          conversationNumberOf: (key: string) => side.conversationNumber(key),
          labelOf: agentLabelOf,
          infoOf: (key: string) => ({ role: agentSessions.get(key).role }),
          log: agentLog,
        });
        presenceBridge = bridge;
        boards.boardFor(projectId).onDeclare = (key: string) => { void bridge.publishAgent(key); };
        void bridge.start();
        const detachBoard = () => {
          detachLink();
          bridge.close();
          if (presenceBridge === bridge) presenceBridge = null;
          const b = boards.boardFor(projectId);
          b.onDeclare = null;
        };
        agentBinding = { projectId, mode, url, side, detachBoard };
        agentLog("agent.bind", { projectId, mode, url });
        return agentBinding;
      }

      function unbindAgent(reason: string) {
        const b = agentBinding;
        if (!b) return;
        agentBinding = null;
        try { b.detachBoard?.(); } catch { /* 已经解了 */ }
        try { b.side.close(); } catch { /* 已经关了 */ }
        agentLog("agent.unbind", { projectId: b.projectId, reason });
      }
      server.httpServer?.once("close", () => unbindAgent("server-close"));

      /** 审查环路走 CLI 时的只读锁:null = 不锁;Set = 只放行这些工具(空 Set = 全拦)。见下面 callToolInternal */
      let loopToolLock: Set<string> | null = null;

      /*
       * Agent 会话登记表(server/agent/agent-sessions.mjs):对话 ID → 类型、厂商、角色、创造力等级的覆盖值。
       * /api/ai/chat 每次发消息登记一次;桌面 APP 的会话每次调用在 /api/mcp/call 登记(类型 desktop,跟项目)。
       */
      const agentSessions = createAgentSessions();
      /*
       * 桌面 APP 会话在 AI 栏里的分组(A4,server/agent/desktop-activity.mjs):厂商、正在进行的操作、交上来的进度报告。
       * 变了就把整份快照经 SSE(agent.desktop)推给页面,节流 100 毫秒。
       */
      let desktopPushTimer: ReturnType<typeof setTimeout> | null = null;
      const pushDesktop = () => {
        if (desktopPushTimer) return;
        desktopPushTimer = setTimeout(() => {
          desktopPushTimer = null;
          if (!editorRes) return;
          try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.desktop', sessions: desktopActivity.snapshot() })}\n\n`); } catch { /* 页面走了 */ }
        }, 100);
      };
      const desktopActivity = createDesktopActivity({ onChange: pushDesktop });
      /** /api/mcp/call 的 caller 字段:只认 mcp-server.mjs 报的桌面会话身份,形状不对就当没带 */
      const desktopCallerOf = (c: any): { key: string; vendor: string | null; label: string | null; client: { name: string; version: string } | null } | null => {
        if (!c || typeof c !== 'object' || c.type !== 'desktop') return null;
        if (typeof c.key !== 'string' || !/^desk-[A-Za-z0-9_-]{1,59}$/.test(c.key)) return null;
        const str = (v: any, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : null);
        const client = c.client && typeof c.client === 'object' && typeof c.client.name === 'string'
          ? { name: c.client.name.slice(0, 64), version: typeof c.client.version === 'string' ? c.client.version.slice(0, 32) : '' }
          : null;
        return { key: c.key, vendor: str(c.vendor, 64), label: str(c.label, 64), client };
      };
      /**
       * SKILL 悬浮窗下面的「上一步做成的动作」预览(desktop/src-tauri/src/skill_shell.rs 盯 skillRoot/last-action.*):
       * 桌面会话做成一次操作、SKILL 模式开着时,让页面渲一张那一刻的画面交回来(页面只对时间轴操作照做,失败静默)。
       * 原来这件事由无头实例的页面做,无头实例归档之后由用户这份页面做。
       */
      const requestSkillPreview = (tool: string, args: any, result: any) => {
        if (!editorRes || (result && typeof result === 'object' && result.ok === false)) return;
        void import(new URL('./skill-gate.mjs', import.meta.url).href).then((gate: any) => {
          if (!gate.readState().active || !editorRes) return;
          const clipId = typeof args?.clipId === 'string' ? args.clipId : typeof result?.clip?.id === 'string' ? result.clip.id : null;
          const start = typeof args?.start === 'number' ? args.start : null;
          try { editorRes.write(`data: ${JSON.stringify({ type: 'skill.preview', tool, clipId, start })}\n\n`); } catch { /* 页面走了 */ }
        }).catch(() => {});
      };
      /** 页面发消息时顺手报上来的项目默认等级:服务端读不到项目(没绑副本、没有镜像)时用它 */
      let projectCreativityHint: string | null = null;
      /**
       * 项目当前的默认等级。按新鲜程度:绑了项目副本就读副本(文档服务的最新版本),
       * 否则读页面推来的镜像,再没有用页面发消息时报的那个,都没有按出厂的「高」。
       */
      function currentProjectCreativity(): string {
        const replica = (agentBinding as any)?.side?.link?.replica?.project;
        if (replica && typeof replica === 'object') return projectCreativity(replica);
        const mirrored = latestMirror()?.project;
        if (mirrored && typeof mirrored === 'object') return projectCreativity(mirrored);
        return normalizeCreativity(projectCreativityHint) ?? projectCreativity(null);
      }
      /** create_card 的等级按「这张用户卡在不在」判(整篇重写已有的 = 中,新建 = 高);按生效的那一份判,改动层优先 */
      function userCardExists(id: string): boolean {
        return effectiveIsFile(server.config.root, path.join(server.config.root, 'src', 'cards', 'user', `${id}.tsx`));
      }

      /*
       * ---------------- 多 Agent(计划 agent-workflow-plan.md A3) ----------------
       *
       * 公告板(server/agent/agent-board.mjs)按项目一份,在这个进程里:declare_scope / list_agents / send_message /
       * check_messages 在这里答(side: "server"),所有 Agent 看到同一份。改动记录由文档服务的提交流喂(绑了项目副本时,
       * attachLink),没绑时由页面执行器算好范围随结果带回来、在下面 dispatchTool 里记。
       * spawn_agent(server/agent/multi-agent.mjs)经 SSE 让页面开新页签(agent.spawn),页面 POST /api/agent/spawned 回话。
       * 页签上的范围名、未读标记经同一条 SSE 推给页面(agent.board);页面空闲时 POST /api/agent/inbox 取走消息发出。
       */
      /** 当前项目:绑了副本用副本的项目 id,否则用镜像里的项目 id,都没有是 ''(本机那一份) */
      const currentProjectKey = (): string => {
        const b = agentBinding;
        if (b) return b.projectId;
        const id = (latestMirror() as any)?.project?.id;
        return typeof id === 'string' ? id : '';
      };
      let lastTabs: any[] = [];
      let presenceBridge: any = null;
      let boardPushTimer: ReturnType<typeof setTimeout> | null = null;
      const pushBoard = () => {
        if (boardPushTimer) return;
        boardPushTimer = setTimeout(() => {
          boardPushTimer = null;
          if (!editorRes) return;
          try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.board', agents: board().snapshot() })}\n\n`); } catch { /* 页面走了 */ }
        }, 50);
      };
      const boards = createAgentBoards(() => ({
        labelOf: agentLabelOf,
        // 收件方在共享项目别的成员那边:经文档服务转过去(A3 第二阶段;没绑项目副本、旧版文档服务时转不出去)
        forwardRemote: (msg: any) => presenceBridge?.forward(msg) ?? false,
        infoOf: (key: string) => {
          const e = agentSessions.get(key);
          return { role: e.role, roleName: e.role && e.role !== 'main' ? loadRole(e.role)?.name ?? null : null, parent: e.parent };
        },
      }));
      const boardKeys = new Set<string>();
      /** 当前项目的公告板;第一次用到时订阅(变了就推给页面)并补上页面最近报的页签 */
      function board() {
        const key = currentProjectKey();
        const b = boards.boardFor(key);
        if (!boardKeys.has(key)) {
          boardKeys.add(key);
          b.subscribe(() => { if (currentProjectKey() === key) pushBoard(); });
          if (lastTabs.length) b.setTabs(lastTabs);
        }
        return b;
      }
      let spawnSeq = 0;
      const spawnWaiters = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      /** 让页面开一个子 Agent 的页签,等它回话(8 秒) */
      function openAgentTab(spec: any): Promise<void> {
        return new Promise((resolve, reject) => {
          if (!editorRes) return reject(new Error('编辑台没有打开,没有页签可开'));
          const reqId = `s${++spawnSeq}`;
          const timer = setTimeout(() => {
            spawnWaiters.delete(reqId);
            reject(new Error('页面 8 秒内没有开出页签'));
          }, 8_000);
          spawnWaiters.set(reqId, { resolve, reject, timer });
          editorRes.write(`data: ${JSON.stringify({ type: 'agent.spawn', reqId, ...spec })}\n\n`);
        });
      }
      const multiAgent = createMultiAgent({
        sessions: agentSessions,
        board,
        openTab: openAgentTab,
        projectCreativity: () => currentProjectCreativity(),
      });

      async function callToolInternal(tool: string, args: any, agent?: string, callId?: string): Promise<any> {
        const { tools } = await import(new URL('./mcp-tools.mjs', import.meta.url).href);
        const toolDef = tools.find((t: any) => t.name === tool);

        if (!toolDef) {
          const err = new Error('Unknown tool');
          (err as any).code = 'UNKNOWN_TOOL';
          throw err;
        }

        /*
         * 审查环路走 CLI 时的只读锁(runners/cli-loop.mjs 通过 setToolAccess 设置)。
         *
         * CLI 的 MCP 是全局登记的,没法按回合少给工具,所以只能在执行入口拦:reviewer / judger
         * 回合只放行只读名单,反省回合一个都不放行。锁是这个服务端全局的 —— 锁住的那几分钟里
         * 别的对话页发来的写操作也会被拦,这是有意的:reviewer 正在看的工程不该被同时改。
         */
        if (loopToolLock && !loopToolLock.has(tool)) {
          return {
            ok: false,
            error: loopToolLock.size
              ? `审查环路的这一回合是只读的:${tool} 这一回合不能用。能用的只有 ${[...loopToolLock].join('、')}。`
              : `审查环路的这一回合不调用任何工具,${tool} 被拒绝。只用文字回答。`,
          };
        }

        /*
         * SKILL 模式的闸门(server/skill-gate.mjs),按调用方类型拦(A4):登记过的桌面 APP 会话在 SKILL 模式关着时
         * 什么都不做,AI 栏的 Agent 不受它管。**拦在执行之前** —— 用户切回传统式就是收回了桌面 APP 的手,
         * 那边的会话可能正跑在半路并不知情;执行完再回滚是收拾不干净的。没登记过、也没报身份的调用按 unknown,不拦。
         */
        const callerEntry = agentSessions.get(agent);
        const gate = await import(new URL('./skill-gate.mjs', import.meta.url).href);
        const verdict = gate.checkGate(tool, callerEntry.registeredAt ? callerEntry.type : 'unknown');
        if (!verdict.ok) return { ok: false, skillClosed: true, error: verdict.message, message: verdict.message };

        /*
         * 堵口子(计划 agent-workflow-plan.md A1):set_project_meta 带了 schema 没声明的字段就整次拒绝。
         * 实现那一层(src/mcp/handlers/project.ts)也拦,这里是两条入口共同的一道。
         */
        const strict = await import(new URL('./agent/strict-args.mjs', import.meta.url).href);
        const unknownArgs = strict.undeclaredArgs(tool, toolDef, args);
        if (unknownArgs.length) return { ok: false, error: strict.undeclaredArgsError(tool, toolDef, unknownArgs) };

        /*
         * 创造力等级的闸门(server/agent/creativity-gate.mjs,对照表在那里)。这个对话生效的等级:
         * AI 栏的对话取它自己的覆盖值,没有就跟项目;桌面 APP 会话(没登记过的对话 ID)跟项目。拦在执行之前。
         */
        const creativityGate = await import(new URL('./agent/creativity-gate.mjs', import.meta.url).href);
        const { level: creativity, source: creativitySource } = agentSessions.creativityOf(agent, currentProjectCreativity());
        const allowed = creativityGate.checkCreativity(tool, args, creativity, { cardExists: userCardExists, source: creativitySource });
        if (!allowed.ok) {
          agentLog('agent.creativity-denied', { tool, agent: agent || '', ...allowed.creativity });
          return { ok: false, error: allowed.error, creativity: allowed.creativity };
        }
        agentSessions.touch(agent);

        /*
         * 绑了项目副本(C6.5):交给 server/agent/agent-side.mjs —— 每个工具调用前后各发一条事件(D2,带 callId),
         * side: "agent" 在副本上执行(D1 / D4),"page" 经页面,"server" 就地(runServerTool)。
         * 没绑:和以前一样,不发事件。
         */
        /*
         * 多 Agent(A3):包一层 —— 调用期间公告板知道「谁在跑什么工具」,调用完把要告诉它的(别的 Agent 给它的消息、
         * 别人动了它声明的范围、它写的被覆盖了、它写进了别人声明的范围)放进结果,notice 在最前。
         */
        return multiAgent.wrap(agent || '', tool, async () => {
          const binding = agentBinding;
          if (binding) return binding.side.callTool(tool, args, { agent: agent || '', callId });
          // 没绑副本:写经页面执行,写到哪些片段这里不知道,按参数点名的片段提示(绑了的在 agent-side 里按实际写到的算)
          try {
            const out = await dispatchTool(tool, args, agent, toolDef);
            return annotateResult(out, { userEditing: userEditingFor({ tool, args, editing: userEditingBoard.current() }) });
          } catch (err) {
            throw annotateError(err, userEditingFor({ tool, args, editing: userEditingBoard.current() }));
          }
        });
      }

      async function dispatchTool(tool: string, args: any, agent: string | undefined, toolDef: any): Promise<any> {
        /*
         * 读 / 渲染类工具有镜像时就地执行,直接问预渲染进程,不经过编辑器页面(见上面 runMirroredTool)。
         * 返回 undefined 的(没有镜像、素材拼图这类)照旧走桥。
         */
        const mirrored = await runMirroredTool(tool, args, toolDef);
        if (mirrored !== undefined) return mirrored;
        if (toolDef.side === 'server') return runServerTool(tool, args, agent);
        const out = await callEditorPage(tool, args, agent, toolDef.timeoutMs || 60000);
        // 没接文档服务时公告板的改动记录由这里记:页面执行器算好这次改了哪几条「剪辑->序列」随回包带回来(A3)
        if (Array.isArray(out?.scopes) && out.scopes.length && !agentBinding) board().noteChange(agent || '', tool, out.scopes);
        if (out.ok) return out.result || out;
        throw new Error(out.error);
      }

      /** side: "server" 的工具(不碰项目、不过浏览器桥) */
      async function runServerTool(tool: string, args: any, agent?: string): Promise<any> {
        // 多 Agent 的五个工具(A3):公告板与拉起子 Agent,在这个进程里答
        if (multiAgent.isTool(tool)) return multiAgent.handle(tool, args, agent || '');

        /*
         * side: "server" 的工具就地执行,不过浏览器桥。
         *
         * 目前只有 wait。它纯粹是「睡一会儿」,没有任何理由绕编辑台走一趟 ——
         * 而且这样一来,即使桥这一刻忙着,轮询之间的等待也不会失败。
         * 上面那道 SKILL 闸门仍然管得着它(用户收回控制权时连等待都不该继续)。
         */
        {
          if (tool === 'wait') {
            // 只认真正的数字:Number(null) 是 0、Number('') 也是 0,靠 isFinite 判会把
            // 「没填」当成「填了 0」再夹到 1 秒 —— 那不是用户的意思,默认该是 3 秒
            const raw = (args as any)?.seconds;
            const secs = typeof raw === 'number' && Number.isFinite(raw)
              ? Math.min(30, Math.max(1, raw))
              : 3;
            await new Promise((r) => setTimeout(r, secs * 1000));
            return { ok: true, waited: secs };
          }
          if (tool === 'report_progress') {
            // 进度报告只做校验和规范化,界面直接读 tool_call 事件里的 input。
            const { validateProgressReport } = await import(new URL('./progress-report.mjs', import.meta.url).href);
            const checked = validateProgressReport(args);
            if (!checked.ok) {
              return { ok: false, error: checked.error };
            }
            return { ok: true, message: '已记录进度报告', report: checked.value };
          }
          return { ok: false, error: `服务端工具 ${tool} 没有实现` };
        }
      }

      /**
       * 经编辑器页面执行一个工具(SSE 发 call,页面 POST /api/mcp/result 回来)。回页面的原始回包
       * { ok, result, error, opIds? };超时回 ok:false。`__page_state`(server/agent/agent-side.mjs 的
       * PAGE_STATE_TOOL)也走这条:向页面要一次只读的页面状态。
       */
      async function callEditorPage(tool: string, args: any, agent: string | undefined, limit: number): Promise<any> {
        if (!editorRes) {
          // 桌面 APP 的会话最常碰到这一条(SKILL 模式默认关着编辑界面;后台运行是计划 A5):说清是什么、该怎么办
          throw new Error(`编辑台没有打开:没有页面连着 /api/mcp/events。${tool} 要在 PromptCut 的编辑界面里执行,请用户打开编辑界面后再试,不要反复重试。`);
        }

        const id = nextCallId++;
        // 大多数工具是即时的,慢活儿都返回 jobId 让调用方轮询,所以 60 秒够用。
        // 例外是 see_frames:它当场起一个 Chrome 渲一帧,冷启动加素材预热可能过分钟。
        // 让工具自己声明上限,而不是把所有工具一起放宽 —— 真卡住的时候还是该早点报错。(limit 由调用方按工具给)
        // 定时器句柄要留着:工具正常返回之后不清掉的话,每一次调用都在事件循环里留一个
        // 最长几十秒的游离定时器。工具调用是高频的,积起来就是白占的内存和唤醒。
        let timer: ReturnType<typeof setTimeout> | undefined;
        const p = new Promise<any>(resolve => {
          pendingCalls.set(id, (result: any) => { clearTimeout(timer); resolve(result); });
          timer = setTimeout(() => {
            if (pendingCalls.has(id)) {
              pendingCalls.delete(id);
              resolve({ ok: false, error: `${tool} 超过 ${Math.round(limit / 1000)} 秒没有返回,已放弃等待。` });
            }
          }, limit);
        });

        editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool, args, agent: agent || undefined })}\n\n`);
        
        // 留在页面的工具写了项目时,页面回包带它这次提交的 opIds(c65-integ2 接线);agent-side 据此推进对话读到的版本
        return await p;
      }

      server.middlewares.use('/api/ai/providers', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const urlStr = req.originalUrl || req.url || '';
          const refresh = /[?&]refresh=1(&|$)/.test(urlStr);
          const runners = await getRunner();
          const list = await runners.listProviders({ refresh });
          
          let stt = { engine: null as string | null, available: false, hint: 'STT removed' };
          sendJson(res, 200, { ok: true, providers: list, stt });
        } catch (e: any) {
          sendJson(res, 503, { ok: false, error: String(e) });
        }
      });

      // Bounded UI polling reads only the non-sensitive ledger, never launches a CLI.
      server.middlewares.use('/api/ai/auth-state', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const { codexAuthState } = await import('./runners/codex-auth-state.mjs');
        sendJson(res, 200, { ok: true, codex: codexAuthState().snapshot() });
      });

      /**
       * 列出某家能用的模型。
       *
       * 两条路:
       *   - `agy`:跑 `agy models`(输出是「名字<TAB>说明」);
       *   - `api`:打 OpenAI 兼容的 `GET {baseUrl}/v1/models`。中转站基本都实现了这个口子,
       *     返回 `{ data: [{ id, object, owned_by }], object: "list" }`。
       *
       * claude / codex 没有对应命令,清单只能在设置里手填 —— 与其编一份可能过期的
       * 硬编码名单,不如老实说这一家读不到。
       */
      server.middlewares.use('/api/ai/models', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider');

        if (provider === 'api') {
          try {
            const { readConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
            const api = (readConfig() as any)?.api || {};
            if (!api.apiKey) return sendJson(res, 400, { ok: false, error: '还没填 API Key,拉不了模型清单' });
            if (!api.baseUrl) return sendJson(res, 400, { ok: false, error: '还没填接口地址(官方源没有统一的清单口子,中转站才有)' });
            const { listApiModels } = await import(new URL('./runners/api-models.mjs', import.meta.url).href);
            const models = await listApiModels(api);
            return sendJson(res, 200, { ok: true, models });
          } catch (e: any) {
            return sendJson(res, 500, { ok: false, error: e.message || String(e) });
          }
        }

        if (provider !== 'agy') {
          return sendJson(res, 400, { ok: false, error: '这一家没有列出模型的命令,请在上面手填' });
        }
        try {
          const { resolveExe } = await getRunner();
          const { cliCommand, cliEnv } = await import(new URL('./runners/cli-runtime.mjs', import.meta.url).href);
          const { execFile } = await import('node:child_process');
          const inv = cliCommand(resolveExe('agy'), ['models']);
          const out = await new Promise<string>((resolve, reject) => {
            execFile(inv.command, inv.args, { env: cliEnv('agy'), timeout: 30000, windowsHide: true },
              (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout || '')));
          });
          // 只收「名字<TAB>说明」那些行,把「Fetching available models...」之类的抬头滤掉
          const models = out.split(/\r?\n/)
            .map((l) => l.split('\t')[0].trim())
            .filter((n) => /^[\w.:-]+$/.test(n));
          sendJson(res, 200, { ok: true, models });
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e.message || String(e) });
        }
      });

      // Keep operations alive across dialog close/reopen and report actual results.
      const setupService = import(new URL('./runners/setup.mjs', import.meta.url).href)
        .then(mod => mod.createSetupService());
      server.httpServer?.once('close', () => { void setupService.then(service => service.dispose()); });
      server.middlewares.use('/api/ai/setup', async (req, res) => {
        if (req.method === 'DELETE') {
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
          req.on('end', async () => {
            if (over) return;
            try { (await setupService).cancel(JSON.parse(body).provider); sendJson(res, 200, { ok: true }); }
            catch (e: any) { sendJson(res, 400, { ok: false, error: e.message }); }
          });
          return;
        }
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        res.setHeader('Cache-Control', 'no-store');
        try { sendJson(res, 200, { ok: true, jobs: (await setupService).list() }); }
        catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });
      for (const kind of ['install', 'login'] as const) {
        server.middlewares.use('/api/ai/' + kind, async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
          req.on('end', async () => {
            if (over) return;
            try {
              const { provider, dryRun, deviceAuth } = JSON.parse(body || '{}');
              if (kind === 'install' && dryRun) {
                const { installPlanFor, manualHintFor } = await import(new URL('./runners/install.mjs', import.meta.url).href);
                const plan = installPlanFor(provider);
                return sendJson(res, plan ? 200 : 400, plan ? { ok: true, ...plan } : { ok: false, hint: manualHintFor(provider) });
              }
              const job = (await setupService).start(provider, kind, { deviceAuth: deviceAuth === true });
              sendJson(res, 200, { ok: true, job });
            } catch (e: any) { sendJson(res, 400, { ok: false, error: e.message }); }
          });
        });
      }

      /**
       * POST /api/ai/diagnostics/save —— 报告太长时存成文件,并打开它所在的文件夹。
       *
       * 为什么不一律走剪贴板:诊断报告带上每一步执行事件之后动辄几百 KB,
       * 粘到聊天框里既贴不动也没人看。超过阈值就落盘,让用户直接把文件发过来。
       *
       * **每次单独建一个带时间戳的文件夹**,里面就这一个 txt。直接打开
       * 「诊断报告」总目录的话,用户会看到一堆历次的文件,还得自己认哪个是刚生成的。
       */
      server.middlewares.use('/api/ai/diagnostics/save', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let tooBig = false;
        // 报告本身就是大块头,这里的上限只用来挡住明显不正常的请求
        req.on('data', (c) => { if (tooBig) return; body += c; tooBig = overLimit(req, res, body.length, 64 * 1024 * 1024, '报告超过 64MB,没有保存'); });
        req.on('end', () => {
          if (tooBig) return;
          try {
            const { text, label } = JSON.parse(body || '{}');
            if (typeof text !== 'string' || !text) return sendJson(res, 400, { ok: false, error: 'text 必填' });
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
            const safeLabel = String(label || '诊断').replace(/[\\/:*?"<>|]/g, '');
            // 和 ai.json 放一处,不往桌面上堆东西;反正马上就用资源管理器打开了
            const root = path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut', '诊断报告');
            const dir = path.join(root, `${safeLabel}-${stamp}`);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${safeLabel}-${stamp}.txt`);
            // 带 BOM:Windows 记事本没有它会把中文按 ANSI 读成乱码
            fs.writeFileSync(file, '﻿' + text, 'utf8');
            revealInFileManager(dir);
            sendJson(res, 200, { ok: true, dir, file });
          } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
        });
      });

      // 排查信息:用户点「诊断」时一次性拿全,复制给我们看。
      // 里面绝不能有明文 Key —— publicConfig() 已经把它换成 { set, last4 }。
      //
      // 机器码同样要脱敏。它不只是个编号,它**就是**分发 API 配置时的加密口令
      // (configShare 拿它当 password),整串写进报告等于把解密口令一起交出去。
      // 只留第一组:够我们认出是哪台机器,不够任何人拿去解密。
      server.middlewares.use('/api/ai/diagnostics', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const [{ publicConfig }, { setupRoot }, { machineCode, redactMachineCode }, env, runners] = await Promise.all([
            import(new URL('./ai-config.mjs', import.meta.url).href),
            import(new URL('./runners/cli-runtime.mjs', import.meta.url).href),
            import(new URL('./runners/machine-id.mjs', import.meta.url).href),
            import(new URL('./harness/env-snapshot.mjs', import.meta.url).href),
            getRunner(),
          ]);
          res.setHeader('Cache-Control', 'no-store');
          /*
           * 驱动探活会给 claude / codex / agy 各起一个子进程(runners/auth.mjs,
           * 单个超时 15 秒)。诊断报告那条路等不起,而且它要的是**这台机器的现状**,
           * 不是「CLI 现在还登着吗」,所以它带 ?refresh=0 走进程内缓存。
           *
           * 还要把它单独 try 起来:原来整个响应是 all-or-nothing 的,探活一抛错就 500,
           * 把 node 和 sessions 一起带走 —— 而那两段恰恰是这个按钮最有价值的产出,
           * 偏偏在机器出问题的时候最容易被连坐。
           */
          const refresh = new URL(req.url || '/', 'http://x').searchParams.get('refresh') !== '0';
          let providers: unknown;
          try {
            /*
             * refresh=0 那条路(诊断快照)再压一道时限。
             *
             * 但**要说清这道时限管不到什么**,别把它当成一张不存在的保票:
             * runners/index.mjs 的 probeVersion 用的是 execFileSync,而三个 provider
             * 都在第一个 await 之前调它 —— 也就是说 listProviders(...) 这个调用本身
             * 就同步阻塞(每个 CLI 上限 15 秒),下面那个 setTimeout 要等它返回之后
             * 才被创建。CLI 真卡住时这道 race 完全不生效,整个 dev server 一起冻住。
             * 真修法是把 probeVersion 改成异步 execFile,那要单独一轮评审。
             *
             * 它管得到的是:探活本身返回慢(而不是卡死)、以及 listProviders 抛错。
             * 这两种下面照常把 node 和 sessions 返回 —— 那两段才是这个按钮最有价值的
             * 产出,不该被 providers 这一格连坐。
             *
             * 缓存也别高估:TTL 只有 5 秒(index.mjs),用户点按钮时基本不命中,
             * 所以 refresh=0 的实际收益是「不强制刷新 probeAuth」,不是「直接走缓存」。
             *
             * refresh=true 那条路(AI 设置里的「诊断」)不压时限:它要的就是真实探活结果。
             */
            providers = refresh
              ? await runners.listProviders({ refresh })
              : await Promise.race([
                  runners.listProviders({ refresh: false }),
                  new Promise((resolve) => setTimeout(() => resolve({ error: '驱动探活超时', 说明: '超过 2.5 秒没回来,这一格先跳过 —— 下面那些机器状态仍然有效' }), 2500)),
                ]);
          }
          catch (e: any) { providers = { error: e?.message || String(e), 说明: '驱动探活失败 —— 下面那些机器状态仍然有效' }; }
          sendJson(res, 200, {
            ok: true,
            generatedAt: new Date().toISOString(),
            app: {
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              cliHome: setupRoot(),
              configPath: process.env.PROMPTCUT_AI_CONFIG || '(默认 %LOCALAPPDATA%\\promptcut\\ai.json)',
            },
            machineCode: redactMachineCode(machineCode()),
            machineCodeNote: '只保留首组:机器码同时是配置分发的解密口令,整串不外发',
            // 本地服务这个进程的现状:跑了多久、内存还剩多少、是打包版还是源码跑的。
            // 「重启一下就好了」这类问题,不看这些就只能靠猜。
            node: env.nodeStatus(),
            /*
             * 后端的会话文件柜。界面上的对话是按项目走的,而**服务端接哪段历史**取决于
             * localStorage 里那把会话 id;两者脱节时界面上完全看不出来(见 81f255b)。
             * 报「有几段、各几条、多新」,是这类看不见的串台唯一的物证。不含对话内容。
             */
            sessions: env.inspectSessionStore(),
            providers,
            providersRefreshed: refresh,
            config: publicConfig(),
          });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      /*
       * 本机识别码:分发 API 配置时当加密口令用。只给摘要后的码,原始指纹不出服务端。
       *
       * 这里**故意返回完整码**,不像 /api/ai/diagnostics 那样截断 —— 用户就是要把这一整串
       * 发给帮他加密配置的人,截了这个功能就没了。它的保护来自 vite-plugin-api-guard 那道
       * 同源卡口:本机上别的网页(它们都是跨源)打不进这个接口。
       */
      server.middlewares.use('/api/ai/machine-code', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const { machineCode } = await import(new URL('./runners/machine-id.mjs', import.meta.url).href);
          res.setHeader('Cache-Control', 'no-store');
          sendJson(res, 200, { ok: true, code: machineCode() });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      server.middlewares.use('/api/ai/config', async (req, res) => {
        try {
          const { publicConfig, writeConfig, clearKey } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          // POST /api/ai/config/clear-key {kind}:删掉那一路的密钥文件(设置窗口里的「清理密钥」)
          if ((req.url || '').split('?')[0] === '/clear-key') {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
            let body = '';
            let over = false;
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
            req.on('end', () => {
              if (over) return;
              try {
                const { kind } = JSON.parse(body || '{}');
                clearKey(kind);
                sendJson(res, 200, { ok: true, config: publicConfig() });
              } catch (e: any) {
                sendJson(res, 400, { ok: false, error: e.message });
              }
            });
            return;
          }
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, config: publicConfig() });
          } else if (req.method === 'POST') {
            let body = '';
            let over = false;
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 200_000, '请求体超过 200KB'); });
            req.on('end', () => {
              if (over) return;
              try {
                const partial = JSON.parse(body);
                writeConfig(partial);
                sendJson(res, 200, { ok: true, config: publicConfig() });
              } catch (e: any) {
                sendJson(res, 400, { ok: false, error: e.message });
              }
            });
          } else {
            sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          }
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/agy-permissions', async (req, res) => {
        try {
          const { status, grant } = await import(new URL('./agy-permissions.mjs', import.meta.url).href);
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, ...status() });
          } else if (req.method === 'POST') {
            return sendJson(res, 200, { ok: true, ...grant() });
          } else {
            sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          }
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/chat', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let over = false;
        // 32MB:附件带的是地址和文本(ChatAttachment 没有内联二进制),整段字幕、整篇文档都够;
        // 再大就不是正常输入了,而是有人在往这条路上灌东西。
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, '请求体超过 32MB'); });
        req.on('end', async () => {
          if (over) return;
          let hasDone = false;
          // 公告板上这一轮开始了(A3):无论怎么结束都要记一次结束,否则这个对话一直算「忙」
          let runBegun = false;
          let runAgentId = '';
          try {
            const runners = await getRunner();
            const data = JSON.parse(body);
            const { provider, prompt, sessionId, model, effort, fast, attachments, script, schemaCompat, deepAuto } = data;
            if (provider === 'codex') {
              const { codexAuthState, authFailureEvent } = await import('./runners/codex-auth-state.mjs');
              const auth = codexAuthState().snapshot();
              if (auth.state !== 'normal') {
                // Before quota probes or task registration: no CLI executes known-invalid credentials.
                const event = auth.state === 'invalid' ? authFailureEvent(auth.reason) : {
                  type: 'error', message: 'Codex 登录状态待确认，请重新登录。', retryable: false,
                  authProvider: 'codex', authReason: 'state_unknown', authGeneration: auth.revision,
                };
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                res.end(`data: ${JSON.stringify(event)}\n\n`);
                return;
              }
            }
            // 多 Agent 分页:这一页的对话 ID。只认会话 id 的字符集,别的一律当没带
            const agentId: string = typeof data.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : '';
            runAgentId = agentId;

            let systemPrompt = '';
            try {
              systemPrompt = fs.readFileSync(new URL('./ai-system-prompt.md', import.meta.url), 'utf-8');
            } catch {
              systemPrompt = 'System prompt missing.';
            }

            // 剧本每一轮都拼进系统提示词,而不是只在第一条用户消息里说一次:
            // 多轮执行最容易顺着中间结果越走越偏,摆在系统提示里才拉得住。
            if (typeof script === 'string' && script.trim()) {
              systemPrompt += `\n\n## 本片剧本(用户写的,每一步都要照它来)\n\n${script.trim()}\n\n` +
                '这是这条片子的主线。做任何编排、配字幕、配动效的决定时都要对照它;' +
                '和它冲突的做法不要做,拿不准就按剧本写的来。剧本没写到的细节可以自己判断。';
            }

            let finalPrompt = prompt;
            // 素材库那几条单列:给 mediaId 和卡片能直接用的 cardUrl,**不给磁盘路径** ——
            // 以前每轮都把每个素材的磁盘路径塞进来,模型没有能读它的工具,却一再被引着去读(见 src/ai/mediaRef.ts)
            const library = (attachments || []).filter((a: any) => a.library);
            const userFiles = (attachments || []).filter((a: any) => !a.library);
            if (library.length > 0) {
              const kindName: Record<string, string> = { video: '视频', image: '图片', audio: '音频' };
              finalPrompt += '\n\n素材库(已导入,工具里用 mediaId;卡片参数里引用填 cardUrl):\n' + library.map((a: any) => {
                let line = `- [${kindName[a.kind] || a.kind}] ${a.name} · mediaId ${a.id} · cardUrl ${a.url}`;
                if (a.durationSec && a.kind !== 'image') line += ` · 时长 ${a.durationSec} 秒`;
                return line;
              }).join('\n');
            }
            // 附件也**不给磁盘路径**(和上面素材库那几条同一个理由):Agent 经接口读写字节,不读任何存储目录
            // (docs/semantics/product/agent.md「素材与产物」),磁盘路径它读不了,只会被引着去读。
            // 要剪辑、转写、配动效,先用 import_media 把「站内地址」装进素材库(import_media 的工具说明写着这条路)。
            if (userFiles.length > 0) {
              finalPrompt += '\n\n附件(在对话的工作目录里,不在素材库;要剪辑、转写或配动效,先用 import_media 传它的站内地址装进素材库):\n' + userFiles.map((a: any) => {
                let line = `- [${a.kind === 'video' ? '视频' : a.kind}] ${a.name} · 站内地址 ${a.url}`;
                if (a.durationSec) line += ` · 时长 ${a.durationSec} 秒`;
                if (a.text) line += `\n\`\`\`\n${a.text}\n\`\`\``;
                return line;
              }).join('\n');
            }

            /*
             * 登记这个对话(server/agent/agent-sessions.mjs):类型、厂商、角色、创造力等级的覆盖值。
             * creativity 是这个页签单独设的等级,null / 不带 = 跟项目;projectCreativity 是页面这一刻的项目默认,
             * 服务端读不到项目时才用。每条消息都登记:用户可能在两条消息之间换了驱动或等级。
             */
            if (typeof data.projectCreativity === 'string') projectCreativityHint = normalizeCreativity(data.projectCreativity);
            agentSessions.register(agentId, {
              type: provider === 'api' ? 'api' : 'cli',
              vendor: provider === 'api' ? String((await import(new URL('./ai-config.mjs', import.meta.url).href)).publicConfig()?.api?.vendor || 'api') : String(provider || ''),
              role: 'main',
              creativity: normalizeCreativity(data.creativity),
            });
            const { level: convCreativity, source: convCreativitySource } = agentSessions.creativityOf(agentId, currentProjectCreativity());

            /*
             * 多 Agent(A3):
             *   - spawn_agent 拉起的子 Agent:每一轮系统提示词都拼上它的角色提示词(多轮跑下来最容易忘了自己是谁);
             *   - 别的 Agent 的动态(改了什么范围、信箱里到顶没自动投递的消息)拼在这一轮提示词前面,只进模型;
             *   - hops:这条是第几层自动投递(页面投递别的 Agent 的消息时带上),公告板据此给连锁封顶。
             */
            const sess = agentSessions.get(agentId);
            if (agentId && sess.parent && sess.role) {
              const role = loadRole(sess.role);
              if (role) {
                systemPrompt += `\n\n## 你的角色:${role.name}\n\n你是 Agent ${sess.parent} 用 spawn_agent 拉起的子 Agent,对话 ID ${agentId}。` +
                  '只做它交给你的那部分;开工先 declare_scope,做完用 report_progress 交代,再用 send_message 把结果告诉拉起你的 Agent。' +
                  `你不能再拉起别的 Agent。\n\n${role.prompt}`;
              }
            }
            const agentNotes = agentId ? board().consumeNotes(agentId) : '';
            if (agentNotes) finalPrompt = `${agentNotes}\n\n${finalPrompt}`;
            const runHops = Number.isSafeInteger(data.hops) && data.hops > 0 ? data.hops : 0;

            const editorPort = (server.httpServer?.address() as any)?.port || 5195;
            const editorState = editorRes ? "编辑台已连接" : "未连接";
            finalPrompt += `\n\n当前端口 ${editorPort};${editorState}` + (agentId ? `;你的 Agent 对话 ID:${agentId}` : '') +
              `;创造力等级「${CREATIVITY_LABEL[convCreativity as keyof typeof CREATIVITY_LABEL]}」(${convCreativitySource}):` +
              `${CREATIVITY_HINT[convCreativity as keyof typeof CREATIVITY_HINT]}。越级的工具调用会被拒绝,被拒就停下告诉用户,不要绕`;

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            res.flushHeaders();

            const keepAlive = setInterval(() => {
              res.write(': ping\n\n');
            }, 15000);

            const mcp = {
              serverName: "promptcut",
              command: process.execPath,
              args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))],
              // PROMPTCUT_CALLER=cli:这份 MCP 是 AI 栏起的,不是桌面 APP 的会话(mcp-server.mjs 据此不报桌面身份)
              env: { PROMPTCUT_CALLER: 'cli', PROMPTCUT_PORT: String(editorPort), ...(agentId ? { PROMPTCUT_AGENT: agentId } : {}) }
            };

            const cwd = path.join(server.config.root, 'exports', 'ai-workspace');
            fs.mkdirSync(cwd, { recursive: true });

            const runId = Math.random().toString(36).substring(2, 9);
            res.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);

            const { publicConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
            const cfg = publicConfig();

            // 额度熔断:先看这一路的用量,超线就不起 CLI 了,直接把原因告诉用户
            const { guard: quotaGuard, mod: quotaMod } = await getQuotaGuard();
            try {
              // 把模型一起递进去:claude 的 /usage 里「本周(Fable)」那种窗口是模型专属的,
              // 不跑那个模型就不该拿它来拦(见 quota.mjs 的 decidingWindows)
              await quotaGuard.gate(provider, cfg.quota, model);
            } catch (e: any) {
              if (e instanceof quotaMod.QuotaExceededError) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: e.message, quota: e.quota })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                clearInterval(keepAlive);
                res.end();
                return;
              }
              throw e;
            }
            let replyBytes = 0;
            /*
             * D2:文字回复整条完成时推一条事件(绑了项目副本时)。回复在工具调用之间成段,
             * 遇到下一次工具调用或这一轮结束就把攒着的那一段发出去。
             */
            let pendingText = '';
            const flushText = () => {
              const b = agentBinding;
              if (b && pendingText.trim()) b.side.executor.text(agentId, pendingText);
              pendingText = '';
            };

            if (agentId) { board().beginRun(agentId, runHops); runBegun = true; }
            const run = runners.startRun({
              provider,
              prompt: finalPrompt,
              systemPrompt,
              sessionId,
              cwd,
              model,
              /*
               * 深度自主:轮次上限换成设置里的「自主轮次」(ai.json 的 deepAutoRounds,
               * 默认 300,填 0 就是不限),而且不再给模型任何关于轮次的话。
               *
               * 轮数从**服务端配置**取,不听请求体里的数 —— 前端只发一个「开没开」的布尔。
               * 上限是道安全阀,不该由一个请求字段随手顶开。
               */
              maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
              deepAuto: !!deepAuto,
              // 推理强度和加速档:哪家支持哪些由各自的 runner 翻译成标志,
              // 不支持的直接忽略(前端也已经把对应控件灰掉了)
              effort,
              fast,
              /*
               * 深度自主:轮次上限换成设置里的「自主轮次」(ai.json 的 deepAutoRounds,
               * 默认 300,填 0 就是不限),而且不再给模型任何关于轮次的话。
               *
               * 轮数从**服务端配置**取,不听请求体里的数 —— 前端只发一个「开没开」的布尔。
               * 上限是道安全阀,不该由一个请求字段随手顶开。
               */
              maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
              deepAuto: !!deepAuto,
              // 参数兼容模式(工具 schema 按 Gemini 子集清洗):'auto' / 'on' / 'off',API 直连的 runner 才用
              schemaCompat,
              // 审查环路单独开关(只有 API 直连用);不传就跟着深度自主走,见 runners/api.mjs
              reviewLoop: typeof data.reviewLoop === 'boolean' ? data.reviewLoop : undefined,
              // 审查环路走 CLI 时,按回合给工具上只读锁(见 callToolInternal)。null = 解锁
              setToolAccess: (list: string[] | null) => { loopToolLock = list ? new Set(list) : null; },
              toolProtocol: cfg.toolProtocol,
              mcp,
              // codex、agy 在输出流里报到工具调用,/api/mcp/call 按线索认领同一个 callId(见上面 callPairing)
              callPairing,
              // meta.callId:API 直连那条路的 tool_use id(server/harness/tools/index.mjs 传进来),事件带上它,AI 栏按它对上
              callTool: async (name: string, args: any, meta?: { callId?: string }) => await callToolInternal(name, args, agentId || undefined, typeof meta?.callId === 'string' ? meta.callId : undefined),
              onEvent: (ev: any) => {
                if (ev.type === 'done' || ev.type === 'error') hasDone = true;
                if (ev.type === 'text' && typeof ev.delta === 'string') pendingText += ev.delta;
                if (ev.type === 'tool_call' || ev.type === 'done' || ev.type === 'error') flushText();
                if (ev.type === 'text' && typeof ev.delta === 'string') replyBytes += Buffer.byteLength(ev.delta, 'utf8');
                // The chat never reads a tool result's full output (get_project is the whole
                // project); sending it made the editor parse and trace megabytes per result.
                // Server-side consumers of onEvent still receive it unchanged.
                const outbound = ev.type === 'tool_result' && ev.output !== undefined ? { ...ev, output: undefined, outputOmitted: true } : ev;
                res.write(`data: ${JSON.stringify(outbound)}\n\n`);
              }
            });

            const runState = {
              abort: run.abort, finished: false, provider,
              // 后台重查发现超线时,把原因写给正在看这条对话的人,再掐进程
              fail: (message: string) => { try { res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`); } catch {} },
            };
            activeRuns.set(runId, runState);

            res.on('close', () => {
              if (!runState.finished) run.abort();
              activeRuns.delete(runId);
              clearInterval(keepAlive);
            });

            try {
              await run.done;
            } catch (e: any) {
              if (!res.headersSent) throw e;
              res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
            }
            
            runState.finished = true;
            activeRuns.delete(runId);
            clearInterval(keepAlive);
            flushText();
            // 记账:这一轮新增的上下文 = 发出去的提示词 + 收回来的回复。到线就后台重查,超线掐同一路的其他对话
            const noted = quotaGuard.note(provider, Buffer.byteLength(finalPrompt, 'utf8') + replyBytes, cfg.quota, model);
            if (noted) noted.then((v: any) => { if (v?.blocked) failProviderRuns(provider, v.message); }).catch(() => {});
            if (!hasDone) {
               res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            }
            res.end();
            
          } catch (e: any) {
            if (!res.headersSent) {
              sendJson(res, 503, { ok: false, error: String(e) });
            } else {
              res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
              res.end();
            }
          } finally {
            if (runBegun) board().endRun(runAgentId);
          }
        });
      });

      // 额度:给设置窗口显示用。refresh=1 强制重查(Claude 那条要跑一次 claude -p,十来秒)
      server.middlewares.use('/api/ai/quota', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const provider = url.searchParams.get('provider') || '';
          const { guard, mod } = await getQuotaGuard();
          if (!mod.QUOTA_PROVIDERS.includes(provider)) return sendJson(res, 400, { ok: false, error: '只有 claude / codex 有额度窗口' });
          const { publicConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          const cfg = mod.normalizeQuotaConfig(publicConfig().quota);
          const quota = await guard.get(provider, { refresh: url.searchParams.get('refresh') === '1' });
          // 面板问的时候也要带上模型,不然显示的「已熔断」和真正发起对话时的判定对不上
          const verdict = guard.verdict(provider, cfg, url.searchParams.get('model') || '');
          sendJson(res, 200, { ok: true, quota, config: cfg, blocked: !!verdict.blocked, message: verdict.message ?? null, bytesSince: guard.bytesSince(provider) });
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/abort', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let over = false;
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
        req.on('end', () => {
          if (over) return;
          try {
            const { runId } = JSON.parse(body);
            const runState = activeRuns.get(runId);
            if (runState && !runState.finished) {
              runState.abort();
              runState.finished = true;
              activeRuns.delete(runId);
            }
            sendJson(res, 200, { ok: true });
          } catch(e: any) {
            sendJson(res, 400, { ok: false, error: String(e) });
          }
        });
      });

      server.middlewares.use('/api/mcp/events', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });

        // 这个位置只有一个(editorRes),后连的把前一个挤掉:用户刷新页面就靠它重新接管
        if (editorRes) {
          editorRes.write(`data: ${JSON.stringify({ type: "replaced" })}\n\n`);
          editorRes.end();
        }

        editorRes = res;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.flushHeaders();
        
        const port = (server.httpServer?.address() as any)?.port || 5195;
        res.write(`data: ${JSON.stringify({ type: 'hello', port })}\n\n`);
        // 公告板的现状(页签上的范围名、未读)先推一份(A3);桌面 APP 会话的分组也推一份(A4)
        pushBoard();
        pushDesktop();

        req.on('close', () => {
          if (editorRes === res) editorRes = null;
        });
      });

      server.middlewares.use('/api/mcp/result', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let over = false;
        // 工具结果从页面回来,里面可能整段是画面或大段文本,给得宽一点;宽也是有上限的。
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, '工具结果超过 64MB'); });
        req.on('end', () => {
          if (over) return;
          try {
            const data = JSON.parse(body);
            const cb = pendingCalls.get(data.id);
            if (cb) {
              cb(data);
              pendingCalls.delete(data.id);
            }
            sendJson(res, 200, { ok: true });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: String(e) });
          }
        });
      });

      server.middlewares.use('/api/mcp/call', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let over = false;
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, '请求体超过 32MB'); });
        req.on('end', async () => {
          if (over) return;
          try {
            const { tool, args, agent, callId, pair, caller } = JSON.parse(body);
            // callId:Claude Code 经 MCP 的 _meta["claudecode/toolUseId"] 带来(server/mcp-server.mjs 转过来),事件带上它
            let call: string | undefined = typeof callId === 'string' && callId.length <= 128 ? callId : undefined;
            /*
             * codex、agy 不带 callId,只带配对线索 pair: { scope, hint? }(mcp-server.mjs 的 pairingOf)。
             * 只有绑了项目副本时事件才发出去,callId 才有用;没绑就不去等配对。配不上就不带,和以前一样。
             */
            if (!call && agentBinding && pair && typeof pair.scope === 'string' && pair.scope.length <= 160) {
              call = await callPairing.claim(pair.scope, tool, args ?? {}, typeof pair.hint === 'string' && pair.hint.length <= 128 ? pair.hint : undefined);
            }
            /*
             * 桌面 APP 的会话(A4):mcp-server.mjs 报来 caller { type: 'desktop', key, vendor, label, client }。
             * 每次调用登记一次(类型 desktop、跟项目的创造力等级),用它的 key 当对话 ID —— 写入身份(文档服务按对话开连接)、
             * 公告板、「用户正在编辑」与覆盖提示都按它区分,和 AI 栏的 Agent 走同一条路。AI 栏的调用带 agent,不带 caller。
             */
            const desk = desktopCallerOf(caller);
            const agentKey = desk ? desk.key : (typeof agent === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(agent) ? agent : undefined);
            if (desk) agentSessions.register(desk.key, { type: 'desktop', vendor: desk.vendor, label: desk.label, client: desk.client, role: null });
            const handle = desk ? desktopActivity.begin(desk.key, desk, String(tool), args) : null;
            let result: any;
            try {
              result = await callToolInternal(tool, args, agentKey, call);
            } catch (e) {
              if (handle) desktopActivity.end(handle, null, e);
              throw e;
            }
            if (handle) {
              desktopActivity.end(handle, result, null);
              requestSkillPreview(String(tool), args, result);
            }
            sendJson(res, 200, { ok: true, result });
          } catch (e: any) {
            if (e.code === 'UNKNOWN_TOOL') {
              sendJson(res, 404, { ok: false, error: e.message });
            } else {
              sendJson(res, 200, { ok: false, error: e.message });
            }
          }
        });
      });

      /*
       * C6.5 Agent 服务端的项目副本(见上面 bindAgent)。页面(c65-editor)接上文档服务后:
       *   POST /api/agent/bind   { projectId, mode?: "local" | "lan-host" | "ticket", url? } → { ok, projectId, mode, url }
       *   POST /api/agent/unbind {} → { ok }(换项目、断开文档服务时)
       *   POST /api/agent/ticket { reqId, ticket? , error? } → 交回 SSE 里 { type: "agent.ticket" } 要的连接票据
       *   GET  /api/agent/status → 绑没绑、各对话读到的版本、副本版本(诊断)
       */
      const readJsonBody = (req: any, res: ServerResponse, max: number, onBody: (data: any) => void) => {
        let body = '';
        let over = false;
        req.on('data', (c: Buffer) => { if (over) return; body += c; over = overLimit(req, res, body.length, max, `请求体超过 ${max} 字节`); });
        req.on('end', () => {
          if (over) return;
          let data: any;
          try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }); }
          onBody(data);
        });
      };
      server.middlewares.use('/api/agent/bind', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        readJsonBody(req, res, 8192, async (data) => {
          try {
            const b = await bindAgent(data);
            sendJson(res, 200, { ok: true, projectId: b.projectId, mode: b.mode, url: b.url });
          } catch (e: any) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
        });
      });
      server.middlewares.use('/api/agent/unbind', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        readJsonBody(req, res, 8192, () => { unbindAgent('page'); sendJson(res, 200, { ok: true }); });
      });
      server.middlewares.use('/api/agent/ticket', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        readJsonBody(req, res, 8192, (data) => {
          const w = typeof data?.reqId === 'string' ? ticketWaiters.get(data.reqId) : undefined;
          if (!w) return sendJson(res, 404, { ok: false, error: '没有在等这张票据' });
          ticketWaiters.delete(data.reqId);
          clearTimeout(w.timer);
          if (typeof data.ticket === 'string' && data.ticket.length > 0 && data.ticket.length <= 2048) w.resolve(data.ticket);
          else w.reject(new Error(typeof data.error === 'string' ? `页面没签出票据:${data.error}` : '页面交回的票据不合法'));
          sendJson(res, 200, { ok: true });
        });
      });
      /*
       * 「用户正在编辑」(A2):
       *   POST /api/agent/editing { session, entities: [{ clipId, kind: "drag" | "text" | "recent", remainingMs? }] } → { ok, count }
       *     编辑页(src/editor/userEditing.ts)推的整份状态,变了就推(节流)、非空时心跳续期;
       *   GET  /api/agent/editing → { ok, entities }(诊断、探针)
       */
      server.middlewares.use('/api/agent/editing', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, entities: userEditingBoard.current() });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET / POST only' });
        readJsonBody(req, res, 64 * 1024, (data) => {
          try {
            const count = userEditingBoard.report(data?.session, data?.entities);
            sendJson(res, 200, { ok: true, count });
          } catch (e: any) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
        });
      });
      /*
       * 多 Agent(A3):
       *   POST /api/agent/tabs    { tabs: [{ conversationId, title, busy }] } → { ok }   页面的页签(整份),公告板的名单与并发名额用
       *   POST /api/agent/inbox   { conversationId, onlyAuto? } → { ok, messages }       页面空闲时取走投给这一页的消息,作为一条用户消息发出
       *   POST /api/agent/spawned { reqId, ok, error? } → { ok }                         页面开好(或开不出)spawn_agent 要的页签
       *   GET  /api/agent/board → { ok, agents, list }                                   诊断、探针
       */
      server.middlewares.use('/api/agent/tabs', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        readJsonBody(req, res, 64 * 1024, (data) => {
          lastTabs = Array.isArray(data?.tabs) ? data.tabs.slice(0, 64) : [];
          board().setTabs(lastTabs);
          sendJson(res, 200, { ok: true });
        });
      });
      server.middlewares.use('/api/agent/inbox', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        readJsonBody(req, res, 8192, (data) => {
          const key = typeof data?.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : null;
          if (!key) return sendJson(res, 400, { ok: false, error: 'conversationId 不合法' });
          const b = board();
          b.markSeen(key);
          sendJson(res, 200, { ok: true, messages: b.takeInbox(key, data?.onlyAuto !== false) });
        });
      });
      server.middlewares.use('/api/agent/spawned', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        readJsonBody(req, res, 8192, (data) => {
          const w = typeof data?.reqId === 'string' ? spawnWaiters.get(data.reqId) : undefined;
          if (!w) return sendJson(res, 404, { ok: false, error: '没有在等这个页签' });
          spawnWaiters.delete(data.reqId);
          clearTimeout(w.timer);
          if (data.ok === true) w.resolve();
          else w.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 300) : '页面没开出页签'));
          sendJson(res, 200, { ok: true });
        });
      });
      server.middlewares.use('/api/agent/board', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        res.setHeader('Cache-Control', 'no-store');
        const b = board();
        sendJson(res, 200, { ok: true, project: currentProjectKey(), agents: b.snapshot(), list: b.listRaw(''), sessions: agentSessions.list(), changes: b._changes().slice(-50) });
      });
      /*
       * 桌面 APP 会话的分组(A4):GET /api/agent/desktop → { ok, sessions }(页面刚连上时取一次,之后收 SSE 的 agent.desktop;
       * 探针也读它)。每个会话:id、厂商、正在进行的操作、最近的调用、交上来的进度报告,以及登记表里的类型与生效的创造力等级。
       */
      server.middlewares.use('/api/agent/desktop', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        res.setHeader('Cache-Control', 'no-store');
        const level = currentProjectCreativity();
        const sessions = desktopActivity.snapshot().map((s: any) => {
          const c = agentSessions.creativityOf(s.id, level);
          return { ...s, type: c.entry.type, creativity: c.level };
        });
        sendJson(res, 200, { ok: true, sessions });
      });
      server.middlewares.use('/api/agent/status', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        res.setHeader('Cache-Control', 'no-store');
        const b = agentBinding;
        sendJson(res, 200, b ? { ok: true, bound: true, mode: b.mode, url: b.url, ...b.side.describe(), presence: presenceBridge?.describe() ?? null, editing: userEditingBoard.describe() } : { ok: true, bound: false });
      });

      server.middlewares.use('/api/mcp/status', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const port = (server.httpServer?.address() as any)?.port || 5195;
        let activeRunCount = 0;
        for (const st of activeRuns.values()) if (!st.finished) activeRunCount++;
        sendJson(res, 200, {
          editorConnected: !!editorRes,
          pending: pendingCalls.size,
          /*
           * 还有几轮对话正在跑。装补丁的脚本(desktop/scripts/apply-patch.ps1)靠它决定
           * 要不要拦一下 —— 补丁会把整个 runtime/app 覆盖掉,而覆盖发生在一个正在服务
           * 页面的 dev server 脚下时,agent 那边**不会崩,只会哑**:Node 里的循环照跑、
           * 对模型的请求照发,但页面发出的每一个 HTTP 请求(工具结果回传、看画面、读卡源码)
           * 全部挂住,直到服务重新起来。表现就是一连串莫名其妙的工具超时,查不到原因。
           */
          activeRuns: activeRunCount,
          port
        });
      });
    }
  };
}
