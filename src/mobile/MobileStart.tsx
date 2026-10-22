/**
 * 手机版开始页(项目列表,演示稿第一屏):新建云端项目、加入别人的项目、我的项目。
 * 账号与项目的动作和桌面在线开始页同一份(`src/account/useAccountProjects.ts`);在线页面没有本机存储,「存储」一块不显示。
 */
import { useEffect, useState } from "react";
import { useAccountProjects } from "../account/useAccountProjects";
import { JOIN_REQUEST_TEXT, autoJoinKey, joinRequestNotice } from "../account/joinRequestText";
import { LogoMark } from "../ui/Logo";
import { BrandCanvas } from "../start/BrandCanvas";
import { Icon } from "./icons";
import { Sheet } from "./ui";

export function MobileStart({ onEnterEditor }: { onEnterEditor: () => void }) {
  const ap = useAccountProjects({ online: true, onEnterEditor });
  const { account, busy, error, setError, lists, listError, perform, request } = ap;
  const [name, setName] = useState(""), [password, setPassword] = useState(""), [remember, setRemember] = useState(false);
  const [sheet, setSheet] = useState<"new" | "join" | null>(null);
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
  const notice = request && account ? joinRequestNotice(request) : null;
  const rows = lists ? [...lists.owned.map((p) => ({ ...p, mine: true })), ...lists.joined.map((p) => ({ ...p, mine: false }))] : [];

  return (
    <div className="editor" data-pcm="home">
      {/*
        没登录时整屏铺和桌面登录页同一张渐变(竖屏,用户 2026-10-23 定):背后是 WebGL 那一层,
        上面压一道暗化,登录块再浮在一张毛玻璃卡片上 —— 这样表单被衬托出来,不会糊在画面里。
        登录之后这一层就不渲染了,项目列表该是什么样还是什么样。
      */}
      {!account && <div className="ps-m-login-bg" aria-hidden="true"><BrandCanvas /></div>}
      <div className="topbar">
        <div className="logo"><LogoMark size={18} /><span>Prompt<b>Cut</b></span></div>
        {account && <span className="chip accent" data-pcm="account-chip"><i className="dot" /> {account.name}</span>}
        {account && <button type="button" className="icon-btn" title="退出登录" aria-label="退出登录" disabled={busy} onClick={() => void perform(ap.logout)}><Icon name="back" /></button>}
      </div>
      <div className="home-body">
        {error && <div className="err" role="alert" data-pcm="home-error">{error}</div>}
        {!account ? (
          <form data-pcm="login" className="ps-m-login-card" onSubmit={(e) => { e.preventDefault(); void perform(async () => { await ap.login(name, password, remember); setPassword(""); }); }}>
            <h2 className="sec">登录网站账号</h2>
            <div className="field"><label>账号名</label><input className="text-in" name="username" autoComplete="username" required value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label>密码</label><input className="text-in" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <label className="check-row"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />记住登录状态</label>
            <button type="submit" className="btn primary" style={{ width: "100%" }} disabled={busy}>{busy ? "正在连接…" : "登录账号"}</button>
            <div className="hint" style={{ marginTop: 10 }}><a href={`${ap.origin}/account`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>注册账号 / 忘记密码</a></div>
          </form>
        ) : (
          <>
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
