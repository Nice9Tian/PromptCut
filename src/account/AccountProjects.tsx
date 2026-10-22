import { useState } from 'react';
import { useAccountProjects } from './useAccountProjects';
import { OLD_SHELL_ACCOUNT_TEXT } from './desktopVault';

export function AccountProjects({ online, onEnterEditor }: { online: boolean; onEnterEditor: () => void }) {
  const ap = useAccountProjects({ online, onEnterEditor });
  const { origin, account, busy, error, setError, shellOld, link, setLink, lists, listError, perform } = ap;
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [remember, setRemember] = useState(false);
  const [projectName, setProjectName] = useState('未命名');
  const [secondaryPassword, setSecondaryPassword] = useState('');
  const [askSecondaryPassword, setAskSecondaryPassword] = useState(false);
  return <section className="sp-section sp-account" data-pc="account-projects">
    <div className="sp-section-head"><h2 className="sp-section-title">云端项目</h2>
      <a className="sp-ghost-btn" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">官网账号与项目列表</a></div>
    {shellOld ? <p className="sp-muted" role="status" data-pc="account-shell-old">{OLD_SHELL_ACCOUNT_TEXT}</p> : <>
    {error && <div className="sp-error" role="alert" data-pc="account-error">{error}</div>}
    {!account ? <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
      await ap.login(name, password, remember);
      setPassword('');
    }); }}>
      <label>账号名<input name="username" autoComplete="username" required value={name} onChange={e => setName(e.target.value)} /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      {online && <label className="sp-account-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />记住登录状态</label>}
      <button className="sp-primary-btn" disabled={busy}>{busy ? '正在连接…' : '登录账号'}</button>
      <a href={`${origin}/account`} target="_blank" rel="noopener noreferrer">注册账号 / 忘记密码</a>
    </form> : <>
      <div className="sp-account-row"><span data-pc="account-name">已登录：{account.name}</span><button className="sp-ghost-btn" disabled={busy} onClick={() => void perform(ap.logout)}>退出登录</button></div>
      <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(() => ap.create(projectName)); }}>
        <label>项目名<input data-pc="cloud-project-name" required maxLength={200} value={projectName} onChange={e => setProjectName(e.target.value)} /></label>
        <button className="sp-primary-btn" data-pc="cloud-create" disabled={busy}>{busy ? '正在处理…' : '新建云端项目'}</button>
      </form>
    </>}
    <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
      const outcome = await ap.join(link, askSecondaryPassword ? secondaryPassword : (secondaryPassword || undefined));
      if (outcome === 'secondary-required' || outcome === 'bad-secondary') {
        setAskSecondaryPassword(true);
        setError(outcome === 'bad-secondary' ? '项目二级密码不正确。' : '该项目设置了项目二级密码，请输入二级密码。');
        return;
      }
      if (outcome === 'expired') {
        setError('该项目链接已失效，请联系创建者获取最新链接。');
        return;
      }
      setAskSecondaryPassword(false);
      setSecondaryPassword('');
    }); }}>
      <label>项目链接<input data-pc="cloud-project-link" type="text" required placeholder="粘贴云端项目链接" value={link} onChange={e => { setLink(e.target.value); setAskSecondaryPassword(false); }} /></label>
      {askSecondaryPassword && (
        <label>项目二级密码<input data-pc="cloud-secondary-password" type="password" required placeholder="请输入项目二级密码" value={secondaryPassword} onChange={e => setSecondaryPassword(e.target.value)} /></label>
      )}
      <button className="sp-primary-btn" data-pc="cloud-join" disabled={busy || !account}>{askSecondaryPassword ? '验证二级密码并加入' : '加入并打开项目'}</button>
    </form>
    {lists && <div data-pc="cloud-project-lists">{(['owned', 'joined'] as const).map(kind => <div key={kind}>
      <h3>{kind === 'owned' ? '我创建的' : '我加入的'}</h3>{lists[kind].length === 0 ? <p className="sp-muted">暂无项目</p> : lists[kind].map(p =>
        <div className="sp-account-row" key={p.projectId}><button className="sp-ghost-btn" disabled={busy} onClick={() => void perform(() => ap.enter(p.projectId, p.name))}>{p.name}</button>
          <button className="sp-ghost-btn" onClick={() => { setLink(ap.projectLink(p.projectId)); }}>显示项目链接</button></div>)}</div>)}</div>}
    {listError && <p role="status">{listError}<button className="sp-ghost-btn" disabled={busy} onClick={() => void ap.refreshLists()}>重试列表</button></p>}
    {!online && <p className="sp-muted">本机项目照常使用本地身份。账号登录用于云端；恢复凭据由桌面版安全保存。</p>}
    </>}
  </section>;
}
