// 对应 claude-quickstarts/agents/utils/history.py

/**
 * 衡量历史有多长。
 *
 * 图片的 base64 不算进去：一张 768px 的截图就是几十万字符，按字面长度算的话，
 * 只要看过一次画面就必然超过 maxChars，截断会把整段对话削光。而模型那边图片是
 * 按尺寸计费的，字节数根本不是它的成本。所以这里只用一个和它 token 量级相当的
 * 常数占位（约 1200 token × 3 字符）。
 */
function sizeOf(messages) {
  return JSON.stringify(messages, (key, v) => (key === 'data' && typeof v === 'string' && v.length > 4096 ? 'x'.repeat(3600) : v)).length;
}

export class MessageHistory {
  constructor({ maxChars = 120000, onEvent } = {}) {
    this.maxChars = maxChars;
    this.onEvent = onEvent || (() => {});
    this.messages = [];
  }

  append(msg) {
    this.messages.push(msg);
  }

  appendAll(msgs) {
    this.messages.push(...msgs);
  }

  get() {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
  }

  estimateTokens() {
    return Math.ceil(sizeOf(this.messages) / 3);
  }

  /**
   * 只保留最近 keep 张截图，更早的换成一句说明。
   *
   * 图片按尺寸计费，不按字节，但每张仍是几百个 token，而且 base64 本身要走一遍
   * 网络。一次任务里可能看十几次画面，全留着既贵又没用——模型要判断的是「刚改完
   * 现在长什么样」，三轮前的旧样子留在上下文里反而会让它把旧画面当成现状。
   */
  pruneImages(keep = 2) {
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (let j = msg.content.length - 1; j >= 0; j--) {
        if (msg.content[j].type !== 'image') continue;
        if (++seen > keep) msg.content[j] = { type: 'text', text: '(更早的一张截图已从上下文移除；需要重看请再截一次)' };
      }
    }
  }

  truncate() {
    let currentChars = sizeOf(this.messages);
    if (currentChars <= this.maxChars) return;
    let truncated = false;

    while (this.messages.length > 2 && sizeOf(this.messages) > this.maxChars) {
      // 检查如果要删除第一条及关联的记录后，是否至少还剩 2 条消息
      let nextMessages = JSON.parse(JSON.stringify(this.messages));
      // Keep the latest actual user request while removing complete old tool pairs.
      const pinned = this.messages.findLastIndex(m => m.role === 'user' && m.content?.some(b => b.type === 'text') && !m.content?.some(b => b.type === 'tool_result'));
      const removeIndex = pinned === 0 ? 1 : 0;
      const [msg] = nextMessages.splice(removeIndex, 1);
      
      if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
        const toolUseIds = new Set();
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.add(block.id);
          }
        }
        
        if (toolUseIds.size > 0 && nextMessages.length > 0) {
           for (let i = 0; i < nextMessages.length; i++) {
             const m = nextMessages[i];
             if (m.role === 'user' && Array.isArray(m.content)) {
                m.content = m.content.filter(block => 
                  !(block.type === 'tool_result' && toolUseIds.has(block.tool_use_id))
                );
             }
           }
           nextMessages = nextMessages.filter(m => m.content && m.content.length > 0);
        }
      }
      
      if (nextMessages.length < 2) {
         break;
      }
      
      this.messages = nextMessages;
      truncated = true;
    }
    
    if (truncated) {
      this.onEvent({ type: 'status', text: '对话历史过长,已截断早期消息' });
    }
  }

  toJSON() {
    return this.messages;
  }

  static fromJSON(arr, opts) {
    const history = new MessageHistory(opts);
    if (Array.isArray(arr)) {
      history.messages = [...arr];
    }
    return history;
  }
}
