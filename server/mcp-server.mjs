import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { tools } from './mcp-tools.mjs';
import { injectCardParams } from './card-params-schema.mjs';

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
        body: JSON.stringify({ tool, args })
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

    sendResponse(req.id, { tools: pubTools });
    return;
  }

  if (req.method === 'tools/call') {
    const tool = req.params.name;
    const args = req.params.arguments || {};
    
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
      // 带画面的工具(see_preview)把 base64 放在 __image 里。MCP 的 content 数组
      // 本来就支持 image 块，直接作为一个块发出去即可；但 base64 绝不能留在 text
      // 块里——那是几十万字符的乱码，模型看不见画面，上下文还被白白撑爆。
      // (API 直连那条路做的是同一件事，见 harness/agent.mjs 里的 __image 处理。)
      const payload = out.result || out;
      const image = payload && typeof payload === "object" ? payload.__image : null;
      const rest = image ? (({ __image, ...r }) => r)(payload) : payload;
      const content = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
      if (image?.base64) content.push({ type: "image", data: image.base64, mimeType: image.mime || "image/png" });
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
