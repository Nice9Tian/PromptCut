import type { Project } from './project';
export function applyCardDefinition(project: Project, args: any, getCard?: (id: string) => any): { project: Project; clipId: string; nodeId: string };
export function cloneCardClipInstance(project: Project, oldClipId: string, newClipId: string, nodeId?: string, timeOffset?: number): { project: Project; nodeId?: string };
