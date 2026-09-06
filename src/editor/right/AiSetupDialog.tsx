import type { JSX } from "react";
import { useEffect, useState } from "react";
import "./AiSetupDialog.css";
import type { ProviderInfo, AiProvider, SttInfo, PublicAiConfig, AiConfigPatch, ApiVendor } from "../../ai/types";

export function AiSetupDialog(props: {
  open: boolean; onClose: () => void;
  providers: ProviderInfo[];
  stt?: SttInfo;
  current: AiProvider | null; onChoose: (id: AiProvider) => void;
  onLogin: (id: AiProvider) => Promise<void>;
  loginState: Partial<Record<AiProvider, "idle" | "waiting" | "ok" | "timeout">>;
  config: PublicAiConfig | null; onSaveConfig: (partial: AiConfigPatch) => Promise<void>;
}): JSX.Element | null {
  const { open, onClose, providers, stt, current, onChoose, onLogin, loginState, config, onSaveConfig } = props;

  const [selected, setSelected] = useState<AiProvider | null>(current);
  const [apiVendor, setApiVendor] = useState<ApiVendor>("anthropic");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiModel, setApiModel] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelected(current);
      if (config) {
        setApiVendor(config.api.vendor);
        setApiBaseUrl(config.api.baseUrl);
        setApiModel(config.api.model);
        setReplaceKey(!config.api.apiKey.set);
        setApiKeyInput("");
        setSaveSuccess(false);
        setSaveError(null);
      }
    }
  }, [open, current, config]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleSaveApi = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    
    const patch: AiConfigPatch = {
      api: {
        vendor: apiVendor,
        baseUrl: apiBaseUrl,
        model: apiModel,
      }
    };
    if (replaceKey && apiKeyInput.trim()) {
      patch.api!.apiKey = apiKeyInput.trim();
    }

    try {
      await onSaveConfig(patch);
      setSaveSuccess(true);
      setApiKeyInput("");
      setReplaceKey(false);
    } catch (e: unknown) {
      if (e instanceof Error) {
        setSaveError(e.message || "保存失败");
      } else {
        setSaveError("保存失败");
      }
    } finally {
      setSaving(false);
    }
  };

  const currentProviderData = providers.find(p => p.id === selected);
  const isApi = selected === "api";
  
  let canUse = false;
  let useHint = "";
  if (!selected) {
    useHint = "先选一种";
  } else if (!isApi) {
    if (!currentProviderData?.available) {
      useHint = `${currentProviderData?.label || selected} 没装`;
    } else if (currentProviderData?.auth?.loggedIn === false) {
      useHint = `${currentProviderData?.label || selected} 还没登录`;
    } else {
      canUse = true;
    }
  } else {
    if (config?.api.apiKey.set !== true) {
      useHint = "先填并保存 API Key";
    } else {
      canUse = true;
    }
  }

  const renderCliRow = (p: ProviderInfo) => {
    const isChecked = selected === p.id;
    const st = loginState[p.id];
    
    return (
      <label key={p.id} className={`ais-row ${!p.available ? "disabled" : ""}`}>
        <input 
          type="radio" 
          name="ais-provider" 
          checked={isChecked}
          disabled={!p.available}
          onChange={() => setSelected(p.id)} 
        />
        <div className="ais-row-content">
          <div className="ais-row-header">
            <span className="ais-row-name">{p.label}</span>
            <span className="ais-row-version">
              {p.available ? `v${p.version || "未知"}` : "未安装"}
            </span>
          </div>
          {p.available && p.auth !== undefined && (
            <div className="ais-row-auth">
              {p.auth.loggedIn === true ? (
                <span className="ais-status-ok">已登录</span>
              ) : p.auth.loggedIn === false ? (
                <div className="ais-auth-action">
                  <span>未登录</span>
                  <button 
                    className="ais-btn"
                    disabled={st === "waiting"}
                    onClick={(e) => { e.preventDefault(); onLogin(p.id); }}
                  >
                    {st === "waiting" ? "等待登录…" : st === "ok" ? "已登录" : st === "timeout" ? "登录超时,重试" : "登录"}
                  </button>
                </div>
              ) : (
                <div className="ais-auth-hint">
                  <div className="ais-detail">{p.auth.detail}</div>
                  {p.auth.fixHint && <div className="ais-fixhint">{p.auth.fixHint}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </label>
    );
  };

  const cliProviders = providers.filter(p => p.id !== "api");

  return (
    <div className="ais-backdrop" onClick={onClose}>
      <div className="ais-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ais-title">选择 AI 助手的驱动方式</div>
        
        <div className="ais-providers">
          {cliProviders.map(renderCliRow)}
          
          <label className="ais-row ais-api-row">
            <input 
              type="radio" 
              name="ais-provider" 
              checked={selected === "api"}
              onChange={() => setSelected("api")} 
            />
            <div className="ais-row-content">
              <div className="ais-row-header">
                <span className="ais-row-name">API 直连</span>
              </div>
            </div>
          </label>
          
          {selected === "api" && (
            <div className="ais-api">
              <div className="ais-api-field">
                <select value={apiVendor} onChange={e => setApiVendor(e.target.value as ApiVendor)}>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI 兼容</option>
                  <option value="gemini">Gemini</option>
                </select>
              </div>
              <div className="ais-api-field">
                <input 
                  type="text" 
                  value={apiBaseUrl} 
                  onChange={e => setApiBaseUrl(e.target.value)} 
                  placeholder={apiVendor === "anthropic" ? "https://api.anthropic.com" : apiVendor === "openai" ? "https://api.openai.com" : "https://generativelanguage.googleapis.com"}
                />
              </div>
              <div className="ais-api-field">
                <input 
                  type="text" 
                  value={apiModel} 
                  onChange={e => setApiModel(e.target.value)} 
                  placeholder={apiVendor === "anthropic" ? "claude-sonnet-4-5" : apiVendor === "openai" ? "gpt-4o" : "gemini-2.0-flash"}
                />
              </div>
              <div className="ais-api-field">
                {config?.api.apiKey.set && !replaceKey ? (
                  <div className="ais-api-saved-key">
                    <span>已保存 ••••{config.api.apiKey.last4}</span>
                    <button className="ais-btn" onClick={(e) => { e.preventDefault(); setReplaceKey(true); }}>更换</button>
                  </div>
                ) : (
                  <input 
                    type="password" 
                    value={apiKeyInput} 
                    onChange={e => setApiKeyInput(e.target.value)} 
                    placeholder="粘贴 API Key"
                  />
                )}
              </div>
              <div className="ais-api-actions">
                <button className="ais-btn ais-primary-btn" onClick={(e) => { e.preventDefault(); handleSaveApi(); }} disabled={saving}>
                  {saving ? "保存中…" : "保存"}
                </button>
                {saveSuccess && <span className="ais-status-ok">已保存</span>}
                {saveError && <span className="ais-status-err">{saveError}</span>}
              </div>
            </div>
          )}
        </div>

        <div className="ais-footer">
          <div className="ais-footer-actions">
            <span className="ais-use-hint">{!canUse ? useHint : ""}</span>
            <button className="ais-btn" onClick={onClose}>以后再说</button>
            <button 
              className="ais-btn ais-primary-btn" 
              disabled={!canUse} 
              onClick={() => { if(selected) onChoose(selected); }}
            >
              使用所选方案
            </button>
          </div>
          {stt && (
            <div className="ais-stt-info">
              语音识别: {stt.engine} - {stt.available ? "可用" : `不可用 (${stt.hint})`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
