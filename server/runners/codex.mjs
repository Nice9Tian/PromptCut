import { spawnCli, resolveExe, lineSplitter } from './index.mjs';
import { execFileSync } from 'node:child_process';

export async function getCodexProvider() {
  const exePath = resolveExe('codex', 'C:\\Users\\admin\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
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
  return { id: 'codex', label: 'Codex', available, version, path: exePath, note };
}

export function startRun(opts) {
  const exePath = resolveExe('codex', 'C:\\Users\\admin\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
  
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
  } else {
      args.push('-c', 'sandbox_mode="read-only"');
  }
  
  args.push('-c', `mcp_servers.promptcut.command=${JSON.stringify(opts.mcp.command)}`);
  args.push('-c', `mcp_servers.promptcut.args=${JSON.stringify(opts.mcp.args)}`);
  const envPairs = Object.entries(opts.mcp.env).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join(', ');
  args.push('-c', `mcp_servers.promptcut.env={${envPairs}}`);
  
  if (opts.model) {
      args.push('-m', opts.model);
  }
  args.push('-'); // stdin
  
  const fullPrompt = `<<<系统说明>>>\n${opts.systemPrompt}\n<<<用户消息>>>\n${opts.prompt}`;
  
  const { child, safeOnEvent, finish, abort, donePromise } = spawnCli(exePath, args, { cwd: opts.cwd }, opts.onEvent, 'Codex CLI');

  let sentLength = 0;
  let threadId = null;
  let warnedConfig = false;

  child.stderr.on('data', (data) => {
      const str = data.toString('utf8');
      if (!warnedConfig && str.includes('config.toml') && (str.includes('unknown variant') || str.includes('unknown field'))) {
          warnedConfig = true;
          safeOnEvent({ type: 'status', text: 'Codex 读不了自己的配置：~/.codex/config.toml 里有这个版本不认识的取值（见上一条报错）。请自行修改该配置后重试；本程序不会替你改它。' });
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
