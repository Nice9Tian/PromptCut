import { spawnCli, resolveExe, lineSplitter } from './index.mjs';
import { execFileSync } from 'node:child_process';

let registerPromise = null;
let lastRegisteredPort = null;

async function ensureMcpRegistered(exePath, mcpOpts, safeOnEvent) {
  if (registerPromise && lastRegisteredPort === mcpOpts.env.PROMPTCUT_PORT) return registerPromise;
  
  registerPromise = (async () => {
    try {
      const listStdout = execFileSync(exePath, ['mcp', 'list'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = listStdout.trim().split(/\r?\n/);
      let found = false;
      for (const l of lines) {
         if (l.startsWith('promptcut') || l.split(/\s+/)[0] === 'promptcut') {
             if (l.includes(mcpOpts.command) && l.includes(mcpOpts.args[0])) {
                 found = true;
                 break;
             }
         }
      }
      if (found) {
         lastRegisteredPort = mcpOpts.env.PROMPTCUT_PORT;
         return;
      }
    } catch {}

    try {
      execFileSync(exePath, ['mcp', 'add', '-e', `PROMPTCUT_PORT=${mcpOpts.env.PROMPTCUT_PORT}`, 'promptcut', mcpOpts.command, mcpOpts.args[0]], { windowsHide: true, stdio: 'ignore' });
      lastRegisteredPort = mcpOpts.env.PROMPTCUT_PORT;
      safeOnEvent({ type: 'status', text: '已把 PromptCut 注册为 agy 的 MCP 服务（agy mcp add promptcut）' });
    } catch (e) {
      safeOnEvent({ type: 'error', message: `MCP registration failed: ${e.message}` });
    }
  })();
  return registerPromise;
}

export async function getAgyProvider() {
  const exePath = resolveExe('agy', 'C:\\Users\\admin\\AppData\\Local\\agy\\bin\\agy.exe');
  let available = false;
  let version = undefined;
  let note = undefined;
  try {
    const stdout = execFileSync(exePath, ['--version'], { timeout: 2000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    version = stdout.trim();
    available = true;
  } catch (e) {
    note = e.message;
  }
  return { id: 'agy', label: 'Antigravity', available, version, path: exePath, note };
}

export function startRun(opts) {
  const exePath = resolveExe('agy', 'C:\\Users\\admin\\AppData\\Local\\agy\\bin\\agy.exe');
  
  let resolveDone;
  const donePromise = new Promise(r => { resolveDone = r; });
  let childController = null;
  let isAborted = false;
  
  const fullPrompt = `<<<系统说明>>>\n${opts.systemPrompt}\n<<<用户消息>>>\n${opts.prompt}`;
  
  const args = [
    '-p', fullPrompt,
    '--output-format', 'stream-json',
    '--add-dir', opts.cwd,
    '--print-timeout', '20m'
  ];
  if (opts.sessionId) {
    args.push('--conversation', opts.sessionId);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }

  const safeOnEvent = (ev) => {
      if (childController) childController.safeOnEvent(ev);
      else {
          try { opts.onEvent(ev); } catch {}
      }
  };

  ensureMcpRegistered(exePath, opts.mcp, safeOnEvent).then(() => {
    if (isAborted) {
       resolveDone();
       return;
    }
    
    childController = spawnCli(exePath, args, { cwd: opts.cwd }, opts.onEvent, 'Antigravity');
    let emitted = '';
    
    childController.child.stdout.on('data', lineSplitter(line => {
      if (!line.trim()) return;
      if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[agy] ' + line);
      try {
        const ev = JSON.parse(line);
        if (ev.event === 'init' && ev.conversation_id) {
          childController.safeOnEvent({ type: 'session', sessionId: ev.conversation_id });
        } else if (ev.event === 'step_update' && ev.step_update) {
           const su = ev.step_update;
           if (su.step_type === 'tool') {
              let tName = su.tool_name;
              let tInput = su.tool_info?.parameters || {};
              if (tName === 'call_mcp_tool') {
                  tName = tInput.ToolName || 'call_mcp_tool';
                  tInput = tInput.Arguments || tInput;
              }
              
              if (su.state === 'ACTIVE') {
                 childController.safeOnEvent({ type: 'tool_call', name: tName, input: tInput });
              } else if (su.state === 'DONE') {
                 let outputStr = 'done';
                 if (su.tool_info?.output !== undefined) {
                     if (typeof su.tool_info.output === 'string') outputStr = su.tool_info.output;
                     else outputStr = JSON.stringify(su.tool_info.output);
                 }
                 childController.safeOnEvent({ type: 'tool_result', name: tName, ok: true, summary: outputStr.substring(0, 300) });
              } else if (su.state === 'ERROR') {
                 const msg = su.tool_info?.error?.message || '';
                 if (msg.includes('permission') || msg.includes('权限') || msg.includes('denied') || msg.includes('not allowed')) {
                    childController.safeOnEvent({ type: 'error', message: msg });
                    childController.safeOnEvent({ type: 'status', text: `agy 拒绝了 MCP 工具调用。请在 ~/.gemini/antigravity-cli/settings.json 的 permissions.allow 里加一条 mcp(promptcut/${tName}) 规则（每个工具一条），然后重试。` });
                 } else {
                    childController.safeOnEvent({ type: 'tool_result', name: tName, ok: false, summary: msg });
                 }
              }
           } else {
               const txt = su.text_delta ?? su.text ?? su.delta ?? su.content ?? su.message;
               if (typeof txt === 'string' && txt.length > 0) {
                  childController.safeOnEvent({ type: 'text', delta: txt });
                  emitted += txt;
               }
           }
        } else if (ev.event === 'result' && ev.result) {
           const res = ev.result;
           
           if (res.denied_actions && res.denied_actions.length > 0) {
               const deniedNames = res.denied_actions.map(a => a.display_name || a.action).join(', ');
               childController.safeOnEvent({ type: 'status', text: `部分动作被拒绝: ${deniedNames}` });
           }

           const finalResponse = res.response || '';
           if (typeof finalResponse === 'string' && finalResponse.trim().length > 0) {
              const cleanedEmitted = emitted.trim();
              const cleanedResponse = finalResponse.trim();
              if (!cleanedEmitted.endsWith(cleanedResponse) && !cleanedEmitted.includes(cleanedResponse)) {
                  childController.safeOnEvent({ type: 'text', delta: finalResponse });
              }
           }
           childController.finish({ type: 'done', sessionId: res.conversation_id, usage: res.usage });
        }
      } catch {}
    }));

    childController.donePromise.then(resolveDone);
  });
  
  const abort = () => {
    isAborted = true;
    if (childController) childController.abort();
    else resolveDone();
  };
  
  return { abort, done: donePromise };
}
