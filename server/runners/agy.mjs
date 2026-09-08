import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';
import { cliCommand, cliEnv } from './cli-runtime.mjs';

function runAgy(exe, args, options) {
  const invocation = cliCommand(exe, args);
  return execFileSync(invocation.command, invocation.args, { env: cliEnv('agy'), timeout: 15000, ...options });
}

let registerPromise = null;
let lastRegisteredPort = null;

async function ensureMcpRegistered(exePath, mcpOpts, safeOnEvent) {
  if (registerPromise && lastRegisteredPort === mcpOpts.env.PROMPTCUT_PORT) return registerPromise;
  
  registerPromise = (async () => {
    try {
      const listStdout = runAgy(exePath, ['mcp', 'list'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
      runAgy(exePath, ['mcp', 'add', '-e', `PROMPTCUT_PORT=${mcpOpts.env.PROMPTCUT_PORT}`, 'promptcut', mcpOpts.command, mcpOpts.args[0]], { windowsHide: true, stdio: 'ignore' });
      lastRegisteredPort = mcpOpts.env.PROMPTCUT_PORT;
      safeOnEvent({ type: 'status', text: '已把 PromptCut 注册为 agy 的 MCP 服务（agy mcp add promptcut）' });
    } catch (e) {
      safeOnEvent({ type: 'error', message: `MCP registration failed: ${e.message}` });
    }
  })();
  return registerPromise;
}

export async function getAgyProvider() {
  const exePath = resolveExe('agy');
  let available = false;
  let version = undefined;
  let note = undefined;
  try {
    const stdout = probeVersion(exePath);
    version = stdout.trim();
    available = true;
  } catch (e) {
    note = e.message;
  }
  return { id: 'agy', label: 'Antigravity', available, version, path: exePath, note };
}

import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
  }

  let abortRef = { abort: () => {} };
  let rejected = false;

  const interceptOnEvent = (ev) => {
    if ((ev.type === 'done' || ev.type === 'error') && rejected) {
        return;
    }
    opts.onEvent(ev);
  };

  const run = _startRun({
    ...opts,
    onEvent: interceptOnEvent,
    onPermissionDenied: () => {
      rejected = true;
    }
  });
  abortRef.abort = run.abort;

  const donePromise = run.done.then((res) => {
    if (rejected) {
      opts.onEvent({ type: 'status', text: '原生工具被拒，改用文本协议重试' });
      const nextRun = runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
      abortRef.abort = nextRun.abort;
      return nextRun.done;
    }
    return res;
  });

  return { abort: () => abortRef.abort(), done: donePromise };
}

function _startRun(opts) {
  const exePath = resolveExe('agy');
  
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
  // agy 支持 low|medium|high 三档;没有加速档,前端会把那个开关灰掉
  if (opts.effort) {
    args.push('--effort', opts.effort);
  }

  const safeOnEvent = (ev) => {
      if (childController) childController.safeOnEvent(ev);
      else {
          try { opts.onEvent(ev); } catch {}
      }
  };

  const runChild = () => {
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
                    if (opts.onPermissionDenied) opts.onPermissionDenied();
                    childController.safeOnEvent({ type: 'status', text: `agy 拒绝了 MCP 工具调用。请打开 AI 设置（右栏齿轮），点『授权 PromptCut 工具』，然后重试。` });
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

           /*
            * agy 出错时照样发一条 result,只是 status 是 ERROR、error 里写着原因,
            * 然后以非 0 退出。这里原来不看 status,把它当成正常收尾发了个 done ——
            * 而 done 一发,spawnCli 里 hasDone 就为真,`close` 那条「exited with code 1」
            * 也被一并压掉。于是界面上只剩一句「已启动 Antigravity」,几秒后无声无息地结束:
            * 没有回复、没有报错、usage 全是 0,看起来就像连不上。
            *
            * 实际最常撞上的是模型名不对(比如 `gemini-3.8.flash` —— agy 的名字是
            * `gemini-3.8-flash-low` 这种),agy 说得清清楚楚,只是没人把这句话传出来。
            * claude.mjs 那边一直是查 is_error 的,这里补齐。
            */
           if (res.status === 'ERROR' || res.error) {
              const why = typeof res.error === 'string' ? res.error : (res.error?.message || 'Antigravity 报错但没说原因');
              childController.finish({ type: 'error', message: `Antigravity: ${why}` });
              return;
           }

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
  };

  if (opts.mcp) {
    ensureMcpRegistered(exePath, opts.mcp, safeOnEvent).then(runChild);
  } else {
    runChild();
  }
  
  const abort = () => {
    isAborted = true;
    if (childController) childController.abort();
    else resolveDone();
  };
  
  return { abort, done: donePromise };
}
