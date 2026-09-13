import type { UnifiedCardDefinition } from './cardGraph.mjs';
import type { Project } from './project';
export function saveCardDefinition(project: Project, definition: UnifiedCardDefinition, options?: { overwrite?: boolean }): Project;
export function patchCardDefinition(definition: UnifiedCardDefinition, args: { find: string; replace: string; replaceAll?: boolean; metadata?: Record<string, unknown> }): UnifiedCardDefinition;
export function applyCardDefinition(project: Project, args: any): { project: Project; clipId: string; nodeId: string };
export function cloneCardClipInstance(project: Project, oldClipId: string, newClipId: string, nodeId?: string, timeOffset?: number): { project: Project; nodeId?: string };
