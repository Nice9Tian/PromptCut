#!/usr/bin/env node
/**
 * 给 agent 用的命令行:不接 MCP 也能调 PromptCut 的工具。
 *
 *   node scripts/pc-tool.mjs list                      列出全部工具(名字 + 一句说明)
 *   node scripts/pc-tool.mjs describe <tool>           看某个工具的参数 schema
 *   node scripts/pc-tool.mjs call <tool> ['<json>'|@file]   调一次,结果打成 JSON
 *   node scripts/pc-tool.mjs save                      等无头实例把改动写回 project.proc
 *   node scripts/pc-tool.mjs status                    实例活着吗、端口、脏不脏
 *
 * 连哪个实例:--port N > 环境变量 PROMPTCUT_PORT > --job <目录>/instance.json > 当前目录的 instance.json。
 * Skill 任务目录里就有 instance.json,所以在任务目录下直接跑就行。
 *
 * see_frames 这类带画面的工具,返回里的 __image 会被换成一个 png 文件路径(写在当前目录),
 * base64 不打到终端 —— 那是几十万字符的乱码,模型看不见画面,上下文还被撑爆。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

function readInstance() {
  const dir = flag("--job") || process.cwd();
  const file = path.join(dir, "instance.json");
  try {
    return { ...JSON.parse(fs.readFileSync(file, "utf8")), file };
  } catch {
    return null;
  }
}

function resolvePort() {
  const p = flag("--port") || process.env.PROMPTCUT_PORT;
  if (p) return Number(p);
  const inst = readInstance();
  if (inst?.port) return inst.port;
  fail("不知道连哪个实例:传 --port,或设 PROMPTCUT_PORT,或在 Skill 任务目录下运行(那里有 instance.json)");
}

function fail(msg) {
  console.error("错误:" + msg);
  process.exit(1);
}

async function post(port, tool, args) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/mcp/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
  } catch (e) {
    fail(`连不上 127.0.0.1:${port} —— 无头实例没在跑?(${e.message})`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(data?.error || `HTTP ${res.status}`);
  return data;
}

function parseArgs(raw) {
  if (!raw) return {};
  if (raw.startsWith("@")) raw = fs.readFileSync(raw.slice(1), "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`参数不是合法 JSON:${e.message}`);
  }
}

/**
 * 工具清单从哪儿读。
 *
 * 先看自己旁边有没有一份 —— Skill 任务目录会把这个脚本连同 mcp-tools.mjs 一起复制到
 * <任务目录>/tools/ 下,那个目录在仓库外面,agent 的沙箱够不到仓库。找不到再回落到
 * 仓库里的 server/mcp-tools.mjs(从仓库直接跑这个脚本时走这条)。
 */
async function loadTools() {
  const url = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:");
  for (const candidate of [path.join(__dirname, "mcp-tools.mjs"), path.join(ROOT, "server", "mcp-tools.mjs")]) {
    if (fs.existsSync(candidate)) return (await import(url(candidate))).tools;
  }
  fail("找不到 mcp-tools.mjs(既不在脚本旁边,也不在仓库的 server/ 下)");
}

const cmd = positional[0];

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].split("\n").slice(1).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
  process.exit(0);
}

if (cmd === "list") {
  const tools = await loadTools();
  for (const t of tools) {
    const req = t.inputSchema?.required || [];
    const props = Object.keys(t.inputSchema?.properties || {}).map((k) => (req.includes(k) ? k + "*" : k));
    const desc = String(t.description || "").replace(/\s+/g, " ");
    console.log(`${t.name}${props.length ? `(${props.join(", ")})` : "()"}\n    ${desc.length > 160 ? desc.slice(0, 157) + "…" : desc}`);
  }
  process.exit(0);
}

if (cmd === "describe") {
  const tools = await loadTools();
  const t = tools.find((x) => x.name === positional[1]);
  if (!t) fail(`没有叫 ${positional[1]} 的工具,先 list 看看`);
  console.log(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }, null, 2));
  process.exit(0);
}

if (cmd === "status") {
  const inst = readInstance();
  const port = flag("--port") || process.env.PROMPTCUT_PORT || inst?.port;
  let bridge = null;
  if (port) {
    try {
      bridge = await (await fetch(`http://127.0.0.1:${port}/api/mcp/status`)).json();
    } catch {
      bridge = { error: "连不上" };
    }
  }
  console.log(JSON.stringify({ instance: inst, bridge }, null, 2));
  process.exit(0);
}

if (cmd === "save") {
  // 无头实例每秒 flush 一次,这里只是等它把脏标记清掉,然后把文件路径报出来
  const t0 = Date.now();
  const deadline = t0 + 15000;
  let inst = readInstance();
  if (!inst) fail("找不到 instance.json —— 在 Skill 任务目录下运行,或传 --job <目录>");
  // 实例每秒写一次 instance.json。必须等到一份**这次调用之后**写出来的样本再看 dirty,
  // 否则刚 call 完就 save,读到的是改动前的旧样本,dirty=false 是假的。
  while (Date.now() < deadline) {
    inst = readInstance();
    const fresh = inst && Date.parse(inst.updatedAt || 0) >= t0;
    if (fresh && inst.dirty === false && inst.ready) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const file = path.join(path.dirname(inst.file), "project.proc");
  if (inst.dirty) console.error("警告:15 秒内没等到写回完成,文件可能还是旧的");
  console.log(JSON.stringify({ ok: !inst.dirty, file, url: "file:///" + file.replace(/\\/g, "/"), savedAt: inst.savedAt }, null, 2));
  process.exit(inst.dirty ? 2 : 0);
}

if (cmd === "call") {
  const tool = positional[1];
  if (!tool) fail("call 后面要跟工具名");
  const port = resolvePort();
  const out = await post(port, tool, parseArgs(positional[2]));
  if (out?.ok === false) {
    console.error("工具报错:" + out.error);
    process.exit(2);
  }
  const result = out?.result ?? out;
  if (result && typeof result === "object" && result.__image?.base64) {
    const file = path.resolve(`preview-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(result.__image.base64, "base64"));
    const { __image, ...rest } = result;
    rest.previewImage = file;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(0);
}

fail(`不认识的命令 ${cmd}。用 help 看用法`);
