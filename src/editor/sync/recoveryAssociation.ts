import type { Project } from "../../kernel/project";
// @ts-expect-error Browser-safe format validation, also used by the server.
import { parseCollaboration } from "../../../server/recovery/descriptor.mjs";

export interface CollaborationDescriptor {
  version: number;
  roomId?: string;
  service?: string;
  where?: "lan" | "hosted";
  hint?: string;
  [key: string]: unknown;
}
let pending: { contentId: string; descriptor: CollaborationDescriptor | null } | null = null;
let active: CollaborationDescriptor | null = null;

export function noteLoadedAssociation(project: Project, value: unknown) {
  pending = { contentId: project.id!, descriptor: parseCollaboration(value) as CollaborationDescriptor | null };
}
export function takeLoadedAssociation(project: Project): CollaborationDescriptor | null {
  const value = pending && pending.contentId === project.id ? pending.descriptor : null;
  pending = null; active = value;
  return value;
}
export function currentAssociation(): CollaborationDescriptor | null { return active; }
export function setAssociation(value: CollaborationDescriptor | null) { active = value; }
