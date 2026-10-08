// Intentionally exits without finally/close at each persistence boundary. Only isolated TMP data is used.
import fs from 'node:fs';
import path from 'node:path';
import { fixture, accountFixture, loadKeys, spec, actor } from '../../../../server/test/password-order-fixture.mjs';
import { operationBinding, signDocProof } from '../../../../server/account/password-order.mjs';

const [dir, crash] = process.argv.slice(2);
const pair = loadKeys(path.join(dir, 'keys.json'));
const fault = (side) => (phase) => { if (`${side}:${phase}` === crash) process.exit(73); };
const account = await accountFixture({ dir, pair, actual: true, failpoint: fault('account'), storeFailpoint: fault('store') });
if (crash.startsWith('store:')) { account.change(); throw new Error('Expected password transaction crash did not happen'); }
if (crash.includes('logout-')) {
  const event = account.change(); account.choose(event, true);
  for (const service of ['doc', 'asset', 'agent', 'render']) account.store.ack(event.event_id, service, { receiptId: `ack-${service}`, appliedSeq: account.store.eventSequence(event.event_id), logoutComplete: true });
  const proof = signDocProof({ v: 1, domain: 'promptcut.logout-order', eventId: event.event_id, requestId: 'logout-proof', docAuthorityId: 'doc-one', pendingSeals: 0, revocationSeq: account.store.eventSequence(event.event_id), projectCursors: [], connections: [] }, pair.doc.privateKey);
  account.handle({ method: 'POST', path: '/internal/v2/order/logout-complete', body: { eventId: event.event_id, requestId: 'logout-proof', proof }, serviceId: 'doc' });
  throw new Error('Expected logout crash did not happen');
}
const f = await fixture({ dir, pair, account, failpoint: fault('doc'), historyFailpoint: fault('history'), acknowledgeFence: async () => ({ durable: true, receiptId: 'fixture-ack' }) });
fs.appendFileSync(path.join(dir, 'external-effects.log'), 'original invocation\n');
const principal = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
if (crash.includes('cancel')) {
  const prepared = f.history.prepareOperation(spec('crash-operation', { principal }));
  f.history.recordWitness(prepared, await f.client.reserve(operationBinding(prepared)));
  await f.coordinator.recover('project-one');
  throw new Error('Expected cancel crash did not happen');
}
await f.coordinator.submit(spec('crash-operation', { principal }));
if (crash.includes('fence-')) await f.coordinator.fence({ id: 'stop', projectId: 'project-one', kind: 'stop', runId: 'run' });
throw new Error(`Expected crash did not happen: ${crash}`);
