/**
 * 场景图的坐标换算:局部框 ⇄ 画面绝对位置,以及 Stage 要的 CSS。
 *
 * 原则只有一条:**只存局部坐标(ClipFrame),世界坐标永远由这里推导,不落盘。**
 * Agent 设世界坐标时,这里反解成局部存下来;设局部时,世界自动跟着变。
 * 两个都存的话早晚漂掉,谁都说不清哪个是真的。
 *
 * 卡片级的父坐标系就是舞台(原点左上角),所以现在 world == local,反解是恒等;
 * 函数签名都按「父框 → 子框」写,将来部件级(卡片内部的 title / rows …)接进来时
 * 只是多递归一层,接口不用动。
 *
 * ⚠ 一个必须写进工具说明的坑:设世界坐标 ≠ 钉在屏幕上。反解出来存的是局部,
 * 之后父节点一动,子节点跟着走(标题理应跟着卡片走)。要"不管父节点怎么动都钉在
 * 屏幕这儿",是另一个意图(pin / 摘出组),不是这条路。
 */
import type { CSSProperties } from "react";
import type { ClipFrame } from "./types";

export interface Size {
  width: number;
  height: number;
}

/** 父坐标系里的矩形(缩放旋转之前) */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** ClipFrame 补全默认值之后的形状 */
export interface FrameResolved {
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: [number, number];
  scale: number;
  rotate: number;
}

/** 补全默认值:没有 frame = 铺满父坐标系 */
export function resolveFrame(frame: ClipFrame | undefined, parent: Size): FrameResolved {
  return {
    x: frame?.x ?? 0,
    y: frame?.y ?? 0,
    w: frame?.w ?? parent.width,
    h: frame?.h ?? parent.height,
    anchor: frame?.anchor ?? [0, 0],
    scale: frame?.scale ?? 1,
    rotate: frame?.rotate ?? 0,
  };
}

/** 框在父坐标系里的矩形:锚点在 (x,y),左上角 = (x,y) 减去锚点在框内的偏移 */
export function frameBox(frame: ClipFrame | undefined, parent: Size): Box {
  const f = resolveFrame(frame, parent);
  return { left: f.x - f.anchor[0] * f.w, top: f.y - f.anchor[1] * f.h, width: f.w, height: f.h };
}

/** 一个节点在世界坐标系里的描述(get_layout 返回的 world 部分) */
export interface WorldPlacement {
  /** 锚点的世界坐标 */
  x: number;
  y: number;
  anchor: [number, number];
  w: number;
  h: number;
  scale: number;
  rotate: number;
  /** 世界坐标系里的矩形(缩放旋转之前,即画布) */
  box: Box;
  /** 缩放旋转**之后**的外接矩形。判断遮挡、贴边、会不会出画,看这个,不是 box */
  visualBox: Box;
}

/**
 * 缩放 + 旋转之后的外接矩形(AABB)。
 * scale 是均匀的,和 rotate 可交换,所以不用管 CSS transform 列表的顺序;两者都绕锚点。
 */
