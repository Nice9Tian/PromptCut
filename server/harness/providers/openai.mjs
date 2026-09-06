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
          
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              hasToolResult = true;
            } else if (block.type === 'text') {
              textBuffer += block.text;
            }
          }
          
          if (!hasToolResult) {
             openaiMessages.push({ role: 'user', content: textBuffer });
          } else {
             for (const block of msg.content) {
               if (block.type === 'tool_result') {
                 openaiMessages.push({
                   role: 'tool',
                   tool_call_id: block.tool_use_id,
                   content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                 });
               } else if (block.type === 'text') {
                 openaiMessages.push({ role: 'user', content: block.text });
               }
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

      const openaiTools = (tools || []).map(t => toolToVendor(t, 'openai'));
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

        const choice = parsed.choices?.[0];
        if (choice) {
          if (choice.delta?.content) {
            yield { type: 'text_delta', text: choice.delta.content };
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
               } catch {}
               yield { type: 'tool_use', id: pt.id, name: pt.name, input };
            }
            partialToolCalls = {}; // clear
          }
        }
      }

      yield { type: 'usage', input: promptTokens, output: completionTokens };
      yield { type: 'stop', reason: stopReason || 'stop' };
    }
  };
}
