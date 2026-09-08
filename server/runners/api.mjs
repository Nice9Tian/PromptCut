import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Agent } from '../harness/agent.mjs';
import { MessageHistory } from '../harness/history.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { createRetryingFetch } from '../harness/retry-fetch.mjs';

// 对应 13.3 及获取配置接口
export async function getApiProvider() {
  let configModule;
  try {
    configModule = await import('../ai-config.mjs');
  } catch {
    return {
      id: 'api',
      label: 'API 直连',
      available: false,
      version: undefined,
      auth: {
        loggedIn: false,
        detail: '配置模块缺失'
      },
      note: '配置模块缺失'
    };
  }

  try {
    const cfg = configModule.readConfig()?.api || {};
    const available = typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '';
    const version = cfg.vendor && cfg.model ? `${cfg.vendor}/${cfg.model}` : undefined;
    return {
      id: 'api',
      label: 'API 直连',
      available,
      version,
      auth: {
        loggedIn: available,
        detail: available ? undefined : '还没填 API Key'
      },
      note: undefined
    };
  } catch (e) {
    let msg = e.message || String(e);
    return {
      id: 'api',
      label: 'API 直连',
      available: false,
      version: undefined,
      auth: {
        loggedIn: false,
        detail: `读取配置失败: ${msg}`
      },
      note: `读取配置失败: ${msg}`
    };
  }
}

