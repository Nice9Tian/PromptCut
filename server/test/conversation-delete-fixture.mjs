import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createConversationAuthority, claimNextInState } from '../account/conversation-authority.mjs';

/** 云端对话删除相关测试共用的文档权威夹具：真的 SQLite 账本、真的对话权威，停任务的围栏与 Agent 确认是受控的替身 */
export const projectId = 'sp_' + 'a'.repeat(26);
export const otherProjectId = 'sp_' + 'z'.repeat(26);
export const ownerId = 'acc_' + 'a'.repeat(24);
export const memberId = 'acc_' + 'b'.repeat(24);
export const creatorId = 'acc_' + 'c'.repeat(24);
export const bystanderId = 'acc_' + 'd'.repeat(24);
export const readerId = 'acc_' + 'e'.repeat(24);
export const names = { [ownerId]: 'Owner', [memberId]: 'Member', [creatorId]: 'Creator', [bystanderId]: 'Bystander', [readerId]: 'Reader' };

export function fixture() {
  let clock = 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-conv-delete-'));
  const file = path.join(dir, 'authority.sqlite');
  const ledger = openAccountLedger({ file, authorityId: 'conversation-delete-test' });
  ledger.transaction(state => {
    const members = Object.fromEntries([ownerId, memberId, creatorId, bystanderId].map(id => [id, { access: 'rw' }]));
    members[readerId] = { access: 'r' };
    state.projects[projectId] = { projectId, status: 'active', creatorAccountId: creatorId, hosted: { agent: true }, bans: {}, members };
    state.projects[otherProjectId] = { projectId: otherProjectId, status: 'active', creatorAccountId: creatorId, hosted: { agent: true }, bans: {},
      members: { [ownerId]: { access: 'rw' }, [creatorId]: { access: 'rw' } } };
  });
  const principals = {};
  for (const id of Object.keys(names)) for (const pid of [projectId, otherProjectId]) principals[`auth:${id}:${pid}`] = { authorizationId: `auth:${id}:${pid}`,
    projectId: pid, accountId: id, loginId: `login:${id}`, credentialId: `cred:${id}`, loginGeneration: 1, username: names[id] };
  const accountAuthority = { async authorizePrincipal(ref, { projectId: requested, action }) {
    const principal = principals[ref.authorizationId];
    if (!principal || principal.projectId !== requested) throw Object.assign(new Error('login-required'), { status: 401, code: 'principal-mismatch' });
    if (ledger.read().revokedLogins[`login:${principal.loginId}`]) throw Object.assign(new Error('revoked'), { status: 401, code: 'credential-revoked' });
    const project = ledger.read().projects[requested];
    if (action === 'write' && project.members[principal.accountId]?.access !== 'rw') throw Object.assign(new Error('readonly'), { status: 403, code: 'not-listed' });
    return structuredClone(principal);
  } };
  // 受控的「停任务」口子:fenced 记下收到的围栏;stopClears=false 模拟任务进程还没关干净(围栏还在办)
  const control = { fenced: [], stopClears: true, ackError: null, ackMissing: false, onFenceCalls: [], afterAck: null };
  const runHooks = { fenceInState(state, input) {
    control.fenced.push(structuredClone(input));
    if (input.kind !== 'stop' || !control.stopClears) return;
    const conv = state.conversationsV2[input.projectId][input.conversationId];
    const message = conv.messages.find(m => m.runId === input.runId);
    if (message) { message.queueState = 'cancelled'; message.reason = 'stop'; }
    conv.currentRunId = null;
  } };
  const options = { ledger, accountAuthority, runHooks, now: () => clock,
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal, projectId: id }) => ({ projectId: id, accountId: principal.accountId,
      pageId: 'page_123', selection: { clipIds: [] }, sentAt: 100, source: 'sent-snapshot' }),
    async onFence(input) {
      control.onFenceCalls.push(input);
      if (control.ackError) throw control.ackError;
      control.afterAck?.();
      return control.ackMissing ? { ack: false } : { ack: true, ...input };
    } };
  const authority = createConversationAuthority(options);
  const ref = (accountId, pid = projectId) => ({ authorizationId: `auth:${accountId}:${pid}` });
  const send = (accountId, conversationId, requestId, content = 'hello', pid = projectId) => authority.send({ principalRef: ref(accountId, pid),
    projectId: pid, conversationId, requestId, content, selectionInput: { pageId: 'page_123', selection: { clipIds: [] } } });
  const remove = (accountId, conversationId, requestId = `del-${conversationId}`, pid = projectId) => authority.remove({
    principalRef: ref(accountId, pid), projectId: pid, conversationId, requestId });
  const notices = accountId => authority.notices({ principalRef: ref(accountId), projectId });
  const list = accountId => authority.list({ principalRef: ref(accountId), projectId });
  /** 把一条消息领成正在跑的一轮(runId 固定),用来造「对话里有任务在跑」 */
  const startRun = (conversationId, runId = 'run1') => ledger.transaction(state => {
    const conv = state.conversationsV2[projectId][conversationId];
    const first = conv.messages.find(m => m.queueState === 'queued');
    claimNextInState(state, { projectId, conversationId, runId, expectedMessageId: first.messageId });
  });
  return { dir, file, ledger, options, authority, control, principals, ref, setNow: v => { clock = v; }, send, remove, notices, list, startRun, close() {
    try { this.ledger.close(); } catch { /* 已关 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}
