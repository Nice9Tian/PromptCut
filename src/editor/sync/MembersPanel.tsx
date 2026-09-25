/**
 * 顶栏的成员按钮、成员浮层与创建者操作(c65-ux-draft.md 第 3、4 节;契约 `auth-contract.md` 第 7 节)。
 *
 * - 按设备一行;重名带设备名(服务端给的 displayName);自己那行加粗、后缀「(自己)」;创建者带「[创建者]」;
 *   标签 [编辑中] [渲染中] [Agent ×n];点行展开 Agent:「用户名 · Agent · 第 n 个对话」。
 * - 我是创建者时:别人那行悬停出「踢出」;浮层底部「项目管理（仅创建者可见）」:改项目密码 / 改名单、改创建者密码、
 *   已禁入的设备、删除项目。每次都先「验证创建者身份」(当场输密码,用 `list-bans` 做一次无副作用的证明核对),
 *   验证过的 K 只用于这一次操作流程,关掉就丢。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { adminOp, leaveBlocked, makeCredential, pushToast, useSync, type MemberRow } from "./syncManager";
import { ListEditor } from "./SharedDialogs";
import "./sync.css";

type Flow =
  | { kind: "password" }
  | { kind: "creator-password" }
  | { kind: "list" }
  | { kind: "bans" }
  | { kind: "delete" }
  | { kind: "kick"; row: MemberRow };

export function MembersButton() {
  const shared = useSync((v) => v.shared);
  const members = useSync((v) => v.members);
  const device = useSync((v) => v.device);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!shared) return null;
  const isMe = (r: MemberRow) => r.username === shared.username && r.deviceId === device?.deviceId;
  const others = members.filter((r) => !isMe(r));
  const mine = members.find(isMe);
  const iAmCreator = shared.creator || !!mine?.creator;
  const startFlow = (f: Flow) => {
    setOpen(false);
    setFlow(f);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="pc-sync-chip"
        data-pc="members-button"
        title="成员"
        onClick={() => {
          if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
          setOpen(!open);
        }}
      >
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          <circle cx="5.5" cy="4" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M1 13c0-2.6 2-4.3 4.5-4.3S10 10.4 10 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="11" cy="4.6" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M11.5 8.8c2 .2 3.5 1.8 3.5 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span>成员: {Math.max(1, members.length)} 人</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="pc-members-pop"
            data-pc="members-pop"
            style={{ top: (rect?.bottom ?? 40) + 6, left: Math.max(8, Math.min((rect?.right ?? 340) - 330, window.innerWidth - 338)) }}
          >
            {[...(mine ? [mine] : []), ...others].map((row) => {
              const key = `${row.username}@${row.deviceId}`;
              const agents = row.conns.filter((c) => c.role === "agent");
              const me = isMe(row);
              return (
                <div className="pc-members-row" key={key}>
                  <div
                    className={`pc-members-row-main${agents.length ? " is-expandable" : ""}`}
                    onClick={() => agents.length && setExpanded(expanded === key ? null : key)}
                  >
                    <span className={`pc-members-name${me ? " is-me" : ""}`}>
                      {row.displayName}
                      {me ? " (自己)" : ""}
                    </span>
                    {row.creator ? <span className="pc-sync-tag pc-sync-tag--creator">[创建者]</span> : null}
                    {row.tags.editing ? <span className="pc-sync-tag pc-sync-tag--editing">[编辑中]</span> : null}
                    {row.tags.rendering ? <span className="pc-sync-tag pc-sync-tag--rendering">[渲染中]</span> : null}
                    {row.tags.agents > 0 ? <span className="pc-sync-tag">[Agent ×{row.tags.agents}]</span> : null}
                    {iAmCreator && !me && row.deviceId ? (
                      <button
                        type="button"
                        className="pc-members-kick"
                        onClick={(e) => {
                          e.stopPropagation();
                          startFlow({ kind: "kick", row });
                        }}
                      >
                        踢出
                      </button>
                    ) : null}
                  </div>
                  {expanded === key && agents.length ? (
                    <div className="pc-members-sub">
                      {agents.map((a, i) => (
                        <span key={i}>
                          {row.username} · Agent · 第 {a.conversation ?? i + 1} 个对话
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {others.length === 0 ? <div className="pc-members-empty">只有你自己在线。</div> : null}
            {iAmCreator ? (
              <>
                <div className="pc-members-sep" />
                <div className="pc-members-admin-title">项目管理（仅创建者可见）</div>
                {shared.mode === "free" ? (
                  <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "password" })}>
                    改项目密码
                  </button>
                ) : (
                  <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "list" })}>
                    改名单
                  </button>
                )}
                <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "creator-password" })}>
                  改创建者密码
                </button>
                <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "bans" })}>
                  已禁入的设备
                </button>
                <button type="button" className="pc-members-admin-item is-danger" onClick={() => startFlow({ kind: "delete" })}>
                  删除项目
                </button>
              </>
            ) : null}
          </div>,
          document.body,
        )}
      {flow ? <CreatorFlow flow={flow} onClose={() => setFlow(null)} /> : null}
    </>
  );
}

/* ---------------- 创建者操作 ---------------- */

