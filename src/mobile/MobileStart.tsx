/**
 * 手机版开始页(项目列表,演示稿第一屏):新建云端项目、加入别人的项目、我的项目。
 * 账号与项目的动作和桌面在线开始页同一份(`src/account/useAccountProjects.ts`);在线页面没有本机存储,「存储」一块不显示。
 */
import { useEffect, useState } from "react";
import { useAccountProjects } from "../account/useAccountProjects";
import { JOIN_REQUEST_TEXT, autoJoinKey, joinRequestNotice } from "../account/joinRequestText";
import { LogoMark } from "../ui/Logo";
import { BrandGlow } from "../start/BrandGlow";
import { Icon } from "./icons";
import { Sheet } from "./ui";
import "./mobileLogin.css";

export function MobileStart({ onEnterEditor }: { onEnterEditor: () => void }) {
  const ap = useAccountProjects({ online: true, onEnterEditor });
  const { account, busy, error, setError, lists, listError, perform, request } = ap;
  const [name, setName] = useState(""), [password, setPassword] = useState(""), [remember, setRemember] = useState(false);
  const [sheet, setSheet] = useState<"new" | "join" | null>(null);
  /**
   * 以游客身份进来了(用户 2026-10-23:「手机版游客键也点了就进，和桌面一样」)。
   *
   * 只是**跳过登录这一屏**,和桌面 `OnlineLogin.tsx` 那颗走 `onDone()` 是一回事。
   * 随机分配 ID 和头像、以及游客能不能建项目,归「游客身份随机分配」那个会话;
   * 账号层(`src/account/useAccountProjects.ts`)现在还没有游客接口,所以进来之后
   * 「新建项目」「加入别人的项目」仍然要账号,点了会报错 —— 接口出来之后这里接上就通了。
   */
  const [guest, setGuest] = useState(false);
  /** 真登录上了就不再是游客 */
  const asGuest = guest && !account;
  const [projectName, setProjectName] = useState("未命名");
  const [secondary, setSecondary] = useState(""), [askSecondary, setAskSecondary] = useState(false);
  /** 凭链接加入(表单提交、申请被通过后自动再试都走这里);被账号名单挡住时不弹错误,由面板里申请那一块说明(同桌面 `AccountProjects.tsx`) */
  const submitJoin = (secondaryValue: string | undefined) => perform(async () => {
    const r = await ap.join(ap.link, secondaryValue);
    if (r === "secondary-required" || r === "bad-secondary") { setAskSecondary(true); setError(r === "bad-secondary" ? "项目二级密码不正确。" : JOIN_REQUEST_TEXT.secondaryRequired); return; }
    if (r === "expired") { setError("该项目链接已失效，请联系创建者获取最新链接。"); return; }
    if (r === "not-listed") return;
    setAskSecondary(false); setSecondary("");
  });
  // 申请被创建者通过、或项目改回「知道链接就能进」:打开「加入」面板,自动再走一次加入(设了二级密码的接着问密码)
  const autoJoin = autoJoinKey(request);
  useEffect(() => { if (autoJoin) { setSheet("join"); void submitJoin(undefined); } }, [autoJoin]); // eslint-disable-line react-hooks/exhaustive-deps
  // 从项目直达地址自动进项目时要先输二级密码:和从列表点进去一样打开「加入」面板问密码(同桌面 `AccountProjects.tsx`)
  useEffect(() => {
    if (!ap.directSecondary) return;
    setSheet("join"); setAskSecondary(true); setSecondary(""); setError(JOIN_REQUEST_TEXT.secondaryRequired);
    ap.clearDirectSecondary();
  }, [ap.directSecondary]); // eslint-disable-line react-hooks/exhaustive-deps
  const notice = request && account ? joinRequestNotice(request) : null;
  const rows = lists ? [...lists.owned.map((p) => ({ ...p, mine: true })), ...lists.joined.map((p) => ({ ...p, mine: false }))] : [];

  return (
    <div className="editor" data-pcm="home">
      {/*
        登录这一屏的背景:官网首页那层光的渲染器版(`BrandGlow`,用户 2026-10-23 定,
        换掉了原来那块流动的极光)。表单直接落在它上面,不做实体方框 —— 同桌面窄屏。
        进去之后(登录或游客)这一层就不渲染了,项目列表该是什么样还是什么样。
      */}
      {!account && !asGuest && <div className="ps-m-login-bg" aria-hidden="true"><BrandGlow /></div>}
      <div className="topbar">
        <div className="logo"><LogoMark size={18} /><span>Prompt<b>Cut</b></span></div>
        {account && <span className="chip accent" data-pcm="account-chip"><i className="dot" /> {account.name}</span>}
        {asGuest && <span className="chip" data-pcm="guest-chip">游客</span>}
        {account && <button type="button" className="icon-btn" title="退出登录" aria-label="退出登录" disabled={busy} onClick={() => void perform(ap.logout)}><Icon name="back" /></button>}
        {/* 游客没有「退出登录」可退,但得有一条回登录页的路,否则进来就出不去了 */}
        {asGuest && <button type="button" className="icon-btn" title="退出游客身份" aria-label="退出游客身份" data-pcm="guest-leave" onClick={() => { setError(""); setGuest(false); }}><Icon name="back" /></button>}
      </div>
      <div className="home-body">
        {error && <div className="err" role="alert" data-pcm="home-error">{error}</div>}
        {!account && !asGuest ? (
          <form data-pcm="login" className="ps-m-login-form" onSubmit={(e) => { e.preventDefault(); void perform(async () => { await ap.login(name, password, remember); setPassword(""); }); }}>
            <div className="ps-m-login-head">
              <h2 className="sec">登录账号</h2>
              <span className="ps-m-login-sub">网站账号和官网通用。</span>
            </div>
            <div className="field"><label>账号名</label><input className="text-in" name="username" autoComplete="username" required value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label>密码</label><input className="text-in" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <label className="check-row"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />记住登录状态</label>
            {/* 两个都填了才可点,和桌面 `OnlineLogin.tsx` 的 `disabled={!name || !password}` 一致:
                空着时那颗键是半透明的深色,不是满色的强调色(用户 2026-10-23 对比截图时看到的色差就是这个) */}
            <button type="submit" className="btn primary" disabled={busy || !name || !password}>{busy ? "正在连接…" : "登录账号"}</button>
            <div className="ps-m-login-alt">
              <a href={`${ap.origin}/account`} target="_blank" rel="noopener noreferrer">注册账号</a>
              <a href={`${ap.origin}/account`} target="_blank" rel="noopener noreferrer">忘记密码</a>
            </div>
            <div className="ps-m-login-sep">或</div>
            {/*
              第三方登录的位置,和桌面 `src/start/OnlineLogin.tsx` 里那颗是同一件事:
              `docs/semantics/product/document-service.md` 第 66 行现在写的是「不另做第三方登录」,
              用户还没裁(两版「修改前 / 修改后」记在 `docs/plan/user-decisions-2026-10-23.md` 第 5 节)。
              所以这里也只占位、不接任何逻辑;裁定下来两处一起接上或者一起去掉。
              标记用的是一个普通的「G」字,不是 Google 的官方商标。
            */}
            <button
              type="button"
              className="ps-m-oauth-btn"
              data-pcm="login-google"
              aria-label="用 Google 继续"
              title="待办：OAuth 流程在 VisuHive 仓库，这里只留位置"
            >
              <span className="ps-m-oauth-mark" aria-hidden="true">G</span>
              用 Google 继续
            </button>
            {/*
              游客身份的入口（用户 2026-10-23 要求两个登录页都摆上，并且「点了就进，和桌面一样」）。
              和桌面 `src/start/OnlineLogin.tsx` 里那颗是同一件事：点了跳过登录这一屏。
              随机分配 ID 和头像那套逻辑归「游客身份随机分配」那个会话，这里只管入口。
            */}
            <button
              type="button"
              className="ps-m-oauth-btn"
              data-pcm="login-guest"
              onClick={() => { setError(""); setGuest(true); }}
            >
              <span className="ps-m-oauth-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
                  <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.8c-4 0-7 2-7 4.4V20h14v-1.8c0-2.4-3-4.4-7-4.4Z" />
                </svg>
              </span>
              以游客身份进入
            </button>
          </form>
        ) : (
          <>
            {/*
              游客进来之后的说明。账号层还没有游客接口，所以下面两颗照样要账号，点了会报错；
              先把话说在前面，免得看着像坏了。「游客身份随机分配」那个会话接上之后删掉这一行。
            */}
            {asGuest && <div className="hint" data-pcm="guest-note">游客身份还没接账号服务：现在可以先逛，新建和加入项目仍要登录。</div>}
            <div className="quick">
              <button type="button" className="main" data-pcm="home-new" onClick={() => { setError(""); setSheet("new"); }}>
                <span className="big"><Icon name="plus" /></span><b>新建项目</b><small>云端项目，Agent 开工</small>
              </button>
              <button type="button" data-pcm="home-join" onClick={() => { setError(""); setSheet("join"); }}>
                <span className="big"><Icon name="join" /></span><b>加入别人的项目</b><small>粘贴项目链接</small>
              </button>
            </div>
            <h2 className="sec">我的项目</h2>
            {listError && <div className="hint">{listError} <button type="button" style={{ color: "var(--accent)" }} onClick={() => void ap.refreshLists()}>重试</button></div>}
            {lists && rows.length === 0 && <div className="hint">还没有云端项目。</div>}
            {rows.map((p) => (
              <button key={p.projectId} type="button" className="proj" data-pcm="proj" data-project={p.projectId} disabled={busy} onClick={() => void perform(async () => {
                // 设了二级密码而还没输过当前这一版(刚被通过的申请人等):不报错,打开「加入」面板、链接填好、弹出二级密码框
                if (await ap.open(p.projectId, p.name) === "secondary-required") { setSheet("join"); setAskSecondary(true); setSecondary(""); setError(JOIN_REQUEST_TEXT.secondaryRequired); }
              })}>
                <div className="th" />
                <div className="meta"><div className="name">{p.name}</div><div className="sub">{p.mine ? "我创建的" : "我加入的"}</div>
                  <div className="tags"><span className="chip">云端</span></div></div>
              </button>
            ))}
          </>
        )}
        <div className="note-mobile">手机端是“看与改”：对话、预览、微调、审阅 Agent 的改动。重型制作（导入大素材、写卡片代码）留给桌面端。</div>
      </div>

      {sheet === "new" && (
        <Sheet id="new" title="新建云端项目" onClose={() => setSheet(null)}>
          <form onSubmit={(e) => { e.preventDefault(); void perform(() => ap.create(projectName)); }}>
            <div className="field"><label>项目名</label><input className="text-in" data-pcm="new-name" required maxLength={200} value={projectName} onChange={(e) => setProjectName(e.target.value)} /></div>
            {error && <div className="err">{error}</div>}
            <button type="submit" className="btn primary" style={{ width: "100%" }} data-pcm="new-submit" disabled={busy}>{busy ? "正在处理…" : "新建并打开"}</button>
          </form>
        </Sheet>
      )}
      {sheet === "join" && (
        <Sheet id="join" title="加入别人的项目" onClose={() => setSheet(null)}>
          <form onSubmit={(e) => { e.preventDefault(); void submitJoin(askSecondary ? secondary : (secondary || undefined)); }}>
            <div className="field"><label>项目链接</label><input className="text-in" data-pcm="join-link" required placeholder="粘贴云端项目链接" value={ap.link} onChange={(e) => { ap.setLink(e.target.value); setAskSecondary(false); ap.clearRequest(); }} /></div>
            {askSecondary && <div className="field"><label>项目二级密码</label><input className="text-in" data-pcm="join-secondary" type="password" required value={secondary} onChange={(e) => setSecondary(e.target.value)} /></div>}
            <div className="hint">云端项目需要先登录网站账号。</div>
            {error && <div className="err">{error}</div>}
            {/* 被账号名单挡住(2026-10-22 用户定):「你不在这个项目的成员名单中」+「发送申请」;发出后「已发送，等创建者通过」;被拒「创建者没有通过你的申请」 */}
            {notice && request && <div data-pcm="join-request" data-state={request.state} role="status">
              <div className={request.state === "pending" || request.state === "member" ? "hint" : "err"} data-pcm="join-request-text">{notice.text}</div>
              {notice.hint && <div className="hint" data-pcm="join-request-hint">{notice.hint}</div>}
              {notice.canSend && <button type="button" className="btn" style={{ width: "100%", marginBottom: 10 }} data-pcm="join-request-send" disabled={busy}
                onClick={() => void perform(ap.sendRequest)}>{JOIN_REQUEST_TEXT.send}</button>}
            </div>}
            <button type="submit" className="btn primary" style={{ width: "100%" }} data-pcm="join-submit" disabled={busy}>{askSecondary ? "验证二级密码并加入" : "加入"}</button>
          </form>
        </Sheet>
      )}
    </div>
  );
}
