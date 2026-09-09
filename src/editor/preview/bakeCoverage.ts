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

/**
 * 一刻的标识:`<clipId>@<t>`。
 *
 * **判断「烘了没」用它,不用服务端那个缓存键。** 前台现烘和空闲预烘走的是两条路,
 * 前台手上只有 (clipId, t),没有服务端算的哈希;两条路要是各用各的键,前台烘完了
 * 覆盖表也认不出来 —— 表现就是「画面已经出来了,时间轴上的条还没变」。
 */
export const momentId = (clipId: string, t: number) => `${clipId}@${t}`;

export interface CoverageInput {
  clipId: string;
  /** 这一刻的标识(momentId)。覆盖表按它记「烘了没」 */
  id?: string;
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

  return mergeSegments(raw);
}

/**
 * 把挨着或重叠的段并起来。不合并的话一张卡会画出十几条挨着的小块,每块之间一道缝,
 * 看着像「烘得断断续续」,其实是连续的。
 *
 * 单独导出是因为**画的时候还要再合一次**:覆盖是按卡分开存的(见 ClipCoverage),
 * 而首尾相接的两张卡各自的段应该连成一条。
 */
export function mergeSegments(segs: CoverageSegment[]): CoverageSegment[] {
  const raw = [...segs].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CoverageSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
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
/**
 * 一张卡的覆盖情况。**带着这张卡当时的内容指纹**。
 *
 * 分卡存 + 带指纹,是为了「改了 A,A 那一段立刻变白」这件事能**不依赖任何异步**:
 * 画条子的时候拿当前项目的指纹对一遍,对不上的直接不画。用户一改参数,store 里的
 * project 就换了,条子这一帧就把 A 抹掉了 —— 不用等盘点、不用等烘焙、也不会有竞态。
 *
 * 之前是把所有卡合成一条整段存的,于是**只有预烘循环能更新它**,而那个循环要等
 * 当前这批烘完、再盘点一次才轮得到发布。结果就是「改完卡片,条子纹丝不动」。
 */
export interface ClipCoverage {
  clipId: string;
  /** 这张卡当时长什么样(clipFingerprint)。和当前项目对不上就说明它已经作废了 */
  fp: string;
  /** 这张卡要烘的全部时刻 */
  moments: CoverageInput[];
}

/**
 * 覆盖表存的是**事实**(有哪些时刻、哪些已经烘好),段落是画的时候现算的。
 *
 * 这样安排是因为「烘好了」这件事有两个来源:空闲预烘,和用户正盯着时前台的现烘。
 * 存算好的段的话,只有预烘那条路能更新它 —— 前台烘完,画面出来了,条子还得等下一轮
 * 盘点才变。存事实就没这问题:哪条路烘完都只是往 `baked` 里加一个 id,条子当帧就重算。
 */
export interface BakeCoverage {
  /** 按卡分开存,画的时候按指纹过滤 */
  clips: ClipCoverage[];
  /** 已经烘好的那些时刻(momentId)。两条烘焙路径共用这一个集合 */
  baked: Set<string>;
  /** 正在烘的那一刻(时间轴绝对秒);没在烘就是 null */
  bakingAt: number | null;
  /** 已经占了多少磁盘(字节,实测值) */
  bytes: number;
}

const EMPTY: BakeCoverage = { clips: [], baked: new Set(), bakingAt: null, bytes: 0 };

/**
 * 一张卡「长什么样」的指纹 —— 只带**决定像素**的东西。
 *
 * 这一份是**唯一**的算法:Scene3DView 判断要不要重建场景用它,进度条判断某段覆盖
 * 是不是过期了也用它。两处各写一套的话,会出现「条子认为还有效、画面已经换了」这种
 * 对不上的状态,而且不报错。
 *
 * 位置和三维变换不进指纹:服务端烘的时候会把 frame 整个摘掉(见 bakeTarget),
 * 转一下卡、推一下深度,像素一个都不变。
 */
export function clipFingerprint(c: {
  id: string; cardId: string; params?: unknown; frame?: { w?: number; h?: number } | null;
}): string {
  return [c.id, c.cardId, JSON.stringify(c.params ?? {}), `${c.frame?.w ?? "-"}x${c.frame?.h ?? "-"}`].join("|");
}

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


/** 进度条真正要画的东西:过滤掉作废的卡之后,跨卡合并出来的段和计数 */
export interface VisibleCoverage {
  coarse: CoverageSegment[];
  full: CoverageSegment[];
  coarseBaked: number;
  coarseTotal: number;
  fullBaked: number;
  fullTotal: number;
  /** 有多少张卡的覆盖已经作废(刚改过参数,还没重烘) */
  stale: number;
}

/**
 * 拿**当前项目**的指纹过一遍覆盖,只留还算数的,再跨卡合并。
 *
 * 这是「改了 A,A 那一段当帧就变白」的全部机制:指纹对不上就不画。
 * 它是个纯函数,所以这条行为可以单测 —— 而它要是错了,界面上的表现是
 * 「条子显示绿的,拖过去却要等五秒」,属于会骗人的那一类,必须钉住。
 */
export function visibleCoverage(cov: BakeCoverage, liveFingerprints: Set<string>): VisibleCoverage {
  const live = cov.clips.filter((c) => liveFingerprints.has(c.fp));
  const isBaked = (m: CoverageInput) => !!m.id && cov.baked.has(m.id);
  const coarseM: CoverageInput[] = [];
  const fineM: CoverageInput[] = [];
  for (const c of live) {
    for (const m of c.moments) {
      if ((m.tier ?? "coarse") === "coarse") coarseM.push(m);
      // 绿用 fine 而不是 tier:0.5 秒这类点两档都落在上面,排队时算低帧率,
      // 但它同样是逐帧那一档的一格 —— 漏掉它绿条会每隔半秒缺一块
      if (m.fine) fineM.push(m);
    }
  }
  return {
    coarse: coverageSegments(coarseM, isBaked),
    full: coverageSegments(fineM, isBaked),
    coarseBaked: coarseM.filter(isBaked).length,
    coarseTotal: coarseM.length,
    fullBaked: fineM.filter(isBaked).length,
    fullTotal: fineM.length,
    stale: cov.clips.length - live.length,
  };
}

/**
 * 记下「这一刻烘好了」。**前台现烘完也要调这个** —— 不调的话画面已经换成真图了,
 * 时间轴上那一段还是空的,要等下一轮盘点才补上,看起来就是条子慢半拍。
 *
 * 只加不算段:段是画的时候现算的,所以这里 O(1) 就够,每烘完一张调一次不心疼。
 */
export function markBaked(ids: string[]): void {
  const add = ids.filter((id) => !current.baked.has(id));
  if (!add.length) return;
  const baked = new Set(current.baked);
  for (const id of add) baked.add(id);
  publishCoverage({ ...current, baked });
}