export function visualBox(frame: ClipFrame | undefined, parent: Size): Box {
  const f = resolveFrame(frame, parent);
  const b = frameBox(frame, parent);
  const rad = (f.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: [number, number][] = [
    [b.left, b.top], [b.left + b.width, b.top], [b.left, b.top + b.height], [b.left + b.width, b.top + b.height],
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of corners) {
    const dx = (cx - f.x) * f.scale;
    const dy = (cy - f.y) * f.scale;
    const rx = f.x + dx * cos - dy * sin;
    const ry = f.y + dx * sin + dy * cos;
    x0 = Math.min(x0, rx); y0 = Math.min(y0, ry); x1 = Math.max(x1, rx); y1 = Math.max(y1, ry);
  }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * 局部框 → 世界描述。卡片级:父 = 舞台,原点重合,所以就是把 frame 补全再算两个矩形。
 * 部件级接进来时这里改成:parentWorld 的 box.left/top 加上局部 x,y,scale 相乘。
 */
export function worldOf(frame: ClipFrame | undefined, parent: Size): WorldPlacement {
  const f = resolveFrame(frame, parent);
  return { ...f, box: frameBox(frame, parent), visualBox: visualBox(frame, parent) };
}

/**
 * 世界坐标 → 局部坐标(只换算传了的字段)。卡片级恒等;签名留着是为了部件级。
 * 传进来的 x,y 是「锚点的世界坐标」,和存下来的语义一致,所以不需要知道尺寸。
 */
export function localFromWorld(world: Partial<ClipFrame>, _parent: Size): Partial<ClipFrame> {
  return { ...world };
}

/** set_position 的入参 */
export interface PositionArgs {
  space?: "world" | "local";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  anchor?: [number, number];
  scale?: number;
  rotate?: number;
}

/**
 * 把 set_position 的入参变成要合并进 frame 的补丁:校验数值、按 space 换算。
 * 只返回传了的字段 —— 调用方 { ...prev, ...patch } 合并,没传的保留。
 * 校验不过就 throw,错误信息给 Agent 看,所以说人话。
 */
export function framePatchFromArgs(args: PositionArgs, parent: Size): Partial<ClipFrame> {
  const out: Partial<ClipFrame> = {};
  const num = (k: keyof PositionArgs, v: unknown, check?: (n: number) => string | null) => {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(v)}`);
    const bad = check?.(v);
    if (bad) throw new Error(bad);
    (out as Record<string, unknown>)[k] = v;
  };
  num("x", args.x);
  num("y", args.y);
  num("w", args.w, (n) => (n > 0 ? null : `w 必须大于 0,收到 ${n}`));
  num("h", args.h, (n) => (n > 0 ? null : `h 必须大于 0,收到 ${n}`));
  num("scale", args.scale, (n) => (n > 0 ? null : `scale 必须大于 0,收到 ${n};要隐藏卡片用 remove_clip 或 opacity,不要缩到 0`));
  num("rotate", args.rotate);
  if (args.anchor !== undefined) {
    const a = args.anchor;
    if (!Array.isArray(a) || a.length !== 2 || !a.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error(`anchor 必须是两个数字 [ax, ay],例如 [0.5, 0.5] 表示中心,收到 ${JSON.stringify(a)}`);
    }
    out.anchor = [a[0], a[1]];
  }
  if (Object.keys(out).length === 0) {
    throw new Error("set_position 至少要传 x / y / w / h / anchor / scale / rotate 中的一项,或 clear:true");
  }
  return args.space === "world" ? localFromWorld(out, parent) : out;
}

/**
 * Stage 要的样式。
 *
 * 没有 frame 时**原样**输出以前那套(inset:0 + 可选的轨迹平移),一个字节都不变 ——
 * 老项目的导出结果有逐像素基线在,这里不冒险。有 frame 时才走 left/top/width/height
 * 那条路,transform 按「轨迹平移 → 缩放 → 旋转」的顺序合成,绕锚点。
 * 恒等的 scale / rotate 不写进 transform:即使是 scale(1),transform 属性的存在
 * 本身也可能让合成器换一条光栅路径。
 */
export function frameCss(frame: ClipFrame | undefined, parent: Size, translate?: { dx: number; dy: number }): CSSProperties {
  const parts: string[] = [];
  if (translate) parts.push(`translate(${translate.dx}px, ${translate.dy}px)`);
  if (!frame) {
    return {
      position: "absolute",
      inset: 0,
      ...(parts.length ? { transform: parts.join(" "), willChange: "transform" } : null),
    };
  }
  const f = resolveFrame(frame, parent);
  const box = frameBox(frame, parent);
  if (f.scale !== 1) parts.push(`scale(${f.scale})`);
  if (f.rotate !== 0) parts.push(`rotate(${f.rotate}deg)`);
  return {
    position: "absolute",
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    transformOrigin: `${f.anchor[0] * 100}% ${f.anchor[1] * 100}%`,
    ...(parts.length ? { transform: parts.join(" ") } : null),
    ...(translate ? { willChange: "transform" } : null),
  };
}

/* ------------------------------------------------------------------------------------------
 * 下面是 Agent 的另外几种说法 —— 矩形、对齐、微调。它们都只是把话换算成同一个 ClipFrame,
 * 存的东西没有第二种。
 * ---------------------------------------------------------------------------------------- */

/** 两个对角点,顺序随意 */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function normRect(r: Rect): Box {
  for (const k of ["x1", "y1", "x2", "y2"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k])) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(r[k])}`);
  }
  const box = { left: Math.min(r.x1, r.x2), top: Math.min(r.y1, r.y2), width: Math.abs(r.x2 - r.x1), height: Math.abs(r.y2 - r.y1) };
  if (!(box.width > 0 && box.height > 0)) throw new Error(`矩形必须有正的宽高,收到 x1=${r.x1} y1=${r.y1} x2=${r.x2} y2=${r.y2}`);
  return box;
}

