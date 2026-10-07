import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFaultMatrix } from './password-order-fixture.mjs';

test('password-order actual subprocess crash matrix: SQLite persistence boundaries and missing evidence', {
  skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ? 'Actual cross-repository provider must be explicitly configured; portable unit tests do not prove it' : false,
}, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-order-faults-'));
  const results = await runFaultMatrix(out);
  assert.equal(results.length, 33);
  assert.ok(results.every((result) => result.passed));
  console.log(JSON.stringify({ proof: 'actual-provider-crash-matrix', cases: results.length, out }));
});
