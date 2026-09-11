import type { Plugin, ViteDevServer, Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import os from "os";

function sanitizeFilename(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

function inside(file: string, dir: string): boolean {
  const target = path.resolve(file);
  const base = path.resolve(dir);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Old .proc files store an absolute path from the desktop media library.  The
 * browser cannot read that path directly, so expose only the two media roots
 * owned by PromptCut (current out/media and the legacy Videos/PromptCut/media
 * folder).  The path is never accepted as an arbitrary file read.
 */
function allowedMediaRoots(root: string): string[] {
  const roots = [mediaDir(root)];
  const legacy = path.join(os.homedir(), "Videos", "PromptCut", "media");
  roots.push(legacy);
  if (process.env.PROMPTCUT_MEDIA_DIR) roots.push(path.resolve(process.env.PROMPTCUT_MEDIA_DIR));
  return roots;
}

async function handleMediaFile(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  try {
    const query = new URL(req.url || "/", "http://promptcut.local").searchParams;
    const raw = query.get("path");
    if (!raw) { res.statusCode = 400; return res.end("Missing media path"); }
    const file = path.resolve(raw);
    const roots = allowedMediaRoots(root);
    if (!roots.some((dir) => inside(file, dir))) {
      res.statusCode = 403;
      return res.end("Media path is outside PromptCut media folders");
    }
    return serveFile(file, req, res);
  } catch {
    res.statusCode = 400;
    res.end("Invalid media path");
  }
}

/**
 * 素材落盘目录。上传和素材收集(vite-plugin-collect)都往这里写,
 * 所以 /@media/<文件名> 对两边的文件都能取到。
 */
export function mediaDir(root: string): string {
  return path.resolve(outRoot(root), "media");
}

async function handleMediaUpload(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  const rawName = req.url?.split("/").pop();
  if (!rawName) {
    res.statusCode = 400;
    res.end("Missing filename");
    return;
  }
  const name = decodeURIComponent(rawName);
  const safeName = sanitizeFilename(name);
  const dir = mediaDir(root);
  await fs.mkdir(dir, { recursive: true });

  const destPath = path.resolve(dir, safeName);
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const buffer = Buffer.concat(chunks);
      await fs.writeFile(destPath, buffer);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        path: destPath,
        url: `/@media/${encodeURIComponent(safeName)}`,
        bytes: buffer.length
      }));
    } catch (err: unknown) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
}

async function serveFile(filePath: string, req: Connect.IncomingMessage, res: ServerResponse) {
  try {
    const stat = await fs.stat(filePath);
    const range = req.headers.range;
    
    let contentType = "application/octet-stream";
    if (filePath.endsWith(".mp4")) contentType = "video/mp4";
    else if (filePath.endsWith(".webm")) contentType = "video/webm";
    else if (filePath.endsWith(".mov")) contentType = "video/quicktime";
    else if (filePath.endsWith(".mp3")) contentType = "audio/mpeg";
    else if (filePath.endsWith(".m4a")) contentType = "audio/mp4";
    else if (filePath.endsWith(".wav")) contentType = "audio/wav";
    else if (filePath.endsWith(".png")) contentType = "image/png";
    else if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) contentType = "image/jpeg";
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType,
      });
      
      const stream = (await import("fs")).createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      const stream = (await import("fs")).createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (err) {
    res.statusCode = 404;
    res.end("Not found");
  }
}

export function mediaPlugin(): Plugin {
  return {
    name: "vite-plugin-media",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        
        // POST /api/media/upload/<文件名>
        if (req.method === "POST" && req.url.startsWith("/api/media/upload/")) {
          return handleMediaUpload(req, res, root);
        }

        // GET /api/media/file?path=<legacy absolute path>
        if (req.method === "GET" && req.url.startsWith("/api/media/file")) {
          return handleMediaFile(req, res, root);
        }
        
        // GET /@media/<文件名>
        if (req.method === "GET" && req.url.startsWith("/@media/")) {
          const rawName = req.url.split("?")[0].split("/").pop();
          if (rawName) {
            const name = sanitizeFilename(decodeURIComponent(rawName));
            return serveFile(path.resolve(mediaDir(root), name), req, res);
          }
        }
        
        next();
      });
    }
  };
}
