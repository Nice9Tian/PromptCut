/**
 * 在线浏览器(电脑身份)的登录页。
 *
 * 原来登录就是开始页上那一小块表单(`src/account/AccountProjects.tsx`),和「新建云端项目」「凭链接加入」
 * 挤在一起。这里把它拆成独立的一页:没登录先看到它,登录成功才进开始页 —— 在线浏览器里项目一律是
 * 放云端的多用户协作项目(`product/platforms.md`「能新建放云端的项目」),所以账号是进门的前提。
 *
 * 这一版只跑界面:提交不发请求,直接当登录成功。
 *
 * 待办(业务层):
 * - 接 `src/account/useAccountProjects.ts` 的 `login`(账号服务在 VisuHive 仓库,见 `architecture.md` 的角色表);
 * - 「记住登录状态」是在线页面才有的那个勾(`workflow/project.md`「在线浏览器和官网共用登录」);
 * - 官网已登录时这一页应该直接跳过,不再问一遍;
 * - 游客身份(进入时随机分配 ID 和头像)的入口如果要做,位置就在下面「或」那一段 —— 这条正由另一个
 *   会话(`游客身份随机分配`)定方案,这里先不摆按钮,免得两边各做一套。
 */
import { useState } from "react";
import type { JSX } from "react";
import { Logo } from "../ui/Logo";
import { BrandAurora } from "./BrandAurora";

export function OnlineLogin(props: { onDone: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [link, setLink] = useState("");
  const [byLink, setByLink] = useState(false);
  const origin = typeof location !== "undefined" ? location.origin : "";

  return (
    <div className="ps-login" data-pc="start-login">
      <section className="ps-login-art">
        <BrandAurora />
        <div>
          <Logo size={26} />
          <h1 className="ps-login-art-title">打开浏览器就能剪片子</h1>
          <p className="ps-login-art-sub">
            项目、素材和预渲染结果都在云端，换一台设备登录同一个账号，接着上次的地方往下剪。
          </p>
        </div>
        <span className="ps-login-art-foot">PromptCut · 在线版</span>
      </section>

      <section className="ps-login-panel">
        <form
          className="ps-login-form"
          data-pc="start-login-form"
          onSubmit={(e) => {
            e.preventDefault();
            // 待办:这里要调账号服务。现在只跑界面,填了就算过
            props.onDone();
          }}
        >
          <div className="ps-login-head">
            <h2 className="ps-login-title">登录账号</h2>
            <span className="ps-muted">网站账号和官网通用。</span>
          </div>

          <label className="ps-field">
            账号名
            <input name="username" autoComplete="username" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="ps-field">
            密码
            <input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <label className="ps-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住登录状态
          </label>

          <button className="ps-primary-btn" data-pc="start-login-submit" disabled={!name || !password}>
            登录账号
          </button>

          <div className="ps-login-alt">
            <a className="ps-link" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">注册账号</a>
            <a className="ps-link" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">忘记密码</a>
          </div>

          <div className="ps-login-sep">或</div>

          {/*
            第三方登录的位置。逻辑归「接通 Google 账号登录」那个会话(OAuth、账号服务接口、会话都在
            VisuHive 仓库的 account/、site/ 下),它只改这里这几行,不动这一页其余部分。

            **这里和现有语义冲突,合入前要先裁**:`product/document-service.md` 第 66 行写的是
            「云端网站账号已有邮箱重设密码,不另做第三方登录。」真要做第三方登录,得按
            `guide_files/suggested_agent_behavior.md`「对齐」先把这条二级语义以「修改前 / 修改后」
            dry run 给用户过目、改掉,再把按钮接上。在那之前这个按钮不接任何逻辑。

            标记用的是一个普通的「G」字,不是 Google 的官方商标:真接上去时按它的品牌规范换成官方图形。
          */}
          <div className="ps-login-oauth" data-pc="start-login-oauth">
            <button
              type="button"
              className="ps-oauth-btn"
              data-pc="start-login-google"
              aria-label="用 Google 继续"
              title="待办：OAuth 流程在 VisuHive 仓库，这里只留位置"
            >
              <span className="ps-oauth-mark" aria-hidden="true">G</span>
              用 Google 继续
            </button>
          </div>

          {byLink ? (
            <label className="ps-field">
              项目链接
              <input
                type="text"
                placeholder="粘贴别人给你的云端项目链接"
                value={link}
                data-pc="start-login-link"
                onChange={(e) => setLink(e.target.value)}
              />
            </label>
          ) : (
            <button type="button" className="ps-ghost-btn" data-pc="start-login-by-link" onClick={() => setByLink(true)}>
              用项目链接加入别人的项目
            </button>
          )}

          <p className="ps-login-note">
            界面预览阶段：登录不会真的发请求，填上账号名和密码点「登录账号」就进开始页。
            <button type="button" className="ps-link" data-pc="start-login-skip" onClick={props.onDone}>
              或者直接跳过
            </button>
          </p>
        </form>
      </section>
    </div>
  );
}
