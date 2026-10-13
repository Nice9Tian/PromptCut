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

/* ====================================================================== 账号模式(0.7.18,工具包 W2)
 *
 * 账号模式下服务端的反向通道是 `server/agent/service/page-bridge.mjs`:发起人与发起页都从文档服务确认过的运行授权里取,
 * 请求带版本号 2、这张页面在文档服务在场表里的页面号、一个只出现在这条事件流上的一次性随机数:
 *   `page.request { v: 2, id, nonce, runId, pageId, tool, args, timeoutMs }`
 * 页面执行后经 `POST …/page-results` 交回 `{ v: 2, id, nonce, pageId, runId, ok, result?, error?, code? }`。
 *
 * 与旧通道(上面的 `runPageRequest`)的不同:
 *   1. 白名单是 `seek`、`play`、`pause`、`web_handoff`,**没有 `get_selection`**:账号模式下它走文档服务的全员选区查询,
 *      页面不再交自己这一张的选区(那是旧的单人快照);
 *   2. 请求里的页面号必须就是这张页面此刻的在场页面号(`selectionPresenceStatus().pageId`,由接线的一侧给),对不上的不执行也不答
 *      (同一个账号的另一个页签、别的成员的页面收到了也不会动);
 *   3. 同一个请求号重复到达只执行一次,再到时回第一次的答案(交回没成功时可以原样再交,服务端按幂等处理)。
 * 入口同样只有事件流那一处;本文件不挂全局、不听消息。
 */

/** 账号模式下页面肯执行的请求。与服务端 `page-bridge.mjs` 的 `PAGE_BRIDGE_TOOLS` 对账(单测 CAU-ACC-05) */
export const ACCOUNT_PAGE_REQUEST_TOOLS = Object.freeze(["seek", "play", "pause", "web_handoff"] as const);
export type AccountPageRequestTool = (typeof ACCOUNT_PAGE_REQUEST_TOOLS)[number];
export const ACCOUNT_PAGE_REQUEST_VERSION = 2;

/** 在场页面号的形状(文档服务 `selection` 模块的同一条规矩) */
const PRESENCE_PAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_REASON_CHARS = 200;
const MAX_URL_CHARS = 2048;

/** 页面做不了时回给服务端的话(服务端按 `code` 换成给模型看的说明,这句只是兜底) */
export const ACCOUNT_PAGE_TEXT = Object.freeze({
  unsupported: "这个页面没有可以交给用户的本机浏览器。",
});

export interface AccountPageExec {
  seek(args: { t: number }): unknown;
  play(): unknown;
  pause(): unknown;
  /** 本机那份 `web_handoff`(桌面版才有);`url` 是云端浏览器当前页的公开地址。纯网页的环境不给这个函数 */
  webHandoff?(args: { reason?: string; hide?: boolean; url?: string }): unknown;
  begin?(): void;
  end?(): void;
}

