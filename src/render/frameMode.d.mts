export type FrameMode = 'direct' | 'stateful';
/** @deprecated Old card source remains readable; new cards use FrameMode. */
export type LegacyFrameMode = 'react' | 'non-react';
export type FrameModeInput = FrameMode | LegacyFrameMode;
export type CardCompositing = 'independent' | 'context' | 'unknown';
type Definition = { frameMode?: FrameModeInput; need_prerendering?: boolean; compositing?: CardCompositing; defaults?: any; lifecycle?: any; timing?: (params: any) => any };
export function normalizeFrameMode(mode: unknown): FrameMode | undefined;
export function cardFrameMode(def?: Definition, params?: any): FrameMode;
export function cardCapabilities(def?: Definition, params?: any): { frameMode: FrameMode; need_prerendering: boolean; compositing: CardCompositing; independentCache: boolean };
export function clipFrameMode(clip: { parts?: unknown[]; params?: any }, def?: Definition): FrameMode;
