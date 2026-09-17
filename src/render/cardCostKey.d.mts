export function stableJson(value: unknown): string;
export function cardCostKey(node: Record<string, unknown>, sourceVersion: string | undefined | null, fps: number, durationFrames: number): string;
/** One K1 probe record as stored in out/card-costs.json (GET/PUT /api/data/costs). */
export interface CardCostRecord {
  identityKey: string;
  fps: number;
  /** worst single frame in ms, including freezing the control to HTML (the heavy/light threshold input) */
  frameMs: number;
  /** worst single frame without the freeze (null for random-access cards) */
  stepMs: number | null;
  /** total catch-up from the mount frame to the last clip frame (0 for random-access cards) */
  catchUpMs: number;
  capped?: boolean;
  kind: 'random' | 'stepped';
  vtOk?: boolean;
  seekOk?: boolean;
  seekMs?: number | null;
  demoted?: boolean;
  pinnedHeavy?: boolean;
  measuredAt: number;
  device: string;
}
