/**
 * 项目设置里的「多用户协作」一段（C10a 契约 `docs/plan/c10a-contract.md` 第 6、7 节；文案照第 14 节表 B）。
 *
 * - 没开启：勾选框。勾上后给出缺省（放本机、自由进入、创建者用户名取设备名、两样密码自动生成并存在本机），都能改；
 *   点对话框的「确定」才开始设置（语义「勾上并保存」），对话框留着显示进度与结果。
 * - 已开启（当前连着共享项目）：项目名与项目密码（自由进入，带复制）、邀请链接与二维码（放云端，只有创建者本机有）、
 *   邀请码状态、创建者操作（作废并重新生成邀请码，每次当场输入创建者密码；以及 C6.5 的改项目密码、改名单、踢人、删项目）。
 * - 取消勾选再「确定」：确认后放云端的先拉回本机再删云端项目，放本机的停本机托管；中途失败恢复为开启。
 *
 * 房间关联写进普通项目文件，凭证只在设备保护存储中；连接状态取自同步管理（`syncManager.ts`）与本机记录（`collab.ts`）。
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
// @ts-expect-error 无类型声明的 .mjs(零依赖,浏览器里能跑,契约第 7 节)
import { qrSvg } from "../../../server/qr.mjs";
import { ONLINE } from "../../online/mode";
import { hosted, type SharedMode, type Where } from "./sharedApi";
import { ListEditor, LanRestartHint, readHostedUrl, writeHostedUrl } from "./SharedDialogs";
import { CreatorFlow, type Flow } from "./MembersPanel";
import { useSync } from "./syncManager";
import {
  createInvite, defaultCreatorName, disableCollab, enableCollab, fetchInviteStatus, generatePassword, localCollab,
  type InviteInfo, type InviteStatus,
} from "./collab";
import "./sync.css";

/** 表 B（契约第 14 节）：原文照抄 */
export const COLLAB_TEXT = {
  enabling: "正在设置多用户协作…",
  enabled: "多用户协作已开启。",
  offline: "当前离线，不能放到云端。联网后再试。",
  unreachable: "连不上云端，设置没有完成。",
  copied: "已复制",
  regenConfirm: "作废后，旧链接和旧二维码立刻失效（项目密码不受影响）。确认作废并重新生成？",
  regenDone: "已生成新的邀请链接与二维码。",
  inviteDead: "邀请码已失效，可以重新生成。",
  cancelConfirm: "取消后其他成员不能再进入。会先把项目内容和素材原尺寸拉回本机，确认取消？",
  cancelling: "正在把项目内容拉回本机…",
  cancelled: "多用户协作已关闭，内容已拉回本机。",
  cancelFailed: "拉回本机没有完成，已恢复为开启状态。检查网络后重试。",
  localNote: "你的电脑关机后其他人打不开，可在设置里搬到云端",
  localLimit: "放本机时，主机在线且云端登记成功后，其他成员可通过中继加入；临时网络故障会自动重试登记。",
} as const;

export interface CollabHandle {
  /** 对话框「确定」时调：回 true 表示这一段有动作在做（对话框留着），false 表示没有要做的 */
  apply(projectName: string): Promise<boolean>;
}

function copy(text: string, done: () => void) {
  void navigator.clipboard?.writeText(text).then(done, () => undefined);
}

