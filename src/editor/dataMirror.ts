import { getState, subscribe } from "../store/project";

/**
 * 数据管理的只读镜像:编辑器页面把项目(带版本号)推给服务端一份
 * (docs/decoupling-plan.md 第 3.2 节「数据管理 → 项目」,阶段 4)。
 *
 * # 为什么
 *
 * 以前 Agent 的每一个动作都要经过编辑器页面中转:服务端通过 SSE 把调用转给页面,页面再去请求渲染。
 * 时间轴的真身在浏览器 store 里(right/index.tsx 的 seePreview 注释),所以不这么绕拿不到项目 ——
 * 可这一绕,Agent 的看图请求就挂在编辑器页面的连接上,这正是它能卡住界面的结构原因。
 *
 * 有了镜像,Agent 的读和渲染(get_project / see_frames / get_gif / bake_card / inspect_card_dom)
 * 由服务端直接拿镜像去问预渲染,完全不碰页面;写操作仍经过页面,撤销 / 重做不变。
 *
 * # 一致性
 *
 * - 用户的编辑:防抖 250 ms 推一次。
 * - Agent 的写操作:mcpExecutor 在回结果之前调 flushDataMirror(),所以 Agent「改完马上看」
 *   看到的一定是改完的那份(读后写一致)。
 * - 播放头 t 只在停下来时推(播放时每帧都变,推了也没人要):see_frames 不给时刻时用它。
 */

let rev = 0;
let pushedProject: unknown = null;
let pushedT = -1;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let started = false;

async function push(): Promise<void> {
  const s = getState();
  const project = s.project;
  const t = s.t;
  if (project === pushedProject && t === pushedT) return;
  const body = JSON.stringify({ rev: ++rev, project, t, playing: s.playing });
  pushedProject = project;
  pushedT = t;
  try {
    await fetch("/api/data/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // 推不上就当没推,下一次变化再推;服务端没有镜像时 Agent 的工具退回经页面执行
    pushedProject = null;
  }
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    inflight = push().finally(() => { inflight = null; });
  }, delay);
}

/** 开始镜像。只在连着 MCP 桥的那个编辑器页面上调(只读观看页不推,免得两个页面互相覆盖) */
export function startDataMirror(): () => void {
  if (started) return () => {};
  started = true;
  let lastProject = getState().project;
  let lastPlaying = getState().playing;
  schedule(0);
  const off = subscribe(() => {
    const s = getState();
    if (s.project !== lastProject) {
      lastProject = s.project;
      schedule(250);
    } else if (!s.playing && (lastPlaying || s.t !== pushedT)) {
      // 播放中不推 t;停下来(或暂停时拖了播放头)才推一次
      schedule(400);
    }
    lastPlaying = s.playing;
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    timer = null;
    started = false;
  };
}

/** 立刻把还没推的改动推上去并等它落地。Agent 的写工具回结果之前调 */
export async function flushDataMirror(): Promise<void> {
  if (!started) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inflight) await inflight;
  inflight = push().finally(() => { inflight = null; });
  await inflight;
}
