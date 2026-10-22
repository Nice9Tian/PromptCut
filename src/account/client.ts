/** Account credentials live in RAM. Only the native vault owns desktop recovery. */
export interface Account { id: string; name: string; email?: string | null }
export interface EditorLogin { account: Account; loginId: string; accessToken: string; accessExpiresAt: number }
export interface ProjectSession {
  connectionTicket: string; assetTicket: string; agentDelegationTicket: string; expiresAt: number;
  projectId: string; creator: boolean; access: 'r' | 'rw'; accessRevision: number;
  /**
   * 托管方的服务在这个项目里的状态。`render`(托管方的渲染节点,带子选项「生成轨道流」)只有新的文档服务才报;
   * 旧文档服务不报这一项,页面上那两行就不显示(任务书 `docs/plan/render-refactor-task.md`「甲三」)。
   * `render.streamsAllowed`:创建者账号在不在 `render_streams` 权限分组(文档服务问账号服务得出);为 false 时「生成轨道流」置灰并提示。
   */
  hosted: { agent: { available: boolean; enabled: boolean; url: string | null }; render?: { available: boolean; enabled: boolean; streams?: boolean; streamsAllowed?: boolean } };
  linkToken?: string;
  hasSecondaryPassword?: boolean;
  needsSecondaryPassword?: boolean;
}
export interface CloudAgentConsent { accountId: string; accepted: boolean; noticeVersion: 1; acceptedAt?: number }
/** Keep the standard transport protocol alongside the opaque account credential. */
export function accountConnectionProtocols(session: ProjectSession): string[] { return ['promptcut.v1', `promptcut.account.${session.connectionTicket}`]; }
export interface CloudProject { projectId: string; name: string; authorityId: string; creatorAccountId?: string; url?: string }
export interface ProjectLists { owned: CloudProject[]; joined: CloudProject[] }
export interface AccountMembersSnapshot {
  v: 2; authorityId: string; projectId: string; accessRevision: number;
  self: { accountId: string; creator: boolean; access: 'r' | 'rw' }; creatorAccountId: string; allowLinkJoin: boolean;
  members: { accountId: string; accountName: string | null; access: 'r' | 'rw'; joinedAt: number | null }[];
  devices: { accountId: string; accountName: string | null; deviceId: string; deviceName: string; creator: boolean;
    conns: { role: 'page' | 'agent' | 'render'; service?: 'agent' | 'render'; conversation?: string | number }[] }[];
  bans?: { accountId: string; accountName: string | null; reason: 'kick' }[];
  /** 挂着的申请加入(只有创建者的投影里有),按申请时间从早到晚 */
  requests?: AccountJoinRequestRow[];
}
export interface AccountJoinRequestRow { accountId: string; joinRequestId: string; accountName: string | null; createdAt: number }
/** 踢人、解除禁入:按访问版本号防并发改动 */
export interface AccountKickOperation { op: 'kick' | 'unban'; accountId: string; expectedAccessRevision: number; requestId: string }
/** 「任何知道链接的人都可加入」勾选(只有创建者能改):同上按访问版本号 */
export interface AccountEntryOperation { op: 'set-entry'; allowLinkJoin: boolean; expectedAccessRevision: number; requestId: string }
/** 创建者「通过」「拒绝」一条申请:点名哪个账号的哪一条,不核访问版本号 */
export interface AccountJoinDecision { op: 'approve-join' | 'reject-join'; accountId: string; joinRequestId: string; requestId: string }
export type AccountMemberOperation = AccountKickOperation | AccountEntryOperation | AccountJoinDecision;
export type AccountMemberResult =
  | { eventId: string; accessRevision: number; completed: false; state: 'pending-services' }
  | { joinRequest: { accountId: string; joinRequestId: string; state: 'approved' | 'rejected' }; accessRevision: number };
/**
 * 申请人自己那一条(查状态、发申请都回它)。`state`:`none` 没申请过 / `pending` 等创建者 / `rejected` 被拒 / `member` 已是成员(含刚被通过);
 * `entry`:`list` 只放账号名单 / `link` 知道链接就能进;`canApply`:这个项目这边现在能不能再发;`retryAt`:次数用完时最早能再发的时刻
 */
