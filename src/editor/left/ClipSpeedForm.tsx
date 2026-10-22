import { useState } from "react";
import { actions } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { CLIP_SPEED_PRESETS, SPEED_MUTE_NOTE, clipSpeed, speedLabel } from "../../kernel/clipTime.mjs";

/**
 * 编辑分区里视频段的「速度」一栏:几档倍数,起点不动、终点按新速度重算(store 的 setClipSpeed)。
 * 手机版的入口在子导航栏的「速度」(`src/mobile/sheets.tsx` 的 SpeedSheet),两边同一个动作、同一句说明。
 */
export function ClipSpeedForm({ clip }: { clip: TrackClip }) {
  const [msg, setMsg] = useState<string | null>(null);
  const cur = clipSpeed(clip);
  const presets = CLIP_SPEED_PRESETS.includes(cur) ? CLIP_SPEED_PRESETS : [...CLIP_SPEED_PRESETS, cur].sort((a, b) => a - b);
  const apply = (v: number) => {
    const r = actions.setClipSpeed(clip.id, v);
    setMsg(r.ok ? (r.capped ? "后面放不下，已截到下一段的起点" : null) : r.error);
  };
  return (
    <div className="mt-2 pt-2 pc-left-divider" data-pc="clip-speed">
      <div className="flex items-center gap-2 mb-1">
        <span className="pc-left-muted shrink-0">速度</span>
        <select data-pc="clip-speed-select" value={String(cur)} onChange={(e) => apply(Number(e.target.value))} className="flex-1 pc-left-select is-sm">
          {presets.map((v) => <option key={v} value={String(v)}>{speedLabel(v)}</option>)}
        </select>
      </div>
      <div className={cur === 1 ? "pc-left-faint" : "pc-left-muted"} data-pc="clip-speed-note">{SPEED_MUTE_NOTE}</div>
      {msg && <div className="pc-left-faint" data-pc="clip-speed-msg" role="status">{msg}</div>}
    </div>
  );
}
