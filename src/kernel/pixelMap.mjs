/**
 * 通用像素映射的纯内核。
 *
 * 这里故意不接 DOM、Canvas 或 ffmpeg：定义和表达式在编辑器、see_frames、导出
 * 之间共用，具体渲染器只需要调用 mapRgba。表达式复用滤镜里的安全解析器，绝不
 * 使用 eval / Function。
 */
import { compiledOf, FilterExprError } from "./filters.mjs";

export const PIXEL_MAP_MODES = ["continuous", "discrete"];
export const PIXEL_MAP_STAGES = ["origin", "after_filters"];
export const MAX_PIXEL_MAPS = 16;
export const MAX_SEQUENCE = 64;
const PIXEL_VARS = ["r", "g", "b", "a", "luma", "x", "y", "t"];
const HEX = /^#([0-9a-f]{3,8})$/i;

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const str = (v) => typeof v === "string" ? v.trim() : "";

export function parseColor(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  const m = HEX.exec(s);
  if (!m) {
    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
    if (!rgb) return null;
    return [clamp01(Number(rgb[1]) / 255), clamp01(Number(rgb[2]) / 255), clamp01(Number(rgb[3]) / 255), rgb[4] == null ? 1 : clamp01(Number(rgb[4]))];
  }
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  if (h.length !== 8) return null;
  return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function sourceOf(raw, label) {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value.toLowerCase() === "transparent") return { kind: "transparent" };
    if (parseColor(value)) return { kind: "color", value };
    if (value) return { kind: "media", mediaId: value, stage: "origin" };
  }
  if (!raw || typeof raw !== "object") throw new FilterExprError(`${label} 要是素材、颜色、transparent 或表达式对象`);
  const stage = raw.stage ?? "origin";
  if (!PIXEL_MAP_STAGES.includes(stage)) throw new FilterExprError(`${label}.stage 只能是 origin 或 after_filters`);
  if (typeof raw.mediaId === "string" && raw.mediaId.trim()) return { kind: "media", mediaId: raw.mediaId.trim(), stage, ...(raw.filterId ? { filterId: String(raw.filterId) } : null) };
  if (typeof raw.value === "string") {
    if (raw.value.trim().toLowerCase() === "transparent") return { kind: "transparent" };
    if (parseColor(raw.value)) return { kind: "color", value: raw.value.trim() };
  }
  if (raw.kind === "media" && typeof raw.mediaId === "string") return { kind: "media", mediaId: raw.mediaId.trim(), stage, ...(raw.filterId ? { filterId: String(raw.filterId) } : null) };
  if (raw.kind === "color" && parseColor(raw.color ?? raw.value)) return { kind: "color", value: String(raw.color ?? raw.value).trim() };
  if (raw.kind === "transparent") return { kind: "transparent" };
  if (raw.kind === "expr" || ["r", "g", "b"].some((k) => typeof raw[k] === "string" || typeof raw[k] === "number")) {
    const out = { kind: "expr", r: raw.r ?? "r", g: raw.g ?? "g", b: raw.b ?? "b", a: raw.a ?? "a" };
    for (const k of ["r", "g", "b", "a"]) {
      if (typeof out[k] === "number") continue;
      if (typeof out[k] !== "string" || !out[k].trim()) throw new FilterExprError(`${label}.${k} 要是表达式`);
      try { compiledOf(out[k].trim(), PIXEL_VARS); } catch (e) { throw new FilterExprError(`${label}.${k} 表达式有问题:${e.message}`); }
    }
    return out;
  }
  throw new FilterExprError(`${label} 写法不认识`);
}

function sequenceOf(raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEQUENCE) throw new FilterExprError(`colorSequence 要是 1~${MAX_SEQUENCE} 个颜色`);
  const out = raw.map((v, i) => {
    const c = parseColor(v);
    if (!c) throw new FilterExprError(`colorSequence[${i}] 不是颜色`);
    return String(v).trim();
  });
  return out;
}

