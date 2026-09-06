import { execFile } from 'node:child_process';
import { resolveExe } from './index.mjs';

const cache = new Map();

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    let actualCmd = cmd;
    let actualArgs = args;
    if (actualCmd.toLowerCase().endsWith('.cmd') || actualCmd.toLowerCase().endsWith('.bat')) {
      actualCmd = 'cmd.exe';
      actualArgs = ['/c', cmd, ...args];
    }
    
    execFile(actualCmd, actualArgs, {
      timeout: 5000,
      windowsHide: true,
      shell: false
    }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error
      });
    });
  });
}

export async function probeAuth(providerId, opts = {}) {
  const now = Date.now();
  if (!opts.refresh && cache.has(providerId)) {
    const cached = cache.get(providerId);
    if (now - cached.time < 10000) {
      return cached.result;
    }
  }

  let result = { loggedIn: null };

  if (providerId === 'claude') {
    const exe = resolveExe('claude', 'C:\\Users\\admin\\.local\\bin\\claude.exe');
    result.loginCommand = ['claude', 'auth', 'login'];
    const { stdout, stderr, error } = await runCommand(exe, ['auth', 'status']);
    
    let parsed = null;
    try {
      const match = stdout.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        parsed = JSON.parse(stdout);
      }
    } catch {}

    if (parsed && typeof parsed.loggedIn === 'boolean') {
      result.loggedIn = parsed.loggedIn;
      result.detail = `authMethod: ${parsed.authMethod || 'unknown'}, apiProvider: ${parsed.apiProvider || 'unknown'}`;
    } else {
      result.loggedIn = null;
      const combined = (stdout + '\n' + stderr).trim().substring(0, 300);
      result.detail = combined || (error ? `探测命令没跑起来:${error.message}` : 'No output');
    }
  } else if (providerId === 'codex') {
    const exe = resolveExe('codex', 'C:\\Users\\admin\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
    result.loginCommand = ['codex', 'login'];
    const { stdout, stderr, error } = await runCommand(exe, ['login', 'status']);
    const output = stdout + '\n' + stderr;

    if (output.includes('config.toml') && (output.includes('unknown variant') || output.includes('unknown field') || output.includes('Error loading configuration'))) {
      result.loggedIn = null;
      const lines = output.split('\n');
      const errorLine = lines.find(l => l.includes('config.toml')) || lines[0] || '';
      result.detail = errorLine.trim();
      
      const match = errorLine.match(/config\.toml:(\d+):/);
      const lineNum = match ? match[1] : '某一行';
      result.fixHint = `codex 配置文件 ~/.codex/config.toml 第 ${lineNum} 行的 model_reasoning_effort 值本版 codex 不认,改成 high 或 xhigh 后再试。`;
    } else if (stdout.includes('Not logged in')) {
      result.loggedIn = false;
    } else if (stdout.includes('Logged in')) {
      result.loggedIn = true;
    } else {
      result.loggedIn = null;
      const combined = output.trim().substring(0, 300);
      result.detail = combined || (error ? `探测命令没跑起来:${error.message}` : 'No output');
    }
  } else if (providerId === 'agy') {
    result.loggedIn = null;
    result.detail = 'agy 没有登录状态命令;未登录时首次运行会自己打开浏览器';
    result.loginCommand = ['agy'];
  }

  cache.set(providerId, { time: now, result });
  return result;
}

export function loginCommandFor(providerId) {
  if (providerId === 'claude') return ['claude', 'auth', 'login'];
  if (providerId === 'codex') return ['codex', 'login'];
  if (providerId === 'agy') return ['agy'];
  return null;
}
