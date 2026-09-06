import type { Plugin, ViteDevServer, Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import type { AddressInfo } from "net";

interface ExportJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  message?: string;
  outDir: string;
  /** 绝对路径,给「打开文件夹」和取件用;不回给浏览器以外的地方 */
  absOutDir: string;
  /** 渲染子进程,取消时要连它的子孙一起杀(它自己还会拉起 Chrome 和 ffmpeg) */
  child?: ReturnType<typeof spawn>;
  cancelled?: boolean;
}

/** 允许被浏览器取走的产物,白名单挡住任意读盘 */
const DELIVERABLES = ["preview.mp4", "overlay.mov"] as const;

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
      const job: ExportJob = { id, status: "running", done: 0, total: 1, outDir: relOutDir, absOutDir: outDir };
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
      job.child = child;

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
        job.child = undefined;
        if (job.cancelled) {
          job.status = "cancelled";
          job.message = "已取消";
        } else if (code === 0) {
          job.status = "done";
        } else {
          job.status = "error";
          const tail = stderrLog.join("").trim();
          // 0xC0000142 = STATUS_DLL_INIT_FAILED,子进程连 DLL 都没加载起来,
          // 所以 stderr 是空的。裸报一个十进制数字没人看得懂,这里给一句人话。
          job.message = tail
            || (code === 3221225794
              ? "渲染进程启动失败(0xC0000142)。通常是同时开了太多浏览器实例,关掉一些再试;若持续出现请重启软件。"
              : `渲染进程异常退出(代码 ${code})`);
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

/** 把某个产物流给浏览器。只认白名单里的文件名,不接受路径。 */
async function handleDeliverable(res: ServerResponse, id: string, name: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  if (!(DELIVERABLES as readonly string[]).includes(name)) {
    res.statusCode = 400;
    return res.end("Not a deliverable");
  }
  const file = path.resolve(job.absOutDir, name);
  // 名字来自白名单,这里再确认一次没跑出产物目录
  if (!file.startsWith(path.resolve(job.absOutDir) + path.sep)) {
    res.statusCode = 400;
    return res.end("Path escaped output dir");
  }
  try {
    const data = await fs.readFile(file);
    res.setHeader("Content-Type", name.endsWith(".mov") ? "video/quicktime" : "video/mp4");
    res.setHeader("Content-Length", String(data.length));
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("产物还没生成");
  }
}

/** 在文件管理器里定位产物目录。Windows 用 explorer,其余平台各按各的。 */
function handleReveal(res: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  const opener = process.platform === "win32" ? "explorer.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  // explorer 打开目录时返回码是 1,这不是失败,所以不看退出码
  spawn(opener, [job.absOutDir], { detached: true, stdio: "ignore" }).unref();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, dir: job.outDir }));
}

/**
 * 取消导出。渲染进程自己还会拉起 Chrome 和 ffmpeg,只杀它会留下孤儿,
 * 所以 Windows 上走 taskkill /T 把整棵进程树带走。
 */
function handleCancel(res: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  if (job.status === "running" && job.child) {
    job.cancelled = true;
    const pid = job.child.pid;
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      job.child.kill("SIGTERM");
    }
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
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
        
        // GET /api/export/<id>/file/<名字> —— 把产物交给浏览器,好让它写到用户
        // 用「另存为」挑的位置去(和保存项目走同一套 File System Access API)
        const fileMatch = req.method === "GET" && req.url.match(/^\/api\/export\/([^/]+)\/file\/([^/?]+)$/);
        if (fileMatch) {
          return handleDeliverable(res, fileMatch[1], decodeURIComponent(fileMatch[2]));
        }

        // POST /api/export/<id>/reveal —— 在文件管理器里打开产物目录
        const revealMatch = req.method === "POST" && req.url.match(/^\/api\/export\/([^/]+)\/reveal$/);
        if (revealMatch) {
          return handleReveal(res, revealMatch[1]);
        }

        // DELETE /api/export/<id> —— 取消
        const cancelMatch = req.method === "DELETE" && req.url.match(/^\/api\/export\/([^/?]+)$/);
        if (cancelMatch) {
          return handleCancel(res, cancelMatch[1]);
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
