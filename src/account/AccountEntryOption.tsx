import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountFailure, type AccountMembersSnapshot } from './client';
import { accountMemberAdmin, accountProjectMembers, useSync } from '../editor/sync/syncManager';
import { JOIN_REQUEST_TEXT } from './joinRequestText';

/**
 * 云端项目的「任何知道链接的人都可加入」勾选(2026-10-22 用户定,`workflow/project.md`「多用户协作」第 27 条):
 * 在项目设置「作废并重新生成项目链接」「项目二级密码」两个按钮下面(`src/editor/sync/CollabSection.tsx` 只在创建者那一段挂它),
 * 只有创建者能改(服务端 `/hosted/shared/account/admin` 的 `set-entry` 只认创建者本人的页面)。
 *
 * 取消勾选就是「只允许账号名单」,名单就是项目成员:落账那一刻已经是成员的人都在名单里,之后的新人只能申请、由创建者通过;
 * 没有「输入账号名加人」。改的时候先重读一次成员投影拿当前的访问版本号;中间有人进来(版本号变了,回 409)就再读一次、再改一次,
 * 名单照落账那一刻算(规则见报告 `AGENT-claude-join-requests.md`「名单快照」)。
 */
export function AccountEntryOption({ disabled = false }: { disabled?: boolean }) {
  const shared = useSync(v => v.shared);
  const [snapshot, setSnapshot] = useState<AccountMembersSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const own = generation.current;
    const value = await accountProjectMembers();
    if (generation.current !== own) throw new AccountFailure(401, 'credential-revoked');
    setSnapshot(value);
    return value;
  }, []);
  useEffect(() => {
    generation.current++; setSnapshot(null); setError('');
    void load().catch(e => setError(e instanceof Error ? e.message : '暂时无法读取进入方式。'));
  }, [shared?.projectId, shared?.accountId, load]);
  const change = async (allowLinkJoin: boolean) => {
    const own = generation.current;
    setBusy(true); setError('');
    try {
      for (let attempt = 0; ; attempt++) {
        const latest = await load();
        if (!latest.self.creator) throw new AccountFailure(403, 'creator-required');
        if (latest.allowLinkJoin === allowLinkJoin) break;
        try {
          await accountMemberAdmin({ op: 'set-entry', allowLinkJoin, expectedAccessRevision: latest.accessRevision, requestId: crypto.randomUUID() });
          await load();
          break;
        } catch (e) {
          // 读到版本号之后、改之前有人进来了:再读一次再改(名单照落账那一刻算);只重来一次,再变就如实报
          if (attempt === 0 && e instanceof AccountFailure && e.code === 'access-revision-mismatch') continue;
          throw e;
        }
      }
    } catch (e) {
      if (generation.current === own) {
        setError(e instanceof Error ? e.message : '进入方式没有改成，请重试。');
        void load().catch(() => undefined);
      }
    } finally { if (generation.current === own) setBusy(false); }
  };
  if (!shared?.accountId) return null;
  const checked = snapshot?.allowLinkJoin ?? true;
  return <div className="pc-collab-entry" data-pc="collab-entry" data-state={snapshot ? (checked ? 'link' : 'list') : 'loading'}>
    <label className="pc-collab-head">
      <input type="checkbox" data-pc="collab-entry-toggle" checked={checked}
        disabled={!snapshot || busy || disabled || !snapshot.self.creator} onChange={e => { void change(e.target.checked); }} />
      {JOIN_REQUEST_TEXT.entryLabel}
    </label>
    {snapshot && <div className="pc-sync-hint" data-pc="collab-entry-hint">
      {checked ? JOIN_REQUEST_TEXT.entryLinkHint : JOIN_REQUEST_TEXT.entryListHint(snapshot.members.length)}
    </div>}
    {error && <div className="pc-sync-status-line is-err" role="alert" data-pc="collab-entry-error">{error}</div>}
  </div>;
}
