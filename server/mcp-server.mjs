import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { tools } from './mcp-tools.mjs';

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
      const res = await callBridge('list_cards', {});
      if (res.ok) {
        const out = await res.json();
        if (out.ok && out.result) {
          const cards = out.result;
          
          const paramsSchema = {
            type: "object",
            description: "卡片的具体参数 (基于 controls)",
            anyOf: cards.map(c => {
              const props = {};
              c.controls.forEach(ctrl => {
                if (ctrl.type === 'number') props[ctrl.key] = { type: 'number' };
                else props[ctrl.key] = { type: 'string' };
              });
              return {
                title: c.id,
                type: "object",
                properties: props
              };
            })
          };

          const addClip = pubTools.find(t => t.name === 'add_clip');
          if (addClip) {
             addClip.inputSchema.properties.params = paramsSchema;
          }
          const updateClip = pubTools.find(t => t.name === 'update_clip');
          if (updateClip) {
             updateClip.inputSchema.properties.params = paramsSchema;
          }
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
      sendResponse(req.id, {
        content: [{ type: "text", text: JSON.stringify(out.result || out, null, 2) }]
      });
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
