import fs from 'node:fs';
import path from 'node:path';
import { accountFixture, actor, keys, saveKeys, loadKeys } from './password-order-fixture.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { openOperationHistory } from '../docservice/modules/operation-history.mjs';
import { createAccountOrderClient, createWitnessVerifier } from '../account/password-order.mjs';
import { createOperationWiring, createDurableProjectProjection } from '../docservice/operation-wiring.mjs';
import { projectModule, stateBlobName } from '../docservice/modules/project.mjs';
import { createFileStore } from '../docservice/store/index.mjs';
import { createDocService } from '../docservice/service.mjs';
import { wsClient } from './fake-ws-kit.mjs';

export async function operationFixture({ dir, port = 5760, request, failpoint = () => {}, historyFailpoint = () => {},
  accountFailpoint = () => {}, projectionFailpoint = () => {}, onFenceRequested, acknowledgeFence, runProvider,
  clock = { now: 100 }, principalTransform = p => p } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'keys.json');
  const pair = fs.existsSync(keyFile) ? loadKeys(keyFile) : keys();
  if (!fs.existsSync(keyFile)) saveKeys(keyFile, pair);
  const account = await accountFixture({ dir, pair, actual: true, failpoint: accountFailpoint, utc: () => clock.now });
  const storeDir = path.join(dir, 'project-store');
  const store = createFileStore({ dir: storeDir, log: () => {} });
  const sessionFile = path.join(dir, 'fixture-sessions.json');
  const sessions = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : {};
  for (const name of ['a', 'b']) if (!sessions[name]) sessions[name] = account.credentials.createEditor({
    account: account.store.accountById(actor.accountId), deviceId: `fixture-${name}`, requestId: `fixture-login-${name}` });
  const ledger = openAccountLedger({ file: path.join(dir, 'authority.db'), authorityId: 'doc-fixture' });
  const counts = { credentialChecks: 0 };
  const authority = createAccountAuthority({ ledger, accountClient: {
    async verify(token) { counts.credentialChecks++; return account.credentials.verify(token); },
    async events(after) { return account.store.events(after); },
  }, now: () => 100, pollMs: 0, authorityUrl: 'https://fixture.invalid',
  async initializeProject({ projectId, initialProject }) {
    store.writeBlob(stateBlobName(projectId), JSON.stringify({ v: 1, projectId, rev: 1, at: 100, project: initialProject, writers: [], history: [], opIds: [] }));
    return { contentId: `fixture:${projectId}` };
  } });
  await authority.start();
  if (!sessions.projectId) {
    const created = await authority.createProject({ accessToken: sessions.a.accessToken }, { name: 'Operation fixture', requestId: 'fixture-project', initialProject: { title: 'before', clips: [{ id: 'stable', value: 1 }] } });
    sessions.projectId = created.projectId;
  }
  fs.writeFileSync(sessionFile, JSON.stringify(sessions), { mode: 0o600 });
  const history = openOperationHistory(path.join(dir, 'history.db'), { failpoint: historyFailpoint });
  const invoke = args => account.handle({ ...args, serviceId: 'doc' });
  const client = createAccountOrderClient({ request: args => request ? request(args, invoke) : invoke(args), timeoutMs: 3000 });
  const coordinator = createOperationWiring({ history, account: client,
    verifyWitness: createWitnessVerifier({ keys: { 'test-account': pair.account.publicKey } }), authority,
    projection: createDurableProjectProjection({ store, directory: storeDir, failpoint: projectionFailpoint }),
    docAuthorityId: 'doc-fixture', failpoint, onFenceRequested, acknowledgeFence, runProvider });
  const project = projectModule({ store, now: () => clock.now, operationCoordinator: coordinator });
  const service = createDocService({ modules: [project], autoTick: false, log: () => {},
    async authenticate(req) {
      const name = new URL(req.url, 'http://localhost').searchParams.get('page') ?? 'a';
      if (!sessions[name]?.accessToken) return null;
      const p = await authority.authorizePrincipal({ accessToken: sessions[name].accessToken }, { projectId: sessions.projectId });
      return principalTransform({ ...p, tenantId: sessions.projectId, userId: p.accountId, deviceId: `fixture-${name}` });
    },
  });
  await service.listen(port, '127.0.0.1');
  const clients = [];
  return { account, authority, ledger, store, storeDir, history, coordinator, project, sessions, counts, projectId: sessions.projectId,
    async connect(name = 'a') { const c = wsClient(`ws://127.0.0.1:${port}/?page=${name}`); clients.push(c); await c.opened; return c; },
    async close() {
      for (const c of clients) c.close();
      await service.close(); await Promise.all(clients.map(c => c.closed));
      authority.close(); history.close(); ledger.close(); account.close();
    },
  };
}
