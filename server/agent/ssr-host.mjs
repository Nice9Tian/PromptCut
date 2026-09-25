/**
 * 在 Agent 服务端(编辑器 vite 进程)里载入页面那一套工具实现(C6.5 设计稿第 5 节:「用 vite 的 ssrLoadModule
 * 载入 src/mcp/handlers/* 和 store」)。
 *
 * `load(id)` 是 `server.ssrLoadModule`(测试里是自己起的 vite 服务器的同名方法)。每次执行工具前都调一遍:
 * 模块没被改过时 vite 直接回缓存;src 下的文件改了(含新建的定制卡),vite 把它和引用它的模块作废,下次载入即是新代码。
 *
 * 服务端的 store 是这个进程里的一份单例:执行器(`agent-exec.mjs`)在串行锁里先把项目副本放进去,跑完再取出来算差异。
 * 页面独有的状态(播放头、选区、面板)在这份 store 里只是缺省值,不代表页面;读它们的工具留在页面执行。
 */

/** 注册表要先于工具实现就位:卡片、部件都靠 import 时的副作用登记 */
const REGISTRIES = ['/src/cards/index.ts', '/src/parts/index.ts'];

/**
 * @param {(id: string) => Promise<any>} load
 * @param {{ apiBase?: string }} [options] 工具实现里打编辑器接口用的地址(`src/mcp/apiUrl.ts`)
 */
export async function loadSsrHost(load, { apiBase } = {}) {
  for (const id of REGISTRIES) await load(id);
  const [core, api, routes, diff, common, apiUrl] = await Promise.all([
    load('/src/store/core.ts'),
    load('/src/mcp/api.ts'),
    load('/src/mcp/routes.mjs'),
    load('/src/kernel/diffProject.ts'),
    load('/src/mcp/common.ts'),
    load('/src/mcp/apiUrl.ts'),
  ]);
  if (apiBase) apiUrl.setApiBase(apiBase);
  const editorApi = api.editorApi;
  const routeTable = routes.TOOL_ROUTES;
  return {
    /** 把项目放进服务端 store(不进撤销栈、不经同步挂钩) */
    setProject(project) {
      core.set({ project });
    },
    getProject() {
      return core.getState().project;
    },
    /** 路由表里的工具 → EditorApi 方法;不在表里回 undefined */
    routeOf(tool) {
      return Object.hasOwn(routeTable, tool) ? routeTable[tool] : undefined;
    },
    async callRoute(tool, args) {
      const route = routeTable[tool];
      const fn = editorApi[route.method];
      if (typeof fn !== 'function') throw new Error(`服务端没有 ${tool} 的实现(${route.method})`);
      return route.passArgs ? fn(args) : fn();
    },
    diffProject: diff.diffProject,
    frameLayoutOf: common.frameLayoutOf,
    stageSize: common.stageSize,
  };
}
