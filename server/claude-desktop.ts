import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * 把一个任务目录交给 **Claude 桌面版**:开一条 Code 会话、工作目录就是任务目录、把 /promptcut 发出去。
 *
 * 桌面版只有一条深链可用:`claude://code/new?folder=<目录>&q=<指令>`。它做三件事:新建对话、
 * 把工作目录切到 folder、把 q **预填**进输入框 —— 不发送。所以拉起之后还得替用户按回车。
 *
 * 实测踩过的几个坑,这个模块就是围着它们写的:
 *
 * 1. **深链带了目录一定弹「Trust this workspace?」。** 渲染层 adoptExternalFolder 的逻辑:
 *    外部链接送来的目录,只要带了提示词预填(hasPromptPrefill)就一律弹信任框;不带预填时
 *    理论上「已信任就静默采用」,但那条路挂在一个远端开关后面,这台机器上没生效 —— 实测
 *    只带 folder= 照样弹。弹窗默认焦点在 **Cancel** 上,这时候盲目回车等于取消,指令就发进了
 *    上一个项目(用户当时选中的那个)。所以躲不掉,只能替用户点:用 UI Automation 在 Claude
 *    窗口里找名为「Trust workspace」的按钮 Invoke 它(Chromium 的无障碍树一查就开,实测
 *    313 个元素、按钮名全能读到)。
 * 2. **不要模拟键盘。** 一开始用 SendKeys 按回车:要求桌面版在前台、焦点在输入框上,用户这时候
 *    动一下鼠标、敲两个字就废了;而且回车早了(弹窗没处理完、目录没切过来)指令就发进别的会话。
 *    改成全程 UIA:会话是在「发送」那一刻才创建的,cwd 取的是那一刻界面上的目录,所以发送前先
 *    确认**输入框(Edit「Prompt」)的值就是这条指令、目录芯片(名字 = 任务目录名的 Button)已经
 *    出现**,再 Invoke「Send」按钮。Invoke 不依赖前台、焦点和鼠标。找不到 Send 按钮才退回 SendKeys。
 * 3. **`~/.claude.json` 也要预写。** 桌面版点了 Trust 之后写的就是这里的
 *    `projects[<目录>].hasTrustDialogAccepted`,CLI 那层进目录时也看它;同一个条目还管
 *    `.mcp.json` 里的服务要不要启用(`enabledMcpjsonServers`)—— 一并写上,agent 一进来
 *    MCP 就是通的,不用再答一次「要不要启用这个项目的 MCP」。
 * 4. **发没发对,得核对。** 桌面版把每条会话记在 `%APPDATA%\Claude\claude-code-sessions\`
 *    下(回车之后几秒落盘,带 cwd)。回车之后盯着这个目录,看到 cwd == 任务目录的新会话才算
 *    成功;看到 cwd 是别的目录,就是发错地方了,要明说,不能报「已发送」。
 */

export type AutoSend = "sent" | "nofocus" | "error" | "skipped";

/** 发送那一步的结果:发没发、路上有没有替用户点掉信任弹窗、没发的话卡在哪 */
export interface PressResult {
  autoSend: AutoSend;
  trustDialog: "clicked" | "none" | "failed";
  /** 没发出去的原因码(NOWINDOW / NOPREFILL / NOFOLDER …),给人看时翻成 SEND_REASONS 里的话 */
  reason?: string;
}

const SEND_REASONS: Record<string, string> = {
  NOWINDOW: "没找到 Claude 桌面版的窗口",
  NOPREFILL: "输入框里没出现预填的指令",
  NOFOLDER: "目录芯片没切到任务目录,没敢发",
};

export interface ClaudeLaunch {
  kind: "claude-deeplink";
  /** 给人看的一句话:成功了落在哪、失败了差在哪 */
  detail: string;
  autoSend: AutoSend;
  status: "ready" | "failed";
  /** 核对到的那条桌面版会话 */
  sessionId?: string;
  sessionCwd?: string;
}

export interface ClaudeDeps {
  /** 用户主目录(`~/.claude.json` 在这儿);测试换成临时目录 */
  home: string;
  /** 桌面版的会话归档目录 */
  sessionsDir: string;
  openUrl: (url: string) => Promise<void>;
  /** 处理信任弹窗、把预填好的指令发出去;settleMs 是最多等弹窗多久 */
  sendPrompt: (dir: string, prompt: string, settleMs: number) => Promise<PressResult>;
  now: () => number;
  /** 深链之后最多等弹窗多久(没弹就当目录已经切好了) */
  settleMs: number;
  /** 回车之后最多等多久看归档 */
  verifyMs: number;
  pollMs: number;
}

const MCP_SERVERS = ["promptcut"];
/** 放行规则:`mcp__<服务名>` 匹配那个 MCP 服务下的全部工具(Claude Code 的规则语法) */
const MCP_ALLOW_RULES = MCP_SERVERS.map((s) => `mcp__${s}`);

export function defaultDeps(): ClaudeDeps {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return {
    home,
    sessionsDir: path.join(appData, "Claude", "claude-code-sessions"),
    openUrl,
    sendPrompt: (dir, prompt, settleMs) => sendPromptViaUia(dir, "claude", prompt, settleMs),
    now: Date.now,
    settleMs: 8000,
    verifyMs: 45000,
    pollMs: 1000,
  };
}

export async function launchClaudeTask(dir: string, prompt: string, overrides: Partial<ClaudeDeps> = {}): Promise<ClaudeLaunch> {
  const deps = { ...defaultDeps(), ...overrides };
  const t0 = deps.now();
  const trusted = trustFolder(deps.home, dir, MCP_SERVERS);
  const allowed = allowMcpInUserSettings(deps.home, MCP_ALLOW_RULES);
  await deps.openUrl(`claude://code/new?folder=${encodeURIComponent(dir)}&q=${encodeURIComponent(prompt)}`);
  const pressed = await deps.sendPrompt(dir, prompt, deps.settleMs);
  const { autoSend } = pressed;
  const notes = [
    pressed.trustDialog === "clicked" ? "已替你点掉信任弹窗" : "",
    pressed.trustDialog === "failed" ? "信任弹窗没点成,切过去点一下 Trust workspace" : "",
    trusted ? "" : "没能预写 ~/.claude.json 的信任记录,Claude Code 可能会再问一次,选信任",
    allowed === "added" ? "已在 ~/.claude/settings.json 放行 promptcut 的 MCP 工具,以后不会再问" : "",
    allowed === "failed" ? "没能写 ~/.claude/settings.json,agent 第一次调工具时会问一次权限,选 Always allow" : "",
  ].filter(Boolean);
  const note = notes.length ? `(${notes.join(";")})` : "";
  if (autoSend !== "sent") {
    const why = SEND_REASONS[pressed.reason ?? ""] ?? "没能替你发送";
    return { kind: "claude-deeplink", status: "ready", autoSend, detail: `${why}。到 Claude 里看一眼:指令应该还留在输入框里,目录对的话按一下回车就行${note}` };
  }
  // 回车之后盯着归档:新会话落在哪个目录。
  // 期限从**回车之后**起算:原来是从深链那一刻起算,而 UIA 那段(找窗口、等信任弹窗、
  // 等预填、按发送)在 Electron 那棵巨大的无障碍树上动辄四五十秒,回来时期限早过了,
  // 归档一眼都没看就报「没在归档里看到新会话」—— 明明会话就开在任务目录里(实测)。
  const deadline = deps.now() + deps.verifyMs;
  let seen: SessionRecord | null = null;
  while (deps.now() < deadline) {
    seen = findSessionSince(deps.sessionsDir, t0, dir);
    if (seen?.matches) break;
    await new Promise((r) => setTimeout(r, deps.pollMs));
  }
  if (seen?.matches) {
    return { kind: "claude-deeplink", status: "ready", autoSend, sessionId: seen.sessionId, sessionCwd: seen.cwd, detail: `Claude 会话已开在任务目录${note}` };
  }
  if (seen) {
    return {
      kind: "claude-deeplink", status: "failed", autoSend, sessionId: seen.sessionId, sessionCwd: seen.cwd,
      detail: `指令发进了别的目录的会话(${seen.cwd})。到 Claude 里新建对话、目录选任务目录,再发一次 /promptcut${note}`,
    };
  }
  return { kind: "claude-deeplink", status: "ready", autoSend, detail: `指令已发送,但没在会话归档里看到新会话,到 Claude 里确认一下${note}` };
}

