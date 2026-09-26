/**
 * 「新建共享项目」「打开共享项目」两个对话框(c65-ux-draft.md 第 1、2 节;c65-design.md 第 9 节)。
 * 文案一字不差照稿件的文案表;稿件没写到的几处(局域网模式要重启编辑器、托管地址不合法)在报告里列出。
 *
 * 数据流:新建经 `server/auth/route.mjs` 的 `createSharedProject`(托管端 `POST shared/create`,局域网是本机编辑器的
 * `/docservice/shared/create`),建好后以创建者身份进入(`syncManager.enterShared`),当前项目以根替换写进新项目;
 * 打开经 `findSharedProject`(局域网由本机编辑器替页面查找 3 s,与托管端同时查),候选并列供挑,再凭证明进入。
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { enterShared, knownCreator, pushToast, useSync, type EnterError } from "./syncManager";
import { errorStatus, hosted, route, type Candidate, type SharedMode, type Where, type FindResult, type LanHost } from "./sharedApi";
import "./sync.css";

/* ---------------- 托管地址(两个对话框共用,记在本机) ---------------- */

const HOSTED_KEY = "pc.shared.hostedUrl";

export function readHostedUrl(): string {
  try {
    return localStorage.getItem(HOSTED_KEY) || hosted.DEFAULT_HOSTED_URL;
  } catch {
    return hosted.DEFAULT_HOSTED_URL;
  }
}

function writeHostedUrl(url: string) {
  try {
    if (!url.trim() || url.trim() === hosted.DEFAULT_HOSTED_URL) localStorage.removeItem(HOSTED_KEY);
    else localStorage.setItem(HOSTED_KEY, url.trim());
  } catch {
    /* 存不了就只在这次生效 */
  }
}

/** 界面上改过的值才算「界面值」(覆盖顺序第 1 级);和缺省相同就当没改 */
function uiHostedUrl(): string | null {
  const v = readHostedUrl();
  return v === hosted.DEFAULT_HOSTED_URL ? null : v;
}

const charLen = (s: string) => Array.from(s).length;

/* ---------------- 新建 ---------------- */

interface ListRow {
  username: string;
  password: string;
}

