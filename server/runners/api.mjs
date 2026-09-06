import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Agent } from '../harness/agent.mjs';
import { MessageHistory } from '../harness/history.mjs';
import { buildTools } from '../harness/tools/index.mjs';

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
    const provider = providerModule.createProvider(cfg, { fetchImpl: (url, options) => requestFetch(url, { ...options, signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(120000)]) }) });
    safeOnEvent({ type: 'diagnostic', stage: 'configuration', data: { vendor: cfg.vendor, model: cfg.model, maxTokens: cfg.maxTokens, protocol: 'native-tools', maxRounds: 24 } });
    const tools = await buildTools({ callTool: opts.callTool, workspaceDir: opts.cwd, onEvent: safeOnEvent });
    const agent = new Agent({ 
      provider, 
      system: opts.systemPrompt, 
      tools, 
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
