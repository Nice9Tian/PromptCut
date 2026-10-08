import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createAccountAuthority } from '../account/authority.mjs';
import { accountError } from '../account/client.mjs';
import { createFileStore, createMemoryStore, fileNameOf } from './store/index.mjs';
import { stateBlobName } from './modules/project.mjs';
import { offeredProtocols } from './auth.mjs';
import { AUTH_PREFIX, TICKET_PREFIX, TENANT_PREFIX, TOKEN_PREFIX, SERVICE_PREFIX } from '../auth/protocol.mjs';

const PREFIX = 'promptcut.account.';
const fail = (status, code) => { throw accountError(status, code); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Account v2 admission for a hosted document service. Tickets are random, kind-bound and
 * short-lived. Their server-side authorization reference is reverified at every entry.
 * Asset validation is exposed as a doc-side resolver for the separate mTLS access route.
 */
export function createAccountHostedRuntime({ ledger, accountClient, dataDir, authorityUrl, signingKey, keyId,
  now = Date.now, pollMs = 1000, onDiagnostic = () => {}, assetReadyProbe = null,
  assetInstanceId = null, allowFixtureAssetReady = false, runHooks = null,
  getRunProvider = () => null, onRunControl = null, onPageFence = null }) {
  if (!ledger || !accountClient) fail(503, 'account-configuration');
  if (typeof getRunProvider !== 'function' || (onRunControl !== null && typeof onRunControl !== 'function')) fail(503, 'run-authority-unavailable');
  if (assetReadyProbe !== null && typeof assetReadyProbe !== 'function') fail(503, 'asset-configuration');
  if (assetInstanceId !== null && (typeof assetInstanceId !== 'string' || !assetInstanceId)) fail(503, 'asset-configuration');
  if (allowFixtureAssetReady && assetReadyProbe) fail(503, 'asset-configuration');
  const tickets = new Map();
  const pageFences = new Map();
  const memoryStores = new Map();
  let service = null;
  let assetReady = false;
  async function requireAssetReady({ expectedInstanceId } = {}) {
    if (!assetReadyProbe) {
      if (allowFixtureAssetReady && assetReady) return { instanceId: 'fixture-asset', accessHead: authority.eventsSince(0).headSeq };
      fail(503, 'asset-unavailable');
    }
    try {
      await authority.synchronize();
      const before = authority.eventsSince(0).headSeq;
      const state = await assetReadyProbe({ authorityId: authority.authorityId, requiredAccessHead: before });
      await authority.synchronize();
      const after = authority.eventsSince(0).headSeq;
      if (!state || state.ok !== true || state.ready !== true || state.authorityId !== authority.authorityId ||
        typeof state.instanceId !== 'string' || !state.instanceId ||
        (assetInstanceId && state.instanceId !== assetInstanceId) ||
        (expectedInstanceId && state.instanceId !== expectedInstanceId) ||
        !Number.isSafeInteger(state.accessCursor) || !Number.isSafeInteger(state.accessHead) ||
        state.accessCursor !== before || state.accessHead !== before || after !== before) fail(503, 'asset-unavailable');
      assetReady = true;
      return { instanceId: state.instanceId, accessHead: after };
    } catch {
      assetReady = false;
      fail(503, 'asset-unavailable');
    }
  }
  const storeOf = projectId => dataDir ? createFileStore({ dir: path.join(dataDir, 'tenants', projectId), log: () => {} }) :
    (memoryStores.get(projectId) ?? memoryStores.set(projectId, createMemoryStore()).get(projectId));
  const authority = createAccountAuthority({ ledger, accountClient, authorityUrl, signingKey, keyId, now, pollMs, onDiagnostic, runHooks,
    async initializeProject({ projectId, initialProject }) {
      const store = storeOf(projectId);
      const body = initialProject ?? null;
      const digest = sha256(JSON.stringify(body));
      const snapshotName = stateBlobName(projectId);
      const existing = store.readBlob(snapshotName);
      if (existing !== null) {
        let saved;
        try { saved = JSON.parse(existing); } catch { fail(503, 'initialization-conflict'); }
        if (saved?.projectId !== projectId || saved?.rev !== 1 || sha256(JSON.stringify(saved.project)) !== digest) fail(503, 'initialization-conflict');
      } else {
        store.writeBlob(snapshotName, JSON.stringify({ v: 1, projectId, rev: 1, at: now(), project: body, writers: [], history: [], opIds: [] }));
      }
      const stream = `projects/${projectId}`;
      const records = store.read(stream);
      if (records.length && (records[0].projectId !== projectId || records[0].rev !== 1 || records[0].digest !== digest)) fail(503, 'initialization-conflict');
      if (!records.length) store.append(stream, { projectId, rev: 1, digest, actor: { userId: 'system:account-create' }, at: now() });
      if (dataDir) {
        const directory = path.join(dataDir, 'tenants', projectId, 'projects');
        for (const file of [path.join(directory, `${fileNameOf(projectId)}.ndjson`), path.join(directory, snapshotName.slice('projects/'.length))]) {
          const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        if (process.platform !== 'win32') { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      }
      return { contentId: sha256(`${projectId}\n${digest}`) };
    },
  });
  const issue = (kind, principal, deviceId, expiresAt) => {
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { kind, authorizationId: principal.authorizationId, projectId: principal.projectId,
      deviceId, expiresAt });
    return ticket;
  };
  async function resolve(ticket, kind) {
    const entry = tickets.get(ticket);
    if (!entry || entry.kind !== kind || entry.expiresAt <= now()) fail(401, 'ticket-expired');
    const checked = await authority.authorizePrincipal({ authorizationId: entry.authorizationId }, { projectId: entry.projectId });
    return { ...checked, deviceId: entry.deviceId, deviceName: entry.deviceId, userId: `account:${checked.accountId}@${entry.deviceId}`,
      tenantId: entry.projectId, scope: 'member', identityVersion: 2, realm: 'account', loginKind: checked.kind,
      projectAccessRevision: checked.accessRevision };
  }
  async function resolveRun(ticket) {
    const entry = tickets.get(ticket), provider = getRunProvider();
    if (!entry || entry.kind !== 'run' || entry.expiresAt <= now()) fail(401, 'ticket-expired');
    if (typeof provider?.resolveRunPrincipal !== 'function') fail(503, 'run-authority-unavailable');
    const principal = await provider.resolveRunPrincipal({ servicePrincipal: entry.servicePrincipal,
      projectId: entry.projectId, runGrantId: entry.runGrantId });
    const fields = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId', 'serviceKid',
      'accountId', 'loginId', 'credentialId', 'loginGeneration', 'instanceId', 'instanceGeneration'];
    if (fields.some(field => principal?.[field] !== entry.principal[field]) || principal?.creator !== false ||
        principal?.role !== 'agent' || principal?.serviceId !== 'agent') fail(403, 'run-binding-mismatch');
    if ((await provider.checkAccess({ principal, projectId: entry.projectId, action: 'read' }))?.allowed !== true)
      fail(403, 'run-revoked');
    return { ...principal, service: 'agent', tenantId: entry.projectId, scope: 'member',
      userId: `account:${principal.accountId}@run:${principal.runId}`, deviceId: principal.runId,
      deviceName: principal.runId, creator: false };
  }
  function ticketOf(req) {
    const list = offeredProtocols(req);
    const matching = list.filter(value => value.startsWith(PREFIX));
    if (matching.length !== 1 || list.some(value => [AUTH_PREFIX, TICKET_PREFIX, TENANT_PREFIX, TOKEN_PREFIX, SERVICE_PREFIX].some(prefix => value.startsWith(prefix)))) fail(401, 'account-ticket-required');
    return matching[0].slice(PREFIX.length);
  }
  const unsubscribe = authority.subscribeRevocations({}, async (event, committedControl) => {
    if (!service) return;
    // Start the page admission barrier synchronously, before any asynchronous run
    // delivery. The core barrier includes authenticating sockets and real close.
    if (!(event.service === 'agent' && event.enabled === false)) {
      const criteria = { roles: ['page'], ...(event.projectId ? { projectId: event.projectId } : {}),
        ...(event.loginIds?.length ? { loginIds: event.loginIds } : {}),
        ...(event.accountIds?.length ? { accountIds: event.accountIds } : {}) };
      if (criteria.projectId || criteria.loginIds || criteria.accountIds) {
        const closing = service.fencePrincipals(criteria).then(async receipt => {
          if (typeof onPageFence === 'function') await onPageFence({ event, receipt });
          return receipt;
        });
        pageFences.set(event.eventId, closing);
        // notify owns error diagnostics; this catch also prevents an unhandled
        // rejection while run control delivery is awaiting another resource.
        closing.catch(() => {});
      }
    }
    const runs = [];
    for (const conn of service.describe().conns) {
      const principal = conn.principal;
      if (principal?.realm !== 'account') continue;
      if (event.projectId && event.projectId !== principal.tenantId) continue;
      if (event.accountIds?.length && !event.accountIds.includes(principal.accountId)) continue;
      if (event.loginIds?.length && !event.loginIds.includes(principal.loginId)) continue;
      if (principal.role === 'agent' || principal.service === 'agent') { runs.push(conn); continue; }
      // Agent-off revokes tasks, not the member's page login/project membership.
      if (event.service === 'agent' && event.enabled === false) continue;
    }
    const provider = getRunProvider();
    let control = committedControl;
    try {
      if (typeof provider?.applyAccessEvent === 'function') control = await provider.applyAccessEvent(event);
      if (control && onRunControl) {
        for (const value of Array.isArray(control) ? control : [control]) await onRunControl(value);
      }
    } catch {
      await Promise.all(runs.map(conn => service.fenceConn(conn.connId, 4003, 'run-authority-unavailable')));
      throw accountError(503, 'run-authority-unavailable');
    }
    for (const conn of runs) {
      try {
        if (typeof provider?.checkAccess !== 'function') fail(503, 'run-authority-unavailable');
        const checked = await provider.checkAccess({ principal: conn.principal, projectId: conn.principal.tenantId, action: 'read' });
        if (checked?.allowed !== true || checked.retainedGrant?.state !== 'retained') fail(403, 'run-revoked');
      } catch { await service.fenceConn(conn.connId, 4003, 'access-revoked'); }
    }
    await pageFences.get(event.eventId);
  });
  return {
    authority,
    get sessionReady() { return assetReady; },
    setAssetReady(value) {
      if (!allowFixtureAssetReady) fail(503, 'asset-configuration');
      assetReady = value === true;
    },
    requireAssetReady,
    bindService(value) { service = value; },
    async pageFenceReceipt(eventId) { return pageFences.get(eventId) ?? null; },
    async start() { return authority.start(); },
    async issueSession({ principal, deviceId, expectedAssetInstanceId }) {
      await requireAssetReady({ expectedInstanceId: expectedAssetInstanceId });
      const expiresAt = Math.min(principal.expiresAt, now() + 5 * 60_000);
      if (expiresAt <= now()) fail(401, 'credential-revoked');
      for (const [ticket, entry] of tickets) if (entry.expiresAt <= now()) tickets.delete(ticket);
      return { connectionTicket: issue('conn', principal, deviceId, expiresAt),
        assetTicket: issue('asset', principal, deviceId, expiresAt),
        agentDelegationTicket: issue('agent', principal, deviceId, expiresAt), expiresAt };
    },
    async authenticate(req) {
      const ticket = ticketOf(req);
      return tickets.get(ticket)?.kind === 'run' ? resolveRun(ticket) : resolve(ticket, 'conn');
    },
    async issueRunTicket({ principal, servicePrincipal, purpose }) {
      if (purpose !== 'run' || principal?.creator !== false || principal?.role !== 'agent' ||
          principal?.serviceId !== 'agent' || principal?.servicePrincipal !== servicePrincipal) fail(403, 'run-binding-mismatch');
      // The current provider has no durable instance generation yet. Missing
      // registration is a deployment gap, never a default or an empty-resource ACK.
      if (typeof principal.instanceId !== 'string' || !principal.instanceId ||
          !Number.isSafeInteger(principal.instanceGeneration) || principal.instanceGeneration < 1)
        fail(503, 'run-instance-unavailable');
      const provider = getRunProvider();
      if ((await provider?.checkAccess?.({ principal, projectId: principal.projectId, action: 'read' }))?.allowed !== true)
        fail(403, 'run-revoked');
      const connectionTicket = randomBytes(32).toString('base64url'), expiresAt = now() + 5 * 60_000;
      tickets.set(connectionTicket, { kind: 'run', projectId: principal.projectId, runGrantId: principal.runGrantId,
        principal: structuredClone(principal), servicePrincipal: structuredClone(servicePrincipal), expiresAt });
      return { connectionTicket, expiresAt };
    },
    async resolveAssetTicket(ticket) { return resolve(ticket, 'asset'); },
    // Only the authenticated Agent mTLS RPC calls this resolver. A reference is
    // kind-bound and reverified, not a public accountId/authorizationId claim.
    async resolveAgentDelegation(ticket) { return resolve(ticket, 'agent'); },
    async gate(principal, type, msg) {
      if (principal?.realm !== 'account') return null;
      if (type.startsWith('shared.') || type === 'auth.ticket' || type.startsWith('hosted.') || type.startsWith('service.')) return 'forbidden';
      if (msg?.projectId !== undefined && msg.projectId !== principal.tenantId) return 'project-mismatch';
      if (type === 'selection.set' || type === 'selection.clear') {
        if (['username', 'accountName', 'accountId', 'principal', 'actor'].some(field => msg?.[field] !== undefined)) return 'invalid-authority-claim';
      }
      // Presence of a selection does not modify project content. Readonly members
      // publish their own live selection through the same read authority as open.
      const action = type === 'selection.set' || type === 'selection.clear' ? 'read' :
        /^(project\.op|project\.upload|project\.snapshot\.put|content\.put|events\.|presence\.(set|clear|send)|task\.|publisher\.|node\.)/.test(type) ? 'write' : 'read';
      try {
        if (principal.role === 'agent' || principal.service === 'agent') {
          const provider = getRunProvider();
          if (typeof provider?.checkAccess !== 'function') fail(503, 'run-authority-unavailable');
          const checked = await provider.checkAccess({ principal, projectId: principal.tenantId, action });
          if (checked?.allowed !== true) fail(403, 'run-revoked');
        } else await authority.checkAccess({ principal, projectId: principal.tenantId, action });
        return null;
      }
      catch (error) { return error?.code === 'account-unavailable' || error?.status === 503 ? 'authority-unavailable' : error?.code ?? 'forbidden'; }
    },
    async resumeGate(principal) {
      if (principal?.realm !== 'account') return null;
      try {
        if (principal.role === 'agent' || principal.service === 'agent') {
          const provider = getRunProvider();
          if (typeof provider?.checkAccess !== 'function') fail(503, 'run-authority-unavailable');
          if ((await provider.checkAccess({ principal, projectId: principal.tenantId, action: 'read' }))?.allowed !== true) fail(403, 'run-revoked');
        } else await authority.checkAccess({ principal, projectId: principal.tenantId, action: 'read' });
        return null;
      }
      catch (error) { return error?.code === 'account-unavailable' || error?.status === 503 ? 'authority-unavailable' : error?.code ?? 'forbidden'; }
    },
    close() { unsubscribe(); authority.close(); tickets.clear(); accountClient.close?.(); ledger.close?.(); },
  };
}
