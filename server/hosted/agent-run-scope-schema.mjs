/** Agent-only proof chain. Pure validation does not authenticate root files or
 * attest the kernel. No asset publication is accepted as a run publication. */
import { createPublicKey, verify } from 'node:crypto';
import { digestOf } from '../account/ledger.mjs';
import { validateAssetRootExpectedV2, validateAssetRootScopeV2, validateAssetRootInstanceV2 } from './asset-root-registry-schema-v2.mjs';

export const failScope = code => { throw Object.assign(new Error(`agent-scope-${code}`), { code: `agent-scope-${code}` }); };
export const exactScope = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const sameScope = (a, b) => digestOf(a) === digestOf(b);
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const domain = kind => `promptcut.agent-run-scope.${kind}.v1`;
const ROOT = ['authorityId', 'serviceIdentity', 'uid', 'unit', 'clientFingerprint256', 'serverFingerprint256', 'closurePolicy'];
const EXPECTED = [...ROOT, 'slotId', 'docAuthorityId', 'docPublicKey'];
const TARGET = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId', 'serviceId', 'serviceKid', 'instanceId', 'instanceGeneration', 'publicKeyDigest'];
export const scopePhaseRank = phase => phase === 'ready' ? 0 : phase === 'bound' ? 1 : phase === 'closed' ? 2 : undefined;

export function scopePublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 128) failScope('public-key');
  let key; try { key = createPublicKey({ key: Buffer.from(value, 'base64'), type: 'spki', format: 'der' }); } catch { failScope('public-key'); }
  if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'der' }).toString('base64') !== value) failScope('public-key');
  return key;
}
export function verifyScopeSignature(value, publicKey) {
  const { signature, ...payload } = value;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      !verify(null, Buffer.from(digestOf(payload)), scopePublicKey(publicKey), Buffer.from(signature, 'base64url'))) failScope('signature');
  return value;
}
/** Reuses only the existing strict root OS tuple grammar; it has no asset
 * service/domain/record conversion. Agent records below have separate domains. */
export function scopeRuntimeExpected(expected) {
  return Object.fromEntries(ROOT.map(k => [k, expected[k]]));
}
export function validateAgentScopeExpected(value) {
  if (!exactScope(value, EXPECTED) || !ref(value.slotId) || !ref(value.docAuthorityId)) failScope('expected');
  validateAssetRootExpectedV2(scopeRuntimeExpected(value)); scopePublicKey(value.docPublicKey);
  return structuredClone(value);
}
export function validateAgentScopeReservation(value, expected) {
  validateAgentScopeExpected(expected);
  if (!exactScope(value, ['v', 'protocol', 'authorityId', 'slotId', 'epoch', 'instanceId', 'serviceCgroupPath', 'closureScope']) ||
      value.v !== 1 || value.protocol !== domain('reservation') || value.authorityId !== expected.authorityId ||
      value.slotId !== expected.slotId || !positive(value.epoch) || !ref(value.instanceId)) failScope('reservation');
  validateAssetRootScopeV2(value.closureScope, { expected: scopeRuntimeExpected(expected), epoch: value.epoch, instanceId: value.instanceId });
  if (value.serviceCgroupPath !== `${value.closureScope.cgroup.v2Path}/${expected.unit}`) failScope('containment');
  return structuredClone(value);
}
export function validateAgentScopeRecord(value, expected) {
  validateAgentScopeExpected(expected);
  if (!exactScope(value, ['v', 'protocol', 'authorityId', 'slotId', 'epoch', 'instance', 'closureScope', 'worker', 'previousClosureDigest']) ||
      value.v !== 1 || value.protocol !== domain('epoch') || value.authorityId !== expected.authorityId || value.slotId !== expected.slotId ||
      !positive(value.epoch) || !exactScope(value.worker, ['publicKey', 'publicKeyDigest']) ||
      value.worker.publicKeyDigest !== digestOf(value.worker.publicKey) ||
      (value.epoch === 1 ? value.previousClosureDigest !== null : !hash(value.previousClosureDigest))) failScope('record');
  scopePublicKey(value.worker.publicKey);
  validateAssetRootScopeV2(value.closureScope, { expected: scopeRuntimeExpected(expected), epoch: value.epoch, instanceId: value.instance?.instanceId });
  validateAssetRootInstanceV2(value.instance, { expected: scopeRuntimeExpected(expected), closureScope: value.closureScope });
  return structuredClone(value);
}
function certificate(value, kind, keys, expected, record) {
  if (!exactScope(value, ['v', 'protocol', 'authorityId', 'slotId', 'epoch', 'recordDigest', 'docAuthorityId', ...keys, 'signature']) ||
      value.v !== 1 || value.protocol !== domain(kind) || value.authorityId !== expected.authorityId || value.slotId !== expected.slotId ||
      value.epoch !== record.epoch || value.recordDigest !== digestOf(record) || value.docAuthorityId !== expected.docAuthorityId) failScope(kind);
  verifyScopeSignature(value, expected.docPublicKey);
}
export function validateAgentScopeAssignment(value, expected, record) {
  certificate(value, 'assignment', ['target'], expected, record);
  const t = value.target;
  if (!exactScope(t, TARGET) || TARGET.filter(k => !['instanceGeneration', 'publicKeyDigest'].includes(k)).some(k => !ref(t[k])) ||
      t.serviceId !== 'agent' || !positive(t.instanceGeneration) || t.instanceId !== record.instance.instanceId ||
      t.publicKeyDigest !== record.worker.publicKeyDigest) failScope('assignment');
  return structuredClone(value);
}
export function validateAgentScopeTerminal(value, intent, expected, record, assignment) {
  validateAgentScopeAssignment(assignment, expected, record);
  certificate(value, 'terminal', ['assignmentDigest', 'finish'], expected, record);
  if (value.assignmentDigest !== digestOf(assignment) || !exactScope(value.finish, ['readReceiptId', 'finishReceiptId', 'outcomeDigest', 'terminalReceiptDigest']) ||
      !ref(value.finish.readReceiptId) || !ref(value.finish.finishReceiptId) || !hash(value.finish.outcomeDigest) || !hash(value.finish.terminalReceiptDigest)) failScope('terminal');
  if (!exactScope(intent, ['v', 'protocol', 'assignmentDigest', 'terminalDigest', 'signature']) || intent.v !== 1 ||
      intent.protocol !== domain('intent') || intent.assignmentDigest !== digestOf(assignment) || intent.terminalDigest !== digestOf(value)) failScope('intent');
  verifyScopeSignature(intent, record.worker.publicKey);
  return structuredClone(value);
}
/** Forced closure is Doc-authorized by a durable fence, never a fabricated
 * worker intent. Retirement concerns a root-unbound slot, not a task outcome. */
