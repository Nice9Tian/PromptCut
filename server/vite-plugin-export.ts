import type { Plugin, ViteDevServer, Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import type { AddressInfo } from "net";

interface ExportJob {
  id: string;
  status: "running" | "done" | "error";
  done: number;
  total: number;
  message?: string;
  outDir: string;
}

const jobs = new Map<string, ExportJob>();
let lastJobId: string | null = null;

function sanitizeFilename(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

/**
 * 导出根目录。桌面版里 root 是安装目录下的 runtime/app,成品不能落在那里(卸载会一起删),
 * 所以优先读壳设置的 PROMPTCUT_EXPORT_DIR(默认 %USERPROFILE%VideosPromptCut);开发期回落到 <root>/out。
 */
function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
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
  const stagingDir = path.resolve(outRoot(root), ".export-staging", "media");
  await fs.mkdir(stagingDir, { recursive: true });
  
  const destPath = path.resolve(stagingDir, safeName);
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    const buffer = Buffer.concat(chunks);
    await fs.writeFile(destPath, buffer);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ url: `/@export/media/${encodeURIComponent(safeName)}` }));
  });
}

async function handleExportStart(req: Connect.IncomingMessage, res: ServerResponse, server: ViteDevServer, root: string) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      let project = body;
      let frames: string | undefined;
      let fps: number | undefined;
      let noVideo: boolean | undefined;
      if (body.project) {
        project = body.project;
        frames = body.frames;
        fps = body.fps;
        noVideo = body.noVideo;
      }
      
      const now = new Date();
      const id = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const outDir = path.resolve(outRoot(root), `export-${id}`);
      const mediaDir = path.resolve(outDir, "media");
      await fs.mkdir(mediaDir, { recursive: true });
      
      // Move staging media
      const stagingDir = path.resolve(outRoot(root), ".export-staging", "media");
      try {
        const files = await fs.readdir(stagingDir);
        for (const file of files) {
          await fs.rename(path.resolve(stagingDir, file), path.resolve(mediaDir, file));
        }
      } catch (e) {
        // staging dir might not exist, ignore
      }
      
      // Rewrite media URLs in project
      if (project.media && Array.isArray(project.media)) {
        for (const m of project.media) {
          if (m.url && m.url.startsWith("/@export/media/")) {
            const fileName = m.url.split("/").pop();
            if (fileName) {
              m.url = `/@export/${id}/media/${fileName}`;
            }
          }
        }
      }
      
      const projectJsonPath = path.resolve(outDir, "project.json");
      await fs.writeFile(projectJsonPath, JSON.stringify(project, null, 2));
      
      lastJobId = id;
      // 回给浏览器的路径:开发期是相对项目根的 out/export-<id>,桌面版(设了 PROMPTCUT_EXPORT_DIR)给绝对路径
      const relOutDir = process.env.PROMPTCUT_EXPORT_DIR ? outDir : `out/export-${id}`;
      const job: ExportJob = { id, status: "running", done: 0, total: 1, outDir: relOutDir };
      jobs.set(id, job);
      
      // Spawn child process
      let port = server.config.server.port;
      if (!port) {
        const address = server.httpServer?.address() as AddressInfo;
        port = address?.port || 5190;
      }
      
      const args = [
        "scripts/export-frames.mjs",
        "--url",
        `http://127.0.0.1:${port}/?export=1&timeline=/@export/${id}/project.json`,
        "--out",
        relOutDir
      ];
      if (frames) {
        args.push("--frames", frames);
      }
      if (fps) {
        args.push("--fps", String(fps));
      }
      if (noVideo) {
        args.push("--no-video");
      }
      
      const child = spawn(process.execPath, args, { cwd: root });
      
      let stderrLog: string[] = [];
      child.stdout.on("data", (data) => {
        const str = data.toString();
        // Exported frame 0 (1/90)
        const progressMatch = str.match(/Exported frame \d+ \((\d+)\/(\d+)\)/);
        if (progressMatch) {
          job.done = parseInt(progressMatch[1], 10);
          job.total = parseInt(progressMatch[2], 10);
        }
      });
      
      child.stderr.on("data", (data) => {
        stderrLog.push(data.toString());
        if (stderrLog.length > 10) stderrLog.shift();
      });
      
      child.on("close", (code) => {
        if (code === 0) {
          job.status = "done";
        } else {
          job.status = "error";
          job.message = stderrLog.join("").trim() || `Exited with code ${code}`;
        }
      });
      
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id, outDir: relOutDir }));
    } catch (err: unknown) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
}

