import type { Plugin } from "vite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { captureCode, frameCode, invalidateFrameCode } from "./frame-code.mjs";
import { FramePipeline } from "./frame-pipeline.mjs";
import { unpackFrameArchive } from "./frame-archive.mjs";
import { overLimit } from "./http-guard.mjs";
import { prerenderState } from "./prerender-client.mjs";
import { isPrerender } from "./render-role.mjs";
import { ensureMirror } from "./vite-plugin-mirror";

const services = new Map<string, FramePipeline>();
function requestSignal(req: any, res: any) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.("aborted", abort);
  res.once?.("close", () => { if (!res.writableEnded) abort(); });
  return controller.signal;
}
export function frameService(root: string, origin: string) {
  root = path.resolve(root);
  let service = services.get(root);
  if (!service) {
    service = new FramePipeline({ root: path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(root, "out"), "frame-library"), origin: () => origin,
      code: () => frameCode(root), captureCode: () => captureCode(root) });
    services.set(root, service);
  }
  return service;
}
export function renderProject(project: any) {
  return { ...project, media: (project.media || []).map((m: any) => {
    // .proc files from older versions may contain a bare filename (and some
    // callers still send blob URLs).  The renderer cannot resolve either
    // form; the durable server path is the source of truth for both.
    // A legacy .proc may say /@media/<name> while the actual file lives in
    // the shared Videos/PromptCut/media folder.  Resolve through the guarded
    // media endpoint so the export/Agent page sees the same file as the editor.
    //
    // A1: a hash IS the asset's identity.  Media that carries one is served by
    // /@media/<hash> (vite-plugin-media resolves it in the local content store,
    // with the right Content-Type and Range support), so leave that address
    // alone — rewriting it by path would pin the renderer to one machine's
    // file layout and, from step 5 on, defeat tier switching.  Only migration
    // era media (no hash) is still rewritten by its durable path.  A hashed
    // asset that somehow still carries a page-private address (blob: / data:,
    // or nothing at all) gets the hash address instead — same rule as
    // vite-plugin-vision.ts's resolveMediaUrls, so both paths agree.
    if (m.hash) {
      const u = String(m.url || "");
      return !u || u.startsWith("blob:") || u.startsWith("data:") ? { ...m, url: `/@media/${m.hash}` } : m;
    }
    if (m.path && (!m.url || m.url.startsWith("blob:") || !m.url.startsWith("/@export/"))) {
      return { ...m, url: "/api/media/file?path=" + encodeURIComponent(String(m.path)) };
    }
    return m;
  }) };
}
export function framesPlugin(): Plugin {
  return { name: "promptcut-frames", configureServer(server) {
    const root = path.resolve(server.config.root);
    let remoteLease: { owner: string; url: string; at: number; ready: boolean } | null = null;
    const borrow = async (owner: string) => {
      const remote = prerenderState();
      if (isPrerender || !remote.ready || !remote.url) return false;
      if (remoteLease?.owner === owner && remoteLease.url === remote.url && Date.now() - remoteLease.at < 1000) return remoteLease.ready;
      try {
        const response = await fetch(remote.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, ttl: 5000 }), signal: AbortSignal.timeout(2000) });
        const result = await response.json();
        remoteLease = { owner, url: remote.url, at: Date.now(), ready: response.ok && result.yielded === true };
      } catch { remoteLease = { owner, url: remote.url, at: Date.now(), ready: false }; }
      return remoteLease.ready;
    };
    const release = async (owner: string) => {
      if (remoteLease?.owner !== owner) return;
      const lease = remoteLease; remoteLease = null;
      await fetch(lease.url + "/api/frames/yield", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, ttl: 0 }), signal: AbortSignal.timeout(1500) }).catch(() => {});
    };
    server.watcher.on("change", file => { if (/^(src|scripts)\//.test(path.relative(root, file).replaceAll("\\", "/"))) invalidateFrameCode(root); });
    server.httpServer?.once("close", () => { const s = services.get(root); services.delete(root); void s?.close(); });
    /*
     * D4(b) `/api/cards/layout`:Agent 的 `get_layout` —— 按 t 在**整场景**上实测实体框
     * (pinned 架构 4:Agent 的 query 跑预渲染进程;用户交互的 query 走自己的离屏舞台,不走这里)。
     * body `{ session, localRev, t, clipIds? }`,项目来路和 `/preload` / `/playback` / `/see`
     * 同一套(A7 的镜像前奏,迁移期仍收 `project`)。
     * 和 `/playback` 一样**两边都能答**:编辑器进程手里也有 FramePipeline,不另开一层转发。
     */
    server.middlewares.use("/api/cards/layout", (req, res, next) => {
      if (req.method !== "POST") return next();
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      let body = "", over = false;
      req.on("data", chunk => { if (!over) { body += chunk; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Layout request too large"); } });
      req.on("end", async () => {
        if (over) return;
        try {
          const input = JSON.parse(body || "{}");
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          if (input.t !== undefined && !Number.isFinite(input.t)) throw new Error("t 要是秒数");
          if (input.clipIds !== undefined && input.clipIds !== null && (!Array.isArray(input.clipIds) || input.clipIds.some((id: unknown) => typeof id !== "string")))
            throw new Error("clipIds 要是字符串数组");
          const service = frameService(root, origin);
          return json(200, await service.layout(project, { t: Number(input.t) || 0, clipIds: input.clipIds ?? null, signal: requestSignal(req, res) }));
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          json(status, { ok: false, code: timedOut ? "FRAME_TIMEOUT" : cancelled ? "FRAME_CANCELLED" : (error?.code || "LAYOUT_ERROR"),
            retryable: timedOut || status >= 500, error: error?.message || "实体框测量失败" });
        }
      });
    });
    server.middlewares.use("/api/frames", (req, res, next) => {
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const service = frameService(root, origin);
      const url = new URL(req.url || "/", origin);
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
      if (req.method === "GET") {
        const control = /^\/control\/([a-f0-9]{64})\/(\d{1,8})$/.exec(url.pathname);
        if (control) {
          void fsp.readFile(path.join(service.root, 'controls', control[1], 'mov', 'frames', control[2].padStart(6, '0') + '.png')).then(buf => {
            res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'private,max-age=31536000,immutable'); res.end(buf);
          }, () => json(404, { error: 'Control frame is not ready' })); return;
        }
        // The final cumulative render is used by the editor, while the
        // cumulative track renders are useful to callers that want to rebuild
        // only the edited upper part.  Keep both forms behind fixed-length
        // hexadecimal keys; no user supplied path segment reaches the disk.
        const final = /^\/([a-f0-9]{64})\/(preview\.mp4|mov\/full\.mov|mov\/playback-[a-f0-9-]{36}\.mov|mov\/frames\/\d{6}\.png|frames\/\d{6}\.png|preview-frames\/\d{6}\.png)$/.exec(url.pathname);
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
          res.setHeader("Content-Type", file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".mov") ? "video/quicktime" : "image/png");
          if (file.includes("playback-")) res.setHeader("Cache-Control", "no-store");
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
          if (url.pathname === "/yield") {
            if (typeof input.owner !== "string" || input.owner.length > 100) throw new Error("Invalid playback owner");
            if (input.ttl === 0) await service.resumeBackground(input.owner);
            else await service.yieldBackground(input.owner, 5000);
            return json(200, { yielded: input.ttl !== 0 });
          }
          /*
           * 项目从哪儿来(A7)。body 里带 `project` 的是迁移期的调用方(脚本、只读观看页、
           * 舞台页、导出页)—— 照旧用它。编辑页只带 `{session, localRev}`:按这个键从
           * **本进程**的镜像插件取,本进程没有就按 PROMPTCUT_EDITOR_URL 回拉一次。
           * 还是取不到就回 409 MIRROR_MISSING,页面整份重推之后重试。
           */
          let source = input.project;
          if (!source) {
            const version = await ensureMirror(String(input.session || ""), input.localRev);
            if (!version) return json(409, { error: `镜像里没有这一版项目(session=${input.session}, localRev=${input.localRev})，请整份重推后重试。`, code: "MIRROR_MISSING", retryable: true });
            source = version.project;
          }
          const project = renderProject(source);
          if (!Array.isArray(project.tracks) || !Number.isFinite(project.duration) || project.duration <= 0) throw new Error("Invalid project");
          const entry = await service.entry(project);
          if (url.pathname === "/playback") {
            if (typeof input.owner !== "string" || input.owner.length > 100 || !Number.isSafeInteger(input.sequence)
              || !Number.isFinite(input.t) || typeof input.playing !== "boolean" || (input.rate !== undefined && (!Number.isFinite(input.rate) || input.rate <= 0 || input.rate > 8))
              || (input.deliveryMs !== undefined && (!Number.isFinite(input.deliveryMs) || input.deliveryMs < 0 || input.deliveryMs > 5000))) throw new Error("Invalid playback clock");
            return json(200, await service.updatePlayback(project, input, { borrow, release }));
          }
          if (url.pathname === "/see") {
            const lane = input.lane === "agent" ? "agent" : input.lane === "background" ? "background" : "user";
            const frames = await service.see_frames(project, input.times || [0], { lane, signal: requestSignal(req, res) });
            const movReady = await fsp.access(path.join(entry.dir, "mov", "full.mov")).then(() => true, () => false);
            return json(200, { key: entry.key, incomplete: [...frames.values()].some((value: any) => value.incomplete),
              frames: [...frames].map(([frame, value]: any) => ({ frame, source: value.source, incomplete: !!value.incomplete, missing: value.missing || [],
                url: `/api/frames/${entry.key}/${value.incomplete ? 'preview-frames' : value.source === "mov" ? "mov/frames" : "frames"}/${String(frame).padStart(6, "0")}.png` })), mov: movReady ? `/api/frames/${entry.key}/mov/full.mov` : null });
          }
          if (url.pathname === "/preload") await service.preload(project);
          else if (url.pathname === "/import" && typeof input.snapshots === "string") {
            try {
              // Restore the control index together with the HTML.  It is built from
              // the same snapshots and lets callers address a component at its
              // local frame without sampling the whole project again.
              const archive = unpackFrameArchive(input.snapshots, entry.key, { spillDir: path.join(entry.dir, "html-cache") });
              entry.html = archive.frames;
              entry.controls = archive.controls;
              entry.createControl = archive.createControl;
              entry.disposeArchive?.(); entry.disposeArchive = archive.dispose;
              entry.recordVersion = (entry.recordVersion || 0) + 1;
              await service.save(entry);
            }
            catch { return json(200, { discarded: true }); }
          } else if (url.pathname === "/archive") {
            const snapshots = await service.portableArchive(entry);
            return json(200, { key: entry.key, snapshots, localOnly: snapshots === null });
          } else if (url.pathname !== "/status") return json(404, { error: "Unknown frame operation" });
          await entry.mov?.ready;
          const videoReady = await fsp.access(path.join(entry.dir, "preview.mp4")).then(() => true, () => false);
          const movReady = await fsp.access(path.join(entry.dir, "mov", "full.mov")).then(() => true, () => false);
          return json(200, { key: entry.key, status: entry.status, sampled: entry.html.size, movSampled: entry.mov ? [...(entry.mov.frames || [])].length : 0, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))), error: entry.error,
            video: videoReady ? `/api/frames/${entry.key}/preview.mp4` : null,
            mov: movReady ? `/api/frames/${entry.key}/mov/full.mov` : null });
        } catch (error: any) {
          const timedOut = Boolean(error?.timedOut || error?.code === "PRERENDER_TIMEOUT");
          const cancelled = Boolean(error?.cancelled || error?.name === "AbortError");
          const status = timedOut ? 504 : cancelled ? 499 : Number(error?.status) >= 500 ? Number(error.status) : 400;
          const code = timedOut ? "FRAME_TIMEOUT" : error?.superseded ? "FRAME_SUPERSEDED" : cancelled ? "FRAME_CANCELLED" : (error?.code || "FRAME_ERROR");
          if (status >= 500) console.error(`[frames] ${code}:`, error?.stack || error?.message || error);
          json(status, {
            ok: false,
            code,
            retryable: timedOut || status >= 500,
            error: error?.message || "帧渲染失败",
          });
        }
      });
    });
  } };
}
