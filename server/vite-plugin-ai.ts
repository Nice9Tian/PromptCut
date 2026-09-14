import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { overLimit } from './http-guard.mjs';
/*
 * 必须静态 import:vite 打包配置时,别的插件静态引入的 prerender-client.mjs 被打进同一个包里,
 * 状态(预渲染的地址、就绪没有)在那一份上。这里要是换成 import(new URL(...)) 动态加载,拿到的是
 * 磁盘上的另一份模块实例,状态永远是空的 —— 实测服务端 see_frames 在 whenPrerenderReady 里干等 60 秒。
 */
import { prerenderPost } from './prerender-client.mjs';


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

/* 请求体超限的 413:实现挪去 server/http-guard.mjs 了,vision 那边也要用同一份 */

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
  // 编排阶段这几次小调用也走中转,一样会撞上「upstream load is saturated」。
  // 撞上就整个编排失败,而它其实只要等几秒。包一层自动重试,规则和主对话那条路同源。
  const { createRetryingFetch } = await import(new URL('./harness/retry-fetch.mjs', import.meta.url).href);
  const provider = (providerModule as any).createProvider(
    { ...cfg, maxTokens },
    {
      fetchImpl: (createRetryingFetch as any)(
        (u: string, o: RequestInit) => fetch(u, { ...o, signal: AbortSignal.timeout(timeoutMs) }),
        { onRetry: (i: any) => console.error(`[oneshot] ${i.reason},${i.delayMs}ms 后重试(第 ${i.attempt}/${i.of} 次)`) },
      ),
    },
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
  /** 当前编辑台宣示的所有权令牌。空 = 普通页面,谁都能接管(和以前一样) */
  let editorOwner = '';
  let nextCallId = 1;
  const pendingCalls = new Map<number, (result: any) => void>();
  const activeRuns = new Map<string, { abort: () => void, finished: boolean, provider?: string, fail?: (message: string) => void }>();
  /**
   * CLI 额度熔断(server/runners/quota.mjs):对话开始前 gate,结束后按新增字节记账、到线后台重查;
   * 重查发现超线就把同一路正在跑的对话全部掐掉。模块懒加载,和别的 runner 一样。
   */
  let quotaGuardPromise: Promise<any> | null = null;
  const getQuotaGuard = () => {
    quotaGuardPromise ??= import(new URL('./runners/quota.mjs', import.meta.url).href).then((m: any) => ({ guard: m.createQuotaGuard(), mod: m }));
    return quotaGuardPromise;
  };
  const failProviderRuns = (provider: string, message: string) => {
    for (const [id, st] of activeRuns) {
      if (st.finished || st.provider !== provider) continue;
      try { st.fail?.(message); } catch {}
      try { st.abort(); } catch {}
      st.finished = true;
      activeRuns.delete(id);
    }
  };

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

      /**
       * agent:发起这次调用的 Agent 对话 ID(多 Agent 分页)。CLI 那条路由 mcp-server 从环境变量
       * PROMPTCUT_AGENT 带上来,API 直连那条路由 startRun 的 callTool 闭包带;编辑台拿它记「谁改了哪儿」。
       */
      /*
       * 数据管理的只读镜像(docs/decoupling-plan.md 第 3.2 节,阶段 4)。
       *
       * 连着桥的编辑器页面把项目(带版本号)和停下时的播放头推过来(src/editor/dataMirror.ts)。
       * 有了它,Agent 的读和渲染 —— get_project / see_frames(成片)/ get_gif / bake_card / inspect_card_dom ——
       * 就在这里直接拿镜像去问预渲染进程,**完全不经过编辑器页面**:以前这些调用要经 SSE 转给页面,
       * 页面再发渲染请求,请求一挂几分钟,占的是编辑器那个源的连接,界面因此卡死而 CPU 一点都不忙。
       * 写操作仍然经过页面(撤销 / 重做都在那边),页面在回结果之前会先把改动推过来,读后写一致。
       * 页面关掉之后镜像还留在内存里,Agent 照样能读、能看画面。
       */
      let mirror: { session: string; rev: number; project: any; t: number; at: number } | null = null;
      server.middlewares.use('/api/data/project', (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, mirror ? 200 : 404, mirror ? { ok: true, rev: mirror.rev, t: mirror.t, at: mirror.at, project: mirror.project } : { ok: false, error: '还没有镜像:编辑器页面没打开过' });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET / POST only' });
        let body = '';
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > 64 * 1024 * 1024) { req.destroy(); return; } body += c; });
        req.on('end', () => {
          try {
            const d = JSON.parse(body || '{}');
            if (!d.project || !Array.isArray(d.project.tracks)) return sendJson(res, 400, { ok: false, error: '缺少 project' });
            const session = String(d.session || '');
            const rev = Number(d.rev) || 0;
            /*
             * 同一个页面会话里只收更新的版本:页面那边已经一次只推一个,这里再兜一道,
             * 万一两次推送乱序到达,旧的也盖不掉新的。换了页面(刷新、重开)版本号从头数,按会话区分。
             */
            if (mirror && mirror.session === session && rev <= mirror.rev) {
              return sendJson(res, 200, { ok: true, rev: mirror.rev, stale: true });
            }
            mirror = { session, rev, project: d.project, t: Number.isFinite(Number(d.t)) ? Number(d.t) : 0, at: Date.now() };
            sendJson(res, 200, { ok: true, rev: mirror.rev });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /** 这几个工具在服务端就地执行(有镜像时);其余照旧经编辑器页面 */
      const MIRRORED_TOOLS = new Set(['get_project', 'see_frames', 'get_gif', 'bake_card', 'inspect_card_dom']);

      /**
       * 服务端执行一个读 / 渲染类工具。返回 undefined = 这里不接,交给编辑器页面。
       * 出错就抛(和经页面那条路一样:桥把 error 原样交给 Agent)。
       */
      async function runMirroredTool(tool: string, args: any, toolDef: any): Promise<any> {
        if (!MIRRORED_TOOLS.has(tool) || !mirror) return undefined;
        const required: string[] = toolDef?.inputSchema?.required ?? [];
        const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
        if (missing.length) throw new Error(`缺少必填参数：${missing.join('、')}。请补齐后重试。`);
        const project = mirror.project;
        const timeoutMs = toolDef?.timeoutMs || 60000;

        if (tool === 'get_project') {
          // 和编辑器页面的 getProject 同一个形状:文字稿只给摘要,全文走 get_transcript
          return {
            ...project,
            media: (project.media || []).map((m: any) => m?.transcript ? {
              ...m,
              transcript: {
                engine: m.transcript.engine, model: m.transcript.model, language: m.transcript.language,
                createdAt: m.transcript.createdAt, segments: m.transcript.segments?.length ?? 0,
                hint: '完整文字稿请用 get_transcript',
              },
            } : m),
          };
        }

        if (tool === 'see_frames') {
          const { source, ...rest } = args || {};
          // 素材镜头拼图要跑镜头识别、写回项目,留给编辑器页面
          if (source !== undefined && source !== 'timeline') return undefined;
          const times = Array.isArray(rest.times) ? rest.times.filter((x: unknown) => typeof x === 'number').slice(0, 10) : [];
          const body = times.length
            ? { project, times, clipId: rest.clipId }
            : { project, t: typeof rest.t === 'number' ? rest.t : (rest.clipId ? undefined : mirror.t), clipId: rest.clipId };
          const data = await prerenderPost('/api/vision/snapshot', body, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '渲染画面失败');
          let result: any = times.length ? { ok: true, frames: data.frames, note: data.note, __images: data.__images } : data;
          // 聊天栏里「看得见的工具结果」:和编辑器页面的 withVisual 同一份记录
          const images: any[] = [];
          if (data.__image?.base64) images.push({ mime: data.__image.mime, base64: data.__image.base64, label: typeof data.t === 'number' ? `t=${data.t}s` : '' });
          for (const im of Array.isArray(data.__images) ? data.__images : []) if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? '' });
          if (images.length) {
            const v = await prerenderPost('/api/ai/visual', { tool: 'see_frames', images }, { timeoutMs: 5000 }).catch(() => null);
            if (v?.ok && v.visualId) result = { visualId: v.visualId, ...result };
          }
          return result;
        }

        if (tool === 'get_gif') {
          const data = await prerenderPost('/api/ai/visual', { tool: 'get_gif', clipId: args.clipId, after: project, render: true }, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '做动图失败');
          return {
            visualId: data.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
            note: '拼图 4×2,第 k 格对应 times 的第 k 个时刻(按行从左到右)。用户在聊天栏点开这一步能看到动图。',
            ...(data.grid ? { __image: { mime: 'image/png', base64: data.grid } } : {}),
          };
        }

        if (tool === 'bake_card') {
          const data = await prerenderPost('/api/vision/bake', { project, clipId: args.clipId, t: args.t, size: args.size, bg: args.bg }, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '烘焙失败');
          return data;
        }

        if (tool === 'inspect_card_dom') {
          const ref = typeof args.ref === 'string' ? Number(String(args.ref).replace(/^ref_/, '')) : args.ref;
          const data = await prerenderPost('/api/cards/dom', { project, clipId: args.clipId, t: args.t, ref, depth: args.depth }, { timeoutMs });
          if (!data?.ok) throw new Error(data?.error || '读不到 DOM 树');
          return data;
        }
        return undefined;
      }

      /** 审查环路走 CLI 时的只读锁:null = 不锁;Set = 只放行这些工具(空 Set = 全拦)。见下面 callToolInternal */
      let loopToolLock: Set<string> | null = null;

      async function callToolInternal(tool: string, args: any, agent?: string): Promise<any> {
        const { tools } = await import(new URL('./mcp-tools.mjs', import.meta.url).href);
        const toolDef = tools.find((t: any) => t.name === tool);

        if (!toolDef) {
          const err = new Error('Unknown tool');
          (err as any).code = 'UNKNOWN_TOOL';
          throw err;
        }

        /*
         * 审查环路走 CLI 时的只读锁(runners/cli-loop.mjs 通过 setToolAccess 设置)。
         *
         * CLI 的 MCP 是全局登记的,没法按回合少给工具,所以只能在执行入口拦:reviewer / judger
         * 回合只放行只读名单,反省回合一个都不放行。锁是这个服务端全局的 —— 锁住的那几分钟里
         * 别的对话页发来的写操作也会被拦,这是有意的:reviewer 正在看的工程不该被同时改。
         */
        if (loopToolLock && !loopToolLock.has(tool)) {
          return {
            ok: false,
            error: loopToolLock.size
              ? `审查环路的这一回合是只读的:${tool} 这一回合不能用。能用的只有 ${[...loopToolLock].join('、')}。`
              : `审查环路的这一回合不调用任何工具,${tool} 被拒绝。只用文字回答。`,
          };
        }

        /*
         * SKILL 模式的闸门(server/skill-gate.mjs)。
         *
         * 只在无头实例上拦,而且**拦在执行之前** —— 用户点了「关闭 SKILL 模式」就是收回了
         * 控制权,agent 那边可能正跑在半路并不知情。执行完再回滚是收拾不干净的:见过画面的
         * 卡片、写过的文件都追不回来。放行与否只看那一个状态文件,和这条调用是谁发起的无关。
         */
        const gate = await import(new URL('./skill-gate.mjs', import.meta.url).href);
        const verdict = gate.checkGate(tool);
        if (!verdict.ok) return { ok: false, skillClosed: true, message: verdict.message };

        /*
         * 读 / 渲染类工具有镜像时就地执行,直接问预渲染进程,不经过编辑器页面(见上面 runMirroredTool)。
         * 返回 undefined 的(没有镜像、素材拼图这类)照旧走桥。
         */
        const mirrored = await runMirroredTool(tool, args, toolDef);
        if (mirrored !== undefined) return mirrored;

        /*
         * side: "server" 的工具就地执行,不过浏览器桥。
         *
         * 目前只有 wait。它纯粹是「睡一会儿」,没有任何理由绕编辑台走一趟 ——
         * 而且这样一来,即使桥这一刻忙着,轮询之间的等待也不会失败。
         * 上面那道 SKILL 闸门仍然管得着它(用户收回控制权时连等待都不该继续)。
         */
        if (toolDef.side === 'server') {
          if (tool === 'wait') {
            // 只认真正的数字:Number(null) 是 0、Number('') 也是 0,靠 isFinite 判会把
            // 「没填」当成「填了 0」再夹到 1 秒 —— 那不是用户的意思,默认该是 3 秒
            const raw = (args as any)?.seconds;
            const secs = typeof raw === 'number' && Number.isFinite(raw)
              ? Math.min(30, Math.max(1, raw))
              : 3;
            await new Promise((r) => setTimeout(r, secs * 1000));
            return { ok: true, waited: secs };
          }
          if (tool === 'report_progress') {
            // 进度报告只做校验和规范化,界面直接读 tool_call 事件里的 input。
            const { validateProgressReport } = await import(new URL('./progress-report.mjs', import.meta.url).href);
            const checked = validateProgressReport(args);
            if (!checked.ok) {
              return { ok: false, error: checked.error };
            }
            return { ok: true, message: '已记录进度报告', report: checked.value };
          }
          return { ok: false, error: `服务端工具 ${tool} 没有实现` };
        }

        if (!editorRes) {
          throw new Error('编辑台没有打开:没有页面连着 /api/mcp/events');
        }

        const id = nextCallId++;
        // 大多数工具是即时的,慢活儿都返回 jobId 让调用方轮询,所以 60 秒够用。
        // 例外是 see_frames:它当场起一个 Chrome 渲一帧,冷启动加素材预热可能过分钟。
        // 让工具自己声明上限,而不是把所有工具一起放宽 —— 真卡住的时候还是该早点报错。
        const limit = toolDef.timeoutMs || 60000;
        // 定时器句柄要留着:工具正常返回之后不清掉的话,每一次调用都在事件循环里留一个
        // 最长几十秒的游离定时器。工具调用是高频的,积起来就是白占的内存和唤醒。
        let timer: ReturnType<typeof setTimeout> | undefined;
        const p = new Promise<any>(resolve => {
          pendingCalls.set(id, (result: any) => { clearTimeout(timer); resolve(result); });
          timer = setTimeout(() => {
            if (pendingCalls.has(id)) {
              pendingCalls.delete(id);
              resolve({ ok: false, error: `${tool} 超过 ${Math.round(limit / 1000)} 秒没有返回,已放弃等待。` });
            }
          }, limit);
        });

        editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool, args, agent: agent || undefined })}\n\n`);
        
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
       * 列出某家能用的模型。
       *
       * 两条路:
       *   - `agy`:跑 `agy models`(输出是「名字<TAB>说明」);
       *   - `api`:打 OpenAI 兼容的 `GET {baseUrl}/v1/models`。中转站基本都实现了这个口子,
       *     返回 `{ data: [{ id, object, owned_by }], object: "list" }`。
       *
       * claude / codex 没有对应命令,清单只能在设置里手填 —— 与其编一份可能过期的
       * 硬编码名单,不如老实说这一家读不到。
       */
      server.middlewares.use('/api/ai/models', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider');

        if (provider === 'api') {
          try {
            const { readConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
            const api = (readConfig() as any)?.api || {};
            if (!api.apiKey) return sendJson(res, 400, { ok: false, error: '还没填 API Key,拉不了模型清单' });
            if (!api.baseUrl) return sendJson(res, 400, { ok: false, error: '还没填接口地址(官方源没有统一的清单口子,中转站才有)' });
            const { listApiModels } = await import(new URL('./runners/api-models.mjs', import.meta.url).href);
            const models = await listApiModels(api);
            return sendJson(res, 200, { ok: true, models });
          } catch (e: any) {
            return sendJson(res, 500, { ok: false, error: e.message || String(e) });
          }
        }

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
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
          req.on('end', async () => {
            if (over) return;
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
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
          req.on('end', async () => {
            if (over) return;
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
        req.on('data', (c) => { if (tooBig) return; body += c; tooBig = overLimit(req, res, body.length, 64 * 1024 * 1024, '报告超过 64MB,没有保存'); });
        req.on('end', () => {
          if (tooBig) return;
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
          const [{ publicConfig }, { setupRoot }, { machineCode, redactMachineCode }, env, runners] = await Promise.all([
            import(new URL('./ai-config.mjs', import.meta.url).href),
            import(new URL('./runners/cli-runtime.mjs', import.meta.url).href),
            import(new URL('./runners/machine-id.mjs', import.meta.url).href),
            import(new URL('./harness/env-snapshot.mjs', import.meta.url).href),
            getRunner(),
          ]);
          res.setHeader('Cache-Control', 'no-store');
          /*
           * 驱动探活会给 claude / codex / agy 各起一个子进程(runners/auth.mjs,
           * 单个超时 15 秒)。诊断报告那条路等不起,而且它要的是**这台机器的现状**,
           * 不是「CLI 现在还登着吗」,所以它带 ?refresh=0 走进程内缓存。
           *
           * 还要把它单独 try 起来:原来整个响应是 all-or-nothing 的,探活一抛错就 500,
           * 把 node 和 sessions 一起带走 —— 而那两段恰恰是这个按钮最有价值的产出,
           * 偏偏在机器出问题的时候最容易被连坐。
           */
          const refresh = new URL(req.url || '/', 'http://x').searchParams.get('refresh') !== '0';
          let providers: unknown;
          try {
            /*
             * refresh=0 那条路(诊断快照)再压一道时限。
             *
             * 但**要说清这道时限管不到什么**,别把它当成一张不存在的保票:
             * runners/index.mjs 的 probeVersion 用的是 execFileSync,而三个 provider
             * 都在第一个 await 之前调它 —— 也就是说 listProviders(...) 这个调用本身
             * 就同步阻塞(每个 CLI 上限 15 秒),下面那个 setTimeout 要等它返回之后
             * 才被创建。CLI 真卡住时这道 race 完全不生效,整个 dev server 一起冻住。
             * 真修法是把 probeVersion 改成异步 execFile,那要单独一轮评审。
             *
             * 它管得到的是:探活本身返回慢(而不是卡死)、以及 listProviders 抛错。
             * 这两种下面照常把 node 和 sessions 返回 —— 那两段才是这个按钮最有价值的
             * 产出,不该被 providers 这一格连坐。
             *
             * 缓存也别高估:TTL 只有 5 秒(index.mjs),用户点按钮时基本不命中,
             * 所以 refresh=0 的实际收益是「不强制刷新 probeAuth」,不是「直接走缓存」。
             *
             * refresh=true 那条路(AI 设置里的「诊断」)不压时限:它要的就是真实探活结果。
             */
            providers = refresh
              ? await runners.listProviders({ refresh })
              : await Promise.race([
                  runners.listProviders({ refresh: false }),
                  new Promise((resolve) => setTimeout(() => resolve({ error: '驱动探活超时', 说明: '超过 2.5 秒没回来,这一格先跳过 —— 下面那些机器状态仍然有效' }), 2500)),
                ]);
          }
          catch (e: any) { providers = { error: e?.message || String(e), 说明: '驱动探活失败 —— 下面那些机器状态仍然有效' }; }
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
            // 本地服务这个进程的现状:跑了多久、内存还剩多少、是打包版还是源码跑的。
            // 「重启一下就好了」这类问题,不看这些就只能靠猜。
            node: env.nodeStatus(),
            /*
             * 后端的会话文件柜。界面上的对话是按项目走的,而**服务端接哪段历史**取决于
             * localStorage 里那把会话 id;两者脱节时界面上完全看不出来(见 81f255b)。
             * 报「有几段、各几条、多新」,是这类看不见的串台唯一的物证。不含对话内容。
             */
            sessions: env.inspectSessionStore(),
            providers,
            providersRefreshed: refresh,
            config: publicConfig(),
          });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      /*
       * 本机识别码:分发 API 配置时当加密口令用。只给摘要后的码,原始指纹不出服务端。
       *
       * 这里**故意返回完整码**,不像 /api/ai/diagnostics 那样截断 —— 用户就是要把这一整串
       * 发给帮他加密配置的人,截了这个功能就没了。它的保护来自 vite-plugin-api-guard 那道
       * 同源卡口:本机上别的网页(它们都是跨源)打不进这个接口。
       */
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
        let over = false;
        req.on('data', (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
        req.on('end', async () => {
          if (over) return;
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
        let over = false;
        req.on('data', (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 200_000, '请求体超过 200KB'); });
        req.on('end', async () => {
          if (over) return;
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
          const { publicConfig, writeConfig, clearKey } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          // POST /api/ai/config/clear-key {kind}:删掉那一路的密钥文件(设置窗口里的「清理密钥」)
          if ((req.url || '').split('?')[0] === '/clear-key') {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
            let body = '';
            let over = false;
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
            req.on('end', () => {
              if (over) return;
              try {
                const { kind } = JSON.parse(body || '{}');
                clearKey(kind);
                sendJson(res, 200, { ok: true, config: publicConfig() });
              } catch (e: any) {
                sendJson(res, 400, { ok: false, error: e.message });
              }
            });
            return;
          }
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, config: publicConfig() });
          } else if (req.method === 'POST') {
            let body = '';
            let over = false;
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 200_000, '请求体超过 200KB'); });
            req.on('end', () => {
              if (over) return;
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
        let over = false;
        // 32MB:附件带的是地址和文本(ChatAttachment 没有内联二进制),整段字幕、整篇文档都够;
        // 再大就不是正常输入了,而是有人在往这条路上灌东西。
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, '请求体超过 32MB'); });
        req.on('end', async () => {
          if (over) return;
          let hasDone = false;
          try {
            const runners = await getRunner();
            const data = JSON.parse(body);
            const { provider, prompt, sessionId, model, effort, fast, attachments, script, schemaCompat, deepAuto } = data;
            // 多 Agent 分页:这一页的对话 ID。只认会话 id 的字符集,别的一律当没带
            const agentId: string = typeof data.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : '';

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
            // 素材库那几条单列:给 mediaId 和卡片能直接用的 cardUrl,**不给磁盘路径** ——
            // 以前每轮都把每个素材的磁盘路径塞进来,模型没有能读它的工具,却一再被引着去读(见 src/ai/mediaRef.ts)
            const library = (attachments || []).filter((a: any) => a.library);
            const userFiles = (attachments || []).filter((a: any) => !a.library);
            if (library.length > 0) {
              const kindName: Record<string, string> = { video: '视频', image: '图片', audio: '音频' };
              finalPrompt += '\n\n素材库(已导入,工具里用 mediaId;卡片参数里引用填 cardUrl):\n' + library.map((a: any) => {
                let line = `- [${kindName[a.kind] || a.kind}] ${a.name} · mediaId ${a.id} · cardUrl ${a.url}`;
                if (a.durationSec && a.kind !== 'image') line += ` · 时长 ${a.durationSec} 秒`;
                return line;
              }).join('\n');
            }
            if (userFiles.length > 0) {
              finalPrompt += '\n\n附件:\n' + userFiles.map((a: any) => {
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
            finalPrompt += `\n\n当前端口 ${editorPort};${editorState}` + (agentId ? `;你的 Agent 对话 ID:${agentId}` : '');

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
              env: { PROMPTCUT_PORT: String(editorPort), ...(agentId ? { PROMPTCUT_AGENT: agentId } : {}) }
            };

            const cwd = path.join(server.config.root, 'exports', 'ai-workspace');
            fs.mkdirSync(cwd, { recursive: true });

            const runId = Math.random().toString(36).substring(2, 9);
            res.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);

            const { publicConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
            const cfg = publicConfig();

            // 额度熔断:先看这一路的用量,超线就不起 CLI 了,直接把原因告诉用户
            const { guard: quotaGuard, mod: quotaMod } = await getQuotaGuard();
            try {
              // 把模型一起递进去:claude 的 /usage 里「本周(Fable)」那种窗口是模型专属的,
              // 不跑那个模型就不该拿它来拦(见 quota.mjs 的 decidingWindows)
              await quotaGuard.gate(provider, cfg.quota, model);
            } catch (e: any) {
              if (e instanceof quotaMod.QuotaExceededError) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: e.message, quota: e.quota })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                clearInterval(keepAlive);
                res.end();
                return;
              }
              throw e;
            }
            let replyBytes = 0;

            const run = runners.startRun({
              provider,
              prompt: finalPrompt,
              systemPrompt,
              sessionId,
              cwd,
              model,
              /*
               * 深度自主:轮次上限换成设置里的「自主轮次」(ai.json 的 deepAutoRounds,
               * 默认 300,填 0 就是不限),而且不再给模型任何关于轮次的话。
               *
               * 轮数从**服务端配置**取,不听请求体里的数 —— 前端只发一个「开没开」的布尔。
               * 上限是道安全阀,不该由一个请求字段随手顶开。
               */
              maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
              deepAuto: !!deepAuto,
              // 推理强度和加速档:哪家支持哪些由各自的 runner 翻译成标志,
              // 不支持的直接忽略(前端也已经把对应控件灰掉了)
              effort,
              fast,
              /*
               * 深度自主:轮次上限换成设置里的「自主轮次」(ai.json 的 deepAutoRounds,
               * 默认 300,填 0 就是不限),而且不再给模型任何关于轮次的话。
               *
               * 轮数从**服务端配置**取,不听请求体里的数 —— 前端只发一个「开没开」的布尔。
               * 上限是道安全阀,不该由一个请求字段随手顶开。
               */
              maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
              deepAuto: !!deepAuto,
              // 参数兼容模式(工具 schema 按 Gemini 子集清洗):'auto' / 'on' / 'off',API 直连的 runner 才用
              schemaCompat,
              // 审查环路单独开关(只有 API 直连用);不传就跟着深度自主走,见 runners/api.mjs
              reviewLoop: typeof data.reviewLoop === 'boolean' ? data.reviewLoop : undefined,
              // 审查环路走 CLI 时,按回合给工具上只读锁(见 callToolInternal)。null = 解锁
              setToolAccess: (list: string[] | null) => { loopToolLock = list ? new Set(list) : null; },
              toolProtocol: cfg.toolProtocol,
              mcp,
              callTool: async (name: string, args: any) => await callToolInternal(name, args, agentId || undefined),
              onEvent: (ev: any) => {
                if (ev.type === 'done') hasDone = true;
                if (ev.type === 'text' && typeof ev.delta === 'string') replyBytes += Buffer.byteLength(ev.delta, 'utf8');
                // The chat never reads a tool result's full output (get_project is the whole
                // project); sending it made the editor parse and trace megabytes per result.
                // Server-side consumers of onEvent still receive it unchanged.
                const outbound = ev.type === 'tool_result' && ev.output !== undefined ? { ...ev, output: undefined, outputOmitted: true } : ev;
                res.write(`data: ${JSON.stringify(outbound)}\n\n`);
              }
            });

            const runState = {
              abort: run.abort, finished: false, provider,
              // 后台重查发现超线时,把原因写给正在看这条对话的人,再掐进程
              fail: (message: string) => { try { res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`); } catch {} },
            };
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
            // 记账:这一轮新增的上下文 = 发出去的提示词 + 收回来的回复。到线就后台重查,超线掐同一路的其他对话
            const noted = quotaGuard.note(provider, Buffer.byteLength(finalPrompt, 'utf8') + replyBytes, cfg.quota, model);
            if (noted) noted.then((v: any) => { if (v?.blocked) failProviderRuns(provider, v.message); }).catch(() => {});
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

      // 额度:给设置窗口显示用。refresh=1 强制重查(Claude 那条要跑一次 claude -p,十来秒)
      server.middlewares.use('/api/ai/quota', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const provider = url.searchParams.get('provider') || '';
          const { guard, mod } = await getQuotaGuard();
          if (!mod.QUOTA_PROVIDERS.includes(provider)) return sendJson(res, 400, { ok: false, error: '只有 claude / codex 有额度窗口' });
          const { publicConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          const cfg = mod.normalizeQuotaConfig(publicConfig().quota);
          const quota = await guard.get(provider, { refresh: url.searchParams.get('refresh') === '1' });
          // 面板问的时候也要带上模型,不然显示的「已熔断」和真正发起对话时的判定对不上
          const verdict = guard.verdict(provider, cfg, url.searchParams.get('model') || '');
          sendJson(res, 200, { ok: true, quota, config: cfg, blocked: !!verdict.blocked, message: verdict.message ?? null, bytesSince: guard.bytesSince(provider) });
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/abort', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let over = false;
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
        req.on('end', () => {
          if (over) return;
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

        /*
         * 谁能当编辑台:先来后到,但**正在干活的实例不许被踢**。
         *
         * 这个位置只有一个(editorRes),后连的会把前一个挤掉。平时这是对的 —— 用户刷新
         * 页面就得靠它重新接管。但 Skill 模式下会出事:agent 拿自己的浏览器打开编辑台
         * 想「看一眼」布局,一连上就把无头实例那个页面踢了,之后它的所有工具调用全部失败,
         * 而被踢的那一方是**永久放弃**的(mcpExecutor 里 active=false),不会自己回来。
         * 实测过:Claude 桌面版自带的浏览器打开 127.0.0.1 就能接管这个位置。
         *
         * 所以给「正在干活的那个」发一把钥匙:无头实例的页面带 owner=<令牌> 连进来,
         * 之后没有同一把钥匙的连接一律**拒绝**(而不是接管)。普通用户那份不带 owner,
         * 行为和以前一模一样,刷新照样能接管 —— 这道锁只在有人明确宣示所有权时才生效。
         */
        const url = new URL(req.url || '/', 'http://localhost');
        const owner = url.searchParams.get('owner') || '';
        if (editorOwner && owner !== editorOwner) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            ok: false,
            error: '编辑台已被一个正在运行的实例占用',
            // 别让人去猜该加什么后缀:钥匙在环境变量里,直接把能用的那条链接给出去
            hint: process.env.PROMPTCUT_VIEW_TOKEN
              ? `这个端口上有 Skill 任务在跑。想看画面请打开这条只读链接(钥匙已在里面):http://${req.headers.host || '127.0.0.1'}/?draft=project&view=${encodeURIComponent(process.env.PROMPTCUT_VIEW_TOKEN)}`
              : '这个端口上有 Skill 任务在跑。想看画面请用只读方式打开:在地址后面加 ?observe=1,那样不会抢走它的连接。',
          }));
        }

        if (editorRes) {
          editorRes.write(`data: ${JSON.stringify({ type: "replaced" })}\n\n`);
          editorRes.end();
        }

        editorOwner = owner;
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
            // 主人走了,锁跟着放 —— 否则实例崩了之后这个端口永远没人能连上
            editorOwner = '';
          }
        });
      });

      server.middlewares.use('/api/mcp/result', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let over = false;
        // 工具结果从页面回来,里面可能整段是画面或大段文本,给得宽一点;宽也是有上限的。
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, '工具结果超过 64MB'); });
        req.on('end', () => {
          if (over) return;
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
        let over = false;
        req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, '请求体超过 32MB'); });
        req.on('end', async () => {
          if (over) return;
          try {
            const { tool, args, agent } = JSON.parse(body);
            const result = await callToolInternal(tool, args, typeof agent === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(agent) ? agent : undefined);
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
        let activeRunCount = 0;
        for (const st of activeRuns.values()) if (!st.finished) activeRunCount++;
        sendJson(res, 200, {
          editorConnected: !!editorRes,
          // 有主 = 这个端口被一个正在跑的实例占着,别的页面连不上(只能 ?observe=1 只读打开)
          editorOwned: !!editorOwner,
          pending: pendingCalls.size,
          /*
           * 还有几轮对话正在跑。装补丁的脚本(desktop/scripts/apply-patch.ps1)靠它决定
           * 要不要拦一下 —— 补丁会把整个 runtime/app 覆盖掉,而覆盖发生在一个正在服务
           * 页面的 dev server 脚下时,agent 那边**不会崩,只会哑**:Node 里的循环照跑、
           * 对模型的请求照发,但页面发出的每一个 HTTP 请求(工具结果回传、看画面、读卡源码)
           * 全部挂住,直到服务重新起来。表现就是一连串莫名其妙的工具超时,查不到原因。
           */
          activeRuns: activeRunCount,
          port
        });
      });
    }
  };
}
