import { MessageHistory } from './history.mjs';

const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const checkAbort = signal => { if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' }); };

export class Agent {
  constructor({ provider, system, tools, maxIterations = 24, onEvent, signal, history }) {
    Object.assign(this, { provider, system, tools, maxIterations, signal });
    this.onEvent = onEvent || (() => {});
    this.history = history || new MessageHistory({ onEvent: this.onEvent });
  }

  async run(userText) {
    this.history.append({ role: 'user', content: [{ type: 'text', text: userText }] });
    const usage = { input: 0, output: 0 };
    const recent = [];
    let completed = 0, failed = 0, outcome = 'completed', lastText = '', lastRound = 0;
    const started = Date.now();
    const progress = (round, phase, text) => this.onEvent({ type: 'progress', round, maxRounds: this.maxIterations, phase, completed, failed, elapsedMs: Date.now() - started, text });
    const system = this.system + '\n\n执行规则：每组操作前用一句简短的话说明将做什么；需要做多件事时，在同一次回复里一次返回多个工具调用，它们会在同一轮内依次执行。依赖上一步返回值的操作留到下一轮。后台作业由工具自动等待，请勿反复启动或紧密轮询。遇到重复错误应改变方法或说明阻碍。工具返回成功后核对一次即可，完成后向用户总结结果。';
    let summaryReason = '';

    // The budget counts model/tool round trips, not individual calls.
    for (let round = 1; round <= this.maxIterations + 1; round++) {
      checkAbort(this.signal);
      lastRound = round;
      const summarizing = !!summaryReason;
      if (summarizing) this.history.append({ role: 'user', content: [{ type: 'text', text: `执行已暂停：${summaryReason}。不要再调用工具，只用中文说明已完成的部分、未完成的部分、阻碍和下一步。不得把未完成任务说成成功。` }] });
      progress(round, summarizing ? 'summarizing' : 'requesting', summarizing ? '正在整理执行结果和未完成事项…' : `第 ${round}/${this.maxIterations} 轮：正在等待模型响应…`);
      this.onEvent({ type: 'diagnostic', stage: 'request', data: { round, summaryOnly: summarizing, messages: this.history.get().length, tools: summarizing ? 0 : this.tools.length } });
      const content = [], calls = [];
      let text = '', current = '';
      const flush = () => { if (current) { content.push({ type: 'text', text: current }); current = ''; } };
      const heartbeat = setInterval(() => progress(round, summarizing ? 'summarizing' : 'requesting', `仍在等待模型响应，已用时 ${Math.floor((Date.now() - started) / 1000)} 秒；可以随时停止。`), 10000);
      try {
        for await (const ev of this.provider.stream(this.history.get(), summarizing ? [] : this.tools, system, this.signal)) {
          checkAbort(this.signal);
          if (ev.type === 'text_delta') {
            current += ev.text; text += ev.text;
            this.onEvent({ type: 'text', delta: ev.text });
          } else if (ev.type === 'thinking_delta') {
            // 只往界面转发,不并进 assistant 正文——思考不该混进回复,也不回灌给模型
            this.onEvent({ type: 'thinking', delta: ev.text, round });
          } else if (ev.type === 'tool_use') {
            if (summarizing) continue; // Never execute tools once the safety stop fired.
            flush();
            const call = { ...ev, id: ev.id || `round-${round}-call-${calls.length + 1}` };
            if (calls.some(c => c.id === call.id)) throw new Error('API 返回了重复的工具调用 ID，已停止以免重复执行。');
            calls.push(call);
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
          } else if (ev.type === 'stop') {
            this.onEvent({ type: 'diagnostic', stage: 'response', data: { round, stopReason: ev.reason, toolCalls: calls.length } });
          } else if (ev.type === 'usage') {
            usage.input += Number(ev.input) || 0; usage.output += Number(ev.output) || 0;
          }
        }
      } catch (err) {
        if (!summarizing || this.signal?.aborted) throw err;
        this.onEvent({ type: 'status', text: `结果摘要请求失败：${err.message}` });
      } finally { clearInterval(heartbeat); }
      flush();
      if (content.length) this.history.append({ role: 'assistant', content });
      lastText = text;
      if (summarizing) {
        const note = `\n\n本次执行已暂停：${summaryReason}。已成功执行 ${completed} 次操作，失败 ${failed} 次。已完成的修改会保留；可以补充要求后继续，或复制本次对话进行排查。`;
        this.onEvent({ type: 'text', delta: note });
        this.history.append({ role: 'assistant', content: [{ type: 'text', text: note }] });
        lastText += note;
        break;
      }
      if (!calls.length) {
        if (!text.trim()) throw new Error('API 没有返回文字或工具调用，请检查模型和接口协议设置。');
        break;
      }
      progress(round, 'executing', `本轮收到 ${calls.length} 个工具调用，正在执行…`);
      const results = [];
      // Preserve declared order for edits: two mutations must not race in the store.
      // Multiple calls still share one model round trip.
      for (const call of calls) {
        checkAbort(this.signal);
        const tool = this.tools.find(t => t.name === call.name);
        const begin = Date.now();
        this.onEvent({ type: 'tool_call', callId: call.id, round, name: call.name, input: call.input });
        const toolHeartbeat = setInterval(() => progress(round, 'executing', `正在执行 ${call.name}，已等待 ${Math.floor((Date.now() - begin) / 1000)} 秒…`), 5000);
        let result, ok = true;
        try {
          if (!tool) throw new Error(`未知工具 ${call.name}，请使用已提供的工具名称。`);
          if (call.inputError) throw new Error(call.inputError);
          if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('工具参数必须是 JSON 对象。');
          for (const key of tool.inputSchema?.required || []) if (call.input[key] === undefined) throw new Error(`缺少必填参数 ${key}。`);
          result = await tool.execute(call.input, { signal: this.signal, callId: call.id, round });
          if (result?.ok === false || result?.isError === true) ok = false;
          checkAbort(this.signal);
        } catch (err) {
          checkAbort(this.signal);
          ok = false; result = { error: err.message || String(err) };
        } finally { clearInterval(toolHeartbeat); }
        const output = typeof result === 'string' ? result : JSON.stringify(result ?? null);
        ok ? completed++ : failed++;
        this.onEvent({ type: 'tool_result', callId: call.id, round, name: call.name, ok, summary: output.slice(0, 1000), output: result, durationMs: Date.now() - begin });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: output, is_error: !ok });
      }
      this.history.append({ role: 'user', content: results });
      const fingerprint = canonical(calls.map((c, index) => ({ name: c.name, input: c.input, result: results[index].content })));
      recent.push(fingerprint);
      if (recent.length > 6) recent.shift();
      const repeats = recent.filter(f => f === fingerprint).length;
      if (repeats >= 3) {
        outcome = 'stalled'; summaryReason = '连续出现重复操作且结果没有变化，已停止无效循环';
      } else if (round === this.maxIterations) {
        outcome = 'round_limit'; summaryReason = `已达到 ${this.maxIterations} 轮模型往返上限`;
      }
      this.history.truncate();
    }
    progress(lastRound, outcome === 'completed' ? 'completed' : 'paused', outcome === 'completed' ? `本次完成：${completed} 次成功，${failed} 次失败。` : summaryReason);
    return { text: lastText, history: this.history, usage, outcome, completed, failed };
  }
}
