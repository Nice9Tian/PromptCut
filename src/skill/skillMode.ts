/**
 * SKILL 模式在前端这一侧:订阅状态、开关、以及通知桌面壳变形。
 *
 * 真相源是服务端那个状态文件(server/skill-gate.mjs),不是这里的变量 —— 无头实例和
 * Rust 壳是另外两个进程,只有那个文件是三方都能约定的地方。这里做的事只有三件:
 * 每秒问一次、把结果发给订阅者、状态一变就通知壳。
 *
 * 为什么是轮询不是 SSE:壳那边本来就在轮询同一个文件(Rust 里没有网页那套事件流),
 * 前端再单独搞一套推送只会让两边看到的时刻对不上。一秒一次的 JSON 请求便宜得很。
 */

export interface SkillState {
  active: boolean;
  jobId: string | null;
  jobDir: string | null;
  procPath: string | null;
  since: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

/** agent 那边改到哪了,给锁定面板和悬浮图标显示 */
export interface SkillProgress {
  updatedAt: string;
  clips: number;
}

export interface SkillSnapshot {
  state: SkillState;
  proc: SkillProgress | null;
}

const CLOSED: SkillState = {
  active: false, jobId: null, jobDir: null, procPath: null,
  since: null, closedAt: null, closedBy: null,
};

let snapshot: SkillSnapshot = { state: CLOSED, proc: null };
const listeners = new Set<(s: SkillSnapshot) => void>();
let timer: number | null = null;
/** 上一次通知壳的状态,只在真的翻转时才发事件 */
let lastNotified: boolean | null = null;

function emit() {
  for (const fn of listeners) fn(snapshot);
}

/**
 * 告诉桌面壳「进/出 SKILL 模式了」。
 *
 * 壳收到之后隐藏主窗、变成右上角的悬浮图标(反之恢复)。走 window.__TAURI__ 的事件,
 * 和「外观 → 皮肤…」那条是同一个路子;不是桌面版就什么都不做,浏览器里照常用。
 */
function notifyShell(active: boolean) {
  if (lastNotified === active) return;
  lastNotified = active;
  const tauri = (window as unknown as {
    __TAURI__?: { event?: { emit?: (e: string, payload?: unknown) => Promise<unknown> } };
  }).__TAURI__;
  void tauri?.event?.emit?.("pc-skill-mode", { active, at: new Date().toISOString() })?.catch?.(() => {});
}

/**
 * 让开关跟着 Skill 任务的生死走。
 *
 * 这一步不做的话,SKILL 模式永远没人打开 —— 用户点的是「Skill 模式 → 开始」,那是另一个
 * 对话框的事(它由另一条线在改,不往里加东西)。所以反过来推:**有活着的任务就是 SKILL 模式**。
 *
 * 两条例外,都关于「别跟用户抢」:
 *   - 用户自己按了「关闭 SKILL 模式」,那这个任务就不再自动打开 —— 否则他刚关上,
 *     下一秒又被这里打开,按钮等于失灵;换一个新任务才重新开;
 *   - 任务已经不在了(停了 / 删了)就自动关,不用等用户来点。agent 都没了,
 *     再锁着 AI 面板是白锁。
 *
 * 只读 /api/skill/jobs,不写它 —— 那条接口归另一条线管。
 */
/**
 * 这个页面是不是无头实例(agent 那份)。
 *
 * 无头实例的页面**不许碰 SKILL 开关** —— 它是被管的一方。真出过事:开关的自动开合
 * 逻辑在它那儿也跑,用户刚点了「关闭 SKILL 模式」,它下一秒就把闸又打开,
 * agent 继续往项目里写(实测:闸关之后还是多落了一张卡)。等于 agent 能自己解除封锁。
 */
function isHeadlessPage(): boolean {
  try {
    return new URLSearchParams(location.search).has("headless");
  } catch {
    return false;
  }
}

async function syncWithJobs(state: SkillState) {
  if (isHeadlessPage()) return;
  let alive: { id: string; dir: string; alive: boolean; createdAt?: string } | null = null;
  try {
    const res = await fetch("/api/skill/jobs");
    const data = await res.json();
    alive = (data?.jobs ?? []).find((j: { alive?: boolean }) => j.alive) ?? null;
  } catch {
    return; // 接口不在(旧版本 / 正在重启)就什么都不做,别乱关用户的模式
  }

  if (alive && !state.active) {
    /*
     * 用户手动关过就别再自动打开 —— 除非这是一个**关掉之后才新建**的任务。
     *
     * 判据必须是时间,不能是「jobId 一样不一样」:一开始写成后者,结果是任务还活着、
     * 用户点了关闭,下一秒 jobId 对不上就又被打开,那个按钮等于失灵(实测复现)。
     * 按时间比就没有这个洞:关掉的那一刻之前存在的任务,一律不再唤醒它。
     */
    const closedAt = state.closedBy === "user" ? Date.parse(state.closedAt || "") : NaN;
    const jobStarted = Date.parse(alive.createdAt || "");
    const suppressed = Number.isFinite(closedAt) && !(jobStarted > closedAt);
    if (!suppressed) {
      await openSkillMode({ jobId: alive.id, jobDir: alive.dir, procPath: `${alive.dir}\\project.proc` });
    }
    return;
  }
  if (!alive && state.active) {
    await closeSkillMode("job-stopped");
  }
}

async function poll() {
  try {
    const res = await fetch("/api/skill-mode");
    const data = await res.json();
    if (data?.ok) {
      snapshot = { state: { ...CLOSED, ...data.state }, proc: data.proc ?? null };
      notifyShell(snapshot.state.active);
      emit();
      // 放在推送之后:先把当前状态给界面,再去纠正它,免得界面等一整轮才更新
      await syncWithJobs(snapshot.state);
    }
  } catch {
    /* dev server 没起来 / 正在重启,下一秒再问,别把界面弄成报错 */
  }
}

export function subscribeSkill(fn: (s: SkillSnapshot) => void): () => void {
  listeners.add(fn);
  fn(snapshot);
  if (timer === null) {
    void poll();
    timer = window.setInterval(() => void poll(), 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function getSkillSnapshot(): SkillSnapshot {
  return snapshot;
}

/** 开:Skill 任务起来之后调一次,把闸打开 */
export async function openSkillMode(info: { jobId?: string; jobDir?: string; procPath?: string }): Promise<void> {
  await fetch("/api/skill-mode/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(info),
  });
  await poll();
}

/** 关:用户点「关闭 SKILL 模式」。之后无头实例的任何操作都会被拒 */
export async function closeSkillMode(by = "user"): Promise<void> {
  await fetch("/api/skill-mode/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by }),
  });
  await poll();
}

/**
 * 抢一份 .proc 的独占锁。SKILL 模式下服务端会跳过 —— 那时无头实例在写、壳在读,
 * 加了独占谁都别想动。返回 null 表示拿到了,否则是拿不到的原因。
 */
export async function acquireProcLock(procPath: string): Promise<string | null> {
  try {
    const res = await fetch("/api/skill-lock/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: procPath }),
    });
    const data = await res.json();
    return data?.ok ? null : data?.error || "这个项目文件已被占用";
  } catch (e) {
    // 锁服务不可用不该挡住打开项目
    return null;
  }
}

export async function releaseProcLock(procPath: string): Promise<void> {
  try {
    await fetch("/api/skill-lock/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: procPath }),
    });
  } catch { /* 放锁失败无所谓:进程退出时服务端会兜底清掉 */ }
}
