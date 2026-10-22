import { useEffect, useRef, useState } from 'react';
import { createEmptyProject } from '../kernel/project';
import { setActiveDraftId } from '../editor/io/drafts';
import { ensureDevice, enterAccountProject } from '../editor/sync/syncManager';
import { AccountFailure, createAccountClient, projectIdFromLink, projectLink, JOIN_REQUEST_POLL_MS, type Account, type CloudAccountClient, type GuestLogin, type JoinRequestStatus, type ProjectLists } from './client';
import { desktopAccountBridge, isDesktopShellTooOld } from './desktopVault';
import { createRequestIds } from './requestIds';
import { enterOrAskPassword } from './entryFlow';

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

/**
 * 加入时服务端要项目二级密码(`secondary`)、链接失效(`expired`)、被账号名单挡住(`not-listed`:这时 `request` 里是自己那一条申请,
 * 页面显示「你不在这个项目的成员名单中」和「发送申请」),其余错误照常抛出
 */
export type JoinOutcome = 'entered' | 'secondary-required' | 'bad-secondary' | 'expired' | 'not-listed';

/**
 * 云端项目入口的状态与动作:恢复登录、登录 / 退出、项目列表、新建、凭链接加入、进入项目,以及被账号名单挡住时的申请加入
 * (2026-10-22 用户定:发送申请、等创建者通过时每 10 秒问一次、通过后由页面自动再走一次加入)。
 * 桌面开始页的「云端项目」(`AccountProjects.tsx`)和手机版开始页(`src/mobile/MobileStart.tsx`)共用这一份,
 * 两边只是摆法不同。重试同一次新建 / 加入 / 登录 / 发申请时沿用同一个请求号(服务端据此去重)。
 */
