import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { mediaDir } from "./vite-plugin-media";
import { isInside } from "./http-guard.mjs";
import { findFfmpeg } from "./ai-visual.mjs";
import { readBody } from "./vite-plugin-stt";
import { measureArgs, timelineMeasureArgs, parseEbur128 } from "./audio-measure.mjs";

function hasAudioStream(file: string, ffprobeCmd: string): boolean {
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

function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

function mediaFileOf(root: string, m: any): string | null {
  // media.path 不能直接用，因为可能来自恶意请求构造的绝对路径。
  // 我们必须根据 url 中携带的文件名在限定的素材目录 (mediaDir) 中寻找对应的真实文件，并且使用 isInside 确保不越界。
  const dir = mediaDir(root);
  const direct = m?.path ? String(m.path) : "";
  if (direct && isInside(direct, dir) && fs.existsSync(direct)) return direct;

  const urlStr = String(m?.url || "");
  const base = String(m?.url || m?.path || "").split(/[/\\]/).pop() || "";
  if (!base) return null;

  const decoded = decodeURIComponent(base);

  const match = urlStr.match(/^\/@export\/([^/]+)\/media\//);
  if (match) {
    const id = match[1];
    const exportDir = path.resolve(outRoot(root), `export-${id}`, "media");
    const localExport = path.join(exportDir, decoded);
    if (isInside(localExport, exportDir) && fs.existsSync(localExport)) {
      return localExport;
    }
  }

  const local = path.join(dir, decoded);
  return isInside(local, dir) && fs.existsSync(local) ? local : null;
}

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function audioPlugin(): Plugin {
  return {
    name: "vite-plugin-audio",
    configureServer(server) {
      const root = server.config.root;
      
      server.middlewares.use(async (req: Connect.IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method === "POST" && req.url === "/api/audio/measure") {
          try {
            const bodyBuf = await readBody(req);
            const body = JSON.parse(bodyBuf.toString("utf-8"));
            
            const ffmpeg = findFfmpeg();
            if (!ffmpeg) {
              return sendJson(res, 400, { ok: false, error: "找不到 ffmpeg" });
            }
            const ffprobe = path.join(path.dirname(ffmpeg), "ffprobe" + path.extname(ffmpeg));

            let args: string[] = [];
            let notes: string[] = [];
            let seriesRequested = !!body.series;

            if (body.scope === "media" || body.scope === "clip") {
              const file = mediaFileOf(root, body.media);
              if (!file) {
                return sendJson(res, 400, { ok: false, error: "素材文件不存在" });
              }
              if (!hasAudioStream(file, ffprobe)) {
                return sendJson(res, 400, { ok: false, error: "该文件没有音频流" });
              }
              args = measureArgs({
                file,
                offset: body.scope === "clip" ? body.offset : undefined,
                duration: body.scope === "clip" ? body.duration : undefined
              });
            } else if (body.scope === "timeline") {
              seriesRequested = true;
              const validEntries: any[] = [];
              let skipped = 0;
              let skippedNames: string[] = [];
              for (const e of body.entries) {
                const file = mediaFileOf(root, e.media);
                if (!file || !hasAudioStream(file, ffprobe)) {
                  skipped++;
                  skippedNames.push(e.media?.name || e.clipId || "未知片段");
                  continue;
                }
                validEntries.push({ ...e, file });
              }
              if (skipped > 0) {
                notes.push("有 " + skipped + " 段没有音频流或文件不存在，已跳过：" + skippedNames.join("、"));
              }
              if (validEntries.length === 0) {
                return sendJson(res, 200, {
                  ok: true,
                  duration: body.duration,
                  integrated: null, truePeak: null, lra: null, lraLow: null, lraHigh: null, threshold: null,
                  series: [],
                  ...(notes.length ? { notes } : {})
                });
              }
              args = timelineMeasureArgs(validEntries, Number(body.duration) > 0 ? Number(body.duration) : undefined);
            } else {
              return sendJson(res, 400, { ok: false, error: "无效的 scope" });
            }

            const child = spawn(ffmpeg, args, { windowsHide: true });
            
            let stderr = "";
            let timedOut = false;

            child.stderr.on("data", (d) => { stderr += d.toString(); });
            
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill();
            }, 50000);

            child.on("error", (e) => {
              clearTimeout(timer);
              sendJson(res, 500, { ok: false, error: "启动 ffmpeg 失败: " + e.message });
            });

            child.on("close", (code) => {
              clearTimeout(timer);
              if (timedOut) {
                return sendJson(res, 500, { ok: false, error: "分析超时" });
              }

              if (code !== 0 && !stderr.includes("Parsed_ebur128")) {
                return sendJson(res, 500, { ok: false, error: "ffmpeg 运行失败: " + stderr.slice(-300) });
              }

              try {
                const parsed = parseEbur128(stderr);
                if (!seriesRequested) {
                  delete parsed.series;
                }
                if (notes.length > 0) {
                  parsed.notes = (parsed.notes || []).concat(notes);
                }
                sendJson(res, 200, { ok: true, ...parsed });
              } catch (err) {
                sendJson(res, 500, { ok: false, error: "解析输出失败: " + String(err) });
              }
            });

          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e.message || String(e) });
          }
        } else {
          next();
        }
      });
    }
  };
}
