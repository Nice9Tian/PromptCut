import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tools } from './mcp-tools.mjs';
import { injectCardParams, injectPartParams } from './card-params-schema.mjs';

function getTargets() {
  let port = 5195;
  let lockHost = null;
  if (process.env.PROMPTCUT_PORT) {
    port = parseInt(process.env.PROMPTCUT_PORT, 10);
  }
  try {
    const p = path.join(os.tmpdir(), 'promptcut', 'port.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!process.env.PROMPTCUT_PORT && data.port) port = data.port;
      if (data.host) lockHost = data.host;
    }
  } catch {
    // ignore
  }

  const hostsSet = new Set();
  
  if (lockHost) {
    let host = lockHost;
    if (host === '::' || host === '0.0.0.0') {
      host = '127.0.0.1';
    } else if (host.includes(':') && !host.startsWith('[')) {
      host = `[${host}]`;
    }
    hostsSet.add(host);
  }
  
  hostsSet.add('127.0.0.1');
  
  return { port, hosts: Array.from(hostsSet) };
}

/*
 * Skill 任务目录里才有的工具:submit_merge。
 *
 * 这份脚本被复制进 <任务目录>/tools/ 跑的时候,上一级就是任务目录(有 job.json)。
 * agent 改完项目想并回用户手里那份,没法自己动手 —— 用户的 PromptCut 在另一个端口、
 * 另一个进程,agent 连它的地址都不该知道。所以走文件:往任务目录写 merge-request.json,
 * 用户那份 PromptCut 每秒轮询任务列表,看到请求就在自己页面里做三方合并(和对话框里
 * 「强制并入」同一套代码),把结果写成 merge-result.json,这里等到它就把结果回给 agent。
 * 像 git worktree 合回主分支,只是仲裁的一方是用户正在开着的编辑台。
 */
const JOB_DIR = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.resolve(here, "..");
    return fs.existsSync(path.join(dir, "job.json")) ? dir : null;
  } catch {
    return null;
  }
})();

const SUBMIT_MERGE = {
  name: "submit_merge",
  description: "把这个任务目录里的项目改动并回用户正在编辑的那份 PromptCut 项目(三方合并:以启动时的快照为基线,两边都改的保留用户的)。像 git worktree 合回主分支。会先等实例把改动写回 project.proc,再等用户那边的 PromptCut 完成合并(它每秒检查一次),返回合并报告。用户那边没开 PromptCut 或已关闭 SKILL 模式时会超时,请如实告诉用户让他在 Skill 对话框里点「强制并入」。",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "一句话说明这次并入了什么(会显示给用户)" },
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitWriteBack(dir) {
  const file = path.join(dir, "instance.json");
  const t0 = Date.now();
  let inst = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const st = fs.statSync(file);
      inst = JSON.parse(fs.readFileSync(file, "utf8"));
      // 必须等到一份这次调用之后写出来的样本,不然读到的是改动前的旧 dirty=false
      if (st.mtimeMs >= t0 && inst.dirty === false && inst.ready) return { ok: true, inst };
    } catch { /* 正在写,下一轮再读 */ }
  }
  return { ok: false, inst };
}

async function submitMerge(args) {
  if (!JOB_DIR) return { ok: false, error: "这不是 Skill 任务目录,没有可并回的目标" };
  const wb = await waitWriteBack(JOB_DIR);
  if (!wb.ok) return { ok: false, error: "15 秒内实例没把改动写回 project.proc(实例可能已经停了),先确认实例还在跑" };
  const seq = Date.now();
  const note = typeof args.note === "string" ? args.note.slice(0, 400) : "";
  const resultFile = path.join(JOB_DIR, "merge-result.json");
  try { fs.unlinkSync(resultFile); } catch {}
  fs.writeFileSync(path.join(JOB_DIR, "merge-request.json"), JSON.stringify({ seq, note, requestedAt: new Date().toISOString() }), "utf8");
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const r = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      if (r && r.seq === seq) return r;
    } catch { /* 还没有 */ }
  }
  return { ok: false, error: "60 秒内用户那边的 PromptCut 没有响应合并请求:可能没开着、或者 SKILL 模式已关闭。请用户在 Skill 对话框的历史任务里点「强制并入」。" };
}

let lastBridgeHost = null;

function isConnRefused(err) {
  let found = false;
  function walk(e, depth) {
    if (found || depth > 5 || !e || typeof e !== 'object') return;
    if (e.code === 'ECONNREFUSED') {
      found = true;
      return;
    }
    if (e.cause) walk(e.cause, depth + 1);
    if (Array.isArray(e.errors)) {
      for (const child of e.errors) {
        walk(child, depth + 1);
      }
    }
  }
  walk(err, 0);
  return found;
}

