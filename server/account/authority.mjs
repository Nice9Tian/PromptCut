import { randomUUID, sign, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { newProjectId } from '../auth/store.mjs';
import { validateAccountEvent, validateEventBatch, requireRequestId } from './protocol.mjs';
import { accountError } from './client.mjs';
import { canonicalJson, digestOf, appendAccessEvent } from './ledger.mjs';
import { rollbackEventOf } from './logout-rollback.mjs';
import { GUEST_LIMITS, guestExpired, guestPrincipal, guestProjectLimitReached, isGuestId, looksLikeGuestToken, readGuestToken, signGuestToken } from './guest.mjs';

/**
 * 主体编号：账号是 `acc_` + 24 位十六进制，游客是 `gst_` + 24 位（`guest.mjs`）。两种在成员名单、禁入表、
 * 权限判断里当同一类键用，只有「谁签发、谁核对」和限额不同，所以这里一并收。
 */
const accountIdOK = value => typeof value === 'string' && (/^acc_[a-f0-9]{24}$/.test(value) || isGuestId(value));
const projectIdOK = value => typeof value === 'string' && /^(?:sp_[a-z2-7]{26}|[A-Za-z0-9_-]{8,64})$/.test(value);
const services = ['asset', 'agent', 'render'];
/** 托管方服务下面有哪些子选项(与口令项目那条路 `auth/service-identity.mjs` 的 `HOSTED_OPTIONS` 同一份登记;这里不引它,账号这条路不依赖旧凭证存储的模块) */
export const HOSTED_OPTIONS = Object.freeze({ render: Object.freeze(['streams']), agent: Object.freeze([]) });
/** 账号项目的托管方服务状态里渲染节点那一项:开关(记录里是布尔,缺省关)与子选项「生成轨道流」(缺省关) */
export const accountRenderState = project => ({ enabled: project?.hosted?.render === true, streams: project?.hostedOptions?.render?.streams === true });
const reject = (status, code) => { throw accountError(status, code); };
const agentReadClosureComplete = (state, eventId, receipt) => {
  if (state.agentReadControlRequired !== true) return true;
  const event = state.accessEvents.find(e => e.eventId === eventId);
  const closure = state.agentReadAccessClosuresV1?.[eventId];
  return !!(event && closure && closure.payload?.source === 'doc-agent-read-control' &&
    closure.payload.complete === true && closure.payload.eventId === eventId &&
    closure.payload.accessSeq === event.seq && Array.isArray(closure.payload.controlIds) &&
    closure.payload.controlIds.length && closure.digest === digestOf(closure.payload) &&
    receipt?.agentReadClosureDigest === closure.digest);
};
const projectOf = (state, id) => {
  if (!projectIdOK(id)) reject(400, 'invalid-project');
  const project = state.projects[id];
  if (!project) reject(404, 'no-project');
  return project;
};
const active = project => {
  if (project.status === 'relocating') reject(409, 'relocating');
  if (project.status !== 'active') reject(404, 'no-project');
};
const permission = (project, accountId, action) => {
  active(project);
  if (Object.hasOwn(project.bans, accountId)) reject(403, 'banned');
  const creator = accountId === project.creatorAccountId;
  // 游客在别人的项目里只能查看(2026-10-23 用户定)。判在这一个口子上:名单里哪怕写着读写也按只读算,
  // 不指望每个调用方各记一遍。自己建的项目里他是创建者,照常读写
  const guestReadOnly = isGuestId(accountId) && !creator;
  const stored = creator ? 'rw' : project.members[accountId]?.access;
  const access = stored && guestReadOnly ? 'r' : stored;
  if (!access) reject(403, 'not-listed');
  if (action === 'write' && access !== 'rw') reject(403, guestReadOnly ? 'guest-read-only' : 'not-listed');
  return access;
};

/** 搬到云端时带上来的历史序号最多多大、提交摘要最多几条(与文档服务 `PROJECT_LIMITS.HISTORY` 同数) */
const IMPORTED_HISTORY_MAX = 1000;
const shortStrings = (value, maxItems, maxLength) => Array.isArray(value)
  ? value.filter(s => typeof s === 'string' && s.length <= maxLength).slice(0, maxItems) : [];
/**
 * 「搬到云端」带上来的本机提交摘要(本机 DocSync 记下的那几条):只留形状对、序号不超过起始历史序号、严格递增的,
 * 字段只留文档服务历史里用得上的那几样(`modules/project.mjs` 的 `staleDetail`)。写入身份一律记成导入,不信页面报的身份。
 */
export function importedHistory(history, initialRev) {
  if (!Array.isArray(history)) return [];
  const out = [];
  let last = 0;
  for (const entry of history.slice(-IMPORTED_HISTORY_MAX)) {
    if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.rev) || entry.rev <= last || entry.rev < 1 || entry.rev > initialRev) continue;
    last = entry.rev;
    out.push({ rev: entry.rev, ...(typeof entry.opId === 'string' && entry.opId.length <= 256 ? { opId: entry.opId } : {}),
      actor: { userId: 'system:account-import' }, at: Number.isFinite(entry.at) ? entry.at : null,
      paths: shortStrings(entry.paths, 32, 512), entities: shortStrings(entry.entities, 64, 256), imported: true });
  }
  return out;
}
/** 两段秘密(链接口令、二级密码的哈希)按固定时间比较;长度不同直接不等 */
const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};
const secondaryHash = (password, salt) => scryptSync(password, salt, 32).toString('base64url');
/** 项目二级密码最长几个字(只防超长输入拖慢哈希;不限字符种类) */
const SECONDARY_PASSWORD_MAX = 256;
/**
 * 这个账号还没输过项目二级密码的当前这一版:项目设了二级密码、他不是创建者、成员记录上的版本号与当前不符
 * (从没输过的——设密码之前进来的老成员、刚被通过的申请人——没有版本号;改过密码之后旧版本号也不算)。
 * 二级密码挡的是「进这个项目」,读成员名单也算:`/session`(`entryState`)与 `/members`(`project-members.mjs`)用这同一条判,
 * 不各写一份(两处给两种答案正是漏洞长出来的地方,2026-10-22 主会话定;`/join` 另在 `joinProject` 里凭密码核)。
 */
export const secondaryPasswordPending = (p, accountId) => !!p?.secondaryPassword && accountId !== p.creatorAccountId &&
  p.members?.[accountId]?.secondaryPasswordRev !== p.secondaryPassword.rev;

/**
 * 申请加入(2026-10-22 用户定,`docs/semantics/workflow/project.md`「多用户协作」):项目只放账号名单时,被名单挡住的账号可以发申请,
 * 创建者在成员浮层里「通过」「拒绝」。下面几个上限是三级机制的数(报告 `docs/reports/AGENT-claude-join-requests.md`「三级数字」):
 *   projectPending      一个项目同时挂着的申请最多几条;满了新申请回 429 `join-request-full`(创建者处理掉一条就又能收)
 *   accountProjectSends 同一个账号对同一个项目,任意连续 `windowMs` 里最多起几条新申请(被拒后可以再发);到数回 429 `join-request-limit`。
 *                       按时间窗数,不是一辈子的额度:「不提供输入账号名加人」,创建者没有别的办法把人拉进来,终身额度会让误拒几次的人永远进不来
 *   accountSends        同一个账号向这台文档服务上所有项目,任意连续 `windowMs` 里最多起几条新申请;到数回 429 `join-request-account-limit`
 *   windowMs            上面两个数的时间窗(滚动的 24 小时)。数的是「起了一条新申请」:已在等时再点、同一个请求号的重试都不算
 *   rejectedKept        每个项目留几条被拒的记录;超出按拒绝时间从旧到新删。被拒记录只是给申请人看「没有通过」、数时间窗用的,
 *                       不是凭据:删掉的那人看到的是「没申请过」,可以再发(要再有 `rejectedKept` 条更晚的拒绝才会轮到删它)
 */
export const JOIN_REQUEST_LIMITS = Object.freeze({ projectPending: 50, accountProjectSends: 3, accountSends: 20,
  windowMs: 24 * 60 * 60 * 1000, rejectedKept: 200 });
const validJoinRequestLimits = limits => limits !== null && typeof limits === 'object' &&
  ['projectPending', 'accountProjectSends', 'accountSends', 'windowMs', 'rejectedKept'].every(k => Number.isSafeInteger(limits[k]) && limits[k] >= 1);
/** 一条申请记录里,还落在时间窗里的那几次发起时刻(从早到晚) */
const recentSends = (record, at, limits) => (Array.isArray(record?.sends) ? record.sends : [])
  .filter(t => Number.isSafeInteger(t) && t > at - limits.windowMs).sort((x, y) => x - y);
