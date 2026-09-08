// 对应 claude-quickstarts/agents/providers/openai.py
// 本家 API 要点: Chat Completions 接口，tool 变成 role=tool 的独立消息，工具定义为 function，增量流在 choices[0].delta 拼装。
import { readSse, assertOk } from './base.mjs';
import { toolToVendor } from '../schema.mjs';

export function createProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'openai',
    async *stream(messages, tools, system, signal) {
      let baseUrl = cfg.baseUrl || 'https://api.openai.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      
      let url = '';
      if (baseUrl.endsWith('/v1')) {
        url = `${baseUrl}/chat/completions`;
      } else {
        url = `${baseUrl}/v1/chat/completions`;
      }

      const headers = {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json'
      };

      const openaiMessages = [];
      if (system) {
        openaiMessages.push({ role: 'system', content: system });
      }

      for (const msg of messages) {
        if (msg.role === 'user') {
          if (!Array.isArray(msg.content)) continue;
          
          let hasToolResult = false;
          let textBuffer = '';
          // 图片只能挂在 role:"user" 上——role:"tool" 的 content 只收字符串
          const parts = [];

          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              hasToolResult = true;
            } else if (block.type === 'text') {
              textBuffer += block.text;
              parts.push({ type: 'text', text: block.text });
            } else if (block.type === 'image') {
              parts.push({ type: 'image_url', image_url: { url: `data:${block.mime || 'image/png'};base64,${block.data}` } });
            }
          }

          if (!hasToolResult) {
             // 没有图片时仍旧发纯字符串:多模态数组的形式不是每个兼容端点都吃
             const hasImage = parts.some(p => p.type === 'image_url');
             openaiMessages.push({ role: 'user', content: hasImage ? parts : textBuffer });
          } else {
             // 同一条消息里既有工具结果又有图片时：工具结果各自变成 role:"tool"，
             // 图片只能另起一条 role:"user" 跟在后面——role:"tool" 装不下图片块。
             // 顺序仍是 assistant(tool_calls) → tool(...) → user(图)，合法。
             for (const block of msg.content) {
               if (block.type === 'tool_result') {
                 openaiMessages.push({
                   role: 'tool',
                   tool_call_id: block.tool_use_id,
                   content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                 });
               }
             }
             // 工具结果全部发完之后，图片和随行文字合成一条 user 消息。
             // 图片必须和它的说明文字在一起，所以文字也一并挪到这里，而不是各发一条。
             if (parts.length) {
               const hasImage = parts.some(p => p.type === 'image_url');
               openaiMessages.push({ role: 'user', content: hasImage ? parts : textBuffer });
             }
          }
        } else if (msg.role === 'assistant') {
          if (!Array.isArray(msg.content)) continue;
          
          let textBuffer = '';
          const toolCalls = [];
          
          for (const block of msg.content) {
            if (block.type === 'text') {
              textBuffer += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input)
                }
              });
            }
          }
          
          const outMsg = { role: 'assistant', content: textBuffer || null };
          if (toolCalls.length > 0) {
            outMsg.tool_calls = toolCalls;
          }
          openaiMessages.push(outMsg);
        }
      }

      const body = {
        model: cfg.model,
        messages: openaiMessages,
        stream: true,
        max_tokens: cfg.maxTokens || 4096,
        stream_options: { include_usage: true }
      };

      const openaiTools = (tools || []).map(t => toolToVendor(t, 'openai', { compat: cfg.schemaCompat }));
      if (openaiTools.length > 0) {
        body.tools = openaiTools;
      }

      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });

      await assertOk(response, 'openai');

      let partialToolCalls = {}; // index -> {id, name, args}
      let stopReason = null;
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const { data } of readSse(response, { signal })) {
        if (data === '[DONE]') {
          break; // break instead of continue for openai DONE
        }
        
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens || 0;
          completionTokens = parsed.usage.completion_tokens || 0;
        }

        if (parsed.error) throw new Error(parsed.error.message || 'API 流返回错误');
        const choice = parsed.choices?.[0];
        if (choice) {
          if (choice.delta?.content) {
            yield { type: 'text_delta', text: choice.delta.content };
          }

          // 各家兼容接口给推理过程起的名字不一样,常见这三个,取到哪个算哪个
          const reasoning =
            choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.delta?.thinking;
          if (typeof reasoning === 'string' && reasoning) {
            yield { type: 'thinking_delta', text: reasoning };
          }

          if (Array.isArray(choice.delta?.tool_calls)) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index;
              if (!partialToolCalls[idx]) {
                partialToolCalls[idx] = { id: '', name: '', args: '' };
              }
              if (tc.id) partialToolCalls[idx].id = tc.id;
              if (tc.function?.name) partialToolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) partialToolCalls[idx].args += tc.function.arguments;
            }
          }

          if (choice.finish_reason) {
            stopReason = choice.finish_reason;
            
            // output tools
            const indices = Object.keys(partialToolCalls).map(Number).sort((a, b) => a - b);
            for (const idx of indices) {
               const pt = partialToolCalls[idx];
               let input = {};
               try {
                 input = JSON.parse(pt.args || '{}');
               } catch (error) {
                 yield { type: 'tool_use', id: pt.id, name: pt.name, input: {}, inputError: `工具参数 JSON 不完整：${error.message}。请缩小批量或提高输出长度后重试。` };
                 continue;
               }
               yield { type: 'tool_use', id: pt.id, name: pt.name, input };
            }
            partialToolCalls = {}; // clear
          }
        }
      }

      if (!stopReason) throw new Error('API 响应流提前结束或未返回 SSE 数据，请检查接口协议。');
      if (stopReason === 'length' && Object.keys(partialToolCalls).length) throw new Error('模型输出达到长度上限，工具参数未完成。');
      yield { type: 'usage', input: promptTokens, output: completionTokens };
      yield { type: 'stop', reason: stopReason || 'stop' };
    }
  };
}