export interface AccountPageAnswer {
  v: 2;
  id: string;
  nonce: string;
  pageId: string;
  runId?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

function handoffArgs(args: Record<string, unknown>): { reason?: string; hide?: boolean; url?: string } | string {
  const out: { reason?: string; hide?: boolean; url?: string } = {};
  if (args.reason !== undefined) {
    if (typeof args.reason !== "string" || args.reason.length > MAX_REASON_CHARS) return "web_handoff 的 reason 要是一句不太长的话。";
    if (args.reason) out.reason = args.reason;
  }
  if (args.hide !== undefined) {
    if (typeof args.hide !== "boolean") return "web_handoff 的 hide 要是 true 或 false。";
    if (args.hide) out.hide = true;
  }
  if (args.url !== undefined) {
    if (typeof args.url !== "string" || args.url.length > MAX_URL_CHARS) return "web_handoff 的地址不合格。";
    let parsed: URL;
    try { parsed = new URL(args.url); } catch { return "web_handoff 的地址不合格。"; }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return "web_handoff 的地址不合格。";
    out.url = parsed.href;
  }
  return out;
}

/**
 * 账号模式的页面请求执行器。`pageId` 每次现取(这张页面此刻的在场页面号;没连上文档服务时是 null,那时什么都不执行)。
 * `run` 回 null 表示这条不是给这张页面的合格请求:不执行、不答。
 */
export function createAccountPageRequests(deps: { pageId: () => string | null; exec: AccountPageExec; remember?: number }): {
  run(ev: CloudEvent): Promise<AccountPageAnswer | null>;
} {
  const remember = deps.remember ?? 200;
  /** 请求号 → 一次性随机数与第一次的答案 */
  const done = new Map<string, { nonce: string; answer: Promise<AccountPageAnswer> }>();

  async function execute(base: { v: 2; id: string; nonce: string; pageId: string; runId?: string }, tool: string, raw: Record<string, unknown>): Promise<AccountPageAnswer> {
    if (!(ACCOUNT_PAGE_REQUEST_TOOLS as readonly string[]).includes(tool)) {
      return { ...base, ok: false, error: `这个页面不执行 ${tool.slice(0, 40) || "(空)"}:反向通道只做 ${ACCOUNT_PAGE_REQUEST_TOOLS.join("、")}。` };
    }
    let seekArgs: { t: number } | null = null;
    let handoff: { reason?: string; hide?: boolean; url?: string } | null = null;
    if (tool === "seek") {
      if (raw.t === undefined || raw.t === null) return { ...base, ok: false, error: "缺少必填参数：t。请补齐后重试。" };
      if (typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t < 0) return { ...base, ok: false, error: "seek 的 t 要是不小于 0 的数(秒)。" };
      seekArgs = { t: raw.t };
    } else if (tool === "web_handoff") {
      const checked = handoffArgs(raw);
      if (typeof checked === "string") return { ...base, ok: false, error: checked };
      if (!deps.exec.webHandoff) return { ...base, ok: false, code: "unsupported", error: ACCOUNT_PAGE_TEXT.unsupported };
      handoff = checked;
    }
    deps.exec.begin?.();
    try {
      if (tool === "web_handoff") {
        const r = await deps.exec.webHandoff!(handoff!);
        const failed = !!r && typeof r === "object" && (r as { ok?: unknown }).ok === false;
        if (failed) return { ...base, ok: false, error: String((r as { error?: unknown }).error ?? "web_handoff 没有做成").slice(0, 300) };
        // 本机实现回的窗口细节不往云端带,只说交没交出去
        return { ...base, ok: true, result: { ok: true, visible: !handoff!.hide } };
      }
      let result: unknown;
      if (tool === "seek") result = deps.exec.seek(seekArgs!);
      else if (tool === "play") result = deps.exec.play();
      else result = deps.exec.pause();
      result = await result;
      return { ...base, ok: true, result: result === undefined ? null : result };
    } catch (err) {
      return { ...base, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    } finally {
      deps.exec.end?.();
    }
  }

  return {
    async run(ev: CloudEvent): Promise<AccountPageAnswer | null> {
      if (!ev || ev.type !== "page.request" || ev.v !== ACCOUNT_PAGE_REQUEST_VERSION) return null;
      const id = typeof ev.id === "string" && REQUEST_ID_RE.test(ev.id) ? ev.id : null;
      const nonce = typeof ev.nonce === "string" && NONCE_RE.test(ev.nonce) ? ev.nonce : null;
      if (!id || !nonce) return null;
      const mine = deps.pageId();
      // 不是发给这张页面的(页面号对不上、这张页面还没连上文档服务):不执行也不答
      if (!mine || !PRESENCE_PAGE_ID_RE.test(mine) || ev.pageId !== mine) return null;
      const seen = done.get(id);
      if (seen) return seen.nonce === nonce ? seen.answer : null;
      const tool = typeof ev.tool === "string" ? ev.tool : "";
      const raw = ev.args && typeof ev.args === "object" && !Array.isArray(ev.args) ? (ev.args as Record<string, unknown>) : {};
      const base = { v: ACCOUNT_PAGE_REQUEST_VERSION as 2, id, nonce, pageId: mine, ...(typeof ev.runId === "string" ? { runId: ev.runId } : {}) };
      const answer = execute(base, tool, raw);
      done.set(id, { nonce, answer });
      if (done.size > remember) done.delete(done.keys().next().value as string);
      return answer;
    },
  };
}
