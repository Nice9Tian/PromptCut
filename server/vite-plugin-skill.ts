import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse, IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createCodexTask } from "./codex-desktop";

/**
 * Skill 模式:把当前项目交给桌面版的 Claude Code / Codex 去改,改完再合回来。
 *
 * 一次「任务」= Documents/PromptCut-Skill/<id>/ 下的一个目录:
 *   1. 快照当前项目成 base.proc 和 project.proc;
 *   2. 起一份无头 PromptCut(scripts/headless.mjs):自己的端口、自己的草稿目录(就是这个任务目录),
 *      和用户正在用的实例完全隔离;
 *   3. 往目录里放 CLAUDE.md / SKILL.md / AGENTS.md / .mcp.json,agent 一进来就知道该干什么;
 *   4. 用深链拉起桌面 app 的新对话(Claude: claude://code/new?folder=…&q=/promptcut;
 *      Codex: app-server 创建无项目归属的线程 + codex://threads/<id>);
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
  launch?: { kind: string; detail: string; at: string; autoSend?: AutoSend; status?: "launching" | "ready" | "failed"; projectId?: string | null; workspaceMode?: "projectless"; threadId?: string; cwd?: string; initialState?: "dispatching" | "completed" };
}

/** 替用户按回车的结果:发了 / 桌面 app 没到前台没敢发 / 脚本出错 / 非 Windows 跳过 */
type AutoSend = "sent" | "nofocus" | "error" | "skipped";

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

/**
 * 任务目录放哪儿:**仓库外面**,而且**不能放 %LOCALAPPDATA%**。
 *
 * 放仓库外的理由:原来在 <仓库>/.pc-work/skill/ 下,Codex 的工作区标签写着仓库名,
 * 看着就像「它在改我的源码」;而且 agent 的工作区里躺着整个代码库,它随时可能翻进去。
 * 搬出来之后一个任务目录就是一个干净的独立项目,里面只有这次任务要用的东西。
 *
 * 不放 %LOCALAPPDATA% 的理由(踩过):PromptCut 有可能跑在一个 MSIX 打包容器里
 * (比如从 Claude 桌面版的终端起的 dev server)。那种情况下对 %LOCALAPPDATA% 的写入会被
 * 重定向进 Packages\<包名>\LocalCache\,**容器外的程序完全看不见** —— Codex 会报
 * 「这个目录不存在」。Documents 不在虚拟化范围内,两边看到的是同一个真实路径。
 * 顺带用户自己也能直接打开这个文件夹看结果。
 *
 * 目录不在仓库里,agent 也就够不到仓库里的 pc-tool.mjs / mcp-server.mjs ——
 * 所以下面 copyTools() 把它们复制进来,任务目录彻底自包含。
 */
function jobsRoot(_root: string) {
  const base = process.env.PROMPTCUT_SKILL_DIR
    || path.join(os.homedir(), "Documents", "PromptCut-Skill");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/**
 * 把 agent 要用的工具复制进任务目录的 tools/。
 *
 * 任务目录在仓库外,agent 的沙箱只覆盖它自己的工作区 —— 引用仓库里的脚本会被挡。
 * 这四个文件是一个干净闭包:mcp-server → mcp-tools + card-params-schema(两个都没有
 * 别的依赖),pc-tool → mcp-tools。复制过来之后这个目录不依赖仓库也能跑。
 */
function copyTools(root: string, dir: string): string {
  const out = path.join(dir, "tools");
  fs.mkdirSync(out, { recursive: true });
  const files: [string, string][] = [
    [path.join(root, "scripts", "pc-tool.mjs"), "pc-tool.mjs"],
    [path.join(root, "server", "mcp-server.mjs"), "mcp-server.mjs"],
    [path.join(root, "server", "mcp-tools.mjs"), "mcp-tools.mjs"],
    [path.join(root, "server", "card-params-schema.mjs"), "card-params-schema.mjs"],
  ];
  for (const [src, name] of files) {
    try { fs.copyFileSync(src, path.join(out, name)); } catch { /* 缺一个不该让整个任务起不来 */ }
  }
  return out;
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
function openUrl(url: string): Promise<void> {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error("打开桌面协议超时")); }, 15000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`打开桌面协议失败 (${code})`)); });
  });
}