function checkAlign(a: unknown, name: string): [number, number] {
  if (!Array.isArray(a) || a.length !== 2 || !a.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`${name} 必须是两个数字 [ax, ay],例如 [0.5, 0.5] 表示中心,收到 ${JSON.stringify(a)}`);
  }
  return [a[0], a[1]];
}

/**
 * 把卡片放进一个矩形。
 *   fit(默认):画布尺寸不动,整体缩放到刚好装进矩形(保持比例),按 align 对齐在矩形里。
 *     大多数卡按 1920×1080 设计,"放进左半屏"该做的就是这个 —— 缩放后内容一定在矩形内。
 *   canvas:画布就是这个矩形(w/h = 矩形尺寸,scale 归 1)。内容按卡片自己的规则在新画布里
 *     布局,可能溢出(rank-bars 自带 min-w 1000px,放进 960 宽的画布就会露出去)。
 * 两种都不碰 rotate;fit 的"装进去"不考虑旋转后的外接框。
 */
export function rectToFrame(
  rect: Rect,
  opts: { mode?: "fit" | "canvas"; align?: [number, number] },
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  const r = normRect(rect);
  const align = opts.align === undefined ? ([0.5, 0.5] as [number, number]) : checkAlign(opts.align, "align");
  const mode = opts.mode ?? "fit";
  if (mode !== "fit" && mode !== "canvas") throw new Error(`mode 只能是 fit 或 canvas,收到 ${JSON.stringify(mode)}`);
  const x = r.left + align[0] * r.width;
  const y = r.top + align[1] * r.height;
  if (mode === "canvas") {
    return { ...prev, x, y, w: r.width, h: r.height, anchor: align, scale: 1 };
  }
  const p = resolveFrame(prev, parent);
  const scale = Math.min(r.width / p.w, r.height / p.h);
  return { ...prev, x, y, w: p.w, h: p.h, anchor: align, scale };
}

export type AlignH = "left" | "center" | "right";
export type AlignV = "top" | "center" | "bottom";

/**
 * 对齐到父坐标系的边或中心,带边距。锚点跟着对齐方式走(靠右就把锚点放到右边),
 * 缩放绕锚点,所以缩放后的可见框也贴在同一条边上。旋转会让角伸出去,不管。
 * 只传 h 或只传 v 时另一个方向保持不动。
 */
export function alignToFrame(
  h: AlignH | undefined,
  v: AlignV | undefined,
  margin: number,
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  if (h === undefined && v === undefined) throw new Error("align 至少要传 h(left/center/right)或 v(top/center/bottom)中的一个");
  if (h !== undefined && !["left", "center", "right"].includes(h)) throw new Error(`h 只能是 left / center / right,收到 ${JSON.stringify(h)}`);
  if (v !== undefined && !["top", "center", "bottom"].includes(v)) throw new Error(`v 只能是 top / center / bottom,收到 ${JSON.stringify(v)}`);
  if (typeof margin !== "number" || !Number.isFinite(margin)) throw new Error(`margin 必须是有限数字,收到 ${JSON.stringify(margin)}`);
  const p = resolveFrame(prev, parent);
  const ax = h === "left" ? 0 : h === "right" ? 1 : h === "center" ? 0.5 : p.anchor[0];
  const ay = v === "top" ? 0 : v === "bottom" ? 1 : v === "center" ? 0.5 : p.anchor[1];
  const x = h === "left" ? margin : h === "right" ? parent.width - margin : h === "center" ? parent.width / 2 : p.x;
  const y = v === "top" ? margin : v === "bottom" ? parent.height - margin : v === "center" ? parent.height / 2 : p.y;
  return { ...prev, x, y, anchor: [ax, ay] };
}