export function useAccountProjects({ online, onEnterEditor }: { online: boolean; onEnterEditor: () => void }) {
  const [origin, setOrigin] = useState(online ? location.origin : 'https://visuhive.com');
  const client = useRef<CloudAccountClient | null>(null);
  const [account, setAccount] = useState<Account | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  /** 以游客身份进来时的那一个身份（2026-10-23 用户定）；不是游客就是 null */
  const [guest, setGuest] = useState<GuestLogin | null>(null);
  /** 桌面外壳太老(0.2.8 以前的外壳打了补丁)没有账号桥:入口不报错,只说明要装完整安装包 */
  const [shellOld, setShellOld] = useState(false);
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
  /** 被账号名单挡住的那个项目里,自己那一条申请(没被挡住时为 null) */
  const [request, setRequest] = useState<JoinRequestStatus | null>(null);
  /** 「发送申请」的请求号:没收到回包再点沿用原来的,收到结论就丢掉(`requestIds.ts`,与成员浮层、重开文件那条提示共用) */
  const sendIds = useRef(createRequestIds());
  // 游客没有网站账号,「我创建的 / 我加入的」是向官网要的(`/api/account/projects`),问了只会被 401 挡回来。
  // 他自己建的那一个项目靠本机记着的项目链接回去(开始页那一栏),不走列表
  async function refreshLists() { if (!online || !client.current || client.current.guest) return;
    setListError(''); try { setLists(await client.current.lists()); } catch (e) { setLists(null); if (isDesktopShellTooOld(e)) setShellOld(true); else setListError(e instanceof Error ? e.message : '项目列表暂时不可用。'); } }
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
      catch (e) { if (alive) { if (isDesktopShellTooOld(e)) setShellOld(true); else setError(e instanceof Error ? e.message : '登录恢复失败，请重新登录。'); } }
      finally { if (alive) setBusy(false); }
    })().catch(e => { if (alive) { if (isDesktopShellTooOld(e)) setShellOld(true); else setError(e instanceof Error ? e.message : '账号入口初始化失败。'); setBusy(false); } });
    return () => { alive = false; };
  }, [online]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); }
    catch (e) { if (isDesktopShellTooOld(e)) setShellOld(true); else setError(e instanceof Error ? e.message : '请求失败，请重试。'); } finally { setBusy(false); } }
  async function enter(projectId: string, label: string, firstSession?: Awaited<ReturnType<CloudAccountClient['join']>>) {
    if (!client.current) throw new Error('账号入口尚未就绪。');
    await enterAccountProject({ client: client.current, origin, projectId, name: label, initial: createEmptyProject(label), firstSession });
    setActiveDraftId(null); onEnterEditor();
  }
  /**
   * 从「我的项目」列表点进去。项目设了二级密码而这个账号还没输过当前这一版(刚被通过的申请人、改过密码之后的老成员):
   * 不当失败,把项目链接填进「凭链接加入」那一栏、回 'secondary-required',页面弹出二级密码框改走带密码的加入(`entryFlow.ts`)
   */
  async function open(projectId: string, label: string): Promise<'entered' | 'secondary-required'> {
    const outcome = await enterOrAskPassword(() => enter(projectId, label));
    if (outcome === 'secondary-required') { clearRequest(); joinAttempt.current = null; setLink(projectLink(origin, projectId)); }
    return outcome;
  }
  async function login(name: string, password: string, remember: boolean) {
    if (!client.current) throw new Error('账号入口尚未就绪。');
    if (loginAttempt.current?.name !== name) loginAttempt.current = { name, requestId: crypto.randomUUID() };
    const current = await client.current.login(name, password, remember, loginAttempt.current!.requestId);
    setAccount(current); loginAttempt.current = null; await refreshLists();
  }
  async function logout() { await client.current!.logout(); setAccount(null); setLists(null); clearRequest(); }
  /** 以游客身份进来：本机记着的那一张交回去续期（还是同一个人），没有就领一个新身份 */
  async function enterAsGuest() { setGuest(await client.current!.enterAsGuest()); }
  /** 「换一个」：不交旧令牌，服务端给个新的 */
  async function newGuest() { setGuest(await client.current!.newGuest()); }
  /** 不当游客了（去登录账号）。本机那一份一并清掉 */
  function leaveGuest() { client.current?.leaveGuest(); setGuest(null); setLists(null); clearRequest(); }
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
      if (err?.code === 'not-listed') { joinAttempt.current = null; await checkRequest(projectId); return 'not-listed'; }
      throw err;
    }
    clearRequest();
    await refreshLists(); await enter(projectId, lists?.owned.concat(lists.joined).find(p => p.projectId === projectId)?.name || '云端项目', firstSession);
    joinAttempt.current = null;
    return 'entered';
  }
  /** 被名单挡住之后读自己那一条申请;读不到(网络)就按「没申请过」显示,发不发得成由服务端说了算 */
  async function checkRequest(projectId: string) {
    try { setRequest(await client.current!.joinRequestStatus(projectId)); }
    catch (e) { if (isDesktopShellTooOld(e)) throw e; setRequest({ projectId, state: 'none', entry: 'list', canApply: true }); }
  }
  /** 点「发送申请」。同一次发送没收到回包时再点,沿用原来的请求号(服务端不会多记一次);收到结论的,下次点算新的一次 */
  async function sendRequest() {
    const projectId = request?.projectId;
    const c = client.current;
    if (!projectId || !c) return;
    try {
      setRequest(await sendIds.current.run(`send:${projectId}`, requestId => c.sendJoinRequest(projectId, requestId)));
    } catch (e) {
      // 这时项目已经改回知道链接就能进:按读到的状态显示,页面接着自己去加入
      if (e instanceof AccountFailure && e.code === 'entry-open') { await checkRequest(projectId); return; }
      throw e;
    }
  }
  function clearRequest() { setRequest(null); sendIds.current.forget(); }
  // 等创建者处理时每 10 秒问一次自己那一条;页面看不见时不问,回到前台马上问一次。通过、被拒、项目改回知道链接就能进,都由这里看到。
  // 项目已经改回「知道链接就能进」(`entry` 不是 `list`)就不再问:页面这时直接去加入(弹着二级密码框的也一样),不空转
  useEffect(() => {
    if (request?.state !== 'pending' || request.entry !== 'list') return;
    const projectId = request.projectId;
    let alive = true;
    const check = () => {
      if (!alive || !client.current || document.visibilityState === 'hidden') return;
      void client.current.joinRequestStatus(projectId).then(status => { if (alive) setRequest(cur => cur?.projectId === projectId ? status : cur); }, () => undefined);
    };
    const timer = setInterval(check, JOIN_REQUEST_POLL_MS);
    document.addEventListener('visibilitychange', check);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [request?.state, request?.entry, request?.projectId]);
  // 读到申请被通过(`member`):马上重取项目列表,这个项目当场出现在「我加入的」里(设了二级密码、还没输的也在,从那里点进去先问密码)
  useEffect(() => { if (request?.state === 'member') void refreshLists(); }, [request?.state, request?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { origin, account, busy, error, setError, shellOld, link, setLink, lists, listError, refreshLists, perform, enter, open, login, logout, create, join,
    guest, enterAsGuest, newGuest, leaveGuest,
    request, sendRequest, clearRequest,
    projectLink: (projectId: string) => projectLink(origin, projectId) };
}
