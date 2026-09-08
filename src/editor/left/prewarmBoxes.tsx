import { createRoot, type Root } from "react-dom/client";
import { allCards } from "../../kernel/registry";
import { allParts } from "../../parts/registry";
import { assetCardKind } from "../../cards/assets";
import { AnimClock } from "../../kernel/AnimClock";
import { PartTree } from "../../kernel/PartTree";
import { themeStyle } from "../../themes";
import { getState } from "../../store/project";
import type { CardDef, PartInstance } from "../../kernel/types";
import type { PartDef } from "../../parts/types";
import { measureAcrossTime, unionBox, type Box } from "./contentBox";
import { knownKeys, rememberBox, dumpBoxes } from "./previewBoxes";

/**
 * 后台补量:第一次打开卡片页时,把静态表里没有的卡片 / 部件挨个在屏幕外渲染一遍、
 * 量出包围盒存起来(previewBoxes.ts)。算完的下次悬停一步到位,不用再等测量跑。
 *
 * 三条自我约束:
 *   - **一次只渲一个**,而且排在空闲时段(requestIdleCallback),不跟用户的操作抢主线程;
 *   - **屏幕外而不是 display:none**:隐藏起来的元素没有布局也没有动画,什么都量不到;
 *   - **粒子卡不排队**:53 张全是 canvas 引擎,后台一张张点火代价太大,而且它们本来就
 *     铺满整幅、量出来是 null。它们靠悬停时的像素扫描(contentBox 的 canvasBox)就够。
 */
const SETTLE_MS = 80;
const MAX_MEASURE_MS = 4000;
const GAP_MS = 120;
/** 跟真实时间走的部件(打字机、Lottie)等它长出来的上限 */
const SETTLED_WAIT_MS = 1800;

interface Job {
  key: string;
  /** t:部件按秒计的时间轴位置(卡片用不到) */
  node: (t: number) => React.ReactElement;
  animMs: number;
}

let started = false;
let pending = 0;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function idle(fn: () => void, timeout = 2000) {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout });
  else window.setTimeout(fn, GAP_MS);
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function cardAnimMs(def: CardDef<any>): number {
  try {
    const dyn = def.timing?.(def.defaults)?.settleMs;
    if (typeof dyn === "number" && Number.isFinite(dyn)) return dyn;
  } catch { /* 算炸了按静态值 */ }
  const st = def.lifecycle?.settleMs;
  return typeof st === "number" && Number.isFinite(st) ? st : 1500;
}

function partAnimMs(def: PartDef<any>): number {
  try {
    const v = def.settleMs?.(def.defaults);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch { /* 同上 */ }
  return 1500;
}

function ensureStage(w: number, h: number, themeId: string): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.setAttribute("data-pc", "prewarm");
    container.setAttribute("aria-hidden", "true");
    document.body.appendChild(container);
  }
  container.style.cssText = `position:fixed;left:-20000px;top:0;width:${w}px;height:${h}px;overflow:hidden;pointer-events:none;z-index:-1;`;
  // 主题是一串 CSS 自定义属性,只能一条条 setProperty
  for (const [k, v] of Object.entries(themeStyle(themeId) as Record<string, string>)) {
    if (k.startsWith("--")) container.style.setProperty(k, String(v));
  }
  if (!root) root = createRoot(container);
  return container;
}

async function runJob(job: Job, w: number, h: number, themeId: string) {
  const host = ensureStage(w, h, themeId);
  const total = Math.min(MAX_MEASURE_MS, Math.max(400, job.animMs) + 300);
  root!.render(
    <div className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }}>
      <AnimClock speed={1}>{job.node(total / 1000)}</AnimClock>
    </div>,
  );
  let box: Box | null = null;
  const sample = () => {
    const stage = host.querySelector<HTMLElement>(".pc-stage");
    if (!stage) return;
    try {
      box = unionBox(box, measureAcrossTime(stage, total));
    } catch {
      // 哪张卡渲染炸了都不该拖垮整条队列
    }
  };
  // 量两回:刚挂上去(入场从画外飞进来的那一段靠拨 Web Animations 取到),
  // 再等它跑一会儿(打字机、Lottie 这些跟真实时间走的,拨不动,只能等内容自己长出来)
  await wait(SETTLE_MS);
  sample();
  await wait(Math.min(total, SETTLED_WAIT_MS));
  sample();
  rememberBox(job.key, w, h, box);
  root!.render(null);
  await wait(30);
}

function buildQueue(w: number, h: number, force: boolean): Job[] {
  // force(生成静态表)= 不认静态表,但认本机缓存,重载后能接着量
  const known = knownKeys(w, h, force);
  const jobs: Job[] = [];
  for (const def of allCards()) {
    // 粒子卡不排队:见上面的说明
    if (assetCardKind(def) === "particles") continue;
    const key = `card:${def.id}`;
    if (known.has(key)) continue;
    jobs.push({ key, animMs: cardAnimMs(def), node: () => <def.Component params={def.defaults} playToken={1} /> });
  }
  for (const def of allParts()) {
    const key = `part:${def.id}`;
    if (known.has(key)) continue;
    const parts: PartInstance[] = [
      { id: "preview", partId: def.id, params: { ...def.defaults }, ...(def.defaultFrame ? { frame: { ...def.defaultFrame } } : {}) },
    ];
    jobs.push({ key, animMs: partAnimMs(def), node: (t: number) => <PartTree parts={parts} size={{ width: w, height: h }} t={t} playToken={1} /> });
  }
  return jobs;
}

/**
 * 开始后台补量。重复调用无副作用;无头实例(agent 那份页面)不做这件事。
 * `force` 只给 scripts/preview-boxes.mjs 用:重新量一遍静态表里的东西。
 */
export function startPrewarm(force = false): void {
  if ((started && !force) || typeof document === "undefined") return;
  try {
    if (new URLSearchParams(location.search).has("headless")) return;
  } catch { /* 拿不到就当普通页面 */ }
  started = true;
  const { width, height, themeId } = getState().project;
  const queue = buildQueue(width, height, force);
  pending = queue.length;
  const next = () => {
    const job = queue.shift();
    if (!job) {
      pending = 0;
      root?.render(null);
      return;
    }
    idle(() => {
      void runJob(job, width, height, themeId).finally(() => {
        pending = queue.length;
        next();
      });
    });
  };
  next();
}

/** 给 scripts/preview-boxes.mjs 用:催一遍、看还剩几个、把结果拿走 */
if (typeof window !== "undefined") {
  (window as unknown as { __pcPreviewBoxes?: unknown }).__pcPreviewBoxes = {
    start: (force?: boolean) => startPrewarm(force === true),
    get pending() {
      return pending;
    },
    get started() {
      return started;
    },
    dump: () => {
      const { width, height } = getState().project;
      return dumpBoxes(width, height);
    },
  };
}
