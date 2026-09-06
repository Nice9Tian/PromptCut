// 对应 claude-quickstarts/agents/providers/base.py

/**
 * Provider 契约:
 * createProvider(cfg, { fetchImpl = globalThis.fetch } = {})
 * 返回 { name: string, stream: async function*(messages, tools, system, signal) }
 * 
 * stream 产出以下事件之一:
 * - { type: 'text_delta', text: string }
 * - { type: 'tool_use', id: string, name: string, input: object }
 * - { type: 'usage', input: number, output: number }
 * - { type: 'stop', reason: string }
 */

/**
 * 创建 SSE 解析器。返回一个函数 feed(chunkString)，返回本次解析出的事件数组，元素形如 {event, data}。
 */
export function createSseParser() {
  let buffer = '';
  let currentEvent = null;
  let currentData = [];

  return function feed(chunkString) {
    const events = [];
    buffer += chunkString;
    
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      
      buffer = buffer.slice(lineEnd + 1);
      
      if (line === '') {
        if (currentEvent !== null || currentData.length > 0) {
           events.push({
             event: currentEvent || 'message',
             data: currentData.join('\n')
           });
           currentEvent = null;
           currentData = [];
        }
      } else if (line.startsWith(':')) {
        // 注释行，忽略
      } else {
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
          const field = line.slice(0, colonIndex);
          let value = line.slice(colonIndex + 1);
          if (value.startsWith(' ')) {
            value = value.slice(1);
          }
          
          if (field === 'event') {
            currentEvent = value;
          } else if (field === 'data') {
            currentData.push(value);
          }
        }
      }
      
      lineEnd = buffer.indexOf('\n');
    }
    
    return events;
  };
}

/**
 * 增量解码 response.body，逐个 yield {event, data}
 */
export async function* readSse(response, { signal } = {}) {
  const parser = createSseParser();
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      if (signal?.aborted) break;
      const str = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const evs = parser(str);
      for (const ev of evs) {
        yield ev;
      }
    }
    const finalEvs = parser(decoder.decode());
    for (const ev of finalEvs) {
       yield ev;
    }
  } else if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        const evs = parser(decoder.decode(value, { stream: true }));
        for (const ev of evs) {
          yield ev;
        }
      }
      const finalEvs = parser(decoder.decode());
      for (const ev of finalEvs) {
         yield ev;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * 断言 HTTP 响应为 2xx，否则抛出截断后的异常
 */
export async function assertOk(response, vendor) {
  if (response.ok) return;
  
  let text = '';
  try {
    text = await response.text();
  } catch {
    // ignore
  }
  
  let msg = '无 message 字段';
  if (text) {
    try {
      const body = JSON.parse(text);
      if (body?.error?.message) {
        msg = body.error.message;
      } else if (body?.message) {
        msg = body.message;
      } else if (Array.isArray(body) && body[0]?.error?.message) {
        msg = body[0].error.message;
      }
    } catch {
      // not json
    }
  }
  
  if (msg.length > 300) {
    msg = msg.substring(0, 300);
  }
  
  throw new Error(`${vendor} HTTP ${response.status}: ${msg}`);
}
