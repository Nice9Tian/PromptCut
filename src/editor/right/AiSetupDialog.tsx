import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import "./AiSetupDialog.css";
import { ApiSharePanel } from "./ApiSharePanel";
import { SETUP_ENTRIES, isCliEntry, readFace, writeFace } from "./setupEntries";
import type { SetupEntry, SetupEntryId } from "./setupEntries";
import { copyDebugReport, redactDebug } from "../../ai/debug";
import { CAPABILITIES } from "../../ai/modelOptions";
import type { ProviderInfo, AiProvider, SttInfo, PublicAiConfig, AiConfigPatch, ApiVendor, CliSetupJob, LoginState } from "../../ai/types";

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
}): JSX.Element | null {
  const { open, onClose, providers, stt, current, onChoose, onLogin, loginState, setupJobs, onCancelSetup, onInstall, installState, installError, config, onSaveConfig } = props;

  /** null = 停在第一级的选择页;有值 = 进了那一项的配置页 */
  const [openedEntry, setOpenedEntry] = useState<SetupEntryId | null>(null);

  const [apiVendor, setApiVendor] = useState<ApiVendor>("anthropic");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiModel, setApiModel] = useState("");
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
  /** 三家 CLI 的可选模型清单(| 分隔),面板上的模型选择器读它 */
  const [cliModels, setCliModels] = useState<Record<string, string>>({});
  const [savingModels, setSavingModels] = useState(false);
  const [loadingAgyModels, setLoadingAgyModels] = useState(false);
  const [modelsMsg, setModelsMsg] = useState("");
  const [diagState, setDiagState] = useState("");
  /** 剪贴板写不进去时,把报告摆出来让用户自己复制 */
  const [diagReport, setDiagReport] = useState("");

  useEffect(() => {
    if (!open) return;
    // 每次打开都回到第一级:上次配到哪儿了不该影响这次想看什么
    setOpenedEntry(null);
    setDiagState("");
    setDiagReport("");
    if (config) {
      setApiVendor(config.api.vendor);
      setApiBaseUrl(config.api.baseUrl);
      setApiModel(config.api.model);
      setReplaceKey(!config.api.apiKey.set);
      setApiKeyInput("");
      setSaveSuccess(false);
      setSaveError(null);
      setToolProtocol(!!config.toolProtocol);
      setCliModels({ ...(config.cliModels ?? {}) });
      setModelsMsg("");
    }
    fetch("/api/ai/agy-permissions")
      .then((r) => r.json())
      .then((data) => { if (data.ok) setAgyPerms(data); })
      .catch(() => {});
  }, [open, current, config]);

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
    const patch: AiConfigPatch = { api: { vendor: apiVendor, baseUrl: apiBaseUrl, model: apiModel } };
    if (replaceKey && apiKeyInput.trim()) patch.api!.apiKey = apiKeyInput.trim();
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
   * 加上浏览器这边的一点上下文,一起复制走。密钥在服务端就已经换成 last4,
   * redactDebug 再兜一道底。
   */
  const copyDiagnostics = async () => {
    setDiagState("正在收集…");
    setDiagReport("");
    let report: string;
    try {
      const res = await fetch("/api/ai/diagnostics");
      const server = await res.json();
      report = JSON.stringify(
        redactDebug({
          format: "PromptCut AI setup diagnostics v1",
          copiedAt: new Date().toISOString(),
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
      setDiagState(e instanceof Error ? `收集失败:${e.message}` : "收集失败");
      return;
    }
    // 收集成功了,剪贴板能不能写是另一回事:写不进去就把内容摆出来让用户自己复制,
    // 别只丢一句「请手动复制下面的内容」却没有下面的内容。
    try {
      await copyDebugReport(report);
      setDiagState("已复制到剪贴板,可以直接粘贴给我们");
    } catch {
      setDiagReport(report);
      setDiagState("剪贴板不可用,请手动复制下面这段");
    }
  };

  /** 切换入口时把上一项的诊断输出清掉,免得看着像是当前这项的 */
  const goTo = (id: SetupEntryId | null) => {
    setOpenedEntry(id);
    setDiagState("");
    setDiagReport("");
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
      <ApiSharePanel onSaveConfig={onSaveConfig} />
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
          placeholder={apiVendor === "anthropic" ? "claude-sonnet-4-5" : apiVendor === "openai" ? "gpt-4o" : "gemini-2.0-flash"}
        />
      </div>
      <div className="ais-api-field">
        <label>API Key</label>
        {config?.api.apiKey.set && !replaceKey ? (
          <div className="ais-api-saved-key">
            <span>已保存 ••••{config.api.apiKey.last4}</span>
            <button className="ais-btn" onClick={(e) => { e.preventDefault(); setReplaceKey(true); }}>更换</button>
          </div>
        ) : (
          <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="粘贴 API Key" />
        )}
      </div>
      <div className="ais-api-actions">
        <button className="ais-btn ais-primary-btn" onClick={(e) => { e.preventDefault(); handleSaveApi(); }} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        {saveSuccess && <span className="ais-status-ok">已保存</span>}
        {saveError && <span className="ais-status-err">{saveError}</span>}
      </div>
      <div className="ais-detail">
        Key 落盘时用本机指纹加密（<code>ai.json</code> 里存的是密文），不会明文躺在配置文件里；
        它挡的是备份、同步盘、误提交这类外泄，挡不住能在这台机器上跑代码的人。
      </div>
    </section>
  );

  const entry = openedEntry ? SETUP_ENTRIES.find((e) => e.id === openedEntry) : null;

  return createPortal(
    <div className="ais-backdrop" onClick={onClose}>
      <div className="ais-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
            <div className="ais-protocol-mode">
              <label>
                <input type="checkbox" checked={toolProtocol} onChange={(e) => handleSaveProtocol(e.target.checked)} />
                文本协议模式（CLI 原生工具被拒时用）
              </label>
            </div>
            <div className="ais-footer">
              <div className="ais-footer-actions">
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
              {diagReport && (
                <textarea
                  className="ais-share-blob"
                  readOnly
                  rows={6}
                  value={diagReport}
                  onFocus={(e) => e.currentTarget.select()}
                />
              )}
            </div>

            <div className="ais-footer">
              <div className="ais-footer-actions">
                <button className="ais-btn" onClick={copyDiagnostics} title="把本机环境、安装与登录状态复制成 JSON（不含密钥）">
                  Debugger
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
    </div>,
    document.body,
  );
}
