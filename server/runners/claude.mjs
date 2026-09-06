import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnCli, resolveExe, lineSplitter } from './index.mjs';
import { execFileSync } from 'node:child_process';

import { tools } from '../mcp-tools.mjs';

function getAllowedToolsArgv() {
  const arr = ['mcp__promptcut'];
  for (const t of tools) {
    arr.push(`mcp__promptcut__${t.name}`);
  }
  return arr;
}

export async function getClaudeProvider() {
  const exePath = resolveExe('claude', 'C:\\Users\\admin\\.local\\bin\\claude.exe');
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
  return { id: 'claude', label: 'Claude Code', available, version, path: exePath, note };
}

import { runTextProtocolLoop } from '../harness/tool-protocol.mjs';

export function startRun(opts) {
  if (opts.toolProtocol) {
    return runTextProtocolLoop({ startRun: _startRun, opts, onEvent: opts.onEvent });
  }

  let abortRef = { abort: () => {} };
  let rejected = false;

  const interceptOnEvent = (ev) => {
    if (ev.type === 'status' && ev.text && ev.text.includes('permission_denials')) {
        // Just in case
    }
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
  const exePath = resolveExe('claude', 'C:\\Users\\admin\\.local\\bin\\claude.exe');
  
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  
  if (opts.mcp) {
    const tempDir = path.join(os.tmpdir(), 'promptcut');
    fs.mkdirSync(tempDir, { recursive: true });
    const mcpConfigPath = path.join(tempDir, 'mcp-claude.json');
    
    const mcpConfig = {
      mcpServers: {
        "promptcut": {
          command: opts.mcp.command,
          args: opts.mcp.args,
          env: opts.mcp.env
        }
      }
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
    
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', ...getAllowedToolsArgv());
  }

  args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }

  const { child, safeOnEvent, finish, abort, donePromise } = spawnCli(exePath, args, { cwd: opts.cwd }, opts.onEvent, 'Claude Code');
  
  const toolIdToName = new Map();

  child.stdout.on('data', lineSplitter(line => {
    if (!line.trim()) return;
    if (process.env.PROMPTCUT_RUNNER_DEBUG) console.error('[Claude] ' + line);
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'system') {
         if (ev.subtype === 'init') {
            safeOnEvent({ type: 'session', sessionId: ev.session_id });
         } else if (ev.subtype === 'status' && ev.status) {
            safeOnEvent({ type: 'status', text: `claude: ${ev.status}` });
         }
      } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event?.delta?.type === 'text_delta') {
        safeOnEvent({ type: 'text', delta: ev.event.delta.text });
      } else if (ev.type === 'assistant' && ev.message?.content) {
         for (const c of ev.message.content) {
            if (c.type === 'tool_use') {
               toolIdToName.set(c.id, c.name);
               safeOnEvent({ type: 'tool_call', name: c.name, input: c.input });
            }
         }
      } else if (ev.type === 'user' && ev.message?.content) {
         for (const c of ev.message.content) {
            if (c.type === 'tool_result') {
               let summary = '';
               if (typeof c.content === 'string') summary = c.content;
               else if (Array.isArray(c.content)) summary = c.content.map(x => (x.text || '')).join('');
               
               const name = toolIdToName.get(c.tool_use_id) || 'unknown';
               safeOnEvent({ type: 'tool_result', name: name, ok: !c.is_error, summary: summary.substring(0, 300) });
            }
         }
      } else if (ev.type === 'result') {
         if (ev.permission_denials && ev.permission_denials.length > 0) {
             if (opts.onPermissionDenied) opts.onPermissionDenied();
         }
         if (ev.result && ev.result.permission_denials && ev.result.permission_denials.length > 0) {
             if (opts.onPermissionDenied) opts.onPermissionDenied();
         }
         if (ev.is_error) {
             const message = ev.result || ev.error?.message || ev.terminal_reason || 'Claude 出错';
             finish({ type: 'error', message });
         } else {
             const usage = ev.usage || {};
             if (ev.total_cost_usd !== undefined) usage.total_cost_usd = ev.total_cost_usd;
             finish({ type: 'done', sessionId: ev.session_id, usage });
         }
      }
    } catch {}
  }));

  child.stdin.on('error', () => { /* ignore EPIPE */ });
  try {
      child.stdin.write(opts.prompt);
      child.stdin.end();
  } catch {
      // ignore
  }

  return { abort, done: donePromise };
}
