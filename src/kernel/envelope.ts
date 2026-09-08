import type { CardDef, CardPart, CardTiming, ClipFrame } from "./types";
import type { Project, TrackClip } from "./project";
import { findClip } from "./project.ts";
import { worldOf, type Size, type WorldPlacement } from "./layout.ts";
import { validateCardParams } from "./cardParams.ts";

/**
 * 约定封装(clip envelope):一张时间轴上的卡对外唯一的样子。
 *
 * 以前代码页和 Agent 看到的是「原始」的 clip:`{ cardId, start, end, params }` 一坨扁平参数,
 * 位置(frame)、淡入淡出(fadeIn / fadeOut / opacity)、卡片的部件结构和生命周期都不在里面,
 * 于是「动画 3.2 秒就结束了之后干什么」「能不能加淡出」「哪个参数管哪一块」都没处看。
 *
 * 封装把这些收成一份有固定形状的 JSON:
 *   card      —— 这是哪张卡、它的生命周期声明(多久落定、之后停住还是循环、支持什么退场)
 *   time      —— 起止和时长
 *   frame     —— 存下来的局部框(null = 铺满舞台)+ 算出来的画面绝对位置(world,只读)
 *   blend     —— 不透明度、淡入淡出
 *   motion    —— 有没有绑运动轨迹(只读,轨迹本身不在封装里)
 *   parts     —— 部件树:每个部件带它自己的参数值(卡片声明了 parts 才有结构,没声明就一个根)
 *   params    —— 全量参数(和 parts 里的是同一份数据的两种视图)
 *
 * 读:envelopeOf。写:applyEnvelope,只写和当前不一样的部分,顺序固定(换卡 → 参数 → 时段 →
 * 框 → 混合),每一步都走 store 已有的动作,所以撤销栈、脏标记和 Agent 工具的行为完全一致。
 * 素材文件、组件源码都不在封装里 —— Agent 只操作封装,不操作原始代码。
 */

export const ENVELOPE_SCHEMA = "promptcut/clip-envelope@1";

export interface EnvelopePart {
  id: string;
  label: string;
  role?: CardPart["role"];
  enterMs?: number;
  settleMs?: number;
  /** 这个部件自己的参数值(键来自 CardPart.params) */
  params: Record<string, unknown>;
  children?: EnvelopePart[];
}

export interface ClipEnvelope {
  $schema: typeof ENVELOPE_SCHEMA;
  id: string;
  card: {
    id: string;
    name: string;
    source: CardDef["source"];
    lifecycle: { settleMs?: number; after: "hold" | "loop" | "evolve"; exit: ("fade" | "reverse")[] };
  };
  time: { start: number; end: number; duration: number };
  frame: {
    /** 存下来的局部框;null = 铺满舞台 */
    local: ClipFrame | null;
    /** 由 local 算出来的画面绝对位置,只读;写回时忽略 */
    world: WorldPlacement;
  };
  blend: { opacity: number; fadeIn: number; fadeOut: number };
  motion: { attached: boolean; mediaId?: string; whenHidden?: "hold" | "hide" };
  parts: EnvelopePart[];
  params: Record<string, unknown>;
  /** 卡片声明了、clip 里却没有的参数(老 clip 靠默认值兜底渲染) */
  missingParams?: string[];
}

/** 没写 lifecycle 的卡按「有进场动画、之后停住、只支持淡出」处理 */
const DEFAULT_LIFECYCLE: ClipEnvelope["card"]["lifecycle"] = { after: "hold", exit: ["fade"] };

function pick(params: Record<string, unknown>, keys: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys ?? []) if (k in params) out[k] = params[k];
  return out;
}

/**
 * 按当前参数算时序。卡片给了 timing 就用它(参数先和 defaults 合并,和渲染时看到的一样),
 * 没给或算炸了就退回静态声明 —— 时序是辅助信息,不能让它把整份封装拖垮。
 */
