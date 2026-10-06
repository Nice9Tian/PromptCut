import type { CSSProperties } from "react";
import type { Track, TrackClip } from "../../kernel/project";
import { IconVolumeMute } from "../../ui/icons";

export function clipMuteReason(clip: Pick<TrackClip, "audioMuted" | "audioVolume">, track: Pick<Track, "muted">): string | null {
  if (clip.audioMuted) return "片段已静音";
  if (track.muted) return "序列已静音";
  if (clip.audioVolume === 0) return "片段音量为 0，已静音";
  return null;
}

/** 短片段把图标画在裁切框外；标记不改变片段宽度与鼠标命中区域。 */
export function ClipMuteBadge({ reason, label, compact = false, style }: { reason: string; label?: string; compact?: boolean; style?: CSSProperties }) {
  const title = `${label || "片段"}：${reason}`;
  return <span className={`pc-clip-mute-badge${compact ? " is-compact" : ""}`} data-pc="clip-muted" title={title} role="img" aria-label={title} style={style}>
    <IconVolumeMute size={12} />
    <span className={compact ? "sr-only" : ""}>已静音</span>
  </span>;
}

export function reportClipAudioResult(result: { ok: boolean; error?: string }, notify: (message: string) => void): boolean {
  if (!result.ok) notify(result.error || "音频操作失败，未修改片段");
  return result.ok;
}
