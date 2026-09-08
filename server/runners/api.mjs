import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Agent } from '../harness/agent.mjs';
import { MessageHistory } from '../harness/history.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { createRetryingFetch } from '../harness/retry-fetch.mjs';
import { withIdleTimeout } from '../harness/idle-timeout.mjs';

/**
 * 把「有 tool_use、没有配对 tool_result」的半截回合补平,再落盘。
 *
 * # 为什么需要
 *
 * agent.mjs 是先把带 tool_use 的 assistant 消息入历史(:71),跑完工具才把
 * tool_result 入历史(:134)。中间那一段有三道 checkAbort —— 用户在工具执行途中点停止,
 * 就会在历史里留下一个悬空的 tool_use。
 *
 * 以前这不要紧:出错那条路根本不落盘。而现在「中断也落历史」之后,这份不配对的历史
 * 会被写进 `%TEMP%/promptcut/harness-sessions/<sessionId>.json`,下次原样读回 ——
 * 于是发出去的消息里会出现「带 tool_calls 的 assistant 紧跟一条纯文本 user、
 * 中间没有任何 role:"tool"」,Anthropic 和 OpenAI 都按规范拒绝。
 * **这个 sessionId 从此每次都 400**,而用户根本不知道有这么个文件可以删。
 *
 * 补一条 is_error 的 tool_result 而不是把 tool_use 删掉:让模型下次能看见
 * 「刚才那一步被打断了」,而不是莫名其妙少了一段。
 */