function timingOf(card: CardDef<any> | undefined, params: Record<string, unknown>): CardTiming {
  if (!card?.timing) return {};
  try {
    return card.timing({ ...card.defaults, ...params }) ?? {};
  } catch {
    return {};
  }
}

const roundMs = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v));

/** 把卡片声明的部件树填上当前参数值;没声明 parts 的卡就是一个根部件,所有参数都归它 */
function partsOf(card: CardDef<any> | undefined, params: Record<string, unknown>, timing: CardTiming): EnvelopePart[] {
  const fill = (p: CardPart): EnvelopePart => {
    const dyn = timing.parts?.[p.id];
    const enterMs = roundMs(dyn?.enterMs) ?? p.enterMs;
    const settleMs = roundMs(dyn?.settleMs) ?? p.settleMs;
    return {
      id: p.id,
      label: p.label,
      ...(p.role ? { role: p.role } : {}),
      ...(enterMs !== undefined ? { enterMs } : {}),
      ...(settleMs !== undefined ? { settleMs } : {}),
      params: pick(params, p.params),
      ...(p.children?.length ? { children: p.children.map(fill) } : {}),
    };
  };
  if (card?.parts?.length) return card.parts.map(fill);
  return [{ id: "root", label: card?.name ?? "卡片", role: "group", params: { ...params } }];
}

/** 部件树里的参数摊平回一份 params(写回时用:用户改的是部件里的值) */
function flattenParts(parts: EnvelopePart[] | undefined, into: Record<string, unknown>): void {
  for (const p of parts ?? []) {
    if (p.params && typeof p.params === "object") Object.assign(into, p.params);
    flattenParts(p.children, into);
  }
}

