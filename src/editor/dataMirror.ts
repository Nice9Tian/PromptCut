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
 * - **推送一次只飞一个**,后一次等前一次落地再发:两次同时在路上的话,到达顺序没保证,
 *   旧的可能把新的盖掉。服务端也按「页面会话 + 版本号」拒收旧的(vite-plugin-ai)。
 * - **推失败(网络错误、HTTP 非 2xx)就当没推过**,过一会儿自己再推;不然镜像会一直停在旧版,
 *   直到下一次有人改东西。
 */

/** 这个页面这次打开的会话 id:刷新页面版本号从头数,服务端靠它分辨「新页面」和「旧推送」 */
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let rev = 0;
let pushedProject: unknown = null;
let pushedT = -1;
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let started = false;

async function pushNow(): Promise<void> {
  const s = getState();
  const project = s.project;
  const t = s.t;
  if (project === pushedProject && t === pushedT) return;
  const body = JSON.stringify({ session, rev: ++rev, project, t, playing: s.playing });
  let ok = false;
  try {
    const res = await fetch("/api/data/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    pushedProject = project;
    pushedT = t;
  } else if (started) {
    // 推不上:过两秒再试。服务端没有新镜像时 Agent 的工具退回经页面执行,不会用到过期的这一份
    schedule(2000);
  }
}

/** 排进推送链:前一次落地之后才发下一次 */
function push(): Promise<void> {
  chain = chain.then(pushNow, pushNow);
  return chain;
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void push();
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
  await push();
}