function healDanglingToolUse(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.slice();
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter(b => b?.type === 'tool_use' && b.id).map(b => b.id);
    if (!ids.length) continue;
    // 配对的 tool_result 只可能在紧随其后的那条 user 消息里(agent.mjs 就是这么拼的)
    const next = out[i + 1];
    const done = new Set(
      next?.role === 'user' && Array.isArray(next.content)
        ? next.content.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id)
        : [],
    );
    const missing = ids.filter(id => !done.has(id));
    if (!missing.length) continue;
    const patch = missing.map(id => ({
      type: 'tool_result', tool_use_id: id, is_error: true,
      content: '已中断,这次调用没有执行完。',
    }));
    if (next?.role === 'user' && Array.isArray(next.content)) {
      out[i + 1] = { ...next, content: [...patch, ...next.content] };
    } else {
      out.splice(i + 1, 0, { role: 'user', content: patch });
    }
  }
  return out;
}

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
        const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        if (Array.isArray(parsed)) initialMessages = parsed;
        // 是合法 JSON 但不是消息数组(文件被外部改过)。静默丢空的话,用户看到的是
        // 「它忘了刚才说过的话」而没有任何线索 —— 说一声,至少知道往哪儿查。
        else safeOnEvent({ type: 'status', text: '这个会话的历史文件格式不对,已从空白开始。' });
      } catch {}
    }
    
    /*
     * 读回来的也要治一道。落盘那一处(saveHistory)已经补过悬空的 tool_use,
     * 但盘上可能躺着**在那之前**写坏的历史:那时候中断是不落盘的,后来改成落盘了,
     * 于是开发机上留下过一批带悬空 tool_use 的文件。只治写不治读的话,
     * 这种脏会话会先撞一次 400、靠 catch 里的 saveHistory 自愈,下一条才正常。
     */
    const history = MessageHistory.fromJSON(healDanglingToolUse(initialMessages), { onEvent: safeOnEvent });

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
     * 三层包在一起,顺序是有讲究的(从外到内):重试 → 闲置超时 → 真正的 fetch。
     *
     * 重试在最外面:每次尝试都要重新走一遍闲置超时那一层,拿到一份**新的**计时器。
     * 反过来的话第二次尝试会带着上一次已经到期的 signal 出门,当场就 abort。
     *
     * 停止用的是 abortController.signal(用户点停止),退避等待期间也听它 ——
     * 不然点了停止还要干等十几秒才有反应。
     * 只重试「发请求」这一下:流已经开始读之后不能重发,详见 retry-fetch.mjs 的说明。
     */
    const retryingFetch = createRetryingFetch(
      // 超时按「多久没来数据」算,不按「一共跑了多久」算 —— 原来是 AbortSignal.timeout(120000),
      // 那是整段请求的墙钟上限(含读流),一个健康地流了 121 秒的长回合会被硬掐断。
      // 上下文越大、工具越多越容易撞上,也就是活干得越多越容易被掐。见 harness/idle-timeout.mjs。
      withIdleTimeout(
        (url, options) => requestFetch(url, {
          ...options,
          /*
           * **合并,不能覆盖。**
           *
           * 这里原来写的是 `signal: abortController.signal` —— 一行之差,把
           * withIdleTimeout 组合好的信号整个盖掉了,于是闲置定时器到点 abort 的那个
           * controller 根本没人在听:上游真卡住时这一轮永远不结束,不报错、不触发自动续跑,
           * 界面上只有心跳在涨。而改之前 AbortSignal.timeout 是直接交给真 fetch 的,
           * 会真的掐断 —— 也就是说那一版比改之前更糟,是回归。
           *
           * options.signal 里已经含了用户停止那一路(withIdleTimeout 组合过),
           * 这里再并一次 abortController.signal 是为了「即使包装层将来变了,
           * 用户点停止也一定管用」这条保证不依赖上游实现。
           */
          signal: options?.signal
            ? AbortSignal.any([abortController.signal, options.signal])
            : abortController.signal,
        }),
        // 阈值可以从 opts 传,给测试用 —— 不然一条「上游不吐字」的用例要真等两分钟。
        // 生产路径没人传,走 120 秒。
        { idleMs: Number(opts.idleMsForTest) > 0 ? Number(opts.idleMsForTest) : 120000 },
      ),
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

    /*
     * 落历史。**成功和失败都要落** ——
     *
     * 原来只在成功那条路写盘,于是一超时/一报错,这一轮做过的事(说过的话、调过的工具)
     * 全部丢掉:下次带同一个 sessionId 进来,读到的还是上一轮的历史。用户手打「继续」
     * 看着像接上了,其实是从更早的地方重新开始 —— 而且他不会知道。
     * 中断恰恰是最需要「记得刚才干到哪」的时候。
     */
    const saveHistory = () => {
      try {
        const historyStr = JSON.stringify(healDanglingToolUse(history.toJSON()));
        // 再确认一遍历史里没有 API Key
        fs.writeFileSync(
          historyFile,
          currentApiKey && historyStr.includes(currentApiKey)
            ? historyStr.split(currentApiKey).join('***')
            : historyStr,
          'utf8',
        );
      } catch (e) {
        // 存不下也不该把这一轮的结果盖掉,记一句就够了
        console.error('[api] 会话历史没写成:', e?.message || e);
      }
    };

    try {
      const result = await agent.run(opts.prompt);
      saveHistory();

      const rawUsage = result.usage || {};
      const usage = {
        input: typeof rawUsage.input === 'number' ? rawUsage.input : 0,
        output: typeof rawUsage.output === 'number' ? rawUsage.output : 0
      };
      
      safeOnEvent({ type: 'done', sessionId, usage, outcome: result.outcome, completed: result.completed, failed: result.failed });
    } catch (err) {
      // 半路断了也要把做到哪儿记下来,不然「继续」接的是更早的那一轮
      saveHistory();

      if (abortController.signal.aborted) {
        // 用户点了停止 —— 这是他的决定,不报错也不自动续
        safeOnEvent({ type: 'status', text: '已中止' });
      } else {
        let msg = err.message || String(err);
        if (currentApiKey && msg.includes(currentApiKey)) {
          msg = msg.split(currentApiKey).join('***');
        }
        /*
         * 超时是**可续跑**的:上下文都在历史里(上面刚存过),模型只是这一次没在
         * 规定时间内吐字。让它接着说,而不是让用户去手打「继续」。
         *
         * 注意 AbortError 不能一律当成「用户停止」:`AbortSignal.timeout` 触发时
         * 抛的是 TimeoutError,而经 AbortSignal.any 传递之后名字可能是 AbortError ——
         * 原来那句 `err.name === 'AbortError'` 会把超时也吞成一条「已中止」的状态,
         * 连红字都不给,用户只看到对话无声停住。所以判「是不是用户停的」只认
         * abortController.signal.aborted 这一个真凭据。
         */
        const isTimeout = err.name === 'TimeoutError' || /timeout|timed out|aborted due to timeout/i.test(msg);
        safeOnEvent(isTimeout ? {
          type: 'error',
          message: msg,
          retryable: true,
          retryPrompt: `接着上面继续做。上一轮没做完就断了,原因是:${msg}。\n`
            + `之前的进度都还在,不用重头再来,从刚才停下的地方接着做就行。\n`
            + `如果上一步是在等某个后台作业,用 wait 工具等几秒再查它的状态。`,
        } : { type: 'error', message: msg });
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
