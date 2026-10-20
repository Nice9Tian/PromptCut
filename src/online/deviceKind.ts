/**
 * 在线浏览器的身份：电脑 / 手机（语义 `product/platforms.md`「在线浏览器」的「身份」，
 * 判法见 `mechanism/platforms.md`「身份」）。
 *
 * - Chromium 系看 `navigator.userAgentData.mobile`：是就算手机；
 * - 没有 `userAgentData` 的（Safari、Firefox）看标识：有 iPhone / iPod 算手机；
 * - 其余算电脑。两样都读不到也算电脑。
 * - iPad 的 Safari 缺省报桌面声明（`Macintosh` + 多点触控）：舞台闸门实现之前按电脑算，
 *   但结果里标 `ipadLike`，以后 `docs/plan/online-browser-task.md` 的舞台闸门接上时，
 *   停在第一级的改判手机（`resolveIpad`）。
 *
 * 身份决定两件事：渲染节点（电脑当、手机不当）和界面（手机用手机版界面）。界面另有一个只给开发和验收用的
 * 地址参数 `?layout=mobile|desktop`，见 `pickLayout`；不在界面上给用户开关。
 *
 * 不引 `mode.ts`，Node 单测直接用（UA 等都可注入）。
 */

export type DeviceKind = "desktop" | "phone";

export interface UaDataLike {
  mobile?: boolean;
}

export interface DeviceKindInput {
  ua?: string | null;
  uaData?: UaDataLike | null;
  maxTouchPoints?: number;
}

export interface DeviceKindResult {
  kind: DeviceKind;
  /** 按哪一样判的 */
  by: "uaData" | "ua" | "none";
  /** 像 iPad（标识里有 iPad，或报桌面 Mac 却有多点触控）：现在按电脑算，等舞台闸门改判 */
  ipadLike: boolean;
}

export function judgeDeviceKind(input: DeviceKindInput): DeviceKindResult {
  const ua = String(input.ua ?? "");
  const touch = input.maxTouchPoints ?? 0;
  const ipadLike = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  const mobile = input.uaData?.mobile;
  if (typeof mobile === "boolean") return { kind: mobile ? "phone" : "desktop", by: "uaData", ipadLike: ipadLike && !mobile };
  if (ua) return { kind: /iPhone|iPod/.test(ua) ? "phone" : "desktop", by: "ua", ipadLike };
  return { kind: "desktop", by: "none", ipadLike: false };
}

/**
 * 舞台闸门接上之后给 iPad 改判用：到了第二级或第三级算电脑，停在第一级算手机。
 * 闸门还没实现时调用方不传级别，结果不变。
 */
export function resolveIpad(result: DeviceKindResult, stageGateLevel?: 1 | 2 | 3): DeviceKind {
  if (!result.ipadLike || stageGateLevel === undefined) return result.kind;
  return stageGateLevel >= 2 ? "desktop" : "phone";
}

/** 读当前页面的身份 */
export function currentDeviceKind(): DeviceKindResult {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userAgentData?: UaDataLike }) : null;
  return judgeDeviceKind({ ua: nav?.userAgent ?? "", uaData: nav?.userAgentData ?? null, maxTouchPoints: nav?.maxTouchPoints ?? 0 });
}

export type Layout = "desktop" | "mobile";

/**
 * 选界面：只有在线浏览器、身份为手机的进手机版；桌面版（Tauri、本机编辑器）恒为桌面界面。
 * `?layout=mobile|desktop` 只给开发和验收用，强制选界面（在线、桌面都认，方便在桌面浏览器里看手机版）。
 */
export function pickLayout(opts: { online: boolean; kind: DeviceKind; search?: string }): Layout {
  let forced: string | null = null;
  try {
    forced = new URLSearchParams(opts.search ?? "").get("layout");
  } catch {
    forced = null;
  }
  if (forced === "mobile" || forced === "desktop") return forced;
  return opts.online && opts.kind === "phone" ? "mobile" : "desktop";
}
