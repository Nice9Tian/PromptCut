/**
 * 在线页面顶栏的连接状态措辞(C10 契约第 10 节、第 17 节表 A)与离线常驻提示。纯函数,Node 单测可载入。
 *
 * 五条状态(文案一字不差照表 A):
 *   - 断网:             当前没有网络连接。
 *   - 连不上文档服务:   连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。
 *   - 连不上素材服务:   连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。
 *   - 恢复中:           已恢复连接，正在提交离线时的修改…
 *   - 恢复完成:         离线时的修改已全部提交。
 * 离线且有未提交的改动时另有常驻提示(表 A「常驻提示」),关页面时挂浏览器原生的离开确认。
 *
 * **HT-a 会话接续期间不闪**:传输断了在会话层里接续(`src/editor/sync/link.ts`),DocSync 看不见,状态本来就不变;
 * 另外进入离线类措辞要持续 `OFFLINE_SHOW_DELAY_MS` 才显示(会话刚结束又马上建新会话的那一下也不闪)。
 * 「同步已暂停」(离线批次第一条被拒,C6.5)照旧用原来的小部件,不在这五条里。
 */
import type { SyncStatus } from "../../store/docsync";

export const ONLINE_STATUS_TEXT = {
  noNetwork: "当前没有网络连接。",
  docDown: "连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。",
  assetDown: "连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。",
  recovering: "已恢复连接，正在提交离线时的修改…",
  recovered: "离线时的修改已全部提交。",
} as const;

export type OnlineStatusKind = keyof typeof ONLINE_STATUS_TEXT;

/** 离线且有未提交的改动时的常驻提示(表 A) */
export const OFFLINE_UNSENT_TEXT = "当前离线，有未提交的修改。关闭页面将丢失这些操作。";

/** 离线类措辞持续这么久才显示(不闪) */
export const OFFLINE_SHOW_DELAY_MS = 1500;
/** 「离线时的修改已全部提交」显示多久 */
export const RECOVERED_SHOW_MS = 4000;

export interface OnlineStatusInput {
  /** DocSync 的状态 */
  status: SyncStatus;
  /** `navigator.onLine`(浏览器自己认为有没有网) */
  navigatorOnline: boolean;
  /** 素材服务最近一次请求是不是连不上(网络错误,不是 4xx/5xx) */
  assetDown: boolean;
  /** 恢复阶段:从离线回来、还有离线时的修改没提交完 = recovering;刚提交完 = recovered;其余 null */
  recovery: "recovering" | "recovered" | null;
}

/** 这一刻顶栏该显示哪一条(没有要说的回 null)。离线类的延迟由调用方做 */
export function onlineStatusOf(s: OnlineStatusInput): OnlineStatusKind | null {
  if (s.status === "paused") return null; // 「同步已暂停」由原来的小部件管
  if (s.status === "offline") return s.navigatorOnline ? "docDown" : "noNetwork";
  if (s.recovery) return s.recovery;
  if (s.assetDown) return s.navigatorOnline ? "assetDown" : "noNetwork";
  return null;
}

/** 该不该挂常驻提示与离开确认:离线(含暂停)且手里有没提交的修改 */
export function offlineUnsent(status: SyncStatus, unconfirmed: number): boolean {
  return (status === "offline" || status === "paused") && unconfirmed > 0;
}

/**
 * 恢复阶段的状态机:上一拍的阶段 + 这一拍的状态与未确认条数 → 新阶段。
 * 离线(或暂停后选了重放)期间攒过修改,回到在线时还有没确认的,就是「恢复中」;确认完变「恢复完成」;
 * 「恢复完成」由调用方按 `RECOVERED_SHOW_MS` 撤掉。
 */
export function nextRecovery(prev: { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean },
  status: SyncStatus, unconfirmed: number): { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean } {
  const offline = status === "offline" || status === "paused";
  if (offline) return { phase: null, wasOffline: true, hadUnsent: prev.hadUnsent || unconfirmed > 0 };
  if (prev.wasOffline) {
    // 刚回来:离线期间有攒着的修改才进恢复阶段
    if (!prev.hadUnsent) return { phase: null, wasOffline: false, hadUnsent: false };
    return unconfirmed > 0
      ? { phase: "recovering", wasOffline: false, hadUnsent: true }
      : { phase: "recovered", wasOffline: false, hadUnsent: false };
  }
  if (prev.phase === "recovering" && unconfirmed === 0 && status === "online") return { phase: "recovered", wasOffline: false, hadUnsent: false };
  return { ...prev, wasOffline: false };
}