export function NewSharedDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const device = useSync((v) => v.device);
  const [name, setName] = useState("");
  const [creator, setCreator] = useState("");
  const [creatorPw, setCreatorPw] = useState("");
  const [where, setWhere] = useState<Where>("hosted");
  const [mode, setMode] = useState<SharedMode>("free");
  const [projectPw, setProjectPw] = useState("");
  const [list, setList] = useState<ListRow[]>([]);
  const [rowName, setRowName] = useState("");
  const [rowPw, setRowPw] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [tried, setTried] = useState(false);
  const [nameTaken, setNameTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "err" | "info" } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCreator("");
    setCreatorPw("");
    setWhere("hosted");
    setMode("free");
    setProjectPw("");
    setList([]);
    setRowName("");
    setRowPw("");
    setRowErr("");
    setTried(false);
    setNameTaken(false);
    setBusy(false);
    setStatus(null);
  }, [open]);

  const pureBrowser = !device?.localEditor;
  const lanNeedsRestart = !pureBrowser && !device?.lanHost;

  const errors = {
    name: !name.trim() ? "项目名不能为空。" : nameTaken ? "这个项目名已被占用，换一个吧。" : "",
    creator: !creator.trim() ? "创建者用户名不能为空。" : "",
    creatorPw: !creatorPw ? "密码不能为空（用于删项目、踢人等特权）。" : "",
    projectPw: mode === "free" && !projectPw ? "不能为空，建议至少 4 个字符。" : "",
  };
  const hints = {
    name: charLen(name.trim()) > 30 ? "建议不要超过 30 个字。" : "",
    creator: charLen(creator.trim()) > 20 ? "建议不要超过 20 个字。" : "",
    creatorPw: creatorPw && creatorPw.length < 4 ? "建议至少 4 个字符。" : "",
    projectPw: mode === "free" && projectPw && projectPw.length < 4 ? "不能为空，建议至少 4 个字符。" : "",
  };
  const invalid = Object.values(errors).some(Boolean) || (where === "lan" && (pureBrowser || lanNeedsRestart));

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

  const submit = async () => {
    setTried(true);
    if (invalid) {
      setStatus({ text: "检查红色的错误提示，填全并改对后再创建。", tone: "err" });
      return;
    }
    setBusy(true);
    setStatus({ text: "正在创建...", tone: "info" });
    let made: Awaited<ReturnType<typeof route.createSharedProject>>;
    try {
      made = await route.createSharedProject({
        where,
        name: name.trim(),
        mode,
        creator: { username: creator.trim(), password: creatorPw },
        ...(mode === "free" ? { password: projectPw } : { list }),
        uiHostedUrl: uiHostedUrl(),
      });
    } catch (e) {
      setBusy(false);
      const { status: code, reason } = errorStatus(e);
      if (code === 409 || reason === "name-taken") {
        setNameTaken(true);
        setStatus({ text: "检查红色的错误提示，填全并改对后再创建。", tone: "err" });
      } else if (where === "hosted") {
        setStatus({ text: "连不上阿里云，检查一下网络。", tone: "err" });
      } else {
        setStatus({ text: "本机端口被占用，先关掉占用的另一个 PromptCut 窗口，或重启软件试试。", tone: "err" });
      }
      return;
    }
    const entered = await enterShared(
      { where: made.where, base: made.base, projectId: made.projectId, name: made.name, mode: made.mode, ...(where === "lan" ? { hostDeviceName: device?.deviceName } : {}) },
      { as: "creator", username: creator.trim(), password: creatorPw },
    );
    setBusy(false);
    if (!entered.ok) {
      setStatus({ text: where === "hosted" ? "连不上阿里云，检查一下网络。" : "本机端口被占用，先关掉占用的另一个 PromptCut 窗口，或重启软件试试。", tone: "err" });
      return;
    }
    setStatus({
      text: where === "hosted" ? "创建成功，已进入项目。" : "创建成功。让成员在同一个网段下查项目名就能进。记住本机要保持开着。",
      tone: "ok",
    });
  };

  if (!open) return null;
  const done = status?.tone === "ok";
  const show = (field: keyof typeof errors) => (tried || field === "name" ? errors[field] : "");

  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-newshared-title" data-pc="new-shared-dialog">
        <div id="pc-newshared-title" className="pc-dialog-title">
          新建共享项目
        </div>
        <div className="pc-dialog-body">
          <div className="pc-sync-group">
            <div className="pc-sync-group-title">基本信息</div>
            <div className="pc-sync-field">
              <label htmlFor="pc-ns-name">项目名</label>
              <input id="pc-ns-name" className={`pc-dialog-input${show("name") && tried ? " is-invalid" : ""}`} placeholder="给项目起个名字" value={name} maxLength={64}
                onChange={(e) => { setName(e.target.value); setNameTaken(false); }} />
              {tried && errors.name ? <div className="pc-sync-err">{errors.name}</div> : hints.name ? <div className="pc-sync-hint">{hints.name}</div> : null}
            </div>
            <div className="pc-sync-field">
              <label htmlFor="pc-ns-creator">创建者用户名</label>
              <input id="pc-ns-creator" className={`pc-dialog-input${tried && errors.creator ? " is-invalid" : ""}`} placeholder="你的名字" value={creator} maxLength={64} onChange={(e) => setCreator(e.target.value)} />
              {tried && errors.creator ? <div className="pc-sync-err">{errors.creator}</div> : hints.creator ? <div className="pc-sync-hint">{hints.creator}</div> : null}
            </div>
            <div className="pc-sync-field">
              <label htmlFor="pc-ns-cpw">创建者密码</label>
              <input id="pc-ns-cpw" type="password" className={`pc-dialog-input${tried && errors.creatorPw ? " is-invalid" : ""}`} placeholder="设置一个密码" value={creatorPw} onChange={(e) => setCreatorPw(e.target.value)} />
              {tried && errors.creatorPw ? <div className="pc-sync-err">{errors.creatorPw}</div> : hints.creatorPw ? <div className="pc-sync-hint">{hints.creatorPw}</div> : null}
            </div>
          </div>

          <div className="pc-sync-group">
            <div className="pc-sync-group-title">部署位置（选定后不能改）</div>
            <button type="button" className={`pc-sync-choice${where === "hosted" ? " is-on" : ""}`} onClick={() => setWhere("hosted")}>
              <span className="pc-sync-choice-dot" />
              <span className="pc-sync-choice-text">
                <b>互联网模式</b>
                <small>托管在阿里云。只要有网，成员随时能打开项目。</small>
              </span>
            </button>
            <button type="button" className={`pc-sync-choice${where === "lan" ? " is-on" : ""}`} disabled={pureBrowser} onClick={() => setWhere("lan")}>
              <span className="pc-sync-choice-dot" />
              <span className="pc-sync-choice-text">
                <b>局域网模式</b>
                <small>本机当主机。成员要在同一个 Wi-Fi 或网段下才能连上。</small>
                {pureBrowser ? <small>纯浏览器不能当主机，要在桌面版客户端使用局域网模式。</small> : null}
              </span>
            </button>
            {where === "lan" ? <div className="pc-sync-warn">本机关机或退出软件后，其他成员打不开这个项目。</div> : null}
            {where === "lan" && lanNeedsRestart ? <LanRestartHint /> : null}
          </div>

          <div className="pc-sync-group">
            <div className="pc-sync-group-title">进入方式（选定后不能改）</div>
            <button type="button" className={`pc-sync-choice${mode === "free" ? " is-on" : ""}`} onClick={() => setMode("free")}>
              <span className="pc-sync-choice-dot" />
              <span className="pc-sync-choice-text">
                <b>自由进入</b>
                <small>设置一个项目密码，知道名字和密码就能进。</small>
              </span>
            </button>
            {mode === "free" ? (
              <div className="pc-sync-field">
                <label htmlFor="pc-ns-ppw">项目密码</label>
                <input id="pc-ns-ppw" type="password" className={`pc-dialog-input${tried && errors.projectPw ? " is-invalid" : ""}`} placeholder="团队共用的密码" value={projectPw} onChange={(e) => setProjectPw(e.target.value)} />
                {tried && errors.projectPw ? <div className="pc-sync-err">{errors.projectPw}</div> : hints.projectPw ? <div className="pc-sync-hint">{hints.projectPw}</div> : null}
              </div>
            ) : null}
            <button type="button" className={`pc-sync-choice${mode === "restricted" ? " is-on" : ""}`} onClick={() => setMode("restricted")}>
              <span className="pc-sync-choice-dot" />
              <span className="pc-sync-choice-text">
                <b>限定进入</b>
                <small>提前写好名单，只有名单里的人用各自的密码才能进。</small>
              </span>
            </button>
            {mode === "restricted" ? (
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
            ) : null}
          </div>
          {status ? <div className={`pc-sync-status-line${status.tone === "err" ? " is-err" : status.tone === "ok" ? " is-ok" : ""}`}>{status.text}</div> : null}
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn" onClick={onClose}>
            {done ? "返回" : "取消"}
          </button>
          {!done ? (
            <button type="button" className="pc-btn pc-btn--primary" disabled={busy} onClick={() => void submit()}>
              创建
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 局域网模式要编辑器绑在局域网上;浏览器里重启不了编辑器,桌面壳眼下也没有重启接口(留给 C10 / 桌面壳) */
function LanRestartHint() {
  const cmd = "PROMPTCUT_LAN_HOST=1 npm run dev";
  return (
    <div className="pc-sync-hint" data-pc="lan-restart-hint">
      编辑器现在只在本机上监听，局域网里的成员连不上。要当局域网主机，得让编辑器以局域网主机方式重新启动（带 PROMPTCUT_LAN_HOST=1）。
      这个窗口没法替你重启：请关掉编辑器，用下面的命令重新打开后再建。
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <code style={{ fontFamily: "var(--ui-font-mono)", fontSize: 11.5, padding: "2px 6px", borderRadius: 4, background: "var(--ui-float)" }}>{cmd}</code>
        <button
          type="button"
          className="pc-dialog-opt"
          style={{ height: 24, padding: "0 10px", fontSize: 12 }}
          onClick={() => {
            void navigator.clipboard?.writeText(cmd).then(
              () => pushToast("启动命令已复制。", "info", 3000),
              () => pushToast("复制不了，请手动选中命令。", "warn", 4000),
            );
          }}
        >
          复制命令
        </button>
      </div>
    </div>
  );
}

/** 名单表:创建者固定第一行;下面每行可删;底部新增一行(新建对话框与「改名单」共用) */
export function ListEditor(props: {
  creatorName: string;
  list: { username: string; password?: string; kept?: boolean }[];
  onRemove: (username: string) => void;
  onChangePassword?: (username: string) => void;
  rowName: string;
  rowPw: string;
  setRowName: (v: string) => void;
  setRowPw: (v: string) => void;
  onAdd: () => void;
  rowErr: string;
  hint: string;
}) {
  return (
    <div className="pc-sync-field">
      <div className="pc-sync-list" data-pc="list-editor">
        <div className="pc-sync-list-row">
          <span>
            {props.creatorName} <span className="pc-sync-tag pc-sync-tag--creator">[创建者]</span>
          </span>
          <span className="is-muted">同创建者密码</span>
          <span />
        </div>
        {props.list.map((r) => (
          <div className="pc-sync-list-row" key={r.username}>
            <span>{r.username}</span>
            <span className="is-muted">
              {r.kept ? "••••" : "••••"}
              {props.onChangePassword ? (
                <button type="button" className="pc-sync-link-btn" style={{ marginLeft: 8 }} onClick={() => props.onChangePassword!(r.username)}>
                  修改密码
                </button>
              ) : null}
            </span>
            <button type="button" className="pc-sync-icon-btn" title="删除" aria-label={`删除 ${r.username}`} onClick={() => props.onRemove(r.username)}>
              ✕
            </button>
          </div>
        ))}
        <div className="pc-sync-list-row">
          <input className="pc-dialog-input" placeholder="用户名" value={props.rowName} onChange={(e) => props.setRowName(e.target.value)} />
          <input className="pc-dialog-input" type="password" placeholder="密码" value={props.rowPw} onChange={(e) => props.setRowPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") props.onAdd(); }} />
          <button type="button" className="pc-dialog-opt" style={{ height: 26, padding: "0 8px", fontSize: 12 }} onClick={props.onAdd}>
            添加
          </button>
        </div>
      </div>
      {props.rowErr ? <div className="pc-sync-err">{props.rowErr}</div> : null}
      <div className="pc-sync-hint">{props.hint}</div>
    </div>
  );
}

/* ---------------- 打开 ---------------- */

type Step = { kind: "find" } | { kind: "choose"; candidates: Candidate[] } | { kind: "verify"; candidate: Candidate; from: "find" | "choose"; candidates?: Candidate[] };

const LOCK_S = 60;

/** 浏览器发不了 UDP:本机编辑器替页面在本网段查找(`/api/docservice/lan-discover`) */
async function discoverViaEditor({ name }: { name: string; timeoutMs: number }): Promise<{ hosts: LanHost[]; errors?: { reason: string }[] }> {
  const r = await fetch(`/api/docservice/lan-discover?name=${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`lan-discover ${r.status}`);
  const j = await r.json();
  return { hosts: Array.isArray(j.hosts) ? j.hosts : [], errors: Array.isArray(j.errors) ? j.errors : [] };
}

export function OpenSharedDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const device = useSync((v) => v.device);
  const [step, setStep] = useState<Step>({ kind: "find" });
  const [name, setName] = useState("");
  const [showHosted, setShowHosted] = useState(false);
  const [hostedUrl, setHostedUrl] = useState(readHostedUrl());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [asCreator, setAsCreator] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return;
    setStep({ kind: "find" });
    setName("");
    setShowHosted(false);
    setHostedUrl(readHostedUrl());
    setBusy(false);
    setMsg("");
    setAsCreator(false);
    setUsername("");
    setPassword("");
  }, [open]);

  useEffect(() => {
    if (lockUntil <= now) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [lockUntil, now]);

  const locked = Math.max(0, Math.ceil((lockUntil - now) / 1000));

  const find = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setMsg("正在局域网和阿里云查找...");
    let url: string | null = null;
    try {
      url = hostedUrl.trim() && hostedUrl.trim() !== hosted.DEFAULT_HOSTED_URL ? hosted.resolveHostedUrl({ ui: hostedUrl }) : null;
    } catch {
      setBusy(false);
      setMsg("托管地址不对：要以 http:// 或 https:// 开头。");
      return;
    }
    writeHostedUrl(hostedUrl);
    let r: FindResult;
    try {
      r = await route.findSharedProject({
        name: name.trim(),
        uiHostedUrl: url,
        lan: device?.localEditor ? { discover: discoverViaEditor } : {},
      });
    } catch {
      r = { candidates: [], errors: [{ where: "hosted", reason: "unreachable" }] };
    }
    setBusy(false);
    const pick = route.pickRoute(r);
    const lanErr = r.errors.some((e) => e.where === "lan" && e.reason !== "timeout");
    const hostedErr = r.errors.some((e) => e.where === "hosted");
    if (pick.action === "not-found") {
      setMsg(hostedErr && (lanErr || !device?.localEditor) ? "局域网和阿里云都连不上，检查一下网络。" : "找不到这个项目，检查名字对不对，或者局域网主机开没开机。");
      return;
    }
    setMsg("");
    if (hostedErr) pushToast("阿里云连不上", "warn", 4000);
    if (lanErr) pushToast("局域网查找失败", "warn", 4000);
    if (pick.action === "enter") toVerify(pick.candidate, "find");
    else setStep({ kind: "choose", candidates: pick.candidates });
  };

  const toVerify = (candidate: Candidate, from: "find" | "choose", candidates?: Candidate[]) => {
    setAsCreator(false);
    setUsername("");
    setPassword("");
    setMsg("");
    setStep({ kind: "verify", candidate, from, candidates });
  };

  const creatorName = step.kind === "verify" ? knownCreator(step.candidate.projectId) : null;

  const enter = async () => {
    if (step.kind !== "verify" || locked > 0) return;
    const c = step.candidate;
    const user = asCreator && creatorName ? creatorName : username.trim();
    if (!user || !password) return;
    setBusy(true);
    setMsg("");
    const r = await enterShared(c, { as: asCreator ? "creator" : "member", username: user, password });
    setBusy(false);
    if (r.ok) {
      onClose();
      return;
    }
    const text: Record<EnterError, string> = {
      auth: "用户名或密码不对。忘了的话找创建者问一下。",
      "rate-limited": "尝试太多次，等 60 秒后再试。",
      kicked: "你被创建者踢出了这个项目。想回来，找创建者撤销。",
      unreachable: c.where === "lan" ? "连不上主机，可能对方已关机或退出了软件。" : "连不上阿里云，检查一下网络。",
      "no-project": "找不到这个项目，检查名字对不对，或者局域网主机开没开机。",
      "not-ready": c.where === "lan" ? "连不上主机，可能对方已关机或退出了软件。" : "连不上阿里云，检查一下网络。",
    };
    if (r.error === "rate-limited") {
      setLockUntil(Date.now() + LOCK_S * 1000);
      setNow(Date.now());
    }
    setMsg(text[r.error]);
  };

  const candidateLabel = (c: Candidate) => (c.where === "hosted" ? "[互联网模式] 托管在阿里云" : `[局域网模式] 主机：${c.hostDeviceName ?? new URL(c.base).host}`);

  const body = useMemo(() => {
    if (step.kind === "find") {
      return (
        <>
          <div className="pc-sync-field">
            <label htmlFor="pc-os-name">项目名</label>
            <input id="pc-os-name" className="pc-dialog-input" placeholder="输入想找的项目名" value={name} autoFocus
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void find(); }} />
          </div>
          {showHosted ? (
            <div className="pc-sync-field">
              <label htmlFor="pc-os-hosted">托管地址</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="pc-os-hosted" className="pc-dialog-input" value={hostedUrl} onChange={(e) => setHostedUrl(e.target.value)} />
                <button type="button" className="pc-dialog-opt" style={{ height: 30 }} onClick={() => setHostedUrl(hosted.DEFAULT_HOSTED_URL)}>
                  恢复默认
                </button>
              </div>
            </div>
          ) : null}
        </>
      );
    }
    if (step.kind === "choose") {
      return (
        <>
          <div style={{ fontSize: 13 }}>找到两个同名项目，你要进哪一个？</div>
          <div className="pc-sync-choices-v" data-pc="shared-candidates">
            {step.candidates.map((c) => (
              <button key={c.base + c.projectId} type="button" className="pc-sync-choice" onClick={() => toVerify(c, "choose", step.candidates)}>
                <span className="pc-sync-choice-dot" />
                <span className="pc-sync-choice-text">
                  <b>{candidateLabel(c)}</b>
                  <small>{c.name}</small>
                </span>
              </button>
            ))}
          </div>
        </>
      );
    }
    const c = step.candidate;
    const free = c.mode === "free";
    return (
      <>
        <div className="pc-sync-hint">
          {c.name} · {candidateLabel(c)}
        </div>
        {asCreator ? (
          <>
            <div className="pc-sync-field">
              <label htmlFor="pc-os-user">{free ? "你的用户名" : "用户名"}</label>
              <input id="pc-os-user" className="pc-dialog-input" disabled={!!creatorName} value={creatorName ?? username}
                placeholder={free ? "报上你的名字" : "输入名单里的用户名"} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="pc-sync-field">
              <label htmlFor="pc-os-pw">创建者密码</label>
              <input id="pc-os-pw" type="password" className="pc-dialog-input" placeholder="输入创建者密码" value={password} autoFocus
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void enter(); }} />
            </div>
          </>
        ) : free ? (
          <>
            <div className="pc-sync-field">
              <label htmlFor="pc-os-pw">项目密码</label>
              <input id="pc-os-pw" type="password" className="pc-dialog-input" placeholder="输入项目密码" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="pc-sync-field">
              <label htmlFor="pc-os-user">你的用户名</label>
              <input id="pc-os-user" className="pc-dialog-input" placeholder="报上你的名字" value={username}
                onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void enter(); }} />
            </div>
          </>
        ) : (
          <>
            <div className="pc-sync-field">
              <label htmlFor="pc-os-user">用户名</label>
              <input id="pc-os-user" className="pc-dialog-input" placeholder="输入名单里的用户名" value={username} autoFocus onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="pc-sync-field">
              <label htmlFor="pc-os-pw">密码</label>
              <input id="pc-os-pw" type="password" className="pc-dialog-input" placeholder="对应的密码" value={password}
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void enter(); }} />
            </div>
          </>
        )}
        <div>
          <button type="button" className="pc-sync-link-btn" onClick={() => { setAsCreator(!asCreator); setPassword(""); setMsg(""); }}>
            {asCreator ? "返回" : "我是创建者"}
          </button>
        </div>
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, name, showHosted, hostedUrl, asCreator, username, password, creatorName]);

  if (!open) return null;
  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-openshared-title" data-pc="open-shared-dialog" style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div id="pc-openshared-title" className="pc-dialog-title" style={{ flex: 1 }}>
            打开共享项目
          </div>
          {step.kind === "find" ? (
            <button type="button" className="pc-sync-link-btn" onClick={() => setShowHosted(!showHosted)}>
              托管地址
            </button>
          ) : null}
        </div>
        <div className="pc-dialog-body">
          {body}
          {msg ? <div className={`pc-sync-status-line${busy ? "" : " is-err"}`}>{msg}</div> : null}
        </div>
        <div className="pc-dialog-foot">
          {step.kind !== "find" ? (
            <button type="button" className="pc-btn" style={{ marginRight: "auto" }}
              onClick={() => { setMsg(""); setStep(step.kind === "verify" && step.from === "choose" && step.candidates ? { kind: "choose", candidates: step.candidates } : { kind: "find" }); }}>
              返回
            </button>
          ) : null}
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          {step.kind === "find" ? (
            <button type="button" className="pc-btn pc-btn--primary" disabled={busy || !name.trim()} onClick={() => void find()}>
              查找
            </button>
          ) : step.kind === "verify" ? (
            <button type="button" className="pc-btn pc-btn--primary" disabled={busy || locked > 0} onClick={() => void enter()}>
              {locked > 0 ? `进入 (${locked}s)` : "进入"}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