export interface JoinRequestStatus { projectId: string; state: 'none' | 'pending' | 'rejected' | 'member'; entry: 'list' | 'link'; canApply: boolean; retryAt?: number }
/** 申请人等创建者处理时,多久问一次(毫秒);只在页面看得见时问 */
export const JOIN_REQUEST_POLL_MS = 10_000;
export class AccountFailure extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) { super(message || accountErrorText(status, code)); this.status = status; this.code = code; }
}
export function accountErrorText(status: number, code: string): string {
  const messages: Record<string, string> = { 'login-required': '请先登录账号。', 'credential-revoked': '登录已失效，请重新登录。',
    'bad-login': '账号或密码不正确。', 'name-taken': '这个项目名已被使用，请换一个名字。', 'banned': '你已被禁止加入这个项目。',
    'not-listed': '你不在这个项目的成员名单中。', 'project-gone': '这个云端项目已不存在。',
    'asset-unavailable': '素材服务暂时不可用，项目尚不能进入，请稍后重试。', 'session-unavailable': '项目会话暂时不可用，请稍后重试。',
    'desktop-bridge-unavailable': '请使用桌面版登录，或在官网打开在线编辑器。',
    'projects-unavailable': '暂时无法获取云端项目列表，请稍后重试。',
    'members-unavailable': '暂时无法获取项目成员，请稍后重试。', 'members-changed': '成员状态已变化，请刷新后重试。',
    'access-revision-mismatch': '成员状态已变化，请刷新并重新选择操作。', 'creator-required': '只有项目创建者可以管理成员。',
    'permission-denied': '你的账号没有开启这一项的权限，请联系托管方。', 'invalid-service': '这台云节点现在没有这个服务。',
    'invalid-option': '这台云节点现在没有这个选项。',
    // 申请加入与进入方式(2026-10-22 用户定,`workflow/project.md`「多用户协作」);code 与这句话的对照见报告 `AGENT-claude-join-requests.md`
    'no-project': '这个云端项目已不存在。', 'relocating': '这个项目正在搬迁，请稍后再试。',
    'entry-open': '这个项目现在知道链接就能加入，请直接加入。',
    'join-request-limit': '这个项目你最近申请得太多了，请过一段时间再申请。',
    'join-request-full': '这个项目等待处理的申请太多了，请稍后再申请。',
    'join-request-account-limit': '你最近发出的申请太多了，请过一段时间再申请。',
    'invalid-join-request': '申请信息不完整，请刷新后重试。', 'no-join-request': '这条申请已经不在了，请刷新。',
    'join-request-decided': '这条申请已经处理过了，请刷新。', 'join-request-banned': '这个账号已被禁入，要先在「已禁入的账号」里解除。',
    'already-member': '这个账号已经是项目成员。', 'invalid-entry': '进入方式的设置没有保存成功，请刷新后重试。',
    'invalid-member': '成员信息不完整，请刷新后重试。', 'request-mismatch': '这次操作和之前的记录对不上，请刷新后重试。',
    // 页面正常用不会碰到(请求号、项目号由页面自己生成或核过;身份字段页面不带),兜底也要是人话,不只显示代号
    'bad-request-id': '请求不完整，请刷新后重试。', 'invalid-authority-claim': '请求不完整，请刷新后重试。',
    'invalid-project': '请输入有效的云端项目链接。', 'invalid-role': '没有访问这个项目的权限。',
    'invalid-device': '这台设备的身份信息不对，请重新打开软件后再试。',
    // 项目设了二级密码而这个账号没输过当前这一版(新设、改过之后、刚被通过):进项目、续会话、读成员名单都回它。
    // 原来落到 403 的兜底「没有访问这个项目的权限。」,像是被移出了项目;要让人知道是要输这个项目的二级密码
    'secondary-password-required': '这个项目要输入项目二级密码才能进。请用项目链接加入，按提示输入二级密码。',
    'bad-secondary-password': '项目二级密码不正确。' };
  return messages[code] || (status === 401 ? '登录已失效，请重新登录。' : status === 503 ? '云端服务暂时不可用，请稍后重试。' : status === 403 ? '没有访问这个项目的权限。' : status === 0 ? '连接云端失败，请检查网络后重试。' : `请求失败（${code}）。`);
}
/** 在线页面一次账号请求最多等多久(桌面版走外壳的账号桥,那边自己有 20 秒的时限) */
export const REQUEST_TIMEOUT_MS = 20_000;
type Native = (operation: string, args?: Record<string, unknown>) => Promise<unknown>;
export interface AccountClientOptions { online: boolean; origin: string; device: { deviceId: string; deviceName: string }; fetch?: typeof fetch; native?: Native; now?: () => number }
export function projectIdFromLink(text: string, origin: string): string {
  const value = text.trim();
  let id = value;
  if (/^https?:/i.test(value)) {
    const url = new URL(value);
    if (url.origin !== new URL(origin).origin || url.username || url.password) throw new AccountFailure(400, 'wrong-project-origin', '这不是当前云端服务的项目链接。');
    id = url.searchParams.get('project') || '';
  }
  if (!/^(?:sp_[a-z2-7]{26}|[A-Za-z0-9_-]{8,64})$/.test(id)) throw new AccountFailure(400, 'invalid-project', '请输入有效的云端项目链接。');
  return id;
}
export function projectLink(origin: string, projectId: string, linkToken?: string): string {
  const u = new URL('/editor', new URL(origin).origin);
  u.searchParams.set('project', projectId);
  if (linkToken) u.searchParams.set('token', linkToken);
  return u.toString();
}
export function createAccountClient(options: AccountClientOptions) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  let login: EditorLogin | null = null, csrf = '', websiteAccount: Account | null = null;
  let renewTask: Promise<EditorLogin> | null = null;
  let authVersion = 0;
  const authListeners = new Set<() => void>();
  const authChanged = () => { authVersion++; for (const listener of [...authListeners]) listener(); };
  const authIdentity = () => login ? `${login.account.id}:${login.loginId}` : null;
  const native = async (operation: string, args: Record<string, unknown> = {}) => {
    if (!options.native) throw new AccountFailure(503, 'desktop-bridge-unavailable');
    return options.native(operation, args);
  };
  const check = (value: unknown): Record<string, any> => {
    if (!value || typeof value !== 'object') throw new AccountFailure(503, 'account-protocol');
    const result = value as Record<string, any>;
    if (result.ok !== true) throw new AccountFailure(Number(result.status) || 503, String(result.code || result.error || 'account-unavailable'));
    return result;
  };
  async function request(path: string, body?: unknown, token?: string) {
    if (!options.online) return check(await native('request', { path, ...(body !== undefined ? { body } : {}), ...(token ? { accessToken: token } : {}) }));
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (body !== undefined) headers['X-CSRF-Token'] = csrf;
    let response: Response;
    // 请求挂住不回(网络半断)时按连不上算:不设时限的话,等它的那一方(页面换连接、续会话)会一直卡着
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
    try { response = await fetcher(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', headers,
      credentials: token ? 'omit' : 'same-origin', cache: 'no-store', redirect: 'error', ...(signal ? { signal } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new AccountFailure(0, 'network'); }
    let result: Record<string, any>;
    try { result = await response.json(); } catch (error) { throw (error as { name?: string })?.name === 'TimeoutError' ? new AccountFailure(0, 'network') : new AccountFailure(response.status, 'account-protocol'); }
    if (!response.ok || result.ok !== true) throw new AccountFailure(response.status, String(result.code || result.error || 'account-unavailable'));
    return result;
  }
  function accept(value: Record<string, any>): EditorLogin {
    if (!value.account || !/^acc_[0-9a-f]{24}$/.test(value.account.id) || typeof value.account.name !== 'string' ||
      typeof value.loginId !== 'string' || !value.loginId || typeof value.accessToken !== 'string' || !value.accessToken ||
      !Number.isSafeInteger(value.accessExpiresAt) || value.accessExpiresAt <= now()) throw new AccountFailure(503, 'account-protocol');
    const before = authIdentity();
    login = { account: value.account, loginId: value.loginId, accessToken: value.accessToken, accessExpiresAt: value.accessExpiresAt };
    if (authIdentity() !== before) authChanged();
    return login;
  }
  async function website() { const value = await request('/api/account/me'); csrf = value.csrfToken || ''; websiteAccount = value.account ?? null; return websiteAccount; }
  /** `minRemainingMs`:手里的访问令牌至少还要剩这么久,不够就先续(缺省 10 秒;页面换连接时要一张寿命足够的票据,会给得更大) */
  async function ensureLogin(minRemainingMs = 10_000): Promise<EditorLogin> {
    if (login && login.accessExpiresAt > now() + minRemainingMs) return login;
    if (renewTask) return renewTask;
    renewTask = (async () => {
      if (!options.online) return accept(check(await native('recover', options.device)));
      if (!await website()) { if (login) { login = null; authChanged(); } throw new AccountFailure(401, 'login-required'); }
      // Existing editor login must be renewed explicitly; revocation cannot become a fresh login.
      return accept(await request(`/api/account/editor/${login ? 'renew' : 'session'}`, {
        ...options.device, requestId: crypto.randomUUID(), ...(login ? { loginId: login.loginId } : {}) }));
    })().finally(() => { renewTask = null; });
    return renewTask;
  }
  return {
    get account() { return login?.account ?? websiteAccount; },
    get authVersion() { return authVersion; },
    subscribeAuth(listener: () => void) { authListeners.add(listener); return () => { authListeners.delete(listener); }; },
    async restore() { if (options.online) { await website(); if (!websiteAccount) return null; return (await ensureLogin()).account; }
      const value = await native('recover', options.device); if (value === null) return null; return accept(check(value)).account; },
    async login(identifier: string, password: string, remember: boolean, requestId: string = crypto.randomUUID()) {
      if (!options.online) return accept(check(await native('login', { ...options.device, name: identifier, password, requestId }))).account;
      await website(); const value = await request('/api/account/login', { name: identifier, password, remember });
      csrf = value.csrfToken || ''; websiteAccount = value.account; login = null; authChanged();
      return (await ensureLogin()).account;
    },
    async logout() {
      if (options.online) { await website(); await request('/api/account/logout', {}); }
      else {
        const value = await native('logout', { ...(login ? { accessToken: login.accessToken } : {}) });
        // Native401 is a confirmed terminal state: the bridge removes its vault.
        // Other failures preserve RAM/UI state and propagate to the visible error.
        if (!value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 401) check(value);
      }
      login = null; websiteAccount = null; authChanged();
    },
    async cloudAgentConsent(): Promise<CloudAgentConsent> {
      const current = await ensureLogin();
      const identity = authIdentity(), revision = authVersion;
      if (options.online && (await website())?.id !== current.account.id) throw new AccountFailure(401, 'credential-revoked');
      const result = await request('/api/account/cloud-agent-consent', undefined, options.online ? undefined : current.accessToken);
      if (authIdentity() !== identity || authVersion !== revision) throw new AccountFailure(401, 'credential-revoked');
      return validateConsent(result, current.account.id);
    },
    async acceptCloudAgentConsent(requestId: string = crypto.randomUUID()): Promise<CloudAgentConsent> {
      const current = await ensureLogin();
      const identity = authIdentity(), revision = authVersion;
      if (options.online && (await website())?.id !== current.account.id) throw new AccountFailure(401, 'credential-revoked');
      const result = await request('/api/account/cloud-agent-consent', { accept: true, noticeVersion: 1, requestId }, options.online ? undefined : current.accessToken);
      if (authIdentity() !== identity || authVersion !== revision) throw new AccountFailure(401, 'credential-revoked');
      const consent = validateConsent(result, current.account.id);
      if (!consent.accepted) throw new AccountFailure(503, 'account-protocol');
      return consent;
    },
    async lists(): Promise<ProjectLists> { if (!options.online) throw new AccountFailure(503, 'website-project-list', '请在官网登录，查看“我创建的”和“我加入的”项目。');
      await website(); const result = await request('/api/account/projects');
      if (!Array.isArray(result.owned) || !Array.isArray(result.joined)) throw new AccountFailure(503, 'account-protocol');
      return { owned: result.owned, joined: result.joined }; },
    async create(name: string, initialProject: unknown, requestId: string, opts?: { projectId?: string; rev?: number; history?: unknown[] }): Promise<{ projectId: string; authorityId: string }> {
      const current = await ensureLogin();
      const body = {
        name,
        initialProject,
        allowLinkJoin: true,
        requestId,
        ...(opts?.projectId ? { projectId: opts.projectId } : {}),
        ...(opts?.rev ? { rev: opts.rev } : {}),
        ...(opts?.history ? { history: opts.history } : {}),
      };
      return await request('/hosted/shared/account/create', body, current.accessToken) as any;
    },
    async regenProjectLink(projectId: string, expectedAccessRevision: number, requestId: string): Promise<{ eventId: string; accessRevision: number; linkToken: string }> {
      const current = await ensureLogin();
      const out = await request('/hosted/shared/account/admin', {
        projectId,
        op: 'regen-link',
        expectedAccessRevision,
        requestId,
      }, current.accessToken);
      return out as any;
    },
    /**
     * 创建者删除云端项目(`op: "delete"`,与网站和项目设置的「删除项目」同一个接口)。同一个请求号重放回原结果;
     * 项目已经删了再用新请求号删,云端回 404 `no-project`。现在只有「放弃这次搬迁」用(`accountMoveFlow.ts`,〔裁〕H04)
     */
    async deleteProject(projectId: string, expectedAccessRevision: number, requestId: string): Promise<{ eventId: string; accessRevision: number }> {
      const current = await ensureLogin(), identity = authIdentity(), revision = authVersion;
      const out = await request('/hosted/shared/account/admin', { projectId, op: 'delete', expectedAccessRevision, requestId }, current.accessToken);
      if (identity !== authIdentity() || revision !== authVersion) throw new AccountFailure(401, 'credential-revoked');
      if (typeof out.eventId !== 'string' || !out.eventId || !Number.isSafeInteger(out.accessRevision)) throw new AccountFailure(503, 'account-protocol');
      return { eventId: out.eventId, accessRevision: out.accessRevision };
    },
    async setSecondaryPassword(projectId: string, password: string | null, expectedAccessRevision: number, requestId: string): Promise<{ eventId: string; accessRevision: number; hasSecondaryPassword: boolean }> {
      const current = await ensureLogin();
      const out = await request('/hosted/shared/account/admin', {
        projectId,
        op: 'set-secondary-password',
        password,
        expectedAccessRevision,
        requestId,
      }, current.accessToken);
      return out as any;
    },
    async setAgentEnabled(projectId: string, enabled: boolean, expectedAccessRevision: number, requestId: string) {
      const current = await ensureLogin();
      const out = await request('/hosted/shared/account/admin', { projectId, enabled, expectedAccessRevision, requestId,
        op: 'set-hosted-service', service: 'agent' }, current.accessToken);
      if (typeof out.eventId !== 'string' || !Number.isSafeInteger(out.accessRevision) || out.completed !== false || out.state !== 'pending-services')
        throw new AccountFailure(503, 'account-protocol');
      return { eventId: out.eventId as string, accessRevision: out.accessRevision as number, completed: false as const };
    },
    /** 创建者开关托管方的服务(云端 Agent、托管方的渲染节点)。服务端按登录与创建者身份把关,成员调用回 403 */
    async setHostedService(projectId: string, service: 'agent' | 'render', enabled: boolean, expectedAccessRevision: number, requestId: string) {
      const current = await ensureLogin();
      const out = await request('/hosted/shared/account/admin', { projectId, enabled, expectedAccessRevision, requestId,
        op: 'set-hosted-service', service }, current.accessToken);
      if (typeof out.eventId !== 'string' || !Number.isSafeInteger(out.accessRevision) || out.completed !== false || out.state !== 'pending-services')
        throw new AccountFailure(503, 'account-protocol');
      return { eventId: out.eventId as string, accessRevision: out.accessRevision as number, completed: false as const };
    },
    /** 创建者改托管方服务下面的子选项(渲染节点的「生成轨道流」)。同上,成员调用回 403 */
    async setHostedOption(projectId: string, service: 'render', option: 'streams', enabled: boolean, expectedAccessRevision: number, requestId: string) {
      const current = await ensureLogin();
      const out = await request('/hosted/shared/account/admin', { projectId, enabled, expectedAccessRevision, requestId,
        op: 'set-hosted-option', service, option }, current.accessToken);
      if (typeof out.eventId !== 'string' || !Number.isSafeInteger(out.accessRevision) || out.completed !== false || out.state !== 'pending-services')
        throw new AccountFailure(503, 'account-protocol');
      return { eventId: out.eventId as string, accessRevision: out.accessRevision as number, completed: false as const };
    },
    async members(projectId: string): Promise<AccountMembersSnapshot> {
      const current = await ensureLogin(), identity = authIdentity(), revision = authVersion;
      const value = await request('/hosted/shared/account/members', { projectId }, current.accessToken);
      if (identity !== authIdentity() || revision !== authVersion) throw new AccountFailure(401, 'credential-revoked');
      return validateMembers(value, projectId, current.account.id);
    },
    /**
     * 创建者的成员操作,都走 `/hosted/shared/account/admin`:踢人、解除禁入、改「任何知道链接的人都可加入」勾选(`set-entry`)、
     * 「通过」「拒绝」申请(`approve-join` / `reject-join`)。请求体按白名单拼,不带页面上别的东西;回包按操作逐项核。
     * 回包没收到(网络断)时,用同一个请求号再发一次,服务端认得出是同一次
     */
    async memberAdmin(projectId: string, operation: AccountMemberOperation): Promise<AccountMemberResult> {
      const okRequest = typeof operation.requestId === 'string' && !!operation.requestId && operation.requestId.length <= 128;
      const okRevision = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
      let body: Record<string, unknown>;
      if (operation.op === 'kick' || operation.op === 'unban') {
        if (!/^acc_[a-f0-9]{24}$/.test(operation.accountId) || !okRevision(operation.expectedAccessRevision) || !okRequest) throw new AccountFailure(400, 'invalid-member');
        body = { projectId, op: operation.op, accountId: operation.accountId, expectedAccessRevision: operation.expectedAccessRevision, requestId: operation.requestId };
      } else if (operation.op === 'set-entry') {
        if (typeof operation.allowLinkJoin !== 'boolean' || !okRevision(operation.expectedAccessRevision) || !okRequest) throw new AccountFailure(400, 'invalid-entry');
        body = { projectId, op: 'set-entry', allowLinkJoin: operation.allowLinkJoin, expectedAccessRevision: operation.expectedAccessRevision, requestId: operation.requestId };
      } else if (operation.op === 'approve-join' || operation.op === 'reject-join') {
        if (!/^acc_[a-f0-9]{24}$/.test(operation.accountId) || !/^jr_[a-f0-9]{24}$/.test(operation.joinRequestId) || !okRequest) throw new AccountFailure(400, 'invalid-join-request');
        body = { projectId, op: operation.op, accountId: operation.accountId, joinRequestId: operation.joinRequestId, requestId: operation.requestId };
      } else throw new AccountFailure(400, 'invalid-member');
      const current = await ensureLogin(), identity = authIdentity(), revision = authVersion;
      const value = await request('/hosted/shared/account/admin', body, current.accessToken);
      if (identity !== authIdentity() || revision !== authVersion) throw new AccountFailure(401, 'credential-revoked');
      if (operation.op === 'approve-join' || operation.op === 'reject-join') {
        const decided = value.joinRequest, state = operation.op === 'approve-join' ? 'approved' : 'rejected';
        if (!decided || decided.accountId !== operation.accountId || decided.joinRequestId !== operation.joinRequestId || decided.state !== state ||
            !okRevision(value.accessRevision)) throw new AccountFailure(503, 'account-protocol');
        return { joinRequest: { accountId: operation.accountId, joinRequestId: operation.joinRequestId, state }, accessRevision: value.accessRevision };
      }
      if (typeof value.eventId !== 'string' || !value.eventId || !okRevision(value.accessRevision) ||
          value.completed !== false || value.state !== 'pending-services') throw new AccountFailure(503, 'account-protocol');
      return { eventId: value.eventId, accessRevision: value.accessRevision, completed: false, state: 'pending-services' };
    },
    /**
     * 申请加入,申请人这一侧:查自己那一条。走 `/hosted/shared/account/join`(带 `joinRequest`,不进项目、不发票据);
     * 不另开路由,桌面外壳的账号桥只放行 create / join / session / admin / members 五条
     */
    async joinRequestStatus(projectId: string): Promise<JoinRequestStatus> {
      const current = await ensureLogin(), identity = authIdentity(), revision = authVersion;
      const value = await request('/hosted/shared/account/join', { projectId, joinRequest: 'status' }, current.accessToken);
      if (identity !== authIdentity() || revision !== authVersion) throw new AccountFailure(401, 'credential-revoked');
      return validateJoinRequest(value, projectId);
    },
    /** 发申请。同一次「发送申请」的重试用同一个请求号(服务端不会因此多记一次) */
    async sendJoinRequest(projectId: string, requestId: string): Promise<JoinRequestStatus> {
      if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw new AccountFailure(400, 'invalid-join-request');
      const current = await ensureLogin(), identity = authIdentity(), revision = authVersion;
      const value = await request('/hosted/shared/account/join', { projectId, requestId, joinRequest: 'send' }, current.accessToken);
      if (identity !== authIdentity() || revision !== authVersion) throw new AccountFailure(401, 'credential-revoked');
      return validateJoinRequest(value, projectId);
    },
    async join(projectId: string, requestId: string, joinOpts?: { token?: string; linkToken?: string; secondaryPassword?: string }): Promise<ProjectSession> {
      const current = await ensureLogin();
      const token = joinOpts?.token ?? joinOpts?.linkToken;
      const body = {
        projectId,
        deviceId: options.device.deviceId,
        requestId,
        ...(token ? { token, linkToken: token } : {}),
        ...(joinOpts?.secondaryPassword ? { secondaryPassword: joinOpts.secondaryPassword } : {}),
      };
      return validateSession(await request('/hosted/shared/account/join', body, current.accessToken), now(), projectId);
    },
    async session(projectId: string, { minRemainingMs }: { minRemainingMs?: number } = {}): Promise<ProjectSession> { const current = await ensureLogin(minRemainingMs); return validateSession(await request('/hosted/shared/account/session', { projectId, deviceId: options.device.deviceId, requestId: crypto.randomUUID() }, current.accessToken), now(), projectId); },
  };
}
function validateJoinRequest(value: Record<string, any>, projectId: string): JoinRequestStatus {
  const jr = value.joinRequest;
  if (value.projectId !== projectId || !jr || typeof jr !== 'object' || !['none', 'pending', 'rejected', 'member'].includes(jr.state) ||
      !['list', 'link'].includes(jr.entry) || typeof jr.canApply !== 'boolean' ||
      (jr.retryAt !== undefined && (!Number.isSafeInteger(jr.retryAt) || jr.retryAt < 0))) throw new AccountFailure(503, 'account-protocol');
  return { projectId, state: jr.state, entry: jr.entry, canApply: jr.canApply, ...(jr.retryAt !== undefined ? { retryAt: jr.retryAt } : {}) };
}
function validateMembers(value: Record<string, any>, projectId: string, accountId: string): AccountMembersSnapshot {
  const bad = () => { throw new AccountFailure(503, 'account-protocol'); };
  const id = (x: unknown) => typeof x === 'string' && /^acc_[a-f0-9]{24}$/.test(x);
  const name = (x: unknown) => x === null || (typeof x === 'string' && x.length > 0 && x.length <= 200 && !/[\u0000-\u001f]/.test(x));
  const access = (x: unknown) => x === 'r' || x === 'rw';
  if (value.v !== 2 || value.projectId !== projectId || typeof value.authorityId !== 'string' || !value.authorityId ||
      !Number.isSafeInteger(value.accessRevision) || value.accessRevision < 0 || !id(value.creatorAccountId) || typeof value.allowLinkJoin !== 'boolean' ||
      value.self?.accountId !== accountId || typeof value.self.creator !== 'boolean' || !access(value.self.access) ||
      value.self.creator !== (value.creatorAccountId === accountId) ||
      !Array.isArray(value.members) || !Array.isArray(value.devices) || value.members.length > 10000 || value.devices.length > 10000 ||
      (value.bans !== undefined && (!value.self.creator || !Array.isArray(value.bans) || value.bans.length > 10000)) ||
      (value.requests !== undefined && (!value.self.creator || !Array.isArray(value.requests) || value.requests.length > 10000))) bad();
  const memberIds = new Set<string>(), devices = new Set<string>(), bans = new Set<string>();
  const members = value.members.map((row: any) => {
    if (!id(row?.accountId) || memberIds.has(row.accountId) || !name(row.accountName) || !access(row.access) ||
        !(row.joinedAt === null || (Number.isSafeInteger(row.joinedAt) && row.joinedAt >= 0))) bad();
    memberIds.add(row.accountId);
    return { accountId: row.accountId, accountName: row.accountName, access: row.access, joinedAt: row.joinedAt };
  });
  if (!memberIds.has(accountId) || !memberIds.has(value.creatorAccountId)) bad();
  const rows = value.devices.map((row: any) => {
    const key = `${row?.accountId}\n${row?.deviceId}`;
    if (!memberIds.has(row?.accountId) || devices.has(key) || !name(row.accountName) ||
        typeof row.deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(row.deviceId) ||
        typeof row.deviceName !== 'string' || !row.deviceName || row.deviceName.length > 200 ||
        row.creator !== (row.accountId === value.creatorAccountId) || !Array.isArray(row.conns) || row.conns.length > 10000) bad();
    devices.add(key);
    const conns = row.conns.map((conn: any) => {
      if (!['page', 'agent', 'render'].includes(conn?.role) || (conn.service !== undefined && !['agent', 'render'].includes(conn.service)) ||
          (conn.conversation !== undefined && !((typeof conn.conversation === 'string' && conn.conversation.length <= 200) ||
            (Number.isSafeInteger(conn.conversation) && conn.conversation >= 0)))) bad();
      return { role: conn.role, ...(conn.service !== undefined ? { service: conn.service } : {}),
        ...(conn.conversation !== undefined ? { conversation: conn.conversation } : {}) };
    });
    return { accountId: row.accountId, accountName: row.accountName, deviceId: row.deviceId, deviceName: row.deviceName, creator: row.creator, conns };
  });
  const banned = value.bans?.map((row: any) => {
    if (!id(row?.accountId) || bans.has(row.accountId) || memberIds.has(row.accountId) || !name(row.accountName) || row.reason !== 'kick') bad();
    bans.add(row.accountId); return { accountId: row.accountId, accountName: row.accountName, reason: 'kick' as const };
  });
  // 申请:只给创建者;一个账号一条;不能同时是成员或已被禁入;字段只收这四样
  const requested = new Set<string>();
  const requests = value.requests?.map((row: any) => {
    if (!id(row?.accountId) || requested.has(row.accountId) || memberIds.has(row.accountId) || bans.has(row.accountId) ||
        typeof row.joinRequestId !== 'string' || !/^jr_[a-f0-9]{24}$/.test(row.joinRequestId) || !name(row.accountName) ||
        !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) bad();
    requested.add(row.accountId);
    return { accountId: row.accountId, joinRequestId: row.joinRequestId, accountName: row.accountName, createdAt: row.createdAt };
  });
  return { v: 2, projectId, authorityId: value.authorityId, accessRevision: value.accessRevision,
    self: { accountId, creator: value.self.creator, access: value.self.access }, creatorAccountId: value.creatorAccountId,
    allowLinkJoin: value.allowLinkJoin, members, devices: rows, ...(banned !== undefined ? { bans: banned } : {}),
    ...(requests !== undefined ? { requests } : {}) };
}
function validateConsent(value: Record<string, any>, accountId: string): CloudAgentConsent {
  if (value.accountId !== accountId || value.noticeVersion !== 1 || typeof value.accepted !== 'boolean' ||
    (value.acceptedAt !== undefined && !Number.isSafeInteger(value.acceptedAt))) throw new AccountFailure(503, 'account-protocol');
  return { accountId, accepted: value.accepted, noticeVersion: 1, ...(value.acceptedAt !== undefined ? { acceptedAt: value.acceptedAt } : {}) };
}
function validateSession(value: Record<string, any>, now: number, projectId: string): ProjectSession {
  const agent = value.hosted?.agent;
  if (!['connectionTicket', 'assetTicket', 'agentDelegationTicket'].every(k => typeof value[k] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value[k])) ||
    !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.projectId !== projectId ||
    typeof value.creator !== 'boolean' || !['r', 'rw'].includes(value.access) || !Number.isSafeInteger(value.accessRevision) || value.accessRevision < 0 ||
    !agent || typeof agent.available !== 'boolean' || typeof agent.enabled !== 'boolean' ||
    !(agent.url === null || (typeof agent.url === 'string' && /^https?:\/\//.test(agent.url)))) throw new AccountFailure(503, 'session-unavailable');
  // 渲染节点那一项:新的文档服务才报;形状对才收(两个布尔,子选项是布尔才带),旧文档服务没有它,页面上那两行不显示
  const r = value.hosted?.render;
  const render = r && typeof r === 'object' && typeof r.available === 'boolean' && typeof r.enabled === 'boolean'
    ? { available: r.available as boolean, enabled: r.enabled as boolean, ...(typeof r.streams === 'boolean' ? { streams: r.streams as boolean } : {}),
      // 权限分组的结论也要带上:原来这里漏收,账号项目的「生成轨道流」在创建者不在分组时不置灰、不提示(2026-10-20 在线实测)
      ...(typeof r.streamsAllowed === 'boolean' ? { streamsAllowed: r.streamsAllowed as boolean } : {}) } : null;
  return { connectionTicket: value.connectionTicket, assetTicket: value.assetTicket, agentDelegationTicket: value.agentDelegationTicket,
    expiresAt: value.expiresAt, projectId, creator: value.creator, access: value.access, accessRevision: value.accessRevision,
    hosted: { agent: { available: agent.available, enabled: agent.enabled, url: agent.url }, ...(render ? { render } : {}) },
    ...(typeof value.linkToken === 'string' ? { linkToken: value.linkToken } : {}),
    ...(typeof value.hasSecondaryPassword === 'boolean' ? { hasSecondaryPassword: value.hasSecondaryPassword } : {}),
    ...(typeof value.needsSecondaryPassword === 'boolean' ? { needsSecondaryPassword: value.needsSecondaryPassword } : {}) };
}
export type CloudAccountClient = ReturnType<typeof createAccountClient>;
