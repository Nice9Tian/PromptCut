export const CUTS_INDEX_LIMITS: Readonly<{ maxClips: number; perCutMax: number; labelMax: number }>;
export const PARKED_EDIT_NOTE: string;
export interface ParkedCutsIndexOptions {
  maxClips?: number;
  perCutMax?: number;
  labelMax?: number;
  cardName?: (cardId: string) => string | undefined;
}
export interface ParkedCutsIndex {
  activeCutId: string;
  note: string;
  cuts: {
    cutId: string; name: string; duration: number; trackCount: number; clipCount: number;
    clips: Record<string, unknown>[]; omitted?: number; more?: string;
  }[];
}
export function parkedCutsIndex(project: unknown, opts?: ParkedCutsIndexOptions): ParkedCutsIndex | null;
export function otherCutsHint(project: unknown): { cuts: { cutId: string; name: string; clipCount: number }[]; hint: string } | null;