// 对应 4.1 与 14.3 Harness 入口
export function startRun(opts) {
  const sessionId = opts.sessionId || `api-${crypto.randomUUID().substring(0, 8)}`;
  let isAborted = false;
  let currentApiKey = '';

  const safeOnEvent = (ev) => {
    if (isAborted && ev.type !== 'status') return;
    try {
      const safe = currentApiKey ? JSON.parse(JSON.stringify(ev).split(currentApiKey).join('[REDACTED]')) : ev;
      opts.onEvent(safe);
    } catch {}
  };

  const abortController = new AbortController();

  const donePromise = (async () => {
    safeOnEvent({ type: 'session', sessionId });

    let cfg;
    if (opts.apiConfig && typeof opts.apiConfig === 'object') {
      cfg = opts.apiConfig;
      currentApiKey = cfg.apiKey || '';
    } else {
      let configModule;
      try {
        configModule = await import('../ai-config.mjs');
      } catch {
        safeOnEvent({ type: 'error', message: 'API 直连不可用:配置模块缺失' });
        return;
      }
      try {
        cfg = configModule.readConfig()?.api || {};
      } catch {
        cfg = {};
      }
      currentApiKey = cfg.apiKey || '';
    }

    if (cfg.vendor !== 'mock' && !currentApiKey) {
      safeOnEvent({ type: 'error', message: 'API 直连不可用:还没填 API Key' });
      return;
    }

    // 配置里的 model 允许写成 `a|b|c` 一串备选,面板上让用户挑。
    // 这一次跑哪个由 opts.model 决定;没挑就用清单里第一个。
    const modelList = String(cfg.model || '').split('|').map(s => s.trim()).filter(Boolean);
    const picked = opts.model && modelList.includes(opts.model) ? opts.model : modelList[0] || '';
    // 参数兼容模式:'on' / 'off' 是用户(或前端按模型名锁定)的决定;'auto' / 没传 就按厂商和模型名推 ——
    // 走 OpenAI 兼容接口的 Router 也可能接的是 Gemini,厂商字段靠不住,模型名里有 gemini 就开
    const schemaCompat = opts.schemaCompat === 'on' ? true
      : opts.schemaCompat === 'off' ? false
      : (cfg.vendor === 'gemini' || /gemini/i.test(picked));
    /*
     * 思考强度。CLI 那三条路各自翻译成命令行参数(claude 的 --effort、codex 的
     * -c model_reasoning_effort、agy 的 --effort),而 API 直连这条路以前**根本没读过它** ——
     * 面板上的档位对 API 是死的。走 OpenAI 兼容口径的中转是收 `reasoning_effort` 的,
     * 具体怎么发交给各 provider 自己决定(每家字段名不一样)。
     * 空值不覆盖:让模型 / 网关按自己的默认来。
     */
    cfg = { ...cfg, model: picked, schemaCompat, effort: opts.effort || '' };

    const historyDir = path.join(os.tmpdir(), 'promptcut', 'harness-sessions');
    fs.mkdirSync(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, `${sessionId}.json`);
    
    let initialMessages = [];
    if (fs.existsSync(historyFile)) {
      try {
        initialMessages = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      } catch {}
    }
    
    const history = MessageHistory.fromJSON(initialMessages, { onEvent: safeOnEvent });

    let providerModule;
    if (cfg.vendor === 'anthropic') {
      providerModule = await import('../harness/providers/anthropic.mjs');
    } else if (cfg.vendor === 'openai') {
      providerModule = await import('../harness/providers/openai.mjs');
    } else if (cfg.vendor === 'gemini') {
      providerModule = await import('../harness/providers/gemini.mjs');
    } else if (cfg.vendor === 'mock') {
      providerModule = await import('../harness/providers/mock.mjs');
    } else {
      safeOnEvent({ type: 'error', message: '不认识的 vendor' });
      return;
    }

    const requestFetch = opts.fetchImpl || globalThis.fetch;
    /*
     * 自动重试包在**最外层**,不在里面。
     *
     * 里面那个箭头函数每次被调用都新建一份 120 秒超时 signal —— 重试必须重新调它,
     * 才能拿到一份没烧过的超时;要是把重试塞进 signal 里面,第二次尝试会带着
     * 上一次已经到期的 signal 出门,当场就 abort。
     *
     * 停止用的是 abortController.signal(用户点停止),退避等待期间也听它 ——
     * 不然点了停止还要干等十几秒才有反应。
     * 只重试「发请求」这一下:流已经开始读之后不能重发,详见 retry-fetch.mjs 的说明。
     */
    const retryingFetch = createRetryingFetch(
      (url, options) => requestFetch(url, { ...options, signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(120000)]) }),
      {
        signal: abortController.signal,
        onRetry: ({ attempt, of, reason, delayMs }) => {
          console.error(`[api] ${reason},${delayMs}ms 后重试(第 ${attempt}/${of} 次)`);
        },
      },
    );
    const provider = providerModule.createProvider(cfg, { fetchImpl: retryingFetch });
    /*
     * 轮次上限:常规 24 轮;「深度自主」开着时换成设置里的「自主轮次」(opts.maxRounds),
     * 那个值为 0 表示不限 —— 在这里变成 Infinity,循环就没有终点了。
     */
    const maxIterations = opts.deepAuto
      ? (opts.maxRounds === 0 ? Infinity : Number(opts.maxRounds) || 300)
      : 24;
    safeOnEvent({ type: 'diagnostic', stage: 'configuration', data: { vendor: cfg.vendor, model: cfg.model, effort: cfg.effort || '(默认)', maxTokens: cfg.maxTokens, protocol: 'native-tools', schemaCompat, maxRounds: Number.isFinite(maxIterations) ? maxIterations : null, deepAuto: !!opts.deepAuto } });
    const tools = await buildTools({ callTool: opts.callTool, workspaceDir: opts.cwd, onEvent: safeOnEvent });
    const agent = new Agent({ 
      provider, 
      system: opts.systemPrompt, 
      tools, 
      maxIterations,
      deepAuto: !!opts.deepAuto,
      onEvent: safeOnEvent, 
      signal: abortController.signal, 
      history 
    });

    try {
      const result = await agent.run(opts.prompt);
      
      const toSave = history.toJSON();
      const historyStr = JSON.stringify(toSave);
      // Double check that API key is not in history
      if (currentApiKey && historyStr.includes(currentApiKey)) {
        fs.writeFileSync(historyFile, historyStr.split(currentApiKey).join('***'), 'utf8');
      } else {
        fs.writeFileSync(historyFile, historyStr, 'utf8');
      }
      
      const rawUsage = result.usage || {};
      const usage = {
        input: typeof rawUsage.input === 'number' ? rawUsage.input : 0,
        output: typeof rawUsage.output === 'number' ? rawUsage.output : 0
      };
      
      safeOnEvent({ type: 'done', sessionId, usage, outcome: result.outcome, completed: result.completed, failed: result.failed });
    } catch (err) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        safeOnEvent({ type: 'status', text: '已中止' });
      } else {
        let msg = err.message || String(err);
        if (currentApiKey && msg.includes(currentApiKey)) {
          msg = msg.split(currentApiKey).join('***');
        }
        safeOnEvent({ type: 'error', message: msg });
      }
    }
  })();

  return {
    abort: () => {
      isAborted = true;
      abortController.abort();
    },
    done: donePromise
  };
}
