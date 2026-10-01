/**
 * 这个页面是不是「只读查看」打开的(`?observe=1`)。
 *
 * 带它进来的页面:
 *   - 不连 MCP 桥(见 src/ai/mcpExecutor.ts),不会把编辑台从工具通道上挤掉;
 *   - 不能保存(顶栏的保存按钮禁用),不接文档服务、不转码素材。
 *
 * 原来还有一种带钥匙的只读链接(`?view=`,给 SKILL 无头实例里的 agent 看画面用),随无头实例归档
 * (计划 `docs/plan/agent-workflow-plan.md` A4)。
 */
export function isViewOnly(): boolean {
  if (typeof location === "undefined") return false;
  try {
    return new URLSearchParams(location.search).has("observe");
  } catch {
    return false;
  }
}
