import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse, IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Skill 模式:把当前项目交给桌面版的 Claude Code / Codex 去改,改完再合回来。
 *
 * 一次「任务」= 项目根 .pc-work/skill/<id>/ 下的一个目录:
 *   1. 快照当前项目成 base.proc 和 project.proc;
 *   2. 起一份无头 PromptCut(scripts/headless.mjs):自己的端口、自己的草稿目录(就是这个任务目录),
 *      和用户正在用的实例完全隔离;
 *   3. 往目录里放 CLAUDE.md / SKILL.md / AGENTS.md / .mcp.json,agent 一进来就知道该干什么;
 *   4. 用深链拉起桌面 app 的新对话(Claude: claude://code/new?folder=…&q=/promptcut;
 *      Codex: codex app <目录> + codex://threads/new?prompt=…);
 *   5. agent 干完回复里带 project.proc 的 file:// 链接;用户回到这里点「合并」做三方合并。
 *
 * 另外还管「按路径打开 .proc」:先复制到 .pc-work/opened/ 再给前端,原文件不占、不改。
 */

type Provider = "claude" | "codex";
type Phase = "snapshot" | "booting" | "launching" | "ready" | "failed" | "stopped";

interface JobMeta {
  id: string;
  provider: Provider;
  name: string;
  createdAt: string;
  phase: Phase;
  error?: string;
  /** 只起实例、不拉桌面 app(自检和排错用) */
  noLaunch?: boolean;
  /** 最近一次拉起桌面 app 的方式,给对话框显示和排错 */
  launch?: { kind: string; detail: string; at: string };
}

interface Instance {
  ready?: boolean;
  port?: number;
  pid?: number;
  vitePid?: number;
  dirty?: boolean;
  savedAt?: string | null;
  stopped?: boolean;
  error?: string;
  clips?: number;
}

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) {
        req.destroy();
        reject(new Error("请求太大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error("读取请求体失败")));
  });
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function jobsRoot(root: string) {
  const dir = path.join(root, ".pc-work", "skill");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeMeta(dir: string, meta: JobMeta) {
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(meta, null, 2), "utf8");
}

/** 打开一个 URL 协议(claude:// codex://)。rundll32 不经过 cmd,不用操心引号 */
function openUrl(url: string) {
  if (process.platform === "win32") {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function revealDir(dir: string) {
  const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(opener, [dir], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

/**
 * 拉起桌面 app 的新对话。
 *
 * Claude:一条深链搞定,handler 读 folder + q。q 给 /promptcut,skill 在目录里。
 * Codex:先 `codex app <目录>` 把工作区开到任务目录,再用 codex://threads/new?prompt= 开新线程。
 *   两步之间留几秒,app 没起来时深链会被吞掉。
 */
function launchDesktop(provider: Provider, dir: string): { kind: string; detail: string } {
  if (provider === "claude") {
    const url = `claude://code/new?folder=${encodeURIComponent(dir)}&q=${encodeURIComponent("/promptcut")}`;
    openUrl(url);
    return { kind: "claude-deeplink", detail: url };
  }
  const prompt = "先读这个目录里的 AGENTS.md,按它的流程开始;干完把 project.proc 的链接给我";
  const url = `codex://threads/new?prompt=${encodeURIComponent(prompt)}`;
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/s", "/c", `codex app "${dir}"`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    spawn("codex", ["app", dir], { detached: true, stdio: "ignore" }).unref();
  }
  setTimeout(() => openUrl(url), 6000);
  return { kind: "codex-app+deeplink", detail: `codex app "${dir}" → ${url}` };
}

/**
 * 按磁盘路径打开一份 .proc:双击文件、桌面壳启动参数、Skill 结果链接都走这里。
 * **先复制到 .pc-work/opened/ 再读副本**:原文件不被占用、不被改,双击一份别人正在编辑的
 * .proc 不会互相踩。
 */
async function openPath(root: string, req: IncomingMessage, res: ServerResponse) {
  const { path: raw } = JSON.parse((await readBody(req)) || "{}");
  const src = path.resolve(String(raw || ""));
  if (!/\.(proc|json)$/i.test(src)) return sendJson(res, 400, { ok: false, error: "只认 .proc / .json" });
  if (!fs.existsSync(src)) return sendJson(res, 404, { ok: false, error: `文件不存在:${src}` });
  const text = fs.readFileSync(src, "utf8");
  JSON.parse(text);
  const name = path.basename(src);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(root, ".pc-work", "opened", `${stamp}-${name.replace(/[\\/:*?"<>|]/g, "")}`);
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, name);
  fs.copyFileSync(src, copy);
  return sendJson(res, 200, { ok: true, text, name, copy, original: src });
}

export function skillPlugin(): Plugin {
  return {
    name: "promptcut-skill",
    configureServer(server: ViteDevServer) {
      const root = server.config.root || process.cwd();

      const jobDir = (id: string) => (ID_RE.test(id) ? path.join(jobsRoot(root), id) : null);

      const describe = (id: string) => {
        const dir = jobDir(id);
        if (!dir || !fs.existsSync(dir)) return null;
        const meta = readJsonSafe<JobMeta>(path.join(dir, "job.json"));
        if (!meta) return null;
        const inst = readJsonSafe<Instance>(path.join(dir, "instance.json"));
        const alive = !!inst && !inst.stopped && pidAlive(inst.pid);
        let phase = meta.phase;
        // 实例真死了而 meta 还说 ready,以文件系统为准
        if ((phase === "ready" || phase === "launching") && !alive && !inst?.stopped && meta.createdAt < new Date(Date.now() - 10000).toISOString()) {
          phase = inst?.error ? "failed" : phase === "ready" ? "stopped" : phase;
        }
        if (inst?.stopped) phase = "stopped";
        const procFile = path.join(dir, "project.proc");
        const procStat = fs.existsSync(procFile) ? fs.statSync(procFile) : null;
        return {
          ...meta,
          phase,
          dir,
          alive,
          port: inst?.port ?? null,
          dirty: inst?.dirty ?? null,
          savedAt: inst?.savedAt ?? null,
          clips: inst?.clips ?? null,
          instanceError: inst?.error ?? null,
          procUpdatedAt: procStat ? procStat.mtime.toISOString() : null,
          procUrl: "file:///" + procFile.replace(/\\/g, "/"),
        };
      };

      /** 起实例、等就绪、拉桌面 app。异步跑,进度写进 job.json 由前端轮询 */
      const boot = async (id: string, meta: JobMeta) => {
        const dir = jobDir(id)!;
        const update = (patch: Partial<JobMeta>) => {
          meta = { ...meta, ...patch };
          writeMeta(dir, meta);
        };
        try {
          update({ phase: "booting" });
          const script = path.join(root, "scripts", "headless.mjs");
          const logFd = fs.openSync(path.join(dir, "headless.out.log"), "a");
          const child = spawn(process.execPath, [script, "--job", dir], {
            cwd: root,
            detached: true,
            stdio: ["ignore", logFd, logFd],
            windowsHide: true,
            env: { ...process.env },
          });
          child.unref();

          const deadline = Date.now() + 120000;
          let inst: Instance | null = null;
          while (Date.now() < deadline) {
            inst = readJsonSafe<Instance>(path.join(dir, "instance.json"));
            if (inst?.ready) break;
            if (inst?.error) throw new Error(inst.error);
            if (child.exitCode !== null && !inst?.ready) throw new Error(`无头实例退出了(code ${child.exitCode}),看 ${path.join(dir, "headless.log")}`);
            await new Promise((r) => setTimeout(r, 500));
          }
          if (!inst?.ready) throw new Error("无头实例 120 秒内没就绪,看 headless.log");

          update({ phase: "launching" });
          // 实例端口定了才能写 .mcp.json / 说明文件 —— 里面要带端口
          const tpl = await import(new URL("./skill-templates.mjs", import.meta.url).href);
          const ctx = { jobDir: dir, root, port: inst.port!, provider: meta.provider, createdAt: meta.createdAt };
          fs.mkdirSync(path.join(dir, ".claude", "skills", "promptcut"), { recursive: true });
          fs.writeFileSync(path.join(dir, ".claude", "skills", "promptcut", "SKILL.md"), tpl.claudeSkillMd(ctx), "utf8");
          fs.writeFileSync(path.join(dir, "CLAUDE.md"), tpl.claudeMd(ctx), "utf8");
          fs.writeFileSync(path.join(dir, "AGENTS.md"), tpl.agentsMd(ctx), "utf8");
          fs.writeFileSync(path.join(dir, ".mcp.json"), tpl.mcpJson(ctx), "utf8");
          fs.writeFileSync(path.join(dir, "README.md"), tpl.readmeMd(ctx), "utf8");

          if (meta.noLaunch) {
            update({ phase: "ready" });
          } else {
            const launch = launchDesktop(meta.provider, dir);
            update({ phase: "ready", launch: { ...launch, at: new Date().toISOString() } });
          }
        } catch (e) {
          update({ phase: "failed", error: (e as Error).message });
          try { fs.writeFileSync(path.join(dir, "stop"), ""); } catch {}
        }
      };

      server.middlewares.use("/api/skill", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
        try {
          // POST /api/skill/open-path —— 挂在同一条路由里:connect 按前缀匹配,
          // 单独注册 /api/skill/open-path 会被这条先截住,永远走不到
          if (parts[0] === "open-path" && req.method === "POST") return await openPath(root, req, res);

          // POST /api/skill/start
          if (parts[0] === "start" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const provider: Provider = body.provider === "codex" ? "codex" : "claude";
            const proc = String(body.proc || "");
            JSON.parse(proc); // 坏 JSON 别落盘
            const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
            const id = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
            const dir = jobDir(id)!;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "base.proc"), proc, "utf8");
            fs.writeFileSync(path.join(dir, "project.proc"), proc, "utf8");
            const meta: JobMeta = {
              id,
              provider,
              name: String(body.name || "未命名").slice(0, 80),
              createdAt: new Date().toISOString(),
              phase: "snapshot",
              noLaunch: body.noLaunch === true,
            };
            writeMeta(dir, meta);
            void boot(id, meta);
            return sendJson(res, 200, { ok: true, job: describe(id) });
          }

          // GET /api/skill/jobs
          if (parts[0] === "jobs" && parts.length === 1 && req.method === "GET") {
            const ids = fs.readdirSync(jobsRoot(root)).filter((f) => ID_RE.test(f));
            const jobs = ids.map(describe).filter(Boolean).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt));
            return sendJson(res, 200, { ok: true, jobs });
          }

          if (parts[0] === "jobs" && parts[1]) {
            const id = parts[1];
            const job = describe(id);
            if (!job) return sendJson(res, 404, { ok: false, error: "没有这个任务" });
            const dir = job.dir;
            const action = parts[2];

            if (!action && req.method === "GET") return sendJson(res, 200, { ok: true, job });

            if (action === "proc" && req.method === "GET") {
              const f = path.join(dir, "project.proc");
              if (!fs.existsSync(f)) return sendJson(res, 404, { ok: false, error: "还没有 project.proc" });
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              return res.end(fs.readFileSync(f, "utf8"));
            }
            if (action === "base" && req.method === "GET") {
              const f = path.join(dir, "base.proc");
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              return res.end(fs.readFileSync(f, "utf8"));
            }
            if (action === "stop" && req.method === "POST") {
              fs.writeFileSync(path.join(dir, "stop"), "", "utf8");
              const inst = readJsonSafe<Instance>(path.join(dir, "instance.json"));
              // 3 秒还没自己收工就硬杀
              setTimeout(() => {
                if (pidAlive(inst?.pid) && process.platform === "win32") {
                  spawn("taskkill", ["/PID", String(inst!.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
                } else if (pidAlive(inst?.pid)) {
                  try { process.kill(inst!.pid!, "SIGTERM"); } catch {}
                }
              }, 3000);
              const meta = readJsonSafe<JobMeta>(path.join(dir, "job.json"));
              if (meta) writeMeta(dir, { ...meta, phase: "stopped" });
              return sendJson(res, 200, { ok: true });
            }
            if (action === "relaunch" && req.method === "POST") {
              if (!job.alive) return sendJson(res, 400, { ok: false, error: "实例已经停了,重新开一个任务吧" });
              const launch = launchDesktop(job.provider, dir);
              const meta = readJsonSafe<JobMeta>(path.join(dir, "job.json"));
              if (meta) writeMeta(dir, { ...meta, launch: { ...launch, at: new Date().toISOString() } });
              return sendJson(res, 200, { ok: true, launch });
            }
            if (action === "reveal" && req.method === "POST") {
              revealDir(dir);
              return sendJson(res, 200, { ok: true });
            }
            if (action === "delete" && req.method === "POST") {
              if (job.alive) return sendJson(res, 400, { ok: false, error: "先停掉实例再删" });
              fs.rmSync(dir, { recursive: true, force: true });
              return sendJson(res, 200, { ok: true });
            }
          }
          return sendJson(res, 404, { ok: false, error: "没有这个接口" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });

    },
  };
}

export default skillPlugin;