async function callBridge(tool, args) {
  const { port, hosts } = getTargets();
  for (const host of hosts) {
    try {
      const res = await fetch(`http://${host}:${port}/api/mcp/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 多 Agent 分页:这个 MCP 进程是哪一页的 Agent 起的(vite-plugin-ai 起 CLI 时塞的环境变量),
        // 编辑台拿它记「谁改了哪儿」;没有就不带
        body: JSON.stringify({ tool, args, agent: process.env.PROMPTCUT_AGENT || undefined })
      });
      if (lastBridgeHost !== host) {
        process.stderr.write(`[mcp-server] bridge at ${host}:${port}\n`);
        lastBridgeHost = host;
      }
      return res;
    } catch (err) {
      if (isConnRefused(err)) {
        continue;
      }
      throw err;
    }
  }
  const e = new Error('All hosts refused connection');
  e.allRefused = true;
  e.port = port;
  throw e;
}

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + '\n');
}

async function handleMessage(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // ignore invalid json
  }
  
  if (!req.method) return; // ignore non-requests
  if (req.method === 'notifications/initialized') return; // ignore

  if (req.method === 'initialize') {
    let clientProtocolVersion = (req.params && req.params.protocolVersion) || "2025-03-26";
    if (clientProtocolVersion !== "2025-03-26") {
      clientProtocolVersion = "2025-03-26";
    }
    sendResponse(req.id, {
      protocolVersion: clientProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "promptcut", version: "0.1.0" }
    });
    return;
  }

  if (req.method === 'ping') {
    sendResponse(req.id, {});
    return;
  }

  if (req.method === 'tools/list') {
    let pubTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
    if (JOB_DIR) pubTools.push(SUBMIT_MERGE);

    // Fetch cards to dynamically update the schema for add_clip and update_clip
    try {
      // 这里要按 controls 生成 params 的 anyOf schema,所以必须要完整版;
      // list_cards 不带参数返回的是摘要(没有 controls)。
      const res = await callBridge('list_cards', { detail: 'full' });
      if (res.ok) {
        const out = await res.json();
        if (out.ok && out.result) {
          // 和 API 直连共用同一份构造(server/card-params-schema.mjs),
          // 免得两条路给模型看的 schema 不一样 —— 以前就是这么分叉的:
          // 这里注入了真实字段,而 API 直连那边一直是个空壳自由对象。
          injectCardParams(pubTools, out.result);
        }
      }
    } catch(e) {
      // Ignore if bridge is not available, we just return the generic schema
    }

    // 部件同理:add_part / set_part 的 params、add_composite 的 parts 换成按 partId 分支的真实 schema
    try {
      const res = await callBridge('list_parts', { detail: 'full' });
      if (res.ok) {
        const out = await res.json();
        if (out.ok && out.result) injectPartParams(pubTools, out.result);
      }
    } catch (e) {
      // 拿不到就退回自由对象
    }

    sendResponse(req.id, { tools: pubTools });
    return;
  }

  if (req.method === 'tools/call') {
    const tool = req.params.name;
    const args = req.params.arguments || {};

    if (tool === SUBMIT_MERGE.name) {
      const out = await submitMerge(args);
      sendResponse(req.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: !out.ok });
      return;
    }
    
    let res;
    try {
      res = await callBridge(tool, args);
    } catch (e) {
      if (e.allRefused || isConnRefused(e)) {
        const p = e.port || getTargets().port;
        sendResponse(req.id, {
          content: [{ type: "text", text: "PromptCut 没在运行(端口 " + p + " 没有服务)" }],
          isError: true
        });
      } else {
        sendResponse(req.id, {
          content: [{ type: "text", text: e.message }],
          isError: true
        });
      }
      return;
    }
      
    if (!res.ok) {
      const text = await res.text();
      sendResponse(req.id, {
        content: [{ type: "text", text: `HTTP ${res.status}: ${text}` }],
        isError: true
      });
      return;
    }
    
    const out = await res.json();
    if (out.ok) {
      // 带画面的工具(see_frames)把 base64 放在 __image 里。MCP 的 content 数组
      // 本来就支持 image 块，直接作为一个块发出去即可；但 base64 绝不能留在 text
      // 块里——那是几十万字符的乱码，模型看不见画面，上下文还被白白撑爆。
      // (API 直连那条路做的是同一件事，见 harness/agent.mjs 里的 __image 处理。)
      const payload = out.result || out;
      const image = payload && typeof payload === "object" ? payload.__image : null;
      // see_frames 素材模式(source: "media")一次带一页拼图:__images 是数组,每张各一个 image 块,顺序和 scenes 一致
      const images = payload && typeof payload === "object" && Array.isArray(payload.__images) ? payload.__images : [];
      const rest = image || images.length ? (({ __image, __images, ...r }) => r)(payload) : payload;
      const content = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
      if (image?.base64) content.push({ type: "image", data: image.base64, mimeType: image.mime || "image/png" });
      for (const im of images) {
        if (!im?.base64) continue;
        content.push({ type: "text", text: `镜头 ${im.sceneIndex ?? "?"}:` });
        content.push({ type: "image", data: im.base64, mimeType: im.mime || "image/jpeg" });
      }
      sendResponse(req.id, { content });
    } else {
      sendResponse(req.id, {
        content: [{ type: "text", text: out.error || "Unknown error" }],
        isError: true
      });
    }
    return;
  }

  if (req.id !== undefined) {
    sendError(req.id, -32601, "Method not found");
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  handleMessage(line).catch(e => {
    process.stderr.write(`Error handling message: ${e.message}\n`);
  });
});