/**
 * 「重新拉起对话」:任务目录里已经开过 Claude 会话的,直接把那个会话叫回来。
 *
 * 不再走 code/new?folder=:实测同一个目录第二次走这条深链,桌面版开出来的是一个
 * 「No folder」的临时工作区(scratch workspace),/promptcut 在里面是未知命令,agent
 * 连任务目录都找不到。桌面版另有 `claude://code/continue?session=local_…` 能按会话
 * id 把原会话切到前台,会话里 skill 早就加载过了,什么都不用再发。
 *
 * 会话 id 优先用上一次拉起时核对到的;没有就翻归档找落在这个目录里的最新一条。
 * 都没有就返回 null,让调用方照常走新建那条路。
 */
export async function resumeClaudeSession(dir: string, knownSessionId: string | undefined, overrides: Partial<ClaudeDeps> = {}): Promise<ClaudeLaunch | null> {
  const deps = { ...defaultDeps(), ...overrides };
  let sessionId = knownSessionId && /^local_[A-Za-z0-9-]{1,64}$/.test(knownSessionId) ? knownSessionId : undefined;
  let cwd: string | undefined;
  if (!sessionId) {
    const seen = findSessionSince(deps.sessionsDir, 0, dir);
    if (seen?.matches) { sessionId = seen.sessionId; cwd = seen.cwd; }
  }
  if (!sessionId) return null;
  await deps.openUrl(`claude://code/continue?session=${encodeURIComponent(sessionId)}`);
  return { kind: "claude-continue", status: "ready", autoSend: "skipped", sessionId, sessionCwd: cwd ?? dir, detail: "已把原来的 Claude 会话叫回前台;对话关掉过的话在那儿接着说就行" };
}

