import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { openOperationHistory, canonical, digest, historyError } from '../docservice/modules/operation-history.mjs';
import { createPasswordOrder, createWitnessVerifier, createAccountOrderClient, signDocProof } from '../account/password-order.mjs';

export const actor = Object.freeze({ accountId: `acc_${'1'.repeat(24)}`, loginId: 'login-old', credentialId: 'credential-old', loginGeneration: 1 });
export const actorNew = Object.freeze({ ...actor, loginId: 'login-new', credentialId: 'credential-new' });
export const actorOther = Object.freeze({ accountId: `acc_${'2'.repeat(24)}`, loginId: 'login-other', credentialId: 'credential-other', loginGeneration: 1 });
export function keys() { return { account: generateKeyPairSync('ed25519'), doc: generateKeyPairSync('ed25519') }; }
export function saveKeys(file, pair) { fs.writeFileSync(file, JSON.stringify(Object.fromEntries(['account', 'doc'].map((kind) => [kind, { private: pair[kind].privateKey.export({ type: 'pkcs8', format: 'pem' }), public: pair[kind].publicKey.export({ type: 'spki', format: 'pem' }) }]))), { mode: 0o600 }); }
export function loadKeys(file) { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Object.fromEntries(['account', 'doc'].map((kind) => [kind, { privateKey: createPrivateKey(value[kind].private), publicKey: createPublicKey(value[kind].public) }])); }
export function spec(opId, { projectId = 'project-one', expectedRev = 0, principal = actor, ops = [{ op: 'set', path: '/title', value: opId }], ...rest } = {}) {
  return { projectId, opId, requestId: `request-${opId}`, docAuthorityId: 'doc-one', expectedRev, actor: principal, ops, result: { opId }, dependencies: [], ...rest };
}
// Independent protocol simulator for portable PC unit tests. Actual-provider mode never uses this implementation.
function simulator(pair) {
  const rows = new Map(); let seq = 0; let nonce = 0; const revoked = new Set();
  const signed = (body) => signDocProof({ v: 1, domain: 'visuhive.account-order', issuer: 'visuhive-account', keyId: 'test-account', ...body }, pair.account.privateKey);
  const handle = ({ method, path: url, body = {} }) => {
    if (url.endsWith('/reserve')) {
      const prior = [...rows.values()].find((row) => row.requestId === body.requestId);
      if (prior) { if (prior.preparedDigest !== body.preparedDigest) throw historyError('digest-mismatch'); return prior; }
      const row = signed({ ...body, witnessId: `w-${++nonce}`, kind: 'operation', state: 'reserved', orderSeq: null }); rows.set(row.witnessId, row); return row;
    }
    const [, witnessId, action] = /\/order\/([^/]+)(?:\/(seal|cancel))?$/.exec(url) ?? [];
    const prior = rows.get(witnessId); if (!prior) throw historyError('witness-not-found', 404);
    if (method === 'GET') return prior;
    if (prior.state !== 'reserved') { if (action === 'seal' && prior.state === 'cancelled') throw historyError('witness-cancelled'); return prior; }
    if (action === 'cancel') { const row = signed({ ...prior, state: 'cancelled' }); rows.set(witnessId, row); return row; }
    if (revoked.has(prior.actorRef.loginId) && !body.retainedProof) throw historyError('credential-revoked', 401);
    const proof = body.retainedProof;
    const authorization = proof ? { kind: 'retained', projectId: prior.projectId, runGrantId: prior.actorRef.runGrantId, runId: prior.actorRef.runId, messageId: prior.actorRef.messageId, conversationId: prior.actorRef.conversationId, proof } : { kind: 'credential' };
    const row = signed({ ...prior, state: 'sealed', orderSeq: ++seq, utcMs: 1, authorization }); rows.set(witnessId, row); return row;
  };
  return { handle, rows, mode: 'independent-simulator', change: () => ({ accountId: actor.accountId, oldLoginIds: [actor.loginId], choice: 'pending', changeSeq: ++seq }),
    choose: (event, exit) => { event.choice = exit ? 'exit' : 'retain'; if (exit) revoked.add(actor.loginId); seq++; return event; }, head: () => seq, close() {} };
}
export async function accountFixture({ dir, pair = keys(), actual = Boolean(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT), failpoint = () => {}, storeFailpoint = () => {}, utc = () => 100 } = {}) {
  if (!actual) return { ...simulator(pair), pair };
  const provider = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT; const moduleFile = process.env.PROMPTCUT_PASSWORD_ORDER_MODULE;
  if (!provider || !moduleFile) throw new Error('Actual account provider paths must be explicitly configured');
  const { openStore } = await import(pathToFileURL(path.join(provider, 'account/store.mjs')).href);
  const { createCredentials } = await import(pathToFileURL(path.join(provider, 'account/credentials.mjs')).href);
  const { createPasswordOrder: createAccountOrder } = await import(pathToFileURL(moduleFile).href);
  const store = openStore(path.join(dir, 'account.db'), { failpoint: storeFailpoint });
  const credentials = createCredentials({ store, now: () => 100, key: Buffer.alloc(32, 7) });
  for (const principal of [actor, actorNew, actorOther]) {
    if (!store.accountById(principal.accountId)) store.createAccount({ id: principal.accountId, name: principal.accountId, nameKey: principal.accountId, pw: 'fixture-only-hash', now: 1 });
    if (!store.login(principal.loginId)) {
      store.createLogin({ id: principal.loginId, accountId: principal.accountId, kind: 'editor', now: 1, expiresAt: 100000, generation: 1 });
      store.createCredential({ id: principal.credentialId, loginId: principal.loginId, tokenHash: `fixture-${principal.credentialId}`, kind: 'access', now: 1, expiresAt: 100000 });
    }
  }
  if (!store.login('website')) store.createLogin({ id: 'website', accountId: actor.accountId, kind: 'website', now: 1, expiresAt: 100000 });
  const order = createAccountOrder({ store, credentials, accountOrderSigningKey: pair.account.privateKey, accountOrderKeyId: 'test-account', docAttestationPublicKey: pair.doc.publicKey, now: utc, failpoint });
  return { ...order, store, credentials, pair, mode: 'actual-foundation-sqlite', head: () => store.orderHead(),
    change: (requestId = 'password-change') => store.changePassword({ accountId: actor.accountId, requestId, pw: 'next-fixture-hash', now: utc(), initiatorWebsiteLoginId: 'website', clock: { diagnosticOnly: true } }),
    choose: (event, exit) => store.choose(event.event_id, 'website', exit, `choose-${event.event_id}`), close: () => store.close() };
}
export async function fixture({ dir, pair = keys(), account: provided, failpoint = () => {}, historyFailpoint = () => {}, request, checkGate = async () => ({ allowed: true }), acknowledgeFence, onFenceRequested, actual } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const account = provided ?? await accountFixture({ dir, pair, actual });
  const history = openOperationHistory(path.join(dir, 'history.db'), { failpoint: historyFailpoint });
  history.createProject('project-one', { title: 'before', clips: [{ id: 'clip/a', x: 1 }, { id: 'clip-b', x: 2 }], cardSource: 'old' });
  history.createProject('project-two', { title: 'before' });
  const invoke = (args) => account.handle({ ...args, serviceId: 'doc' });
  const client = createAccountOrderClient({ request: request ? (args) => request(args, invoke) : invoke, timeoutMs: 1000 });
  const verifier = createWitnessVerifier({ keys: { 'test-account': pair.account.publicKey } });
  const coordinator = createPasswordOrder({ history, account: client, verifyWitness: verifier, checkGate, docAttestationPrivateKey: pair.doc.privateKey, failpoint, acknowledgeFence, onFenceRequested });
  return { account, history, coordinator, client, verifier, pair, close() { history.close(); if (!provided) account.close(); } };
}
export { canonical, digest };
