/** Project-wide live selections. Only connection principals and an owner-supplied
 * authority callback can name members or authorize a run. Nothing here is durable.
 */

export const SELECTION_MODULE = 'selection';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const empty = () => ({ clipIds: [] });
const error = (status, code) => Object.assign(new Error(code), { status, code });
const validId = value => typeof value === 'string' && ID.test(value);
const clone = value => structuredClone(value);

function selectionOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.clipIds) ||
      value.clipIds.length > 256 || value.clipIds.some(id => !validId(id)) ||
      new Set(value.clipIds).size !== value.clipIds.length) throw error(400, 'invalid-selection');
  let range;
  if (value.range !== undefined) {
    range = value.range;
    if (!range || typeof range !== 'object' || Array.isArray(range) ||
        !Number.isFinite(range.start) || !Number.isFinite(range.end) ||
        range.start < 0 || range.end < range.start) throw error(400, 'invalid-selection');
  }
  const result = { clipIds: [...value.clipIds], ...(range ? { range: { start: range.start, end: range.end } } : {}) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16 * 1024) throw error(413, 'selection-too-large');
  return result;
}

function nameOf(principal) {
  const value = principal?.accountName ?? principal?.username;
  return typeof value === 'string' && value.trim() ? value.trim() : principal.accountId;
}

function clipsOf(project) {
  const clips = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (typeof clip?.id === 'string' && !clips.has(clip.id)) clips.set(clip.id, { trackId: track.id, clip });
    }
  }
  return clips;
}

/**
 * @param {object} options
 * @param {{bodyOf(projectId:string):object|null,revOf(projectId:string):number}} options.project
 * @param {(input:{principal:object,projectId:string,action:'read'|'write'})=>Promise<object|boolean>} options.checkAccess
 *   Must reverify live account credentials and the current account/access head, not cached admission.
 * @param {(input:{principal:object,projectId:string,runGrantId:string})=>Promise<object>} options.authorizeQuery
 *   Must verify the Agent service identity, project-scoped current/retained runGrant,
 *   actual initiator and the persisted message's selectionSnapshot. No client snapshot fallback.
 */
