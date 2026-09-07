/**
 * 这个页面是不是「只读查看」打开的。
 *
 * Skill 任务跑起来之后,agent 想看画面就走任务目录 instance.json 里那条 `viewUrl` ——
 * 一条带钥匙的完整链接,它照常打开就行,不用记「要加什么后缀」。带 `view=` 进来的页面:
 *
 *   - 不连 MCP 桥(见 src/ai/mcpExecutor.ts),不会把无头实例从工具通道上挤掉;
 *   - 不能保存(顶栏的保存按钮禁用)。
 *
 * 真正让「不能编辑」成立的是**服务端**那一道:改项目的接口要 owner 那把钥匙,只读页面
 * 拿不到(见 server/vite-plugin-view-gate.ts)。这里做的是界面这一层 —— 让用户和 agent
 * 一眼看出来「这份是只读的」,而不是点了保存才发现被拒。
 *
 * `?observe=1` 是同一件事的老写法,留着不动:a8a6ee8 之后已经有东西在用它,而且用户
 * 自己那份 PromptCut(没有钥匙这套)想只读打开时也只有它可用。
 */

function params(): URLSearchParams {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
}

/** 只读查看模式:带了 view 钥匙,或者用老写法 ?observe=1 */
export function isViewOnly(): boolean {
  if (typeof location === "undefined") return false;
  const p = params();
  return !!p.get("view") || p.has("observe");
}

/**
 * 这个页面手上的 owner 钥匙,没有就是空串。
 *
 * 只有无头实例自己的页面有(headless.mjs 把它拼进了页面地址)。写项目的请求要把它
 * 带在 `x-pc-owner` 头里,服务端拿它区分「实例在写回」和「别人在乱改」。
 */
export function ownerToken(): string {
  if (typeof location === "undefined") return "";
  return params().get("owner") || "";
}

/** 写项目的请求要带的头。不是主人就返回空对象,让服务端去拒 */
export function ownerHeaders(): Record<string, string> {
  const t = ownerToken();
  return t ? { "x-pc-owner": t } : {};
}
