/** Controlled transaction/OS model. Never described as a kernel witness. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { digestOf } from '../account/ledger.mjs';
import { publishAgentScope } from '../hosted/deploy/agent-run-scope-publisher.mjs';
import { assetClosureUnitV2 } from '../hosted/asset-root-registry-schema-v2.mjs';
import { scopeRuntimeExpected } from '../hosted/agent-run-scope-schema.mjs';

export const pair = () => { const p = generateKeyPairSync('ed25519'); return { privateKey: p.privateKey,
  publicKey: p.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; };
export const signed = (value, key) => ({ ...value, signature: sign(null, Buffer.from(digestOf(value)), key).toString('base64url') });
export function scopeModel(slotId = 'slot-a') {
  const doc = pair(), files = new Map(), calls = [], faults = {}; let locked = false, n = 0, key;
  const bootId = '11111111-1111-1111-1111-111111111111';
  const expected = { authorityId: `root-${slotId}`, slotId, docAuthorityId: 'doc', docPublicKey: doc.publicKey,
    serviceIdentity: 'agent', uid: 12001, unit: `${slotId}.service`, clientFingerprint256: '1'.repeat(64), serverFingerprint256: '2'.repeat(64),
    closurePolicy: { kind: 'systemd-slice', unitNamespace: 'pcagenttest', cgroupRoot: '/sys/fs/cgroup', placement: 'direct-child', singleEpoch: true } };
  const clone = structuredClone;
  const io = {
    read: async name => clone(files.get(name) ?? null),
    async write(name, value, exclusive = false) {
      calls.push(`write:${name}`); if (exclusive && files.has(name)) throw Error('exists');
      if (faults.beforeWrite?.(name)) throw Error('fsync-before'); files.set(name, clone(value));
      if (faults.afterWrite?.(name)) throw Error('fsync-after-visible');
    },
    async lock() { if (locked) throw Error('locked'); locked = true; files.set('.publisher.lock', { pid: 1 });
      return async ({ publicationDurable }) => { if (publicationDurable) { locked = false; files.delete('.publisher.lock'); } }; },
    uuid: () => `instance-${slotId}-${++n}`, scopeId: () => String(n).padStart(32, '0'),
    async assertInitial() { if ([...files.keys()].some(k => k !== '.publisher.lock')) throw Error('not-empty'); },
    async createScope(plan) {
      key = pair(); const unit = assetClosureUnitV2(scopeRuntimeExpected(expected), plan);
      return { ...plan, authorityId: expected.authorityId, kind: 'systemd-slice', unit, unitInvocationId: String(n * 2).padStart(32, '0'), bootId,
        cgroup: { v2Path: `/sys/fs/cgroup/${unit}`, dev: '30', ino: String(n * 2), bootId } };
    },
    async configureService() { calls.push('configure'); }, async start() { calls.push('start'); },
    async inspect(r) {
      const instance = { instanceId: r.instanceId, bootId, pid: 100 + n, pidBirth: { bootId, startTicks: String(1000 + n) },
        uid: expected.uid, unit: expected.unit, unitInvocationId: String(n * 2 + 1).padStart(32, '0'),
        cgroup: { v2Path: r.serviceCgroupPath, dev: '30', ino: String(n * 2 + 1), bootId }, serviceIdentity: expected.serviceIdentity,
        clientFingerprint256: expected.clientFingerprint256, serverFingerprint256: expected.serverFingerprint256 };
      return { instance, closureScope: clone(r.closureScope) };
    },
    async identity(r) { return { v: 1, serviceId: 'agent', authorityId: expected.authorityId, slotId, epoch: r.epoch,
      instanceId: r.instanceId, pid: 100 + n, publicKey: key.publicKey, publicKeyDigest: digestOf(key.publicKey),
      clientFingerprint256: expected.clientFingerprint256, serverFingerprint256: expected.serverFingerprint256 }; },
    async pinPrevious(record) {
      calls.push('pin'); if (faults.pin) throw Error('old-identity-changed');
      return {
        async stopAndObserve() { calls.push('stop'); if (faults.observe) throw Error('ENODEV');
          return { kind: 'cgroup-empty', closed: true, at: 100, bootId, serviceInstance: clone(record.instance), closureScope: clone(record.closureScope),
            scopeActive: true, scopeExclusive: true, populated: faults.populated ?? 0, serviceInactive: true, mainBirthGone: true }; },
        async releaseScope() { calls.push('release'); if (faults.release) throw Error('release-unknown'); },
        async close() { calls.push('close-fd'); },
      };
    },
    async pinRetired(record) {
      const pinned = await io.pinPrevious(record);
      return { ...pinned, async observeFailure() {
        calls.push('observe-failure');
        if (faults.mainGone !== true) throw Error('main-still-live');
        return { kind: 'main-birth-gone', at: 100, bootId, serviceInstance: clone(record.instance), closureScope: clone(record.closureScope),
          scopeActive: true, scopeExclusive: true, mainPid: 0, mainBirthGone: true, populated: faults.failurePopulated ?? 1 };
      } };
    },
  };
  const run = (mode, args = {}) => publishAgentScope({ expected, mode, io,
    configuredAnchorDigest: files.has('anchor.json') ? digestOf(files.get('anchor.json')) : null, ...args });
  const assignment = (changes = {}) => {
    const record = files.get(`epoch-${n}.json`);
    return signed({ v: 1, protocol: 'promptcut.agent-run-scope.assignment.v1', authorityId: expected.authorityId, slotId,
      epoch: n, recordDigest: digestOf(record), docAuthorityId: expected.docAuthorityId,
      target: { projectId: 'project', conversationId: `conversation-${slotId}`, messageId: `message-${n}`, runId: `run-${n}`, runGrantId: `grant-${n}`,
        serviceId: 'agent', serviceKid: 'agent-kid', instanceId: record.instance.instanceId, instanceGeneration: n,
        publicKeyDigest: record.worker.publicKeyDigest, ...changes } }, doc.privateKey);
  };
  const closing = () => {
    const record = files.get(`epoch-${n}.json`), a = files.get(`assignment-${n}.json`);
    const terminal = signed({ v: 1, protocol: 'promptcut.agent-run-scope.terminal.v1', authorityId: expected.authorityId, slotId, epoch: n,
      recordDigest: digestOf(record), docAuthorityId: expected.docAuthorityId, assignmentDigest: digestOf(a),
      finish: { readReceiptId: 'read', finishReceiptId: 'finish', outcomeDigest: 'a'.repeat(64), terminalReceiptDigest: 'b'.repeat(64) } }, doc.privateKey);
    const intent = signed({ v: 1, protocol: 'promptcut.agent-run-scope.intent.v1', assignmentDigest: digestOf(a), terminalDigest: digestOf(terminal) }, key.privateKey);
    return { terminal, intent };
  };
  return { expected, files, io, faults, calls, run, assignment, closing, doc, get workerKey() { return key; } };
}