export function normalizePixelMapDef(input) {
  if (!input || typeof input !== "object") throw new FilterExprError("像素映射定义要是一个对象");
  const name = str(input.name);
  if (!name || name.length > 40) throw new FilterExprError("name 必填,40 字以内");
  const where = str(input.where);
  if (!where) throw new FilterExprError("where 必填:用 r/g/b/a/luma/x/y/t 写选区权重");
  try { compiledOf(where, PIXEL_VARS); } catch (e) { throw new FilterExprError(`where 表达式有问题:${e.message}`); }
  const source = input.source == null ? { stage: "origin" } : input.source;
  if (!source || typeof source !== "object") throw new FilterExprError("source 要是对象");
  const stage = source.stage ?? "origin";
  if (!PIXEL_MAP_STAGES.includes(stage)) throw new FilterExprError("source.stage 只能是 origin 或 after_filters");
  const to = input.to == null && input.colorSequence?.to?.length
    ? { kind: "color", value: String(input.colorSequence.to[input.colorSequence.to.length - 1]) }
    : sourceOf(input.to, "to");
  const mode = input.mode ?? "continuous";
  if (!PIXEL_MAP_MODES.includes(mode)) throw new FilterExprError("mode 只能是 continuous 或 discrete");
  const from = sequenceOf(input.colorSequence?.from);
  const seqTo = sequenceOf(input.colorSequence?.to);
  if ((from && !seqTo) || (!from && seqTo)) throw new FilterExprError("colorSequence 要同时提供 from 和 to");
  if (from && seqTo && to.kind !== "color") throw new FilterExprError("colorSequence 不需要 to,或 to 只能留空");
  return {
    name,
    ...(str(input.description) ? { description: str(input.description).slice(0, 200) } : null),
    source: { stage, ...(source.mediaId ? { mediaId: String(source.mediaId), ...(source.filterId ? { filterId: String(source.filterId) } : null) } : null) },
    where,
    to,
    mode,
    ...(from ? { colorSequence: { from, to: seqTo, mode } } : null),
  };
}

export function compilePixelMap(def) {
  const where = compiledOf(def.where, PIXEL_VARS).fn;
  const to = def.to?.kind === "expr" ? Object.fromEntries(["r", "g", "b", "a"].map((k) => [k, typeof def.to[k] === "number" ? () => def.to[k] : compiledOf(def.to[k], PIXEL_VARS).fn])) : null;
  const seqFrom = def.colorSequence?.from?.map(parseColor);
  const seqTo = def.colorSequence?.to?.map(parseColor);
  return { where, to, seqFrom, seqTo };
}

const compiledCache = new WeakMap();
function compiledCached(def) {
  if (!def || typeof def !== "object") return compilePixelMap(def);
  let hit = compiledCache.get(def);
  if (!hit) { hit = compilePixelMap(def); compiledCache.set(def, hit); }
  return hit;
}

function sequenceTarget(rgba, seqFrom, seqTo, mode) {
  if (!seqFrom?.length || !seqTo?.length) return null;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < seqFrom.length; i++) { const d = dist(rgba, seqFrom[i]); if (d < best) { best = d; idx = i; } }
  if (mode === "discrete" || seqTo.length === 1) return seqTo[Math.min(idx, seqTo.length - 1)];
  const p = seqFrom.length === 1 ? 0 : idx / (seqFrom.length - 1);
  const q = p * (seqTo.length - 1);
  const i = Math.min(seqTo.length - 2, Math.max(0, Math.floor(q)));
  const f = q - i;
  return seqTo[i].map((v, k) => v + (seqTo[i + 1][k] - v) * f);
}

/** 将一个 0~1 RGBA 像素映射成新像素。媒体目标由渲染器提供 targetRgba。 */
export function mapRgba(def, rgba, env = {}, targetRgba = null) {
  const input = [clamp01(rgba?.[0] ?? 0), clamp01(rgba?.[1] ?? 0), clamp01(rgba?.[2] ?? 0), clamp01(rgba?.[3] ?? 1)];
  const e = { r: input[0], g: input[1], b: input[2], a: input[3], luma: input[0] * 0.2126 + input[1] * 0.7152 + input[2] * 0.0722, x: env.x ?? 0, y: env.y ?? 0, t: env.t ?? 0 };
  const compiled = compiledCached(def);
  const w = clamp01(compiled.where(e));
  if (w <= 0) return input;
  let target = sequenceTarget(input, compiled.seqFrom, compiled.seqTo, def.mode);
  if (!target) {
    if (def.to?.kind === "color") target = parseColor(def.to.value);
    else if (def.to?.kind === "transparent") target = [input[0], input[1], input[2], 0];
    else if (def.to?.kind === "expr") {
      const c = compiled.to;
      target = ["r", "g", "b", "a"].map((k) => clamp01(c[k](e)));
    } else target = targetRgba ? targetRgba.map(clamp01) : input;
  }
  return input.map((v, i) => v * (1 - w) + target[i] * w);
}

// The export page runs the same function inside its Chrome context when it has
// to rasterize a pixel map. Keeping this as an explicit bridge avoids eval and
// keeps the expression parser shared by editor, export and see_frames.
if (typeof window !== "undefined") window.__pcMapRgba = mapRgba;
