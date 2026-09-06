import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';


function sendJson(res: ServerResponse, code: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export default function vitePluginAi(): Plugin {
  let editorRes: ServerResponse | null = null;
  let nextCallId = 1;
  const pendingCalls = new Map<number, (result: any) => void>();
  const activeRuns = new Map<string, { abort: () => void, finished: boolean }>();

  return {
    name: 'vite-plugin-ai',
    configureServer(server) {
      server.httpServer?.on('listening', () => {
        try {
          const addr = server.httpServer?.address();
          if (addr && typeof addr !== 'string') {
            const port = addr.port;
            let host = addr.address;
            if (host === '::' || host === '0.0.0.0') {
              host = '127.0.0.1';
            }
            const tmpDir = path.join(os.tmpdir(), 'promptcut');
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'port.json'), JSON.stringify({
              port,
              host,
              pid: process.pid,
              startedAt: Date.now()
            }));
          }
        } catch {}
      });

      async function getRunner() {
        let runnerUrl;
        if (process.env.PROMPTCUT_AI_FAKE_RUNNER === '1') {
          runnerUrl = new URL('./test/fake-runner.mjs', import.meta.url).href;
        } else {
          const mod = process.env.PROMPTCUT_AI_RUNNER_MODULE || './runners/index.mjs';
          runnerUrl = new URL(mod, import.meta.url).href;
        }
        try {
          return await import(runnerUrl);
        } catch (e: any) {
          throw new Error(`Runner 尚未就绪或加载失败: ${e.message}`);
        }
      }

      async function callToolInternal(tool: string, args: any): Promise<any> {
        const { tools } = await import(new URL('./mcp-tools.mjs', import.meta.url).href);
        const toolDef = tools.find((t: any) => t.name === tool);
        
        if (!toolDef) {
          const err = new Error('Unknown tool');
          (err as any).code = 'UNKNOWN_TOOL';
          throw err;
        }

        if (!editorRes) {
          throw new Error('编辑台没有打开:没有页面连着 /api/mcp/events');
        }

        const id = nextCallId++;
        const p = new Promise<any>(resolve => {
          pendingCalls.set(id, resolve);
          setTimeout(() => {
            if (pendingCalls.has(id)) {
              pendingCalls.delete(id);
              resolve({ ok: false, error: 'Timeout' });
            }
          }, 60000);
        });

        editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool, args })}\n\n`);
        
        const out = await p;
        if (out.ok) return out.result || out;
        throw new Error(out.error);
      }

      server.middlewares.use('/api/ai/providers', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const urlStr = req.originalUrl || req.url || '';
          const refresh = /[?&]refresh=1(&|$)/.test(urlStr);
          const runners = await getRunner();
          const list = await runners.listProviders({ refresh });
          
          let stt = { engine: null as string | null, available: false, hint: 'STT removed' };
          sendJson(res, 200, { ok: true, providers: list, stt });
        } catch (e: any) {
          sendJson(res, 503, { ok: false, error: String(e) });
        }
      });

      // Keep operations alive across dialog close/reopen and report actual results.
      const setupService = import(new URL('./runners/setup.mjs', import.meta.url).href)
        .then(mod => mod.createSetupService());
      server.httpServer?.once('close', () => { void setupService.then(service => service.dispose()); });
      server.middlewares.use('/api/ai/setup', async (req, res) => {
        if (req.method === 'DELETE') {
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', async () => {
            try { (await setupService).cancel(JSON.parse(body).provider); sendJson(res, 200, { ok: true }); }
            catch (e: any) { sendJson(res, 400, { ok: false, error: e.message }); }
          });
          return;
        }
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        res.setHeader('Cache-Control', 'no-store');
        try { sendJson(res, 200, { ok: true, jobs: (await setupService).list() }); }
        catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });
      for (const kind of ['install', 'login'] as const) {
        server.middlewares.use('/api/ai/' + kind, async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
          req.on('end', async () => {
            try {
              const { provider, dryRun, deviceAuth } = JSON.parse(body || '{}');
              if (kind === 'install' && dryRun) {
                const { installPlanFor, manualHintFor } = await import(new URL('./runners/install.mjs', import.meta.url).href);
                const plan = installPlanFor(provider);
                return sendJson(res, plan ? 200 : 400, plan ? { ok: true, ...plan } : { ok: false, hint: manualHintFor(provider) });
              }
              const job = (await setupService).start(provider, kind, { deviceAuth: deviceAuth === true });
              sendJson(res, 200, { ok: true, job });
            } catch (e: any) { sendJson(res, 400, { ok: false, error: e.message }); }
          });
        });
      }

      server.middlewares.use('/api/ai/config', async (req, res) => {
        try {
          const { publicConfig, writeConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, config: publicConfig() });
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
              try {
                const partial = JSON.parse(body);
                writeConfig(partial);
                sendJson(res, 200, { ok: true, config: publicConfig() });
              } catch (e: any) {
                sendJson(res, 400, { ok: false, error: e.message });
              }
            });
          } else {
            sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          }
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/agy-permissions', async (req, res) => {
        try {
          const { status, grant } = await import(new URL('./agy-permissions.mjs', import.meta.url).href);
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, ...status() });
          } else if (req.method === 'POST') {
            return sendJson(res, 200, { ok: true, ...grant() });
          } else {
            sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          }
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/chat', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          let hasDone = false;
          try {
            const runners = await getRunner();
            const data = JSON.parse(body);
            const { provider, prompt, sessionId, model, attachments } = data;
            
            let systemPrompt = '';
            try {
              systemPrompt = fs.readFileSync(new URL('./ai-system-prompt.md', import.meta.url), 'utf-8');
            } catch {
              systemPrompt = 'System prompt missing.';
            }

            let finalPrompt = prompt;
            if (attachments && attachments.length > 0) {
              finalPrompt += '\n\n附件:\n' + attachments.map((a: any) => {
                let line = `- [${a.kind === 'video' ? '视频' : a.kind}] ${a.name} · 站内地址 ${a.url}`;
                if (a.path) line += ` · 磁盘路径 ${a.path}`;
                if (a.url && !a.path) {
                  const diskPath = path.join(server.config.root, 'public', decodeURIComponent(a.url.split('?')[0]));
                  if (diskPath.startsWith(path.join(server.config.root, 'public'))) {
                    line += ` · 磁盘路径 ${diskPath}`;
                  }
                }
                if (a.durationSec) line += ` · 时长 ${a.durationSec} 秒`;
                if (a.text) line += `\n\`\`\`\n${a.text}\n\`\`\``;
                return line;
              }).join('\n');
            }

            const editorPort = (server.httpServer?.address() as any)?.port || 5195;
            const editorState = editorRes ? "编辑台已连接" : "未连接";
            finalPrompt += `\n\n当前端口 ${editorPort};${editorState}`;

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            res.flushHeaders();

            const keepAlive = setInterval(() => {
              res.write(': ping\n\n');
            }, 15000);

            const mcp = {
              serverName: "promptcut",
              command: process.execPath,
              args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))],
              env: { PROMPTCUT_PORT: String(editorPort) }
            };

            const cwd = path.join(server.config.root, 'exports', 'ai-workspace');
            fs.mkdirSync(cwd, { recursive: true });

            const runId = Math.random().toString(36).substring(2, 9);
            res.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);

            const { publicConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
            const cfg = publicConfig();

            const run = runners.startRun({
              provider,
              prompt: finalPrompt,
              systemPrompt,
              sessionId,
              cwd,
              model,
              toolProtocol: cfg.toolProtocol,
              mcp,
              callTool: async (name: string, args: any) => await callToolInternal(name, args),
              onEvent: (ev: any) => {
                if (ev.type === 'done') hasDone = true;
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
              }
            });

            const runState = { abort: run.abort, finished: false };
            activeRuns.set(runId, runState);

            req.on('close', () => {
              if (!runState.finished) run.abort();
              activeRuns.delete(runId);
              clearInterval(keepAlive);
            });

            try {
              await run.done;
            } catch (e: any) {
              if (!res.headersSent) throw e;
              res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
            }
            
            runState.finished = true;
            activeRuns.delete(runId);
            clearInterval(keepAlive);
            if (!hasDone) {
               res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            }
            res.end();
            
          } catch (e: any) {
            if (!res.headersSent) {
              sendJson(res, 503, { ok: false, error: String(e) });
            } else {
              res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
              res.end();
            }
          }
        });
      });

      server.middlewares.use('/api/ai/abort', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const { runId } = JSON.parse(body);
            const runState = activeRuns.get(runId);
            if (runState && !runState.finished) {
              runState.abort();
              runState.finished = true;
              activeRuns.delete(runId);
            }
            sendJson(res, 200, { ok: true });
          } catch(e: any) {
            sendJson(res, 400, { ok: false, error: String(e) });
          }
        });
      });

      server.middlewares.use('/api/mcp/events', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        
        if (editorRes) {
          editorRes.write(`data: ${JSON.stringify({ type: "replaced" })}\n\n`);
          editorRes.end();
        }
        
        editorRes = res;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.flushHeaders();
        
        const port = (server.httpServer?.address() as any)?.port || 5195;
        res.write(`data: ${JSON.stringify({ type: 'hello', port })}\n\n`);
        
        req.on('close', () => {
          if (editorRes === res) {
            editorRes = null;
          }
        });
      });

      server.middlewares.use('/api/mcp/result', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const cb = pendingCalls.get(data.id);
            if (cb) {
              cb(data);
              pendingCalls.delete(data.id);
            }
            sendJson(res, 200, { ok: true });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: String(e) });
          }
        });
      });

      server.middlewares.use('/api/mcp/call', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const { tool, args } = JSON.parse(body);
            const result = await callToolInternal(tool, args);
            sendJson(res, 200, { ok: true, result });
          } catch (e: any) {
            if (e.code === 'UNKNOWN_TOOL') {
              sendJson(res, 404, { ok: false, error: e.message });
            } else {
              sendJson(res, 200, { ok: false, error: e.message });
            }
          }
        });
      });

      server.middlewares.use('/api/mcp/status', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const port = (server.httpServer?.address() as any)?.port || 5195;
        sendJson(res, 200, {
          editorConnected: !!editorRes,
          pending: pendingCalls.size,
          port
        });
      });
    }
  };
}
