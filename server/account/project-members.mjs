import { accountError } from './client.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const accountOK = id => typeof id === 'string' && /^acc_[a-f0-9]{24}$/.test(id);
const nameOf = name => typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\u0000-\u001f]/.test(name) ? name : null;

/** Fresh authorization followed by a synchronous, whitelist-only projection.
 * getConnections must expose the real doc service registry, never public claims.
 * This display snapshot neither grants access nor substitutes for a fence receipt.
 */
export function createProjectMembers({ ledger, authority, getConnections }) {
  if (!ledger || typeof authority?.authorizePrincipal !== 'function' || typeof getConnections !== 'function') fail(503, 'members-unavailable');
  return async function membersSnapshot(actor, body) {
    if (!body || Object.keys(body).some(key => key !== 'projectId') || !/^sp_[a-z2-7]{26}$/.test(body.projectId ?? '')) fail(400, 'invalid-project');
    const principal = await authority.authorizePrincipal(actor, { projectId: body.projectId, action: 'read' });
    // No await from this point until the entire projection has been copied.
    const state = ledger.read(), project = state.projects[body.projectId];
    if (!project || project.status !== 'active' || principal.projectId !== body.projectId || principal.authorityId !== ledger.authorityId ||
        principal.accessRevision !== project.accessRevision || principal.revocationSeq !== state.accessHead) fail(503, 'members-changed');
    const connections = getConnections();
    if (!Array.isArray(connections)) fail(503, 'members-unavailable');
    const names = new Map(), groups = new Map();
    for (const connection of connections) {
      const p = connection?.principal;
      if (!connection.transport || connection.detached || p?.realm !== 'account' || p.identityVersion !== 2 ||
          p.tenantId !== project.projectId || !accountOK(p.accountId) || !['page', 'agent', 'render'].includes(p.role) ||
          typeof p.deviceId !== 'string' || !p.deviceId || project.bans[p.accountId] ||
          !project.members[p.accountId] || state.revokedLogins[`login:${p.loginId}`]) continue;
      const name = nameOf(p.accountName);
      if (name && p.role === 'page') names.set(p.accountId, name);
      const key = `${p.accountId}\n${p.deviceId}`;
      if (!groups.has(key)) groups.set(key, { accountId: p.accountId, accountName: name,
        deviceId: p.deviceId, deviceName: nameOf(p.deviceName) ?? p.deviceId,
        creator: p.accountId === project.creatorAccountId, conns: [] });
      const conn = { role: p.role };
      if (['agent', 'render'].includes(p.service)) conn.service = p.service;
      if ((typeof p.conversation === 'string' && p.conversation.length <= 200) ||
          (Number.isSafeInteger(p.conversation) && p.conversation >= 0)) conn.conversation = p.conversation;
      groups.get(key).conns.push(conn);
    }
    const members = Object.entries(project.members).map(([accountId, record]) => ({ accountId,
      accountName: names.get(accountId) ?? nameOf(record.accountNameAtJoin), access: record.access,
      joinedAt: record.joinedAt ?? null }));
    const devices = [...groups.values()].map(row => ({ ...row, accountName: names.get(row.accountId) ??
      nameOf(project.members[row.accountId]?.accountNameAtJoin) ?? row.accountName }));
    const creator = principal.accountId === project.creatorAccountId && principal.role === 'page';
    return { v: 2, authorityId: ledger.authorityId, projectId: project.projectId, accessRevision: project.accessRevision,
      self: { accountId: principal.accountId, creator, access: principal.access }, creatorAccountId: project.creatorAccountId,
      allowLinkJoin: project.allowLinkJoin, members, devices,
      ...(creator ? { bans: Object.entries(project.bans).map(([accountId, ban]) => ({ accountId,
        accountName: nameOf(ban.accountNameAtJoin), reason: 'kick' })) } : {}) };
  };
}
