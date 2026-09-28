export const SWAP_MS: number;
export function fitBeatSwaps(input: { fps: number; occupiedMs?: number; layers: readonly string[]; swapMs?: number }): {
  swap: string[];
  placeholder: string[];
  deadMs: number;
  fit: number;
};
