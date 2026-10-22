import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AccountFailure, type AccountJoinRequestRow, type AccountMembersSnapshot, type AccountKickOperation } from './client';
import { accountProjectMembers, accountMemberAdmin, returnToAccountProjectHome, pushToast, useSync } from '../editor/sync/syncManager';
import { useCloudAgent, useCloudApi } from '../ai/cloud/useCloud';
import { CLOUD_CHAT_TEXT } from '../ai/cloud/chatTexts';
import { CloudError } from '../ai/cloud/cloudApi';
import { accountMemberCountLabel, accountMemberState, cloudAgentLabel } from '../editor/sync/hostedServices';
import { JOIN_REQUEST_TEXT, requestedAtText } from './joinRequestText';
import './account.css';

/** 成员列表展开 / 收着时取成员名单的间隔(毫秒) */
export const MEMBERS_POLL_OPEN_MS = 3000;
export const MEMBERS_POLL_CLOSED_MS = 15_000;

/** Account membership is independent of device names and the old LAN passwords. */
export function AccountMembersPanel() {
  const shared = useSync(v => v.shared);
  const [snapshot, setSnapshot] = useState<AccountMembersSnapshot | null>(null);
  const [open, setOpen] = useState(false), [bansOpen, setBansOpen] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ operation: AccountKickOperation; name: string; retry: boolean } | null>(null);
  /** 「通过」「拒绝」没收到回包时,再点同一个按钮沿用原来的请求号(服务端认得出是同一次);收到结论就丢掉 */
  const decisionIds = useRef(new Map<string, string>());
  const [rect, setRect] = useState<DOMRect | null>(null);
  // 踢出时可以选「同时清除他的私有对话」(2026-10-13 用户定，缺省不选：他的共有对话一律保留)；踢出成功后再清，清不完可重试
  const cloud = useCloudAgent(), cloudApi = useCloudApi(cloud.url, cloud.projectId);
  const [clearPrivate, setClearPrivate] = useState(false);
  const [clearing, setClearing] = useState<{ accountId: string; name: string; requestId: string; stage: 'working' | 'pending' | 'error'; text: string } | null>(null);
  const button = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null), generation = useRef(0);
  const refresh = useCallback(async () => {
    const own = generation.current;
    try {
      const value = await accountProjectMembers();
      if (generation.current !== own) throw new AccountFailure(401, 'credential-revoked');
      if (generation.current === own) { setSnapshot(value); setError(''); }
      return value;
    } catch (e) {
      if (generation.current === own) { setSnapshot(null); setError(e instanceof Error ? e.message : '暂时无法获取项目成员。'); }
      throw e;
    }
  }, []);
  useEffect(() => {
    generation.current++; setSnapshot(null); setAttempt(null); setOpen(false); setBansOpen(false);
    // Display polling only. The server's access fence closes actual connections.
    void refresh().catch(() => undefined);
  }, [shared?.projectId, shared?.accountId, refresh]);
  // 展开成员列表时每 3 秒取一次；收着时只显示人数，每 15 秒取一次(原来不论展开与否都 3 秒一次，
  // 2026-10-19 在线实测 2 分钟 35 次)。页签在后台时不取（看不见，不用刷新）；切回来以后下一次就取到最新的
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh().catch(() => undefined); },
      open ? MEMBERS_POLL_OPEN_MS : MEMBERS_POLL_CLOSED_MS);
    return () => clearInterval(timer);
  }, [shared?.projectId, shared?.accountId, refresh, open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!pop.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const select = async (op: 'kick' | 'unban', accountId: string) => {
    const own = generation.current;
    setBusy(true); setAttempt(null);
    try {
      const latest = await refresh();
      if (!latest.self.creator) throw new AccountFailure(403, 'creator-required');
      const target = (op === 'kick' ? latest.members : latest.bans)?.find(row => row.accountId === accountId);
      if (!target || accountId === latest.creatorAccountId) throw new AccountFailure(409, 'access-revision-mismatch');
      setClearPrivate(false);
      setAttempt({ operation: { op, accountId, expectedAccessRevision: latest.accessRevision, requestId: crypto.randomUUID() },
        name: target.accountName ?? target.accountId, retry: false });
    } catch (e) { if (generation.current === own) setError(e instanceof Error ? e.message : '暂时无法确认成员状态。'); }
    finally { if (generation.current === own) setBusy(false); }
  };
  /**
   * 申请加入(2026-10-22 用户定):创建者在成员浮层里「通过」「拒绝」。服务端只认创建者本人的页面,通过那一刻现核禁入与申请还在不在;
   * 通过以后他直接能进(设了二级密码的仍要输一次),被拒的看到「创建者没有通过你的申请」。
   */
  const decide = async (op: 'approve-join' | 'reject-join', row: AccountJoinRequestRow) => {
    const own = generation.current, key = `${op}:${row.joinRequestId}`, name = row.accountName ?? row.accountId;
    const requestId = decisionIds.current.get(key) ?? crypto.randomUUID();
    decisionIds.current.set(key, requestId);
    setBusy(true); setError('');
    try {
      await accountMemberAdmin({ op, accountId: row.accountId, joinRequestId: row.joinRequestId, requestId });
      decisionIds.current.delete(key);
      if (generation.current !== own) return;
      pushToast(op === 'approve-join' ? `已通过 ${name} 的申请。` : `已拒绝 ${name} 的申请。`, 'info');
      await refresh().catch(() => undefined);
    } catch (e) {
      if (generation.current !== own) return;
      // 有结论的失败(已处理过、申请不在了、没有权限……)丢掉请求号;没收到回包(网络)的留着,再点一次就是重试
      if (e instanceof AccountFailure && e.status !== 0) decisionIds.current.delete(key);
      await refresh().catch(() => undefined);
      setError(e instanceof Error ? e.message : '暂时无法处理这条申请，请重试。');
    } finally { if (generation.current === own) setBusy(false); }
  };
  const runClear = async (accountId: string, name: string, requestId: string) => {
    setClearing({ accountId, name, requestId, stage: 'working', text: CLOUD_CHAT_TEXT.clearPrivateWorking });
    try {
      const out = await cloudApi.clearMemberPrivate(accountId, requestId);
      if (out.pending.length) { setClearing({ accountId, name, requestId, stage: 'pending', text: CLOUD_CHAT_TEXT.clearPrivatePending(out.pending.length) }); return; }
      setClearing(null);
      pushToast(CLOUD_CHAT_TEXT.clearPrivateDone(out.removed.length), 'info');
    } catch (e) {
      setClearing({ accountId, name, requestId, stage: 'error', text: e instanceof CloudError ? e.message : '暂时无法清除，请重试。' });
    }
  };
  const submit = async () => {
    if (!attempt) return;
    const exact = attempt, own = generation.current; setBusy(true);
    try {
      await accountMemberAdmin(exact.operation);
      if (generation.current !== own) return;
      setAttempt(null);
      if (exact.operation.op === 'kick' && clearPrivate) void runClear(exact.operation.accountId, exact.name, crypto.randomUUID());
      pushToast(exact.operation.op === 'kick' ? '账号已禁入，正在确认相关服务关闭。' : '已解除账号禁入；该账号可按当前项目权限重新加入。', 'info', Infinity);
      await refresh();
    } catch (e) {
      if (generation.current !== own) return;
      // Unknown delivery outcome keeps the exact request/revision for replay.
      // Conflict never silently replaces the user's original selection.
      if (e instanceof AccountFailure && (e.status === 409 || e.status === 400 || e.status === 403 || e.status === 401)) {
        setAttempt(null); await refresh().catch(() => undefined);
      } else setAttempt({ ...exact, retry: true });
      setError(e instanceof Error ? e.message : '暂时无法确认操作结果，请重试同一操作。');
    } finally { if (generation.current === own) setBusy(false); }
  };
  // Only actual connections are displayed. Persisted queued messages are never Agents.
  // 计数口径与「离线，Agent 在跑」见 `hostedServices.ts` 的 `accountMemberState`(语义 `product/agent.md`「成员列表怎么数」)
  const stateOf = (accountId: string) => accountMemberState(accountId, snapshot?.devices ?? []);
  // 挂着的申请只有创建者的投影里有;有就在成员按钮上出数字角标
  const requests = snapshot?.self.creator ? snapshot.requests ?? [] : [];
  if (!shared?.accountId) return null;
  return <>
    <button ref={button} type="button" className="pc-sync-chip" data-pc="members-button" title={requests.length ? `成员 · ${requests.length} 条申请加入` : '成员'} onClick={() => {
      setRect(button.current?.getBoundingClientRect() ?? null); setOpen(!open); void refresh().catch(() => undefined);
    }}><span data-pc="members-count">{snapshot ? accountMemberCountLabel(snapshot) : '成员：暂不可用'}</span>
      {requests.length > 0 && <span className="pc-members-badge" data-pc="members-request-badge">{requests.length}</span>}</button>
    {open && createPortal(<div ref={pop} className="pc-members-pop pc-account-members" data-pc="members-pop"
      style={{ top: (rect?.bottom ?? 40) + 6, left: Math.max(8, Math.min((rect?.right ?? 340) - 360, window.innerWidth - 368)) }}>
      <div className="pc-account-members-heading">项目成员 <button type="button" disabled={busy} onClick={() => { void refresh().catch(() => undefined); }}>刷新</button></div>
      {error && <div role="alert" className="pc-account-members-error" data-pc="account-members-error">{error}</div>}
      {requests.length > 0 && <div data-pc="account-join-requests">
        <div className="pc-account-requests-title">{JOIN_REQUEST_TEXT.requestsTitle(requests.length)}</div>
        {requests.map(row => <div className="pc-account-member" key={row.joinRequestId} data-pc="account-join-request" data-account-id={row.accountId}>
          <div className="pc-members-row-main"><span className="pc-members-name">{row.accountName ?? row.accountId}</span></div>
          <small className="pc-account-member-id">{row.accountId} · {requestedAtText(row.createdAt)}</small>
          <div className="pc-account-request-actions">
            <button type="button" className="pc-account-request-approve" data-pc="account-join-approve" disabled={busy || !!attempt} onClick={() => { void decide('approve-join', row); }}>{JOIN_REQUEST_TEXT.approve}</button>
            <button type="button" className="pc-account-request-reject" data-pc="account-join-reject" disabled={busy || !!attempt} onClick={() => { void decide('reject-join', row); }}>{JOIN_REQUEST_TEXT.reject}</button>
          </div>
        </div>)}
        <div className="pc-members-sep" />
      </div>}
      {snapshot?.members.map(member => { const state = stateOf(member.accountId), name = member.accountName ?? member.accountId;
        return <div className="pc-account-member pc-members-row" key={member.accountId} data-pc="account-member" data-account-id={member.accountId}>
        <div className="pc-members-row-main"><span className={`pc-members-name${member.accountId === shared.accountId ? ' is-me' : ''}`}>
          {name}{member.accountId === shared.accountId ? '（自己）' : ''}</span>
          {member.accountId === snapshot.creatorAccountId && <span className="pc-sync-tag">[创建者]</span>}
          {state.offlineAgent ? <span className="pc-sync-tag" data-pc="members-offline-agent" title="这位成员不在线，他的云端 Agent 还在跑；不计入成员人数，计入 Agent 个数">[离线，Agent 在跑]</span>
            : !state.online && <span className="pc-sync-tag">[离线]</span>}
          {state.cloudRunning && <span className="pc-sync-tag" data-pc="members-cloud-agent" title={cloudAgentLabel(name)}>[云端 Agent]</span>}
          {member.access === 'r' && <span className="pc-sync-tag">[只读]</span>}
          {snapshot.self.creator && member.accountId !== snapshot.creatorAccountId && <button type="button" className="pc-members-kick" data-pc="account-member-kick"
            disabled={busy || !!attempt} onClick={() => { void select('kick', member.accountId); }}>踢出账号</button>}
        </div>
        <small className="pc-account-member-id">{member.accountId}</small>
        {/* 设备行只列页面与本机 Agent;云端 Agent 的任务连接(没有设备,按任务号归项)不当设备显示,统一成下面那一行 */}
        {snapshot.devices.filter(row => row.accountId === member.accountId && row.conns.some(conn => conn.service !== 'agent')).map(device => <div className="pc-members-sub" key={device.deviceId}>
          <span>{device.deviceName} · {device.deviceId}</span>
          {device.conns.some(conn => conn.role === 'page') && <span>[编辑中]</span>}
          {device.conns.filter(conn => conn.role === 'agent' && conn.service !== 'agent').map((conn, i) => <span key={i}>Agent{conn.conversation !== undefined ? ` · 对话 ${conn.conversation}` : ''}</span>)}
        </div>)}
        {state.cloudRunning && <div className="pc-members-sub"><span data-pc="members-cloud-agent-row">{cloudAgentLabel(name)}</span></div>}
      </div>; })}
      {snapshot?.self.creator && <>
        <div className="pc-members-sep" />
        <button type="button" className="pc-members-admin-item" data-pc="account-bans-open" disabled={busy} onClick={() => setBansOpen(!bansOpen)}>已禁入的账号</button>
        {bansOpen && (snapshot.bans?.length ? snapshot.bans.map(ban => <div className="pc-account-member" key={ban.accountId} data-pc="account-ban" data-account-id={ban.accountId}>
          <div>{ban.accountName ?? ban.accountId}</div><small className="pc-account-member-id">{ban.accountId}</small>
          <button type="button" data-pc="account-member-unban" disabled={busy || !!attempt} onClick={() => { void select('unban', ban.accountId); }}>解除禁入</button>
        </div>) : <div className="pc-members-empty">没有已禁入的账号。</div>)}
      </>}
      {attempt && <div className="pc-account-member-confirm" data-pc="account-member-confirm">
        <p>{attempt.operation.op === 'kick' ? `踢出并禁止 ${attempt.name} 再次加入这个项目？该账号的所有设备都会失去项目访问权限。` : `解除 ${attempt.name} 的账号禁入？`}</p>
        <small className="pc-account-member-id">{attempt.operation.accountId}</small>
        {attempt.operation.op === 'kick' && <label className="pc-account-member-clear" data-pc="account-member-clear-option"><input type="checkbox" checked={clearPrivate} disabled={busy}
          onChange={event => setClearPrivate(event.target.checked)} /> {CLOUD_CHAT_TEXT.clearPrivateOption}</label>}
        <button type="button" disabled={busy} data-pc="account-member-submit" onClick={() => { void submit(); }}>{busy ? '正在提交…' : attempt.retry ? '重试同一操作' : '确认'}</button>
        <button type="button" disabled={busy} onClick={() => setAttempt(null)}>取消</button>
      </div>}
      {clearing && <div className="pc-account-member-confirm" data-pc="account-member-clear-status" data-stage={clearing.stage} role="status">
        <p>{clearing.name}：{clearing.text}</p>
        {clearing.stage !== 'working' && <button type="button" data-pc="account-member-clear-retry" onClick={() => { void runClear(clearing.accountId, clearing.name, clearing.requestId); }}>{CLOUD_CHAT_TEXT.clearPrivateRetry}</button>}
      </div>}
      <div className="pc-members-sep" />
      <button type="button" className="pc-members-admin-item" data-pc="account-project-home" disabled={busy} onClick={() => {
        setBusy(true); void returnToAccountProjectHome().catch(e => setError(e instanceof Error ? e.message : '尚有改动未确认，请稍后重试。')).finally(() => setBusy(false));
      }}>回项目首页</button>
    </div>, document.body)}
  </>;
}