/**
 * 铺满舞台、又没缩小的卡片,对齐是看不出效果的:画布本来就和舞台一样大,贴哪条边都一样。
 * 给 align 的返回加一句提醒用。
 */
export function alignIsInvisible(frame: ClipFrame | undefined, parent: Size): boolean {
  const f = resolveFrame(frame, parent);
  return f.w >= parent.width && f.h >= parent.height && f.scale >= 1;
}

/**
 * 把框夹回父坐标系里:可见框(缩放旋转后)超出哪条边就往回挪多少。
 * 比父坐标系还大的框夹不回来,原样返回 —— 那是 scale 的事,不是位置的事。
 * 给 nudge / set_position 的 clamp 用:「再往右 300」不该把卡推出屏幕。
 */
export function clampToStage(frame: ClipFrame | undefined, parent: Size): ClipFrame {
  const f = resolveFrame(frame, parent);
  const vb = visualBox(frame, parent);
  let dx = 0;
  let dy = 0;
  if (vb.width <= parent.width) {
    if (vb.left < 0) dx = -vb.left;
    else if (vb.left + vb.width > parent.width) dx = parent.width - (vb.left + vb.width);
  }
  if (vb.height <= parent.height) {
    if (vb.top < 0) dy = -vb.top;
    else if (vb.top + vb.height > parent.height) dy = parent.height - (vb.top + vb.height);
  }
  if (dx === 0 && dy === 0) return { ...frame, x: f.x, y: f.y };
  return { ...frame, x: f.x + dx, y: f.y + dy };
}

export type SafeSide = "left" | "right" | "top" | "bottom";

/**
 * 主体检测说「这一侧是空的」→ 一个能直接喂给 set_rect 的矩形。
 * left/right 是半屏,top/bottom 是 1/3 带(和主体检测算 occupancy 用的分区一致),四周留 margin。
 */
export function rectForSafeSide(side: SafeSide, parent: Size, margin = 40): Rect {
  const W = parent.width, H = parent.height;
  switch (side) {
    case "left": return { x1: margin, y1: margin, x2: W / 2 - margin, y2: H - margin };
    case "right": return { x1: W / 2 + margin, y1: margin, x2: W - margin, y2: H - margin };
    case "top": return { x1: margin, y1: margin, x2: W - margin, y2: H / 3 - margin };
    case "bottom": return { x1: margin, y1: (H * 2) / 3 + margin, x2: W - margin, y2: H - margin };
    default: throw new Error(`safeSide 只能是 left / right / top / bottom,收到 ${JSON.stringify(side)}`);
  }
}

/** 在现有基础上加减:位置加像素,缩放乘倍数,旋转加角度 */
export function nudgeFrame(
  d: { dx?: number; dy?: number; scaleBy?: number; rotateBy?: number },
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  for (const k of ["dx", "dy", "scaleBy", "rotateBy"] as const) {
    const v = d[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`${k} 必须是有限数字,收到 ${JSON.stringify(v)}`);
  }
  if (d.scaleBy !== undefined && !(d.scaleBy > 0)) throw new Error(`scaleBy 是倍数,必须大于 0(0.5 = 缩到一半,2 = 放大一倍),收到 ${d.scaleBy}`);
  if (d.dx === undefined && d.dy === undefined && d.scaleBy === undefined && d.rotateBy === undefined) {
    throw new Error("nudge 至少要传 dx / dy / scaleBy / rotateBy 中的一项");
  }
  const p = resolveFrame(prev, parent);
  return {
    ...prev,
    x: p.x + (d.dx ?? 0),
    y: p.y + (d.dy ?? 0),
    ...(d.scaleBy !== undefined ? { scale: p.scale * d.scaleBy } : null),
    ...(d.rotateBy !== undefined ? { rotate: p.rotate + d.rotateBy } : null),
  };
}
