// 0.7.18 验收补证据(conv 组)用的真实组合底座，只给 accept-018-conv-*.test.mjs 用。
//
// 真的：VisuHive 账号后端的库与凭证（要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT）、文档服务一侧的账号权限
//       (createAccountAuthority：建项目、加入、踢人、删项目、开关 Agent，同一份 SQLite 账本)、对话权威
//       (createConversationAuthority)、任务授权 (run-authority，经 run-authority-fixture 里的 Agent 实例签名)。
// 受控的：Agent 实例的传输通道（run-authority-fixture 里已有的受控通道）；同意提示与选区快照固定放行；
//         不起网络监听，不占任何端口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { runFixture, servicePrincipal } from './run-authority-fixture.mjs';
import { accountError } from '../account/client.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createConversationAuthority } from '../account/conversation-authority.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';
import { digestOf } from '../account/ledger.mjs';

export const providerRoot = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? '';
export const providerAvailable = Boolean(providerRoot) && fs.existsSync(path.join(providerRoot, 'account/store.mjs'));
export const skipReason = !providerAvailable && 'readonly account provider not available; set PROMPTCUT_ACCOUNT_PROVIDER_ROOT (VisuHive repo root)';
export { servicePrincipal };

const hex = n => randomBytes(n).toString('hex');
/** dir/key 只在「重启」时传：同一个目录、同一把凭证密钥，账本与账号库都从磁盘重新打开。 */
export async function startStack({ prefix = 'pc-accept018-conv-', dir: reuseDir = null, key: reuseKey = null } = {}) {
  const dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const key = reuseKey ?? randomBytes(32);
  const [storeModule, credentialModule] = await Promise.all(['store', 'credentials'].map(name =>
    import(pathToFileURL(path.join(providerRoot, `account/${name}.mjs`)).href)));
  const store = storeModule.openStore(path.join(dir, 'account.sqlite'));
  const credentials = credentialModule.createCredentials({ store, key });
  let authority;
  // 与 server/account/client.mjs 的 verify 同样的错误形状：缺令牌 401 login-required，令牌无效 401 credential-revoked。
  const verifyLikeClient = token => {
    if (typeof token !== 'string' || !token || token.length > 256) throw accountError(401, 'login-required');
    try { return credentials.verify(token); } catch { throw accountError(401, 'credential-revoked'); }
  };
  const f = await runFixture({ dir, verifySender: ref => credentials.verifyActorRef(ref),
    synchronize: () => authority.synchronize() });
  const keys = generateKeyPairSync('ed25519');
  authority = createAccountAuthority({ ledger: f.ledger, pollMs: 0, runHooks: f.provider.hooks,
    accountClient: { verify: async token => verifyLikeClient(token), events: async after => store.events(after) },
    initializeProject: async ({ projectId }) => ({ contentId: `content:${projectId}` }),
    authorityUrl: 'https://fixture.invalid/editor', signingKey: keys.privateKey, keyId: 'accept018-key' });
  await authority.start();

  let accountSerial = 0;
  /** 新账号：名字、编号，以及按设备登录的办法。 */
  function account(name) {
    const id = `acc_${hex(12)}`;
    if (!store.createAccount({ id, name, nameKey: name.toLowerCase(), pw: 'unusable-hash-fixture', now: Date.now() })) throw new Error('create-account');
    const logins = [];
    const login = (device = `device-${++accountSerial}`) => {
      const editor = credentials.createEditor({ account: store.accountById(id), deviceId: device, requestId: `login-${id}-${device}` });
      const entry = { accessToken: editor.accessToken, loginId: editor.loginId, device };
      logins.push(entry); return entry;
    };
    return { id, name, login, logins };
  }

  // 对话权威看到的是 Agent 身份：先用某个登录的令牌换出一份文档服务的不透明授权，之后每次核对都走真的账号权限。
  const refs = new Map();
  const conversationAuthority = createConversationAuthority({ ledger: f.ledger, runHooks: f.provider.hooks,
    accountAuthority: { authorizePrincipal: (ref, options) => authority.authorizePrincipal(ref, { ...options, trustedRole: 'agent' }) },
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal, projectId, selectionInput }) => ({ projectId, accountId: principal.accountId,
      pageId: selectionInput?.pageId ?? 'page_1', selection: selectionInput?.selection ?? { clipIds: [] }, sentAt: Date.now(), source: 'sent-snapshot' }),
    onFence: async value => ({ ack: true, ...value }) });

  /** 某个登录在某个项目里的对话权威入口。令牌第一次用时由文档服务核对并发出授权，之后同一份授权可重复使用。 */
  async function actor(projectId, entry) {
    const key = `${projectId}:${entry.loginId}`;
    if (!refs.has(key)) {
      const principal = await authority.authorizePrincipal({ accessToken: entry.accessToken }, { projectId, action: 'read', trustedRole: 'agent' });
      refs.set(key, { authorizationId: principal.authorizationId });
    }
    return refs.get(key);
  }
  const call = (method, projectId, entry, input) => actor(projectId, entry).then(principalRef =>
    conversationAuthority[method]({ principalRef, projectId, ...input }));
  const send = (projectId, entry, conversationId, requestId, content = 'hello') =>
    call('send', projectId, entry, { conversationId, requestId, content, selectionInput: { pageId: 'page_1', selection: { clipIds: [] } } });

  /** 创建者建项目、打开 Agent；成员凭令牌加入。 */
  const admin = async (projectId, creatorEntry, body) => {
    const before = await authority.authorizePrincipal({ accessToken: creatorEntry.accessToken }, { projectId });
    return authority.adminProject({ accessToken: creatorEntry.accessToken }, { projectId, expectedAccessRevision: before.accessRevision, requestId: `admin-${hex(6)}`, ...body });
  };
  async function project(creatorEntry, members = []) {
    const created = await authority.createProject({ accessToken: creatorEntry.accessToken }, { name: `accept018-${++accountSerial}`, requestId: `create-${hex(6)}`, initialProject: { cards: [] } });
    const projectId = created.projectId;
    await admin(projectId, creatorEntry, { op: 'set-hosted-service', service: 'agent', enabled: true });
    for (const entry of members) await authority.joinProject({ accessToken: entry.accessToken }, { projectId, requestId: `join-${hex(6)}` });
    return { projectId, admin: body => admin(projectId, creatorEntry, body) };
  }

  function close({ keepDir = false } = {}) {
    try { authority.close(); } catch { /* 已关 */ }
    try { f.close(); } catch { /* 已关 */ }
    try { store.close(); } catch { /* 已关 */ }
    if (!keepDir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
  /** 重启：账号库、账本、账号权限、对话权威、Agent 实例都关掉，同一个目录重新打开(Agent 实例拿到新的内存密钥)。 */
  const restart = () => { close({ keepDir: true }); return startStack({ dir, key }); };
  /** 给已有账号再开一个登录(用当前这一份账号库，重启之后也能用)。 */
  const loginAs = (acct, device) => {
    const editor = credentials.createEditor({ account: store.accountById(acct.id), deviceId: device, requestId: `login-${acct.id}-${device}` });
    return { accessToken: editor.accessToken, loginId: editor.loginId, device };
  };
  return { dir, key, loginAs, store, credentials, authority, conversationAuthority, f, account, project, admin, call, send, actor, close, restart,
    ledger: () => f.ledger.read() };
}

/** 取某个对话队首的一条消息开一轮任务(Agent 领取)，并按需确认 Agent 已读(read=false 时停在「已领取、未确认已读」)。 */
export async function startRun(s, projectId, conversationId, requestId, { read = true, prompt: tampered = null } = {}) {
  const g = await s.f.provider.admit({ servicePrincipal, projectId, conversationId, requestId });
  if (!g.runGrantId) throw new Error(`没有领到任务：${JSON.stringify(g)}`);
  if (!read) return g;
  const prompt = tampered ?? canonicalReadRecord(g.message, g);
  await s.f.provider.confirmRead({ servicePrincipal, projectId, conversationId, messageId: g.messageId, runId: g.runId, runGrantId: g.runGrantId,
    requestId: `read-${requestId}`, readIntentId: `intent-${requestId}`, prompt, promptDigest: digestOf(prompt) });
  return g;
}
export const finishRun = (s, projectId, conversationId, g, requestId) => s.f.provider.finish({ servicePrincipal, projectId, conversationId,
  messageId: g.messageId, runId: g.runId, runGrantId: g.runGrantId, requestId });
