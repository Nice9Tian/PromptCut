/**
 * 给导出的成品加音轨。
 *
 * 逐帧截图那条链路只产出画面,声音必须在最后用 ffmpeg 拼回去:
 * 项目里每一段有声音的素材(配乐、以及视频自带的声音)按它在时间轴上的位置延迟、
 * 按 mediaOffset 取片段、按 fadeIn/fadeOut 做淡入淡出,再混成一条轨。
 *
 * 单独成文件是为了可测:buildAudioPlan / buildFfmpegArgs 都是纯函数,不碰磁盘。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 导出时素材的 url 形如 /@export/<id>/media/<file>,真实文件在 outDir/media/<file> */
export function localPathOf(url, outDir) {
  if (!url) return null;
  const marker = "/media/";
  const i = url.lastIndexOf(marker);
  if (i === -1) return null;
  return path.join(outDir, "media", decodeURIComponent(url.slice(i + marker.length)));
}

/**
 * 从 Project 里挑出所有该出声的片段。
 * 图片没有声音;隐藏的序列不出声;音量取 clip.opacity(和画面用同一个字段,画面淡下去声音也淡)。
 */
export function buildAudioPlan(project, outDir, exists = fs.existsSync) {
  const out = [];
  for (const tr of project.tracks || []) {
    if (tr.hidden || tr.muted) continue;
    for (const c of tr.clips || []) {
      if (!c.mediaId || c.audioMuted) continue;
      const m = (project.media || []).find((x) => x.id === c.mediaId);
      if (!m || !m.url || m.kind === "image") continue;
      const file = localPathOf(m.url, outDir);
      if (!file || !exists(file)) continue;
      const dur = +(c.end - c.start).toFixed(3);
      if (!(dur > 0)) continue;
      out.push({
        file,
        start: +c.start.toFixed(3),
        dur,
        offset: +(c.mediaOffset ?? 0).toFixed(3),
        volume: c.opacity ?? 1,
        fadeIn: c.fadeIn ?? 0,
        fadeOut: c.fadeOut ?? 0,
      });
    }
  }
  return out;
}

/** 这个文件里有没有音频流(视频不一定有声轨,直接引用会让整条 filter 崩掉) */
export function hasAudioStream(file, ffprobeCmd) {
  try {
    const out = execFileSync(
      ffprobeCmd,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** 拼 ffmpeg 参数:视频流照抄,音频按计划混音 */
export function buildFfmpegArgs(videoIn, plan, videoOut, durationSec) {
  const args = ["-y", "-i", videoIn];
  const filters = [];
  plan.forEach((p, i) => {
    args.push("-ss", String(p.offset), "-t", String(p.dur), "-i", p.file);
    const k = i + 1; // 0 是视频
    const chain = [`adelay=${Math.round(p.start * 1000)}:all=1`];
    if (p.fadeIn > 0) chain.push(`afade=t=in:st=${p.start.toFixed(3)}:d=${p.fadeIn}`);
    if (p.fadeOut > 0) {
      chain.push(`afade=t=out:st=${(p.start + p.dur - p.fadeOut).toFixed(3)}:d=${p.fadeOut}`);
    }
    if (p.volume !== 1) chain.push(`volume=${p.volume}`);
    filters.push(`[${k}:a]${chain.join(",")}[a${k}]`);
  });
  const labels = plan.map((_, i) => `[a${i + 1}]`).join("");
  // normalize=0:多条音轨叠加时不要自动压低音量,否则加一段配乐会把原声压小
  filters.push(`${labels}amix=inputs=${plan.length}:normalize=0:dropout_transition=0[aout]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(durationSec),
    videoOut,
  );
  return args;
}
