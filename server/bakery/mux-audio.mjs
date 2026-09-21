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
import { audioPlanOf } from "../../src/kernel/audioPlan.mjs";
import { audioFxOfClip } from "../../src/kernel/audioFx.mjs";

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
 *
 * sourceOf:素材 → ffmpeg 能读的文件或同源 http 地址。导出时传 export-frames 的 mediaSourceOf,
 * 和画面层同一套规则。以前只认 localPathOf(/@export/<id>/media/),素材库里的 /@media/<文件> 一律被跳过,
 * 配乐、配音、打开 .proc 后的视频原声都进不了成片。
 */
export function buildAudioPlan(project, outDir, exists = fs.existsSync, sourceOf = (m) => localPathOf(m.url, outDir)) {
  const out = [];
  // 谁出声、多响的规则在 kernel/audioPlan.mjs(和测响度、Chrome 离线混音同一份);这里只补文件在哪
  for (const e of audioPlanOf(project)) {
    const sourceClip = (project.tracks ?? []).flatMap(track => track.clips ?? []).find(clip => clip.id === e.clipId);
    // A generated node replaces its corresponding source-media input; applying both would double it.
    if (isCardAudioNode(project, sourceClip?.nodeId)) continue;
    const m = (project.media || []).find((x) => x.id === e.mediaId);
    const file = sourceOf(m);
    if (!file || (!/^https?:/i.test(file) && !exists(file))) continue;
    out.push({ file, clipId: e.clipId, start: e.start, dur: e.dur, offset: e.offset, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx });
  }
  // 音频图卡节点 have no ffmpeg-readable source file.  Keep them in the one common
  // plan so Chrome's OfflineAudioContext can request their true WAV blocks.  A caller that
  // explicitly selects the old --audio ffmpeg path must reject them, never silently omit them.
  for (const track of project.tracks ?? []) {
    if (track.hidden || track.muted) continue;
    for (const clip of track.clips ?? []) {
      if (clip.audioMuted || !isCardAudioNode(project, clip.nodeId)) continue;
      // Generated blocks are sample-addressed; do not quantize their timeline placement to
      // the legacy 3 ms audio-plan precision before converting duration to frames.
      const dur = clip.end - clip.start;
      if (!(dur > 0)) continue;
      const definition = audioFxOfClip(project, clip);
      out.push({ cardAudio: true, nodeId: clip.nodeId, clipId: clip.id, start: clip.start, dur,
        offset: 0, volume: (clip.opacity ?? 1) * (clip.audioVolume ?? 1), fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0,
        fx: definition ? { def: definition, params: clip.audioFx?.params } : null });
    }
  }
  return out;
}

/** Kept local to this script so the project model need not invent a fake media asset for a generated node.
 *  只看节点:Node 侧脚本读不到 TSX 定义,kind 是 H2 从定义抄进节点的那一份。 */
export function isCardAudioNode(project, nodeId) {
  if (!nodeId) return false;
  const node = (project.cardNodes ?? []).find(value => value.id === nodeId);
  return node?.adapter === "card" && node.kind === "audio";
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
  if (plan.some(p => p.cardAudio)) throw new Error("ffmpeg audio mux cannot render card audio; use the Chrome audio mixer");
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
