/**
 * Isolated actual-provider product fixture; --url http://127.0.0.1:5760 --out <TMP directory>.
 * Requires PROMPTCUT_ACCOUNT_PROVIDER_ROOT and PROMPTCUT_PASSWORD_ORDER_MODULE pointing to reviewed sources.
 * Owns URL and URL+1, never attaches to an existing service. Asserts 33 abrupt-crash/missing-evidence cases
 * and real mTLS/HTTP seal-ACK/private races. Exit 1 on any failure; no retries. This does not prove production mounting.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFaultMatrix } from './fixtures/password-order/fault-matrix.mjs';
import { runLiveProbe } from './fixtures/password-order/live-fixture.mjs';

const args = process.argv.slice(2); const get = (key) => args[args.indexOf(key) + 1];
const out = path.resolve(get('--out') ?? ''); const relative = path.relative(path.resolve(os.tmpdir()), out);
if (!args.includes('--out') || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Probe output must be an isolated directory under system TEMP');
fs.mkdirSync(out, { recursive: true });
try {
  const faults = await runFaultMatrix(path.join(out, 'faults'));
  const live = await runLiveProbe({ url: get('--url'), out: path.join(out, 'live') });
  const result = { passed: faults.length + live.length, failed: 0, faults, live };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, failed: 0, out, mode: 'actual-provider-isolated-fixture' }));
} catch (error) { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ code: error.code, message: error.message }, null, 2)); throw error; }
