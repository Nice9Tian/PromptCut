import type { Plugin, ViteDevServer } from "vite";
import { isPrerender } from "./render-role.mjs";
import { installHostedGate, hostedGateWanted } from "./hosted-render/vite-gate.mjs";

/**
 * 托管方渲染服务工作进程里的「页面一侧的闸」(契约 `docs/plan/hosted-render-contract.md` 第 7.5 节;实现与说明在
 * `server/hosted-render/vite-gate.mjs`):页面请求闸、出口代理、出口白名单头。
 *
 * **只在托管方的工作进程里生效**(环境里有管理进程给的 `PROMPTCUT_RENDER_BROKER`);桌面版、开发服务器、普通的独立渲染主机
 * 没有这个变量,这个插件什么都不做。要排在插件表的最前面:中间件按 `configureServer` 的调用顺序注册,闸要先于一切接口。
 */
export function hostedGatePlugin(): Plugin {
  return {
    name: "promptcut-hosted-gate",
    async configureServer(server: ViteDevServer) {
      if (!hostedGateWanted()) return;
      await installHostedGate(server as any, { prerender: isPrerender });
    },
  };
}

export default hostedGatePlugin;