function revealDir(dir: string) {
  const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(opener, [dir], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

/** 跑一段 PowerShell(脚本落在任务目录里,不走 shell 引号),拿回 stdout */
function runPs(dir: string, name: string, lines: string[]): Promise<string> {
  // 内部脚本放 .pc/ 里:任务目录是给 agent 看的,ls 出来一堆 ps1 只会干扰它
  const scriptDir = path.join(dir, ".pc");
  fs.mkdirSync(scriptDir, { recursive: true });
  const file = path.join(scriptDir, name);
  fs.writeFileSync(file, lines.join("\r\n"), "utf8");
  return new Promise((resolve) => {
    let out = "";
    // -WindowStyle Hidden 是必须的:光给 spawn 传 windowsHide,powershell.exe 照样会
    // 闪一下黑窗(用户看得见)。两个一起给才干净。
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", file], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(out));
  });
}

/**
 * 替用户按下那一下回车。
 *
 * 两家的深链都只把指令**预填**进输入框,不发送(实测)。用户要的是「打开就发出去,
 * agent 自己把环境配好」,所以拉起之后再补一下 Enter。
 *
 * 安全闸:先等前台窗口真的是那个桌面 app(最多 12 秒),不是就什么都不发 ——
 * 宁可让用户自己按,也不能往别的窗口里敲回车。Claude 的输入框预填斜杠命令时会
 * 弹补全菜单,第一下 Enter 是选中补全、第二下才发送;所以发两下,中间隔半秒。
 * 已经发出去的话,第二下落在空输入框上,没有副作用。
 *
 * 只做 Windows:桌面壳本来就只发 Windows 包。
 */
async function autoPressEnter(dir: string, processMatch: string): Promise<AutoSend> {
  if (process.platform !== "win32") return "skipped";
  const out = await runPs(dir, "press-enter.ps1", [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class PcFg { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }'",
    "$deadline = (Get-Date).AddSeconds(12)",
    "$ok = $false",
    "while ((Get-Date) -lt $deadline) {",
    "  $h = [PcFg]::GetForegroundWindow(); $procId = [uint32]0; [PcFg]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null",
    "  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue",
    "  if ($proc -and $proc.ProcessName -match '" + processMatch + "') { $ok = $true; break }",
    "  Start-Sleep -Milliseconds 300",
    "}",
    "if (-not $ok) { Write-Output 'NOFOCUS'; exit 2 }",
    "Start-Sleep -Milliseconds 1500",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "Start-Sleep -Milliseconds 500",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "Write-Output 'SENT'",
  ]);
  return out.includes("SENT") ? "sent" : out.includes("NOFOCUS") ? "nofocus" : "error";
}

/**
 * 桌面 app 的进程名(前台校验和等窗口都按它匹配,-match 不区分大小写)。
 *
 * Codex 那个坑:桌面版的进程叫 **ChatGPT** —— Codex 住在 ChatGPT 客户端里,不是独立 app。
 * 按 "codex" 匹配前台窗口永远匹配不上,自动回车会一直判成「没到前台」而不发。
 * codex 也留着:命令行那个进程叫 codex,以后真独立成 app 也认得出来。
 */
const APP_PROCESS: Record<Provider, string> = { claude: "claude", codex: "chatgpt|codex" };

type LaunchResult = Omit<NonNullable<JobMeta["launch"]>, "at">;
const pendingLaunches = new Map<string, Promise<LaunchResult>>();
function launchDesktop(provider: Provider, dir: string): Promise<LaunchResult> {
  const existing = pendingLaunches.get(dir);
  if (existing) return existing;
  const result = launchDesktopImpl(provider, dir).catch((error): LaunchResult => ({
    kind: "desktop-launch", status: "failed", autoSend: "error", detail: String(error),
  })).finally(() => pendingLaunches.delete(dir));
  pendingLaunches.set(dir, result);
  return result;
}

/** 创建无项目归属的独立线程，再打开已有线程深链。 */
async function launchDesktopImpl(provider: Provider, dir: string): Promise<Omit<NonNullable<JobMeta["launch"]>, "at">> {
  if (provider === "claude") {
    const url = `claude://code/new?folder=${encodeURIComponent(dir)}&q=${encodeURIComponent("/promptcut")}`;
    await openUrl(url);
    const autoSend = await autoPressEnter(dir, APP_PROCESS.claude);
    return { kind: "claude-deeplink", detail: url, autoSend };
  }
  /*
   * 提示词里必须写**绝对路径**,而且**必须用正斜杠**。
   *
   * 两件事各栽过一次:
   *   1. codex://threads/new 不带 cwd,而 `codex app <目录>` 在 app 已经开着的时候不会
   *      把窗口切到新工作区 —— 新线程开在了仓库根目录,agent 找不到 AGENTS.md,只好满盘
   *      搜,还搜出好几份历史任务来问用户要哪个。所以路径写死在提示词里;
   *   2. Codex 收深链的 prompt 时会过一层反斜杠转义:`C:\\…\\PromptCut\\.pc-work` 到了模型
   *      那儿变成 `C:\\…\\PromptCut.pc-work`(`\\.` 被吞了,而 `\\U` `\\D` 这些都活着),
   *      于是它报「找不到这个目录」。正斜杠没有这个问题,Windows 也照样认。
   */
  const slash = dir.replace(/\\/g, "/");
  const prompt = [
    `读 ${slash}/AGENTS.md,按它的流程操作这个目录:`,
    slash,
    "按 AGENTS.md 里的办法调一次 get_project,把项目名和每条序列的卡片数报给我,确认环境通了,然后等我说要做什么。",
  ].join("\n");
  const save = (launch: Omit<NonNullable<JobMeta["launch"]>, "at">) => {
    const meta = readJsonSafe<JobMeta>(path.join(dir, "job.json"));
    if (meta) writeMeta(dir, { ...meta, launch: { ...launch, at: new Date().toISOString() } });
  };
  const previous = readJsonSafe<JobMeta>(path.join(dir, "job.json"))?.launch;
  const launch = await createCodexTask(dir, prompt, previous, save);
  if (launch.status === "ready" && launch.threadId) {
    try { await openUrl(`codex://threads/${encodeURIComponent(launch.threadId)}`); }
    catch (error) { return { ...launch, status: "failed", detail: `打开 Codex 线程失败: ${String(error)}` }; }
  }
  return launch;
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
            // launch 进度由启动器写入 job.json。
            const launch = await launchDesktop(meta.provider, dir);
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
            copyTools(root, dir);
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
              // 不等它:拉起 + 自动回车要十几秒,结果写进 job.json 由前端轮询
              void launchDesktop(job.provider, dir).then((launch) => {
                const meta = readJsonSafe<JobMeta>(path.join(dir, "job.json"));
                if (meta) writeMeta(dir, { ...meta, launch: { ...launch, at: new Date().toISOString() } });
              });
              return sendJson(res, 200, { ok: true });
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
