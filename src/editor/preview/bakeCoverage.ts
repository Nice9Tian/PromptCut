/**
 * 「时间轴上哪几段已经预渲染好了」—— 算给那条绿条用的(像 AE 顶上那条)。
 *
 * # 一个烘好的时刻覆盖的是一小段,不是一个点
 *
 * 预烘是按**时刻**烘的(哪几个时刻由 bakeTime.ts 的 sampleTimesFor 定),而播放头落在
 * 两个时刻之间时,显示的是**往回取**的那一个(pickBakeT 用 floor)。所以烘好 t_i 那一张,
 * 等于 `[t_i, t_{i+1})` 这一整段都有图可显示 —— 最后一个时刻一直管到这张卡结束。
 *
 * 这也是绿条唯一诚实的画法:绿的地方拖过去一定立刻有画面,不绿的地方一定要等。
 * 按「烘好几张 / 一共几张」画个百分比进度条就做不到这一点 —— 那种条能显示 90%,
 * 而用户偏偏拖到了剩下那 10% 里,一样要干等五秒,条却是绿的。
 *
 * # 为什么不按 clip 整段算
 *
 * 一张卡有十来个时刻,烘到一半时它**前半段能看、后半段不能**。整段涂绿会骗人,
 * 整段留白又埋没了已经烘好的部分。所以按时刻切段,一段一段涂。
 */

export interface CoverageSegment {
  start: number;
  end: number;
}

/** 浮点比较的容差:时刻是 0.25 秒一格累加出来的,末位会有误差 */
const EPS = 1e-6;

export interface CoverageInput {
  clipId: string;
  /** 这一刻的缓存键。判断「烘了没」要用它,所以这里也带上 */
  key?: string;
  /** 属于哪一档(低帧率 / 原始帧率)。分开画黄绿两条 */
  tier?: "coarse" | "full";
  /** 是否落在原始帧率的格子上 */
  fine?: boolean;
  /** 这一刻烘出来的图代表哪个瞬间(时间轴绝对秒) */
  t: number;
  /** 这张卡的区间 —— 最后一个时刻要一直管到 end */
  start: number;
  end: number;
}

/**
 * 已经烘好的那些时刻,在时间轴上覆盖了哪几段。
 *
 * `isBaked` 由调用方给:预烘那边知道哪些键已经落盘了。
 * 返回的段按时间排好,并且**相邻的合并过** —— 不合并的话一张卡会画出十几条挨着的小绿块,
 * 每块之间一道缝,看着像"烘得断断续续",其实是连续的。
 */
export function coverageSegments(
  moments: CoverageInput[],
  isBaked: (m: CoverageInput) => boolean,
): CoverageSegment[] {
  // 按卡分组:一个时刻能管到哪儿,取决于**同一张卡里**的下一个时刻,不能跨卡去找
  const byClip = new Map<string, CoverageInput[]>();
  for (const m of moments) {
    const list = byClip.get(m.clipId);
    if (list) list.push(m);
    else byClip.set(m.clipId, [m]);
  }

  const raw: CoverageSegment[] = [];
  for (const list of byClip.values()) {
    const sorted = [...list].sort((a, b) => a.t - b.t);
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      if (!isBaked(m)) continue;
      const next = sorted[i + 1];
      // 管到下一个时刻为止;它是这张卡的最后一个,就一直管到卡结束
      const end = next ? Math.min(next.t, m.end) : m.end;
      const start = Math.max(m.start, m.t);
      if (end > start + EPS) raw.push({ start, end });
    }
  }

  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CoverageSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    // 挨着(或重叠)就并成一段,免得画出一排带缝的小绿块
    if (last && seg.start <= last.end + EPS) last.end = Math.max(last.end, seg.end);
    else merged.push({ ...seg });
  }
  return merged;
}

/**
 * 进度条要显示的全部信息。**两档分开**:
 *
 * coarse(黄)—— 低帧率那一档。拖过去立刻有画面,但看到的那一刻最多和播放头差 0.25 秒。
 * full(绿)—— 原始帧率那一档。那一段是逐帧精确的。
 *
 * 两档分开画而不是合成一个百分比,是因为它们对用户的意义完全不同:
 * 黄的地方"能看但不准",绿的地方"就是这一帧"。合成一条就把这个区别抹掉了。
 */
export interface BakeCoverage {
  /** 低帧率已覆盖的段(黄) */
  coarse: CoverageSegment[];
  /** 原始帧率已覆盖的段(绿)。它总是落在 coarse 之内 */
  full: CoverageSegment[];
  coarseBaked: number;
  coarseTotal: number;
  fullBaked: number;
  fullTotal: number;
  /** 正在烘的那一刻(时间轴绝对秒);没在烘就是 null */
  bakingAt: number | null;
  /** 已经占了多少磁盘(字节,实测值) */
  bytes: number;
}

const EMPTY: BakeCoverage = {
  coarse: [], full: [], coarseBaked: 0, coarseTotal: 0, fullBaked: 0, fullTotal: 0,
  bakingAt: null, bytes: 0,
};

/*
 * 模块级的小仓库:预烘那边写,时间轴那边读。
 *
 * 走模块级而不是 React context,是因为这两处在组件树上离得很远(预烘挂在预览面板的 3D 页里,
 * 绿条在时间轴顶上),中间那一整条链路没有一个组件需要这个值 —— 穿过去只会让沿途每个组件
 * 都多一个用不上的 prop 或者多一次重渲染。
 *
 * 值留在模块里还有个好处:从 3D 页切回 2D 页,预烘停了,但**已经烘到哪儿的信息还在**,
 * 绿条不会因为切了个页就整条清空。
 */
let current: BakeCoverage = EMPTY;
const listeners = new Set<() => void>();

export function publishCoverage(next: BakeCoverage): void {
  current = next;
  for (const fn of listeners) fn();
}

/** useSyncExternalStore 要的那两个:订阅 + 取快照 */
export function subscribeCoverage(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 取当前值。**必须返回同一个引用**(除非真的变了)—— useSyncExternalStore 每次渲染都会
 * 调它并和上次比引用,这里要是每次新建一个对象,React 会判定"变了"从而无限重渲染。
 */
export function getCoverage(): BakeCoverage {
  return current;
}

