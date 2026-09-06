import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function setupRoot() {
  return process.env.PROMPTCUT_CLI_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut', 'cli');
}

export function cliEnv(provider, base = process.env) {
  const env = { ...base };
  // PowerShell 7 module paths can shadow Windows PowerShell 5's built-ins.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  // A desktop Codex configuration may contain providers/options unsupported by the CLI.
  // Keep PromptCut login and execution in the same independent home.
  if (provider === 'codex') {
    env.CODEX_HOME = path.join(setupRoot(), 'codex-home');
    fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  }
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[key] = [path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'), env[key] || ''].join(path.delimiter);
  return env;
}

export function resolveCli(name, { env = process.env, home = os.homedir(), platform = process.platform, root = setupRoot(), lookup = execFileSync } = {}) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [
    path.join(root, name, name + (platform === 'win32' ? '.exe' : '')),
    path.join(home, '.local', 'bin', name + (platform === 'win32' ? '.exe' : '')),
  ];
  if (platform === 'win32') candidates.push(
    path.join(local, name, 'bin', `${name}.exe`),
    ...(name === 'codex' ? [path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')] : []),
    path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', `${name}.cmd`),
  );
  for (const file of candidates) if (fs.existsSync(file)) return file;
  try {
    const out = lookup(platform === 'win32' ? 'where.exe' : 'which', [name], {
      env, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const hits = out.trim().split(/\r?\n/);
    const hit = hits.find(f => fs.existsSync(f) && (platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(f)));
    if (hit) return hit;
  } catch {}
  return name;
}

export const psLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";
export const encodedPowerShell = script => ['-NoLogo', '-NoProfile', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue'; " + script, 'utf16le').toString('base64')];

// Use PowerShell's literal argument invocation for npm shims; no cmd.exe quoting
// of paths, prompts, JSON, ampersands, or spaces.
export function cliCommand(exe, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    const name = path.basename(exe, path.extname(exe)).toLowerCase();
    const pkg = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }[name];
    if (pkg) {
      const dir = path.join(path.dirname(exe), 'node_modules', pkg);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
        if (entry && fs.existsSync(path.join(dir, entry))) return { command: process.execPath, args: [path.join(dir, entry), ...args] };
      } catch {}
    }
    return { command: 'powershell.exe', args: encodedPowerShell(`& ${psLiteral(exe)} ${args.map(psLiteral).join(' ')}; exit $LASTEXITCODE`) };
  }
  return { command: exe, args };
}
