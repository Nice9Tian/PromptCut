/**
 * 「用链接加入项目」:开始页顶栏右边那颗键点出来的一小块(原来开始页上那一栏「凭链接加入」,`src/account/AccountProjects.tsx`)。
 *
 * 业务照搬那一栏,全走 `useAccountProjects` 的 `join`:
 *   - 项目设了二级密码:出二级密码框,输了再加入;输错说「项目二级密码不正确」;
 *   - 链接失效:说「该项目链接已失效,请联系创建者获取最新链接」;
 *   - 不在名单里(只许名单的项目):说「你不在这个项目的成员名单中」并给「发送申请」;发出后等创建者通过,每 10 秒问一次,
 *     通过了自动再加入一次(问和自动再加入都在 `useAccountProjects` 里,这里只显示 `request`);
 *   - 从项目列表点进一个设了二级密码、还没输过的项目时,上层把链接填好、把这一块打开并要密码(`askPassword`)。
 * 位置借右键菜单那一套长相(`.ps-menu`),不另起一套样式。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { JOIN_REQUEST_TEXT, autoJoinKey, joinRequestNotice } from "../account/joinRequestText";
import type { useAccountProjects } from "../account/useAccountProjects";

type Ap = ReturnType<typeof useAccountProjects>;

export function JoinPanel(props: { ap: Ap; askPassword: boolean; onClose: () => void; onJoined: () => void }): JSX.Element {
  const { ap } = props;
  const [secondary, setSecondary] = useState("");
  const [askSecondary, setAskSecondary] = useState(props.askPassword);
  const [msg, setMsg] = useState(props.askPassword ? JOIN_REQUEST_TEXT.secondaryRequired : "");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.askPassword) { setAskSecondary(true); setMsg(JOIN_REQUEST_TEXT.secondaryRequired); } }, [props.askPassword]);

  const submit = (pass: string | undefined) => ap.perform(async () => {
    setMsg("");
    const outcome = await ap.join(ap.link, pass);
    if (outcome === "secondary-required" || outcome === "bad-secondary") {
      setAskSecondary(true);
      setMsg(outcome === "bad-secondary" ? "项目二级密码不正确。" : JOIN_REQUEST_TEXT.secondaryRequired);
      return;
    }
    if (outcome === "expired") { setMsg("该项目链接已失效，请联系创建者获取最新链接。"); return; }
    if (outcome === "not-listed") return;
    setAskSecondary(false);
    setSecondary("");
    props.onJoined();
  });

  // 申请被通过、或项目改回「知道链接就能进」:自动再走一次加入(同 AccountProjects.tsx)
  const autoJoin = autoJoinKey(ap.request);
  useEffect(() => { if (autoJoin) void submit(undefined); }, [autoJoin]); // eslint-disable-line react-hooks/exhaustive-deps

  // 按 Esc 关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);

  const notice = ap.request && (ap.account || ap.guest) ? joinRequestNotice(ap.request) : null;
  const signedIn = !!(ap.account || ap.guest);

  return (
    <div ref={box} className="ps-menu ps-join" role="dialog" aria-label="用项目链接加入" data-pc="start-join">
      <div className="ps-menu-head">用项目链接加入</div>
      <form
        className="ps-join-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(askSecondary ? secondary : secondary || undefined);
        }}
      >
        <label className="ps-field">
          项目链接
          <input data-pc="start-join-link" type="text" required placeholder="粘贴别人给你的云端项目链接" value={ap.link} autoFocus
            onChange={(e) => { ap.setLink(e.target.value); setAskSecondary(false); setMsg(""); ap.clearRequest(); }} />
        </label>
        {askSecondary && (
          <label className="ps-field">
            项目二级密码
            <input data-pc="start-join-secondary" type="password" required placeholder="请输入项目二级密码" value={secondary} onChange={(e) => setSecondary(e.target.value)} />
          </label>
        )}
        {msg && <p className="ps-join-msg" role="alert" data-pc="start-join-msg">{msg}</p>}
        {!signedIn && <p className="ps-join-msg">先登录账号或以游客身份进入，才能加入别人的项目。</p>}
        {notice && ap.request && (
          <div className="ps-join-msg" role="status" data-pc="start-join-request" data-state={ap.request.state}>
            <span>{notice.text}</span>
            {notice.canSend && (
              <button type="button" className="ps-ghost-btn" data-pc="start-join-request-send" disabled={ap.busy} onClick={() => void ap.perform(ap.sendRequest)}>
                {JOIN_REQUEST_TEXT.send}
              </button>
            )}
            {notice.hint && <span className="ps-muted">{notice.hint}</span>}
          </div>
        )}
        <div className="ps-join-actions">
          <button type="button" className="ps-ghost-btn" onClick={props.onClose}>取消</button>
          <button className="ps-primary-btn" data-pc="start-join-submit" disabled={ap.busy || !signedIn || !ap.link.trim()}>
            {askSecondary ? "验证二级密码并加入" : "加入并打开项目"}
          </button>
        </div>
      </form>
    </div>
  );
}
