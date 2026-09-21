export type FrameMode = 'direct' | 'stateful';
/** @deprecated Old card source remains readable; new cards use FrameMode. */
export type LegacyFrameMode = 'react' | 'non-react';
export type FrameModeInput = FrameMode | LegacyFrameMode;
/** `context` 是 sourceDependent / belowDependent 的旧统称,只为读老 .proc 保留。 */
export type CardCompositing = 'independent' | 'sourceDependent' | 'belowDependent' | 'context' | 'unknown';
/** 审阅表(src/cards/capabilities.json)里一张卡的条目 */
export interface ReviewedCard { compositing?: 'independent' | 'sourceDependent' | 'belowDependent'; canvasHeavy?: boolean; frameMode?: FrameMode }
export type PartSource = string | { from?: string; cardId?: string };
type Definition = { id?: string; frameMode?: FrameModeInput; need_prerendering?: boolean; compositing?: CardCompositing; canvasHeavy?: boolean; defaults?: any; lifecycle?: any; timing?: (params: any) => any };
export const COMPOSITING_VALUES: CardCompositing[];
export const DERIVED_FROM_PARTS: string[];
export function normalizeFrameMode(mode: unknown): FrameMode | undefined;
export function cardFrameMode(def?: Definition, params?: any): FrameMode;
export function reviewedCard(id?: string): ReviewedCard | undefined;
export function derivedCompositing(parts?: PartSource[]): CardCompositing;
export function degradeCard(id?: string, reason?: string): boolean;
export function degradedCards(): Map<string, string>;
export function resetDegradedCards(): void;
export function cardCapabilities(def?: Definition, params?: any, parts?: PartSource[]): { frameMode: FrameMode; need_prerendering: boolean; compositing: CardCompositing; canvasHeavy: boolean; independentCache: boolean };
export function clipFrameMode(clip: { parts?: unknown[]; params?: any }, def?: Definition): FrameMode;