export function mountSelection({ project, checkAccess, authorizeQuery, now = Date.now } = {}) {
  if (typeof project?.bodyOf !== 'function' || typeof project?.revOf !== 'function' ||
      typeof checkAccess !== 'function' || typeof authorizeQuery !== 'function')
    throw new TypeError('selection authority and project providers are required');
  const principals = new Map();
  const blocked = new Set();
  /** projectId -> connId -> page record */
  const projects = new Map();
  const revisions = new Map();
  const clock = () => now();
  const bump = projectId => revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1);
  const listOf = projectId => {
    let list = projects.get(projectId);
    if (!list) { list = new Map(); projects.set(projectId, list); }
    return list;
  };
  const remove = (projectId, connId) => {
    const list = projects.get(projectId);
    if (!list?.delete(connId)) return false;
    if (!list.size) projects.delete(projectId);
    bump(projectId);
    return true;
  };
  const pagePrincipal = (principal, projectId) => principal?.role === 'page' && !principal.service &&
    typeof principal.accountId === 'string' && principal.accountId && principal.tenantId === projectId;
  async function checked(principal, projectId, action) {
    if (!pagePrincipal(principal, projectId)) throw error(403, 'forbidden');
    const answer = await checkAccess({ principal, projectId, action });
    if (!answer) throw error(403, 'forbidden');
    if (answer === true) return principal;
    if (answer.accountId !== principal.accountId || answer.projectId !== projectId) throw error(403, 'principal-mismatch');
    return { ...principal, accountName: answer.accountName ?? principal.accountName };
  }
  const messageId = msg => msg?.requestId ?? msg?.reqId;
  const reply = (ctx, connId, msg, requestId) => ctx.send(connId,
    requestId === undefined ? msg : { ...msg, reqId: requestId });

  async function set(ctx, connId, msg) {
    const principal = principals.get(connId);
    if (!validId(msg.projectId) || !validId(msg.pageId) ||
        !Number.isSafeInteger(msg.revision) || msg.revision < 0) throw error(400, 'invalid-selection');
    const selection = selectionOf(msg.selection);
    const current = await checked(principal, msg.projectId, 'write');
    if (!principals.has(connId) || blocked.has(connId)) throw error(403, 'connection-closed');
    const list = listOf(msg.projectId);
    const previous = list.get(connId);
    if (previous?.pageId === msg.pageId && msg.revision <= previous.selectionRevision) {
      return reply(ctx, connId, { type: 'selection.ok', projectId: msg.projectId,
        pageId: msg.pageId, selectionRevision: previous.selectionRevision,
        presenceRevision: revisions.get(msg.projectId) ?? 0, duplicate: true }, messageId(msg));
    }
    list.set(connId, { connId, principal: current, pageId: msg.pageId, selection,
      selectionRevision: msg.revision, serverReceivedAt: clock() });
    bump(msg.projectId);
    reply(ctx, connId, { type: 'selection.ok', projectId: msg.projectId, pageId: msg.pageId,
      selectionRevision: msg.revision, presenceRevision: revisions.get(msg.projectId) }, messageId(msg));
  }

  async function clear(ctx, connId, msg) {
    const principal = principals.get(connId);
    if (!validId(msg.projectId) || !validId(msg.pageId)) throw error(400, 'invalid-selection');
    const current = await checked(principal, msg.projectId, 'write');
    if (!principals.has(connId) || blocked.has(connId)) throw error(403, 'connection-closed');
    const existing = listOf(msg.projectId).get(connId);
    if (existing && existing.pageId !== msg.pageId) throw error(403, 'page-mismatch');
    listOf(msg.projectId).set(connId, { ...(existing ?? { connId, selectionRevision: 0 }),
      principal: current, pageId: msg.pageId, selection: empty(), serverReceivedAt: clock() });
    bump(msg.projectId);
    reply(ctx, connId, { type: 'selection.ok', projectId: msg.projectId, pageId: msg.pageId,
      selectionRevision: existing?.selectionRevision ?? 0, presenceRevision: revisions.get(msg.projectId) }, messageId(msg));
  }

  async function querySelections({ principal, projectId, runGrantId } = {}) {
    if (!validId(projectId) || typeof runGrantId !== 'string' || !runGrantId ||
        principal?.service !== 'agent' || principal?.tenantId !== projectId) throw error(403, 'forbidden');
    const grant = await authorizeQuery({ principal, projectId, runGrantId });
    if (!grant || typeof grant.initiatorAccountId !== 'string' || !grant.initiatorAccountId ||
        grant.projectId !== projectId || grant.runGrantId !== runGrantId) throw error(403, 'run-grant-invalid');
    const initiator = grant.initiatorAccountId;
    const live = [...(projects.get(projectId)?.values() ?? [])];
    const valid = [];
    for (const entry of live) {
      if (blocked.has(entry.connId) || projects.get(projectId)?.get(entry.connId) !== entry) continue;
      try {
        const current = await checked(entry.principal, projectId, 'read');
        if (projects.get(projectId)?.get(entry.connId) === entry) valid.push({ record: entry, principal: current });
      } catch (cause) {
        if (cause?.status !== 403) throw error(503, 'authority-unavailable');
        remove(projectId, entry.connId);
      }
    }
    const projectRev = project.revOf(projectId);
    const clipMap = clipsOf(project.bodyOf(projectId));
    const itemsOf = selection => selection.clipIds.map(id => {
      const found = clipMap.get(id);
      return found ? { id, trackId: found.trackId, clip: clone(found.clip) } : { id, missing: true };
    });
    const members = new Map();
    for (const { record: entry, principal } of valid) {
      if (blocked.has(entry.connId) || projects.get(projectId)?.get(entry.connId) !== entry) continue;
      const accountId = principal.accountId;
      let member = members.get(accountId);
      if (!member) {
        const username = nameOf(principal);
        member = { accountId, username, isInitiator: accountId === initiator,
          displayName: accountId === initiator ? `${username}（当前用户）` : username, pages: [] };
        members.set(accountId, member);
      }
      member.pages.push({ pageId: entry.pageId, selection: clone(entry.selection),
        selectionRevision: Math.max(0, entry.selectionRevision), items: itemsOf(entry.selection), live: true });
    }
    const snapshot = grant.selectionSnapshot;
    if (!members.has(initiator) && snapshot !== undefined) {
      if (!snapshot || snapshot.source !== 'sent-snapshot' || snapshot.projectId !== projectId ||
          snapshot.accountId !== initiator || !validId(snapshot.pageId) || !Number.isFinite(snapshot.sentAt))
        throw error(403, 'snapshot-invalid');
      const selection = selectionOf(snapshot.selection);
      const username = typeof grant.initiatorName === 'string' && grant.initiatorName.trim()
        ? grant.initiatorName.trim() : initiator;
      members.set(initiator, { accountId: initiator, username, isInitiator: true,
        displayName: `${username}（当前用户）`, pages: [{ pageId: snapshot.pageId, selection,
          selectionRevision: null, items: itemsOf(selection), live: false, source: 'sent-snapshot',
          sentAt: snapshot.sentAt, note: '发消息时的选区，非实时' }] });
    }
    return { projectId, projectRev, presenceRevision: revisions.get(projectId) ?? 0,
      members: [...members.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)), queriedAt: clock() };
  }

  async function handle(ctx, connId, msg) {
    try {
      if (msg.type === 'selection.set') return await set(ctx, connId, msg);
      if (msg.type === 'selection.clear') return await clear(ctx, connId, msg);
      if (msg.type === 'selection.query') {
        if (msg.initiatorAccountId !== undefined || msg.selectionSnapshot !== undefined || msg.username !== undefined)
          throw error(400, 'invalid-authority-claim');
        const result = await querySelections({ principal: principals.get(connId), projectId: msg.projectId,
          runGrantId: msg.runGrantId });
        return reply(ctx, connId, { type: 'selection.state', ...result }, messageId(msg));
      }
      throw error(400, 'unsupported');
    } catch (cause) {
      reply(ctx, connId, { type: 'error', reason: cause?.code ?? 'authority-unavailable' }, messageId(msg));
    }
  }

  return {
    name: SELECTION_MODULE, types: ['selection.'],
    connect(_ctx, connId, principal) {
      blocked.delete(connId);
      principals.set(connId, { ...principal });
      if (!pagePrincipal(principal, principal?.tenantId)) return;
      const projectId = principal.tenantId;
      listOf(projectId).set(connId, { connId, principal: { ...principal },
        pageId: `connection:${connId}`, selection: empty(), selectionRevision: 0, serverReceivedAt: clock() });
      bump(projectId);
    },
    disconnect(_ctx, connId) {
      principals.delete(connId);
      blocked.delete(connId);
      for (const projectId of [...projects.keys()]) remove(projectId, connId);
    },
    handle,
    querySelections,
    revoke({ projectId, accountId, loginId } = {}) {
      if (!validId(projectId)) return 0;
      let removed = 0;
      for (const entry of [...(projects.get(projectId)?.values() ?? [])]) {
        if (accountId && entry.principal.accountId !== accountId) continue;
        if (loginId && entry.principal.loginId !== loginId) continue;
        blocked.add(entry.connId);
        if (remove(projectId, entry.connId)) removed++;
      }
      return removed;
    },
    dropSpace(projectId) {
      for (const entry of projects.get(projectId)?.values() ?? []) blocked.add(entry.connId);
      projects.delete(projectId); revisions.delete(projectId);
    },
    describe() { return { projects: projects.size,
      pages: [...projects.values()].reduce((sum, entries) => sum + entries.size, 0) }; },
  };
}

export const createSelectionModule = mountSelection;
export default mountSelection;
