// 测试用的 provider

export function createProvider(cfg) {
  let turn = 0;
  
  return {
    name: 'mock',
    async *stream(_messages, _tools, _system, _signal) {
      turn++;
      if (turn === 1) {
        yield { type: 'tool_use', id: 'call_1', name: cfg?.toolName || 'get_editor_state', input: {} };
        yield { type: 'stop', reason: 'tool_use' };
      } else if (turn === 2) {
        const text = cfg?.finalText || '时间轴上有 2 张卡。';
        const mid = Math.floor(text.length / 2);
        yield { type: 'text_delta', text: text.slice(0, mid) };
        yield { type: 'text_delta', text: text.slice(mid) };
        yield { type: 'usage', input: 10, output: 20 };
        yield { type: 'stop', reason: 'end_turn' };
      } else {
        yield { type: 'text_delta', text: '没别的事了。' };
        yield { type: 'stop', reason: 'end_turn' };
      }
    }
  };
}
