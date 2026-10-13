/** Trusted v2 doc assembly. One coordinator is bound to each tenant's real project
 * module; neither a request body nor the old LAN store supplies an authority. */
import path from 'node:path';
import { createPublicKey, createPrivateKey } from 'node:crypto';
import { isProjectId } from '../auth/protocol.mjs';
import { openOperationHistory, historyError } from '../docservice/modules/operation-history.mjs';
import { createOperationWiring, createDurableProjectProjection } from '../docservice/operation-wiring.mjs';
import { mountSelection } from '../docservice/modules/selection.mjs';
import { createAccountOrderClient, createWitnessVerifier, signDocProof } from '../account/password-order.mjs';
import { createAssetMtlsTransport } from './asset-doc-client.mjs';
import { describeRunMedia, materializeRunMedia } from './media-selector.mjs';
import { digestOf } from '../account/ledger.mjs';

export function createDocAssembly({ dataDir, authority, account, runProvider = null,
  now = Date.now, onFenceRequested, acknowledgeFence,
  resolveTierAssetRef, contentTypeForExt } = {}) {
  if (!dataDir || !authority?.checkAccess || !authority.authorityId || !account?.order?.witnessKeys)
    throw historyError('doc-assembly-configuration', 503);
  // Validate the public key configuration before opening any persistent history.
  const keys = new Map();
  for (const [id, value] of Object.entries(account.order.witnessKeys)) {
    if (!id || id.length > 128) throw historyError('doc-assembly-configuration', 503);
    const key = value?.type === 'public' ? value : createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') throw historyError('doc-assembly-configuration', 503);
    keys.set(id, key);
  }
  if (!keys.size) throw historyError('doc-assembly-configuration', 503);
  const attestationKey = account.order.docAttestationPrivateKey?.type === 'private' ? account.order.docAttestationPrivateKey :
    createPrivateKey(account.order.docAttestationPrivateKey);
  if (attestationKey.asymmetricKeyType !== 'ed25519') throw historyError('doc-assembly-configuration', 503);
  // Reuse the tested TLS1.3/CA/pin implementation, with the doc's own credential.
  // This connection talks to account order, not to the asset authority endpoint.
  const transport = createAssetMtlsTransport({ origin: account.origin, tls: account.clientTls,
    serverFingerprint256: account.serverFingerprint256 });
  const client = createAccountOrderClient({ request: async ({ method, path: route, body }) => {
    try { return await transport.request(method, route, body); }
    catch (error) {
      if (error.code === 'asset-authority-unavailable') throw historyError('order-unavailable', 503);
      throw error;
    }
  } });
  const verifyWitness = createWitnessVerifier({ keys, issuer: account.order.issuer });
  let history;
  try { history = openOperationHistory(path.join(dataDir, 'operation-history-v2.sqlite')); }
  catch (error) { transport.close(); throw error; }
  const coordinators = new Map(), selections = new Map();
  let closed = false, closing = null, tenantResolver = null;
  const requireOpen = () => { if (closed) throw historyError('doc-assembly-unavailable', 503); };
  const ensureTenant = space => {
    requireOpen();
    if (!isProjectId(space)) throw historyError('projection-unavailable', 503);
    if (!coordinators.has(space)) tenantResolver?.(space);
    const coordinator = coordinators.get(space);
    if (!coordinator) throw historyError('projection-unavailable', 503);
    return coordinator;
  };
  const trustedRuns = {
    async checkAccess(input) {
      requireOpen();
      if (typeof runProvider?.checkAccess !== 'function') throw historyError('run-authority-unavailable', 503);
      return runProvider.checkAccess(input);
    },
    async authorizeQuery(input) {
      requireOpen();
      if (typeof runProvider?.authorizeQuery !== 'function') throw historyError('run-authority-unavailable', 503);
      const result = await runProvider.authorizeQuery(input);
      // Query reads the same recovered projection as project.open; an accepted
      // operation not materialized before a crash cannot leave selections on an old rev.
      await ensureTenant(input.projectId).read(input.projectId, input.principal, () => undefined, 'read');
      return result;
    },
  };
  return {
    history,
    runProvider: trustedRuns,
    bindTenantResolver(resolve) {
      requireOpen();
      if (tenantResolver || typeof resolve !== 'function') throw historyError('projection-unavailable', 503);
      tenantResolver = resolve;
    },
    async captureSnapshot({ principal, projectId, selectionInput } = {}) {
      if (!selectionInput || Object.keys(selectionInput).length !== 1 ||
        typeof selectionInput.pageId !== 'string' || principal?.projectId !== projectId)
        throw historyError('invalid-authority-claim', 400);
      ensureTenant(projectId);
      const selection = selections.get(projectId);
      if (!selection) throw historyError('selection-unavailable', 503);
      return selection.captureSnapshot({ principal: { ...principal, tenantId: projectId },
        projectId, pageId: selectionInput.pageId });
    },
    async resolveRunMedia({ principal, projectId, purpose, selector, action = 'read' } = {}) {
      requireOpen();
      if (principal?.realm !== 'account' || principal.role !== 'agent' ||
          principal.projectId !== projectId || !isProjectId(projectId))
        throw historyError('run-asset-project-forbidden', 403);
      const coordinator = ensureTenant(projectId);
      const describe = () => describeRunMedia({ snapshot: history.snapshot(projectId), projectId, purpose, selector });
      // Each read recovers and authorizes within the existing project order lock.
      // Physical tier metadata is queried between them, outside that lock.
      // 核权限用这次请求签的那个动作。导入的请求签的是「写」：按「读」去核，对不上这次请求的签名，会被实例登记那一层拒掉
      //（真实的 Agent、文档服务、素材服务第一次连起来才暴露；各自的单测里对方都是受控的）。
      if (!['read', 'write'].includes(action)) throw historyError('run-asset-project-forbidden', 403);
      const first = await coordinator.read(projectId, principal, describe, action);
      const selected = await materializeRunMedia(first, { resolveTierAssetRef, contentTypeForExt });
      const second = await coordinator.read(projectId, principal, describe, action);
      if (digestOf(first) !== digestOf(second)) throw historyError('stale-media-ref', 409);
      return selected;
    },
    coordinatorForSpace({ space, store, directory }) {
      requireOpen();
      if (!isProjectId(space)) return undefined; // local/LAN v1 keeps its existing path.
      if (coordinators.has(space)) throw historyError('coordinator-already-bound', 503);
      const expected = path.resolve(dataDir, 'tenants', space);
      if (typeof directory !== 'string' || path.resolve(directory) !== expected)
        throw historyError('projection-unavailable', 503);
      const coordinator = createOperationWiring({ history, account: client, verifyWitness, authority,
        projection: createDurableProjectProjection({ store, directory: expected }),
        docAuthorityId: authority.authorityId, runProvider: trustedRuns,
        docAttestationPrivateKey: attestationKey,
        onFenceRequested, acknowledgeFence });
      coordinators.set(space, coordinator); return coordinator;
    },
    selectionForSpace({ space, project }) {
      requireOpen();
      const selection = mountSelection({ project,
        checkAccess: input => authority.checkAccess(input),
        authorizeQuery: input => trustedRuns.authorizeQuery(input), now });
      selections.set(space, selection); return selection;
    },
    async fence(value) {
      requireOpen();
      return ensureTenant(value?.projectId).fence(value);
    },
    /** 退出确认用：把这些旧登录还没走完的操作各自办结（定序的落地、没定序的作废），再报它们在各项目里停在哪。
     * `pendingSeals` 不是 0 就是还有操作没办结（例如保留下来继续跑的共有任务正好在提交一步），调用方过一会儿再问。 */
    async settleLogins(loginIds) {
      requireOpen();
      const open = op => ['prepared', 'reserved', 'accepted'].includes(op.state);
      for (const projectId of new Set(history.byLogins(loginIds).filter(open).map(op => op.projectId))) {
        try { await ensureTenant(projectId).recover(projectId); } catch (error) { if (error.status !== 503 && error.code !== 'pending-operation') throw error; }
      }
      const rows = history.byLogins(loginIds), sealed = op => Number.isSafeInteger(op.witness?.orderSeq) && ['accepted', 'materialized'].includes(op.state);
      const last = list => list.filter(sealed).reduce((max, op) => Math.max(max, op.witness.orderSeq), 0);
      return { pendingSeals: rows.filter(open).length,
        projectCursors: [...new Set(rows.map(op => op.projectId))].sort().map(projectId => {
          const mine = rows.filter(op => op.projectId === projectId);
          return { projectId, projectRev: mine[0].currentProjectRev, lastAcceptedOrderSeq: last(mine) };
        }),
        lastAcceptedOrderSeq: Object.fromEntries(loginIds.map(loginId => [loginId, last(rows.filter(op => op.actor.loginId === loginId))])) };
    },
    /** 向账号服务登记「这次退出到此为止」的顺序见证。证明由文档服务的证明钥签；同一个请求号重发得到同一份见证。 */
    async sealLogout({ eventId, requestId, proof }) {
      requireOpen();
      const signed = signDocProof({ ...proof, v: 1, domain: 'promptcut.logout-order', eventId, requestId, docAuthorityId: authority.authorityId }, attestationKey);
      const witness = verifyWitness(await client.logoutComplete({ eventId, requestId, proof: signed }));
      if (witness.kind !== 'logout-complete' || witness.state !== 'sealed' || witness.eventId !== eventId || witness.requestId !== requestId)
        throw historyError('bad-witness', 403);
      return { proof: signed, witness };
    },
    async close() {
      if (closing) return closing;
      // The caller first closes the real doc connections. In-flight submission and
      // recovery must finish before SQLite and the authenticated order transport close.
      closing = (async () => {
        await Promise.all([...coordinators.values()].map(value => value.idle()));
        closed = true;
        transport.close(); history.close(); selections.clear(); coordinators.clear();
      })();
      return closing;
    },
  };
}
