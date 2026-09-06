import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseToolBlocks(text) {
  const regex = /```promptcut-tool\s*([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const content = match[1].trim();
    try {
      const parsed = JSON.parse(content);
      blocks.push({
        name: parsed.name,
        input: parsed.input || {},
        raw
      });
    } catch (e) {
      blocks.push({
        error: `JSON 解析失败: ${e.message}`,
        raw
      });
    }
  }
  return blocks;
}

export function hasToolBlocks(text) {
  return /```promptcut-tool\s*([\s\S]*?)```/.test(text);
}

export async function executeToolBlocks(blocks, callTool) {
  const results = [];
  const { tools } = await import(new URL('../mcp-tools.mjs', import.meta.url).href);
  const toolNames = tools.map(t => t.name);

  for (const block of blocks) {
    if (block.error) {
      results.push({ name: block.name || 'unknown', ok: false, error: block.error });
      continue;
    }
    
    if (!toolNames.includes(block.name)) {
      results.push({ name: block.name, ok: false, error: `未注册的工具 ${block.name}` });
      continue;
    }
    
    try {
      const result = await callTool(block.name, block.input);
      let text = '';
      let files = undefined;
      
      if (typeof result === 'object' && result !== null) {
        if (Array.isArray(result.files)) {
          files = result.files.map(f => (typeof f === 'string' ? f : f.path)).filter(Boolean);
        }
        text = JSON.stringify(result, null, 2);
      } else {
        text = String(result);
      }
      
      results.push({ name: block.name, ok: true, text, files });
    } catch (e) {
      results.push({ name: block.name, ok: false, error: String(e) });
    }
  }
  return results;
}

export function formatResultsAsUserMessage(results) {
  let output = '工具执行结果：\n\n';
  for (const res of results) {
    if (res.ok) {
      const t = res.text ? res.text.substring(0, 4000) : '';
      output += `[工具 ${res.name} 执行成功]\n${t}\n\n`;
    } else {
      output += `[工具 ${res.name} 执行失败]\n${res.error}\n\n`;
    }
  }
  return output.trim();
}

export async function renderProtocolPrompt() {
  const mdPath = fileURLToPath(new URL('../ai-tool-protocol.md', import.meta.url));
  let md = fs.readFileSync(mdPath, 'utf-8');
  
  const { tools } = await import(new URL('../mcp-tools.mjs', import.meta.url).href);
  
  let toolsDesc = '';
  for (const t of tools) {
    toolsDesc += `### ${t.name}\n- 描述：${t.description}\n- 参数：${JSON.stringify(t.inputSchema)}\n\n`;
  }
  
  return md.replace('<!--TOOLS-->', toolsDesc.trim());
}

export function runTextProtocolLoop({ startRun, opts, onEvent }) {
  let currentOpts = { ...opts };
  
  currentOpts.mcp = undefined;
  let loopCount = 0;
  let finalAbort = () => {};
  
  const donePromise = new Promise(async (resolve, reject) => {
    try {
      const protocolPrompt = await renderProtocolPrompt();
      currentOpts.systemPrompt = currentOpts.systemPrompt + '\n\n' + protocolPrompt;
      
      while (loopCount < 8) {
        loopCount++;
        let collectedText = '';
        let lastSessionId = currentOpts.sessionId;
        let lastUsage = undefined;
        let runError = null;
        
        const run = startRun({
          ...currentOpts,
          onEvent: (ev) => {
            if (ev.type === 'text') {
              collectedText += ev.delta;
            }
            if (ev.type === 'session' && ev.sessionId) {
              lastSessionId = ev.sessionId;
            }
            if (ev.type === 'done') {
              if (ev.sessionId) lastSessionId = ev.sessionId;
              if (ev.usage) lastUsage = ev.usage;
            } else if (ev.type === 'error') {
              runError = ev.message;
              onEvent(ev);
            } else {
              onEvent(ev);
            }
          }
        });
        
        finalAbort = run.abort;
        
        try {
          await run.done;
        } catch (e) {
          if (!runError) {
            runError = e.message || String(e);
            onEvent({ type: 'error', message: runError });
          }
        }
        
        if (runError) {
           resolve();
           return;
        }
        
        if (!hasToolBlocks(collectedText)) {
          onEvent({ type: 'done', sessionId: lastSessionId, usage: lastUsage });
          resolve();
          return;
        }
        
        const blocks = parseToolBlocks(collectedText);
        
        for (const b of blocks) {
           if (b.name) onEvent({ type: 'tool_call', name: b.name, input: b.input });
        }
        
        const results = await executeToolBlocks(blocks, opts.callTool);
        
        for (const res of results) {
           onEvent({ type: 'tool_result', name: res.name || 'unknown', ok: res.ok, summary: res.text || res.error, files: res.files });
        }
        
        const nextPrompt = formatResultsAsUserMessage(results);
        
        currentOpts.prompt = nextPrompt;
        currentOpts.sessionId = lastSessionId;
      }
      
      onEvent({ type: 'status', text: '文本协议已达 8 轮上限' });
      onEvent({ type: 'done', sessionId: currentOpts.sessionId });
      resolve();
    } catch (e) {
      onEvent({ type: 'error', message: String(e) });
      reject(e);
    }
  });
  
  return {
    abort: () => finalAbort(),
    done: donePromise
  };
}
