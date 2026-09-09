// 对应 claude-quickstarts/agents/providers/gemini.py
// 本家 API 要点: GenerateContent 接口，role 为 user/model，工具用 functionDeclarations/functionCall/functionResponse，SSE 解析 candidates。
import { readSse, assertOk } from './base.mjs';
import { toolToVendor } from '../schema.mjs';

export function createProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  let toolUseCounter = 0;
  
  return {
    name: 'gemini',
    async *stream(messages, tools, system, signal) {
      let baseUrl = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      const url = `${baseUrl}/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse`;

      const headers = {
        'x-goog-api-key': cfg.apiKey,
        'content-type': 'application/json'
      };

      const toolUseIdToName = new Map();
      for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolUseIdToName.set(block.id, block.name);
            }
          }
        }
      }

      const geminiMessages = [];
      for (const msg of messages) {
        if (msg.role === 'user') {
          if (!Array.isArray(msg.content)) continue;
          const parts = [];
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ text: block.text });
            } else if (block.type === 'image') {
              parts.push({ inlineData: { mimeType: block.mime || 'image/png', data: block.data } });
            } else if (block.type === 'tool_result') {
              const name = toolUseIdToName.get(block.tool_use_id) || 'unknown';
              /*
               * `FunctionResponse.response` 协议上是 Struct,也就是**必须是 JSON 对象**。
               * 本来就是对象就原样发,别再 JSON.stringify 拍成一整条字符串 ——
               * 拍平既多烧 token,又把嵌套层次抹掉,模型得自己从字符串里再读一遍。
               * null 和数组不是 Struct,仍然要包一层。
               */
              const c = block.content;
              const isStruct = c !== null && typeof c === 'object' && !Array.isArray(c);
              const fnResp = { name, response: isStruct ? c : { result: c } };
              // 官方 id 才回传;自造的 gemini-call-N 是我们编的,发过去它不认识
              if (block.tool_use_id && !String(block.tool_use_id).startsWith('gemini-call-')) {
                fnResp.id = block.tool_use_id;
              }
              parts.push({ functionResponse: fnResp });
            }
          }
          geminiMessages.push({ role: 'user', parts });
        } else if (msg.role === 'assistant') {
          if (!Array.isArray(msg.content)) continue;
          const parts = [];
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use') {
              parts.push({
                functionCall: {
                  name: block.name,
                  args: block.input || {}
                }
              });
            }
          }
          geminiMessages.push({ role: 'model', parts });
        }
      }

      const body = {
        contents: geminiMessages,
        generationConfig: {
          maxOutputTokens: cfg.maxTokens || 4096
        }
      };

      /*
       * 思考档位。以前这里**一个字都没发** —— cfg.effort 从 runners/api.mjs 一路传进来
       * (openai.mjs 把它发成 reasoning_effort),到了这儿被整个丢掉,
       * 于是面板上给 Gemini 选的思考档是死的,选什么都一样。
       *
       * `thinkingLevel` 取 low / medium / high,和面板那三档同名,直接透传,不要自己换算 token 数。
       * `includeThoughts` 不开就收不到思考摘要 —— 界面上那条「模型在想什么」会一直空着。
       */
      if (cfg.effort) {
        body.generationConfig.thinkingConfig = { thinkingLevel: cfg.effort, includeThoughts: true };
      }

      if (system) {
        body.systemInstruction = {
          parts: [{ text: system }]
        };
      }

      const geminiTools = (tools || []).map(t => toolToVendor(t, 'gemini', { compat: cfg.schemaCompat }));
      if (geminiTools.length > 0) {
        body.tools = [{ functionDeclarations: geminiTools }];
      }

      const post = (b) => fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(b), signal });

      let response = await post(body);

      /*
       * 老模型不认 thinkingConfig,传了直接 400 —— 那等于用户在面板上选个思考档
       * 就把整轮对话打死,而且报错里只说某个字段不认识,没人会联想到那个下拉框。
       * 所以碰到 400 就去掉它重发一次:少一个思考档,总好过整条对话红在那儿。
       * (和 openai.mjs 里那段「思考档 + 工具被拒就去掉重发」是同一个思路。)
       */
      if (response.status === 400 && body.generationConfig.thinkingConfig) {
        const retry = { ...body, generationConfig: { ...body.generationConfig } };
        delete retry.generationConfig.thinkingConfig;
        response = await post(retry);
      }

      await assertOk(response, 'gemini');

      let promptTokens = 0;
      let candidatesTokens = 0;
      let stopReason = null;

      for await (const { data } of readSse(response, { signal })) {
        if (!data || data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const candidate = parsed.candidates?.[0];
        if (candidate) {
          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              /*
               * 思考内容是一个**带 thought:true 标记的普通 text part**,不是另一种 part。
               * 所以这一支必须判在 part.text 前面,否则会被下面的 text 分支整个劫走 ——
               * 表现是模型的思考被当成正文播出去,而「在想什么」那一栏始终是空的。
               */
              if (part.thought === true) {
                yield { type: 'thinking_delta', text: part.text || '' };
              } else if (part.text) {
                yield { type: 'text_delta', text: part.text };
              } else if (part.functionCall) {
                toolUseCounter++;
                /*
                 * 有官方 id 就用官方的。自造的 `gemini-call-N` 是按到达顺序编的,
                 * 一轮里并行调同一个工具时,回传的 functionResponse 只按 name 配对,
                 * 谁对谁全靠运气 —— 结果是工具结果串号,而且不报错。
                 */
                const id = part.functionCall.id || `gemini-call-${toolUseCounter}`;
                yield { type: 'tool_use', id, name: part.functionCall.name, input: part.functionCall.args || {} };
              }
            }
          }
          if (candidate.finishReason) {
             stopReason = candidate.finishReason;
          }
        }

        if (parsed.usageMetadata) {
          if (parsed.usageMetadata.promptTokenCount !== undefined) {
             promptTokens = parsed.usageMetadata.promptTokenCount;
          }
          if (parsed.usageMetadata.candidatesTokenCount !== undefined) {
             candidatesTokens = parsed.usageMetadata.candidatesTokenCount;
          }
        }
      }

      yield { type: 'usage', input: promptTokens, output: candidatesTokens };
      /*
       * 出错的收尾不能伪装成正常结束。以前一律 yield 'stop',上层就以为这轮好好讲完了 ——
       * 而 MALFORMED_FUNCTION_CALL(模型把工具调用写坏了)、SAFETY / RECITATION(被拦下)
       * 这几种其实是**这一轮什么都没做成**。伪装的后果是界面上没有任何提示,
       * 要么原地不动,要么上层照着「正常结束」再起一轮,转着圈跑。
       *
       * 用 throw 而不是 yield 一个 error 事件:`harness/agent.mjs` 那个事件循环只认
       * text_delta / thinking_delta / tool_use / stop / usage 五种,**没有 error 这一支** ——
       * yield 过去会被静默丢掉,等于什么都没做。它外面有 try/catch 会把异常往上抛,
       * 而 anthropic.mjs 遇到流内错误走的也是 throw,这里和它保持一致。
       */
      if (stopReason && stopReason !== 'STOP' && stopReason !== 'MAX_TOKENS') {
        throw new Error(`Gemini 这一轮没有正常收尾(finishReason: ${stopReason})。`
          + (stopReason === 'MALFORMED_FUNCTION_CALL' ? '模型把工具调用写坏了,通常重试一次就好。' : ''));
      }
      yield { type: 'stop', reason: stopReason || 'STOP' };
    }
  };
}
