/**
 * 账号云端项目里,页面换会话 / 断线重连之后选区还在不在:真的账号服务、文档服务、素材服务、云端 Agent 入口与任务执行器
 * (`fixtures/accept-018-auth-kit.mjs` 的全链,模型是按脚本回话的替身);页面一侧用真的 `SyncLink`、选区与在场模块。
 * 报告 `docs/reports/AGENT-v18-cardsync.md`。跑:npm test -- server/test/account-page-selection.test.mjs
 *
 * 背景:文档服务按连接记选区。页面换到新会话后,新连接上只有一条合成的空选区,旧连接一关原来那条就没了。账号模式给云端 Agent
 * 发消息必带 `selectionSnapshot: { pageId }`,服务端要求恰好有一条这个页面号的非合成选区,否则回 403 `selection-page-unavailable`
 * —— 也就是进项目约 90 秒(第一次换会话)之后,用户不动一下选区就发不出云端 Agent 消息。
 *
 *   1 进项目、发布选区:带选区快照给云端 Agent 发消息,服务端收下(202)
 *   2 换会话(等旧会话真的关掉之后):同一个页面号再发,服务端仍收下 —— 新连接上重新发布过选区
 *   3 连接作废后重连(`expire()`,走断线重连那条路):同样仍收下
 *   4 选区是真的那一份:云端 Agent 查到的这个页面的选区就是页面上选中的片段
 *
 * 复现原问题(先红):`ACCOUNT_PAGE_SELECTION_REPRO_OLD=1` —— 重新建成会话时不重发选区(改之前 `enterAccountProject` 的写法),第 2 步回 403。
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import WS from 'ws';
import { SKIP_WITHOUT_PROVIDER, script, startAgentPath, waitUntil } from './fixtures/accept-018-auth-kit.mjs';

const { SyncLink } = await import(srcUrl('editor/sync/link.ts'));
const { setSelectionLink, selectionPresenceStatus } = await import(srcUrl('editor/sync/selectionPresence.ts'));
const { setPresenceLink, resyncPresenceLink } = await import(srcUrl('editor/sync/presence.ts'));

const OLD = process.env.ACCOUNT_PAGE_SELECTION_REPRO_OLD === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('账号云端项目:页面换会话、断线重连之后选区还在,带选区快照给云端 Agent 发消息服务端收得下', { skip: SKIP_WITHOUT_PROVIDER, timeout: 300_000 }, async (t) => {
  const fx = await startAgentPath({ diagnostic: () => {} });
  let link = null;
  try {
    const A = await fx.openAccount({ ...fx.accounts[0] });
    const projectId = fx.projectId;
    const setup = await A.enter(projectId, { page: false, deviceTag: 'setup' });
    assert.equal((await A.doc('admin', { projectId, op: 'set-hosted-service', service: 'agent', enabled: true,
      expectedAccessRevision: setup.session.body.accessRevision, requestId: 'sel-enable' })).status, 200);

    // ---- 页面:真的 SyncLink,每建一个会话现取票据;重新建成会话时把跟着连接走的在场状态重建(`enterAccountProject` 的写法)
    class CaWebSocket extends WS { constructor(url, protocols) { super(url, protocols, { ca: fx.ca, origin: fx.origin }); } }
    let opens = 0;
    const closes = [];
    link = new SyncLink({
      url: `${fx.origin.replace(/^https:/, 'wss:')}/hosted/`, projectId, session: 'sel-page-1', initial: { tracks: [] }, initialize: false, WebSocketImpl: CaWebSocket,
      protocols: async () => { const e = await A.enter(projectId, { page: false, deviceTag: 'page' }); assert.ok(!e.denied); return ['promptcut.v1', `promptcut.account.${e.session.body.connectionTicket}`]; },
      isFatalClose: () => false,
      onClosed: (info) => closes.push(info.code),
      onOpen: () => { if (++opens > 1 && !OLD) resyncPresenceLink(); },
      reconnect: { minMs: 200, maxMs: 1000 },
    });
    link.start();
    await waitUntil(() => link.ds.status === 'online', '页面进项目');
    const selected = ['clip-sel-1', 'clip-sel-2'];
    setPresenceLink(link, projectId, `account:${A.accountId}@accept-${A.name}-page`, true);
    setSelectionLink(link, projectId, { readSelection: () => selected, subscribe: () => () => {} });
    await waitUntil(() => selectionPresenceStatus().revision >= 1, '页面发布了选区');
    await sleep(500);
    const pageId = selectionPresenceStatus().pageId;
    assert.ok(pageId);

    let n = 0;
    /** 带选区快照给云端 Agent 发一条(每次一个新对话);回状态码与错误码 */
    const sendToAgent = async () => {
      const entry = await A.enter(projectId, { page: false, deviceTag: 'page' });
      const id = `sel-${++n}`;
      const r = await entry.agent(`/conversations/${id}/messages`, { prompt: script([{ tool: 'get_selection', input: {} }, { say: `DONE_${id}` }]), requestId: id, selectionSnapshot: { pageId } });
      return { status: r.status, code: r.body?.code ?? r.body?.error ?? null, conversationId: id };
    };
    /** 等这一轮跑完(收场时任务执行器里不能还有在跑的) */
    const finished = (sent) => waitUntil(() => fx.rows(projectId, sent.conversationId).some((row) => row.event?.type === 'runner_done'), `${sent.conversationId} 那一轮跑完`, 60_000);

    // ---- 1 基线
    const first = await sendToAgent();
    assert.equal(first.status, 202, `进项目后带选区快照发消息:${JSON.stringify(first)}`);
    t.diagnostic(`1 进项目后带选区快照给云端 Agent 发消息:${first.status}`);
    await finished(first);

    // ---- 2 换会话;等旧会话真的关掉
    assert.equal(await link.renew(), true, '换会话');
    await sleep(2500);
    assert.equal(selectionPresenceStatus().pageId, pageId, '页面号没变');
    const second = await sendToAgent();
    t.diagnostic(`2 换会话(旧会话已关)之后同一个页面号再发:${second.status} ${second.code ?? ''}`);
    assert.equal(second.status, 202, `换会话之后带选区快照发消息被拒:${JSON.stringify(second)}`);

    // ---- 4 云端 Agent 查到的就是页面上的选区(用第 2 步那一轮的工具结果)
    await finished(second);
    const rows = JSON.stringify(fx.rows(projectId, second.conversationId));
    assert.ok(rows.includes('clip-sel-1') && rows.includes('clip-sel-2'), '云端 Agent 的 get_selection 里有页面选中的两个片段');
    t.diagnostic('4 云端 Agent 的 get_selection 结果里是页面上选中的两个片段');

    // ---- 3 连接作废后重连
    link.expire();
    await waitUntil(() => closes.includes(4401) && link.ds.status === 'online', '连接作废后重连上', 30_000);
    await sleep(1500);
    const third = await sendToAgent();
    t.diagnostic(`3 连接作废后重连,同一个页面号再发:${third.status} ${third.code ?? ''}`);
    assert.equal(third.status, 202, `重连之后带选区快照发消息被拒:${JSON.stringify(third)}`);
    await finished(third);
    assert.equal(opens, 3);
  } finally {
    setPresenceLink(null, null, '');
    link?.stop();
    const state = await fx.close().catch((error) => { throw new Error(`收场失败:${error?.message};${JSON.stringify((error?.errors ?? []).map((e) => [e?.message, ...(e?.errors ?? []).map((x) => x?.message ?? String(x))]))}`); });
    assert.equal(state.closed, true);
  }
});
