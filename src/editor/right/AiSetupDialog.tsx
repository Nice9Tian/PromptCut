import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useBackdropClose } from "../../ui/backdropClose";
import { useEffect, useRef, useState } from "react";
import "./AiSetupDialog.css";
import { ApiSharePanel } from "./ApiSharePanel";
import { ReportDialog } from "./ReportDialog";
import { SETUP_ENTRIES, isCliEntry, readFace, writeFace } from "./setupEntries";
import type { SetupEntry, SetupEntryId } from "./setupEntries";
import { redactDebug } from "../../ai/debug";
import { CAPABILITIES } from "../../ai/modelOptions";
import type { ProviderInfo, AiProvider, SttInfo, PublicAiConfig, AiConfigPatch, ApiVendor, CliSetupJob, LoginState, KeyKind } from "../../ai/types";

/**
 * 把「非默认、又容易让排查跑偏」的设置挑成人话，放在诊断报告最前面。
 *
 * 这些值服务端那份 config 里全都有，问题在于没人会去翻。文本协议模式尤其：
 * 它一开，模型就改用回复正文里的文本块下达工具调用，工具相关的症状全变样，
 * 而开关本身藏在「更多」里，用户自己都未必记得点过。
 */
function notableSettings(cfg: PublicAiConfig | null | undefined, current: AiProvider | null): string[] {
  if (!cfg) return ["拿不到服务端配置（/api/ai/diagnostics 没返回 config），下面的内容可能不全"];
  const out: string[] = [];
  if (cfg.toolProtocol) {
    out.push("⚠ 文本协议模式已开启（默认是关的）——模型改用回复正文里的文本块下达工具调用。工具相关的异常先怀疑这里");
  }
  out.push(`当前使用：${current ?? "（还没选）"}；配置里的默认：${cfg.defaultProvider ?? "（未设）"}`);
  if (current === "api") {
    out.push(`API 直连：${cfg.api.vendor}，模型 ${cfg.api.model || "（未填）"}，maxTokens ${cfg.api.maxTokens}`);
    // redactDebug 会把 apiKey 整个换成 [REDACTED]，连「到底配没配」都看不出来了。
    // 这两个字段名躲开它的匹配，好让支持能分清「没配 Key」和「Key 不对」。
    out.push(cfg.api.apiKey.set ? `API Key：已配置，末四位 ${cfg.api.apiKey.last4}` : "API Key：未配置");
    if (cfg.api.baseUrl) out.push(`走了自定义 baseUrl：${cfg.api.baseUrl}`);
  }
  // 模型清单是空的，面板上就只有「默认」一项可选 —— 用户常报「换不了模型」其实是这个
  for (const id of ["claude", "codex", "agy"] as const) {
    if (!cfg.cliModels?.[id]) out.push(`${id} 没配模型清单，面板上只会有「默认」一项`);
  }
  return out;
}

