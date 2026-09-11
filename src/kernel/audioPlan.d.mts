import type { AudioFxDef } from "./audioFx.d.mts";

export interface AudioPlanEntry {
  clipId: string;
  trackId: string;
  mediaId: string;
  start: number;
  dur: number;
  offset: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  fx: { def: AudioFxDef; params?: Record<string, number> } | null;
}

export function audioPlanOf(project: unknown): AudioPlanEntry[];
export function soundingAt(plan: AudioPlanEntry[], T: number): string[];
export function fadeEnvelope(volume: number, fadeIn: number, fadeOut: number, dur: number, n: number): Float32Array<ArrayBuffer>;
