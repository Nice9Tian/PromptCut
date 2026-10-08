import test from 'node:test';
import assert from 'node:assert/strict';

test('account executor assembly rejects incomplete configuration before registration or listening', async () => {
  const { createAccountExecutorAssembly } = await import('../agent-service/account-executor-assembly.mjs');
  let registered = 0;
  await assert.rejects(createAccountExecutorAssembly({ runClient: { registerInstance() { registered++; } } }),
    { code: 'account-executor-configuration', status: 503 });
  assert.equal(registered, 0);
});
