import { useEffect, useState } from "react";
import { authenticateRecovery, chooseRecoveryIdentity, recoveryIdentities, useSync } from "./syncManager";

export function RecoveryActions({ state }: { state: string }) {
  const association = useSync(v => v.association);
  const [open, setOpen] = useState(false);
  const [identities, setIdentities] = useState<{ as: "creator" | "member"; username: string }[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creator, setCreator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open && state === "choose-identity") void recoveryIdentities().then(setIdentities, () => setError("身份记录暂时无法读取，请重试。")); }, [open, state]);
  if (state !== "needs-auth" && state !== "choose-identity") return null;
  return <>
    <button className="pc-sync-chip" data-pc="recovery-auth-open" onClick={() => setOpen(true)}>{state === "choose-identity" ? "选择身份" : "重新认证"}</button>
    {open && <div className="pc-dialog-backdrop" role="presentation"><form className="pc-dialog" role="dialog" aria-label="恢复原协作身份" onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setError("");
      try { const r = await authenticateRecovery(username, password, creator ? "creator" : "member"); if (r.ok) { setPassword(""); setOpen(false); } else setError(r.error === "auth" ? "原用户名或密码不正确，请重新填写。" : "尚未恢复，请查看协作状态后重试。"); }
      catch { setError("无法恢复这个身份，请检查服务地址、原房间及权限。"); }
      finally { setBusy(false); }
    }}>
      <h3>恢复原协作身份</h3>
      <p>服务：{association?.service}</p><p>房间：{association?.roomId}</p>
      {state === "choose-identity" ? identities.map(r => <button key={`${r.as}:${r.username}`} type="button" disabled={busy} onClick={async () => {
        setBusy(true); try { await chooseRecoveryIdentity(r.as, r.username); setOpen(false); } catch { setError("所选身份未能恢复，请重试。"); } finally { setBusy(false); }
      }}>{r.username} · {r.as === "creator" ? "创建者" : "成员"}</button>) : <>
        <label>原用户名<input value={username} required maxLength={64} onChange={e => setUsername(e.target.value)} autoComplete="username" /></label>
        <label>原密码<input value={password} required type="password" onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
        <label><input type="checkbox" checked={creator} onChange={e => setCreator(e.target.checked)} />以创建者身份进入</label>
        <button type="submit" disabled={busy}>{busy ? "正在认证…" : "认证并恢复"}</button>
      </>}
      {error && <p role="alert">{error}</p>}<button type="button" disabled={busy} onClick={() => { setPassword(""); setOpen(false); }}>关闭</button>
    </form></div>}
  </>;
}
