import missingMaterialWavUrl from "./assets/missing-material.wav?url";
import type { MediaAsset, Project, TrackClip } from "../kernel/project";

/** The built-in, software-shipped clip is 1.37 seconds; it is never a project asset. */
export const MISSING_MATERIAL_WAV_URL = missingMaterialWavUrl;
export const MISSING_MATERIAL_WAV_SECONDS = 1.37;

/** Only a serialized recovery confirmation may activate the proxy; read/decode errors stay ordinary errors. */
export function confirmedMissing(media: MediaAsset | undefined): boolean {
  const state = media?.missingMaterial;
  return !!media && state?.v === 1 && state.reason === "confirmed-missing" && state.mediaId === media.id
    && state.original?.kind === media.kind && state.original.name === media.name
    && state.original.url === media.url && state.original.hash === media.hash
    && typeof state.visual === "boolean" && typeof state.audio === "boolean";
}

export function confirmedMissingVisual(media: MediaAsset | undefined): boolean {
  return confirmedMissing(media) && media!.missingMaterial!.visual === true;
}

export function confirmedMissingAudio(media: MediaAsset | undefined, project?: Project): boolean {
  if (confirmedMissing(media) && media!.missingMaterial!.audio === true && media!.kind !== "image") return true;
  if (!media?.soundOf || !project) return false;
  const source = project.media.find((item) => item.id === media.soundOf);
  return confirmedMissing(source) && source!.kind === "video" && source!.missingMaterial!.audio === true;
}

export function missingMaterialLabel(media: MediaAsset): string {
  const original = media.missingMaterial?.original;
  return original?.name || original?.hash || media.name || media.id;
}

export function missingMaterialSourceTime(clip: Pick<TrackClip, "start" | "end">, timelineTime: number): number {
  return Math.min(MISSING_MATERIAL_WAV_SECONDS, Math.max(0, timelineTime - clip.start));
}

export function missingMaterialAudibleDuration(clip: Pick<TrackClip, "start" | "end">): number {
  return Math.max(0, Math.min(MISSING_MATERIAL_WAV_SECONDS, clip.end - clip.start));
}
