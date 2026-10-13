/**
 * 账号模式下,这张页面执行云端 Agent 经反向通道发来的请求的唯一接线处(契约第 28 节的账号版;服务端是
 * `server/agent/service/page-bridge.mjs` 与 `collect-bridge.mjs`)。
 *
 * 两类请求,各有各的执行器,这里只做分流:
 *   - 播放头与网页接管(`seek`、`play`、`pause`、`web_handoff`):`pageRequests.ts` 的 `createAccountPageRequests`;
 *   - 采集的委托与登录(`collect_delegate_start / poll / cancel`、`collect_login`、`collect_login_check`):`collectBridge.ts` 的
 *     `createCollectBridgePage`。本机采集与上传只在有本机编辑器进程的桌面版给;网页版不给,执行器如实回「做不了」。
 *
 * 答案**原样**交回(里面带着请求号、一次性随机数与这张页面的在场页面号);不属于这张页面的请求两个执行器都回 null,不答。
 * 入口只有事件流那一处(`session.ts`),本文件不挂全局、不听消息。
 */
import type { CloudEvent } from "./types.ts";
import { createAccountPageRequests, type AccountPageAnswer, type AccountPageExec } from "./pageRequests.ts";
import { createCollectBridgePage, type CollectBridgeLocal, type CollectBridgeUpload, type CollectPageAnswer } from "./collectBridge.ts";

export interface AccountPageDeps {
  /** 这张页面此刻的在场页面号(连上文档服务之后才有;每次现取) */
  pageId: () => string | null;
  exec: AccountPageExec;
  /** 本机采集(桌面版);网页版不给 */
  local?: CollectBridgeLocal | null;
  /** 把本机内容库里的文件传进账号项目的素材服务(桌面版);网页版不给 */
  upload?: CollectBridgeUpload | null;
}

export type AccountPageReply = AccountPageAnswer | CollectPageAnswer;

export function createAccountPageHandler(deps: AccountPageDeps): (ev: CloudEvent) => Promise<AccountPageReply | null> {
  const page = createAccountPageRequests({ pageId: deps.pageId, exec: deps.exec });
  const collect = createCollectBridgePage({ pageId: deps.pageId, local: deps.local ?? null, upload: deps.upload ?? null });
  return (ev) => (collect.handles(ev) ? collect.run(ev) : page.run(ev));
}
