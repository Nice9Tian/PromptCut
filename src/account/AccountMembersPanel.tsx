import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AccountFailure, type AccountMembersSnapshot, type AccountMemberOperation } from './client';
import { accountProjectMembers, accountMemberAdmin, returnToAccountProjectHome, pushToast, useSync } from '../editor/sync/syncManager';

/** Account membership is independent of device names and the old LAN passwords. */
export function AccountMembersPanel() {
  const shared = useSync(v => v.shared);
  const [snapshot, setSnapshot] = useState<AccountMembersSnapshot | null>(null);
  const [open, setOpen] = useState(false), [bansOpen, setBansOpen] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ operation: AccountMemberOperation; name: string; retry: boolean } | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
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
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 3000);
    return () => { generation.current++; clearInterval(timer); };
  }, [shared?.projectId, shared?.accountId, refresh]);
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
      setAttempt({ operation: { op, accountId, expectedAccessRevision: latest.accessRevision, requestId: crypto.randomUUID() },
        name: target.accountName ?? target.accountId, retry: false });
    } catch (e) { if (generation.current === own) setError(e instanceof Error ? e.message : '暂时无法确认成员状态。'); }
    finally { if (generation.current === own) setBusy(false); }
  };
  const submit = async () => {
    if (!attempt) return;
    const exact = attempt, own = generation.current; setBusy(true);
    try {
      await accountMemberAdmin(exact.operation);
      if (generation.current !== own) return;
      setAttempt(null);
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
  const online = new Set(snapshot?.devices.filter(row => row.conns.some(conn => conn.role === 'page')).map(row => row.accountId) ?? []);
  if (!shared?.accountId) return null;
  return <>
    <button ref={button} type="button" className="pc-sync-chip" data-pc="members-button" title="成员" onClick={() => {
      setRect(button.current?.getBoundingClientRect() ?? null); setOpen(!open); void refresh().catch(() => undefined);
    }}>成员 <span data-pc="members-count">{snapshot ? `${online.size} 人` : '暂不可用'}</span></button>
    {open && createPortal(<div ref={pop} className="pc-members-pop pc-account-members" data-pc="members-pop"
      style={{ top: (rect?.bottom ?? 40) + 6, left: Math.max(8, Math.min((rect?.right ?? 340) - 360, window.innerWidth - 368)) }}>
      <div className="pc-account-members-heading">项目成员 <button type="button" disabled={busy} onClick={() => { void refresh().catch(() => undefined); }}>刷新</button></div>
      {error && <div role="alert" className="pc-account-members-error" data-pc="account-members-error">{error}</div>}
      {snapshot?.members.map(member => <div className="pc-account-member" key={member.accountId} data-pc="account-member" data-account-id={member.accountId}>
        <div className="pc-members-row-main"><span className={`pc-members-name${member.accountId === shared.accountId ? ' is-me' : ''}`}>
          {member.accountName ?? member.accountId}{member.accountId === shared.accountId ? '（自己）' : ''}</span>
          {member.accountId === snapshot.creatorAccountId && <span className="pc-sync-tag">[创建者]</span>}
          {!online.has(member.accountId) && <span className="pc-sync-tag">[离线]</span>}
          {member.access === 'r' && <span className="pc-sync-tag">[只读]</span>}
          {snapshot.self.creator && member.accountId !== snapshot.creatorAccountId && <button type="button" className="pc-members-kick" data-pc="account-member-kick"
            disabled={busy || !!attempt} onClick={() => { void select('kick', member.accountId); }}>踢出账号</button>}
        </div>
        <small className="pc-account-member-id">{member.accountId}</small>
        {snapshot.devices.filter(row => row.accountId === member.accountId).map(device => <div className="pc-members-sub" key={device.deviceId}>
          <span>{device.deviceName} · {device.deviceId}</span>
          {device.conns.some(conn => conn.role === 'page') && <span>[编辑中]</span>}
          {device.conns.filter(conn => conn.role === 'agent').map((conn, i) => <span key={i}>Agent{conn.conversation !== undefined ? ` · 对话 ${conn.conversation}` : ''}</span>)}
        </div>)}
      </div>)}
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
        <button type="button" disabled={busy} data-pc="account-member-submit" onClick={() => { void submit(); }}>{busy ? '正在提交…' : attempt.retry ? '重试同一操作' : '确认'}</button>
        <button type="button" disabled={busy} onClick={() => setAttempt(null)}>取消</button>
      </div>}
      <div className="pc-members-sep" />
      <button type="button" className="pc-members-admin-item" data-pc="account-project-home" disabled={busy} onClick={() => {
        setBusy(true); void returnToAccountProjectHome().catch(e => setError(e instanceof Error ? e.message : '尚有改动未确认，请稍后重试。')).finally(() => setBusy(false));
      }}>回项目首页</button>
    </div>, document.body)}
  </>;
}