type Verified = { key: string; bans: { username: string; deviceId: string }[]; list: string[] };

function CreatorFlow({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const [verified, setVerified] = useState<Verified | null>(null);
  if (!verified) return <VerifyDialog onClose={onClose} onOk={setVerified} />;
  switch (flow.kind) {
    case "password":
    case "creator-password":
      return <PasswordDialog creator={flow.kind === "creator-password"} v={verified} onClose={onClose} />;
    case "list":
      return <ListDialog v={verified} onClose={onClose} />;
    case "bans":
      return <BansDialog v={verified} onClose={onClose} />;
    case "delete":
      return <DeleteDialog v={verified} onClose={onClose} />;
    case "kick":
      return <KickDialog row={flow.row} v={verified} onClose={onClose} />;
  }
}

function Dialog({ title, children, foot, pc }: { title?: string; children: React.ReactNode; foot: React.ReactNode; pc: string }) {
  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog" role="dialog" aria-modal="true" data-pc={pc}>
        {title ? <div className="pc-dialog-title">{title}</div> : null}
        <div className="pc-dialog-body">{children}</div>
        <div className="pc-dialog-foot">{foot}</div>
      </div>
    </div>,
    document.body,
  );
}

const LOCK_MS = 60_000;

function VerifyDialog({ onClose, onOk }: { onClose: () => void; onOk: (v: Verified) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockUntil, setLockUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!lockUntil) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [lockUntil]);
  const locked = lockUntil > Date.now();
  const verify = async () => {
    if (!pw || busy || locked) return;
    setBusy(true);
    const r = await adminOp("list-bans", { password: pw });
    setBusy(false);
    if (r.ok) {
      onOk({ key: r.key, bans: (r.reply.bans as Verified["bans"]) ?? [], list: (r.reply.list as string[]) ?? [] });
      return;
    }
    if (r.error === "rate-limited") {
      setLockUntil(Date.now() + LOCK_MS);
      setErr("尝试太多次，等 60 秒后再试。");
    } else setErr("密码错误。");
  };
  return (
    <Dialog
      title="验证创建者身份"
      pc="creator-verify"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={!pw || busy || locked} onClick={() => void verify()}>
            验证
          </button>
        </>
      }
    >
      <div className="pc-sync-field">
        <label htmlFor="pc-cv-pw">创建者密码</label>
        <input id="pc-cv-pw" type="password" autoFocus className={`pc-dialog-input${err ? " is-invalid" : ""}`} placeholder="输入创建者密码" value={pw} disabled={locked}
          onChange={(e) => { setPw(e.target.value); setErr(""); }} onKeyDown={(e) => { if (e.key === "Enter") void verify(); }} />
        {err ? <div className="pc-sync-err">{err}</div> : null}
      </div>
    </Dialog>
  );
}

function failText(error: string): string {
  if (error === "rate-limited") return "尝试太多次，等 60 秒后再试。";
  if (error === "forbidden") return "密码错误。";
  if (error === "offline") return "没连上文档服务，稍后再试。";
  return "没做成，稍后再试。";
}

