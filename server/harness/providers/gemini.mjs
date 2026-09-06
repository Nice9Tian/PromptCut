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
            } else if (block.type === 'tool_result') {
              const name = toolUseIdToName.get(block.tool_use_id) || 'unknown';
              parts.push({
                functionResponse: {
                  name,
                  response: { result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
                }
              });
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

      if (system) {
        body.systemInstruction = {
          parts: [{ text: system }]
        };
      }

      const geminiTools = (tools || []).map(t => toolToVendor(t, 'gemini'));
      if (geminiTools.length > 0) {
        body.tools = [{ functionDeclarations: geminiTools }];
      }

      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });

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
              if (part.text) {
                yield { type: 'text_delta', text: part.text };
              } else if (part.functionCall) {
                toolUseCounter++;
                const id = `gemini-call-${toolUseCounter}`;
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
      yield { type: 'stop', reason: stopReason || 'STOP' };
    }
  };
}
