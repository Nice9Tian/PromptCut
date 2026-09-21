/**
 * ffmpeg 抽帧与素材层渲染。从 server/vite-plugin-vision.ts 逐字搬来,函数体和注释一字未改。
 *
 * 这一层只认磁盘上的素材文件,不碰浏览器、不碰队列 —— 传进来项目状态和时刻,
 * 交回抽出来的 PNG 路径。`mediaFileOf` 那道白名单边界是它唯一的安全职责。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractArgs, mediaLayersAt } from "../vision-compose.mjs";
import { mediaDir } from "../vite-plugin-media";
import { isInside } from "../http-guard.mjs";

/** ffmpeg 抽一帧的上限:本地文件按关键帧定位,正常两三秒 */
export const EXTRACT_TIMEOUT_MS = 30000;

/**
 * ffmpeg 在哪:PATH 上的优先;没有就用 winget 装的那份(和 server/bakery/ffmpeg.mjs 同一个兜底);
 * 都没有返回 null,素材那一层就不画、在 note 里说清楚。结果缓存,别每次看图都 spawn 一遍 -version。
 */
let ffmpegResolved: string | null | undefined;
export function ffmpegCommand(): string | null {
  if (ffmpegResolved !== undefined) return ffmpegResolved;
  const candidates = [
    process.env.PROMPTCUT_FFMPEG,
    "ffmpeg",
    path.join(process.env.LOCALAPPDATA || os.homedir(), "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.1-full_build", "bin", "ffmpeg.exe"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
      if (r.status === 0) return (ffmpegResolved = c);
    } catch { /* 下一个 */ }
  }
  return (ffmpegResolved = null);
}

/**
 * 素材文件在磁盘上的位置:导入时记的 path 优先,没有就按文件名去媒体目录找。
 *
 * `m` 来自**请求体**(`/api/vision/sheet` 的 media、snapshot 的 project.media),所以 `m.path`
 * 是外面递进来的字符串,不是我们自己算出来的。曾经只判 `fs.existsSync` 就直接用:
 * 递一个 `{"path":"C:\\Users\\...\\任意文件"}` 进来,服务端就会对那个文件跑 ffmpeg 抽帧,
 * 再把画面 base64 塞进响应 —— 等于给 MCP 那边的 agent(本该只操作封装)开了一条读盘的路。
 * 跨源有 vite-plugin-api-guard 挡着,所以不是远程漏洞,但本机这道边界当时是空的。
 *
 * 现在按白名单收口:只认落在**素材目录**里的绝对路径,别的一律退回「按文件名去素材目录找」。
 * 这不影响正常素材 —— 导入和素材收集都只往 mediaDir 写(见 vite-plugin-media.ts 的
 * handleMediaUpload、vite-plugin-collect.ts:181),path 字段本来就只可能指到那里。
 */
export function mediaFileOf(root: string, m: any): string | null {
  const dir = mediaDir(root);
  const direct = m?.path ? String(m.path) : "";
  if (direct && isInside(direct, dir) && fs.existsSync(direct)) return direct;
  const base = String(m?.url || m?.path || "").split(/[/\\]/).pop() || "";
  if (!base) return null;
  // decodeURIComponent 之后还要再判一次:`a%2F..%2F..%2Fx` 按 / 和 \ 切是切不开的
  // (斜杠是编码过的),解码完却成了 `a/../../x`,path.join 会顺着它走出素材目录。
  const local = path.join(dir, decodeURIComponent(base));
  return isInside(local, dir) && fs.existsSync(local) ? local : null;
}

/** 用 ffmpeg 把素材的第 seconds 秒抽成 w×h 的 RGBA PNG(object-fit: cover),写到 opts.out */
function extractFrame(ffmpeg: string, opts: { file: string; kind: string; seconds: number; width: number; height: number; opacity: number; filter?: string; out: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, extractArgs(opts), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg 抽帧超时")); }, EXTRACT_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
      resolve();
    });
  });
}

/**
 * 素材层:第 t 秒画面里的每一段视频 / 图片各抽一帧。抽不到的(文件没了、ffmpeg 不在)
 * 在 notes 里如实说,那一层留空 —— 别让模型对着一张缺层的图得出「视频没进来」。
 *
 * 返回的是抽出来的 PNG **文件路径**(从下到上),不在这里解码:合成由渲染 worker 做
 * (server/png-post.mjs),这个进程只管调度。
 */
async function renderMediaLayers(root: string, project: any, t: number, dir: string, notes: string[]): Promise<string[]> {
  const layers = mediaLayersAt(project, t);
  if (layers.length === 0) return [];
  const ffmpeg = ffmpegCommand();
  if (!ffmpeg) {
    notes.push("这台机器上找不到 ffmpeg,画面里素材那一层是空的(不是素材的问题)。");
    return [];
  }
  const width = project.width || 1920;
  const height = project.height || 1080;
  const out: string[] = [];
  let i = 0;
  for (const layer of layers) {
    const file = mediaFileOf(root, layer.media);
    if (!file) {
      notes.push(`素材「${layer.media.name || layer.media.id}」的文件服务端取不到,画面里它那一层是空的。`);
      continue;
    }
    try {
      // 帧号带进文件名:renderFrames 一趟抽好几个时刻的素材层,都落在同一个目录里
      const layerOut = path.join(dir, `layer-${Math.round(t * 1000)}-${i++}.png`);
      await extractFrame(ffmpeg, {
        file, kind: layer.media.kind, seconds: Math.max(0, layer.mediaTime), width, height, opacity: layer.opacity, filter: layer.filter,
        out: layerOut,
      });
      out.push(layerOut);
    } catch (e: any) {
      notes.push(`素材「${layer.media.name || layer.media.id}」第 ${layer.mediaTime.toFixed(2)} 秒抽帧失败(${e?.message || e}),画面里它那一层是空的。`);
    }
  }
  return out;
}
