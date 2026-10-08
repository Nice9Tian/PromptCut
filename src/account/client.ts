/** Account credentials live in RAM. Only the native vault owns desktop recovery. */
export interface Account { id: string; name: string; email?: string | null }
export interface EditorLogin { account: Account; loginId: string; accessToken: string; accessExpiresAt: number }
export interface ProjectSession { connectionTicket: string; assetTicket: string; expiresAt: number }
export interface CloudProject { projectId: string; name: string; authorityId: string; creatorAccountId?: string; url?: string }
export interface ProjectLists { owned: CloudProject[]; joined: CloudProject[] }
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
    'projects-unavailable': '暂时无法获取云端项目列表，请稍后重试。' };
  return messages[code] || (status === 401 ? '登录已失效，请重新登录。' : status === 503 ? '云端服务暂时不可用，请稍后重试。' : status === 403 ? '没有访问这个项目的权限。' : status === 0 ? '连接云端失败，请检查网络后重试。' : `请求失败（${code}）。`);
}
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
  if (!/^sp_[a-z2-7]{26}$/.test(id)) throw new AccountFailure(400, 'invalid-project', '请输入有效的云端项目链接。');
  return id;
}
export function projectLink(origin: string, projectId: string): string { return `${new URL(origin).origin}/editor?project=${encodeURIComponent(projectId)}`; }
export function createAccountClient(options: AccountClientOptions) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  let login: EditorLogin | null = null, csrf = '', websiteAccount: Account | null = null;
  let renewTask: Promise<EditorLogin> | null = null;
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
    try { response = await fetcher(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', headers,
      credentials: token ? 'omit' : 'same-origin', cache: 'no-store', redirect: 'error', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new AccountFailure(0, 'network'); }
    let result: Record<string, any>;
    try { result = await response.json(); } catch { throw new AccountFailure(response.status, 'account-protocol'); }
    if (!response.ok || result.ok !== true) throw new AccountFailure(response.status, String(result.code || result.error || 'account-unavailable'));
    return result;
  }
  function accept(value: Record<string, any>): EditorLogin {
    if (!value.account || !/^acc_[0-9a-f]{24}$/.test(value.account.id) || typeof value.account.name !== 'string' ||
      typeof value.loginId !== 'string' || !value.loginId || typeof value.accessToken !== 'string' || !value.accessToken ||
      !Number.isSafeInteger(value.accessExpiresAt) || value.accessExpiresAt <= now()) throw new AccountFailure(503, 'account-protocol');
    login = { account: value.account, loginId: value.loginId, accessToken: value.accessToken, accessExpiresAt: value.accessExpiresAt };
    return login;
  }
  async function website() { const value = await request('/api/account/me'); csrf = value.csrfToken || ''; websiteAccount = value.account ?? null; return websiteAccount; }
  async function ensureLogin(): Promise<EditorLogin> {
    if (login && login.accessExpiresAt > now() + 10_000) return login;
    if (renewTask) return renewTask;
    renewTask = (async () => {
      if (!options.online) return accept(check(await native('recover', options.device)));
      if (!await website()) { login = null; throw new AccountFailure(401, 'login-required'); }
      // Existing editor login must be renewed explicitly; revocation cannot become a fresh login.
      return accept(await request(`/api/account/editor/${login ? 'renew' : 'session'}`, {
        ...options.device, requestId: crypto.randomUUID(), ...(login ? { loginId: login.loginId } : {}) }));
    })().finally(() => { renewTask = null; });
    return renewTask;
  }
  return {
    get account() { return login?.account ?? websiteAccount; },
    async restore() { if (options.online) { await website(); if (!websiteAccount) return null; return (await ensureLogin()).account; }
      const value = await native('recover', options.device); if (value === null) return null; return accept(check(value)).account; },
    async login(identifier: string, password: string, remember: boolean, requestId: string = crypto.randomUUID()) {
      if (!options.online) return accept(check(await native('login', { ...options.device, name: identifier, password, requestId }))).account;
      await website(); const value = await request('/api/account/login', { name: identifier, password, remember });
      csrf = value.csrfToken || ''; websiteAccount = value.account; login = null;
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
      login = null; websiteAccount = null;
    },
    async lists(): Promise<ProjectLists> { if (!options.online) throw new AccountFailure(503, 'website-project-list', '请在官网登录，查看“我创建的”和“我加入的”项目。');
      await website(); const result = await request('/api/account/projects');
      if (!Array.isArray(result.owned) || !Array.isArray(result.joined)) throw new AccountFailure(503, 'account-protocol');
      return { owned: result.owned, joined: result.joined }; },
    async create(name: string, initialProject: unknown, requestId: string): Promise<{ projectId: string; authorityId: string }> {
      const current = await ensureLogin(); return await request('/hosted/shared/account/create', { name, initialProject, allowLinkJoin: true, requestId }, current.accessToken) as any;
    },
    async join(projectId: string, requestId: string): Promise<ProjectSession> { const current = await ensureLogin(); return validateSession(await request('/hosted/shared/account/join', { projectId, deviceId: options.device.deviceId, requestId }, current.accessToken), now()); },
    async session(projectId: string): Promise<ProjectSession> { const current = await ensureLogin(); return validateSession(await request('/hosted/shared/account/session', { projectId, deviceId: options.device.deviceId, requestId: crypto.randomUUID() }, current.accessToken), now()); },
  };
}
function validateSession(value: Record<string, any>, now: number): ProjectSession {
  if (!['connectionTicket', 'assetTicket'].every(k => typeof value[k] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value[k])) ||
    !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) throw new AccountFailure(503, 'session-unavailable');
  return { connectionTicket: value.connectionTicket, assetTicket: value.assetTicket, expiresAt: value.expiresAt };
}
export type CloudAccountClient = ReturnType<typeof createAccountClient>;
