// 对应 claude-quickstarts/agents/agent.py
import { MessageHistory } from './history.mjs';

export class Agent {
  constructor({ provider, system, tools, maxIterations = 24, onEvent, signal, history }) {
    this.provider = provider;
    this.system = system;
    this.tools = tools;
    this.maxIterations = maxIterations;
    this.onEvent = onEvent || (() => {});
    this.signal = signal;
    this.history = history || new MessageHistory({ onEvent: this.onEvent });
  }

  async run(userText) {
    this.history.append({
      role: 'user',
      content: [{ type: 'text', text: userText }]
    });

    let textOut = '';
    let usageOut = {};

    for (let i = 0; i < this.maxIterations; i++) {
      if (this.signal?.aborted) {
         const err = new Error('Aborted');
         err.name = 'AbortError';
         throw err;
      }

      let turnText = '';
      let toolUses = [];
      let assistantContent = [];
      
      const stream = this.provider.stream(this.history.get(), this.tools, this.system, this.signal);
      
      let currentText = '';
      for await (const ev of stream) {
        if (ev.type === 'text_delta') {
          currentText += ev.text;
          turnText += ev.text;
          this.onEvent({ type: 'text', delta: ev.text });
        } else if (ev.type === 'tool_use') {
          if (currentText) {
             assistantContent.push({ type: 'text', text: currentText });
             currentText = '';
          }
          toolUses.push(ev);
          assistantContent.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
          this.onEvent({ type: 'tool_call', name: ev.name, input: ev.input });
        } else if (ev.type === 'usage') {
          usageOut = ev;
        } else if (ev.type === 'stop') {
          // stop reason
        }
      }

      if (currentText) {
        assistantContent.push({ type: 'text', text: currentText });
      }

      if (assistantContent.length > 0) {
        this.history.append({ role: 'assistant', content: assistantContent });
      }

      textOut = turnText;

      if (toolUses.length === 0) {
        this.history.truncate();
        break;
      }

      const toolResults = await Promise.all(toolUses.map(async tu => {
        const tool = this.tools.find(t => t.name === tu.name);
        if (!tool) {
          const errStr = `未知工具 ${tu.name}`;
          this.onEvent({ type: 'tool_result', name: tu.name, ok: false, summary: errStr });
          return { type: 'tool_result', tool_use_id: tu.id, content: errStr, is_error: true };
        }
        try {
          const res = await tool.execute(tu.input);
          const content = typeof res === 'string' ? res : JSON.stringify(res);
          let summary = content;
          if (summary.length > 300) summary = summary.substring(0, 300);
          this.onEvent({ type: 'tool_result', name: tu.name, ok: true, summary });
          return { type: 'tool_result', tool_use_id: tu.id, content, is_error: false };
        } catch (err) {
          let summary = err.message || String(err);
          if (summary.length > 300) summary = summary.substring(0, 300);
          this.onEvent({ type: 'tool_result', name: tu.name, ok: false, summary });
          return { type: 'tool_result', tool_use_id: tu.id, content: err.message, is_error: true };
        }
      }));

      this.history.append({ role: 'user', content: toolResults });
      this.history.truncate();
      
      if (i === this.maxIterations - 1) {
         this.onEvent({ type: 'status', text: '已达工具调用上限' });
      }
    }

    return { text: textOut, history: this.history, usage: usageOut };
  }
}
