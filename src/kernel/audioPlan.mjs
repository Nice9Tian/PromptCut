/**
 * 时间轴上「谁在什么时候出声、多响」的清单,纯函数,不碰磁盘。
 *
 * 三处用同一份规则,免得各写一遍又对不上:
 *   - 导出混音(scripts/mux-audio.mjs 的 buildAudioPlan → ffmpeg;scripts/export-frames.mjs 的 Chrome 离线渲染)
 *   - 测响度(measure_audio 的 timeline 档,浏览器把这份清单发给服务端)
 *   - 预览不用它(预览按时刻查 audioClipsAt / videoLayersAt),但规则一致:隐藏 / 静音的序列不出声,
 *     片段 audioMuted 不出声,图片没声音,音量 = opacity × audioVolume,淡入淡出线性。
 */

import { audioFxOfClip } from "./audioFx.mjs";

const r3 = (n) => +Number(n).toFixed(3);

/**
 * @returns 每一条:{ clipId, trackId, mediaId, start, dur, offset, volume, fadeIn, fadeOut, fx: { def, params } | null }
 *   start / dur 是时间轴上的位置(秒),offset 是从素材第几秒开始。顺序按序列从上到下、片段原顺序。
 */
export function audioPlanOf(project) {
  const out = [];
  for (const tr of project.tracks || []) {
    if (tr.hidden || tr.muted) continue;
    for (const c of tr.clips || []) {
      if (!c.mediaId || c.audioMuted) continue;
      const m = (project.media || []).find((x) => x.id === c.mediaId);
      if (!m || !m.url || m.kind === "image") continue;
      const dur = r3(c.end - c.start);
      if (!(dur > 0)) continue;
      const def = audioFxOfClip(project, c);
      out.push({
        clipId: c.id,
        trackId: tr.id,
        mediaId: m.id,
        start: r3(c.start),
        dur,
        offset: r3(c.mediaOffset ?? 0),
        volume: (c.opacity ?? 1) * (c.audioVolume ?? 1),
        fadeIn: c.fadeIn ?? 0,
        fadeOut: c.fadeOut ?? 0,
        fx: def ? { def, params: c.audioFx.params } : null,
      });
    }
  }
  return out;
}

/**
 * 一段的音量包络:volume × 淡入(线性 0→1)× 淡出(线性 1→0),采成 n 个点(首尾各一个,之间等距)。
 * 和 ffmpeg 那条路(scripts/mux-audio.mjs:afade t=in 再 afade t=out,默认 tri 曲线)语义完全一样 —— 两条淡化相乘。
 * 淡入淡出重叠(fadeIn + fadeOut > dur)时是两条斜线的乘积(抛物线),淡入比片段还长时终点只到 dur/fadeIn,
 * 都由乘法自然给出;以前用「两段自动化拼起来」在重叠时会被 AudioParam 的事件排序吃掉整段淡入(实测硬跳)。
 * 导出用 setValueCurveAtTime 铺进去,点间线性插值,5 ms 一个点足够。
 */
export function fadeEnvelope(volume, fadeIn, fadeOut, dur, n) {
  const count = Math.max(2, Math.floor(n) || 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * dur;
    let g = volume;
    if (fadeIn > 0) g *= Math.min(1, t / fadeIn);
    if (fadeOut > 0) g *= Math.min(1, (dur - t) / fadeOut);
    out[i] = Math.max(0, g);
  }
  return out;
}

/** 时间轴时刻 T 正在出声的片段(给测响度的逐秒归因用) */
export function soundingAt(plan, T) {
  return plan.filter((p) => T >= p.start && T < p.start + p.dur).map((p) => p.clipId);
}
