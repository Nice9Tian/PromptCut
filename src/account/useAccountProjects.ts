import { useEffect, useRef, useState } from 'react';
import { createEmptyProject } from '../kernel/project';
import { setActiveDraftId } from '../editor/io/drafts';
import { ensureDevice, enterAccountProject } from '../editor/sync/syncManager';
import { AccountFailure, createAccountClient, linkTokenFromLink, projectIdFromLink, projectLink, JOIN_REQUEST_POLL_MS, type Account, type CloudAccountClient, type JoinRequestStatus, type ProjectLists } from './client';
import { desktopAccountBridge, isDesktopShellTooOld } from './desktopVault';
import { createRequestIds } from './requestIds';
import { enterOrAskPassword } from './entryFlow';
import { JOIN_REQUEST_TEXT } from './joinRequestText';
import { projectPath, readProjectAddress, type ProjectAddress } from '../online/projectAddress';

/** 编辑器页的根路径:在线构建是 `/editor/`,桌面是 `/` */
const PAGE_BASE = (typeof import.meta.env !== 'undefined' && import.meta.env.BASE_URL) || '/';

/** 这一页地址里的项目:直达地址、分享链接、旧的 `?project=&token=`(`projectAddress.ts`) */
function pageAddress(): ProjectAddress | null {
  try { return readProjectAddress(new URL(location.href), PAGE_BASE); } catch { return null; }
}
const linkOf = (origin: string, a: ProjectAddress) => projectLink(origin, a.projectId, a.kind === 'share' ? a.token : undefined);

/** 进了项目:地址栏换成它的直达地址,刷新后还在这个项目里;链接令牌、旧的 `?project=` 不留在地址栏里(`product/platforms.md`「项目直达地址」) */
function showProjectAddress(projectId: string) {
  try {
    const url = new URL(location.href);
    url.pathname = projectPath(projectId, PAGE_BASE);
    for (const key of ['project', 'token', 'linkToken']) url.searchParams.delete(key);
    history.replaceState(history.state, '', url);
  } catch { /* 改不了地址栏不影响进项目 */ }
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
  /** 桌面外壳太老(0.2.8 以前的外壳打了补丁)没有账号桥:入口不报错,只说明要装完整安装包 */
  const [shellOld, setShellOld] = useState(false);
  const [link, setLink] = useState(() => { const a = pageAddress(); return a ? linkOf(origin, a) : ''; });
  /** 页面是从项目直达地址打开的(只认在线页面):登录恢复或登录之后自动进一次,进过就清掉 */
  const direct = useRef<string | null>(null);
  /** 自动进项目时要先输二级密码:界面照「从列表点进去」那样弹出输入框(`AccountProjects.tsx`、`MobileStart.tsx`) */
  const [directSecondary, setDirectSecondary] = useState<string | null>(null);
  const [lists, setLists] = useState<ProjectLists | null>(null), [listError, setListError] = useState('');
  const createAttempt = useRef<{ name: string; requestId: string; initial: ReturnType<typeof createEmptyProject>; projectId?: string } | null>(null);
  const joinAttempt = useRef<{ projectId: string; requestId: string } | null>(null);
  const loginAttempt = useRef<{ name: string; requestId: string } | null>(null);
  /** 被账号名单挡住的那个项目里,自己那一条申请(没被挡住时为 null) */
  const [request, setRequest] = useState<JoinRequestStatus | null>(null);
  /** 「发送申请」的请求号:没收到回包再点沿用原来的,收到结论就丢掉(`requestIds.ts`,与成员浮层、重开文件那条提示共用) */
  const sendIds = useRef(createRequestIds());
  async function refreshLists(): Promise<ProjectLists | null> { if (!online || !client.current) return null;
    setListError(''); try { const next = await client.current.lists(); setLists(next); return next; } catch (e) { setLists(null); if (isDesktopShellTooOld(e)) setShellOld(true); else setListError(e instanceof Error ? e.message : '项目列表暂时不可用。'); return null; } }
  useEffect(() => { let alive = true;
    void (async () => { const device = await ensureDevice(); if (!alive) return;
      if (!device) throw new Error('无法取得当前设备身份，请重试。');
      const serviceOrigin = online ? location.origin : (await desktopAccountBridge('configuration') as { origin: string }).origin;
      if (!alive) return; setOrigin(serviceOrigin);
      const invited = pageAddress();
      if (invited) setLink(linkOf(serviceOrigin, invited));
      direct.current = online && invited?.kind === 'project' ? invited.projectId : null;
      const c = createAccountClient({ online, origin: serviceOrigin, device, ...(!online ? { native: desktopAccountBridge } : {}) }); client.current = c;
      try { const current = await c.restore(); if (alive) { setAccount(current); if (current) { const l = await refreshLists(); if (alive) await enterDirect(l); } } }
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
    if (online) showProjectAddress(projectId);
  }
  /**
   * 页面是从项目直达地址打开的:恢复登录或登录之后自动进一次(`product/platforms.md`「项目直达地址」)。进不去照常抛出,
   * 由调用方显示原因;要二级密码时交给界面弹输入框(`directSecondary`)
   */
  async function enterDirect(current: ProjectLists | null) {
    const projectId = direct.current;
    if (!projectId || !client.current) return;
    direct.current = null;
    const label = current?.owned.concat(current.joined).find(p => p.projectId === projectId)?.name || '云端项目';
    try {
      if (await open(projectId, label) === 'secondary-required') setDirectSecondary(projectId);
    } catch (e) {
      // 还不是成员:不当错误,说一句让用户自己点加入(链接已填好;加入是用户的动作,不自动加。只许名单的项目点了走「发送申请」)
      if (e instanceof AccountFailure && e.code === 'not-listed') { setError(JOIN_REQUEST_TEXT.directNotMember); return; }
      throw e;
    }
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
    setAccount(current); loginAttempt.current = null;
    await enterDirect(await refreshLists());
  }
  async function logout() { await client.current!.logout(); setAccount(null); setLists(null); clearRequest(); }
  async function create(projectName: string) {
    const c = client.current!;
    if (createAttempt.current?.name !== projectName) createAttempt.current = { name: projectName, requestId: crypto.randomUUID(), initial: createEmptyProject(projectName) };
    const attempt = createAttempt.current!;
    if (!attempt.projectId) attempt.projectId = (await c.create(attempt.name, attempt.initial, attempt.requestId)).projectId;
    setLink(projectLink(origin, attempt.projectId)); await refreshLists(); await enter(attempt.projectId, attempt.name); createAttempt.current = null;
  }
  async function join(linkText: string, secondaryPassword: string | undefined): Promise<JoinOutcome> {
    const projectId = projectIdFromLink(linkText, origin);
    // 输入框里只填了项目号时,用这一页地址里同一个项目的链接令牌(分享链接打开的页面)
    const page = pageAddress();
    const token = linkTokenFromLink(linkText) || (page?.kind === 'share' && page.projectId === projectId ? page.token : undefined);
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
    request, sendRequest, clearRequest, directSecondary, clearDirectSecondary: () => setDirectSecondary(null),
    projectLink: (projectId: string) => projectLink(origin, projectId) };
}
