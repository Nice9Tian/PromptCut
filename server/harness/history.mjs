// 对应 claude-quickstarts/agents/utils/history.py

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
    const jsonStr = JSON.stringify(this.messages);
    return Math.ceil(jsonStr.length / 3);
  }

  truncate() {
    let currentChars = JSON.stringify(this.messages).length;
    if (currentChars <= this.maxChars) return;
    let truncated = false;

    while (this.messages.length > 2 && JSON.stringify(this.messages).length > this.maxChars) {
      // 检查如果要删除第一条及关联的记录后，是否至少还剩 2 条消息
      let nextMessages = JSON.parse(JSON.stringify(this.messages));
      const msg = nextMessages.shift();
      
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
