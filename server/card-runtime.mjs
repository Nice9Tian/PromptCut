import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_MESSAGE = 8 * 1024 * 1024;
const runtimeError = (message, code = 'CARD_RUNTIME') => Object.assign(new Error(message), { code });

/** The host never starts Python. Only the verified Rust LPAC runner can do so. */
export class CardRuntime {
  constructor({ root, executable, timeout = 120000, spawnImpl = spawn } = {}) {
    this.root = root; this.executable = executable; this.timeout = timeout;
    this.spawnImpl = spawnImpl;
    this.pending = new Map(); this.scopes = new Map(); this.sequence = 0;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (process.platform !== 'win32') throw runtimeError('Python card isolation requires Windows LPAC', 'ISOLATION_UNAVAILABLE');
      const candidates = [this.executable, process.env.PROMPTCUT_CARD_RUNTIME,
        // Installed sidecar runs with root=runtime/app. The LPAC executable is
        // a sibling of app, not nested below it.
        path.resolve(this.root, '..', 'card-runtime', 'promptcut-card-runtime.exe'),
        path.join(this.root, 'runtime', 'card-runtime', 'promptcut-card-runtime.exe'),
        path.join(this.root, 'desktop', 'src-tauri', 'runtime', 'card-runtime', 'promptcut-card-runtime.exe'),
        path.join(this.root, 'tools', 'card-runtime', 'target', 'release', 'promptcut-card-runtime.exe'),
        path.join(this.root, 'tools', 'card-runtime', 'target', 'debug', 'promptcut-card-runtime.exe')].filter(Boolean);
      let executable;
      for (const candidate of candidates) if (await fs.stat(candidate).then(s => s.isFile(), () => false)) { executable = candidate; break; }
      if (!executable) throw runtimeError('The packaged Python card isolation runner is missing', 'ISOLATION_UNAVAILABLE');
      // The runner sanitizes its own environment before creating threads. Send
      // only Windows path variables here as well; no API keys reach the runner.
      const allowed = new Set(['systemroot','windir','comspec','pathext','path','temp','tmp','systemdrive','userprofile','localappdata','appdata']);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
      const child = this.spawnImpl(executable, [], { cwd: this.root, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      this.child = child;
      let buffer = Buffer.alloc(0), diagnostic = '';
      child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const end = buffer.indexOf(10);
          if (end < 0) break;
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          if (line.length > MAX_MESSAGE) return this.fail(runtimeError('Runner message budget exceeded'), child);
          try {
            const message = JSON.parse(line.toString('utf8'));
            // receive awaits host input adapters.  A rejected adapter must fail this
            // child, rather than becoming an unhandled promise rejection.
            void this.receive(message).catch(error => this.fail(error, child));
          } catch { this.fail(runtimeError('Malformed isolation runner reply'), child); }
        }
        if (buffer.length > MAX_MESSAGE) this.fail(runtimeError('Runner message budget exceeded'), child);
      });
      child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-8192); });
      child.on('error', error => { if (this.closingChild !== child) this.fail(runtimeError(error.message, 'ISOLATION_UNAVAILABLE'), child); });
      child.on('exit', (code, signal) => { if (this.closingChild !== child) this.fail(runtimeError(`Isolation runner exited (${code ?? signal}): ${diagnostic}`, 'ISOLATION_STOPPED'), child); });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    })().catch(error => { this.starting = null; throw error; });
    return this.starting;
  }
  fail(error, child = this.child) {
    // Old child listeners may run after a replacement has started.  They must
    // never kill or reject work owned by the replacement.
    if (child && this.child !== child) return;
    child?.kill(); this.child = null; this.starting = null; this.scopes.clear();
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
  send(value) {
    if (!this.child || this.child.stdin.destroyed) throw runtimeError('Isolation runner is not available');
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > MAX_MESSAGE) throw runtimeError('Card control message exceeds budget');
    this.child.stdin.write(line);
  }
  async receive(message) {
    const task = this.pending.get(message.id);
    if (!task) return;
    if (message.revision !== task.revision) return task.reject(runtimeError('Stale runtime revision'));
    if (message.type === 'input') {
      try {
        if (!task.input) throw runtimeError('No source broker is available');
        const result = await task.input(message, task.signal);
        if (!this.pending.has(message.id) || task.signal?.aborted) return;
        this.send({ type: 'input_result', op: 'input_result', id: message.id, scope: task.scope, revision: task.revision,
          queryId: message.queryId, ok: true, result });
      } catch (error) {
        if (this.pending.has(message.id)) this.send({ type: 'input_result', op: 'input_result', id: message.id,
          scope: task.scope, revision: task.revision, queryId: message.queryId, ok: false, error: { message: error.message } });
      }
      return;
    }
    if (message.ok) task.resolve(message.result);
    else task.reject(runtimeError(message.error?.message || String(message.error || 'Python card failed'), message.error?.code));
  }
  async request(op, scope, revision, payload = {}, { signal, input, timeout = this.timeout } = {}) {
    await this.start();
    if (signal?.aborted) throw runtimeError('Card request cancelled', 'CARD_CANCELLED');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const finish = fn => value => { cleanup(); fn(value); };
      const abort = () => {
        try { this.send({ id: randomUUID(), op: 'cancel', scope, revision, payload: { id, requestId: id } }); } catch {}
        finish(reject)(runtimeError('Card request cancelled', 'CARD_CANCELLED'));
      };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject), revision, scope, signal, input });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { abort(); }, timeout);
      try { this.send({ id, op, scope, revision, payload }); } catch (error) { finish(reject)(error); }
    });
  }
  async open(scope, revision, config) {
    const signature = JSON.stringify(config);
    const existing = this.scopes.get(scope);
    if (existing) {
      if (existing.signature !== signature) throw runtimeError('Authorization scope cannot change its directories');
      return existing.ready;
    }
    const ready = this.request('open', scope, revision, config).catch(error => { this.scopes.delete(scope); throw error; });
    this.scopes.set(scope, { signature, ready });
    return ready;
  }
  async closeScope(scope, revision) {
    if (!this.scopes.has(scope)) return;
    await this.request('close', scope, revision); this.scopes.delete(scope);
  }
  async close() {
    const closes = await Promise.allSettled([...this.scopes].map(([scope]) => this.closeScope(scope, 'close')));
    // Ask every scope to release its profile/ACLs before ending stdin. Do not
    // kill a healthy runner here: its EOF path drops remaining scope state.
    const child = this.child;
    this.scopes.clear();
    if (child?.stdin && !child.stdin.destroyed) {
      this.closingChild = child;
      const exited = new Promise(resolve => child.once('exit', resolve));
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, 5000); timer.unref?.(); });
      child.stdin.end();
      // Failed scope closes are still given EOF so Rust can drop its remaining
      // state.  Only an all-fulfilled close set qualifies for the stronger
      // "every scope acknowledged" teardown guarantee.
      await Promise.race([exited, deadline]);
      clearTimeout(timer);
      if (this.child === child && child.exitCode === null && !child.killed) child.kill();
    }
    if (this.closingChild === child) this.closingChild = null;
    if (this.child === child) this.child = null;
    this.starting = null;
    for (const task of this.pending.values()) task.reject(runtimeError('Card runtime closed'));
    this.pending.clear();
  }
}