/* ---------------- ~/.claude.json:预写信任 ---------------- */

/**
 * 把目录写成「已信任 + .mcp.json 里这些服务已启用」。
 *
 * 返回 false 表示没写成(文件读不出来、解析不了、写不进去)。**解析不了就绝不覆盖** ——
 * 那是用户全部 Claude Code 配置所在的文件,宁可让弹窗出一次。
 */
export function trustFolder(home: string, dir: string, mcpServers: string[]): boolean {
  const file = path.join(home, ".claude.json");
  let config: any = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return false;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  }
  const projects = (config.projects && typeof config.projects === "object") ? config.projects : (config.projects = {});
  // CLI 用 process.cwd() 的原样(Windows 反斜杠)当键;已有的同目录条目沿用它的键
  const key = Object.keys(projects).find((k) => samePath(k, dir)) ?? dir;
  const entry = (projects[key] && typeof projects[key] === "object") ? projects[key] : {};
  const enabled = new Set<string>(Array.isArray(entry.enabledMcpjsonServers) ? entry.enabledMcpjsonServers : []);
  for (const s of mcpServers) enabled.add(s);
  const disabled = (Array.isArray(entry.disabledMcpjsonServers) ? entry.disabledMcpjsonServers : []).filter((s: string) => !mcpServers.includes(s));
  projects[key] = {
    allowedTools: [],
    mcpContextUris: [],
    ...entry,
    enabledMcpjsonServers: [...enabled],
    disabledMcpjsonServers: disabled,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  try {
    const tmp = `${file}.pc-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- ~/.claude/settings.json:放行 MCP 工具 ---------------- */

/**
 * 在**用户级** `~/.claude/settings.json` 的 `permissions.allow` 里加规则。
 *
 * 为什么非得是用户级:桌面版起 Code 会话时只加载 user 这一层设置(asar 里写死了
 * `settingSources:["user"]`),任务目录里的 `.claude/settings.json` 根本不读;它自己的
 * 「Always allow」也只记在会话里(destination:"session"),不落盘。所以没有别的地方可写。
 * 影响面:`mcp__promptcut` 只匹配名叫 promptcut 的 MCP 服务的工具,而只有我们的任务目录
 * 会在 .mcp.json 里定义这个服务 —— 用户别的项目不受影响。
 *
 * 和 trustFolder 一样:解析不了就绝不覆盖。
 */
export function allowMcpInUserSettings(home: string, rules: string[]): "added" | "present" | "failed" {
  const file = path.join(home, ".claude", "settings.json");
  let settings: any = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return "failed";
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "failed";
  }
  const perms = (settings.permissions && typeof settings.permissions === "object") ? settings.permissions : (settings.permissions = {});
  const allow: string[] = Array.isArray(perms.allow) ? perms.allow : (perms.allow = []);
  const missing = rules.filter((r) => !allow.includes(r));
  if (missing.length === 0) return "present";
  allow.push(...missing);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.pc-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return "added";
  } catch {
    return "failed";
  }
}

/* ---------------- 会话归档:核对落在哪 ---------------- */

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  createdAt: number;
  matches: boolean;
}

/**
 * 归档里 createdAt >= t0 的最新一条会话。有落在 dir 里的优先返回它(matches=true);
 * 没有就返回最新那条,让调用方知道指令发到哪儿去了。
 */
export function findSessionSince(root: string, t0: number, dir: string): SessionRecord | null {
  let best: SessionRecord | null = null;
  const since = t0 - 2000; // 时钟和落盘都有点误差,放宽两秒
  const visit = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) visit(p, depth + 1); continue; }
      if (!e.name.endsWith(".json")) continue;
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < since) continue;
      let j: any;
      try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
      if (!j || typeof j.sessionId !== "string" || typeof j.cwd !== "string") continue;
      const createdAt = Number(j.createdAt);
      if (!(createdAt >= since)) continue;
      const rec: SessionRecord = { sessionId: j.sessionId, cwd: j.cwd, createdAt, matches: samePath(j.cwd, dir) };
      if (!best || (rec.matches && !best.matches) || (rec.matches === best.matches && rec.createdAt > best.createdAt)) best = rec;
    }
  };
  visit(root, 0);
  return best;
}

export function samePath(a: string, b: string) {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/* ---------------- 深链 / 弹窗 / 回车 ---------------- */

export function openUrl(url: string): Promise<void> {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error("打开桌面协议超时")); }, 15000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`打开桌面协议失败 (${code})`)); });
  });
}

/** 跑一段 PowerShell(脚本落在任务目录的 .pc/ 里,不走 shell 引号),拿回 stdout */
function runPs(dir: string, name: string, lines: string[]): Promise<string> {
  const scriptDir = path.join(dir, ".pc");
  fs.mkdirSync(scriptDir, { recursive: true });
  const file = path.join(scriptDir, name);
  fs.writeFileSync(file, lines.join("\r\n"), "utf8");
  return new Promise((resolve) => {
    let out = "";
    // -WindowStyle Hidden 是必须的:光给 spawn 传 windowsHide,powershell.exe 照样会闪一下黑窗
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", file], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (c) => (out += c));
    // 脚本卡住(等一个再也不会出现的窗口之类)不能把整条拉起流程吊死
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经没了 */ } resolve(out); }, 120000);
    const done = (v: string) => { clearTimeout(timer); resolve(v); };
    child.on("error", () => done(""));
    /*
     * 用 close 而不是 exit:exit 只说进程没了,**stdio 管道里可能还有没读完的字节**。
     * 拿 exit 当信标会把输出读断 —— 末尾那行 SENT / NOFOCUS 正好在缓冲区里没排干,
     * 上层 autoPressEnter 就把一次本来成功的发送判成 "error"。close 是所有 stdio 都关掉
     * 之后才发的,那时 out 才是完整的。
     */
    child.on("close", () => done(out));
  });
}

/** 无障碍树里的名字(按 Name 精确匹配)。app 换语言要在这里补 */
const UIA_NAMES = {
  trust: ["Trust workspace"],
  prompt: ["Prompt"],
  send: ["Send"],
};

const psStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psList = (names: string[]) => names.map(psStr).join(",");

/**
 * 替用户过掉信任弹窗、把预填好的指令发出去。全程 UI Automation,不模拟键盘、不看鼠标、不要求前台。
 *
 * 1. 找 app 主窗口(最多等 12 秒),拿它的无障碍树根;
 * 2. 最多等 settleMs 看有没有「Trust workspace」按钮,有就 Invoke;
 * 3. 最多等 10 秒,直到 Edit「Prompt」的值里有这条指令、而且出现了名字等于任务目录名的 Button
 *    (目录芯片)—— 两样缺一样都**不发**,原因码回给上层;
 * 4. Invoke「Send」。找不到这个按钮才退回「聚焦输入框 + 回车两下」(预填斜杠命令时第一下是选补全)。
 *
 * 只做 Windows:桌面壳本来就只发 Windows 包。
 */
export async function sendPromptViaUia(dir: string, processMatch: string, prompt: string, settleMs: number): Promise<PressResult> {
  if (process.platform !== "win32") return { autoSend: "skipped", trustDialog: "none" };
  const out = await runPs(dir, "send-prompt.ps1", [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "Add-Type -AssemblyName System.Windows.Forms",
    /*
     * 前台窗口属于谁 —— 退回模拟键盘那条路必须先问这一句。
     *
     * SendKeys 是**全局**的:它把回车送给当前拥有焦点的那个窗口,不管那是谁。SetFocus()
     * 到真正 SendWait 之间有几百毫秒的空档,用户这时候切一下窗口(或者别的程序自己弹到
     * 前台),这个回车就打进了别人的应用里 —— 可能是一封写了一半的邮件、一个确认对话框。
     * 所以每一下回车之前都重新核一次前台进程,对不上就不按。
     */
    "Add-Type -Namespace PC -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);'",
    "function Test-Foreground($want) { if (-not $want) { return $false }; $h = [PC.Win]::GetForegroundWindow(); $fp = 0; [void][PC.Win]::GetWindowThreadProcessId($h, [ref]$fp); return ($fp -eq $want) }",
    "$A = [System.Windows.Automation.AutomationElement]",
    "$CT = [System.Windows.Automation.ControlType]",
    "function Find-Named($root, $names, $type) {",
    "  foreach ($n in $names) {",
    "    $c = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $n)",
    "    $c = New-Object System.Windows.Automation.AndCondition($c, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type)))",
    "    $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)",
    "    if ($e) { return $e }",
    "  }",
    "  return $null",
    "}",
    "function Invoke-El($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }",
    "function Get-Root {",
    // 进程名要**整个**对上。原来是 -match 子串匹配,任何名字里带这个词的进程都算数
    // (ClaudeHelper、claude-updater、用户自己写的什么 MyClaudeTool),挑错了窗口
    // 后面的回车就打到别人身上去了。-match 加锚点 = 全名匹配,PowerShell 默认不区分大小写。
    `  $p = Get-Process | Where-Object { $_.ProcessName -match ${psStr("^" + processMatch + "$")} -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    "  if (-not $p) { return $null }",
    "  $script:tpid = $p.Id",
    "  try { return $A::FromHandle($p.MainWindowHandle) } catch { return $null }",
    "}",
    "$script:tpid = 0",
    // 1. 主窗口
    "$deadline = (Get-Date).AddSeconds(12)",
    "$root = $null",
    "while (-not $root -and (Get-Date) -lt $deadline) { $root = Get-Root; if (-not $root) { Start-Sleep -Milliseconds 400 } }",
    "if (-not $root) { Write-Output 'NOWINDOW'; exit 2 }",
    // 2. 信任弹窗
    "$trust = 'NODIALOG'",
    `$tdead = (Get-Date).AddMilliseconds(${Math.max(0, Math.round(settleMs))})`,
    "while ((Get-Date) -lt $tdead) {",
    `  $btn = Find-Named $root @(${psList(UIA_NAMES.trust)}) ($CT::Button)`,
    "  if ($btn) { if (Invoke-El $btn) { $trust = 'TRUSTED' } else { $trust = 'TRUSTFAIL' }; break }",
    "  Start-Sleep -Milliseconds 400",
    "}",
    "Write-Output $trust",
    // 3. 输入框里是这条指令、目录芯片是任务目录
    "$edit = $null; $v = $null; $chip = $null",
    "$rdead = (Get-Date).AddSeconds(10)",
    "while ((Get-Date) -lt $rdead) {",
    `  $edit = Find-Named $root @(${psList(UIA_NAMES.prompt)}) ($CT::Edit)`,
    "  $v = $null",
    "  if ($edit) { try { $v = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {} }",
    `  $chip = Find-Named $root @(${psStr(path.basename(dir))}) ($CT::Button)`,
    `  if ($v -and $v.Contains(${psStr(prompt)}) -and $chip) { break }`,
    "  Start-Sleep -Milliseconds 400",
    "}",
    `if (-not ($v -and $v.Contains(${psStr(prompt)}))) { Write-Output 'NOPREFILL'; exit 3 }`,
    "if (-not $chip) { Write-Output 'NOFOLDER'; exit 3 }",
    // 4. 发送
    `$send = Find-Named $root @(${psList(UIA_NAMES.send)}) ($CT::Button)`,
    "if ($send -and (Invoke-El $send)) { Write-Output 'SENT'; exit 0 }",
    // 退回模拟键盘。每一下回车之前都重新核一次前台窗口是不是目标进程 —— 核完到按下之间
    // 仍有极短的空档(这是 SendKeys 这个机制本身的性质,消不掉),但把几百毫秒的窗口
    // 收成了几毫秒。核不上就什么都不按,宁可回报「没发出去」让用户自己按。
    "try { $edit.SetFocus(); Start-Sleep -Milliseconds 300 } catch {}",
    "if (-not (Test-Foreground $script:tpid)) { Write-Output 'NOFOCUS'; exit 4 }",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "Start-Sleep -Milliseconds 500",
    // 预填斜杠命令时第一下是选补全,第二下才是发送。第二下之前再核一次
    "if (-not (Test-Foreground $script:tpid)) { Write-Output 'HALFSENT'; exit 4 }",
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    "Write-Output 'SENT-KEYS'",
  ]);
  const trustDialog: PressResult["trustDialog"] = out.includes("TRUSTED") ? "clicked" : out.includes("TRUSTFAIL") ? "failed" : "none";
  // 先看失败码再看 SENT:'HALFSENT' 里不含 'SENT' 之外的坑,但顺序错了就会把半截当成功
  const reason = ["NOWINDOW", "NOPREFILL", "NOFOLDER", "NOFOCUS", "HALFSENT"].find((r) => out.includes(r));
  if (reason) return { autoSend: reason === "NOFOCUS" || reason === "HALFSENT" ? "nofocus" : "error", trustDialog, reason };
  if (out.includes("SENT")) return { autoSend: "sent", trustDialog };
  return { autoSend: "error", trustDialog, reason: "UNKNOWN" };
}