function handleProgress(req: Connect.IncomingMessage, res: ServerResponse) {
  // /api/export/<id>
  const parts = req.url?.split("/") || [];
  const id = parts.pop()?.split("?")[0];
  if (!id) {
    res.statusCode = 400;
    res.end("Missing ID");
    return;
  }
  
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    res.end("Job not found");
    return;
  }
  
  const isSSE = req.headers.accept === "text/event-stream" || req.url?.includes("sse=1");
  if (isSSE) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    const sendEvent = () => {
      res.write(`data: ${JSON.stringify({ done: job.done, total: job.total, status: job.status, message: job.message })}\n\n`);
    };
    
    sendEvent();
    
    if (job.status !== "running") {
      res.end();
      return;
    }
    
    const interval = setInterval(() => {
      sendEvent();
      if (job.status !== "running") {
        clearInterval(interval);
        res.end();
      }
    }, 500);
    
    req.on("close", () => {
      clearInterval(interval);
    });
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ done: job.done, total: job.total, status: job.status, message: job.message }));
  }
}

async function serveFile(filePath: string, req: Connect.IncomingMessage, res: ServerResponse) {
  try {
    const stat = await fs.stat(filePath);
    const range = req.headers.range;
    
    let contentType = "application/octet-stream";
    if (filePath.endsWith(".json")) contentType = "application/json";
    else if (filePath.endsWith(".mp4")) contentType = "video/mp4";
    else if (filePath.endsWith(".webm")) contentType = "video/webm";
    else if (filePath.endsWith(".mov")) contentType = "video/quicktime";
    else if (filePath.endsWith(".png")) contentType = "image/png";
    
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

export function exportPlugin(): Plugin {
  return {
    name: "vite-plugin-export",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        
        // POST /api/export/media/<文件名>
        if (req.method === "POST" && req.url.startsWith("/api/export/media/")) {
          return handleMediaUpload(req, res, root);
        }
        
        // POST /api/export
        if (req.method === "POST" && req.url === "/api/export") {
          return handleExportStart(req, res, server, root);
        }
        
        // GET /api/export/<id>
        if (req.method === "GET" && req.url.startsWith("/api/export/")) {
          return handleProgress(req, res);
        }
        
        // GET /@export/<id>/project.json or /@export/project.json
        if (req.method === "GET" && req.url.startsWith("/@export/")) {
          const url = req.url.split("?")[0];
          let match = url.match(/^\/@export\/([^/]+)\/project\.json$/);
          if (match) {
            const id = match[1];
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "project.json"), req, res);
          }
          if (url === "/@export/project.json") {
            if (!lastJobId) return res.end("{}");
            return serveFile(path.resolve(outRoot(root), `export-${lastJobId}`, "project.json"), req, res);
          }
          
          match = url.match(/^\/@export\/([^/]+)\/media\/(.+)$/);
          if (match) {
            const id = match[1];
            const name = sanitizeFilename(decodeURIComponent(match[2]));
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "media", name), req, res);
          }
          match = url.match(/^\/@export\/media\/(.+)$/);
          if (match) {
            const name = sanitizeFilename(decodeURIComponent(match[1]));
            if (lastJobId) {
              const checkPath = path.resolve(outRoot(root), `export-${lastJobId}`, "media", name);
              try {
                await fs.access(checkPath);
                return serveFile(checkPath, req, res);
              } catch (e) {
                // fall back to staging
              }
            }
            return serveFile(path.resolve(outRoot(root), ".export-staging", "media", name), req, res);
          }
        }
        
        next();
      });
    }
  };
}
