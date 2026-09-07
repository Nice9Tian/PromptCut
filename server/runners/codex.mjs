import { cliEnv } from './cli-runtime.mjs';
import { spawnCli, resolveExe, lineSplitter, probeVersion } from './index.mjs';
import { execFileSync } from 'node:child_process';

export async function getCodexProvider() {
  const exePath = resolveExe('codex');
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
  return { id: 'codex', label: 'Codex', available, version, path: exePath, note };
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
  const exePath = resolveExe('codex');
  
  const args = [];
  if (opts.sessionId) {
      args.push('exec', 'resume', opts.sessionId);
  } else {
      args.push('exec');
  }
  args.push('--json', '--skip-git-repo-check');
  
  if (!opts.sessionId) {
      args.push('-C', opts.cwd);
      args.push('-s', 'read-only');
      args.push('-c', 'approval_policy="never"');
  } else {
      args.push('-c', 'sandbox_mode="read-only"');
      args.push('-c', 'approval_policy="never"');
  }
  
  if (opts.mcp) {
      args.push('-c', `mcp_servers.promptcut.command=${JSON.stringify(opts.mcp.command)}`);
      args.push('-c', `mcp_servers.promptcut.args=${JSON.stringify(opts.mcp.args)}`);
      const envPairs = Object.entries(opts.mcp.env).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join(', ');
      args.push('-c', `mcp_servers.promptcut.env={${envPairs}}`);
  }
  
  if (opts.model) {
      args.push('-m', opts.model);
  }
  // codex 没有 --effort,推理档只能通过 -c 覆盖配置项。codex 没有加速档,
  // 所以 opts.fast 在这里没有对应物,前端也会把那个开关灰掉。
  if (opts.effort) {
      args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  }
  args.push('-'); // stdin
  
  const fullPrompt = `<<<系统说明>>>\n${opts.systemPrompt}\n<<<用户消息>>>\n${opts.prompt}`;
  
  const { child, safeOnEvent, finish, abort, donePromise } = spawnCli(exePath, args, { cwd: opts.cwd, env: cliEnv('codex') }, opts.onEvent, 'Codex CLI');

  let sentLength = 0;
  let threadId = null;
  let warnedConfig = false;

  child.stderr.on('data', (data) => {
      const str = data.toString('utf8');
      if (!warnedConfig && str.includes('config.toml') && (str.includes('unknown variant') || str.includes('unknown field'))) {
          warnedConfig = true;
          safeOnEvent({ type: 'status', text: 'Codex 无法读取 PromptCut 的独立配置，请根据上一条错误检查配置。' });
      }
  });

  child.stdout.on('data', lineSplitter(line => {
    if (!line.trim()) return;
    if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[Codex] ' + line);
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || ev.event;
      
      if (evType === 'thread.started' && ev.thread_id) {
         threadId = ev.thread_id;
         safeOnEvent({ type: 'session', sessionId: ev.thread_id });
      } else if (evType === 'turn.started') {
         safeOnEvent({ type: 'status', text: 'Codex 开始处理' });
      } else if (evType === 'item.started' || evType === 'item.completed' || evType === 'item.updated') {
         const item = ev.item;
         if (item) {
             const itemType = item.item_type || item.type;
             if (itemType === 'agent_message') {
                 const txt = item.text ?? item.content ?? item.message;
                 if (typeof txt === 'string' && txt.length > sentLength) {
                    safeOnEvent({ type: 'text', delta: txt.slice(sentLength) });
                    sentLength = txt.length;
                 }
             } else if (itemType === 'mcp_tool_call') {
                 if (evType === 'item.started') {
                     const name = item.tool ?? item.name ?? item.tool_name;
                     const input = item.arguments ?? item.input ?? {};
                     safeOnEvent({ type: 'tool_call', name, input });
                 } else if (evType === 'item.completed') {
                     const name = item.tool ?? item.name ?? item.tool_name;
                     const ok = !(item.error) && item.status !== 'failed';
                     if (!ok && typeof item.error === 'string' && (item.error.toLowerCase().includes('denied') || item.error.toLowerCase().includes('approval'))) {
                         if (opts.onPermissionDenied) opts.onPermissionDenied();
                     }
                     const summary = item.result ? JSON.stringify(item.result).substring(0, 300) : (item.error ? String(item.error) : '');
                     safeOnEvent({ type: 'tool_result', name, ok, summary });
                 }
             }
         }
      } else if (evType === 'mcp_tool_call') {
         const status = ev.status || ev.state || ev.action;
         if (status === 'started' || status === 'active' || (!status && ev.input && !ev.result)) {
             safeOnEvent({ type: 'tool_call', name: ev.name, input: ev.input || {} });
         } else if (status === 'completed' || status === 'success' || status === 'error' || status === 'done' || ev.result !== undefined) {
             const ok = status === 'completed' || status === 'success' || status === 'done' || (!status && !ev.error);
             if (!ok && typeof ev.error === 'string' && (ev.error.toLowerCase().includes('denied') || ev.error.toLowerCase().includes('approval'))) {
                 if (opts.onPermissionDenied) opts.onPermissionDenied();
             }
             safeOnEvent({ type: 'tool_result', name: ev.name, ok, summary: ev.result ? JSON.stringify(ev.result).substring(0, 300) : '' });
         }
      } else if (evType === 'turn.completed') {
         finish({ type: 'done', sessionId: threadId, usage: ev.usage });
      } else if (evType === 'turn.failed') {
         finish({ type: 'error', message: ev.error?.message || ev.message || 'Codex turn failed' });
      } else if (evType === 'error') {
         const msg = ev.message || ev.error || 'Codex error';
         if (typeof msg === 'string' && (msg.startsWith('Reconnecting') || msg.includes('重试'))) {
             safeOnEvent({ type: 'status', text: msg });
         } else {
             safeOnEvent({ type: 'error', message: msg });
         }
      }
    } catch {}
  }));

  child.stdin.on('error', () => {});
  try {
      child.stdin.write(fullPrompt);
      child.stdin.end();
  } catch {}

  return { abort, done: donePromise };
}