function PasswordDialog({ creator, v, onClose }: { creator: boolean; v: Verified; onClose: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!a || a !== b) {
      setErr(a !== b ? "两次输入不一致。" : "");
      return;
    }
    setBusy(true);
    const cred = await makeCredential(a);
    const r = creator ? await adminOp("set-creator-password", { key: v.key }, { creator: cred }) : await adminOp("set-password", { key: v.key }, { project: cred });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    pushToast(creator ? "创建者密码已修改，之后的项目管理要用新密码。" : "项目密码已修改。在线的人不受影响，下次进入要用新密码。", "info");
    onClose();
  };
  return (
    <Dialog
      title={creator ? "改创建者密码" : "改项目密码"}
      pc={creator ? "creator-password" : "project-password"}
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={busy || !a || !b} onClick={() => void submit()}>
            确认修改
          </button>
        </>
      }
    >
      <div className="pc-sync-field">
        <label htmlFor="pc-pw-a">新密码</label>
        <input id="pc-pw-a" type="password" autoFocus className="pc-dialog-input" value={a} onChange={(e) => { setA(e.target.value); setErr(""); }} />
      </div>
      <div className="pc-sync-field">
        <label htmlFor="pc-pw-b">确认新密码</label>
        <input id="pc-pw-b" type="password" className={`pc-dialog-input${err ? " is-invalid" : ""}`} value={b} onChange={(e) => { setB(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        {err ? <div className="pc-sync-err">{err}</div> : null}
      </div>
      <div className="pc-sync-hint">{creator ? "在线的人不受影响，之后的项目管理要用新的创建者密码。" : "在线的人不受影响，下次进入要用新密码。"}</div>
    </Dialog>
  );
}

function ListDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [rows, setRows] = useState<{ username: string; password?: string; kept?: boolean }[]>(v.list.map((u) => ({ username: u, kept: true })));
  const [rowName, setRowName] = useState("");
  const [rowPw, setRowPw] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = () => {
    const u = rowName.trim();
    if (!u) return setRowErr("用户名不能为空。");
    if (!rowPw) return setRowErr("密码不能为空。");
    if (u === shared?.username || rows.some((r) => r.username === u)) return setRowErr("名单里已有这个名字，换一个区分一下。");
    setRows([...rows, { username: u, password: rowPw }]);
    setRowName("");
    setRowPw("");
  };
  const changePassword = (u: string) => {
    const pw = window.prompt(`给 ${u} 设一个新密码`);
    if (pw) setRows(rows.map((r) => (r.username === u ? { username: u, password: pw } : r)));
  };
  const submit = async () => {
    setBusy(true);
    const list = [];
    for (const r of rows) list.push(r.password ? { username: r.username, ...(await makeCredential(r.password)) } : { username: r.username, keep: true });
    const res = await adminOp("set-list", { key: v.key }, { list });
    setBusy(false);
    if (!res.ok) return setErr(failText(res.error));
    pushToast("名单已修改。", "info", 4000);
    onClose();
  };
  return (
    <Dialog
      title="改名单"
      pc="list-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={busy} onClick={() => void submit()}>
            确认修改
          </button>
        </>
      }
    >
      <ListEditor
        creatorName={shared?.username ?? ""}
        list={rows}
        onRemove={(u) => setRows(rows.filter((r) => r.username !== u))}
        onChangePassword={changePassword}
        rowName={rowName}
        rowPw={rowPw}
        setRowName={(x) => { setRowName(x); setRowErr(""); }}
        setRowPw={(x) => { setRowPw(x); setRowErr(""); }}
        onAdd={add}
        rowErr={rowErr}
        hint="独立渲染主机是在另一台机器上帮你跑后台预渲染的 PromptCut 实例。如果有，在这里给它加一条专属名单，并在那边凭该用户名密码登录。"
      />
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function BansDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const [bans, setBans] = useState(v.bans);
  const [err, setErr] = useState("");
  const unban = async (b: { username: string; deviceId: string }) => {
    const r = await adminOp("unban", { key: v.key }, b);
    if (!r.ok) return setErr(failText(r.error));
    setBans(bans.filter((x) => !(x.username === b.username && x.deviceId === b.deviceId)));
  };
  return (
    <Dialog
      title="已禁入的设备"
      pc="bans-dialog"
      foot={
        <button type="button" className="pc-btn" onClick={onClose}>
          返回
        </button>
      }
    >
      {bans.length ? (
        <div className="pc-backups">
          {bans.map((b) => (
            <div className="pc-backup-row" key={`${b.username}@${b.deviceId}`}>
              <span>{b.username}</span>
              <small>{b.deviceId}</small>
              <button type="button" className="pc-dialog-opt" onClick={() => void unban(b)}>
                撤销
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="pc-sync-hint">（没有被禁入的设备）</div>
      )}
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function KickDialog({ row, v, onClose }: { row: MemberRow; v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const kick = async () => {
    setBusy(true);
    const r = await adminOp("kick", { key: v.key }, { username: row.username, deviceId: row.deviceId });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    if (shared?.mode === "free") pushToast("已踢出。自由进入模式下，想彻底挡住，要改项目密码。", "info", 8000);
    else pushToast("已踢出。", "info", 4000);
    onClose();
  };
  return (
    <Dialog
      pc="kick-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-sync-danger-btn" disabled={busy} onClick={() => void kick()}>
            踢出
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        确定要把 {row.username} ({row.deviceName ?? row.deviceId}) 踢出项目吗？
      </div>
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function DeleteDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!shared) return null;
  const del = async () => {
    setBusy(true);
    const r = await adminOp("delete", { key: v.key });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    onClose();
    // 自己删的:不弹「项目已被创建者删除」,直接回开始页
    leaveBlocked();
  };
  return (
    <Dialog
      title="删除项目"
      pc="delete-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-sync-danger-btn" disabled={busy || typed !== shared.name} onClick={() => void del()}>
            永久删除项目
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        {shared.where === "hosted"
          ? "确定要删除这个项目吗？托管在阿里云的项目文档和素材将被永久销毁，所有成员立刻断开。此操作无法恢复。"
          : "确定要删除这个项目吗？本机作为主机的项目数据将被永久销毁，所有成员立刻断开。此操作无法恢复。"}
      </div>
      <input className="pc-dialog-input" style={{ marginLeft: 0 }} placeholder="输入项目名确认" value={typed} onChange={(e) => setTyped(e.target.value)} />
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}
