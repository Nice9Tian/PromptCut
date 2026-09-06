import type { Plugin } from "vite";
import type { Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { spawn, ChildProcess } from "child_process";

// 运行中的 job: jobId → child process
const activeJobs = new Map<string, ChildProcess>();

function sanitizeName(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

/** 按文档顺序查找内置 Python 解释器路径;找不到返回 null */
export function findPython(root: string): string | null {
  if (process.env.PROMPTCUT_PYTHON) {
    if (existsSync(process.env.PROMPTCUT_PYTHON)) return process.env.PROMPTCUT_PYTHON;
  }
  const candidate1 = path.join(root, "desktop", "src-tauri", "runtime", "python", "python.exe");
  if (existsSync(candidate1)) return candidate1;
  const candidate2 = path.join(root, "python", ".venv", "Scripts", "python.exe");
  if (existsSync(candidate2)) return candidate2;
  return null;
}

/**
 * 启动解释器。
 * Node 18.20+/20+ 在 Windows 上拒绝直接 spawn .cmd/.bat(EINVAL),
 * 这类解释器要经 cmd.exe /c 转一手。参数仍按数组传,不拼命令行,避免注入。
 */
export function spawnPython(pythonPath: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const lower = pythonPath.toLowerCase();
  if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    return spawn("cmd.exe", ["/c", pythonPath, ...args], { env, windowsHide: true });
  }
  return spawn(pythonPath, args, { env, windowsHide: true });
}

/** 数据目录(stt job 文件落盘位置) */
export function dataDir(root: string): string {
  return process.env.PROMPTCUT_DATA_DIR ?? path.join(root, "out");
}

/** 组装子进程的环境变量 */
export async function buildEnv(root: string, pythonPath: string): Promise<NodeJS.ProcessEnv> {
  const pyLibs = process.env.PROMPTCUT_PYLIBS ?? path.join(root, "out", "pylibs");
  const models = process.env.PROMPTCUT_MODELS ?? path.join(root, "out", "models");

  await fs.mkdir(pyLibs, { recursive: true });
  await fs.mkdir(models, { recursive: true });

  // 判断 promptcut_stt 是否已在 site-packages 里
  const pythonDir = path.dirname(pythonPath);
  // 按包逐个判断,不能只看 promptcut_stt:自带解释器的 site-packages 里有 stt、
  // 却没有后加的 promptcut_shots,一旦只看前者就会整段跳过,镜头识别永远报
  // No module named。
  const PACKAGES = ["promptcut_stt", "promptcut_shots", "promptcut_track"];
  const missing = PACKAGES.filter(
    (pkg) => !existsSync(path.join(pythonDir, "Lib", "site-packages", pkg)),
  );

  let pythonPathEnv = pyLibs;
  if (missing.length > 0) {
    // 普通 venv 解释器认 PYTHONPATH,追加源码目录即可。
    pythonPathEnv = pyLibs + path.delimiter + path.join(root, "python");

    // 但随包分发的 embeddable 解释器带 python311._pth,一旦存在 ._pth,
    // Python 会**完全忽略 PYTHONPATH**(与加不加 -I 无关)。它认的是
    // site-packages 里那个 promptcut_pylibs.pth 钩子 —— 那个钩子把
    // PROMPTCUT_PYLIBS 指向的目录挂到 sys.path。而 PROMPTCUT_PYLIBS 又要
    // 原样交给 pip 的 --target,不能塞成多段路径。
    // 所以开发期把源码包镜像一份到 pylibs 里,让钩子顺带把它带上。
    // 正式包里 prepare-python 会把这些包复制进 site-packages,走不到这里。
    const hasPthFile = (await fs.readdir(pythonDir).catch(() => [] as string[]))
      .some((f) => f.toLowerCase().endsWith("._pth"));
    if (hasPthFile) {
      // 只镜像缺的那些。镜头识别还 import 了 promptcut_stt.jsonl,所以哪怕
      // 只缺 shots,stt 不在 site-packages 时也得一起搬。
      for (const pkg of missing) {
        const src = path.join(root, "python", pkg);
        if (!existsSync(src)) continue;
        try {
          await fs.cp(src, path.join(pyLibs, pkg), {
            recursive: true,
            force: true,
            filter: (s) => !s.includes("__pycache__"),
          });
        } catch { /* 镜像失败就让 Python 自己报 No module named,便于定位 */ }
      }
    }
  }

  // ffmpeg 路径:依次尝试三处
  const ffmpegBundled = path.join(root, "desktop", "src-tauri", "runtime", "ffmpeg");
  const ffmpegEnv = process.env.PROMPTCUT_FFMPEG_DIR;
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const ffmpegWinget = path.join(
    localAppData,
    "Microsoft", "WinGet", "Packages",
    "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "ffmpeg-9.0.1-full_build", "bin"
  );

  let pathPrefix = "";
  if (existsSync(ffmpegBundled)) {
    pathPrefix = ffmpegBundled + path.delimiter;
  } else if (ffmpegEnv && existsSync(ffmpegEnv)) {
    pathPrefix = ffmpegEnv + path.delimiter;
  } else if (existsSync(ffmpegWinget)) {
    pathPrefix = ffmpegWinget + path.delimiter;
  }

  return {
    ...process.env,
    PYTHONPATH: pythonPathEnv,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PROMPTCUT_PYLIBS: pyLibs,
    PROMPTCUT_MODELS: models,
    PATH: pathPrefix + (process.env.PATH ?? ""),
  };
}

/** 把 Python 的 JSONL stdout + stderr 转成 SSE 流 */
export function pipeToSse(child: ChildProcess, res: ServerResponse): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders?.();

  let buf = "";
  let hasDone = false;
  const stderrLines: string[] = [];

  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line); // 验证合法 JSON
        if (line.includes('"event":"done"')) hasDone = true;
        res.write("data: " + line + "\n\n");
      } catch {
        const wrapped = JSON.stringify({ event: "log", line });
        res.write("data: " + wrapped + "\n\n");
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      stderrLines.push(l);
      if (stderrLines.length > 50) stderrLines.shift();
      const wrapped = JSON.stringify({ event: "log", stream: "stderr", line: l });
      res.write("data: " + wrapped + "\n\n");
    }
  });

  child.on("close", (code) => {
    // 刷剩余缓冲
    if (buf.trim()) {
      try {
        JSON.parse(buf);
        if (buf.includes('"event":"done"')) hasDone = true;
        res.write("data: " + buf + "\n\n");
      } catch {
        const wrapped = JSON.stringify({ event: "log", line: buf });
        res.write("data: " + wrapped + "\n\n");
      }
    }
    if (code !== 0 && !hasDone) {
      const tail = stderrLines.slice(-10).join("\n");
      const errEvent = JSON.stringify({ event: "error", message: `进程退出码 ${code}`, stderr: tail });
      res.write("data: " + errEvent + "\n\n");
    }
    res.end();
  });
}

