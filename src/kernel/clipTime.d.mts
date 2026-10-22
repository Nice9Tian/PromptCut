export interface ClipTimeLike { start: number; end: number; mediaOffset?: number; speed?: number; mediaId?: string }
export const CLIP_SPEED_MIN: number;
export const CLIP_SPEED_MAX: number;
export const CLIP_SPEED_PRESETS: readonly number[];
export function clipSpeed(clip: { speed?: number } | null | undefined): number;
export function isSpeedChanged(clip: { speed?: number } | null | undefined): boolean;
export function speedMutesSource(clip: { speed?: number; mediaId?: string } | null | undefined): boolean;
export function mediaTimeAt(clip: Pick<ClipTimeLike, "start" | "mediaOffset" | "speed">, t: number): number;
export function timelineTimeAt(clip: Pick<ClipTimeLike, "start" | "mediaOffset" | "speed">, mediaSec: number): number;
export function mediaOffsetAfter(clip: Pick<ClipTimeLike, "mediaOffset" | "speed">, dt: number): number;
export function mediaSpanOf(clip: Pick<ClipTimeLike, "start" | "end" | "speed">, dur?: number): number;
export function timelineSpanOf(clip: { speed?: number }, mediaDur: number): number;
export function normalizeSpeed(value: unknown): number | null;
export function withSpeed<T extends { speed?: number }>(clip: T, speed: number): T;
export function speedKeyPart(clip: { speed?: number } | null | undefined): { speed: number } | null;
export function speedLabel(speed: number): string;
