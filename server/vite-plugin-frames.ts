import type { Plugin } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { frameCode, invalidateFrameCode } from "./frame-code.mjs";
import { FramePipeline } from "./frame-pipeline.mjs";
import { unpackFrameArchive } from "./frame-archive.mjs";
import { overLimit } from "./http-guard.mjs";

const services = new Map<string, FramePipeline>();
function requestSignal(req: any, res: any) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.("aborted", abort);
  res.once?.("close", () => { if (!res.writableEnded) abort(); });
  return controller.signal;
}
export function frameService(root: string, origin: string) {
  let service = services.get(root);
  if (!service) {
    service = new FramePipeline({ root: path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(root, "out"), "frame-library"), origin: () => origin, code: () => frameCode(root) });
    services.set(root, service);
  }
  return service;
}
export function renderProject(project: any) {
  return { ...project, media: (project.media || []).map((m: any) => {
    // .proc files from older versions may contain a bare filename (and some
    // callers still send blob URLs).  The renderer cannot resolve either
    // form; the durable server path is the source of truth for both.
    if (m.path && (!m.url || m.url.startsWith("blob:") || !m.url.startsWith("/"))) {
      return { ...m, url: "/@media/" + encodeURIComponent(path.basename(m.path)) };
    }
    return m;
  }) };
}
export function framesPlugin(): Plugin {
  return { name: "promptcut-frames", configureServer(server) {
    const root = server.config.root;
    server.watcher.on("change", file => { if (file.startsWith(path.join(root, "src")) || file.startsWith(path.join(root, "scripts"))) invalidateFrameCode(root); });
    server.httpServer?.once("close", () => { const s = services.get(root); services.delete(root); void s?.close(); });
    server.middlewares.use("/api/frames", (req, res, next) => {
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const service = frameService(root, origin);
      const url = new URL(req.url || "/", origin);
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      if (req.method === "GET") {
        // The final cumulative render is used by the editor, while the
        // cumulative track renders are useful to callers that want to rebuild
        // only the edited upper part.  Keep both forms behind fixed-length
        // hexadecimal keys; no user supplied path segment reaches the disk.
        const final = /^\/([a-f0-9]{64})\/(preview\.mp4|frames\/\d{6}\.png)$/.exec(url.pathname);
        const track = /^\/([a-f0-9]{64})\/tracks\/([a-f0-9]{64})\/(preview\.mp4|frames\/\d{6}\.png)$/.exec(url.pathname);
        if (!final && !track) return next();
        const file = final
          ? path.join(service.root, final[1], final[2])
          : path.join(service.root, track![1], "tracks", track![2], track![3]);
        void fsp.stat(file).then(stat => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(stat.size - 1, Number(range[2])) : stat.size - 1;
          if (start > end || start >= stat.size) { res.statusCode = 416; return res.end(); }
          res.statusCode = range ? 206 : 200;
          res.setHeader("Content-Type", file.endsWith(".mp4") ? "video/mp4" : "image/png");
          res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Length", end - start + 1);
          if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
        }, () => json(404, { error: "Frame is not ready" }));
        return;
      }
      if (req.method !== "POST") return next();
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Frame request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body);
          const project = renderProject(input.project);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          const entry = await service.entry(project);
          if (url.pathname === "/see") {
            const lane = input.lane === "agent" ? "agent" : "user";
            const frames = await service.see_frames(project, input.times || [0], { lane, signal: requestSignal(req, res) });
            return json(200, { key: entry.key, frames: [...frames].map(([frame, value]: any) => ({ frame, source: value.source, url: `/api/frames/${entry.key}/frames/${String(frame).padStart(6, "0")}.png` })) });
          }
          if (url.pathname === "/preload") await service.preload(project);
          else if (url.pathname === "/import" && typeof input.snapshots === "string") {
            try {
              // Restore the control index together with the HTML.  It is built from
              // the same snapshots and lets callers address a component at its
              // local frame without sampling the whole project again.
              const archive = unpackFrameArchive(input.snapshots, entry.key);
              entry.html = archive.frames;
              entry.controls = archive.controls;
              await service.save(entry);
            }
            catch { return json(200, { discarded: true }); }
          } else if (url.pathname === "/archive") {
            await service.save(entry);
            return json(200, { key: entry.key, snapshots: await fsp.readFile(path.join(entry.dir, "snapshots.base64"), "utf8") });
          } else if (url.pathname !== "/status") return json(404, { error: "Unknown frame operation" });
          const videoReady = await fsp.access(path.join(entry.dir, "preview.mp4")).then(() => true, () => false);
          return json(200, { key: entry.key, status: entry.status, sampled: entry.html.size, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))), error: entry.error,
            video: videoReady ? `/api/frames/${entry.key}/preview.mp4` : null });
        } catch (error: any) { json(400, { error: error.message }); }
      });
    });
  } };
}
