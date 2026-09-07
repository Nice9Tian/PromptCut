import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';


/**
 * 在文件管理器里打开一个目录。
 * explorer 打开目录时退出码就是 1,所以这里不看退出码,也不等它。
 */
function revealInFileManager(dir: string) {
  const opener = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了,文件已经写好了,路径也会回给界面 */
  }
}

function sendJson(res: ServerResponse, code: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * 一次「无工具、无历史」的最小补全。分工模式的编排阶段全都走它。
 *
 * 为什么不走 /api/ai/chat：那条路会带上 30 个工具的 schema 和整段历史，而
 * 编排阶段(拆任务、划依赖、分角色)一个工具都不需要用。省下的不只是 token，
 * 还有模型「看到工具就想调一下」而多花的那几轮往返。
 *
 * 只支持 API 直连：CLI 驱动每次都要起进程，做这种小调用是净亏损。
 * 拿不到配置就抛，由调用方决定怎么降级。
 */
async function oneShotCompletion(
  system: string, prompt: string, maxTokens: number, timeoutMs = 60000,
): Promise<string> {
  const configModule = await import(new URL('./ai-config.mjs', import.meta.url).href);
  const cfg = (configModule as any).readConfig()?.api || {};
  if (!cfg.apiKey || !String(cfg.apiKey).trim()) throw new Error('没有配置 API 直连');
  const providerModule = await import(
    new URL(`./harness/providers/${cfg.vendor || 'anthropic'}.mjs`, import.meta.url).href
  );
  const provider = (providerModule as any).createProvider(
    { ...cfg, maxTokens },
    { fetchImpl: (u: string, o: RequestInit) => fetch(u, { ...o, signal: AbortSignal.timeout(timeoutMs) }) },
  );
  let text = '';
  for await (const ev of provider.stream(
    [{ role: 'user', content: [{ type: 'text', text: prompt }] }], [], system, undefined,
  )) {
    if (ev.type === 'text_delta') text += ev.text;
  }
  return text;
}


/**
 * 用 CLI 驱动做一次一问一答。给 /api/ai/plan 在没有 API 直连时兜底。
 *
 * **不给 callTool**：规划阶段一个工具都不该调，不接 MCP 桥就从根上断了这个念头，
 * 顺带也不需要编辑台开着。CLI 起进程要几秒，所以这条路只用于规划那三次
 * （用户已经决定要编排了），不用于 triage 闸（那个必须极便宜）。
 */
function oneShotViaCli(
  runners: any, provider: string, system: string, prompt: string, timeoutMs = 120000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    let run: any;
    const timer = setTimeout(
      () => finish(() => { try { run?.abort(); } catch {} reject(new Error('规划调用超时')); }),
      timeoutMs,
    );
    try {
      run = runners.startRun({
        provider,
        prompt,
        systemPrompt: system,
        onEvent: (ev: any) => {
          if (ev.type === 'text' && ev.delta) text += ev.delta;
          else if (ev.type === 'error') finish(() => { clearTimeout(timer); reject(new Error(ev.message || '规划调用失败')); });
          else if (ev.type === 'done') finish(() => { clearTimeout(timer); resolve(text); });
        },
      });
    } catch (e: any) {
      finish(() => { clearTimeout(timer); reject(e); });
    }
  });
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
        // 无头实例(PROMPTCUT_HEADLESS=1)不写这个锁文件:它是给没指定端口的 mcp-server 兜底的,
        // 被无头实例盖掉会把用户自己那份 AI 面板指到错误的端口上
        if (process.env.PROMPTCUT_HEADLESS === '1') return;
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
        // 大多数工具是即时的,慢活儿都返回 jobId 让调用方轮询,所以 60 秒够用。
        // 例外是 see_preview:它当场起一个 Chrome 渲一帧,冷启动加素材预热可能过分钟。
        // 让工具自己声明上限,而不是把所有工具一起放宽 —— 真卡住的时候还是该早点报错。
        const limit = toolDef.timeoutMs || 60000;
        const p = new Promise<any>(resolve => {
          pendingCalls.set(id, resolve);
          setTimeout(() => {
            if (pendingCalls.has(id)) {
              pendingCalls.delete(id);
              resolve({ ok: false, error: `${tool} 超过 ${Math.round(limit / 1000)} 秒没有返回,已放弃等待。` });
            }
          }, limit);
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

      /**
       * 列出某家 CLI 能用的模型。
       *
       * 目前只有 agy 有列表命令(`agy models`,输出是「名字<TAB>说明」)。
       * claude / codex 没有对应命令,清单只能在设置里手填 —— 与其编一份可能过期的
       * 硬编码名单,不如老实说这一家读不到。
       */
      server.middlewares.use('/api/ai/models', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider');
        if (provider !== 'agy') {
          return sendJson(res, 400, { ok: false, error: '这一家没有列出模型的命令,请在上面手填' });
        }
        try {
          const { resolveExe } = await getRunner();
          const { cliCommand, cliEnv } = await import(new URL('./runners/cli-runtime.mjs', import.meta.url).href);
          const { execFile } = await import('node:child_process');
          const inv = cliCommand(resolveExe('agy'), ['models']);
          const out = await new Promise<string>((resolve, reject) => {
            execFile(inv.command, inv.args, { env: cliEnv('agy'), timeout: 30000, windowsHide: true },
              (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout || '')));
          });
          // 只收「名字<TAB>说明」那些行,把「Fetching available models...」之类的抬头滤掉
          const models = out.split(/\r?\n/)
            .map((l) => l.split('\t')[0].trim())
            .filter((n) => /^[\w.:-]+$/.test(n));
          sendJson(res, 200, { ok: true, models });
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e.message || String(e) });
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

      /**
       * POST /api/ai/diagnostics/save —— 报告太长时存成文件,并打开它所在的文件夹。
       *
       * 为什么不一律走剪贴板:诊断报告带上每一步执行事件之后动辄几百 KB,
       * 粘到聊天框里既贴不动也没人看。超过阈值就落盘,让用户直接把文件发过来。
       *
       * **每次单独建一个带时间戳的文件夹**,里面就这一个 txt。直接打开
       * 「诊断报告」总目录的话,用户会看到一堆历次的文件,还得自己认哪个是刚生成的。
       */
      server.middlewares.use('/api/ai/diagnostics/save', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let tooBig = false;
        // 报告本身就是大块头,这里的上限只用来挡住明显不正常的请求
        req.on('data', (c) => { body += c; if (body.length > 64 * 1024 * 1024) { tooBig = true; req.destroy(); } });
        req.on('end', () => {
          if (tooBig) return sendJson(res, 413, { ok: false, error: '报告超过 64MB,没有保存' });
          try {
            const { text, label } = JSON.parse(body || '{}');
            if (typeof text !== 'string' || !text) return sendJson(res, 400, { ok: false, error: 'text 必填' });
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
            const safeLabel = String(label || '诊断').replace(/[\\/:*?"<>|]/g, '');
            // 和 ai.json 放一处,不往桌面上堆东西;反正马上就用资源管理器打开了
            const root = path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut', '诊断报告');
            const dir = path.join(root, `${safeLabel}-${stamp}`);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${safeLabel}-${stamp}.txt`);
            // 带 BOM:Windows 记事本没有它会把中文按 ANSI 读成乱码
            fs.writeFileSync(file, '﻿' + text, 'utf8');
            revealInFileManager(dir);
            sendJson(res, 200, { ok: true, dir, file });
          } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
        });
      });

      // 排查信息:用户点「诊断」时一次性拿全,复制给我们看。
      // 里面绝不能有明文 Key —— publicConfig() 已经把它换成 { set, last4 }。
      //
      // 机器码同样要脱敏。它不只是个编号,它**就是**分发 API 配置时的加密口令
      // (configShare 拿它当 password),整串写进报告等于把解密口令一起交出去。
      // 只留第一组:够我们认出是哪台机器,不够任何人拿去解密。
      server.middlewares.use('/api/ai/diagnostics', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const [{ publicConfig }, { setupRoot }, { machineCode, redactMachineCode }, runners] = await Promise.all([
            import(new URL('./ai-config.mjs', import.meta.url).href),
            import(new URL('./runners/cli-runtime.mjs', import.meta.url).href),
            import(new URL('./runners/machine-id.mjs', import.meta.url).href),
            getRunner(),
          ]);
          res.setHeader('Cache-Control', 'no-store');
          sendJson(res, 200, {
            ok: true,
            generatedAt: new Date().toISOString(),
            app: {
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              cliHome: setupRoot(),
              configPath: process.env.PROMPTCUT_AI_CONFIG || '(默认 %LOCALAPPDATA%\\promptcut\\ai.json)',
            },
            machineCode: redactMachineCode(machineCode()),
            machineCodeNote: '只保留首组:机器码同时是配置分发的解密口令,整串不外发',
            providers: await runners.listProviders({ refresh: true }),
            config: publicConfig(),
          });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      // 本机识别码:分发 API 配置时当加密口令用。只给摘要后的码,原始指纹不出服务端。
      server.middlewares.use('/api/ai/machine-code', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const { machineCode } = await import(new URL('./runners/machine-id.mjs', import.meta.url).href);
          res.setHeader('Cache-Control', 'no-store');
          sendJson(res, 200, { ok: true, code: machineCode() });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      /**
       * POST /api/ai/triage —— 一句话分类：这个请求值不值得走分工编排。
       *
       * 「分工模式」勾上以后每条提问都要过 manager，可 manager → DAG → JSON 是
       * 三轮模型往返。给「现在几点了」也走一遍，这个本来为了提速的功能反而更慢。
       * 所以先花一次**极便宜**的调用把简单请求筛掉。
       *
       * 便宜体现在三处，缺一不可：不带任何工具（正常对话要带 30 个工具的 schema）、
       * 不带历史、maxTokens 压到 16。答案只要一个词。
       *
       * 只走 API 直连：CLI 驱动光启动进程就要好几秒，用它做这道闸是净亏损。
       * 没配 API 就返回 available:false，由前端退回本地启发式。
       */
      server.middlewares.use('/api/ai/triage', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
        req.on('end', async () => {
          try {
            const { query } = JSON.parse(body || '{}');
            if (typeof query !== 'string' || !query.trim()) {
              return sendJson(res, 400, { ok: false, error: 'query 必填' });
            }
            const system = '你是一个分类器。只回一个词，不要解释。';
            const prompt = [
              '下面这句话是用户对视频编辑软件提的要求。判断它能不能拆成多个',
              '互不依赖、可以同时进行的子任务。',
              '能拆并且确实值得并行 → 回 PARALLEL',
              '只是一句提问、一个小改动、或者天然只能一步步来 → 回 SIMPLE',
              '',
              `用户：${query.slice(0, 500)}`,
            ].join('\n');
            const text = await oneShotCompletion(system, prompt, 16, 15000);
            const parallel = /PARALLEL/i.test(text);
            sendJson(res, 200, { ok: true, available: true, parallel, raw: text.trim().slice(0, 40) });
          } catch (e: any) {
            // 闸门失败不该拖垮提问：回 available:false，前端退回本地启发式
            sendJson(res, 200, { ok: true, available: false, reason: String(e?.message ?? e) });
          }
        });
      });

      /**
       * POST /api/ai/plan —— 编排阶段用的通用「无工具单次补全」。
       *
       * 分工模式的三步(拆任务 / 划依赖 / 分角色)都打这里。之所以不复用
       * /api/ai/chat：那条路带 30 个工具的 schema 和整段历史，而这三步一个
       * 工具都不用。省的不只是 token，还有模型「看见工具就想调一下」多花的往返。
       */
      server.middlewares.use('/api/ai/plan', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy(); });
        req.on('end', async () => {
          try {
            const { system, prompt, maxTokens } = JSON.parse(body || '{}');
            if (typeof prompt !== 'string' || !prompt.trim()) {
              return sendJson(res, 400, { ok: false, error: 'prompt 必填' });
            }
            const cap = Number.isFinite(maxTokens) ? Math.min(Math.max(maxTokens, 16), 4096) : 1500;
            const sys = typeof system === 'string' ? system : '';
            let text: string;
            let via: string;
            try {
              text = await oneShotCompletion(sys, prompt, cap);
              via = 'api';
            } catch (apiErr) {
              // 没配 API 直连就退回 CLI。
              //
              // 起进程要几秒，做 triage 那种「必须极便宜」的闸确实不划算，
              // 但规划这三次是用户已经决定要编排之后的事，几秒占比小得多。
              // 一开始我把 triage 的理由套到了这里，结果是 CLI 用户根本用不了
              // 分工模式——而那是大多数用户。
              const { provider } = JSON.parse(body || '{}');
              if (!provider) throw apiErr;
              text = await oneShotViaCli(await getRunner(), provider, sys, prompt);
              via = provider;
            }
            sendJson(res, 200, { ok: true, text, via });
          } catch (e: any) {
            // 没配 API 直连是最常见的一种，调用方要能区分出来好降级
            sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
          }
        });
      });

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
            const { provider, prompt, sessionId, model, effort, fast, attachments, script } = data;

            let systemPrompt = '';
            try {
              systemPrompt = fs.readFileSync(new URL('./ai-system-prompt.md', import.meta.url), 'utf-8');
            } catch {
              systemPrompt = 'System prompt missing.';
            }

            // 剧本每一轮都拼进系统提示词,而不是只在第一条用户消息里说一次:
            // 多轮执行最容易顺着中间结果越走越偏,摆在系统提示里才拉得住。
            if (typeof script === 'string' && script.trim()) {
              systemPrompt += `\n\n## 本片剧本(用户写的,每一步都要照它来)\n\n${script.trim()}\n\n` +
                '这是这条片子的主线。做任何编排、配字幕、配动效的决定时都要对照它;' +
                '和它冲突的做法不要做,拿不准就按剧本写的来。剧本没写到的细节可以自己判断。';
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
              // 推理强度和加速档:哪家支持哪些由各自的 runner 翻译成标志,
              // 不支持的直接忽略(前端也已经把对应控件灰掉了)
              effort,
              fast,
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

            res.on('close', () => {
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