/** 从 req body 读取全部字节 */
export function readBody(req: Connect.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Windows 下递归杀掉子进程树 */
function killJob(jobId: string): boolean {
  const child = activeJobs.get(jobId);
  if (!child) return false;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch { /* ignore */ }
  activeJobs.delete(jobId);
  return true;
}

export function sttPlugin(): Plugin {
  return {
    name: "vite-plugin-stt",
    configureServer(server) {
      const root = server.config.root;

      server.middlewares.use(async (req: Connect.IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url) return next();
        const url = req.url.split("?")[0];

        // ── GET /api/stt/status ──────────────────────────────────────
        if (req.method === "GET" && url === "/api/stt/status") {
          const python = findPython(root);
          if (!python) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "内置 Python 未就绪,先跑 npm run prepare-python" }));
            return;
          }
          try {
            const env = await buildEnv(root, python);
            const child = spawnPython(python, ["-I", "-m", "promptcut_stt", "status"], env);
            let out = "";
            let err = "";
            child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
            child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
            child.on("close", (_code) => {
              try {
                const parsed = JSON.parse(out.trim());
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(parsed));
              } catch {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Python 输出解析失败", raw: out, stderr: err }));
              }
            });
          } catch (e: unknown) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        // ── POST /api/stt/install ────────────────────────────────────
        if (req.method === "POST" && url === "/api/stt/install") {
          const python = findPython(root);
          if (!python) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "内置 Python 未就绪,先跑 npm run prepare-python" }));
            return;
          }
          try {
            const body = await readBody(req);
            const { engine } = JSON.parse(body.toString("utf-8"));
            const env = await buildEnv(root, python);
            const child = spawnPython(
              python,
              ["-I", "-m", "promptcut_stt", "install", "--engine", engine ?? "faster-whisper"],
              env
            );
            req.on("close", () => { try { child.kill(); } catch { /* ignore */ } });
            pipeToSse(child, res);
          } catch (e: unknown) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        // ── POST /api/stt/upload/<jobId>/<filename> ──────────────────
        if (req.method === "POST" && url.startsWith("/api/stt/upload/")) {
          const parts = url.slice("/api/stt/upload/".length).split("/");
          if (parts.length < 2) {
            res.statusCode = 400;
            res.end("Missing jobId or filename");
            return;
          }
          const jobId = parts[0];
          const rawName = decodeURIComponent(parts.slice(1).join("/"));
          const ext = path.extname(sanitizeName(rawName)) || ".bin";
          const jobDir = path.join(dataDir(root), "stt", jobId);
          await fs.mkdir(jobDir, { recursive: true });
          const inputPath = path.join(jobDir, `input${ext}`);
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", async () => {
            try {
              await fs.writeFile(inputPath, Buffer.concat(chunks));
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, jobId, inputPath }));
            } catch (e: unknown) {
              res.statusCode = 500;
              res.end(String(e));
            }
          });
          return;
        }

        // ── POST /api/stt/transcribe ─────────────────────────────────
        if (req.method === "POST" && url === "/api/stt/transcribe") {
          const python = findPython(root);
          if (!python) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "内置 Python 未就绪,先跑 npm run prepare-python" }));
            return;
          }
          try {
            const body = await readBody(req);
            const { jobId, engine, model, language } = JSON.parse(body.toString("utf-8"));
            if (!jobId) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "jobId 必须" }));
              return;
            }

            const jobDir = path.join(dataDir(root), "stt", jobId);
            // 找 input 文件
            let inputPath: string | null = null;
            try {
              const files = await fs.readdir(jobDir);
              const inp = files.find((f) => f.startsWith("input."));
              if (inp) inputPath = path.join(jobDir, inp);
            } catch { /* ignore */ }

            if (!inputPath) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: `找不到 ${jobId} 的上传文件,先调 /api/stt/upload` }));
              return;
            }

            const resultPath = path.join(jobDir, "result.json");
            const spawnArgs = [
              "-I", "-m", "promptcut_stt", "transcribe",
              "--input", inputPath,
              "--engine", engine ?? "faster-whisper",
              "--model", model ?? "small",
              "--out", resultPath,
            ];
            if (language) spawnArgs.push("--language", language);

            const env = await buildEnv(root, python);
            const child = spawnPython(python, spawnArgs, env);
            activeJobs.set(jobId, child);

            req.on("close", () => {
              if (activeJobs.get(jobId) === child) {
                killJob(jobId);
              }
            });

            child.on("close", () => {
              activeJobs.delete(jobId);
            });

            pipeToSse(child, res);
          } catch (e: unknown) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        // ── DELETE /api/stt/job/<id> ─────────────────────────────────
        if (req.method === "DELETE" && url.startsWith("/api/stt/job/")) {
          const jobId = url.slice("/api/stt/job/".length);
          const killed = killJob(jobId);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, killed }));
          return;
        }

        next();
      });
    },
  };
}