export function envelopeOf(project: Project, clip: TrackClip, card: CardDef<any> | undefined, stage: Size): ClipEnvelope {
  const params = { ...(clip.params ?? {}) };
  const missing = (card?.controls ?? []).map((c) => c.key).filter((k) => !(k in params));
  const motion = clip.motion;
  const timing = timingOf(card, params);
  const staticLc = card?.lifecycle ?? DEFAULT_LIFECYCLE;
  const lifecycle = {
    ...staticLc,
    ...(roundMs(timing.settleMs) !== undefined ? { settleMs: roundMs(timing.settleMs) } : {}),
    ...(timing.after ? { after: timing.after } : {}),
  };
  return {
    $schema: ENVELOPE_SCHEMA,
    id: clip.id,
    card: {
      id: clip.cardId,
      name: card?.name ?? clip.cardId,
      source: card?.source ?? "native",
      lifecycle,
    },
    time: { start: clip.start, end: clip.end, duration: round3(clip.end - clip.start) },
    frame: { local: clip.frame ?? null, world: worldOf(clip.frame, stage) },
    blend: { opacity: clip.opacity ?? 1, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 },
    motion: motion ? { attached: true, mediaId: motion.mediaId, whenHidden: motion.whenHidden } : { attached: false },
    parts: partsOf(card, params, timing),
    params,
    ...(missing.length ? { missingParams: missing } : {}),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 写封装要用到的 store 动作。抽成接口是为了能在 node 里单测,不用拉起整个 store */
export interface EnvelopeWriter {
  setClipCard(clipId: string, cardId: string): void;
  setClipParams(clipId: string, params: Record<string, unknown>, opts?: { merge?: boolean }): void;
  moveClip(clipId: string, patch: { start?: number; end?: number }): void;
  setClipFrame(clipId: string, frame: ClipFrame | undefined): void;
  updateClip(clipId: string, patch: { opacity?: number; fadeIn?: number; fadeOut?: number }): void;
}

export interface ApplyReport {
  /** 实际改了哪些段:card / params / time / frame / blend */
  changed: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 允许写进 frame.local 的键;别的键(比如有人把 world 抄进来)直接拒 */
const FRAME_KEYS = new Set(["x", "y", "w", "h", "anchor", "scale", "rotate"]);

function validateFrame(raw: unknown): ClipFrame | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isObj(raw)) throw new Error("frame.local 要是对象或 null(null = 铺满舞台)");
  for (const k of Object.keys(raw)) if (!FRAME_KEYS.has(k)) throw new Error(`frame.local 不认识 "${k}",只有 x / y / w / h / anchor / scale / rotate;world 是算出来的,不能写`);
  if (!isNum(raw.x) || !isNum(raw.y)) throw new Error("frame.local 的 x、y 必须是数字(锚点在舞台上的位置)");
  for (const k of ["w", "h", "scale", "rotate"] as const) {
    if (raw[k] !== undefined && !isNum(raw[k])) throw new Error(`frame.local.${k} 要是数字`);
  }
  if (raw.w !== undefined && (raw.w as number) <= 0) throw new Error("frame.local.w 要大于 0");
  if (raw.h !== undefined && (raw.h as number) <= 0) throw new Error("frame.local.h 要大于 0");
  if (raw.scale !== undefined && (raw.scale as number) <= 0) throw new Error("frame.local.scale 要大于 0");
  if (raw.anchor !== undefined) {
    const a = raw.anchor;
    if (!Array.isArray(a) || a.length !== 2 || !isNum(a[0]) || !isNum(a[1])) throw new Error("frame.local.anchor 要是 [ax, ay] 两个数字,0~1");
  }
  return raw as unknown as ClipFrame;
}

/**
 * 把一份(可能被人改过的)封装写回 clip。
 *
 * 只比较、只写**有差异**的段;不认识的顶层键忽略,只读段(frame.world、motion、card.name…)忽略。
 * 参数以 `params` 为准;如果调用方只改了 `parts` 里的值而没动 `params`,就用部件树摊平的结果。
 * 所有校验在写之前做完,一处不合法整份不写 —— 不留半截状态。
 */
export function applyEnvelope(
  project: Project,
  clipId: string,
  input: unknown,
  card: CardDef<any> | undefined,
  stage: Size,
  writer: EnvelopeWriter,
  findCardById: (id: string) => CardDef<any> | undefined,
): ApplyReport {
  if (!isObj(input)) throw new Error("封装要是一个对象 { ... }");
  const hit = findClip(project, clipId);
  if (!hit) throw new Error(`找不到 clip ${clipId}`);
  const current = envelopeOf(project, hit.clip, card, stage);
  const env = input as Partial<ClipEnvelope> & Record<string, unknown>;
  const changed: string[] = [];

  // ── 1. 校验(全部做完再写)──
  let nextCardId: string | undefined;
  if (isObj(env.card) && env.card.id !== undefined) {
    if (typeof env.card.id !== "string" || !findCardById(env.card.id)) throw new Error(`没有这张卡: ${String(env.card.id)}`);
    if (env.card.id !== current.card.id) nextCardId = env.card.id;
  }

  let nextParams: Record<string, unknown> | undefined;
  if (env.params !== undefined && !isObj(env.params)) throw new Error("params 要是一个对象");
  const fromParams = isObj(env.params) ? env.params : undefined;
  const fromParts: Record<string, unknown> = {};
  if (env.parts !== undefined) {
    if (!Array.isArray(env.parts)) throw new Error("parts 要是数组");
    flattenParts(env.parts as EnvelopePart[], fromParts);
  }
  // params 段没动、parts 段动了 → 以 parts 为准;两边都给了以 params 为准(它是全量视图)
  const paramsSame = fromParams !== undefined && JSON.stringify(fromParams) === JSON.stringify(current.params);
  const candidate = fromParams !== undefined && !paramsSame ? fromParams : Object.keys(fromParts).length ? { ...current.params, ...fromParts } : undefined;
  if (candidate && JSON.stringify(candidate) !== JSON.stringify(current.params)) {
    const targetCard = nextCardId ?? current.card.id;
    // 换卡时旧参数不再适用,按空的算;不换卡时带上已有的,免得「只改一项」被判成漏了必填
    validateCardParams(targetCard, candidate, nextCardId ? undefined : current.params);
    nextParams = candidate;
  } else if (nextCardId) {
    // 换了卡却没给新参数:按新卡的默认值走(validate 会校必填)
    validateCardParams(nextCardId, {}, undefined);
  }

  let nextTime: { start?: number; end?: number } | undefined;
  if (env.time !== undefined) {
    if (!isObj(env.time)) throw new Error("time 要是对象 { start, end }");
    const s = env.time.start !== undefined ? env.time.start : current.time.start;
    const e = env.time.end !== undefined ? env.time.end : current.time.end;
    if (!isNum(s) || !isNum(e) || e <= s) throw new Error("time.start / time.end 要是数字且 end > start(duration 是算出来的,改 end 就行)");
    if (s !== current.time.start || e !== current.time.end) nextTime = { start: s, end: e };
  }

  let nextFrame: { set: boolean; frame: ClipFrame | undefined } | undefined;
  if (env.frame !== undefined) {
    if (!isObj(env.frame)) throw new Error("frame 要是对象 { local, world };只有 local 能写");
    if ("local" in env.frame) {
      const f = validateFrame(env.frame.local);
      if (JSON.stringify(f ?? null) !== JSON.stringify(current.frame.local)) nextFrame = { set: true, frame: f };
    }
  }

  let nextBlend: { opacity?: number; fadeIn?: number; fadeOut?: number } | undefined;
  if (env.blend !== undefined) {
    if (!isObj(env.blend)) throw new Error("blend 要是对象 { opacity, fadeIn, fadeOut }");
    const patch: { opacity?: number; fadeIn?: number; fadeOut?: number } = {};
    for (const k of ["opacity", "fadeIn", "fadeOut"] as const) {
      const v = env.blend[k];
      if (v === undefined) continue;
      if (!isNum(v)) throw new Error(`blend.${k} 要是数字`);
      if (k === "opacity" && (v < 0 || v > 1)) throw new Error(`blend.opacity 是 0~1,收到 ${v}`);
      if (k !== "opacity" && v < 0) throw new Error(`blend.${k} 是秒数,不能为负`);
      if (v !== current.blend[k]) patch[k] = v;
    }
    if (Object.keys(patch).length) nextBlend = patch;
  }

  // ── 2. 写(顺序固定)──
  if (nextCardId) {
    writer.setClipCard(clipId, nextCardId);
    changed.push("card");
  }
  if (nextParams) {
    writer.setClipParams(clipId, nextParams, { merge: false });
    changed.push("params");
  }
  if (nextTime) {
    writer.moveClip(clipId, nextTime);
    changed.push("time");
  }
  if (nextFrame) {
    writer.setClipFrame(clipId, nextFrame.frame);
    changed.push("frame");
  }
  if (nextBlend) {
    writer.updateClip(clipId, nextBlend);
    changed.push("blend");
  }
  return { changed };
}

/** 代码页 / 工具里给人看的一行说明 */
export function describeLifecycle(env: ClipEnvelope): string {
  const lc = env.card.lifecycle;
  const settle = lc.settleMs !== undefined ? `进场约 ${(lc.settleMs / 1000).toFixed(1)}s 落定` : "进场时长不定";
  const after = lc.after === "hold" ? "之后停住" : lc.after === "loop" ? "之后循环" : "之后持续变化";
  const idle = lc.settleMs !== undefined && lc.after === "hold" ? Math.max(0, env.time.duration - lc.settleMs / 1000) : null;
  const idleNote = idle !== null && idle > 0.5 ? `;这段 clip 有 ${idle.toFixed(1)}s 是静止的` : "";
  return `${settle},${after},退场:${lc.exit.join("/") || "无"}${idleNote}`;
}
