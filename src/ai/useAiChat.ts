import { useState, useEffect, useRef, useCallback } from "react";
import type { AiProvider, ChatMessage, ChatAttachment, ProviderInfo, RunEvent, SttInfo, LoginState, PublicAiConfig, AiConfigPatch } from "./types";
import { parseSseChunks } from "./sse";

export function useAiChat(opts?: { mock?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sttInfo, setSttInfo] = useState<SttInfo | null>(null);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [sessionIds, setSessionIds] = useState<Partial<Record<AiProvider, string>>>({});
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setupOpen, setSetupOpen] = useState(false);
  const [loginState, setLoginState] = useState<Partial<Record<AiProvider, LoginState>>>({});
  const [config, setConfig] = useState<PublicAiConfig | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRunId = useRef<string | null>(null);
  const setupGateRef = useRef(false);
  const loginTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (opts?.mock) {
      setProviders([
        { id: "claude", label: "Claude Code", available: true, version: "2.1.221", auth: { loggedIn: false, loginCommand: ["claude", "auth", "login"] } },
        { id: "codex", label: "Codex", available: true, version: "0.136.0", auth: { loggedIn: null, detail: "unknown variant ultra, expected one of none|minimal|low|medium|high|xhigh", fixHint: "codex 配置文件 ~/.codex/config.toml 第 5 行的 model_reasoning_effort 值本版 codex 不认,改成 high 或 xhigh 后再试", loginCommand: ["codex", "login"] } },
        { id: "agy", label: "Antigravity", available: true, version: "1.1.27", auth: { loggedIn: true } },
        { id: "api", label: "API 直连", available: false, note: "还没填 API Key", auth: { loggedIn: false, detail: "还没填 API Key" } }
      ]);
      setConfig({ version: 1, defaultProvider: null, toolProtocol: true, api: { vendor: "anthropic", baseUrl: "", model: "", maxTokens: 4096, apiKey: { set: false, last4: "" } } });
      setProvider("claude");
      // ?nosetup=1 给自动化脚本用:不弹首启设置对话框
      if (localStorage.getItem("aiSetupDone") === null && !new URLSearchParams(location.search).has("nosetup")) {
        setSetupOpen(true);
      }
      return;
    }

    fetch("/api/ai/config")
      .then((res) => res.json())
      // 桥统一用 { ok, config } 信封(和其他接口一致);兼容裸 publicConfig
      .then((data) => setConfig(data?.config ?? data))
      .catch(() => {});

    fetch("/api/ai/providers")
      .then((res) => res.json())
      .then((data: any) => {
        let list: ProviderInfo[] = [];
        let stt: SttInfo | null = null;
        if (Array.isArray(data)) {
          list = data;
        } else if (data && typeof data === "object") {
          list = data.providers || [];
          stt = data.stt || null;
        }
        setProviders(list);
        setSttInfo(stt);

        const stored = localStorage.getItem("aiProvider") as AiProvider;
        if (stored && list.some((p) => p.id === stored && p.available)) {
          setProvider(stored);
        } else {
          const firstAvailable = list.find((p) => p.available);
          if (firstAvailable) {
            setProvider(firstAvailable.id);
            localStorage.setItem("aiProvider", firstAvailable.id);
          }
        }
      })
      .catch((e: unknown) => {
        if (e instanceof Error) {
          setError("获取 AI 供应商失败：" + e.message);
        } else {
          setError("获取 AI 供应商失败");
        }
      });
  }, [opts?.mock]);

  useEffect(() => {
    if (providers.length > 0 && !setupGateRef.current && !opts?.mock) {
      setupGateRef.current = true;
      // ?nosetup=1 给自动化脚本用:不弹首启设置对话框
      if (localStorage.getItem("aiSetupDone") === null && !new URLSearchParams(location.search).has("nosetup")) {
        setSetupOpen(true);
      }
    }
  }, [providers, opts?.mock]);

  useEffect(() => {
    return () => {
      if (loginTimerRef.current !== null) {
        window.clearInterval(loginTimerRef.current);
      }
    };
  }, []);

  const login = useCallback(async (id: AiProvider) => {
    if (loginTimerRef.current !== null) {
      window.clearInterval(loginTimerRef.current);
      loginTimerRef.current = null;
    }

    setLoginState(prev => ({ ...prev, [id]: "waiting" }));

    if (opts?.mock) {
      setTimeout(() => {
        setLoginState(prev => ({ ...prev, [id]: "ok" }));
        setProviders(prev => prev.map(p => p.id === id ? { ...p, auth: { ...p.auth, loggedIn: true } } : p));
      }, 1500);
      return;
    }

    try {
      const res = await fetch("/api/ai/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: id }),
      });
      if (!res.ok) throw new Error("login failed");
      
      const startTime = Date.now();
      loginTimerRef.current = window.setInterval(async () => {
        if (Date.now() - startTime > 180000) {
          if (loginTimerRef.current !== null) window.clearInterval(loginTimerRef.current);
          setLoginState(prev => ({ ...prev, [id]: "timeout" }));
          return;
        }
        try {
          const r = await fetch("/api/ai/providers?refresh=1");
          if (!r.ok) return;
          const data = await r.json();
          let list: ProviderInfo[] = Array.isArray(data) ? data : (data.providers || []);
          setProviders(list);
          const p = list.find(x => x.id === id);
          if (p && p.auth?.loggedIn === true) {
            if (loginTimerRef.current !== null) window.clearInterval(loginTimerRef.current);
            setLoginState(prev => ({ ...prev, [id]: "ok" }));
          }
        } catch {
          // ignore error in polling
        }
      }, 3000);
    } catch {
      setLoginState(prev => ({ ...prev, [id]: "timeout" }));
      setError("登录请求失败");
    }
  }, [opts?.mock]);

  const saveConfig = useCallback(async (patch: AiConfigPatch) => {
    if (opts?.mock) {
      setConfig(prev => {
        if (!prev) return prev;
        const newApi = { ...prev.api, ...patch.api } as any;
        if (patch.api?.apiKey !== undefined) {
          if (typeof patch.api.apiKey === "string" && patch.api.apiKey.length > 0) {
            newApi.apiKey = { set: true, last4: patch.api.apiKey.slice(-4) };
          } else if (patch.api.apiKey === null) {
            newApi.apiKey = { set: false, last4: "" };
          }
        }
        return {
          ...prev,
          defaultProvider: patch.defaultProvider !== undefined ? patch.defaultProvider : prev.defaultProvider,
          api: newApi
        };
      });
      return;
    }

    try {
      const res = await fetch("/api/ai/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("save config failed");
      const data = await res.json();
      setConfig(data?.config ?? data);
    } catch (e) {
      setError("保存配置失败");
      throw e;
    }
  }, [opts?.mock]);

  const openSetup = useCallback(() => setSetupOpen(true), []);

  const closeSetup = useCallback((chosen?: AiProvider) => {
    setSetupOpen(false);
    localStorage.setItem("aiSetupDone", "1");
    if (chosen) {
      localStorage.setItem("aiProvider", chosen);
      setProvider(chosen);
      saveConfig({ defaultProvider: chosen }).catch(() => {});
    }
  }, [saveConfig]);

  useEffect(() => {
    if (!provider) return;
    const history = localStorage.getItem(`aiChat:${provider}`);
    if (history) {
      try {
        const parsed = JSON.parse(history);
        setMessages(parsed.slice(-50));
      } catch {
        setMessages([]);
      }
    } else {
      setMessages([]);
    }
    const sess = localStorage.getItem(`aiSession:${provider}`);
    if (sess) {
      setSessionIds((prev) => ({ ...prev, [provider]: sess }));
    }
  }, [provider]);

  useEffect(() => {
    if (provider && messages.length > 0) {
      const toSave = messages.filter(m => !m.pending);
      localStorage.setItem(`aiChat:${provider}`, JSON.stringify(toSave.slice(-50)));
    }
  }, [messages, provider]);

  const handleProviderChange = (newP: AiProvider) => {
    setProvider(newP);
    localStorage.setItem("aiProvider", newP);
  };

  const newChat = () => {
    if (!provider) return;
    localStorage.removeItem(`aiChat:${provider}`);
    localStorage.removeItem(`aiSession:${provider}`);
    setMessages([]);
    setSessionIds((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  };

  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (currentRunId.current && !opts?.mock) {
      fetch("/api/ai/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: currentRunId.current }),
      }).catch(() => {});
      currentRunId.current = null;
    }
    setStreaming(false);
  }, [opts?.mock]);

  const send = async (text: string, attachments?: ChatAttachment[]) => {
    if (!provider) return;
    
    abort(); 

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      text,
      attachments,
    };

    const asstMsgId = (Date.now() + 1).toString();
    const asstMsg: ChatMessage = {
      id: asstMsgId,
      role: "assistant",
      text: "",
      tools: [],
      statuses: [],
      pending: true,
    };

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setStreaming(true);
    setError(null);

    if (opts?.mock) {
      let i = 0;
      const msg = "这是内置假流回复内容。我将调用一个工具看看效果。";
      const timer = setInterval(() => {
        if (i < msg.length) {
          setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, text: m.text + msg[i] } : m));
          i++;
        } else {
          clearInterval(timer);
          setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, tools: [{ name: "get_editor_state", input: {} }] } : m));
          setTimeout(() => {
            setMessages(prev => prev.map(m => {
              if (m.id !== asstMsgId) return m;
              const tools = [...(m.tools || [])];
              if (tools.length > 0) {
                tools[0].ok = true;
                tools[0].summary = "获取成功";
              }
              return { ...m, tools, pending: false };
            }));
            setStreaming(false);
          }, 1000);
        }
      }, 50);
      return;
    }

    const ac = new AbortController();
    abortControllerRef.current = ac;

    try {
      const sessionId = sessionIds[provider];
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          prompt: text,
          sessionId,
          attachments,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunks(buffer, chunk);
        buffer = rest;

        for (const ev of events as RunEvent[]) {
          if (ev.type === "run" && ev.runId) {
            currentRunId.current = ev.runId;
          } else if (ev.type === "session" && ev.sessionId) {
            setSessionIds((prev) => ({ ...prev, [provider]: ev.sessionId! }));
            localStorage.setItem(`aiSession:${provider}`, ev.sessionId!);
          } else if (ev.type === "text" && ev.delta) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, text: m.text + ev.delta! } : m
              )
            );
          } else if (ev.type === "tool_call" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                tools.push({ name: ev.name!, input: ev.input, expanded: false });
                return { ...m, tools };
              })
            );
          } else if (ev.type === "tool_result" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i].name === ev.name && tools[i].ok === undefined) {
                    tools[i].ok = ev.ok;
                    tools[i].summary = ev.summary;
                    tools[i].files = ev.files;
                    break;
                  }
                }
                return { ...m, tools };
              })
            );
          } else if (ev.type === "status" && ev.text) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const statuses = m.statuses ? [...m.statuses] : [];
                statuses.push(ev.text!);
                return { ...m, statuses };
              })
            );
          } else if (ev.type === "error" && ev.message) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, error: ev.message, pending: false } : m
              )
            );
          } else if (ev.type === "done") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, pending: false } : m
              )
            );
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstMsgId ? { ...m, pending: false } : m
        )
      );

    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstMsgId
              ? { ...m, error: "发生错误: " + e.message, pending: false }
              : m
          )
        );
      }
    } finally {
      if (abortControllerRef.current === ac) {
        abortControllerRef.current = null;
        currentRunId.current = null;
        setStreaming(false);
      }
    }
  };

  return {
    messages,
    providers,
    sttInfo,
    provider,
    setProvider: handleProviderChange,
    sessionIds,
    streaming,
    send,
    abort,
    newChat,
    error,
    setMessages,
    login,
    loginState,
    config,
    saveConfig,
    setupOpen,
    openSetup,
    closeSetup
  };
}
