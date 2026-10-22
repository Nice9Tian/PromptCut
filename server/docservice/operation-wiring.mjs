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
    if (principal.scope === 'service' && principal.service === 'render' && principal.role === 'render' &&
        !runFields.some(key => principal[key] !== undefined)) {
      if (action !== 'read') throw historyError('operation-forbidden', 403);
      const verified = await authority.checkAccess({ principal, projectId, action });
      if (verified?.allowed !== true) throw historyError('operation-forbidden', 403);
      order.assertUnfenced({ projectId, actor: principal });
      return { allowed: true, ...verified };
    }
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
    return { allowed: true, ...verified };
  }
  /** 改密退出撤回（`server/account/logout-rollback.mjs`）的补偿操作不借任何登录：每一步都回账本核对这确实是一次
   * 「改密码后选了退出」、那些旧登录确实都作废了，写入身份只有那个账号和那次事件。 */
  function checkRollback(principal, operation = null) {
    const event = typeof authority.logoutRollbackEvent === 'function' ? authority.logoutRollbackEvent(principal.eventId) : null;
    if (!event || event.accountId !== principal.accountId) throw historyError('operation-forbidden', 403);
    if (operation && (operation.actor?.rollbackEventId !== principal.eventId || operation.actor?.accountId !== principal.accountId ||
        operation.actor?.loginId !== undefined)) throw historyError('operation-forbidden', 403);
    return { eventId: principal.eventId, accountId: principal.accountId };
  }
  const order = createPasswordOrder({ history, account, verifyWitness, docAttestationPrivateKey, failpoint, initializeProject,
    async checkGate({ operation }) {
      const principal = active.get(operation.requestId);
      if (!principal) throw historyError('operation-forbidden', 403);
      if (principal.kind === 'logout-rollback') return { allowed: true, rollbackGrant: checkRollback(principal, operation) };
      const result = await checkPrincipal(principal, operation.projectId);
      if ((result.retainedGrant || result.activeGrant) && !docAttestationPrivateKey) throw historyError('run-provider-unavailable', 503);
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
      // 请求身份里不放访问凭证号(`credentialId`):它跟着访问令牌走,同一次登录每续一次令牌就换一个(约两分钟一次)。
      // 页面断线重连、到期前换会话之后重发同一条提交(同 opId、同内容)时令牌多半刚续过,把凭证号算进去会把这次重发判成
      // 「另一个人拿同一个 opId 提交」而拒掉,其实那一条早已落地。账号、登录、登录代数、设备、页面会话仍在身份里:
      // 换了人、换了登录、换了内容照旧判 mismatch。落地时的署名与审计记录不受影响(记的是第一次被接受时的完整身份,含凭证号)。
      // 也不放期望版本(`expectRev`):它是这一次投递的前置条件,不是提交的内容。页面断线重连后重发没确认的提交时,第一条会带上
      // 期望版本(离线批次的版本核对),而它第一次发出去时没带;那一条如果其实早已落地,应当按重复提交认 ——
      // 「同一 opId 已落地过:直接回当初的版本,这一步先于 expectRev 检查」(`modules/project.mjs` 文件头的约定)。
      const { credentialId: _rotating, ...stableActor } = actor && typeof actor === 'object' ? actor : {};
      const { expectRev: _precondition, ...stableRequest } = request && typeof request === 'object' ? request : {};
      const requestIdentity = digest({ projectId, actor: actor && typeof actor === 'object' ? stableActor : actor,
        request: request && typeof request === 'object' ? stableRequest : request });
      // 这一版之前落地的提交记的是带凭证号的旧算法:同一张令牌下的重发照旧认
      const legacyIdentity = digest({ projectId, actor, request });
      const sameRequest = recorded => recorded === requestIdentity || recorded === legacyIdentity;
      const requestId = `project-op:${digest({ docAuthorityId, projectId, opId: request.opId })}`;
      const entryVerified = await checkPrincipal(principal, projectId);
      if (entryVerified?.credentialId && actor?.credentialId && actor.credentialId !== entryVerified.credentialId) {
        actor.credentialId = entryVerified.credentialId;
      }
      const retry = history.get(projectId, request.opId);
      if (retry) {
        history.verifyPrepared(retry);
        if (retry.requestId !== requestId || !sameRequest(retry.requestIdentity)) throw historyError('operation-id-mismatch');
      }
      return order.transact(projectId, async scope => {
        await checkPrincipal(principal, projectId);
        const prior = history.get(projectId, request.opId);
        if (prior && !sameRequest(prior.requestIdentity)) throw historyError('operation-id-mismatch');
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
      }, { resumeOpId: retry?.opId });
    },
    /**
     * 文档服务自己发起的补偿操作（现在只有改密退出撤回）。走同一把项目锁、同一条有序提交和同一份操作历史，
     * 但不经页面连接：`principal` 是 `{ kind: 'logout-rollback', eventId, accountId }`，每一步都回账本核对（`checkRollback`）。
     * 同一个 `opId` 重来：已落地的回 `duplicate`；没定序就被作废了的回 `cancelled`（调用方换下一个号重算）。
     * `prepare` 回 null 表示这一次没有要落地的东西。
     */
    async executeSystem({ projectId, principal, opId }, prepare, committed) {
      if (principal?.kind !== 'logout-rollback' || typeof principal.eventId !== 'string' || typeof principal.accountId !== 'string' ||
          typeof opId !== 'string' || !opId || opId.length > 128) throw historyError('operation-forbidden', 403);
      const requestId = `project-op:${digest({ docAuthorityId, projectId, opId })}`;
      const requestIdentity = digest({ projectId, system: { kind: principal.kind, eventId: principal.eventId, accountId: principal.accountId }, opId });
      checkRollback(principal);
      return order.transact(projectId, async scope => {
        checkRollback(principal);
        const prior = history.get(projectId, opId);
        if (prior) {
          history.verifyPrepared(prior);
          if (prior.requestIdentity !== requestIdentity || prior.requestId !== requestId) throw historyError('operation-id-mismatch');
          if (prior.state === 'cancelled') return { operation: prior, cancelled: true };
        }
        const spec = prior ? history.verifyPrepared(prior) : await prepare({ requestId, docAuthorityId, requestIdentity });
        if (!spec) return null;
        const { v, projectRev, before, after, changes, dependencies, ...input } = spec;
        active.set(requestId, principal);
        try {
          const operation = await scope.submit(prior ? input : spec);
          ready.add(projectId);
          const result = { operation, duplicate: Boolean(prior) };
          committed?.(result);
          return result;
        } finally { active.delete(requestId); }
      });
    },
    /** 改密退出撤回一个项目：交给绑在这里的项目模块（它有内容、频道和在线连接）。 */
    rollback: input => {
      const adapter = requireTarget();
      if (typeof adapter.rollback !== 'function') throw historyError('projection-unavailable', 503);
      return adapter.rollback(input);
    },
    fence: value => order.fence(value),
    idle: () => order.idle(),
    history,
  };
}
