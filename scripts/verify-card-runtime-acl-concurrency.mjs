/**
 * Actual LPAC regression: independent broker processes share runtime/python.
 * Each round opens, crashes/restarts its only worker, evaluates a card that
 * proves the read-only input ACL still rejects writes, then closes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const base = path.join(root, 'work', 'card-runtime-acl-concurrency');
// Optional positional paths allow this to test a packaged cycle without
// changing its files. Set PROMPTCUT_ACL_CONCURRENCY_ROUNDS=8 for a longer run.
const runner = process.argv[2] ?? path.join(root, 'tools', 'card-runtime', 'target', 'release', 'promptcut-card-runtime.exe');
const runtime = process.argv[3] ?? path.join(root, 'desktop', 'src-tauri', 'runtime', 'python');
const rounds = Number(process.env.PROMPTCUT_ACL_CONCURRENCY_ROUNDS ?? 3);
assert(Number.isSafeInteger(rounds) && rounds > 0, 'PROMPTCUT_ACL_CONCURRENCY_ROUNDS must be a positive integer');
await rm(base, { recursive: true, force: true });
await mkdir(base, { recursive: true });

function graph(nodeId, definitionId) {
  return { nodes: [{ id: nodeId, adapter: 'python', definitionId, params: {}, inputs: {} }] };
}
const crash = {
  id: 'crash', entry: 'Card', need_prerendering: false,
  source: `import os
class Card:
 def __init__(self,style=None): pass
 def card(self,source,time): os.write(2,b'acl-concurrency forced exit\\n'); os._exit(31)`,
};
function healthy(inputDir) {
  const literal = JSON.stringify(inputDir);
  return {
    id: 'healthy', entry: 'Card', need_prerendering: false,
    source: `import os
class Card:
 def __init__(self,style=None): pass
 def card(self,source,time):
  denied=False
  try:
   with open(os.path.join(${literal}, 'must-remain-read-only.txt'), 'wb') as f: f.write(b'x')
  except PermissionError: denied=True
  if not denied: raise RuntimeError('input directory became writable')
  return GLSL('uniform float denied; void main(){outColor=vec4(denied,0.,1.,1.);}') (denied=1.0)`,
  };
}
class Broker {
  constructor(name, dirs) {
    this.name = name; this.dirs = dirs; this.buffer = ''; this.pending = new Map();
    this.proc = spawn(runner, [], { cwd: path.dirname(runner), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', d => process.stderr.write(`[${name} runner stderr] ${d}`));
    this.proc.stdout.on('data', d => this.read(d));
    this.exit = new Promise(resolve => this.proc.on('exit', (code, signal) => resolve({ code, signal })));
  }
  read(data) {
    this.buffer += data;
    for (;;) {
      const n = this.buffer.indexOf('\n'); if (n < 0) return;
      const line = this.buffer.slice(0, n); this.buffer = this.buffer.slice(n + 1);
      let message; try { message = JSON.parse(line); } catch (error) { this.rejectAll(error); return; }
      const pending = this.pending.get(message.id);
      if (!pending) { this.rejectAll(new Error(`[${this.name}] unexpected ${line}`)); return; }
      this.pending.delete(message.id); pending.resolve(message);
    }
  }
  rejectAll(error) { for (const { reject } of this.pending.values()) reject(error); this.pending.clear(); }
  request(id, op, scope, payload) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`[${this.name}] timeout for ${id}`)); }, 45000);
      timeout.unref();
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.proc.stdin.write(JSON.stringify({ id, op, scope, revision: 'acl-concurrency', payload }) + '\n', error => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }
  async stop() { this.proc.stdin.end(); const result = await this.exit; assert.equal(result.code, 0, `[${this.name}] runner exit ${JSON.stringify(result)}`); }
}
async function scenario(name) {
  const dirs = Object.fromEntries(await Promise.all(['input', 'output', 'temp'].map(async kind => {
    const dir = path.join(base, name, kind); await mkdir(dir, { recursive: true }); return [kind, dir];
  })));
  await writeFile(path.join(dirs.input, 'fixture.txt'), name);
  const broker = new Broker(name, dirs);
  try {
    for (let round = 0; round < rounds; round++) {
      const scope = `${name}-${round}`;
      const open = await broker.request(`open-${round}`, 'open', scope, { runtimeDir: runtime, inputDirs: [dirs.input], outputDir: dirs.output, tempDir: dirs.temp, workers: 1 });
      assert.equal(open.ok, true, `[${name}] open ${JSON.stringify(open)}`);
      // Send both before awaiting: the healthy request must survive the failed
      // active job and run in the replacement worker in FIFO order.
      const failed = broker.request(`crash-${round}`, 'evaluate', scope, { graph: graph('node', crash.id), definitions: [crash], style: {}, nodeId: 'node', time: 0, outputDir: dirs.output });
      const okay = broker.request(`healthy-${round}`, 'evaluate', scope, { graph: graph('node', healthy(dirs.input).id), definitions: [healthy(dirs.input)], style: {}, nodeId: 'node', time: 0, outputDir: dirs.output });
      const [dead, result] = await Promise.all([failed, okay]);
      assert.equal(dead.ok, false, `[${name}] crash ${JSON.stringify(dead)}`);
      assert.equal(dead.error?.code, 'worker_exited', `[${name}] crash ${JSON.stringify(dead)}`);
      assert.match(dead.error?.message ?? '', /acl-concurrency forced exit/, `[${name}] crash stderr ${JSON.stringify(dead)}`);
      assert.equal(result.ok, true, `[${name}] healthy ${JSON.stringify(result)}`);
      assert.equal(result.result?.type, 'glsl', `[${name}] healthy ${JSON.stringify(result)}`);
      assert.equal(result.result?.uniforms?.denied, 1, `[${name}] input write was not denied ${JSON.stringify(result)}`);
      const close = await broker.request(`close-${round}`, 'close', scope, {});
      assert.equal(close.ok, true, `[${name}] close ${JSON.stringify(close)}`);
    }
  } finally { await broker.stop(); }
}
await Promise.all([scenario('runner-a'), scenario('runner-b')]);
console.log(`LPAC_ACL_CONCURRENCY_SUCCESS runners=2 rounds=${rounds} sharedRuntime=${runtime}`);
