/**
 * 反向通道在页面这一侧(契约 `docs/plan/cloud-agent-contract.md` 第 28 节)。没有 React、没有 store,Node 单测直接用。
 *
 * 云端 Agent 在一轮里要发起人的页面做事(播放头、播放与暂停、读当下的选区)时,Agent 服务经**这个对话的事件流**发一条
 * `page.request { id, runId, tool, args, timeoutMs }`;页面用它本机同一套工具实现执行,经 `POST …/page-results` 交回。
 *
 * 页面这一侧守三条:
 *   1. 只认从事件流来的(`session.ts` 里读 `api.events` 的那一处是唯一入口;事件流是带委托票据向 Agent 服务取的)——
 *      页面上没有别的口子能触发这里的执行(没有全局函数、不听 `postMessage`、不听自定义事件);
 *   2. 只执行白名单里的这几种(`CLOUD_PAGE_REQUEST_TOOLS`),别的工具名一律拒绝并回明确的原因,什么都不做;
 *   3. 参数按本机同样的规矩查(`mcpExecutor.ts` 的必填检查):`seek` 必须带 `t`,且是不小于 0 的有限数;多带的字段丢掉,不往下传。
 * 这四个都不改项目:只读成员的页面上也照常执行。
 */
import type { CloudEvent } from "./types.ts";

/** 页面肯执行的请求。与服务端 `server/agent/service/cloud-tools.mjs` 的 `CLOUD_PAGE_TOOLS` 对账(单测 CAU-REV-05) */
export const CLOUD_PAGE_REQUEST_TOOLS = Object.freeze(["seek", "play", "pause", "get_selection"] as const);
export type CloudPageRequestTool = (typeof CLOUD_PAGE_REQUEST_TOOLS)[number];

/** 页面号的形状(页面自己起的随机串;发消息与开事件流时各报一次) */
export const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 本机那几个工具的实现(`src/mcp/handlers/` 里的同一份),由接线的一侧给 */
export interface PageRequestExec {
  seek(args: { t: number }): unknown;
  play(): unknown;
  pause(): unknown;
  getSelection(): unknown;
  /** 执行前后各调一次:这期间页面上的变化是 Agent 让做的,不算「用户动过」(与本机的工具调用同一对钩子) */
  begin?(): void;
  end?(): void;
}

export interface PageRequestAnswer {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 起一个页面号 */
export function newPageId(): string {
  const bytes = new Uint8Array(16);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `pg-${out}`;
}

/**
 * 执行一条 `page.request`。不是一条合格的请求(没有 `id`)回 null(不答);其余都回一个答案,做没做成写在 `ok` 里。
 * 实现抛错不外泄堆栈,只回一句原因。
 */
export async function runPageRequest(ev: CloudEvent, exec: PageRequestExec): Promise<PageRequestAnswer | null> {
  if (!ev || ev.type !== "page.request") return null;
  const id = typeof ev.id === "string" && REQUEST_ID_RE.test(ev.id) ? ev.id : null;
  if (!id) return null;
  const tool = typeof ev.tool === "string" ? ev.tool : "";
  if (!(CLOUD_PAGE_REQUEST_TOOLS as readonly string[]).includes(tool)) {
    return { id, ok: false, error: `这个页面不执行 ${tool.slice(0, 40) || "(空)"}:反向通道只做 ${CLOUD_PAGE_REQUEST_TOOLS.join("、")}。` };
  }
  const args = ev.args && typeof ev.args === "object" && !Array.isArray(ev.args) ? (ev.args as Record<string, unknown>) : {};
  if (tool === "seek") {
    // 与本机的必填检查同一句话(`mcpExecutor.ts` 的 `missingRequired`)
    if (args.t === undefined || args.t === null) return { id, ok: false, error: "缺少必填参数：t。请补齐后重试。" };
    if (typeof args.t !== "number" || !Number.isFinite(args.t) || args.t < 0) return { id, ok: false, error: "seek 的 t 要是不小于 0 的数(秒)。" };
  }
  exec.begin?.();
  try {
    let result: unknown;
    if (tool === "seek") result = exec.seek({ t: args.t as number });
    else if (tool === "play") result = exec.play();
    else if (tool === "pause") result = exec.pause();
    else result = exec.getSelection();
    result = await result;
    return { id, ok: true, result: result === undefined ? null : result };
  } catch (err) {
    return { id, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  } finally {
    exec.end?.();
  }
}
