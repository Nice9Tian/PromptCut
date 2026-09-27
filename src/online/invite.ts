/**
 * 邀请链接与在线地址（C10a 契约 `docs/plan/c10a-contract.md` 第 2、4、5 节）。
 *
 * - 邀请链接：`<托管端公网源>/editor#invite=<邀请码>`；邀请码是 43 个 base64url 字符。邀请码只放在 `#` 片段里，
 *   不进查询串（`?join=` 已被本机第二页占用，第 15 节）。
 * - 页面启动时读 `location.hash` 里的 `invite=`：核对字符集与长度后放进内存，随即 `history.replaceState` 把 `#` 片段清掉，
 *   之后才向服务器提交。不写 localStorage、不进日志。
 * - 粘贴邀请链接：从完整链接里取服务器的源与邀请码（扫码后 `#` 片段没保留时的退路）。
 * - 托管端的文档服务在同一个源的 `/hosted/` 下（nginx 转发，契约第 2 节），素材服务在 `/media/` 下（由文档服务的
 *   `service.endpoints` 下发，页面不自己拼）。
 *
 * 不引 `mode.ts`，Node 单测直接用。
 */

export const INVITE_LENGTH = 43;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** 托管端文档服务在源下的路径（nginx 的 `location /hosted/`） */
export const HOSTED_DOC_PATH = "/hosted/";
/** 在线构建的路径 */
export const EDITOR_PATH = "/editor";

export const isInviteCode = (v: unknown): v is string => typeof v === "string" && CODE_RE.test(v);

/**
 * 从 `#` 片段里取 `invite=`：片段可以是 `#invite=<码>`，也可以和别的参数用 `&` 并列。
 * 回 `{ code }`（合格）、`{ bad: true }`（有 `invite=` 但不合格）或 null（没有）。
 */
export function inviteFromHash(hash: string): { code: string } | { bad: true } | null {
  const text = String(hash || "").replace(/^#/, "");
  if (!text) return null;
  let value: string | null = null;
  for (const part of text.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i) === "invite") {
      value = part.slice(i + 1);
      break;
    }
  }
  if (value === null) return null;
  return isInviteCode(value) ? { code: value } : { bad: true };
}

/**
 * 粘贴的邀请链接 → `{ origin, code }`；不是 `http(s)://…#invite=<43 位>` 的回 null（「这不是有效的邀请链接。」）。
 * 容忍首尾空白、微信等把链接包在文字里（取第一个 http(s):// 起到空白为止）。
 */
export function parseInviteLink(text: string): { origin: string; code: string } | null {
  const m = /https?:\/\/\S+/i.exec(String(text || "").trim());
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(m[0]);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const found = inviteFromHash(u.hash);
  if (!found || !("code" in found)) return null;
  return { origin: u.origin, code: found.code };
}

/** 邀请链接：`<源>/editor#invite=<码>` */
export function inviteLinkOf(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}${EDITOR_PATH}#invite=${code}`;
}

/** 源 → 托管端文档服务的 http 基址（`https://h/hosted/`，以 `/` 结尾，与 route.mjs 候选的 `base` 同形） */
export function hostedDocBaseOf(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${HOSTED_DOC_PATH}`;
}

/**
 * 文档服务的 http 基址 → WebSocket 地址，**保留末尾斜杠**：`https://h/hosted/` → `wss://h/hosted/`。
 * nginx 的 `location /hosted/` 对不带斜杠的 `/hosted` 回 301，WebSocket 升级跟不了重定向，所以凭源走 `/hosted/`
 * 的连接要带斜杠（route.mjs 的 `wsBaseOf` 会去掉它，局域网主机的 `/docservice` 要的是不带斜杠的）。
 */
export function hostedWsUrlOf(base: string): string {
  const u = new URL(base);
  const protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  return `${protocol}//${u.host}${u.pathname}`;
}

/* ---------------- 启动时读、读完即清 ---------------- */

let captured: { code: string } | { bad: true } | null = null;

/**
 * 页面启动时调一次：读 `location.hash` 的 `invite=`，放进内存，然后把 `#` 片段清掉（只清掉带 `invite=` 的片段）。
 * `loc` / `hist` 可注入（测试）。
 */
export function captureInviteFromLocation(
  loc: Pick<Location, "hash" | "pathname" | "search"> = location,
  hist: Pick<History, "replaceState" | "state"> = history,
): void {
  const found = inviteFromHash(loc.hash);
  if (!found) return;
  captured = found;
  try {
    hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}`);
  } catch {
    /* 清不掉就算了：邀请码只在片段里，片段不发给服务器 */
  }
}

/** 取走启动时读到的邀请码（只给一次） */
export function takeCapturedInvite(): { code: string } | { bad: true } | null {
  const c = captured;
  captured = null;
  return c;
}

/** 看一眼（不取走） */
export function peekCapturedInvite(): { code: string } | { bad: true } | null {
  return captured;
}
