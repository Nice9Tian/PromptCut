import { MessageHistory } from './history.mjs';

const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const checkAbort = signal => { if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' }); };

export class Agent {
  /**
   * maxIterations 允许是 Infinity(深度自主 + 自主轮次填 0)。这时循环没有终点,
   * 停下来只靠三样:用户点停止(signal)、模型自己不再调工具、重复操作检测。
   *
   * deepAuto 为真时**不给模型任何关于轮次的话**:到顶收尾那条消息里不写轮数,
   * 免得模型看见「第几轮 / 上限多少」就开始替自己算预算、提前草草收工。
   *
   * maxInputTokens:单次请求的输入 token 预算。给了就按每轮 API 报回的真实 token 数截断
   * (见 history.fitTokens),不给就还是老的按字符数截。
   */
  constructor({ provider, system, tools, maxIterations = 24, deepAuto = false, maxInputTokens = 0, onEvent, signal, history }) {
    Object.assign(this, { provider, system, tools, maxIterations, deepAuto, maxInputTokens, signal });
    this.onEvent = onEvent || (() => {});
    this.history = history || new MessageHistory({ onEvent: this.onEvent });
  }

  async run(userText) {
    // 末尾已经是 user 消息时要并进去,不能新起一条 —— 理由见 history.appendUserText
    this.history.appendUserText(userText);
    const usage = { input: 0, output: 0, cacheRead: 0 };
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
      // 上一轮刚放完 tool_result(那是一条 user),这里直接 append 就又是两条连着的 user
      if (summarizing) this.history.appendUserText(`执行已暂停：${summaryReason}。不要再调用工具，只用中文说明已完成的部分、未完成的部分、阻碍和下一步。不得把未完成任务说成成功。`);
      // 进度这一行只给屏幕看,不进模型上下文。不限轮次时不写分母,省得出现「第 3/Infinity 轮」
      const roundText = Number.isFinite(this.maxIterations) ? `第 ${round}/${this.maxIterations} 轮` : `第 ${round} 轮`;
      progress(round, summarizing ? 'summarizing' : 'requesting', summarizing ? '正在整理执行结果和未完成事项…' : `${roundText}：正在等待模型响应…`);
      this.onEvent({ type: 'diagnostic', stage: 'request', data: { round, summaryOnly: summarizing, messages: this.history.get().length, tools: summarizing ? 0 : this.tools.length } });
      const content = [], calls = [];
      let text = '', current = '', lastInput = 0;
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
            usage.cacheRead += Number(ev.cacheRead) || 0;
            lastInput = Number(ev.input) || 0;
          }
        }
      } catch (err) {
        if (!summarizing || this.signal?.aborted) throw err;
        this.onEvent({ type: 'status', text: `结果摘要请求失败：${err.message}` });
      } finally { clearInterval(heartbeat); }
      flush();
      lastText = text;
      if (summarizing) {
        const note = `\n\n本次执行已暂停：${summaryReason}。已成功执行 ${completed} 次操作，失败 ${failed} 次。已完成的修改会保留；可以补充要求后继续，或复制本次对话进行排查。`;
        this.onEvent({ type: 'text', delta: note });
        /*
         * 收尾这句要**并进当轮那条 assistant**,不能另起一条。
         *
         * 上面本来就要 append 一条 assistant(模型的汇总文字),这里再 append 一条
         * 就是两条连着的 assistant —— 和 appendUserText 治的是同一个病的另一半。
         * 这个形状会被 saveHistory 原样写进 harness-sessions 里那个文件,而后续
         * 没有任何一步会把它合并回去:**这个会话从此每次都 400,而且不自愈**,
         * 用户根本不知道有这么个文件可以删。
         */
        content.push({ type: 'text', text: note });
        if (content.length) this.history.append({ role: 'assistant', content });
        lastText += note;
        break;
      }
      if (content.length) this.history.append({ role: 'assistant', content });
      if (!calls.length) {
        if (!text.trim()) throw new Error('API 没有返回文字或工具调用，请检查模型和接口协议设置。');
        break;
      }
      progress(round, 'executing', `本轮收到 ${calls.length} 个工具调用，正在执行…`);
      const results = [];
      // 工具返回的图片不留在 tool_result 里，改挂到同一条 user 消息的末尾。
      // 原因是可移植性：Anthropic 的 tool_result 装得下图片块，OpenAI 的 role:"tool"
      // 只收字符串，装不了。要让同一套 history 在三家 API 上都成立，图片就只能作为
      // 跟在工具结果后面的普通内容块出现（下面 append 处还有一段说明为什么不另起一条）。
      const images = [];
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
        // 图片从工具结果里摘出来。留在 JSON 里的话，base64 会被当成普通文本灌进历史：
        // 模型看不见画面，几十万字符还会立刻把上下文撑爆并触发截断。摘出来还有个好处是
        // 转发给界面的 tool_result 事件也就不带 base64 了，存档不会被撑大。
        if (ok && result && typeof result === 'object' && result.__image?.base64) {
          images.push({ ...result.__image, name: call.name });
          const { __image, ...rest } = result;
          result = { ...rest, image: '画面见本条消息末尾的图片' };
        }
        // see_frames 素材模式(source: "media")一页多张:每张标上镜头序号,模型看图时能和 scenes 对上
        if (ok && result && typeof result === 'object' && Array.isArray(result.__images)) {
          for (const im of result.__images) if (im?.base64) images.push({ ...im, name: `${call.name} 镜头 ${im.sceneIndex ?? '?'}` });
          const { __images, ...rest } = result;
          result = { ...rest, images: `${result.__images.length} 张镜头拼图见本条消息末尾,按镜头序号排列` };
        }
        const output = typeof result === 'string' ? result : JSON.stringify(result ?? null);
        ok ? completed++ : failed++;
        this.onEvent({ type: 'tool_result', callId: call.id, round, name: call.name, ok, summary: output.slice(0, 1000), output: result, durationMs: Date.now() - begin });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: output, is_error: !ok });
      }
      // 图片跟工具结果放在同一条 user 消息里、排在所有 tool_result 之后。
      // 不另起一条的原因：那会造成两条连着的 user 消息，而三家 API 对连续同角色
      // 消息的容忍度不一样。挂在同一条上是三家都明确支持的形状。
      this.history.append({ role: 'user', content: images.length ? [
        ...results,
        ...images.map(im => ({ type: 'image', mime: im.mime || 'image/png', data: im.base64 })),
        { type: 'text', text: `以上是 ${images.map(i => i.name).join('、')} 截到的画面。照着画面判断，不要凭源码想象效果。` },
      ] : results });
      const fingerprint = canonical(calls.map((c, index) => ({ name: c.name, input: c.input, result: results[index].content })));
      recent.push(fingerprint);
      if (recent.length > 6) recent.shift();
      const repeats = recent.filter(f => f === fingerprint).length;
      if (repeats >= 3) {
        outcome = 'stalled'; summaryReason = '连续出现重复操作且结果没有变化，已停止无效循环';
      } else if (round === this.maxIterations) {
        // 深度自主下不报轮数:这句会作为 user 消息进模型上下文(见循环开头的 summarizing 分支)
        outcome = 'round_limit';
        summaryReason = this.deepAuto ? '本次运行已到上限' : `已达到 ${this.maxIterations} 轮模型往返上限`;
      }
      this.history.pruneImages();
      if (this.maxInputTokens > 0 && lastInput > 0) this.history.fitTokens(lastInput, this.maxInputTokens);
      else this.history.truncate();
    }
    progress(lastRound, outcome === 'completed' ? 'completed' : 'paused', outcome === 'completed' ? `本次完成：${completed} 次成功，${failed} 次失败。` : summaryReason);
    return { text: lastText, history: this.history, usage, outcome, completed, failed };
  }
}
