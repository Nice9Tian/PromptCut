import fs from 'node:fs';
import path from 'node:path';
import { createPasswordOrder } from '../account/password-order.mjs';
import { canonical, digest, historyError } from './modules/operation-history.mjs';

/** The same directory passed to createFileStore. No network paths or caller-supplied paths. */
export function createDurableProjectProjection({ store, directory, failpoint = () => {} } = {}) {
  if (!store?.writeBlob || !store?.readBlob || typeof directory !== 'string') throw historyError('projection-unavailable', 503);
  const root = path.resolve(directory);
  return {
    durability: process.platform === 'win32' ? 'file-fsync-rename-directory-sync-unavailable' : 'file-fsync-rename-directory-fsync',
    write(name, snapshot) {
      if (!/^projects\/[A-Za-z0-9._@%-]+$/.test(name)) throw historyError('bad-projection-path');
      const file = path.resolve(root, ...name.split('/'));
      if (path.relative(root, file).startsWith('..')) throw historyError('bad-projection-path');
      const text = canonical(snapshot);
      failpoint('projection-before-write');
      // createFileStore.writeBlob fsyncs a temporary file, then atomically renames it.
      store.writeBlob(name, text); failpoint('projection-after-rename');
      const fd = fs.openSync(file, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Node/Windows cannot open a directory descriptor for fsync. Do not claim power-loss
      // directory durability there; Linux deployment must exercise this syscall branch.
      if (process.platform !== 'win32') {
        const parent = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      }
      failpoint('projection-after-sync');
      if (store.readBlob(name) !== text || fs.readFileSync(file, 'utf8') !== text) throw historyError('needs-reconciliation');
      failpoint('projection-after-readback');
    },
  };
}

const runFields = ['runGrantId', 'runId', 'messageId', 'conversationId'];
/** Production assembly injects its CURRENT doc authority and authenticated order transport.
 * No allow-all default and no authority inferred from creator/sender. */
export function createOperationWiring({ history, account, verifyWitness, authority, projection, docAuthorityId,
  runProvider, docAttestationPrivateKey, failpoint = () => {}, acknowledgeFence, onFenceRequested } = {}) {
  if (!history || !authority?.checkAccess || !projection?.write || !docAuthorityId) throw historyError('operation-wiring-unavailable', 503);
  let target;
  const active = new Map();
  const ready = new Set();
  const requireTarget = () => { if (!target) throw historyError('projection-unavailable', 503); return target; };
  async function initializeProject(projectId) {
    try {
      const baseline = history.snapshot(projectId);
      if (!history.accepted(projectId).length) {
        const view = requireTarget().read(projectId);
        if (baseline.projectRev !== view.projectRev || digest(baseline.value) !== digest(view.value)) throw historyError('needs-reconciliation');
      }
    }
    catch (error) {
      if (error.code !== 'project-not-found') throw error;
      const view = requireTarget().read(projectId);
      if (view.orderProjection) throw historyError('needs-reconciliation');
      history.createProject(projectId, view.value, { projectRev: view.projectRev });
    }
  }
  async function checkPrincipal(principal, projectId, action = 'write') {
    if (principal?.realm !== 'account' || principal.identityVersion !== 2 || principal.projectId !== projectId) throw historyError('operation-forbidden', 403);
    order.assertUnfenced({ projectId, actor: principal });
    const isRun = principal.role !== 'page' || runFields.some(key => principal[key] !== undefined);
    if (isRun) {
      if (!runProvider?.checkAccess || runFields.some(key => typeof principal[key] !== 'string' || !principal[key])) throw historyError('run-provider-unavailable', 503);
      const result = await runProvider.checkAccess({ principal, projectId, action });
      if (result?.allowed !== true) throw historyError('operation-forbidden', 403);
      order.assertUnfenced({ projectId, actor: principal });
      return result;
    }
    const verified = await authority.checkAccess({ principal, projectId, action });
    if (verified?.allowed !== true) throw historyError('operation-forbidden', 403);
    order.assertUnfenced({ projectId, actor: principal });
    return { allowed: true };
  }
  const order = createPasswordOrder({ history, account, verifyWitness, docAttestationPrivateKey, failpoint, initializeProject,
    async checkGate({ operation }) {
      const principal = active.get(operation.requestId);
      if (!principal) throw historyError('operation-forbidden', 403);
      const result = await checkPrincipal(principal, operation.projectId);
      if (result.retainedGrant && !docAttestationPrivateKey) throw historyError('run-provider-unavailable', 503);
      return result;
    },
    async materializeAccepted(operation) {
      ready.delete(operation.projectId);
      await requireTarget().materialize(operation, projection);
      ready.add(operation.projectId);
    },
    acknowledgeFence,
    onFenceRequested(fence) { ready.delete(fence.projectId); target?.fenceRequested?.(fence, order.assertUnfenced); onFenceRequested?.(fence); },
  });
  return {
    bind(adapter) { if (target) throw historyError('projection-already-bound'); target = adapter; },
    isReady: projectId => ready.has(projectId),
    async recover(projectId) { ready.delete(projectId); await order.recover(projectId); ready.add(projectId); },
    async read(projectId, principal, fn, action = 'read') {
      await checkPrincipal(principal, projectId, action);
      return order.transact(projectId, async () => {
        await checkPrincipal(principal, projectId, action);
        ready.add(projectId); return fn();
      });
    },
    async execute({ projectId, principal, actor, request }, prepare, committed) {
      // Stable identity includes the client's exact operation intent, never its claimed actor.
      const requestIdentity = digest({ projectId, actor, request });
      const requestId = `project-op:${digest({ docAuthorityId, projectId, opId: request.opId })}`;
      await checkPrincipal(principal, projectId);
      return order.transact(projectId, async scope => {
        await checkPrincipal(principal, projectId);
        const prior = history.get(projectId, request.opId);
        if (prior && prior.requestIdentity !== requestIdentity) throw historyError('operation-id-mismatch');
        const spec = prior ? history.verifyPrepared(prior) : await prepare({ requestId, docAuthorityId, requestIdentity });
        if (!spec) return null;
        // verifyPrepared includes derived fields; submit expects the exact original input.
        const { v, projectRev, before, after, changes, dependencies, ...input } = spec;
        // This adapter's specifications have no caller-defined dependencies; history derives them.
        const submission = prior ? input : spec;
        active.set(requestId, principal);
        try {
          const operation = await scope.submit(submission);
          ready.add(projectId);
          const result = { operation, duplicate: Boolean(prior) };
          committed?.(result); // visible reply/broadcast precede the next fence's completion under the same lock
          return result;
        } finally { active.delete(requestId); }
      });
    },
    fence: value => order.fence(value),
    idle: () => order.idle(),
    history,
  };
}