export function agentScopeCloseKind(terminal) {
  return terminal?.protocol === domain('terminal') ? 'normal' : terminal?.protocol === domain('forced-terminal') ? 'forced'
    : terminal?.protocol === domain('unassigned-retirement') ? 'unassigned' : failScope('terminal-kind');
}
export function validateAgentScopeCloseEnvelope(value, intent, expected, record, assignment) {
  const kind = agentScopeCloseKind(value);
  if (kind === 'normal') return validateAgentScopeTerminal(value, intent, expected, record, assignment);
  if (intent !== null) failScope('unexpected-worker-intent');
  if (kind === 'forced') {
    validateAgentScopeAssignment(assignment, expected, record);
    certificate(value, 'forced-terminal', ['assignmentDigest', 'fence'], expected, record);
    const f = value.fence;
    if (value.assignmentDigest !== digestOf(assignment) || !exactScope(f, ['controlId', 'fenceRevision', 'payloadDigest', 'kind', 'outcome']) ||
        !ref(f.controlId) || !positive(f.fenceRevision) || !hash(f.payloadDigest) ||
        !['stop', 'private', 'delete', 'agent-disabled', 'credential-revoked', 'member-revoked', 'instance-revoked', 'worker-failed'].includes(f.kind) ||
        !['failed', 'interrupted'].includes(f.outcome)) failScope('forced-terminal');
  } else {
    if (assignment !== null || !exactScope(value, ['v', 'protocol', 'authorityId', 'slotId', 'epoch', 'recordDigest', 'reason']) ||
        value.v !== 1 || value.authorityId !== expected.authorityId || value.slotId !== expected.slotId ||
        value.epoch !== record.epoch || value.recordDigest !== digestOf(record) ||
        !['worker-start-failed', 'registration-failed', 'assignment-failed'].includes(value.reason)) failScope('unassigned-retirement');
  }
  return structuredClone(value);
}
export function validateAgentScopeClosure(value, expected, record, assignment, terminal, intent) {
  validateAgentScopeCloseEnvelope(terminal, intent, expected, record, assignment);
  const kind = agentScopeCloseKind(terminal), closureProtocol = kind === 'normal' ? domain('closure') : domain(`${kind}-closure`);
  if (!exactScope(value, ['v', 'protocol', 'authorityId', 'slotId', 'epoch', 'recordDigest', 'assignmentDigest', 'terminalDigest', 'intentDigest', 'observed']) ||
      value.v !== 1 || value.protocol !== closureProtocol || value.authorityId !== expected.authorityId || value.slotId !== expected.slotId ||
      value.epoch !== record.epoch || value.recordDigest !== digestOf(record) || value.assignmentDigest !== (assignment ? digestOf(assignment) : null) ||
      value.terminalDigest !== digestOf(terminal) || value.intentDigest !== (intent ? digestOf(intent) : null)) failScope('closure');
  const o = value.observed;
  if (!exactScope(o, ['kind', 'closed', 'at', 'bootId', 'serviceInstance', 'closureScope', 'scopeActive', 'scopeExclusive', 'populated', 'serviceInactive', 'mainBirthGone']) ||
      o.kind !== 'cgroup-empty' || o.closed !== true || !positive(o.at) || o.bootId !== record.instance.bootId ||
      !sameScope(o.serviceInstance, record.instance) || !sameScope(o.closureScope, record.closureScope) || o.scopeActive !== true ||
      o.scopeExclusive !== true || o.populated !== 0 || o.serviceInactive !== true || o.mainBirthGone !== true) failScope('closure-observation');
  return structuredClone(value);
}
export function scopeHead(entry, phase) {
  return { v: 1, protocol: domain('head'), authorityId: entry.record.authorityId, slotId: entry.record.slotId, epoch: entry.record.epoch, phase,
    recordDigest: digestOf(entry.record), assignmentDigest: phase === 'ready' || !entry.assignment ? null : digestOf(entry.assignment),
    closureDigest: phase === 'closed' ? digestOf(entry.closure) : null };
}
export function scopePublication(entry, phase, anchor) {
  return { v: 1, protocol: domain('publication'), head: scopeHead(entry, phase), anchorDigest: digestOf(anchor),
    reservationDigest: digestOf(entry.reservation), terminalDigest: phase === 'closed' ? digestOf(entry.terminal) : null,
    intentDigest: phase === 'closed' && entry.intent ? digestOf(entry.intent) : null };
}
export function validateAgentScopeHistory({ expected, anchor, configuredAnchorDigest, entries, current, locked = true, checkpoint = null }) {
  validateAgentScopeExpected(expected);
  if (locked !== false || !hash(configuredAnchorDigest) || digestOf(anchor) !== configuredAnchorDigest ||
      !exactScope(anchor, ['v', 'protocol', 'expected', 'firstRecordDigest']) || anchor.v !== 1 || anchor.protocol !== domain('anchor') ||
      !sameScope(anchor.expected, expected) || !hash(anchor.firstRecordDigest)) failScope('anchor-or-lock');
  if (!Array.isArray(entries) || !entries.length || entries.length !== current?.epoch || scopePhaseRank(current.phase) === undefined) failScope('history');
  const unique = new Set(); let previous;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], phase = i === entries.length - 1 ? current.phase : 'closed';
    if (!exactScope(e, ['record', 'reservation', 'assignment', 'terminal', 'intent', 'closure', 'publications']) ||
        e.record?.epoch !== i + 1 || !exactScope(e.publications, ['ready', 'bound', 'closed'])) failScope('history');
    const r = validateAgentScopeRecord(e.record, expected); validateAgentScopeReservation(e.reservation, expected);
    if (e.reservation.instanceId !== r.instance.instanceId || !sameScope(e.reservation.closureScope, r.closureScope)) failScope('reservation');
    if (i === 0 ? anchor.firstRecordDigest !== digestOf(r) : r.previousClosureDigest !== digestOf(previous.closure) ||
        r.instance.bootId !== previous.record.instance.bootId) failScope('history');
    for (const id of [`instance:${r.instance.instanceId}`, `scope:${r.closureScope.scopeId}`, `unit:${r.closureScope.unit}`,
      `invocation:${r.instance.unitInvocationId}`, `invocation:${r.closureScope.unitInvocationId}`, `key:${r.worker.publicKeyDigest}`]) {
      if (unique.has(id)) failScope('generation-reused'); unique.add(id);
    }
    if (phase === 'ready' && [e.assignment, e.terminal, e.intent, e.closure, e.publications.bound, e.publications.closed].some(x => x !== null)) failScope('phase');
    if (phase === 'bound' && [e.terminal, e.intent, e.closure, e.publications.closed].some(x => x !== null)) failScope('phase');
    const unassigned = phase === 'closed' && agentScopeCloseKind(e.terminal) === 'unassigned';
    if (unassigned && (e.assignment !== null || e.intent !== null || e.publications.bound !== null)) failScope('retirement-bound');
    if (phase !== 'ready' && !unassigned) {
      validateAgentScopeAssignment(e.assignment, expected, r);
      const id = `grant:${e.assignment.target.runGrantId}`; if (unique.has(id)) failScope('grant-reused'); unique.add(id);
    }
    if (phase === 'closed') validateAgentScopeClosure(e.closure, expected, r, e.assignment, e.terminal, e.intent);
    for (const p of (unassigned ? ['ready', 'closed'] : ['ready', 'bound', 'closed'].slice(0, scopePhaseRank(phase) + 1)))
      if (!sameScope(e.publications[p], scopePublication(e, p, anchor))) failScope('publication-incomplete');
    previous = e;
  }
  if (!sameScope(current, scopeHead(previous, current.phase))) failScope('head');
  if (checkpoint) {
    if (!exactScope(checkpoint, ['anchorDigest', 'head']) || checkpoint.anchorDigest !== configuredAnchorDigest ||
        !positive(checkpoint.head?.epoch) || checkpoint.head.epoch > current.epoch || scopePhaseRank(checkpoint.head.phase) === undefined ||
        (checkpoint.head.epoch === current.epoch && scopePhaseRank(checkpoint.head.phase) > scopePhaseRank(current.phase)) ||
        !sameScope(checkpoint.head, scopeHead(entries[checkpoint.head.epoch - 1], checkpoint.head.phase))) failScope('rollback');
  }
  return { checkpoint: { anchorDigest: configuredAnchorDigest, head: structuredClone(current) },
    record: structuredClone(previous.record), assignment: structuredClone(previous.assignment),
    terminal: structuredClone(previous.terminal), closure: structuredClone(previous.closure) };
}
