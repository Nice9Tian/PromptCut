import { useEffect, useRef, useState } from 'react';
import { createEmptyProject } from '../kernel/project';
import { setActiveDraftId } from '../editor/io/drafts';
import { ensureDevice, enterAccountProject } from '../editor/sync/syncManager';
import { createAccountClient, projectIdFromLink, projectLink, type Account, type CloudAccountClient, type ProjectLists } from './client';
import { desktopAccountBridge } from './desktopVault';

export function AccountProjects({ online, onEnterEditor }: { online: boolean; onEnterEditor: () => void }) {
  const origin = online ? location.origin : 'https://visuhive.com';
  const client = useRef<CloudAccountClient | null>(null);
  const [account, setAccount] = useState<Account | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [remember, setRemember] = useState(false);
  const [projectName, setProjectName] = useState('未命名'), [link, setLink] = useState(() => {
    const id = new URL(location.href).searchParams.get('project'); return id ? projectLink(origin, id) : '';
  });
  const [lists, setLists] = useState<ProjectLists | null>(null), [listError, setListError] = useState('');
  const createAttempt = useRef<{ name: string; requestId: string; initial: ReturnType<typeof createEmptyProject>; projectId?: string } | null>(null);
  const joinAttempt = useRef<{ projectId: string; requestId: string } | null>(null);
  const loginAttempt = useRef<{ name: string; requestId: string } | null>(null);
  async function refreshLists() { if (!online || !client.current) return;
    setListError(''); try { setLists(await client.current.lists()); } catch (e) { setLists(null); setListError(e instanceof Error ? e.message : '项目列表暂时不可用。'); } }
  useEffect(() => { let alive = true;
    void (async () => { const device = await ensureDevice(); if (!alive) return;
      if (!device) throw new Error('无法取得当前设备身份，请重试。');
      const c = createAccountClient({ online, origin, device, ...(!online ? { native: desktopAccountBridge } : {}) }); client.current = c;
      try { const current = await c.restore(); if (alive) { setAccount(current); if (current) await refreshLists(); } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : '登录恢复失败，请重新登录。'); }
      finally { if (alive) setBusy(false); }
    })().catch(e => { if (alive) { setError(e instanceof Error ? e.message : '账号入口初始化失败。'); setBusy(false); } });
    return () => { alive = false; };
  }, [online, origin]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : '请求失败，请重试。'); } finally { setBusy(false); } }
  async function enter(projectId: string, label: string, firstSession?: Awaited<ReturnType<CloudAccountClient['join']>>) {
    if (!client.current) throw new Error('账号入口尚未就绪。');
    await enterAccountProject({ client: client.current, origin, projectId, name: label, initial: createEmptyProject(label), firstSession });
    setActiveDraftId(null); onEnterEditor();
  }
  return <section className="sp-section sp-account" data-pc="account-projects">
    <div className="sp-section-head"><h2 className="sp-section-title">云端项目</h2>
      <a className="sp-ghost-btn" href={`${origin}/`} target="_blank" rel="noopener noreferrer">官网账号与项目列表</a></div>
    {error && <div className="sp-error" role="alert" data-pc="account-error">{error}</div>}
    {!account ? <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
      if (!client.current) throw new Error('账号入口尚未就绪。');
      if (loginAttempt.current?.name !== name) loginAttempt.current = { name, requestId: crypto.randomUUID() };
      const current = await client.current.login(name, password, remember, loginAttempt.current!.requestId);
      setPassword(''); setAccount(current); loginAttempt.current = null; await refreshLists();
    }); }}>
      <label>账号名<input name="username" autoComplete="username" required value={name} onChange={e => setName(e.target.value)} /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      {online && <label className="sp-account-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />记住登录状态</label>}
      <button className="sp-primary-btn" disabled={busy}>{busy ? '正在连接…' : '登录账号'}</button>
      <a href={`${origin}/`} target="_blank" rel="noopener noreferrer">注册账号 / 忘记密码</a>
    </form> : <>
      <div className="sp-account-row"><span data-pc="account-name">已登录：{account.name}</span><button className="sp-ghost-btn" disabled={busy} onClick={() => void perform(async () => {
        await client.current!.logout(); setAccount(null); setLists(null);
      })}>退出登录</button></div>
      <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
        const c = client.current!;
        if (createAttempt.current?.name !== projectName) createAttempt.current = { name: projectName, requestId: crypto.randomUUID(), initial: createEmptyProject(projectName) };
        const attempt = createAttempt.current!;
        if (!attempt.projectId) attempt.projectId = (await c.create(attempt.name, attempt.initial, attempt.requestId)).projectId;
        setLink(projectLink(origin, attempt.projectId)); await refreshLists(); await enter(attempt.projectId, attempt.name); createAttempt.current = null;
      }); }}>
        <label>项目名<input data-pc="cloud-project-name" required maxLength={200} value={projectName} onChange={e => setProjectName(e.target.value)} /></label>
        <button className="sp-primary-btn" data-pc="cloud-create" disabled={busy}>{busy ? '正在处理…' : '新建云端项目'}</button>
      </form>
    </>}
    <form className="sp-account-form" onSubmit={e => { e.preventDefault(); void perform(async () => {
      const projectId = projectIdFromLink(link, origin);
      if (joinAttempt.current?.projectId !== projectId) joinAttempt.current = { projectId, requestId: crypto.randomUUID() };
      const firstSession = await client.current!.join(projectId, joinAttempt.current!.requestId);
      await refreshLists(); await enter(projectId, lists?.owned.concat(lists.joined).find(p => p.projectId === projectId)?.name || '云端项目', firstSession);
      joinAttempt.current = null;
    }); }}>
      <label>项目链接<input data-pc="cloud-project-link" type="text" required placeholder="粘贴云端项目链接" value={link} onChange={e => setLink(e.target.value)} /></label>
      <button className="sp-primary-btn" data-pc="cloud-join" disabled={busy || !account}>加入并打开项目</button>
    </form>
    {lists && <div data-pc="cloud-project-lists">{(['owned', 'joined'] as const).map(kind => <div key={kind}>
      <h3>{kind === 'owned' ? '我创建的' : '我加入的'}</h3>{lists[kind].length === 0 ? <p className="sp-muted">暂无项目</p> : lists[kind].map(p =>
        <div className="sp-account-row" key={p.projectId}><button className="sp-ghost-btn" disabled={busy} onClick={() => void perform(() => enter(p.projectId, p.name))}>{p.name}</button>
          <button className="sp-ghost-btn" onClick={() => { setLink(projectLink(origin, p.projectId)); }}>显示项目链接</button></div>)}</div>)}</div>}
    {listError && <p role="status">{listError}<button className="sp-ghost-btn" disabled={busy} onClick={() => void refreshLists()}>重试列表</button></p>}
    {!online && <p className="sp-muted">本机项目照常使用本地身份。账号登录用于云端；恢复凭据由桌面版安全保存。</p>}
  </section>;
}
