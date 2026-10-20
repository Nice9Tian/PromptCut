import { useEffect, useRef, useState } from 'react';
import { createEmptyProject } from '../kernel/project';
import { setActiveDraftId } from '../editor/io/drafts';
import { ensureDevice, enterAccountProject } from '../editor/sync/syncManager';
import { createAccountClient, projectIdFromLink, projectLink, type Account, type CloudAccountClient, type ProjectLists } from './client';
import { desktopAccountBridge } from './desktopVault';

function tokenFromLink(text: string): string | undefined {
  const value = text.trim();
  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.searchParams.get('token') || url.searchParams.get('linkToken') || undefined;
    } catch {}
  }
  return undefined;
}

/** 加入时服务端要项目二级密码(`secondary`)、链接失效(`expired`),其余错误照常抛出 */
export type JoinOutcome = 'entered' | 'secondary-required' | 'bad-secondary' | 'expired';

/**
 * 云端项目入口的状态与动作:恢复登录、登录 / 退出、项目列表、新建、凭链接加入、进入项目。
 * 桌面开始页的「云端项目」(`AccountProjects.tsx`)和手机版开始页(`src/mobile/MobileStart.tsx`)共用这一份,
 * 两边只是摆法不同。重试同一次新建 / 加入 / 登录时沿用同一个请求号(服务端据此去重)。
 */
export function useAccountProjects({ online, onEnterEditor }: { online: boolean; onEnterEditor: () => void }) {
  const [origin, setOrigin] = useState(online ? location.origin : 'https://visuhive.com');
  const client = useRef<CloudAccountClient | null>(null);
  const [account, setAccount] = useState<Account | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [link, setLink] = useState(() => {
    const sp = new URL(location.href).searchParams;
    const id = sp.get('project');
    const token = sp.get('token') || sp.get('linkToken') || undefined;
    return id ? projectLink(origin, id, token) : '';
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
      const serviceOrigin = online ? location.origin : (await desktopAccountBridge('configuration') as { origin: string }).origin;
      if (!alive) return; setOrigin(serviceOrigin);
      const sp = new URL(location.href).searchParams;
      const invited = sp.get('project');
      const token = sp.get('token') || sp.get('linkToken') || undefined;
      if (invited) setLink(projectLink(serviceOrigin, invited, token));
      const c = createAccountClient({ online, origin: serviceOrigin, device, ...(!online ? { native: desktopAccountBridge } : {}) }); client.current = c;
      try { const current = await c.restore(); if (alive) { setAccount(current); if (current) await refreshLists(); } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : '登录恢复失败，请重新登录。'); }
      finally { if (alive) setBusy(false); }
    })().catch(e => { if (alive) { setError(e instanceof Error ? e.message : '账号入口初始化失败。'); setBusy(false); } });
    return () => { alive = false; };
  }, [online]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : '请求失败，请重试。'); } finally { setBusy(false); } }
  async function enter(projectId: string, label: string, firstSession?: Awaited<ReturnType<CloudAccountClient['join']>>) {
    if (!client.current) throw new Error('账号入口尚未就绪。');
    await enterAccountProject({ client: client.current, origin, projectId, name: label, initial: createEmptyProject(label), firstSession });
    setActiveDraftId(null); onEnterEditor();
  }
  async function login(name: string, password: string, remember: boolean) {
    if (!client.current) throw new Error('账号入口尚未就绪。');
    if (loginAttempt.current?.name !== name) loginAttempt.current = { name, requestId: crypto.randomUUID() };
    const current = await client.current.login(name, password, remember, loginAttempt.current!.requestId);
    setAccount(current); loginAttempt.current = null; await refreshLists();
  }
  async function logout() { await client.current!.logout(); setAccount(null); setLists(null); }
  async function create(projectName: string) {
    const c = client.current!;
    if (createAttempt.current?.name !== projectName) createAttempt.current = { name: projectName, requestId: crypto.randomUUID(), initial: createEmptyProject(projectName) };
    const attempt = createAttempt.current!;
    if (!attempt.projectId) attempt.projectId = (await c.create(attempt.name, attempt.initial, attempt.requestId)).projectId;
    setLink(projectLink(origin, attempt.projectId)); await refreshLists(); await enter(attempt.projectId, attempt.name); createAttempt.current = null;
  }
  async function join(linkText: string, secondaryPassword: string | undefined): Promise<JoinOutcome> {
    const projectId = projectIdFromLink(linkText, origin);
    const token = tokenFromLink(linkText) || new URL(location.href).searchParams.get('token') || new URL(location.href).searchParams.get('linkToken') || undefined;
    if (joinAttempt.current?.projectId !== projectId) joinAttempt.current = { projectId, requestId: crypto.randomUUID() };
    let firstSession;
    try {
      firstSession = await client.current!.join(projectId, joinAttempt.current!.requestId, { token, secondaryPassword });
    } catch (err: any) {
      if (err?.code === 'secondary-password-required') return 'secondary-required';
      if (err?.code === 'bad-secondary-password') return 'bad-secondary';
      if (err?.code === 'link-expired') return 'expired';
      throw err;
    }
    await refreshLists(); await enter(projectId, lists?.owned.concat(lists.joined).find(p => p.projectId === projectId)?.name || '云端项目', firstSession);
    joinAttempt.current = null;
    return 'entered';
  }
  return { origin, account, busy, error, setError, link, setLink, lists, listError, refreshLists, perform, enter, login, logout, create, join,
    projectLink: (projectId: string) => projectLink(origin, projectId) };
}