function when(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const CollabSection = forwardRef<CollabHandle, { open: boolean }>(function CollabSection({ open }, ref) {
  const shared = useSync((v) => v.shared);
  const device = useSync((v) => v.device);
  const association = useSync((v) => v.association);
  const hostRegistration = useSync((v) => v.hostRegistration);
  const isOn = !!shared || !!association;
  const [checked, setChecked] = useState(isOn);
  const [where, setWhere] = useState<Where>("lan");
  const [mode, setMode] = useState<SharedMode>("free");
  const [creator, setCreator] = useState("");
  const [creatorPw, setCreatorPw] = useState("");
  const [projectPw, setProjectPw] = useState("");
  const [list, setList] = useState<{ username: string; password: string }[]>([]);
  const [rowName, setRowName] = useState("");
  const [rowPw, setRowPw] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [hostedUrl, setHostedUrl] = useState(readHostedUrl());
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "err" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [inviteStatus, setInviteStatus] = useState<InviteStatus | null>(null);
  const [regenPw, setRegenPw] = useState<string | null>(null);
  const [cancelPw, setCancelPw] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);

  const local = shared ? localCollab(shared.projectId) : null;
  const iAmCreator = !!shared?.creator;
  const lanOk = !ONLINE && !!device?.localEditor;

  // 打开对话框时按当前状态重置；只有尚未开启协作的创建表单生成缺省密码，恢复原房间不生成新密码。
  useEffect(() => {
    if (!open) return;
    setChecked(isOn);
    setStatus(null);
    setBusy(false);
    setRegenPw(null);
    setCancelPw("");
    setCopied(null);
    setWhere(ONLINE ? "hosted" : "lan");
    setMode("free");
    setCreatorPw(isOn ? "" : generatePassword());
    setProjectPw(isOn ? "" : generatePassword());
    setList([]);
    setHostedUrl(readHostedUrl());
    void defaultCreatorName().then(setCreator);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 已开启：邀请链接取本机记下的；状态用本机记下的创建者密码现查（只读，没有就不查）
  useEffect(() => {
    if (!open || !shared) {
      setInvite(null);
      setInviteStatus(null);
      return;
    }
    const rec = localCollab(shared.projectId);
    setInvite(rec?.invite ?? null);
    setInviteStatus(null);
    if (shared.where === "hosted" && shared.creator && rec?.creatorPassword) {
      void fetchInviteStatus(rec.creatorPassword).then((r) => { if (r.ok) setInviteStatus(r.status); });
    }
  }, [open, shared]);

  const addRow = () => {
    const u = rowName.trim();
    if (!u) return setRowErr("用户名不能为空。");
    if (!rowPw) return setRowErr("密码不能为空。");
    if (u === creator.trim() || list.some((r) => r.username === u)) return setRowErr("名单里已有这个名字，换一个区分一下。");
    setList([...list, { username: u, password: rowPw }]);
    setRowName("");
    setRowPw("");
    setRowErr("");
  };

  useImperativeHandle(ref, () => ({
    async apply(projectName: string) {
      if (busy) return true;
      if (checked && !isOn) {
        if (!creator.trim() || !creatorPw || (mode === "free" && !projectPw)) {
          setStatus({ text: "创建者用户名和密码不能为空。", tone: "err" });
          return true;
        }
        if (where === "lan" && !lanOk) return true;
        setBusy(true);
        setStatus({ text: COLLAB_TEXT.enabling, tone: "info" });
        if (where === "hosted") writeHostedUrl(hostedUrl);
        const r = await enableCollab({
          where,
          mode,
          name: projectName,
          creator: { username: creator.trim(), password: creatorPw },
          ...(mode === "free" ? { projectPassword: projectPw } : { list }),
          hostedUrl: where === "hosted" && hostedUrl.trim() !== hosted.DEFAULT_HOSTED_URL ? hostedUrl.trim() : null,
        });
        setBusy(false);
        if (!r.ok) {
          const text = r.error === "offline" ? COLLAB_TEXT.offline
            : r.error === "name-taken" ? "这个项目名已被占用，换一个吧。"
              : r.error === "lan-failed" ? "本机端口被占用，先关掉占用的另一个 PromptCut 窗口，或重启软件试试。"
                : COLLAB_TEXT.unreachable;
          setStatus({ text, tone: "err" });
          return true;
        }
        setInvite(r.invite);
        setStatus({ text: COLLAB_TEXT.enabled, tone: "ok" });
        return true;
      }
      if (!checked && isOn) {
        if (!iAmCreator) {
          setChecked(true);
          return false;
        }
        const pw = local?.creatorPassword || cancelPw;
        if (!pw) {
          setStatus({ text: "要创建者密码才能取消。", tone: "err" });
          return true;
        }
        if (!window.confirm(COLLAB_TEXT.cancelConfirm)) {
          setChecked(true);
          return true;
        }
        setBusy(true);
        setStatus({ text: COLLAB_TEXT.cancelling, tone: "info" });
        const r = await disableCollab(pw, (done, total) => setStatus({ text: `${COLLAB_TEXT.cancelling}（素材原尺寸 ${done}/${total}）`, tone: "info" }));
        setBusy(false);
        if (!r.ok) {
          setChecked(true);
          setStatus({ text: r.error === "forbidden" ? "密码错误。" : r.error === "rate-limited" ? "尝试太多次，等 60 秒后再试。" : COLLAB_TEXT.cancelFailed, tone: "err" });
          return true;
        }
        setStatus({ text: COLLAB_TEXT.cancelled, tone: "ok" });
        return true;
      }
      return false;
    },
  }), [busy, checked, isOn, creator, creatorPw, projectPw, mode, where, lanOk, hostedUrl, list, iAmCreator, local, cancelPw]);

  const regen = async () => {
    if (regenPw === null) {
      if (!window.confirm(COLLAB_TEXT.regenConfirm)) return;
      setRegenPw("");
      return;
    }
    if (!regenPw) return;
    setBusy(true);
    const r = await createInvite(regenPw);
    setBusy(false);
    if (!r.ok) {
      setStatus({ text: r.error === "forbidden" ? "密码错误。" : r.error === "rate-limited" ? "尝试太多次，等 60 秒后再试。" : COLLAB_TEXT.unreachable, tone: "err" });
      return;
    }
    setRegenPw(null);
    setInvite(r.invite);
    setInviteStatus({ active: true, expiresAt: r.invite.expiresAt, maxUses: r.invite.maxUses, used: 0, revokedAt: null });
    setStatus({ text: COLLAB_TEXT.regenDone, tone: "ok" });
  };

  const copied$ = (key: string) => (copied === key ? <span className="pc-sync-hint">{COLLAB_TEXT.copied}</span> : null);
  const copyBtn = (key: string, text: string) => (
    <button type="button" className="pc-sync-link-btn" onClick={() => copy(text, () => setCopied(key))}>复制</button>
  );

  const on = checked;
  return (
    <div className="pc-collab" data-pc="collab-section">
      <label className="pc-collab-head">
        <input type="checkbox" data-pc="collab-toggle" checked={on} disabled={busy || (isOn && !iAmCreator) || (isOn && ONLINE)}
          onChange={(e) => {
            setChecked(e.target.checked); setStatus(null);
            // 取消后仍留在同一设置窗口：再次明确创建时也保留默认密码生成能力。
            if (e.target.checked && !isOn) {
              if (!creatorPw) setCreatorPw(generatePassword());
              if (!projectPw) setProjectPw(generatePassword());
            }
          }} />
        多用户协作
      </label>

      {on && !isOn ? (
        <>
          <div className="pc-collab-row">
            <span className="pc-collab-key">放在</span>
            <button type="button" className={`pc-dialog-opt${where === "lan" ? " pc-dialog-opt--on" : ""}`} data-pc="collab-where-lan" disabled={ONLINE} onClick={() => setWhere("lan")}>本机</button>
            <button type="button" className={`pc-dialog-opt${where === "hosted" ? " pc-dialog-opt--on" : ""}`} data-pc="collab-where-hosted" onClick={() => setWhere("hosted")}>云端</button>
          </div>
          {where === "lan" ? (
            <>
              <div className="pc-sync-warn">{COLLAB_TEXT.localNote}</div>
              <div className="pc-sync-hint">{COLLAB_TEXT.localLimit}</div>
              {!device?.lanHost && !ONLINE ? <LanRestartHint /> : null}
            </>
          ) : (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-hosted">云端地址</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="pc-collab-hosted" className="pc-dialog-input" data-pc="collab-hosted-url" value={hostedUrl} onChange={(e) => setHostedUrl(e.target.value)} />
                <button type="button" className="pc-dialog-opt" style={{ height: 30 }} onClick={() => setHostedUrl(hosted.DEFAULT_HOSTED_URL)}>恢复默认</button>
              </div>
            </div>
          )}
          <div className="pc-collab-row">
            <span className="pc-collab-key">进入方式</span>
            <button type="button" className={`pc-dialog-opt${mode === "free" ? " pc-dialog-opt--on" : ""}`} onClick={() => setMode("free")}>自由进入</button>
            <button type="button" className={`pc-dialog-opt${mode === "restricted" ? " pc-dialog-opt--on" : ""}`} onClick={() => setMode("restricted")}>限定进入</button>
          </div>
          <div className="pc-sync-field">
            <label htmlFor="pc-collab-creator">创建者用户名</label>
            <input id="pc-collab-creator" className="pc-dialog-input" value={creator} maxLength={64} onChange={(e) => setCreator(e.target.value)} />
          </div>
          <div className="pc-sync-field">
            <label htmlFor="pc-collab-cpw">创建者密码（已自动生成，存在本机）</label>
            <input id="pc-collab-cpw" className="pc-dialog-input" value={creatorPw} onChange={(e) => setCreatorPw(e.target.value)} />
          </div>
          {mode === "free" ? (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-ppw">项目密码（已自动生成，存在本机）</label>
              <input id="pc-collab-ppw" className="pc-dialog-input" value={projectPw} onChange={(e) => setProjectPw(e.target.value)} />
            </div>
          ) : (
            <ListEditor
              creatorName={creator.trim() || "你的名字"}
              list={list}
              onRemove={(u) => setList(list.filter((r) => r.username !== u))}
              rowName={rowName}
              rowPw={rowPw}
              setRowName={(v) => { setRowName(v); setRowErr(""); }}
              setRowPw={(v) => { setRowPw(v); setRowErr(""); }}
              onAdd={addRow}
              rowErr={rowErr}
              hint="如果有独立渲染主机，记得在这里给它也加一条名单。"
            />
          )}
          <div className="pc-sync-hint">点「确定」开始设置。</div>
        </>
      ) : null}

      {isOn && shared ? (
        <>
          <div className="pc-collab-row">
            <span className="pc-collab-key">放在</span>
            <span>{shared.where === "hosted" ? "云端" : "本机"} · {shared.mode === "free" ? "自由进入" : "限定进入"}</span>
          </div>
          <div className="pc-collab-row" data-pc="collab-project-name">
            <span className="pc-collab-key">项目名</span>
            <code>{shared.name}</code>
            {copyBtn("name", shared.name)}
            {copied$("name")}
          </div>
          {shared.mode === "free" && local?.projectPassword ? (
            <div className="pc-collab-row" data-pc="collab-project-password">
              <span className="pc-collab-key">项目密码</span>
              <code>{local.projectPassword}</code>
              {copyBtn("pw", local.projectPassword)}
              {copied$("pw")}
            </div>
          ) : null}
          {shared.where === "lan" ? (
            <>
              <div className="pc-sync-warn">{COLLAB_TEXT.localNote}</div>
              <div className="pc-sync-hint" data-pc="host-registration" data-state={hostRegistration ?? "member"}>{hostRegistration === "online" ? "原房间已登记上线，中继接入已就绪。" : hostRegistration === "host-conflict" ? "主机占用冲突，未自动接管。" : COLLAB_TEXT.localLimit}</div>
            </>
          ) : null}
          {shared.where === "hosted" && iAmCreator ? (
            <>
              {invite ? (
                <div className="pc-collab-qr">
                  <div className="pc-collab-qr-img" data-pc="collab-qr" aria-label="邀请二维码" dangerouslySetInnerHTML={{ __html: qrSvg(invite.link, { ec: "M", quiet: 4, scale: 8 }) }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
                    <code data-pc="collab-invite-link" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{invite.link}</code>
                    <div className="pc-collab-actions">
                      <button type="button" className="pc-dialog-opt" data-pc="collab-copy-link" onClick={() => copy(invite.link, () => setCopied("link"))}>复制邀请链接</button>
                      {copied$("link")}
                    </div>
                    <div className="pc-sync-hint" data-pc="collab-invite-status">
                      {inviteStatus && !inviteStatus.active ? COLLAB_TEXT.inviteDead
                        : `有效期至 ${when(inviteStatus?.expiresAt ?? invite.expiresAt)}${inviteStatus ? ` · 已用 ${inviteStatus.used} 次` : ""}${(inviteStatus?.maxUses ?? invite.maxUses) ? ` / 限 ${inviteStatus?.maxUses ?? invite.maxUses} 次` : ""}`}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="pc-sync-hint">这台设备上没有邀请链接（链接只存在签发它的那台设备上）。</div>
              )}
              <div className="pc-collab-actions">
                <button type="button" className="pc-dialog-opt" data-pc="collab-regen" disabled={busy} onClick={() => void regen()}>作废并重新生成邀请码</button>
              </div>
              {regenPw !== null ? (
                <div className="pc-sync-field">
                  <label htmlFor="pc-collab-regen-pw">创建者密码</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input id="pc-collab-regen-pw" type="password" autoFocus className="pc-dialog-input" data-pc="collab-regen-password" value={regenPw}
                      onChange={(e) => setRegenPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void regen(); }} />
                    <button type="button" className="pc-dialog-opt" data-pc="collab-regen-confirm" style={{ height: 30 }} disabled={!regenPw || busy} onClick={() => void regen()}>确认</button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
          {iAmCreator ? (
            <div className="pc-collab-actions">
              {shared.mode === "free"
                ? <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "password" })}>改项目密码</button>
                : <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "list" })}>改名单</button>}
              <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "creator-password" })}>改创建者密码</button>
              <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "bans" })}>已禁入的设备</button>
              <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "delete" })}>删除项目</button>
            </div>
          ) : null}
          {iAmCreator ? <div className="pc-sync-hint">踢人：在顶栏的成员列表里，悬停到那个人那一行点「踢出」。</div> : null}
          {!checked && iAmCreator && !local?.creatorPassword ? (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-cancel-pw">创建者密码</label>
              <input id="pc-collab-cancel-pw" type="password" className="pc-dialog-input" value={cancelPw} onChange={(e) => setCancelPw(e.target.value)} />
            </div>
          ) : null}
          {!checked && iAmCreator ? <div className="pc-sync-hint">点「确定」取消多用户协作。</div> : null}
        </>
      ) : null}

      {status ? (
        <div className={`pc-sync-status-line${status.tone === "err" ? " is-err" : status.tone === "ok" ? " is-ok" : ""}`} data-pc="collab-status">{status.text}</div>
      ) : null}
      {flow ? <CreatorFlow flow={flow} onClose={() => setFlow(null)} /> : null}
    </div>
  );
});
