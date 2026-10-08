import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { runFixture, projectId, conversationId } from './run-authority-fixture.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createAccountOrderClient, createWitnessVerifier } from '../account/password-order.mjs';
import { openOperationHistory } from '../docservice/modules/operation-history.mjs';
import { createOperationWiring, createDurableProjectProjection } from '../docservice/operation-wiring.mjs';
import { createFileStore } from '../docservice/store/index.mjs';
import { projectModule, stateBlobName } from '../docservice/modules/project.mjs';
import { createDocService } from '../docservice/service.mjs';
import { wsClient } from './fake-ws-kit.mjs';

export async function runOperationFixture({ port = 5730, request, afterGate, waitPastAccessExpiry = false, failpoint = () => {}, accountFailpoint = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-operation-'));
  const providerRoot = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT;
  if (!providerRoot || !process.env.PROMPTCUT_PASSWORD_ORDER_MODULE) throw new Error('actual providers required');
  const { openStore } = await import(pathToFileURL(path.join(providerRoot, 'account/store.mjs')).href);
  const { createCredentials } = await import(pathToFileURL(path.join(providerRoot, 'account/credentials.mjs')).href);
  const { createPasswordOrder } = await import(pathToFileURL(process.env.PROMPTCUT_PASSWORD_ORDER_MODULE).href);
  const accountStore = openStore(path.join(dir, 'account.db')); const clock = { now: 100 };
  const credentials = createCredentials({ store: accountStore, now: () => clock.now, key: Buffer.alloc(32, 6) });
  const accountId = `acc_${'7'.repeat(24)}`;
  accountStore.createAccount({ id: accountId, name: 'fixture', nameKey: 'fixture', pw: 'fixture-only-hash', now: clock.now });
  accountStore.createLogin({ id: 'website', accountId, kind: 'website', now: clock.now, expiresAt: 9_000_000 });
  const session = credentials.createEditor({ account: accountStore.accountById(accountId), deviceId: 'fixture', requestId: 'login' });
  const actor = credentials.verify(session.accessToken);
  let authority;
  const f = await runFixture({ dir, clock, synchronize: () => authority.synchronize(), verifySender: (ref, context) => {
    if (typeof credentials.verifyAcceptedMessageActorRef !== 'function') throw Object.assign(new Error('accepted verifier unavailable'), { status: 503 });
    const result = credentials.verifyAcceptedMessageActorRef(ref, context.messageRef);
    if (result.purpose !== 'accepted-message') throw new Error('wrong accepted purpose');
    return { ...result.actorRef, accountEventSeq: result.accountEventSeq };
  } });
  authority = createAccountAuthority({ ledger: f.ledger, pollMs: 0, accountClient: { events: after => accountStore.events(after) } });
  f.enqueue(); f.ledger.transaction(s => {
    s.projects[projectId].members[accountId] = { access: 'rw' };
    const m = s.conversationsV2[projectId][conversationId].messages[0];
    Object.assign(m, { senderAccountId: actor.accountId, loginId: actor.loginId, credentialId: actor.credentialId,
      loginGeneration: actor.loginGeneration, selectionSnapshot: { ...m.selectionSnapshot, accountId } });
  });
  if (waitPastAccessExpiry) clock.now = session.accessExpiresAt + 1;
  const grant = await f.admit(); await f.provider.confirmRead(f.input(grant));
  const keys = { account: generateKeyPairSync('ed25519'), doc: generateKeyPairSync('ed25519') };
  const accountOrder = createPasswordOrder({ store: accountStore, credentials, accountOrderSigningKey: keys.account.privateKey,
    accountOrderKeyId: 'test', docAttestationPublicKey: keys.doc.publicKey, now: () => clock.now, failpoint: accountFailpoint });
  const invoke = args => accountOrder.handle({ ...args, serviceId: 'doc' });
  const client = createAccountOrderClient({ request: args => request ? request(args, invoke, result) : invoke(args) });
  const history = openOperationHistory(path.join(dir, 'history.db'));
  const storeDir = path.join(dir, 'original-store'), store = createFileStore({ dir: storeDir, log: () => {} });
  store.writeBlob(stateBlobName(projectId), JSON.stringify({ v: 1, projectId, rev: 1, at: clock.now,
    project: { title: 'before', clips: [] }, writers: [], history: [], opIds: [] }));
  const wiring = createOperationWiring({ history, account: client, verifyWitness: createWitnessVerifier({ keys: { test: keys.account.publicKey } }),
    authority: { checkAccess: () => {
      credentials.verify(session.accessToken); // Real ordinary token check; this fixture never grants page access.
      throw new Error('ordinary page unavailable in run-only fixture');
    } },
    projection: createDurableProjectProjection({ store, directory: storeDir }), docAuthorityId: 'doc-run-fixture',
    docAttestationPrivateKey: keys.doc.privateKey, failpoint,
    runProvider: { checkAccess: async args => { const value = await f.provider.checkAccess(args); await afterGate?.(value, result); return value; } } });
  const project = projectModule({ store, operationCoordinator: wiring, now: () => clock.now });
  const service = createDocService({ modules: [project], autoTick: false, log: () => {}, authenticate: async () => {
    const principal = await f.principal(grant); return { ...principal, tenantId: projectId, userId: principal.accountId };
  } });
  const clients = [], controls = [];
  let changes = 0;
  const result = { ...f, grant, actor, credentials, accountStore, history, wiring, project, store, clock, projectId,
    ordinaryPrincipal: { ...actor, projectId, role: 'page' },
    expireAccess() { clock.now = session.accessExpiresAt + 1; },
    change(exit) { const id = `change-${++changes}`; const event = accountStore.changePassword({ accountId, requestId: id,
      pw: 'next-fixture-hash', now: clock.now, initiatorWebsiteLoginId: 'website', clock: { diagnosticOnly: true } });
      accountStore.choose(event.event_id, 'website', exit, `choose-${id}`); return event; },
    control(kind) {
      if (kind === 'private') f.privateFence(`private-${controls.length}`);
      else f.provider.fence({ kind, requestId: `control-${controls.length}`, projectId, runId: grant.runId });
      const control = Object.values(f.ledger.read().runControlsV2).at(-1);
      for (const fence of control.operationFences) controls.push(wiring.fence(fence));
    },
    async connect() { const c = wsClient(`ws://127.0.0.1:${port}/`); clients.push(c); await c.opened; return c; },
    async close() {
      for (const c of clients) c.close(); await service.close(); await Promise.all(clients.map(c => c.closed));
      await Promise.allSettled(controls); await wiring.idle(); authority.close(); history.close(); f.close(); accountStore.close();
      fs.rmSync(dir, { recursive: true });
    } };
  await service.listen(port, '127.0.0.1'); return result;
}
