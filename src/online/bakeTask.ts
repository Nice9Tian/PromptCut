/**
 * 纯浏览器节点生成快照一段细任务要的纯函数(M7 契约第 4.3、4.5 节):
 *
 *   - `bakeInputOf`:任务 → 隔离单卡工程(`isolatedCardProject`)要的参数。它要的 `start`、`end`、`count`、`sampling` 由切分方写在浏览器那一份的 `input.bake` 里,
 *     页面不算 `cardSampling`;片段 id 取 `input.clipId`。
 *   - `snapshotManifest`:全段齐后组的清单,形状同桌面 `server/artifact-transfer.mjs` 的 `collectSnapshotResult`
 *     (`v: 1`、`kind: 'snapshot'`、`tier: 'shared'`、`resultKey`、`dirKey = resultKey`、`entryKey: null`、`range`、`canvasHeavy`、
 *     `frames: [[本地帧, 哈希, 字节数]]`,有小尺寸就带 `small`);单测过桌面的 `manifestMatches`。
 *   - `manifestKey`:清单在内容库里的键 `<resultKey>:<from>-<to>`(同 `manifestKeyOf`)。
 *
 * `isolatedCardProject` 已挪进页面与服务端共用的纯模块 `src/kernel/isolatedCard.mjs`,桌面 `FramePipeline#isolatedCardProject` 改引它(契约第 4.3 节)。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor,不引 `mode.ts`。
 */

import { isolatedCardProject } from "../kernel/isolatedCard.mjs";

/** 清单的版本(同 `artifact-transfer.mjs` 的 `RESULT_VERSION`) */
export const RESULT_VERSION = 1;
/** 清单 JSON 的体积上限(同 `RESULT_MAX_BYTES`) */
export const RESULT_MAX_BYTES = 256 * 1024;

export interface BakeInput {
  clipId: string;
  start: number;
  end: number;
  count: number;
  sampling: { phase: { numerator: number | string; denominator: number | string }; [k: string]: unknown };
}

/** 任务 → 隔离单卡工程要的参数;缺东西回 null(不猜) */
export function bakeInputOf(task: { input?: Record<string, unknown> } | null | undefined): BakeInput | null {
  const input = task?.input ?? {};
  const bake = input.bake as Record<string, unknown> | undefined;
  const clipId = input.clipId;
  if (typeof clipId !== "string" || !clipId || !bake || typeof bake !== "object") return null;
  const start = Number(bake.start), end = Number(bake.end), count = Number(bake.count);
  const sampling = bake.sampling as BakeInput["sampling"] | undefined;
  const phase = sampling?.phase;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isInteger(count) || count < 1) return null;
  if (!phase || !Number.isFinite(Number(phase.numerator)) || !(Number(phase.denominator) > 0)) return null;
  return { clipId, start, end, count, sampling };
}

/** 隔离单卡工程:桌面预渲染与本页共用的唯一一份(`src/kernel/isolatedCard.mjs`) */
export { isolatedCardProject };

/** 清单在内容库里的键:`<resultKey>:<from>-<to>`;缺东西回 null */
export function manifestKey(ref: { resultKey?: unknown; range?: { from?: unknown; to?: unknown } | null } | null | undefined): string | null {
  const key = ref?.resultKey;
  const from = ref?.range?.from, to = ref?.range?.to;
  if (typeof key !== "string" || !key || !Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) < (from as number)) return null;
  return `${key}:${from}-${to}`;
}

export interface ManifestFrame { localFrame: number; hash: string; bytes: number; small?: { hash: string; bytes: number } | null }

export interface SnapshotManifest {
  v: 1;
  kind: "snapshot";
  tier: "shared";
  resultKey: string;
  dirKey: string;
  entryKey: null;
  range: { from: number; to: number };
  canvasHeavy: boolean;
  frames: [number, string, number][];
  small?: [number, string, number][];
}

/** 清单 JSON 的 UTF-8 字节数 */
export function manifestBytes(m: unknown): number {
  return new TextEncoder().encode(JSON.stringify(m)).length;
}

/**
 * 全段齐后组的清单(形状同 `collectSnapshotResult`)。超过 256 KiB 抛 `code: 'result-too-large'`(不可重试,同 `assertResultSize`)。
 * 超体积的帧(DOM 300 KB、画布位图 1 MB)照桌面列进清单,由拉取方判。
 */
export function snapshotManifest(task: { resultKey: string; range: { from: number; to: number } | null; input?: Record<string, unknown> }, frames: readonly ManifestFrame[]): SnapshotManifest {
  if (!task.range) throw Object.assign(new Error("任务没有 range"), { retryable: false });
  const { from, to } = task.range;
  const inRange = [...frames].filter((f) => f.localFrame >= from && f.localFrame <= to).sort((a, b) => a.localFrame - b.localFrame);
  const small = inRange.filter((f) => f.small && typeof f.small.hash === "string" && f.small.bytes > 0)
    .map((f) => [f.localFrame, f.small!.hash, f.small!.bytes] as [number, string, number]);
  const out: SnapshotManifest = {
    v: RESULT_VERSION, kind: "snapshot", tier: "shared",
    resultKey: task.resultKey, dirKey: task.resultKey, entryKey: null,
    range: { from, to },
    canvasHeavy: task.input?.canvasHeavy === true,
    frames: inRange.map((f) => [f.localFrame, f.hash, f.bytes]),
    ...(small.length ? { small } : {}),
  };
  const bytes = manifestBytes(out);
  if (bytes > RESULT_MAX_BYTES) throw Object.assign(new Error(`任务清单 ${bytes} 字节,超过上限 ${RESULT_MAX_BYTES}`), { code: "result-too-large", bytes, retryable: false });
  return out;
}

/** 内容库里取回的清单能不能直接当这一段的结果用(去重,第 4.1 节):形状对、覆盖整段、每帧都有小尺寸 */
export function manifestCovers(body: unknown, task: { resultKey: string; range: { from: number; to: number } | null }): body is SnapshotManifest {
  const b = body as SnapshotManifest | null;
  if (!b || typeof b !== "object" || b.v !== RESULT_VERSION || b.kind !== "snapshot" || b.resultKey !== task.resultKey || !task.range) return false;
  if (b.range?.from !== task.range.from || b.range?.to !== task.range.to || !Array.isArray(b.frames)) return false;
  const HEX = /^[a-f0-9]{64}$/;
  const have = new Set<number>();
  for (const item of b.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || !HEX.test(String(item[1]))) return false;
    have.add(item[0]);
  }
  const smallHave = new Set<number>();
  for (const item of Array.isArray(b.small) ? b.small : []) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || !HEX.test(String(item[1]))) return false;
    smallHave.add(item[0]);
  }
  // 两档都齐才算这一段完成(c10a 第 9 节)
  for (let f = task.range.from; f <= task.range.to; f++) if (!have.has(f) || !smallHave.has(f)) return false;
  return true;
}

/** 清单里要在素材服务上的块:`[{ ns, hash }]`(原尺寸 `snap`,小尺寸 `px`) */
export function manifestBlocks(m: SnapshotManifest): { ns: "snap" | "px"; hash: string }[] {
  const out = new Map<string, { ns: "snap" | "px"; hash: string }>();
  for (const [, hash] of m.frames) out.set(`snap/${hash}`, { ns: "snap", hash });
  for (const [, hash] of m.small ?? []) out.set(`px/${hash}`, { ns: "px", hash });
  return [...out.values()];
}