const joinRequestIdOK = value => typeof value === 'string' && /^jr_[a-f0-9]{24}$/.test(value);
/** 账号名只按白名单收(与成员名单 `project-members.mjs` 的 `nameOf` 同一个口径);不合格记 null,界面显示账号号 */
const shownName = name => typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\u0000-\u001f]/.test(name) ? name : null;
/** 去掉一个账号在项目里的申请记录(换新对象,不原地删) */
const withoutJoinRequest = (requests, accountId) => {
  if (!requests || !Object.hasOwn(requests, accountId)) return requests;
  const { [accountId]: _gone, ...rest } = requests;
  return rest;
};
/** 被拒的记录最多留 `keep` 条:超出的按拒绝时间从旧到新删(挂着的申请不删) */
const pruneRejected = (requests, keep) => {
  const rejected = Object.entries(requests).filter(([, r]) => r?.state === 'rejected');
  if (rejected.length <= keep) return requests;
  rejected.sort((a, b) => (a[1].decidedAt ?? 0) - (b[1].decidedAt ?? 0));
  const drop = new Set(rejected.slice(0, rejected.length - keep).map(([accountId]) => accountId));
  return Object.fromEntries(Object.entries(requests).filter(([accountId]) => !drop.has(accountId)));
};
/**
 * 申请人自己看的那一份:只有自己这一条的状态、项目现在的进入方式、还能不能再发。不带别人的申请、不带成员名单、不带申请号。
 * `state`:`none` 没申请过(或记录已清)/ `pending` 等创建者 / `rejected` 被拒 / `member` 已经是成员(含刚被通过)。
 * `entry`:`list` 只放账号名单 / `link` 知道链接就能进。`canApply`:这个项目这边现在点「发送申请」会不会被收下
 * (项目只放名单、没在等、时间窗里的次数没用完;跨项目那个数不在这里算,超了由发申请时的 429 说明)。
 * 被时间窗挡住时另带 `retryAt`:最早什么时候能再发(毫秒时间戳,只由他自己发起的时刻算出)。
 */
export function joinRequestView(p, accountId, limits = JOIN_REQUEST_LIMITS, at = Date.now()) {
  const entry = p.allowLinkJoin ? 'link' : 'list';
  if (accountId === p.creatorAccountId || p.members?.[accountId]) return { state: 'member', entry, canApply: false };
  const record = p.joinRequests?.[accountId];
  const state = record?.state === 'pending' || record?.state === 'rejected' ? record.state : 'none';
  const recent = recentSends(record, at, limits);
  const spent = recent.length >= limits.accountProjectSends;
  return { state, entry, canApply: entry === 'list' && state !== 'pending' && !spent,
    ...(entry === 'list' && state !== 'pending' && spent ? { retryAt: recent[recent.length - limits.accountProjectSends] + limits.windowMs } : {}) };
}

/**
 * 「谁可以新建云端项目、每人能建多少」的判断口子（online-browser-task.md 第一步第 4 条）。
 * 调用方（`createProject`）只问这一个函数；以后要限制，改配置或换规则，不改调用方。〔裁：v18-fixes 子 Agent〕
 *
 * 配置 `createPolicy`（传给 `createAccountAuthority`，缺省 `{}`，缺省行为：登录了的账号都能建、不限数量）：
 *   - `maxProjectsPerAccount`：`null` / 不给 = 不限；非负整数 N = 一个账号名下（创建者是它、状态不是已删除）最多 N 个，
 *     已经有 N 个时第 N+1 个被拒，错误码 `project-limit-reached`（403）。0 等于谁都不能建。
 *   - `canCreate({ accountId, accountName, ownedCount, requestId })`：可选的自定义判断，回 `true` 放行；
 *     回 `false` 或 `{ code }` 拒绝，错误码取 `code`（缺省 `create-not-allowed`，403）。先于数量上限判。
 * 「要登录」不在这里：没有登录的账号过不了 `verify`，到不了这一步。
 */
export function checkCreateProject(policy, { accountId, accountName, ownedCount, requestId }) {
  // 游客自己建的项目有自己的上限(`guest.mjs` 的 `GUEST_LIMITS.projects`),不走下面那个可配的口子:
  // 这一条是游客身份自带的,不该因为某次部署忘了配就没了
  if (guestProjectLimitReached({ accountId, ownedCount })) reject(403, 'guest-project-limit');
  const max = policy?.maxProjectsPerAccount ?? null;
  if (typeof policy?.canCreate === 'function') {
    const verdict = policy.canCreate({ accountId, accountName, ownedCount, requestId });
    if (verdict !== true) reject(403, typeof verdict?.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(verdict.code) ? verdict.code : 'create-not-allowed');
  }
  if (max !== null && ownedCount >= max) reject(403, 'project-limit-reached');
}
const validCreatePolicy = policy => policy !== null && typeof policy === 'object' &&
  (policy.maxProjectsPerAccount === undefined || policy.maxProjectsPerAccount === null ||
    (Number.isSafeInteger(policy.maxProjectsPerAccount) && policy.maxProjectsPerAccount >= 0)) &&
  (policy.canCreate === undefined || typeof policy.canCreate === 'function');

/** Sole v2 cloud project authority. No LAN records, account passwords, or usable tokens on disk.
 * initializeProject must durably create the real doc/content snapshot before an active commit.
 * This factory is deliberately not mounted in the legacy shared service by itself.
 */
