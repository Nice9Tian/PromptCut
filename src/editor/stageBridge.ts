import type { Project } from "../kernel/project";
import { changedClips, isEmptyPatch } from "../render/changedClips.mjs";
import type { StageRpcClient } from "../render/stageRpc";

/**
 * 主文档里「现在哪个 iframe 是舞台」的登记处(E0 / D4 页面侧)。
 *
 * 以前是挂在主窗口上的一个 getter(取 iframe 里的舞台 api),右栏的定位工具
 * 靠它量 contentBox。现在舞台只经 postMessage RPC 说话,主文档手里只有 RPC 客户端;
 * Preview 每换一个 iframe 就在这里登记一个新客户端,右栏拿到的永远是最新那个。
 *
 * 两个位置:
 *   - `front`:可见的播放器舞台(拖动 / 暂停 / 命中测试)。
 *   - `back`:后台舞台(探针 / 补跑 / 页面侧测量)。第 3 步只有一个舞台,`back` 为空时用 `front`
 *     代替(D4:「第 3 步只有一个舞台,先对它测;第 4 步 E1 之后改走 back 与单飞队列」)。
 *
 * `syncProject` 是**唯一**把项目推给某个舞台的口子:按 iframe 记一份「上次推过的项目」基线,
 * 能做增量就发 changedClips 的两层 diff(舞台合并时保持未变片段的引用),没有基线就整份 + reset。
 * Preview 的 effect 和右栏的测量都经它,所以同一份项目不会被推两遍。
 */
interface Slot {
  client: StageRpcClient | null;
  /** 上次成功推给这个客户端的项目(增量 diff 的基线) */
  pushed: Project | null;
  /** 推送串行化:两次 syncProject 交错时,后一次等前一次落定再比 */
  chain: Promise<void>;
}

const slots: Record<"front" | "back", Slot> = {
  front: { client: null, pushed: null, chain: Promise.resolve() },
  back: { client: null, pushed: null, chain: Promise.resolve() },
};

/** 登记 / 注销一个舞台客户端。换 iframe 时先登记新的再 dispose 旧的,基线随客户端一起换 */
export function setStageClient(role: "front" | "back", client: StageRpcClient | null): void {
  const slot = slots[role];
  if (slot.client === client) return;
  slot.client = client;
  slot.pushed = null;
  slot.chain = Promise.resolve();
}

export function frontStage(): StageRpcClient | null {
  const c = slots.front.client;
  return c && !c.disposed ? c : null;
}

/** 后台舞台此刻落在哪个位置上(第 3 步没有 back,就是 front);syncProject 要按它选基线 */
export function backRole(): "front" | "back" {
  const b = slots.back.client;
  return b && !b.disposed ? "back" : "front";
}

/** 后台舞台;第 3 步没有,退回可见舞台 */
export function backStage(): StageRpcClient | null {
  const b = slots.back.client;
  if (b && !b.disposed) return b;
  return frontStage();
}

/**
 * 把项目同步到某个舞台。返回时舞台已经收到并应用。
 * 基线相同(同一个对象引用)就什么都不发。
 */
export function syncProject(role: "front" | "back", project: Project): Promise<void> {
  const slot = slots[role];
  const run = async () => {
    const client = slot.client;
    if (!client || client.disposed) return;
    if (slot.pushed === project) return;
    const patch = changedClips(slot.pushed, project);
    if (slot.pushed && isEmptyPatch(patch)) {
      slot.pushed = project;
      return;
    }
    if (patch.kind === "full") await client.setProject(project, { reset: true });
    else await client.setProject(patch);
    // 客户端中途换了(iframe 重载),这次推的基线不算数
    if (slot.client === client) slot.pushed = project;
  };
  const next = slot.chain.then(run, run);
  slot.chain = next.catch(() => {});
  return next;
}

/** 测试 / 调试用:哪个舞台推到了哪份项目 */
export function pushedProject(role: "front" | "back"): Project | null {
  return slots[role].pushed;
}
