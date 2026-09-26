/**
 * Agent 服务端的一整套(C6.5 设计稿 `docs/plan/c65-design.md` 第 5、7 节):到文档服务的连接与项目副本
 * (`doc-link.mjs`)、工具执行器(`agent-exec.mjs`),加上**按工具的 `side` 分派**。
 *
 * 编辑器 vite 进程(`vite-plugin-ai.ts` 的 `/api/agent/bind`)与测试都从这里组装,分派规则只有一份:
 *   - `side: "agent"`:在项目副本上执行(写入以这个 Agent 对话的身份、带期望版本提交);执行器回 `undefined`
 *     的(素材镜头拼图)交给页面;
 *   - `side: "page"`:经页面执行(`callPage`,生产上是 SSE 页面通道);页面回包带它这次提交的 `opIds` 时,
 *     记进执行器,免得 Agent 紧接着的写入被自己让页面做的改动挡住;
 *   - `side: "server"`:交给 `callServer`(`wait`、`report_progress`,不碰项目)。
 * 每个工具调用(不论哪一侧)前后各发一条事件(D2),带模型那一侧的 `callId`(有的话)。
 *
 * 页面状态(c65-integ2 裁定):既读页面状态又写项目的工具(`agent-exec.mjs` 的 `PAGE_STATE_TOOLS`)
 * 在服务端执行,只把所需的页面状态经 `callPage(PAGE_STATE_TOOL, { tool, args, keys })` 向页面要一次(只读)。
 */
import { createAgentLink } from './doc-link.mjs';
import { createAgentExecutor } from './agent-exec.mjs';

/** 向页面要只读页面状态用的内部工具名(不在工具表里,Agent 看不到;页面 `src/ai/mcpExecutor.ts` 认它) */
export const PAGE_STATE_TOOL = '__page_state';

/**
 * @param {object} o
 * @param {string} o.projectId
 * @param {string | ((conversation: number) => string)} o.url 文档服务地址
 * @param {(conversation: number) => Promise<string[]> | string[]} o.protocolsFor
 * @param {() => Promise<object>} o.loadHost `ssr-host.mjs` 的 `loadSsrHost` 绑好 `load` 的版本
 * @param {Array<{ name: string, side?: string }>} o.tools 工具表(`mcp-tools.mjs` 的 `tools`)
 * @param {(tool: string, args: object, ctx: { agent: string }) => Promise<{ result?: any, opIds?: string[] } | any>} o.callPage
 *   经页面执行一个工具。回 `{ result, opIds }`(`pageResult: 'wrapped'`)或直接回结果(缺省);失败就抛
 * @param {(tool: string, args: object) => Promise<any>} [o.callServer]
 * @param {'wrapped' | 'plain'} [o.pageResult]
 */
export function createAgentSide({
  projectId,
  url,
  protocolsFor,
  WebSocketImpl,
  loadHost,
  tools,
  callPage,
  callServer = async (tool) => ({ ok: false, error: `服务端工具 ${tool} 没有实现` }),
  pageResult = 'plain',
  prerenderPost = null,
  playhead = () => 0,
  toolGroups = {},
  log = () => {},
  linkOptions = {},
  execLimits = {},
} = {}) {
  if (!Array.isArray(tools)) throw new TypeError('createAgentSide: 要 tools(工具表)');
  if (typeof callPage !== 'function') throw new TypeError('createAgentSide: 要 callPage');
  const byName = new Map(tools.map((t) => [t.name, t]));
  const link = createAgentLink({ url, projectId, protocolsFor, log, ...(WebSocketImpl ? { WebSocketImpl } : {}), ...linkOptions });

  /** 经页面执行,统一成 { result, opIds } */
  async function viaPage(tool, args, agent) {
    const out = await callPage(tool, args, { agent });
    if (pageResult === 'wrapped') return { result: out?.result, opIds: Array.isArray(out?.opIds) ? out.opIds : [] };
    return { result: out, opIds: [] };
  }

  const executor = createAgentExecutor({
    link,
    loadHost,
    prerenderPost,
    playhead,
    toolGroups,
    log,
    limits: execLimits,
    // 只读的页面状态:经同一条页面通道要一次
    pageState: async (tool, args, keys) => {
      const { result } = await viaPage(PAGE_STATE_TOOL, { tool, args, keys: [...keys] }, '');
      return result && typeof result === 'object' ? result : null;
    },
  });

  async function dispatch(tool, args, agent, toolDef, ctx) {
    if (toolDef.side === 'agent') {
      const done = await executor.execute(tool, args, agent, toolDef, ctx);
      if (done !== undefined) return done;
    } else if (toolDef.side === 'server') {
      return callServer(tool, args);
    }
    const { result, opIds } = await viaPage(tool, args, agent);
    const own = opIds.filter((x) => typeof x === 'string');
    if (own.length) await executor.notePageWrites(agent, own).catch(() => {});
    return result;
  }

  return {
    link,
    executor,
    projectId,

    /**
     * 执行一个工具(带事件)。`agent` 是 Agent 对话 id(字符串,没有就 ''),`callId` 是模型那一侧的这次调用 id。
     * 未知工具抛 `code: 'UNKNOWN_TOOL'`。
     */
    async callTool(tool, args = {}, { agent = '', callId } = {}) {
      const toolDef = byName.get(tool);
      if (!toolDef) throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'UNKNOWN_TOOL' });
      const key = typeof agent === 'string' ? agent : '';
      return executor.track(tool, args, key, (ctx) => dispatch(tool, args, key, toolDef, ctx), { callId });
    },

    /** 某个对话 id 在本进程里的对话号(写入身份里的 `conversation`) */
    conversationNumber(agent = '') {
      return executor.conversationOf(typeof agent === 'string' ? agent : '').n;
    },

    describe() {
      return executor.describe();
    },

    close() {
      link.close();
    },
  };
}
