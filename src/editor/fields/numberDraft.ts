/**
 * 数字框的草稿规则(纯函数,`NumberField.tsx` 用,`numberDraft.test.mjs` 直接驱动)。
 *
 * 数字框里打字只改草稿,不进项目;回车、失焦时才按这里的规则决定提交还是还原。
 * 语义见 `docs/semantics/workflow/editing.md`「撤销、重做」(2026-10-20 用户定)。
 */

/** 项目里的值显示成什么(最多 digits 位小数;不是有限数就显示空) */
export function formatNumber(v: number | null | undefined, digits = 3): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  return String(Number(v.toFixed(digits)));
}

export type SettleResult = { kind: "commit"; value: number } | { kind: "revert" };

/**
 * 草稿定稿:
 * - 空、只有「-」「.」这类半截、不是有限数、`validate` 不认 → 还原(不提交);
 * - 和当前显示的值一样(用户没改什么)→ 还原(不提交,免得把 0.30000004 悄悄改成 0.3);
 * - 其余 → 提交这个数。
 */
export function settleDraft(draft: string, current: number | null | undefined, opts: { validate?: (n: number) => boolean; digits?: number } = {}): SettleResult {
  const text = draft.trim();
  if (text === "") return { kind: "revert" };
  const n = Number(text);
  if (!Number.isFinite(n)) return { kind: "revert" };
  if (opts.validate && !opts.validate(n)) return { kind: "revert" };
  const shown = formatNumber(current, opts.digits ?? 3);
  if (shown !== "" && Number(shown) === n) return { kind: "revert" };
  return { kind: "commit", value: n };
}

/**
 * `input` 事件是不是用户在敲字。Chrome / Firefox 里敲字、粘贴、删除的 InputEvent 带 `inputType`,
 * 方向键与输入框自带的上下箭头步进触发的是没有 `inputType` 的普通 input 事件。
 */
export function isTypingInput(inputType: unknown): boolean {
  return typeof inputType === "string" && inputType !== "";
}
