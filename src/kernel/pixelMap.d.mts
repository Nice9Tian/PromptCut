export type PixelMapStage = "origin" | "after_filters";
export type PixelMapMode = "continuous" | "discrete";
export type PixelMapTarget =
  | { kind: "media"; mediaId: string; stage: PixelMapStage; filterId?: string }
  | { kind: "color"; value: string }
  | { kind: "transparent" }
  | { kind: "expr"; r: string | number; g: string | number; b: string | number; a?: string | number };
export interface PixelMapDef {
  id: string;
  name: string;
  description?: string;
  source: { mediaId?: string; stage: PixelMapStage; filterId?: string };
  where: string;
  to: PixelMapTarget;
  mode: PixelMapMode;
  colorSequence?: { from: string[]; to: string[]; mode: PixelMapMode };
  createdBy?: "agent" | "user";
  createdAt?: number;
}
export interface ClipPixelMap { id: string; params?: Record<string, number>; }
export const PIXEL_MAP_MODES: PixelMapMode[];
export const PIXEL_MAP_STAGES: PixelMapStage[];
export const MAX_PIXEL_MAPS: number;
export function parseColor(value: string): [number, number, number, number] | null;
export function normalizePixelMapDef(input: unknown): Omit<PixelMapDef, "id" | "createdBy" | "createdAt">;
export function compilePixelMap(def: PixelMapDef): unknown;
export function mapRgba(def: PixelMapDef, rgba: number[], env?: { x?: number; y?: number; t?: number }, targetRgba?: number[] | null): number[];
