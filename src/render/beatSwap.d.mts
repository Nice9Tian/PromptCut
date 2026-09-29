export const SWAP_MS: number;
export type SwapKind = "dom" | "lottie" | "canvas";
export const SWAP_MS_BY_KIND: Readonly<Record<SwapKind, number>>;
export function swapKindOf(desc: { cardId?: string | null; known?: boolean; source?: string; canvas?: boolean; canvasHeavy?: boolean } | null | undefined): SwapKind | null;
export function swapCostOf(kind: string | null | undefined, table?: Readonly<Record<string, number>>, fallback?: number): number;
export function fitBeatSwaps(input: {
  fps: number;
  occupiedMs?: number;
  layers: readonly string[];
  swapMs?: number;
  costOf?: (id: string) => number | null | undefined;
}): {
  swap: string[];
  placeholder: string[];
  deadMs: number;
  fit: number;
  usedMs: number;
};