export function createAccountAuthority({ ledger, accountClient, initializeProject, authorityUrl,
  signingKey, keyId, now = Date.now, pollMs = 0, onDiagnostic = () => {}, getDocBarrier, verifyDocBarrier,
  runHooks = null, createPolicy = {}, joinRequestLimits = JOIN_REQUEST_LIMITS, guestKey = null }) {
  if (!validCreatePolicy(createPolicy)) reject(503, 'create-policy-configuration');
  if (!validJoinRequestLimits(joinRequestLimits)) reject(503, 'join-request-configuration');
  const limits = Object.freeze({ ...joinRequestLimits });
  if (runHooks !== null && typeof runHooks?.fenceInState !== 'function') reject(503, 'run-authority-unavailable');
  const refs = new Map(); const subscriptions = new Set(); const creating = new Map();
  const projectSubscriptions = new Set();
  let syncing = null, timer = null, closed = false, ready = false;
  const notifyProjectChanged = (projectId, op) => {
    for (const sub of projectSubscriptions) {
      try { sub(projectId, op); } catch { /* ignore */ }
    }
  };
  const notify = (event, control = null) => {
    if (event.type !== 'login-revoked' && !(event.type === 'project-access-changed' &&
      (event.accountIds?.length || (event.service === 'agent' && event.enabled === false)))) return;
    for (const entry of subscriptions) {
      const context = entry.context;
      if (context.projectId && event.projectId && context.projectId !== event.projectId) continue;
      if (context.loginId && event.loginIds?.length && !event.loginIds.includes(context.loginId)) continue;
      if (context.accountId && event.accountIds?.length && !event.accountIds.includes(context.accountId)) continue;
      try { Promise.resolve(entry.callback(structuredClone(event), structuredClone(control))).catch(() => onDiagnostic({ code: 'revocation-subscriber-failed', seq: event.seq })); }
      catch { onDiagnostic({ code: 'revocation-subscriber-failed', seq: event.seq }); }
    }
  };
  function fenceRuns(state, fence) {
    if (runHooks) {
      const result = runHooks.fenceInState(state, fence);
      if (result?.then) reject(503, 'ledger-async-transaction');
      return result;
    }
    // A deployment may still be page-only before run authority is mounted. Durable
    // grants can never survive a missing fence implementation or be silently skipped.
    if (Object.keys(state.runGrantsV2 ?? {}).length) reject(503, 'run-authority-unavailable');
    return null;
  }
  function applyRevocation(input) {
    const event = validateAccountEvent(input);
    const result = ledger.transaction(state => {
      if (event.seq <= state.accountHead) {
        if (state.accountEvents[event.seq]?.digest !== digestOf(event)) reject(503, 'account-event-conflict');
        return { duplicate: true, event: null };
      }
      if (event.seq !== state.accountHead + 1) reject(503, 'account-event-gap');
      const priorEvent = Object.values(state.accountEvents).find(row => row.event.eventId === event.eventId)?.event;
      if (priorEvent && (priorEvent.type !== 'password-changed' || event.type !== 'credentials-revoked' ||
        ['accountId', 'changeSeq', 'changedAt', 'initiatorWebsiteLoginId'].some(field => priorEvent[field] !== event[field]) ||
        canonicalJson(priorEvent.oldLoginIds) !== canonicalJson(event.oldLoginIds))) reject(503, 'account-event-conflict');
      state.accountEvents[event.seq] = { event, digest: digestOf(event) };
      state.accountHead = event.seq;
      if (!['credentials-revoked', 'logout', 'account-deleted'].includes(event.type)) return { duplicate: false, event: null };
      // 账号删了:他在各项目里挂着的、被拒的申请一并清掉(创建者的列表里不再有这个账号,「通过」点到它回 404 `no-join-request`)
      if (event.type === 'account-deleted') for (const p of Object.values(state.projects))
        if (p.joinRequests && Object.hasOwn(p.joinRequests, event.accountId)) p.joinRequests = withoutJoinRequest(p.joinRequests, event.accountId);
      const loginIds = event.revokedLoginIds ?? event.oldLoginIds;
      for (const loginId of loginIds) state.revokedLogins[`login:${loginId}`] = { eventId: event.eventId, seq: event.seq, accountId: event.accountId };
      const accessEvent = appendAccessEvent(state, { type: 'login-revoked', accountEventId: event.eventId,
        accountEventSeq: event.seq, accountIds: [event.accountId], loginIds, createdAt: now() });
      state.barriers[`event:${event.eventId}`] = { eventId: event.eventId, accountEventSeq: event.seq,
        accessEventId: accessEvent.eventId, accessSeq: accessEvent.seq, loginIds, state: 'pending' };
      const control = fenceRuns(state, { kind: 'credential', requestId: `access:${accessEvent.eventId}`,
        loginIds, accessSeq: accessEvent.seq });
      return { duplicate: false, event: accessEvent, control };
    });
    if (result.event) notify(result.event, result.control);
    return { duplicate: result.duplicate, accountHead: ledger.read().accountHead, ok: true, ackSeq: event.seq };
  }
  async function applyRevocationNotification(input) {
    const event = validateAccountEvent(input);
    const cursor = ledger.read().accountHead;
    if (event.seq > cursor + 1) {
      await synchronize();
    }
    return applyRevocation(input);
  }
  async function synchronize() {
    if (closed) reject(503, 'authority-closed');
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        // Account's head is global. Validate and apply every page, never skip another account's seq.
        for (;;) {
          const cursor = ledger.read().accountHead;
          let batch;
          try { batch = validateEventBatch(accountClient.revocations ? await accountClient.revocations(cursor) : await accountClient.events(cursor), cursor); }
          catch (error) { if (error.status) throw error; reject(503, 'account-event-gap'); }
          if (!Number.isSafeInteger(batch.headSeq) || batch.headSeq < cursor || !Array.isArray(batch.events)) reject(503, 'account-event-gap');
          if (batch.headSeq > cursor && batch.events.length === 0) reject(503, 'account-event-gap');
          for (const event of batch.events) applyRevocation(event);
          if (ledger.read().accountHead >= batch.headSeq) break;
        }
        ready = true; return { accountHead: ledger.read().accountHead };
      } catch (error) { ready = false; throw error; }
      finally { syncing = null; }
    })();
    return syncing;
  }
  async function verify(input, trustedRole = 'page') {
    if (!input || typeof input !== 'object') reject(401, 'login-required');
    let token = input.accessToken, ref;
    if (input.authorizationId !== undefined) {
      ref = refs.get(input.authorizationId);
      if (!ref) reject(401, 'authorization-expired');
      token = ref.token;
      for (const field of ['accountId', 'loginId', 'loginGeneration']) {
        if (input[field] !== undefined && input[field] !== ref.principal[field]) reject(401, 'principal-mismatch');
      }
      if (input.accessToken !== undefined && input.accessToken !== token) reject(401, 'principal-mismatch');
      trustedRole = ref.role;
      const state = ledger.read();
      if (state.revokedLogins[`login:${ref.principal.loginId}`]) reject(401, 'credential-revoked');
    }
    // 游客:令牌是本服务自己签的,自己核对,不问账号服务,也不跟着它的事件流同步 ——
    // 账号服务挂了不该把游客一起挡在外面(`guest.mjs` 的开头说明)。往下的关卡(撤销表、角色、授权号)照样过。
    //
    // 「是不是游客令牌」由**签名**说了算:验得过就一定是本服务发的,验不过就往下交给账号服务。
    // 这台没配密钥时验不了,只能看形状说一句人话,免得回一个像是账号出了问题的错
    const read = guestKey ? readGuestToken(token, { key: guestKey, at: now() }) : null;
    if (!read && !guestKey && looksLikeGuestToken(token)) reject(503, 'guest-unavailable');
    if (read) {
      if (read.expired) reject(401, 'credential-revoked');
      const guest = guestPrincipal(read);
      if (ledger.read().revokedLogins[`login:${guest.loginId}`]) reject(401, 'credential-revoked');
      if (ref && ['accountId', 'loginId', 'loginGeneration'].some(k => guest[k] !== ref.principal[k])) reject(401, 'principal-mismatch');
      if (!['page', 'agent', 'render'].includes(trustedRole)) reject(403, 'invalid-role');
      let id = input.authorizationId;
      if (!id) { id = randomUUID(); refs.set(id, { token, principal: guest, role: trustedRole }); }
      return { ...guest, authorizationId: id, role: trustedRole };
    }
    const principal = await accountClient.verify(token);
    await synchronize();
    const state = ledger.read();
    if (state.accountHead < principal.accountEventSeq) reject(503, 'account-event-gap');
    if (state.revokedLogins[`login:${principal.loginId}`]) reject(401, 'credential-revoked');
    if (!ref && principal.expiresAt <= now()) reject(401, 'credential-revoked');
    if (ref && ['accountId', 'loginId', 'loginGeneration'].some(k => principal[k] !== ref.principal[k])) reject(401, 'principal-mismatch');
    if (!['page', 'agent', 'render'].includes(trustedRole)) reject(403, 'invalid-role');
    let authorizationId = input.authorizationId;
    if (!authorizationId) {
      authorizationId = randomUUID();
      refs.set(authorizationId, { token, principal, role: trustedRole });
      for (const [id, existingRef] of refs) {
        if (id !== authorizationId &&
            existingRef.principal.accountId === principal.accountId &&
            existingRef.principal.loginId === principal.loginId &&
            existingRef.principal.loginGeneration === principal.loginGeneration) {
          existingRef.token = token;
          existingRef.principal = { ...existingRef.principal, credentialId: principal.credentialId, expiresAt: principal.expiresAt };
        }
      }
    }
    return { ...principal, authorizationId, role: trustedRole };
  }
  async function authorizePrincipal(input, { projectId, action = 'read', trustedRole = 'page' } = {}) {
    if (!['read', 'write', 'admin'].includes(action)) reject(400, 'invalid-action');
    const principal = await verify(input, trustedRole);
    const state = ledger.read(); const project = projectOf(state, projectId);
    const access = permission(project, principal.accountId, action);
    if (action === 'admin' && (principal.role !== 'page' || project.creatorAccountId !== principal.accountId)) reject(403, 'creator-required');
    return { ...principal, projectId, authorityId: ledger.authorityId, access, creator: principal.accountId === project.creatorAccountId,
      accessRevision: project.accessRevision, revocationSeq: state.accessHead };
  }
  async function checkAccess({ principal, projectId, action, resource } = {}) {
    if (principal?.service === 'render' || (principal?.role === 'render' && principal?.authorizationId === 'service:render')) {
      if (principal.projectId && principal.projectId !== projectId) reject(403, 'project-mismatch');
      const state = ledger.read(); const project = projectOf(state, projectId);
      active(project);
      if (project.hosted?.render !== true) reject(403, 'service-disabled');
      if (principal.access === 'r' && action === 'write') reject(403, 'read-only');
      if (action === 'write' && (resource?.ns === 'media' || resource?.namespace === 'media')) reject(403, 'service-forbidden');
      return {
        allowed: true,
        authorityId: ledger.authorityId,
        accountId: 'service:render',
        loginId: 'service:render',
        credentialId: 'service:render',
        loginGeneration: 1,
        projectId,
        authorizationId: 'service:render',
        access: principal.access ?? 'rw',
        accessRevision: project.accessRevision,
        revocationSeq: state.accessHead,
        role: 'render',
        service: 'render',
      };
    }
    if (!principal?.authorizationId) reject(401, 'login-required');
    if (!accountIdOK(principal.accountId) || typeof principal.loginId !== 'string' || !principal.loginId ||
      typeof principal.credentialId !== 'string' || !principal.credentialId || !Number.isSafeInteger(principal.loginGeneration)) reject(401, 'principal-mismatch');
    if (principal.projectId !== projectId) reject(403, 'project-mismatch');
    if (!['read', 'write'].includes(action)) reject(400, 'invalid-action');
    if (resource !== undefined && (!resource || typeof resource !== 'object' || !['media', 'snap', 'px'].includes(resource.ns))) reject(400, 'invalid-resource');
    // runGrantId in a caller body cannot bypass a revoked login, private read or new run admission.
    const verified = await authorizePrincipal(principal, { projectId, action });
    return { allowed: true, ...verified };
  }
  function requestKey(accountId, requestId) { requireRequestId(requestId); return `request:${accountId}:${requestId}`; }
  function replay(state, key, digest) {
    const previous = state.requests[key];
    if (previous && previous.digest !== digest) reject(409, 'request-mismatch');
    return previous;
  }
  async function createProject(input, body) {
    const actor = await verify(input);
    if (actor.role !== 'page') reject(403, 'creator-required');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) reject(400, 'invalid-name');
    if (body.allowLinkJoin !== undefined && typeof body.allowLinkJoin !== 'boolean') reject(400, 'invalid-entry');
    if (typeof initializeProject !== 'function') reject(503, 'initialization-unavailable');
    const reqProjectId = typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
    if (reqProjectId && !projectIdOK(reqProjectId)) reject(400, 'invalid-project');
    const key = requestKey(actor.accountId, body.requestId);
    // 搬到云端:历史序号接着本机那一份往上数(本机 DocSync 确认过的序号),提交摘要只留到这个序号为止(10-14 第 3.3 节)
    if (body?.rev !== undefined && (!Number.isSafeInteger(body.rev) || body.rev < 1)) reject(400, 'invalid-rev');
    const initialRev = body?.rev ?? 1;
    const initialHistory = importedHistory(body?.history, initialRev);
    const payload = { op: 'create', name, initialProject: body.initialProject ?? null, allowLinkJoin: body.allowLinkJoin ?? true,
      ...(reqProjectId ? { projectId: reqProjectId } : {}) };
    const digest = digestOf(payload);
    const pending = ledger.transaction(state => {
      const previous = replay(state, key, digest);
      if (previous) return { projectId: previous.projectId, result: previous.result ?? null };
      // 重复的 requestId 已在上面原样回放，不占名额；新建才过策略口子（数量从账本里数，不另建表）
      checkCreateProject(createPolicy, { accountId: actor.accountId, accountName: actor.accountName, requestId: body.requestId,
        ownedCount: Object.values(state.projects).filter(p => p.status !== 'deleted' && p.creatorAccountId === actor.accountId).length });
      if (Object.values(state.projects).some(p => p.status !== 'deleted' && p.name === name)) reject(409, 'name-taken');
      let projectId;
      if (reqProjectId) {
        if (state.projects[reqProjectId] && state.projects[reqProjectId].status !== 'deleted') {
          reject(409, 'project-id-taken');
        }
        projectId = reqProjectId;
      } else {
        do { projectId = newProjectId(); } while (state.projects[projectId]);
      }
      state.projects[projectId] = { v: 2, identityRealm: 'account', projectId, authorityId: ledger.authorityId,
        name, status: 'pending', creatorAccountId: actor.accountId, allowLinkJoin: payload.allowLinkJoin, createdAt: now(),
        members: { [actor.accountId]: { access: 'rw', joinedAt: now(), accountNameAtJoin: actor.accountName } }, bans: {}, accessRevision: 0,
        // 托管方的两个服务（渲染节点、云端 Agent）缺省开（product/document-service.md、product/agent.md），创建者可以关；
        // 「生成轨道流」等子选项不在这里，没有记就是关（hostedOptions）
        hosted: { render: true, agent: true }, creationRequestId: body.requestId, initialProject: payload.initialProject,
        initialRev, initialHistory };
      state.requests[key] = { digest, projectId, state: 'pending' }; return { projectId, result: null };
    });
    if (pending.result) return pending.result;
    if (creating.has(key)) return creating.get(key);
    const work = (async () => {
      const project = ledger.read().projects[pending.projectId];
      const initialized = await initializeProject({ projectId: project.projectId, creatorAccountId: actor.accountId,
        authorityId: ledger.authorityId, requestId: body.requestId, initialProject: structuredClone(project.initialProject),
        initialRev: project.initialRev ?? 1, initialHistory: project.initialHistory ?? [] });
      if (!initialized || typeof initialized.contentId !== 'string' || !initialized.contentId) reject(503, 'initialization-incomplete');
      // Recheck the initiating credential after asynchronous durable initialization, before exposing active.
      await verify({ authorizationId: actor.authorizationId });
      const committed = ledger.transaction(state => {
        const p = state.projects[project.projectId]; const previous = replay(state, key, digest);
        if (previous.result) return { result: previous.result, event: null };
        p.status = 'active'; p.contentId = initialized.contentId; delete p.initialProject;
        delete p.initialRev; delete p.initialHistory;
        p.accessRevision = ++state.revision;
        const event = appendAccessEvent(state, { type: 'project-created', projectId: p.projectId, accessRevision: p.accessRevision, createdAt: now() });
        const result = { projectId: p.projectId, authorityId: ledger.authorityId, contentId: p.contentId, accessRevision: p.accessRevision };
        state.requests[key] = { digest, projectId: p.projectId, state: 'complete', result };
        return { result, event };
      });
      if (committed.event) notify(committed.event);
      notifyProjectChanged(committed.result.projectId, 'create');
      return committed.result;
    })();
    creating.set(key, work);
    try { return await work; } finally { creating.delete(key); }
  }
  function listProjects(accountId) {
    if (!accountIdOK(accountId)) reject(400, 'invalid-account');
    if (!ready || closed) reject(503, 'authority-not-ready');
    if (typeof authorityUrl !== 'string' || !/^https:\/\//.test(authorityUrl)) reject(503, 'authority-url-unavailable');
    const state = ledger.read(); const owned = [], joined = [];
    for (const p of Object.values(state.projects)) {
      if (p.status !== 'active' || p.bans[accountId]) continue;
      const item = { projectId: p.projectId, name: p.name, status: p.status, creatorAccountId: p.creatorAccountId,
        authorityId: ledger.authorityId, accessRevision: p.accessRevision,
        url: `${authorityUrl.replace(/\/$/, '')}/?project=${encodeURIComponent(p.projectId)}` };
      if (p.creatorAccountId === accountId) owned.push(item);
      else if (p.members[accountId]?.joinedAt != null) joined.push(item);
    }
    return { authorityId: ledger.authorityId, revision: state.revision, owned, joined };
  }
  async function joinProject(input, body) {
    const actor = await verify(input); const key = requestKey(actor.accountId, body?.requestId);
    const digest = digestOf({ op: 'join', projectId: body.projectId });
    const committed = ledger.transaction(state => {
      const p = projectOf(state, body.projectId); active(p);
      if (p.bans[actor.accountId]) reject(403, 'banned');
      if (!p.allowLinkJoin && !p.members[actor.accountId]) reject(403, 'not-listed');
      const isCreator = actor.accountId === p.creatorAccountId;
      const isExistingMember = !!p.members[actor.accountId]?.joinedAt;

      // 验证链接是否已作废（仅对新加入的非创建者核对；已进来的老成员不受影响）
      if (!isCreator && !isExistingMember && p.linkToken) {
        if (!sameSecret(body?.linkToken ?? body?.token, p.linkToken)) reject(403, 'link-expired');
      }

      // 验证项目二级密码（非创建者需要核对；已经进过的成员不再问，改了密码之后才要重新输一次）。
      // 密码照输入的原样算哈希，设置与核对两边都不去空白
      if (!isCreator && p.secondaryPassword) {
        if (p.members[actor.accountId]?.secondaryPasswordRev !== p.secondaryPassword.rev) {
          if (typeof body.secondaryPassword !== 'string' || body.secondaryPassword === '') reject(403, 'secondary-password-required');
          if (body.secondaryPassword.length > SECONDARY_PASSWORD_MAX) reject(403, 'bad-secondary-password');
          if (!sameSecret(secondaryHash(body.secondaryPassword, p.secondaryPassword.salt), p.secondaryPassword.hash)) reject(403, 'bad-secondary-password');
        }
      }

      const previous = replay(state, key, digest); if (previous) return { result: previous.result, event: null };
      if (!p.members[actor.accountId]?.joinedAt) {
        // 游客进别人的项目一律只读(2026-10-23 用户定),落账时就记成 'r',名单上看到的和实际能做的一致;
        // 真正拦写的是 `permission`,这里只是让记录说实话
        const access = isGuestId(actor.accountId) && !isCreator ? 'r' : (p.members[actor.accountId]?.access ?? 'rw');
        p.members[actor.accountId] = { access, joinedAt: now(), accountNameAtJoin: actor.accountName };
        p.accessRevision = ++state.revision;
      }
      if (p.secondaryPassword) {
        p.members[actor.accountId].secondaryPasswordRev = p.secondaryPassword.rev;
      }
      // 进来了:他在这个项目里的申请记录作废(创建者改回「知道链接就能进」之后他自己进来的那种),不再留在创建者的申请列表里
      p.joinRequests = withoutJoinRequest(p.joinRequests, actor.accountId);
      const result = { projectId: p.projectId, authorityId: ledger.authorityId, accessRevision: p.accessRevision,
        access: p.members[actor.accountId].access };
      state.requests[key] = { digest, result, state: 'complete' };
      const event = appendAccessEvent(state, { type: 'member-joined', projectId: p.projectId, accountIds: [actor.accountId], accessRevision: p.accessRevision, createdAt: now() });
      return { result, event };
    });
    if (committed.event) notify(committed.event);
    notifyProjectChanged(body.projectId, 'join');
    return committed.result;
  }
  /**
   * 发项目会话前的进入核对(公开的 `/session` 路由用;`/join` 已经在 `joinProject` 里核过)。
   * 设了项目二级密码、而这个成员还没输过当前这一版密码的(新设或改过之后):回 `secondary-password-required`,
   * 页面据此请他输一次、凭密码走 `/join`(10-14 第 3.3 节「已经进过的成员不再问，改了密码之后才要重新输一次」)。
   * 创建者自己不用输;回给创建者当前的链接口令(拼「复制项目链接」用)和有没有设二级密码。
   */
  function entryState({ accountId, projectId } = {}) {
    const p = projectOf(ledger.read(), projectId); active(p);
    if (accountId === p.creatorAccountId) return { linkToken: typeof p.linkToken === 'string' ? p.linkToken : null, secondaryPassword: !!p.secondaryPassword };
    if (secondaryPasswordPending(p, accountId)) reject(403, 'secondary-password-required');
    return {};
  }
  async function adminProject(input, body) {
    const actor = await verify(input);
    if (body?.op === 'set-hosted-option' && body.service === 'render' && body.option === 'streams' && body.enabled === true) {
      if (typeof accountClient?.permissions === 'function') {
        const perm = await accountClient.permissions({ accountId: actor.accountId, group: 'render_streams' });
        if (perm?.allowed !== true) reject(403, 'permission-denied');
      }
    }
    // 项目二级密码:照输入的原样(不去空白)加盐哈希;空串或 null 是清除。明文不进请求账本的摘要,也不进账本
    let secondary;
    if (body?.op === 'set-secondary-password') {
      if (body.password !== null && typeof body.password !== 'string') reject(400, 'invalid-password');
      if (typeof body.password === 'string' && body.password.length > SECONDARY_PASSWORD_MAX) reject(400, 'invalid-password');
      secondary = body.password ? (salt => ({ salt, hash: secondaryHash(body.password, salt) }))(randomBytes(16).toString('base64url')) : null;
    }
    const { password: _password, ...digestBody } = body ?? {};
    const key = requestKey(actor.accountId, body.requestId);
    const digest = digestOf({ op: 'admin', body: digestBody, ...(body?.op === 'set-secondary-password' ? { clears: !secondary } : {}) });
    const committed = ledger.transaction(state => {
      const p = projectOf(state, body.projectId);
      if (actor.role !== 'page' || actor.accountId !== p.creatorAccountId) reject(403, 'creator-required');
      const previous = replay(state, key, digest); if (previous) return { result: previous.result, event: null };
      permission(p, actor.accountId, 'admin');
      if (body.expectedAccessRevision !== p.accessRevision) reject(409, 'access-revision-mismatch');
      const affected = [];
      switch (body.op) {
        case 'set-entry':
          if (typeof body.allowLinkJoin !== 'boolean') reject(400, 'invalid-entry'); p.allowLinkJoin = body.allowLinkJoin; break;
        case 'set-list': {
          if (!Array.isArray(body.members) || body.members.length > 10000) reject(400, 'invalid-members');
          const next = { [p.creatorAccountId]: p.members[p.creatorAccountId] };
          for (const member of body.members) {
            if (!accountIdOK(member?.accountId) || !['r', 'rw'].includes(member.access) || next[member.accountId]) reject(400, 'invalid-members');
            if (p.bans[member.accountId]) reject(403, 'banned');
            // 游客一律只读:名单里写了读写也归一成 r,免得名单上显示的和实际能做的两样
            next[member.accountId] = { access: isGuestId(member.accountId) ? 'r' : member.access, joinedAt: p.members[member.accountId]?.joinedAt ?? null };
          }
          for (const [id, old] of Object.entries(p.members)) if (!next[id] || (old.access === 'rw' && next[id].access === 'r')) affected.push(id);
          p.members = next;
          // 名单里有了的账号,挂着的申请作废(成员不留申请记录)
          if (p.joinRequests) p.joinRequests = Object.fromEntries(Object.entries(p.joinRequests).filter(([id]) => !next[id]));
          break;
        }
        case 'kick': {
          if (!accountIdOK(body.accountId) || body.accountId === p.creatorAccountId) reject(400, 'invalid-member');
          const accountNameAtJoin = p.members[body.accountId]?.accountNameAtJoin;
          delete p.members[body.accountId]; p.bans[body.accountId] = { reason: 'kick', requestId: body.requestId, accountNameAtJoin }; affected.push(body.accountId);
          // 被踢(禁入)的账号不能申请:他挂着的、被拒的申请记录一并清掉;解除禁入后要重新申请
          p.joinRequests = withoutJoinRequest(p.joinRequests, body.accountId);
          break;
        }
        case 'unban':
          if (!accountIdOK(body.accountId)) reject(400, 'invalid-member'); delete p.bans[body.accountId]; break;
        // 删项目:申请记录(申请人的账号号与名字)不留在墓碑里
        case 'delete': p.status = 'deleted'; affected.push(...Object.keys(p.members)); delete p.joinRequests; break;
        case 'regen-link':
          // 作废并重新生成项目链接:旧链接失效(新人要带新口令),已经进来的成员不受影响,所以不动成员、不停任务
          p.linkToken = randomBytes(16).toString('base64url');
          break;
        case 'set-secondary-password':
          p.secondaryPassword = secondary ? { ...secondary, rev: ++state.revision } : null;
          break;
        case 'set-hosted-service':
          if (!['render', 'agent'].includes(body.service) || typeof body.enabled !== 'boolean') reject(400, 'invalid-service');
          p.hosted[body.service] = body.enabled; break;
        case 'set-hosted-option':
          // 托管方服务下面的子选项(渲染节点的「生成轨道流」,`docs/plan/hosted-render-contract.md` 第 3.1 节):只记下,不动成员、不停任何任务。
          // 记在 `hostedOptions.<服务名>.<选项名>`(与服务的开关 `hosted.<服务名>` 分开放,那一项仍是布尔);没有算关,只有显式为 true 才算开
          if (!Object.hasOwn(HOSTED_OPTIONS, body.service) || !HOSTED_OPTIONS[body.service].includes(body.option) || typeof body.enabled !== 'boolean') reject(400, 'invalid-option');
          p.hostedOptions = { ...(p.hostedOptions ?? {}), [body.service]: { ...(p.hostedOptions?.[body.service] ?? {}), [body.option]: body.enabled } };
          break;
        default: reject(400, 'invalid-operation');
      }
      p.accessRevision = ++state.revision;
      const event = appendAccessEvent(state, { type: 'project-access-changed', reason: body.op, projectId: p.projectId,
        accountIds: affected, accessRevision: p.accessRevision, createdAt: now(),
        ...(body.op === 'set-hosted-service' ? { service: body.service, enabled: body.enabled } : {}),
        ...(body.op === 'set-hosted-option' ? { service: body.service, option: body.option, enabled: body.enabled } : {}),
        // 链接口令只回给创建者本人(下面的 result),不写进访问事件:各服务都读得到访问事件
        ...(body.op === 'set-secondary-password' ? { hasSecondaryPassword: !!p.secondaryPassword } : {}) });
      let control = null;
      const fence = { requestId: `access:${event.eventId}`, projectId: p.projectId, accessSeq: event.seq };
      if (body.op === 'delete') control = fenceRuns(state, { ...fence, kind: 'delete' });
      else if (body.op === 'set-hosted-service' && body.service === 'agent' && body.enabled === false)
        control = fenceRuns(state, { ...fence, kind: 'agent-disabled' });
      else if (affected.length) control = fenceRuns(state, { ...fence, kind: 'member', accountIds: affected });
      if (p.status === 'deleted') p.tombstone = { revision: p.accessRevision, deletedAt: now() };
      const result = { eventId: event.eventId, accessRevision: p.accessRevision, completed: false, state: 'pending-services',
        ...(body.op === 'regen-link' ? { linkToken: p.linkToken } : {}),
        ...(body.op === 'set-secondary-password' ? { hasSecondaryPassword: !!p.secondaryPassword } : {}) };
      state.requests[key] = { digest, result, state: 'complete' };
      return { result, event, control };
    });
    if (committed.event) notify(committed.event, committed.control);
    notifyProjectChanged(body.projectId, body.op);
    return committed.result;
  }
  /**
   * 发一张游客令牌（公开路由 `/hosted/shared/account/guest`，不要登录 —— 他还没有身份）。
   *
   * 带着旧令牌来就续期，编号不变（同一台浏览器回来还是同一个人，product/document-service.md「游客」）。
   * **过期了也续**（2026-10-23 claude/guest-fix〔裁〕，审查 B：原先过期就换新编号，游客隔天回来就成了另一个人、
   * 进不了自己的项目）：签名对得上、过期不超过 `GUEST_LIMITS.renewGraceMs`（3 天，和游客项目的寿命一样长）、
   * 这个身份没被作废（`revokeGuest`），就续成同一个编号。超过 3 天没来，他建的项目也早清掉了，这时才换新身份。
   * 不带、改过（签名对不上）、作废过的，随机一个新身份。
   * 编号只由这里生成，不收请求体里写的：收了的话谁都能自称是别人（`guest.mjs` 开头说明）。
   *
   * @param {string | null} previous 页面手里那一张，没有就给 null
   * @param {{ admitNew?: () => void }} [options] `admitNew`：要发**新**身份之前调（领令牌的 IP 限流只数这一种，
   *   续期不数，审查 E）；不许发就在里面抛错
   */
  function issueGuest(previous, { admitNew } = {}) {
    if (!guestKey) reject(503, 'guest-unavailable');
    const at = now();
    const read = typeof previous === 'string' ? readGuestToken(previous, { key: guestKey, at }) : null;
    const old = read && at <= read.expiresAt + GUEST_LIMITS.renewGraceMs && !ledger.read().revokedLogins[`login:guest:${read.guestId}`] ? read : null;
    if (!old) admitNew?.();
    const issued = signGuestToken({ key: guestKey, at, ...(old ? { guestId: old.guestId } : {}) });
    return { token: issued.token, guestId: issued.guestId, expiresAt: issued.expiresAt, renewed: !!old };
  }

  /**
   * 作废一个游客身份（同一条公开路由带 `revoke: true`；页面登录账号、或者点「我有账号，去登录」时发，
   * product「登录账号之后游客身份作废」，审查 S9：原先只在页面那一侧清掉，服务端那张令牌照样能用、能续期）。
   * 交来的令牌签名对得上就作废它的编号（过期的也收，过期的还能续期）：记进撤销表（`revokedLogins`，
   * 和账号退出登录同一张），之后这个编号的令牌核不过（`verify` 本来就查这张表）、也续不了期。
   * 认不出的令牌回 `{ revoked: false }`，不说为什么。作废是幂等的。
   *
   * @param {string | null} token
   */
  function revokeGuest(token) {
    if (!guestKey) reject(503, 'guest-unavailable');
    const at = now();
    const read = typeof token === 'string' ? readGuestToken(token, { key: guestKey, at }) : null;
    if (!read) return { revoked: false };
    const key = `login:guest:${read.guestId}`;
    ledger.transaction(state => { if (!state.revokedLogins[key]) state.revokedLogins[key] = { guest: true, revokedAt: at }; });
    return { revoked: true };
  }

  /**
   * 游客建的项目三天就清（2026-10-23 用户定，天数在 `guest.mjs` 的 `GUEST_LIMITS.ttlMs`）。
   *
   * 清的办法和创建者自己点「删项目」完全一样（上面 `adminProject` 的 `delete` 分支）：标成已删除、落墓碑、
   * 记一条访问事件、按 `delete` 围栏停掉在跑的任务。走同一条路，下游（素材服务按项目清字节、连着的页面被断开）
   * 不用为游客另认一种「项目没了」。账号建的项目一个都不碰。
   *
   * 由外面定时叫（`server/hosted/main.mjs`）；这里不自己起计时器，测试才好把时间拨过去。
   * @returns {string[]} 这一趟清掉的项目号
   */
  function sweepExpiredGuestProjects(at = now()) {
    // 没有 createdAt 的是这条规矩之前建的项目:那时还没有游客,一律当没到期(不猜生日、不误删)
    const bornAt = p => (Number.isSafeInteger(p?.createdAt) ? p.createdAt : null);
    const committed = ledger.transaction(state => {
      const done = [];
      for (const p of Object.values(state.projects)) {
        if (p.status === 'deleted' || !isGuestId(p.creatorAccountId)) continue;
        const born = bornAt(p);
        if (born === null || !guestExpired(born, at)) continue;
        const affected = Object.keys(p.members);
        p.status = 'deleted'; delete p.joinRequests;
        p.accessRevision = ++state.revision;
        const event = appendAccessEvent(state, { type: 'project-access-changed', reason: 'delete', projectId: p.projectId,
          accountIds: affected, accessRevision: p.accessRevision, createdAt: at });
        const control = fenceRuns(state, { requestId: `access:${event.eventId}`, projectId: p.projectId, accessSeq: event.seq, kind: 'delete' });
        p.tombstone = { revision: p.accessRevision, deletedAt: at };
        done.push({ projectId: p.projectId, event, control });
      }
      return done;
    });
    for (const { projectId, event, control } of committed) { notify(event, control); notifyProjectChanged(projectId, 'delete'); }
    return committed.map(c => c.projectId);
  }

  /**
   * 申请加入,申请人这一侧(公开路由 `/hosted/shared/account/join` 带 `joinRequest` 字段,不另开路由:桌面外壳的账号桥只放行
   * create / join / session / admin / members 五条,`desktop/src-tauri/src/account_vault.rs`)。
   *   `joinRequest: 'status'`:读自己这一条(`joinRequestView`),不落账。
   *   `joinRequest: 'send'`:发申请。身份只认登录令牌(账号号、名字取自核过的登录,请求体里写的一律不认);被踢的账号回 403 `banned`;
   *     已经是成员回 `member`;项目知道链接就能进时回 409 `entry-open`;已经在等的不另起一条;条数、时间窗里的次数有上限(`JOIN_REQUEST_LIMITS`)。
   *     同一个请求号重试不算第二次;换项目号重用请求号回 409 `request-mismatch`。
   * 不动访问版本号、不记访问事件:申请不改任何人的权限。
   */
  async function joinRequest(input, body) {
    const actor = await verify(input);
    if (actor.role !== 'page') reject(403, 'invalid-role');
    if (body?.joinRequest === 'status') {
      const p = projectOf(ledger.read(), body.projectId); active(p);
      if (Object.hasOwn(p.bans, actor.accountId)) reject(403, 'banned');
      return { projectId: p.projectId, joinRequest: joinRequestView(p, actor.accountId, limits, now()) };
    }
    if (body?.joinRequest !== 'send') reject(400, 'invalid-join-request');
    const key = requestKey(actor.accountId, body.requestId);
    const digest = digestOf({ op: 'join-request', projectId: body.projectId });
    return ledger.transaction(state => {
      const p = projectOf(state, body.projectId); active(p);
      if (Object.hasOwn(p.bans, actor.accountId)) reject(403, 'banned');
      const at = now();
      const view = () => ({ projectId: p.projectId, joinRequest: joinRequestView(p, actor.accountId, limits, at) });
      if (actor.accountId === p.creatorAccountId || p.members[actor.accountId]) return view();
      if (p.allowLinkJoin) reject(409, 'entry-open');
      // 同一个请求号已经办过(回包丢了的重试):不再起一条,回现在的状态(这期间被拒了就是被拒)
      if (replay(state, key, digest)) return view();
      const existing = p.joinRequests?.[actor.accountId];
      if (existing?.state === 'pending') return view();
      const recent = recentSends(existing, at, limits);
      if (recent.length >= limits.accountProjectSends) reject(429, 'join-request-limit');
      if (Object.values(p.joinRequests ?? {}).filter(r => r?.state === 'pending').length >= limits.projectPending) reject(429, 'join-request-full');
      let sent = 0;
      for (const other of Object.values(state.projects)) sent += recentSends(other.joinRequests?.[actor.accountId], at, limits).length;
      if (sent >= limits.accountSends) reject(429, 'join-request-account-limit');
      const record = { id: `jr_${randomBytes(12).toString('hex')}`, accountName: shownName(actor.accountName), createdAt: at, state: 'pending',
        sends: [...recent, at] };
      p.joinRequests = { ...(p.joinRequests ?? {}), [actor.accountId]: record };
      state.requests[key] = { digest, state: 'complete', result: { joinRequestId: record.id } };
      return view();
    });
  }
  /**
   * 申请加入,创建者这一侧:「通过」(`op: 'approve-join'`)、「拒绝」(`op: 'reject-join'`),走 `/hosted/shared/account/admin`。
   * 只有创建者本人的页面能办(服务端核,与踢人同一个判据);点名的是「哪个账号的哪一条申请」(`accountId` + `joinRequestId`),
   * 所以不核访问版本号:别人这时加入、改了别的设置都不影响这一条。
   *   通过:在通过这一笔落账的那一刻现核(不凭页面上那一眼):项目还在、创建者本人登录有效、申请还挂着(被踢、账号删了都会清掉申请)、
   *     申请人不在禁入名单里。申请人成为成员(可写,`joinedAt` 记通过的时刻,「我加入的」里看得到),申请记录删掉、成员记录上留申请号;
   *     访问版本号 +1。进项目仍走原来的全部关卡:`/join`、`/session` 照旧核申请人的登录、禁入、二级密码,通过不跳过任何一道。
   *   拒绝:记录标成被拒(申请人看到「创建者没有通过你的申请」);不动成员与访问版本号。
   *   幂等:同一个请求号重放回原结果;换了请求号再做同样的决定(另一台设备也点了、网络重试)回同样的结果、不再改账;
   *     相反的决定回 409 `join-request-decided`;申请号对不上(已撤、已清、别的项目的)回 404 `no-join-request`。
   */
  async function decideJoinRequest(input, body) {
    const actor = await verify(input);
    const decision = body?.op === 'approve-join' ? 'approved' : body?.op === 'reject-join' ? 'rejected' : null;
    if (!decision) reject(400, 'invalid-operation');
    const key = requestKey(actor.accountId, body.requestId);
    const digest = digestOf({ op: body.op, projectId: body.projectId, accountId: body.accountId, joinRequestId: body.joinRequestId });
    const committed = ledger.transaction(state => {
      const p = projectOf(state, body.projectId);
      if (actor.role !== 'page' || actor.accountId !== p.creatorAccountId) reject(403, 'creator-required');
      const previous = replay(state, key, digest); if (previous) return { result: previous.result, approved: false };
      permission(p, actor.accountId, 'admin');
      if (!accountIdOK(body.accountId) || !joinRequestIdOK(body.joinRequestId)) reject(400, 'invalid-join-request');
      const record = p.joinRequests?.[body.accountId];
      const settled = record?.id === body.joinRequestId && record.state === 'rejected' ? 'rejected'
        : p.members[body.accountId]?.joinRequestId === body.joinRequestId ? 'approved' : null;
      let approved = false;
      if (settled) {
        if (settled !== decision) reject(409, 'join-request-decided');
      } else {
        if (record?.id !== body.joinRequestId || record.state !== 'pending') reject(404, 'no-join-request');
        if (Object.hasOwn(p.bans, body.accountId)) reject(409, 'join-request-banned');
        if (p.members[body.accountId]) reject(409, 'already-member');
        if (decision === 'approved') {
          p.joinRequests = withoutJoinRequest(p.joinRequests, body.accountId);
          // 游客通过申请进来也是只读(`permission` 那一条),落账就记 r,名单上看到的和实际能做的一致
          p.members[body.accountId] = { access: isGuestId(body.accountId) ? 'r' : 'rw', joinedAt: now(),
            ...(record.accountName ? { accountNameAtJoin: record.accountName } : {}), joinRequestId: record.id };
          p.accessRevision = ++state.revision;
          approved = true;
        } else {
          p.joinRequests = pruneRejected({ ...p.joinRequests, [body.accountId]: { ...record, state: 'rejected', decidedAt: now() } }, limits.rejectedKept);
        }
      }
      const result = { joinRequest: { accountId: body.accountId, joinRequestId: body.joinRequestId, state: decision }, accessRevision: p.accessRevision };
      state.requests[key] = { digest, state: 'complete', result };
      return { result, approved };
    });
    if (committed.approved) notifyProjectChanged(body.projectId, body.op);
    return committed.result;
  }
  function eventsSince(after = 0) {
    if (!ready || closed) reject(503, 'authority-not-ready');
    const state = ledger.read();
    if (!Number.isSafeInteger(after) || after < 0 || after > state.accessHead) reject(400, 'invalid-cursor');
    return { events: state.accessEvents.filter(e => e.seq > after).slice(0, 100), headSeq: state.accessHead };
  }
  function ackAccessEvent(eventId, serviceId, receipt) {
    if (!services.includes(serviceId)) reject(403, 'service-forbidden');
    requireRequestId(receipt?.receiptId);
    // A service sends its immutable receipt only after real close. Progress/pending is not an ACK.
    if (!Number.isSafeInteger(receipt.cursor) || receipt.complete !== true || !Array.isArray(receipt.closedStreams) || !Array.isArray(receipt.stoppedRuns) || !Array.isArray(receipt.rejectedCredentials)) reject(400, 'invalid-receipt');
    return ledger.transaction(state => {
      const event = state.accessEvents.find(e => e.eventId === eventId); if (!event) reject(404, 'no-event');
      if (receipt.cursor < event.seq || receipt.cursor > state.accessHead) reject(409, 'ack-cursor-mismatch');
      if (serviceId === 'agent' && !agentReadClosureComplete(state, eventId, receipt)) reject(503, 'agent-read-closure-required');
      const key = `ack:${eventId}:${serviceId}`; const old = state.accessAcks[key];
      if (old && receipt.cursor < old.cursor) return old;
      if (old && receipt.cursor === old.cursor && digestOf(old) !== digestOf(receipt)) reject(409, 'ack-mismatch');
      state.accessAcks[key] = structuredClone(receipt); return receipt;
    });
  }
  function status({ authorityId, projectId }) {
    if (!ready || closed) reject(503, 'authority-not-ready');
    if (authorityId !== ledger.authorityId) reject(409, 'wrong-authority');
    const p = projectOf(ledger.read(), projectId);
    if (p.status === 'pending') reject(404, 'no-project');
    if (p.status !== 'deleted') return { state: p.status === 'active' ? 'exists' : p.status, authorityId, projectId, accessRevision: p.accessRevision };
    return goneProofOf(authorityId, projectId, p.tombstone);
  }
  /** 「这个项目已不存在」的证明：只对账本里留有墓碑的项目签。客户端的核对见 `server/recovery/gone-proof.mjs`。 */
  function goneProofOf(authorityId, projectId, tombstone) {
    if (!signingKey || typeof keyId !== 'string' || !keyId) reject(503, 'gone-proof-unavailable');
    if (!Number.isSafeInteger(tombstone?.revision) || !Number.isSafeInteger(tombstone?.deletedAt)) reject(503, 'gone-proof-unavailable');
    const payload = { v: 1, authorityId, projectId, state: 'gone', tombstoneRevision: tombstone.revision, issuedAt: tombstone.deletedAt, kid: keyId };
    return { ...payload, signature: sign(null, Buffer.from(canonicalJson(payload)), signingKey).toString('base64url') };
  }
  /**
   * 旧办法（不带账号）建的云端项目的墓碑：这些项目从来不在本账本的 `projects` 里，节点上清掉它们时由
   * `server/hosted/deploy/legacy-tombstones.mjs` 把项目号登记进 `legacyTombstones`。它们没有账号成员可核，
   * 所以这一项不带登录也答；但只答登记过墓碑的旧项目号——账号项目（不论在不在、删没删）、没登记过的项目号一律回
   * `no-tombstone`，不签任何东西，也不透露账号项目存不存在。
   */
  function legacyGoneStatus({ authorityId, projectId }) {
    // 不看账号事件有没有追平：旧项目的墓碑和账号服务无关，账号服务停着也答得出来；这一项不带登录，也不该替匿名请求去问账号服务。
    if (closed) reject(503, 'authority-closed');
    if (authorityId !== ledger.authorityId) reject(409, 'wrong-authority');
    if (!projectIdOK(projectId)) reject(400, 'invalid-project');
    const state = ledger.read();
    const tombstone = Object.hasOwn(state.legacyTombstones ?? {}, projectId) && !Object.hasOwn(state.projects, projectId)
      ? state.legacyTombstones[projectId] : null;
    if (!tombstone) reject(404, 'no-tombstone');
    return goneProofOf(authorityId, projectId, tombstone);
  }
  function revocationStatus(eventId) {
    const state = ledger.read(); const barrier = state.barriers[`event:${eventId}`];
    if (!barrier) reject(404, 'no-event');
    const serviceAcks = Object.fromEntries(services.map(service => [service, state.accessAcks[`ack:${barrier.accessEventId}:${service}`] ?? null]));
    // Preserve legacy rows on disk, but they are not proof under the required protocol.
    if (!agentReadClosureComplete(state, barrier.accessEventId, serviceAcks.agent)) serviceAcks.agent = null;
    // 文档服务自己这一项：带着关闭证据的那份回执已经送到账号服务才算。整条退出办完另看账号服务回来的结束见证。
    const docAck = state.accountAcks[`seq:${barrier.accountEventSeq}`];
    const docConfirmed = docAck?.sent === true && docAck.receipt?.logoutComplete === true;
    return { ...barrier, serviceAcks, docConfirmed,
      pendingServices: [...(docConfirmed ? [] : ['doc']), ...services.filter(s => !serviceAcks[s]?.complete || serviceAcks[s].cursor < barrier.accessSeq)],
      logoutComplete: barrier.state === 'complete' };
  }
  /** 这次退出等确认等过了时限：把当时的情况记进账本（哪几样确认了、哪几样没有、原因码、等了多久）。只记第一次。
   * 这只是一条记录：退出仍然算没办完、接着办；旧登录的作废不受任何影响。`reported` 是「已经报给账号服务」的标记。 */
  function recordLogoutTimeout(eventId, info) {
    return ledger.transaction(state => {
      const barrier = state.barriers[`event:${eventId}`]; if (!barrier) reject(404, 'no-event');
      if (barrier.state === 'complete') return structuredClone(barrier);
      barrier.timeout ??= { ...structuredClone(info), reported: false };
      if (info.reported === true) barrier.timeout.reported = true;
      return structuredClone(barrier);
    });
  }
  /** 账号服务已经为这次退出签了结束见证（它那边要四个服务的确认都齐了才签）。只记一次，重复记同一份不报错。 */
  function completeLogoutBarrier(eventId, witness) {
    if (typeof witness?.witnessId !== 'string' || !witness.witnessId || !Number.isSafeInteger(witness.orderSeq) ||
        witness.kind !== 'logout-complete' || witness.state !== 'sealed' || witness.eventId !== eventId) reject(400, 'invalid-logout-witness');
    return ledger.transaction(state => {
      const barrier = state.barriers[`event:${eventId}`]; if (!barrier) reject(404, 'no-event');
      const docAck = state.accountAcks[`seq:${barrier.accountEventSeq}`];
      if (docAck?.sent !== true || docAck.receipt?.logoutComplete !== true) reject(409, 'logout-ack-pending');
      const record = { witnessId: witness.witnessId, orderSeq: witness.orderSeq, utcMs: witness.utcMs ?? null };
      if (barrier.state === 'complete') {
        if (canonicalJson(barrier.logoutWitness) !== canonicalJson(record)) reject(409, 'logout-witness-mismatch');
        return structuredClone(barrier);
      }
      barrier.state = 'complete'; barrier.logoutWitness = record; barrier.completedAt = now();
      return structuredClone(barrier);
    });
  }
  async function statusForPrincipal(input, query) {
    const actor = await verify(input);
    if (query.authorityId !== ledger.authorityId) reject(409, 'wrong-authority');
    const p = projectOf(ledger.read(), query.projectId);
    if (p.bans[actor.accountId]) reject(403, 'banned');
    if (p.creatorAccountId !== actor.accountId && !p.members[actor.accountId]) reject(403, 'not-listed');
    return status(query);
  }
  async function flushAccountAcknowledgements() {
    await synchronize();
    const pending = [];
    for (const { event } of Object.values(ledger.read().accountEvents)) {
      const ackKey = `seq:${event.seq}`;
      let persisted = ledger.read().accountAcks[ackKey];
      if (persisted?.sent) continue;
      if (event.type === 'credentials-revoked' && !hasAgentReadClosure(ledger.read().barriers[`event:${event.eventId}`]?.accessEventId)) {
        pending.push(event.eventId); continue;
      }
      if (!persisted) {
        let receipt = { receiptId: `doc:${ledger.authorityId}:${event.seq}`, appliedSeq: event.seq, logoutComplete: false };
        if (event.type === 'credentials-revoked') {
          const barrier = revocationStatus(event.eventId);
          // No default empty connection enumeration: only an owner-wired real registry/fence verifier can release this.
          if (typeof getDocBarrier !== 'function' || typeof verifyDocBarrier !== 'function' ||
            services.some(service => !barrier.serviceAcks[service]?.complete || barrier.serviceAcks[service].cursor < barrier.accessSeq)) {
            pending.push(event.eventId); continue;
          }
          const proof = await getDocBarrier(structuredClone(barrier));
          if (!proof || proof.eventId !== event.eventId || proof.accountEventSeq !== event.seq || proof.pendingSeals !== 0 ||
            !Array.isArray(proof.connections) || !Number.isSafeInteger(proof.endCursor) || proof.endCursor < 0 ||
            !proof.clockEvidence || !proof.modifications || await verifyDocBarrier(proof, barrier) !== true) {
            pending.push(event.eventId); continue;
          }
          receipt = { ...receipt, logoutComplete: true, connections: proof.connections, endCursor: proof.endCursor,
            clockEvidence: proof.clockEvidence, modifications: proof.modifications,
            serviceAcks: Object.fromEntries(services.map(service => [service, {
              receiptId: barrier.serviceAcks[service].receiptId, appliedSeq: event.seq, logoutComplete: true,
              accessCursor: barrier.serviceAcks[service].cursor, closedStreams: barrier.serviceAcks[service].closedStreams,
              stoppedRuns: barrier.serviceAcks[service].stoppedRuns, rejectedCredentials: barrier.serviceAcks[service].rejectedCredentials,
            }])) };
        }
        persisted = ledger.transaction(state => {
          const accessEventId = state.barriers[`event:${event.eventId}`]?.accessEventId;
          const agentAck = state.accessAcks[`ack:${accessEventId}:agent`];
          if (event.type === 'credentials-revoked' && !agentReadClosureComplete(state, accessEventId, agentAck))
            reject(503, 'agent-read-closure-required');
          state.accountAcks[ackKey] ??= { eventId: event.eventId, receipt, sent: false,
            ...(state.agentReadControlRequired === true && event.type === 'credentials-revoked'
              ? { agentReadClosureDigest: agentAck.agentReadClosureDigest } : {}) };
          return state.accountAcks[ackKey];
        });
      }
      // Persist the exact receipt before network send. A lost response/restart replays the same request.
      const state = ledger.read(), accessEventId = state.barriers[`event:${event.eventId}`]?.accessEventId;
      if (event.type === 'credentials-revoked' && state.agentReadControlRequired === true &&
          (!agentReadClosureComplete(state, accessEventId, state.accessAcks[`ack:${accessEventId}:agent`]) ||
           !agentReadClosureComplete(state, accessEventId, persisted))) {
        // A legacy unsent outbox is retained, not rewritten into a new receipt.
        pending.push(event.eventId); continue;
      }
      await accountClient.ack(persisted.eventId, persisted.receipt);
      ledger.transaction(state => { state.accountAcks[ackKey].sent = true; });
    }
    return { pendingEvents: [...new Set(pending)], accountHead: ledger.read().accountHead };
  }
  function hasAgentReadClosure(eventId) {
    const state = ledger.read();
    return agentReadClosureComplete(state, eventId, state.accessAcks[`ack:${eventId}:agent`]);
  }
  return { authorityId: ledger.authorityId, synchronize, applyRevocation, applyRevocationNotification, authorizePrincipal, checkAccess,
    issueGuest, revokeGuest, sweepExpiredGuestProjects,
    createProject, joinProject, joinRequest, decideJoinRequest, entryState, adminProject, listProjects, status, statusForPrincipal, legacyGoneStatus, eventsSince, ackAccessEvent, hasAgentReadClosure, revocationStatus, completeLogoutBarrier, recordLogoutTimeout, flushAccountAcknowledgements,
    subscribeProjectChanges(callback) {
      if (typeof callback !== 'function') reject(400, 'invalid-subscription');
      projectSubscriptions.add(callback);
      return () => projectSubscriptions.delete(callback);
    },
    listActiveProjects() {
      return Object.values(ledger.read().projects).filter(p => p.status === 'active');
    },
    projectState(projectId) {
      const p = ledger.read().projects[projectId];
      return p && p.status === 'active' ? p : null;
    },
    /** 改密退出撤回用（只读）：这个事件号是不是一次「改密码后选了退出」、旧登录都已作废；是就回账号号、改密顺序号与旧登录。 */
    logoutRollbackEvent(eventId) {
      return typeof eventId === 'string' ? rollbackEventOf(ledger.read(), eventId) : null;
    },
    hasProject(projectId) {
      return typeof projectId === 'string' && Boolean(ledger.read().projects?.[projectId]);
    },
    subscribeRevocations(context, callback) {
      if (!context || typeof context !== 'object' || typeof callback !== 'function') reject(400, 'invalid-subscription');
      const entry = { context: structuredClone(context), callback }; subscriptions.add(entry); return () => subscriptions.delete(entry);
    },
    async start() {
      await synchronize();
      if (!timer && pollMs > 0) { timer = setInterval(() => synchronize().catch(error => onDiagnostic({ code: error.code ?? 'account-unavailable' })), pollMs); timer.unref(); }
      return { accountHead: ledger.read().accountHead };
    },
    close() { closed = true; ready = false; clearInterval(timer); refs.clear(); subscriptions.clear(); projectSubscriptions.clear(); },
  };
}
