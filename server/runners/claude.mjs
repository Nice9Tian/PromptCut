import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnCli, resolveExe, lineSplitter } from './index.mjs';
import { execFileSync } from 'node:child_process';

const ALLOWED_TOOLS_PATTERN = 'mcp__promptcut';

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

export function startRun(opts) {
  const exePath = resolveExe('claude', 'C:\\Users\\admin\\.local\\bin\\claude.exe');
  
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

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', ALLOWED_TOOLS_PATTERN,
    '--permission-mode', 'default',
    '--append-system-prompt', opts.systemPrompt
  ];
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
