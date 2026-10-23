import { useEffect, useState } from 'react';
import { useAccountProjects } from './useAccountProjects';
import { OLD_SHELL_ACCOUNT_TEXT } from './desktopVault';
import { JOIN_REQUEST_TEXT, autoJoinKey, joinRequestNotice } from './joinRequestText';
import { GUEST_LIMITS_TEXT } from './guest.ts';
import { GuestChip } from './GuestAvatar';
import './account.css';

export function AccountProjects({ online, onEnterEditor }: { online: boolean; onEnterEditor: () => void }) {
  const ap = useAccountProjects({ online, onEnterEditor });
  const { origin, account, busy, error, setError, shellOld, link, setLink, lists, listError, perform, request, guest, guestProject } = ap;
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [remember, setRemember] = useState(false);
  const [projectName, setProjectName] = useState('未命名');
  const [secondaryPassword, setSecondaryPassword] = useState('');
  const [askSecondaryPassword, setAskSecondaryPassword] = useState(false);
  /** 凭链接加入(表单提交、申请被通过后自动再试都走这里);被账号名单挡住时不弹错误,由下面申请那一块说明 */
  const submitJoin = (secondary: string | undefined) => perform(async () => {
    const outcome = await ap.join(link, secondary);
    if (outcome === 'secondary-required' || outcome === 'bad-secondary') {
      setAskSecondaryPassword(true);
      setError(outcome === 'bad-secondary' ? '项目二级密码不正确。' : JOIN_REQUEST_TEXT.secondaryRequired);
      return;
    }
    if (outcome === 'expired') {
      setError('该项目链接已失效，请联系创建者获取最新链接。');
      return;
    }
    if (outcome === 'not-listed') return;
    setAskSecondaryPassword(false);
    setSecondaryPassword('');
  });
  // 申请被创建者通过、或项目改回「知道链接就能进」:自动再走一次加入(项目设了二级密码的接着问一次密码)
  const autoJoin = autoJoinKey(request);
  useEffect(() => { if (autoJoin) void submitJoin(undefined); }, [autoJoin]); // eslint-disable-line react-hooks/exhaustive-deps
  // 从项目直达地址自动进项目时要先输二级密码:和从列表点进去一样弹出输入框(链接已由 open 填好)
  useEffect(() => {
    if (!ap.directSecondary) return;
    setAskSecondaryPassword(true); setSecondaryPassword(''); setError(JOIN_REQUEST_TEXT.secondaryRequired);
    ap.clearDirectSecondary();
  }, [ap.directSecondary]); // eslint-disable-line react-hooks/exhaustive-deps
  const notice = request && account ? joinRequestNotice(request) : null;
  return <section className="sp-section sp-account" data-pc="account-projects">
    <div className="sp-section-head"><h2 className="sp-section-title">云端项目</h2>
      <a className="sp-ghost-btn" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">官网账号与项目列表</a></div>
    {shellOld ? <p className="sp-muted" role="status" data-pc="account-shell-old">{OLD_SHELL_ACCOUNT_TEXT}</p> : <>
    {error && <div className="sp-error" role="alert" data-pc="account-error">{error}</div>}
    {!account && !guest ? <>
      <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
        await ap.login(name, password, remember);
        setPassword('');
      }); }}>
        <label>账号名<input name="username" autoComplete="username" required value={name} onChange={e => setName(e.target.value)} /></label>
        <label>密码<input name="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        {online && <label className="sp-account-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />记住登录状态</label>}
        <button className="sp-primary-btn" disabled={busy}>{busy ? '正在连接…' : '登录账号'}</button>
        <a href={`${origin}/account`} target="_blank" rel="noopener noreferrer">注册账号 / 忘记密码</a>
      </form>
      {/* 游客（2026-10-23 用户定）：没有账号也能进来试，进来时随机分一个编号和头像。桌面版走外壳的账号桥，
          桥上没有这一条，所以只在线页面给这个入口（`client.ts` 的 `enterAsGuest` 在桌面版会明说要用官网） */}
      {online && <div className="sp-guest-entry" data-pc="guest-entry">
        <span className="sp-muted">没有账号也可以先进来看看，系统给你一个临时身份。</span>
        <button type="button" className="sp-ghost-btn" data-pc="guest-enter" disabled={busy}
          onClick={() => void perform(ap.enterAsGuest)}>{busy ? '正在进入…' : '以游客身份进入'}</button>
        <span className="sp-muted sp-guest-limits" data-pc="guest-limits">{GUEST_LIMITS_TEXT}</span>
      </div>}
    </> : <>
      {guest
        ? <div className="sp-account-row" data-pc="guest-row">
            <GuestChip id={guest.id} />
            <button className="sp-ghost-btn" data-pc="guest-new" disabled={busy} onClick={() => void perform(ap.newGuest)}>换一个</button>
            <button className="sp-ghost-btn" data-pc="guest-leave" disabled={busy} onClick={() => ap.leaveGuest()}>我有账号，去登录</button>
          </div>
        : <div className="sp-account-row"><span data-pc="account-name">已登录：{account!.name}</span><button className="sp-ghost-btn" disabled={busy} onClick={() => void perform(ap.logout)}>退出登录</button></div>}
      {guest && <p className="sp-muted sp-guest-limits" data-pc="guest-limits">{GUEST_LIMITS_TEXT}</p>}
      {/* 游客没有「我创建的」那张表（它是向官网账号要的），自己建的那一个项目靠本机记着的那一条列出来 */}
      {guest && guestProject && <div className="sp-account-row" data-pc="guest-project">
        <button className="sp-ghost-btn" data-pc="guest-project-open" disabled={busy}
          onClick={() => void perform(ap.openGuestProject)}>{guestProject.name}</button>
        <button className="sp-ghost-btn" onClick={() => { setLink(ap.projectLink(guestProject.id)); }}>显示项目链接</button>
      </div>}
      <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(() => ap.create(projectName)); }}>
        <label>项目名<input data-pc="cloud-project-name" required maxLength={200} value={projectName} onChange={e => setProjectName(e.target.value)} /></label>
        <button className="sp-primary-btn" data-pc="cloud-create" disabled={busy || !!(guest && guestProject)}
          title={guest && guestProject ? '游客只能建一个项目' : undefined}>{busy ? '正在处理…' : '新建云端项目'}</button>
      </form>
    </>}
    <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void submitJoin(askSecondaryPassword ? secondaryPassword : (secondaryPassword || undefined)); }}>
      <label>项目链接<input data-pc="cloud-project-link" type="text" required placeholder="粘贴云端项目链接" value={link} onChange={e => { setLink(e.target.value); setAskSecondaryPassword(false); ap.clearRequest(); }} /></label>
      {askSecondaryPassword && (
        <label>项目二级密码<input data-pc="cloud-secondary-password" type="password" required placeholder="请输入项目二级密码" value={secondaryPassword} onChange={e => setSecondaryPassword(e.target.value)} /></label>
      )}
      <button className="sp-primary-btn" data-pc="cloud-join" disabled={busy || (!account && !guest)}>{askSecondaryPassword ? '验证二级密码并加入' : '加入并打开项目'}</button>
      {/* 被账号名单挡住(2026-10-22 用户定):「你不在这个项目的成员名单中」+「发送申请」;发出后「已发送，等创建者通过」;被拒「创建者没有通过你的申请」 */}
      {notice && request && <div className="sp-join-request" role="status" data-pc="join-request" data-state={request.state}>
        <span data-pc="join-request-text">{notice.text}</span>
        {notice.canSend && <button type="button" className="sp-primary-btn" data-pc="join-request-send" disabled={busy}
          onClick={() => { void perform(ap.sendRequest); }}>{JOIN_REQUEST_TEXT.send}</button>}
        {notice.hint && <span className="sp-muted" data-pc="join-request-hint">{notice.hint}</span>}
      </div>}
    </form>
    {lists && <div data-pc="cloud-project-lists">{(['owned', 'joined'] as const).map(kind => <div key={kind}>
      <h3>{kind === 'owned' ? '我创建的' : '我加入的'}</h3>{lists[kind].length === 0 ? <p className="sp-muted">暂无项目</p> : lists[kind].map(p =>
        <div className="sp-account-row" key={p.projectId}><button className="sp-ghost-btn" data-pc="cloud-project-open" data-project={p.projectId} disabled={busy} onClick={() => void perform(async () => {
          // 设了二级密码而还没输过当前这一版(刚被通过的申请人等):不报错,链接填好、弹出二级密码框,输了走「验证二级密码并加入」
          if (await ap.open(p.projectId, p.name) === 'secondary-required') { setAskSecondaryPassword(true); setSecondaryPassword(''); setError(JOIN_REQUEST_TEXT.secondaryRequired); }
        })}>{p.name}</button>
          <button className="sp-ghost-btn" onClick={() => { setLink(ap.projectLink(p.projectId)); }}>显示项目链接</button></div>)}</div>)}</div>}
    {listError && <p role="status">{listError}<button className="sp-ghost-btn" disabled={busy} onClick={() => void ap.refreshLists()}>重试列表</button></p>}
    {!online && <p className="sp-muted">本机项目照常使用本地身份。账号登录用于云端；恢复凭据由桌面版安全保存。</p>}
    </>}
  </section>;
}
