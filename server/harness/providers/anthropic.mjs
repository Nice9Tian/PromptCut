// 对应 claude-quickstarts/agents/providers/anthropic.py
// 本家 API 要点: Messages API, role 为 user/assistant, content 是 block 数组 (text/tool_use/tool_result).
import { readSse, assertOk } from './base.mjs';
import { toolToVendor } from '../schema.mjs';

export function createProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'anthropic',
    async *stream(messages, tools, system, signal) {
      let baseUrl = cfg.baseUrl || 'https://api.anthropic.com';
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      const url = `${baseUrl}/v1/messages`;

      const headers = {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      };

      const anthropicMessages = messages.map(msg => {
        const newMsg = { role: msg.role, content: [] };
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' || block.type === 'tool_use') {
              newMsg.content.push(block);
            } else if (block.type === 'tool_result') {
              newMsg.content.push({
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                is_error: block.is_error
              });
            }
          }
        }
        return newMsg;
      });

      const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens || 4096,
        messages: anthropicMessages,
        stream: true
      };
      if (system) {
        body.system = system;
      }
      
      const anthropicTools = (tools || []).map(t => toolToVendor(t, 'anthropic'));
      if (anthropicTools.length > 0) {
        body.tools = anthropicTools;
      }

      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });

      await assertOk(response, 'anthropic');

      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = null;
      let partialTools = {};

      for await (const { event, data } of readSse(response, { signal })) {
        if (data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (event === 'message_start') {
          if (parsed.message?.usage?.input_tokens) {
            inputTokens = parsed.message.usage.input_tokens;
          }
        } else if (event === 'content_block_start') {
          if (parsed.content_block?.type === 'tool_use') {
            partialTools[parsed.index] = {
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              partialJson: ''
            };
          }
        } else if (event === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta') {
            yield { type: 'text_delta', text: parsed.delta.text };
          } else if (parsed.delta?.type === 'input_json_delta') {
            if (partialTools[parsed.index]) {
              partialTools[parsed.index].partialJson += parsed.delta.partial_json;
            }
          }
        } else if (event === 'content_block_stop') {
          if (partialTools[parsed.index]) {
            const tool = partialTools[parsed.index];
            let input = {};
            try {
              input = JSON.parse(tool.partialJson || '{}');
            } catch {}
            yield { type: 'tool_use', id: tool.id, name: tool.name, input };
          }
        } else if (event === 'message_delta') {
          if (parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
          if (parsed.usage?.output_tokens) {
            outputTokens = parsed.usage.output_tokens;
          }
        } else if (event === 'message_stop') {
          yield { type: 'usage', input: inputTokens, output: outputTokens };
          yield { type: 'stop', reason: stopReason || 'end_turn' };
        }
      }
    }
  };
}
