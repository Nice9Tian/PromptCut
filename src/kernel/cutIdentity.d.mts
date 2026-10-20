export interface ReachableCutContent { id: string; tracks: unknown[]; duration: number | undefined; transitions: unknown[] }
export function reachableCutContents(project: unknown, tracks?: unknown[]): ReachableCutContent[];
export function reachableMediaIds(project: unknown, tracks?: unknown[]): Set<string>;
export interface CutSegmentContent {
  cutId: string | undefined;
  cutOffset: number;
  contents: ReachableCutContent[];
  media: unknown[];
  nodes: unknown[];
  filters: unknown[];
  pixelMaps: unknown[];
  cardIds: string[];
}
export function cutSegmentContent(project: unknown, clip: unknown): CutSegmentContent;
export function cutSegmentHasVisualMedia(project: unknown, clip: unknown): boolean;