export function AiSetupDialog(props: {
  open: boolean; onClose: () => void;
  providers: ProviderInfo[];
  stt?: SttInfo;
  current: AiProvider | null; onChoose: (id: AiProvider) => void;
  onLogin: (id: AiProvider, deviceAuth?: boolean) => Promise<void>;
  loginState: Partial<Record<AiProvider, LoginState>>;
  setupJobs: CliSetupJob[];
  onCancelSetup: (id: AiProvider) => Promise<void>;
  onInstall: (id: AiProvider) => Promise<void>;
  installState: Partial<Record<AiProvider, "idle" | "installing" | "ok" | "timeout" | "failed">>;
  installError: Partial<Record<AiProvider, string>>;
  config: PublicAiConfig | null; onSaveConfig: (partial: AiConfigPatch) => Promise<void>;
  /** 「清理密钥」:删掉那一路的密钥文件 */
  onClearKey?: (kind: KeyKind) => Promise<void>;
}): JSX.Element | null {
  const { open, onClose, providers, stt, current, onChoose, onLogin, loginState, setupJobs, onCancelSetup, onInstall, installState, installError, config, onSaveConfig, onClearKey } = props;
  // 遮罩:按下和松开都在遮罩上才关。在输入框里拖着选文字、松手滑到外面,不能把窗口关了
  const backdrop = useBackdropClose(onClose);
  const [clearing, setClearing] = useState<KeyKind | "">("");
  const [clearMsg, setClearMsg] = useState("");
  const clearKeyOf = async (kind: KeyKind) => {
    if (!onClearKey) return;
    if (!confirm(kind === "router" ? "删除 Router 导入的密钥文件?之后要再粘一次分发密文。" : "删除自定义 API 的密钥文件?之后要重新填 Key。")) return;
    setClearing(kind);
    setClearMsg("");
    try {
      await onClearKey(kind);
      setClearMsg("密钥文件已删除");
      if (kind === "custom") { setReplaceKey(true); setApiKeyInput(""); }
    } catch (e) {
      setClearMsg(e instanceof Error ? e.message : "清理失败");
    } finally {
      setClearing("");
    }
  };

  /** null = 停在第一级的选择页;有值 = 进了那一项的配置页 */
  const [openedEntry, setOpenedEntry] = useState<SetupEntryId | null>(null);

  const [apiVendor, setApiVendor] = useState<ApiVendor>("anthropic");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiModel, setApiModel] = useState("");
  /** Router 那一路的模型清单(| 分隔),独立于自定义页 */
  const [routerModel, setRouterModel] = useState("");
  const [savingRouter, setSavingRouter] = useState(false);
  const [routerMsg, setRouterMsg] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** provider → 安装方式:能一键装的给命令,不能的给一句人话 */
  const [installPlans, setInstallPlans] = useState<Partial<Record<string, { command?: string; hint?: string }>>>({});
  const [agyPerms, setAgyPerms] = useState<{ path: string; total: number; granted: string[]; missing: string[] } | null>(null);
  const [agyPermError, setAgyPermError] = useState("");
  const [granting, setGranting] = useState(false);
  const [toolProtocol, setToolProtocol] = useState(false);
  /** 「更多」里放高级开关。每次打开对话框都收回去,免得上次展开过就一直敞着 */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 三家 CLI 的可选模型清单(| 分隔),面板上的模型选择器读它 */
  const [cliModels, setCliModels] = useState<Record<string, string>>({});
  const [savingModels, setSavingModels] = useState(false);
  const [loadingAgyModels, setLoadingAgyModels] = useState(false);
  const [modelsMsg, setModelsMsg] = useState("");
  const [diagState, setDiagState] = useState("");
  /*
   * 收好的报告 + 装它的子窗口。
   *
   * 以前是点一下就按长度自己选路走掉(短的进剪贴板、长的落盘),用户既看不到
   * 报告长什么样也没得挑。现在先摆出来,复制 / 保存为文件 / 提交三条路由用户定。
   */
  const [diagReport, setDiagReport] = useState("");
  const [diagOpen, setDiagOpen] = useState(false);
  /*
   * 报告到底去哪了,要弹一条看得见的提示。
   *
   * 以前只把这句话塞进「使用这一项」旁边那行小灰字里,点完 Debugger 什么动静都
   * 没有,用户根本不知道复制成功没有。
   */
  const [diagToast, setDiagToast] = useState("");
  const diagToastTimer = useRef<number | null>(null);
  const showDiagToast = (text: string) => {
    setDiagToast(text);
    if (diagToastTimer.current) window.clearTimeout(diagToastTimer.current);
    diagToastTimer.current = window.setTimeout(() => setDiagToast(""), 6000);
  };
  useEffect(() => () => { if (diagToastTimer.current) window.clearTimeout(diagToastTimer.current); }, []);

  /*
   * 导航状态只在「对话框被打开」这一刻重置。
   *
   * 以前这段和下面的表单同步写在同一个 effect 里,依赖是 [open, current, config] ——
   * 于是**每次保存配置都会把人踢回第一级**:填完 API Key 点保存,config 一变,
   * effect 重跑,setOpenedEntry(null) 把详情页收掉;「更多」展开着也会被合上。
   * 拆成两个:这个只看 open,那个只管把 config 同步进表单。
   */
  useEffect(() => {
    if (!open) return;
    setOpenedEntry(null);
    setMoreOpen(false);
    setDiagState("");
    setDiagReport("");
    setDiagOpen(false);
    // 保存反馈和没提交的输入也属于「这一次打开」的状态,不能跟着 config 走:
    // 跟着走的话保存成功那一刻 config 一变,「已保存」当场被抹掉,用户什么都没看见。
    setApiKeyInput("");
    setSaveSuccess(false);
    setSaveError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (config) {
      // 两路各读各的 profile;老服务端没有 profiles 时退回顶层那份
      const custom = config.api.profiles?.custom ?? config.api;
      setApiVendor(custom.vendor);
      setApiBaseUrl(custom.baseUrl);
      setApiModel(custom.model);
      setRouterModel(config.api.profiles?.router?.model ?? (config.api.source === "router" ? config.api.model : ""));
      setRouterMsg("");
      setReplaceKey(!config.api.apiKey.set);
      setToolProtocol(!!config.toolProtocol);
      setCliModels({ ...(config.cliModels ?? {}) });
      setModelsMsg("");
    }
    fetch("/api/ai/agy-permissions")
      .then((r) => r.json())
      .then((data) => { if (data.ok) setAgyPerms(data); })
      .catch(() => {});
  }, [open, config]);

  useEffect(() => {
    if (!open) return;
    // 未安装的那几项:问服务端能不能一键装、命令是什么(dryRun 只回答不执行)
    for (const p of providers) {
      if (p.available) continue;
      fetch("/api/ai/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p.id, dryRun: true }),
      })
        .then((r) => r.json())
        .then((d) => setInstallPlans((prev) => ({ ...prev, [p.id]: d.ok ? { command: d.command } : { hint: d.hint || d.error } })))
        .catch(() => {});
    }
  }, [open, providers]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Esc 先退回上一级,再按一次才关掉整个对话框
      if (openedEntry) goTo(null);
      else onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, openedEntry]);

  if (!open) return null;

  const handleGrant = async () => {
    setGranting(true);
    setAgyPermError("");
    try {
      const r = await fetch("/api/ai/agy-permissions", { method: "POST" });
      const data = await r.json();
      if (data.ok) {
        setAgyPerms((prev) => (prev ? { ...prev, granted: [...prev.granted, ...data.added], missing: [] } : null));
      } else {
        setAgyPermError(data.error || "授权失败");
      }
    } catch (e) {
      setAgyPermError(String(e));
    } finally {
      setGranting(false);
    }
  };

  const handleSaveApi = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    // 显式写进 custom 那一路:即使当前生效的是 Router,也不会把 Router 的配置冲掉
    const patch: AiConfigPatch = { api: { profiles: { custom: { vendor: apiVendor, baseUrl: apiBaseUrl, model: apiModel } } } };
    if (replaceKey && apiKeyInput.trim()) { patch.api!.apiKey = apiKeyInput.trim(); patch.api!.source = "custom"; }
    else if (config?.keys?.custom.set) patch.api!.source = "custom"; // 保存自定义页 = 切到自定义那一路
    try {
      await onSaveConfig(patch);
      setSaveSuccess(true);
      setApiKeyInput("");
      setReplaceKey(false);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message || "保存失败" : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const saveCliModels = async () => {
    setSavingModels(true);
    setModelsMsg("");
    try {
      await onSaveConfig({ cliModels });
      setModelsMsg("已保存，面板上的模型选择器会立刻用新清单");
    } catch (e) {
      setModelsMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingModels(false);
    }
  };

  /** agy 自己能列模型,不用手打。其余两家没有列表命令,只能手填 */
  const loadAgyModels = async () => {
    setLoadingAgyModels(true);
    setModelsMsg("");
    try {
      const d = await (await fetch("/api/ai/models?provider=agy")).json();
      if (!d.ok) throw new Error(d.error || "读不到模型清单");
      const list: string[] = d.models ?? [];
      if (list.length === 0) throw new Error("CLI 没有返回任何模型");
      setCliModels((prev) => ({ ...prev, agy: list.join("|") }));
      setModelsMsg(`读到 ${list.length} 个模型，确认后点保存`);
    } catch (e) {
      setModelsMsg(e instanceof Error ? e.message : "读取失败");
    } finally {
      setLoadingAgyModels(false);
    }
  };

  const handleSaveProtocol = async (checked: boolean) => {
    setToolProtocol(checked);
    await onSaveConfig({ toolProtocol: checked });
  };

  /**
   * 排查信息:服务端那份(平台、CLI 路径、各家安装/登录状态、脱敏后的配置)
   * 加上浏览器这边的一点上下文,收成一份 JSON 摆进子窗口。密钥在服务端就已经
   * 换成 last4,机器码只留首组(它同时是配置分发的解密口令),redactDebug 再兜一道底。
   *
   * 先收完再开窗:收集要等服务端 refresh 一遍各家 CLI 状态,先开窗会闪一下空白;
   * 收集期间「正在收集…」显示在底部那行小字上。
   */
  const openDiagnostics = async () => {
    setDiagState("正在收集…");
    setDiagReport("");
    let report: string;
    try {
      const res = await fetch("/api/ai/diagnostics");
      const server = await res.json();
      report = JSON.stringify(
        redactDebug({
          format: "PromptCut AI setup diagnostics v2",
          copiedAt: new Date().toISOString(),
          // 摆在最前面:和默认值不一样、又最容易让人查错方向的几条。
          // 服务端那份 config 里本来就有,但埋在几百行 JSON 底下没人翻得到 ——
          // 「用户其实开着文本协议模式」这种乌龙就是这么来的。
          notable: notableSettings(server?.config, current),
          browser: { userAgent: navigator.userAgent, language: navigator.language },
          openedEntry,
          currentProvider: current,
          setupJobs: setupJobs.map((j) => ({ ...j, logs: j.logs.slice(-8) })),
          server,
        }),
        null,
        2,
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setDiagState(`收集失败:${why}`);
      showDiagToast(`诊断信息收集失败:${why}`);
      return;
    }
    // 收集成功就把报告摆进子窗口,复制 / 保存为文件 / 提交由用户自己挑。
    setDiagReport(report);
    setDiagOpen(true);
    setDiagState("");
  };

  /** 切换入口时把上一项的诊断输出清掉,免得看着像是当前这项的 */
  const goTo = (id: SetupEntryId | null) => {
    setOpenedEntry(id);
    setDiagState("");
    setDiagReport("");
    setDiagOpen(false);
  };

  /** 这一项现在能不能用,以及不能用的话缺什么 */
  const readiness = (entry: SetupEntry): { ok: boolean; label: string; tone: "ok" | "warn" | "idle" } => {
    if (isCliEntry(entry.id)) {
      const p = providers.find((x) => x.id === entry.provider);
      if (!p?.available) return { ok: false, label: "未安装", tone: "warn" };
      if (p.auth?.loggedIn === true) return { ok: true, label: "已登录", tone: "ok" };
      if (p.auth?.loggedIn === false) return { ok: false, label: "未登录", tone: "warn" };
      return { ok: false, label: "登录状态待确认", tone: "idle" };
    }
    if (config?.api.apiKey.set) return { ok: true, label: `已配置 ••••${config.api.apiKey.last4}`, tone: "ok" };
    return { ok: false, label: "未配置", tone: "idle" };
  };

  const renderCliBody = (entry: SetupEntry) => {
    const p = providers.find((x) => x.id === entry.provider);
    if (!p) return <div className="ais-detail">这一项在本机上没有检测到。</div>;
    const st = loginState[p.id];
    const job = setupJobs.find((j) => j.provider === p.id);
    const plan = installPlans[p.id];
    const ist = installState[p.id] || "idle";
    const err = installError[p.id];

    return (
      <>
        <section className="ais-step">
          <div className="ais-step-head">
            <span className="ais-step-no">1</span>
            <span className="ais-step-title">安装</span>
            <span className={p.available ? "ais-status-ok" : "ais-status-err"}>
              {p.available ? p.version || "已安装(版本未知)" : "未安装"}
            </span>
          </div>
          {!p.available && (
            plan?.command ? (
              <div className="ais-auth-action">
                <button className="ais-btn ais-primary-btn" disabled={ist === "installing"} onClick={(e) => { e.preventDefault(); onInstall(p.id); }}>
                  {ist === "installing" ? "安装中…" : ist === "ok" ? "已安装" : ist === "timeout" ? "等太久了,重试" : ist === "failed" ? "重试安装" : "安装"}
                </button>
                <span className="ais-detail">{ist === "installing" ? "正在后台安装，完成后会自动检测" : plan.command}</span>
              </div>
            ) : (
              <div className="ais-detail">{plan?.hint || "这一项需要按官方说明手动安装。"}</div>
            )
          )}
          {err && <div className="ais-fixhint">{err}</div>}
        </section>

        <section className="ais-step">
          <div className="ais-step-head">
            <span className="ais-step-no">2</span>
            <span className="ais-step-title">登录</span>
            {p.auth?.loggedIn === true
              ? <span className="ais-status-ok">已登录</span>
              : <span className="ais-status-err">{p.auth?.loggedIn === false ? "未登录" : "待确认"}</span>}
          </div>
          {p.auth?.loggedIn !== true && (
            <div className="ais-auth-action">
              <button className="ais-btn ais-primary-btn" disabled={!p.available || st === "waiting"} onClick={(e) => { e.preventDefault(); onLogin(p.id); }}>
                {st === "waiting" ? "等待登录…" : st === "timeout" || st === "failed" ? "重试登录" : "登录"}
              </button>
              {!p.available && <span className="ais-detail">先装好再登录</span>}
            </div>
          )}
          {p.id === "codex" && <div className="ais-detail">PromptCut 使用独立登录，不受 Codex 桌面应用配置影响。</div>}
          {p.auth?.loggedIn === null && p.auth.detail && <div className="ais-detail">{p.auth.detail}</div>}
          {p.auth?.fixHint && <div className="ais-fixhint">{p.auth.fixHint}</div>}
          {job && (
            <div className="ais-setup-progress" role="status" aria-live="polite">
              <div className={job.state === "failed" ? "ais-fixhint" : "ais-detail"}>{job.message}</div>
              {job.state === "running" && <button className="ais-btn" onClick={(e) => { e.preventDefault(); onCancelSetup(p.id); }}>取消</button>}
              {job.url && <a className="ais-btn" href={job.url} target="_blank" rel="noreferrer">打开登录网页 ↗</a>}
              {job.deviceCode && <div>登录验证码：<strong>{job.deviceCode}</strong></div>}
              {job.kind === "install" && job.logs.length > 0 && <details><summary>查看安装详情</summary><pre>{job.logs.join("")}</pre></details>}
              {p.id === "codex" && job.kind === "login" && job.state === "failed" && (
                <button className="ais-btn" onClick={(e) => { e.preventDefault(); onLogin(p.id, true); }}>改用设备码登录</button>
              )}
            </div>
          )}
        </section>

        <section className="ais-step">
          <div className="ais-step-head">
            <span className="ais-step-no">${entry.id === "agy" ? 4 : 3}</span>
            <span className="ais-step-title">可选模型</span>
          </div>
          <div className="ais-detail">
            用 <code>|</code> 分开写几个，面板输入框旁边就能切。{CAPABILITIES[entry.provider].modelsHint}
          </div>
          <div className="ais-api-field">
            <input
              type="text"
              value={cliModels[entry.id as "claude" | "codex" | "agy"] ?? ""}
              placeholder={CAPABILITIES[entry.provider].suggestedModels || "model-a|model-b"}
              onChange={(e) => setCliModels((prev) => ({ ...prev, [entry.id]: e.target.value }))}
            />
            <button className="ais-btn" disabled={savingModels} onClick={(e) => { e.preventDefault(); saveCliModels(); }}>
              {savingModels ? "保存中…" : "保存"}
            </button>
          </div>
          {entry.id === "agy" && (
            <div className="ais-api-field">
              <button className="ais-btn" disabled={loadingAgyModels} onClick={(e) => { e.preventDefault(); loadAgyModels(); }}>
                {loadingAgyModels ? "读取中…" : "从 CLI 读取"}
              </button>
              <span className="ais-detail">跑一次 agy models，把清单填进上面这一栏</span>
            </div>
          )}
          {modelsMsg && <div className="ais-detail">{modelsMsg}</div>}
        </section>

        {entry.id === "agy" && agyPerms && (
          <section className="ais-step">
            <div className="ais-step-head">
              <span className="ais-step-no">3</span>
              <span className="ais-step-title">授权 PromptCut 工具</span>
              <button className="ais-btn ais-primary-btn ais-small-btn" disabled={granting || agyPerms.missing.length === 0} onClick={handleGrant}>
                {agyPerms.missing.length === 0 ? "已授权" : granting ? "授权中..." : "点击授权"}
              </button>
            </div>
            <div className="ais-agy-perms-desc">
              {agyPerms.missing.length === 0 ? `已授权 ${agyPerms.total} 个工具。` : `已授权 ${agyPerms.granted.length}/${agyPerms.total} 个工具。`}
              会在 <code>{agyPerms.path}</code> 的 permissions.allow 里加 {agyPerms.missing.length} 条 mcp(promptcut/...) 规则；已有的规则不会动。
            </div>
            {agyPermError && <div className="ais-status-err">{agyPermError}</div>}
          </section>
        )}
      </>
    );
  };

  const renderRouterBody = () => (
    <section className="ais-step">
      <div className="ais-detail">
        分发方用你的本机识别码把 API 配置加密成一段密文。粘进来就自动解开并保存，
        密钥全程不以明文出现在聊天记录或磁盘上。
      </div>
      <ApiSharePanel
        onSaveConfig={onSaveConfig}
        saved={config?.keys?.router ?? null}
        active={config?.api.source === "router"}
        clearing={clearing === "router"}
        onClear={onClearKey ? () => clearKeyOf("router") : undefined}
        clearMsg={clearMsg}
      />
      {config?.keys?.router?.set && (
        <>
          <div className="ais-api-field">
            <label>模型</label>
            <input
              type="text"
              value={routerModel}
              onChange={(e) => setRouterModel(e.target.value)}
              placeholder="model-a|model-b"
            />
          </div>
          <div className="ais-detail">
            分发密文里带的模型可以在这里改、也可以用 <code>|</code> 多写几个备选，面板输入框旁边就能切；
            厂商 {config.api.profiles?.router?.vendor ?? config.api.vendor}，地址 {config.api.profiles?.router?.baseUrl || "(默认)"}，这两项跟着密文走。
          </div>
          <div className="ais-api-actions">
            <button
              className="ais-btn ais-primary-btn"
              disabled={savingRouter}
              onClick={async (e) => {
                e.preventDefault();
                setSavingRouter(true);
                setRouterMsg("");
                try {
                  await onSaveConfig({ api: { profiles: { router: { model: routerModel } } } });
                  setRouterMsg("已保存，面板上的模型选择器会立刻用新清单");
                } catch (err) {
                  setRouterMsg(err instanceof Error ? err.message : "保存失败");
                } finally {
                  setSavingRouter(false);
                }
              }}
            >
              {savingRouter ? "保存中…" : "保存模型清单"}
            </button>
            {routerMsg && <span className="ais-detail">{routerMsg}</span>}
          </div>
        </>
      )}
    </section>
  );

  const renderCustomBody = () => (
    <section className="ais-step">
      <div className="ais-api-field">
        <label>厂商</label>
        <select value={apiVendor} onChange={(e) => setApiVendor(e.target.value as ApiVendor)}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI 兼容</option>
          <option value="gemini">Gemini</option>
        </select>
      </div>
      <div className="ais-api-field">
        <label>API 地址</label>
        <input
          type="text"
          value={apiBaseUrl}
          onChange={(e) => setApiBaseUrl(e.target.value)}
          placeholder={apiVendor === "anthropic" ? "https://api.anthropic.com" : apiVendor === "openai" ? "https://api.openai.com" : "https://generativelanguage.googleapis.com"}
        />
      </div>
      <div className="ais-api-field">
        <label>模型</label>
        <input
          type="text"
          value={apiModel}
          onChange={(e) => setApiModel(e.target.value)}
          placeholder={apiVendor === "anthropic" ? "claude-sonnet-4-5|claude-haiku-4-5" : apiVendor === "openai" ? "gpt-4o|gpt-4o-mini" : "gemini-2.0-flash|gemini-2.0-pro"}
        />
      </div>
      <div className="ais-detail">
        用 <code>|</code> 分开写几个模型，面板输入框旁边就能切；不选就用第一个。
      </div>
      <div className="ais-api-field">
        <label>API Key</label>
        {config?.keys?.custom.set && !replaceKey ? (
          <div className="ais-api-saved-key">
            <span>已保存 ••••{config.keys.custom.last4}{config.api.source === "router" ? "(当前生效的是 Router 导入的那份)" : ""}</span>
            <span className="ais-api-saved-acts">
              <button className="ais-btn" onClick={(e) => { e.preventDefault(); setReplaceKey(true); }}>更换</button>
              <button className="ais-btn ais-danger-btn" disabled={clearing !== ""} onClick={(e) => { e.preventDefault(); clearKeyOf("custom"); }} title="删除 keys/custom.key">
                {clearing === "custom" ? "清理中…" : "清理密钥"}
              </button>
            </span>
          </div>
        ) : (
          <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="粘贴 API Key" />
        )}
        {clearMsg && <div className="ais-detail">{clearMsg}</div>}
      </div>
      <div className="ais-api-actions">
        <button className="ais-btn ais-primary-btn" onClick={(e) => { e.preventDefault(); handleSaveApi(); }} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        {saveSuccess && <span className="ais-status-ok">已保存</span>}
        {saveError && <span className="ais-status-err">{saveError}</span>}
      </div>
      <div className="ais-detail">
        Key 落盘时用本机指纹加密，单独存在 <code>keys/custom.key</code>（和 Router 导入的那份各用各的加密标识，不混用），
        不会明文躺在配置文件里；它挡的是备份、同步盘、误提交这类外泄，挡不住能在这台机器上跑代码的人。
      </div>
    </section>
  );

  const entry = openedEntry ? SETUP_ENTRIES.find((e) => e.id === openedEntry) : null;

  return createPortal(
    <>
    <div className="ais-backdrop" {...backdrop}>
      <div className="ais-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {/* 报告去哪了要看得见。role=status 让读屏软件也念出来 */}
        {diagToast && (
          <div className="ais-toast" role="status" onClick={() => setDiagToast("")}>
            {diagToast}
          </div>
        )}
        {!entry ? (
          <>
            <div className="ais-title">选择 AI 助手的驱动方式</div>
            <div className="ais-grid">
              {SETUP_ENTRIES.map((item) => {
                const state = readiness(item);
                const isCurrent = current === item.provider && (isCliEntry(item.id) || readFace() === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-entry={item.id}
                    className={`ais-card${isCurrent ? " is-current" : ""}`}
                    onClick={() => goTo(item.id)}
                  >
                    <span className="ais-card-icon">{item.icon}</span>
                    <span className="ais-card-name">{item.name}</span>
                    <span className="ais-card-tagline">{item.tagline}</span>
                    <span className={`ais-card-state is-${state.tone}`}>{state.label}</span>
                    {isCurrent && <span className="ais-card-current">正在使用</span>}
                  </button>
                );
              })}
            </div>
            {/*
              文本协议模式收进「更多」里。它以前是这一页上一个裸的勾选框,谁都可能顺手点一下,
              可它改的是模型下达工具调用的方式 —— 打开之后调用写在正文里,比原生工具慢也更容易出错,
              属于「CLI 真的拒绝原生工具了」才该动的开关,不该和选驱动放在同一层。
            */}
            {moreOpen && (
              <div className="ais-more">
                <div className="ais-more-title">高级</div>
                <label className="ais-more-row">
                  <input
                    type="checkbox"
                    checked={toolProtocol}
                    onChange={(e) => handleSaveProtocol(e.target.checked)}
                  />
                  <span className="ais-more-body">
                    <span className="ais-more-name">文本协议模式</span>
                    <span className="ais-detail">
                      只有当这家 CLI 拒绝原生工具时才需要打开。打开后模型改用回复正文里的文本块
                      下达工具调用，比原生工具慢、也更容易出错。不确定就别动它。
                    </span>
                  </span>
                </label>
              </div>
            )}
            <div className="ais-footer">
              <div className="ais-footer-actions">
                {/*
                  收起来是为了防误触,但不能收到「开着也看不出来」。里面有非默认项时
                  按钮上挂个点:用户不展开也知道这儿动过,不至于一直开着文本协议模式
                  却在别处找原因。
                */}
                <button
                  className="ais-btn ais-more-btn"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                  title={toolProtocol ? "文本协议模式开着" : undefined}
                >
                  更多{toolProtocol && <span className="ais-more-dot" aria-label="有非默认设置">•</span>}
                  {moreOpen ? " ▴" : " ▾"}
                </button>
                <span className="ais-footer-spacer" />
                <button className="ais-btn" onClick={onClose}>关闭</button>
              </div>
              {stt && <div className="ais-stt-info">语音识别: {stt.engine} - {stt.available ? "可用" : `不可用 (${stt.hint})`}</div>}
            </div>
          </>
        ) : (
          <>
            <div className="ais-detail-head">
              <button className="ais-btn ais-back-btn" onClick={() => goTo(null)}>← 返回</button>
              <span className="ais-card-icon ais-detail-icon">{entry.icon}</span>
              <div className="ais-detail-titles">
                <div className="ais-title">{entry.name}</div>
                <div className="ais-detail">{entry.tagline}</div>
              </div>
            </div>

            <div className="ais-detail-body">
              {isCliEntry(entry.id) ? renderCliBody(entry) : entry.id === "router" ? renderRouterBody() : renderCustomBody()}
            </div>

            <div className="ais-footer">
              <div className="ais-footer-actions">
                <button
                  className="ais-btn"
                  onClick={openDiagnostics}
                  disabled={diagState === "正在收集…"}
                  title="收集本机环境、安装与登录状态(不含密钥),在子窗口里复制 / 存文件 / 提交"
                >
                  {diagState === "正在收集…" ? "收集中…" : "Debugger"}
                </button>
                <span className="ais-use-hint">{diagState || (readiness(entry).ok ? "" : readiness(entry).label)}</span>
                <button
                  className="ais-btn ais-primary-btn"
                  disabled={!readiness(entry).ok}
                  onClick={() => { writeFace(entry.id); onChoose(entry.provider); }}
                >
                  使用这一项
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    <ReportDialog
      open={diagOpen}
      title="环境诊断报告"
      label="环境诊断"
      hint="含本机环境、各家 CLI 安装与登录状态;不含密钥,机器码只保留首组"
      text={diagReport}
      onClose={() => setDiagOpen(false)}
    />
    </>,
    document.body,
  );
}
