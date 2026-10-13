// W2(本人页面反向通道)测试夹具。真的:SQLite 账本上的运行授权(`run-authority.mjs`)、对话权限(`conversation-authority.mjs` 的
// 同一份判定函数)、文档服务的在场表(`docservice/modules/selection.mjs`,发消息时的页面号由它的 `captureSnapshot` 核过才记)、
// 运行资源登记器、反向通道自己的 SQLite 请求记录。
// 不假装的:页面到文档服务的连接是直接调在场模块的 connect / handle / disconnect(没有真的 WebSocket),
// 页面到 Agent 服务的事件流与交回是直接调 `attach` / `acceptResult`(没有真的 HTTP;真 HTTP 与真浏览器在探针里)。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { digestOf, appendAccessEvent } from '../account/ledger.mjs';
import { conversationReadInState } from '../account/conversation-authority.mjs';
import { mountSelection } from '../docservice/modules/selection.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createPageBridge, createPageControlTools } from '../agent/service/page-bridge.mjs';
import { createHandoffTools } from '../agent/service/hosted-handoff.mjs';

export { projectId, conversationId };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, { ms = 5_000, step = 10, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

const loginOf = (accountId) => ({ accountId, loginId: `login-${accountId}`, credentialId: `credential-${accountId}`, loginGeneration: 1 });

/**
 * @param {object} [options]
 * @param {string} [options.initiator] 发消息的账号(缺省 sender;账本里另有 owner、other 两个成员,owner 是对话的主人)
 * @param {object} [options.limits] 反向通道的时限
 * @param {boolean} [options.sendFromPage] false 时不发消息、不起这一轮(测试自己来)
 */
export async function w2Fixture(t, options = {}) {
  const authority = await runFixture();
  const { ledger } = authority;
  const flags = { presenceDown: false, authorityDown: false };

  // ---- 文档服务的在场表(真模块)。页面的账号此刻有没有项目权限、这一轮的授权,都问真的账本
  const pageAccess = async ({ principal, projectId: target }) => {
    const state = ledger.read();
    const project = state.projects?.[target];
    if (!project || project.status !== 'active' || state.revokedLogins?.[`login:${principal.loginId}`] || Object.hasOwn(project.bans ?? {}, principal.accountId)) return false;
    const listed = principal.accountId === project.creatorAccountId || !!project.members?.[principal.accountId];
    return listed ? { allowed: true, accountId: principal.accountId, projectId: target, accountName: `${principal.accountId} name` } : false;
  };
  const selection = mountSelection({
    project: { bodyOf: () => ({ tracks: [] }), revOf: () => 1 },
    checkAccess: pageAccess,
    authorizeQuery: async ({ projectId: target, runGrantId }) => {
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: target, runGrantId });
      return authority.provider.authorizeQuery({ principal, projectId: target, runGrantId });
    },
    now: () => authority.clock.now,
  });
  const replies = new Map();
  const ctx = { send: (connId, message) => { replies.set(`${connId}\n${message.reqId}`, message); } };
  let connSeq = 0; let reqSeq = 0;

  /** 一张页面:连上文档服务并报在场页面号。`attach(bridge)` 再把它到 Agent 服务的事件流挂上 */
  async function openPage(accountId, pageId, { project = projectId } = {}) {
    const connId = `conn-${++connSeq}`;
    const principal = { role: 'page', tenantId: project, projectId: project, ...loginOf(accountId) };
    selection.connect(ctx, connId, principal);
    const reqId = `req-${++reqSeq}`;
    await selection.handle(ctx, connId, { type: 'selection.set', projectId: project, pageId, revision: 1, selection: { clipIds: [] }, reqId });
    const reply = replies.get(`${connId}\n${reqId}`);
    if (reply?.type !== 'selection.ok') throw new Error(`selection.set refused: ${reply?.reason}`);
    const page = {
      accountId, pageId, connId, principal, events: [], stream: null,
      identity: { accountMode: true, accountId, projectId: project },
      attach(bridge, { conversation = conversationId, reportPageId = pageId, aclRevision = aclOf(conversation) } = {}) {
        page.stream = bridge.attach({ identity: page.identity, conversationId: conversation, pageId: reportPageId, aclRevision, send: (event) => page.events.push(event) });
        return page.stream;
      },
      detach() { page.stream?.detach(); page.stream = null; },
      /** 这张页面离开文档服务(关页签、断网) */
      leaveDoc() { selection.disconnect(ctx, connId); },
      /** 按事件交回结果;`over` 改请求体(伪造用),`as` 换成别的身份或对话 */
      answer(bridge, event, { over = {}, as = page.identity, conversation = conversationId, answer = { ok: true, result: { ok: true } } } = {}) {
        return bridge.acceptResult({ identity: as, conversationId: conversation,
          body: { v: 2, id: event.id, nonce: event.nonce, pageId: event.pageId, runId: event.runId, ...answer, ...over } });
      },
    };
    return page;
  }

  const aclOf = (conversation) => ledger.read().conversationsV2[projectId][conversation]?.aclRevision ?? 0;

  /** 发一条消息:页面号先经在场模块的 `captureSnapshot` 核过(这张页面此刻连着、属于这次登录)才记进消息 */
  async function sendMessage(page, messageId = 'message1') {
    const snapshot = await selection.captureSnapshot({ principal: { ...page.principal }, projectId, pageId: page.pageId });
    const login = loginOf(page.accountId);
    ledger.transaction((s) => {
      const c = s.conversationsV2[projectId][conversationId];
      const content = `让发起页做事 ${messageId}`;
      c.messages.push({ messageId, requestId: `send-${messageId}`, arrivalSeq: c.messages.length + 1,
        senderAccountId: page.accountId, senderNameAtSend: `${page.accountId} name`, loginId: login.loginId, credentialId: login.credentialId, loginGeneration: login.loginGeneration,
        content, contentDigest: digestOf(content), attachments: [],
        selectionSnapshot: { ...snapshot, messageId }, queueState: 'queued' });
    });
    return snapshot;
  }

  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      if (flags.authorityDown) throw Object.assign(new Error('doc unavailable'), { status: 503 });
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  const resources = createRunResources({ runClient });
  const presence = async (context) => {
    if (flags.presenceDown) throw Object.assign(new Error('doc unavailable'), { status: 503 });
    return selection.querySelections({ principal: { service: 'agent', tenantId: context.projectId }, projectId: context.projectId, runGrantId: context.runGrantId });
  };
  /** HTTP 层对事件流用的同一个核对:这个账号此刻读不读得到这个对话(真账本上的真判定) */
  const checkSubmitter = async (identity, conversation) => {
    if (flags.authorityDown) throw Object.assign(new Error('doc unavailable'), { status: 503 });
    const state = ledger.read();
    return conversationReadInState(state, { projectId: identity.projectId, ...loginOf(identity.accountId) }, { projectId: identity.projectId, conversationId: conversation, action: 'access' });
  };

  const dbPath = path.join(authority.dir, 'page-requests.sqlite');
  const logs = [];
  const opened = [];
  const openBridge = (overrides = {}) => {
    const bridge = createPageBridge({ databasePath: dbPath, resources, runClient, presence, checkSubmitter,
      limits: { pageMs: 1_500, attachMs: 150, ...options.limits }, log: (event, fields) => logs.push({ event, ...fields }), ...overrides });
    opened.push(bridge);
    return bridge;
  };
  const bridge = openBridge();
  const playheads = [];
  const control = createPageControlTools({ bridge, onPlayhead: (context, time) => { playheads.push({ runId: context.runId, t: time }); } });
  const browser = { target: { url: 'https://example.com/login' }, calls: 0, async handoffTarget() { browser.calls += 1; return browser.target; } };
  const handoff = createHandoffTools({ bridge, browser });

  t.after(async () => {
    for (const each of opened) each.close('test-end');
    await resources.close();
    authority.close();
    fs.rmSync(authority.dir, { recursive: true, force: true });
  });

  const f = {
    authority, ledger, selection, resources, runClient, bridge, control, handoff, browser, playheads, logs, flags, dbPath, openBridge, openPage, sendMessage, aclOf,
    grant: null, context: null, initiatorPage: null,
    /** 起这一轮:文档服务把消息交给 Agent 并确认已读,再由运行资源登记器按当前授权构造可信的运行上下文 */
    async startRun(messageId = 'message1') {
      const grant = await authority.admit(`admit-${messageId}`);
      await authority.provider.confirmRead(authority.input(grant, `read-${messageId}`));
      f.grant = grant;
      f.context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });
      return f.context;
    },
    /** 停这一轮(用户点停止):文档服务的停止栅栏 */
    stopRun() {
      return ledger.transaction((s) => authority.provider.hooks.fenceInState(s, { kind: 'stop', projectId, conversationId, runId: f.grant.runId, requestId: 'stop1' }));
    },
    /** 对话的主人把它转成私有 */
    makePrivate() { return authority.privateFence(); },
    /** 踢出一个成员:成员表、禁入表、权限事件,再让运行授权按事件处理(与 `authority.mjs` 的 kick 同一组改动) */
    kick(accountId) {
      const event = ledger.transaction((s) => {
        const p = s.projects[projectId];
        delete p.members[accountId];
        p.bans[accountId] = { reason: 'kick', requestId: `kick-${accountId}` };
        p.accessRevision += 1;
        return appendAccessEvent(s, { type: 'project-access-changed', reason: 'kick', projectId, accountIds: [accountId], accessRevision: p.accessRevision });
      });
      authority.provider.applyAccessEvent(event);
      selection.revoke({ projectId, accountId });
    },
    /** 请求记录里的一行(只读连接,看它存了什么) */
    row(requestId) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return db.prepare('SELECT * FROM page_requests WHERE request_id=?').get(requestId) ?? null; } finally { db.close(); }
    },
    rows() {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return db.prepare('SELECT request_id, tool, state, reason FROM page_requests ORDER BY created_at, request_id').all().map((r) => ({ ...r })); } finally { db.close(); }
    },
    /** 调一次 `requestPage`(发起人与页面号照文档服务的授权填,像工具提供方那样) */
    async request(tool, args, requestId, extra = {}) {
      const who = await bridge.initiator(f.context);
      return bridge.requestPage({ run: f.context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool, args, requestId, ...extra });
    },
  };

  if (options.sendFromPage !== false) {
    const initiator = options.initiator ?? 'sender';
    f.initiatorPage = await openPage(initiator, 'page-initiator');
    await sendMessage(f.initiatorPage);
    await f.startRun();
  }
  return f;
}
