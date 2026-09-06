import { recordTrace } from './debug';
import { useState, useEffect, useRef, useCallback } from "react";
import type { AiProvider, ChatMessage, ChatAttachment, MessagePart, ProviderInfo, RunEvent, SttInfo, LoginState, PublicAiConfig, AiConfigPatch, CliSetupJob } from "./types";
import { parseSseChunks } from "./sse";
import { getScript } from "./script";
import { WORKFLOW_ROLES } from "./roles";
import { getState } from "../store/project";

/**
 * 把素材库里的素材整理成附件清单的形状,跟着每次发送一起带上。
 *
 * 用 path(服务端和外部命令行都能读的绝对磁盘路径)而不是 url ——
 * 导入的素材 url 是 blob: 开头的浏览器内部地址,对模型和工具都没有意义。
 * 还没上传完、拿不到 path 的先不列,免得给出一个用不了的地址。
 */
function mediaAsAttachments(): ChatAttachment[] {
  try {
    return getState().project.media
      .filter((m) => m.path)
      .map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        path: m.path,
        url: "",
        status: "ready" as const,
        durationSec: m.duration,
      })) as unknown as ChatAttachment[];
  } catch {
    return [];
  }
}

/** 往有序片段里追加文字(接在末尾的文字片段后面,不新开一段) */
function appendTextPart(parts: MessagePart[] | undefined, delta: string): MessagePart[] {
  const next = parts ? [...parts] : [];
  const last = next[next.length - 1];
  if (last && last.kind === "text") next[next.length - 1] = { kind: "text", text: last.text + delta };
  else next.push({ kind: "text", text: delta });
  return next;
}

/** 同上,但追加的是思考片段。思考和正文各自成段,不会互相吞并 */
function appendThinkingPart(parts: MessagePart[] | undefined, delta: string): MessagePart[] {
  const next = parts ? [...parts] : [];
  const last = next[next.length - 1];
  if (last && last.kind === "thinking") next[next.length - 1] = { kind: "thinking", text: last.text + delta };
  else next.push({ kind: "thinking", text: delta });
  return next;
}

/** 给最近一个同名、还没有结果的工具片段补上结果 */
function completeToolPart(
  parts: MessagePart[] | undefined,
  ev: { name: string; ok: boolean; summary?: string; files?: string[]; callId?: string; durationMs?: number },
): MessagePart[] {
  const next = parts ? [...parts] : [];
  for (let i = next.length - 1; i >= 0; i--) {
    const p = next[i];
    if (p.kind === "tool" && (ev.callId ? p.callId === ev.callId : p.name === ev.name) && p.ok === undefined) {
      next[i] = { ...p, ok: ev.ok, summary: ev.summary, files: ev.files, durationMs: ev.durationMs };
      return next;
    }
  }
  next.push({ kind: "tool", name: ev.name, ok: ev.ok, summary: ev.summary, files: ev.files });
  return next;
}

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
  const [setupJobs, setSetupJobs] = useState<CliSetupJob[]>([]);
  /** CLI 安装:idle | installing | ok | timeout | failed */
  const [installState, setInstallState] = useState<Partial<Record<AiProvider, "idle" | "installing" | "ok" | "timeout" | "failed">>>({});
  const [installError, setInstallError] = useState<Partial<Record<AiProvider, string>>>({});


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

  // A single non-overlapping poll follows all providers and survives dialog reopen.
  useEffect(() => {
    if (opts?.mock) return;
    let stopped = false;
    let timer: number;
    let lastFinished = '';
    const poll = async () => {
      try {
        const res = await fetch('/api/ai/setup', { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error('无法获取安装和登录进度');
        const data = await res.json();
        if (stopped) return;
        const jobs: CliSetupJob[] = data.jobs || [];
        setSetupJobs(jobs);
        for (const job of jobs) {
          if (job.kind === 'install') {
            setInstallState(prev => ({ ...prev, [job.provider]: job.state === 'running' ? 'installing' : job.state === 'succeeded' ? 'ok' : 'failed' }));
            setInstallError(prev => ({ ...prev, [job.provider]: job.state === 'failed' ? job.message : '' }));
          } else {
            setLoginState(prev => ({ ...prev, [job.provider]: job.state === 'running' ? 'waiting' : job.state === 'succeeded' ? 'ok' : 'failed' }));
          }
        }
        const finished = jobs.filter(j => j.state !== 'running').map(j => j.id + j.state).join(',');
        if (finished !== lastFinished) {
          const r = await fetch('/api/ai/providers?refresh=1', { signal: AbortSignal.timeout(30000) });
          if (r.ok) {
            const d = await r.json();
            if (!stopped) setProviders(d.providers || []);
            lastFinished = finished;
          }
        }
      } catch (e) {
        if (!stopped) setSetupJobs(prev => prev.map(j => j.state === 'running' ? { ...j, message: '连接中断，正在重新获取进度…' } : j));
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [opts?.mock]);

  const startSetup = useCallback(async (id: AiProvider, kind: 'install' | 'login', deviceAuth = false) => {
    if (kind === 'install') {
      setInstallState(prev => ({ ...prev, [id]: 'installing' }));
      setInstallError(prev => ({ ...prev, [id]: '' }));
    } else setLoginState(prev => ({ ...prev, [id]: 'waiting' }));
    try {
      const res = await fetch('/api/ai/' + kind, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: id, deviceAuth }), signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '请求失败');
      setSetupJobs(prev => [...prev.filter(j => j.provider !== id), data.job]);
    } catch (e) {
      const message = e instanceof Error ? e.message : '请求失败';
      if (kind === 'install') {
        setInstallState(prev => ({ ...prev, [id]: 'failed' }));
        setInstallError(prev => ({ ...prev, [id]: message }));
      } else {
        setLoginState(prev => ({ ...prev, [id]: 'failed' }));
        setSetupJobs(prev => [...prev.filter(j => j.provider !== id), { id: 'request-failed', provider: id, kind, state: 'failed', message, logs: [] }]);
        setError(message);
      }
    }
  }, []);
  const install = useCallback((id: AiProvider) => startSetup(id, 'install'), [startSetup]);
  const login = useCallback(async (id: AiProvider, deviceAuth = false) => {
    if (opts?.mock) {
      setLoginState(prev => ({ ...prev, [id]: 'ok' }));
      setProviders(prev => prev.map(p => p.id === id ? { ...p, auth: { ...p.auth, loggedIn: true } } : p));
      return;
    }
    await startSetup(id, 'login', deviceAuth);
  }, [opts?.mock, startSetup]);

  const cancelSetup = useCallback(async (id: AiProvider) => {
    try {
      const res = await fetch('/api/ai/setup', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id }), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('取消失败，请重试');
    } catch (e) { setError(e instanceof Error ? e.message : '取消失败'); }
  }, []);

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
      try { localStorage.setItem(`aiChat:${provider}`, JSON.stringify(toSave.slice(-50))); }
      catch { /* Full execution traces are also saved by useChatHistory. */ }
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
    setMessages(prev => prev.map(m => m.pending ? { ...m, pending: false, outcome: 'aborted', finishedAt: Date.now() } : m));
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
      parts: [],
      tools: [],
      statuses: [],
      pending: true,
      startedAt: Date.now(),
      trace: [],
    };

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setStreaming(true);
    setError(null);

    if (opts?.mock) {
      let i = 0;
      const msg = "这是内置假流回复内容。我将调用一个工具看看效果。";
      const timer = setInterval(() => {
        if (i < msg.length) {
          // 每帧写「到目前为止的整段文字」,不做增量拼接:
          // 第一次 tick 有可能赶在助手消息真正入列之前,那一次增量更新会静默丢掉,
          // 后面每个字就都错开一位(开头少一个字、结尾多一个 undefined)。
          i++;
          const soFar = msg.slice(0, i);
          setMessages(prev => prev.map(m => m.id === asstMsgId
            ? { ...m, text: soFar, parts: [{ kind: "text", text: soFar }] }
            : m));
        } else {
          clearInterval(timer);
          setMessages(prev => prev.map(m => m.id === asstMsgId ? {
            ...m,
            tools: [{ name: "get_editor_state", input: {} }],
            parts: [...(m.parts || []), { kind: "tool", name: "get_editor_state", input: {} }],
          } : m));
          setTimeout(() => {
            setMessages(prev => prev.map(m => {
              if (m.id !== asstMsgId) return m;
              const tools = [...(m.tools || [])];
              if (tools.length > 0) {
                tools[0].ok = true;
                tools[0].summary = "获取成功";
              }
              const parts = completeToolPart(m.parts, { name: "get_editor_state", ok: true, summary: "获取成功" });
              return { ...m, tools, parts };
            }));
            // 工具跑完之后再说一句:详细模式下应当出现「文字 → 工具 → 文字」的真实顺序
            // 这段同时充当渲染样张:表格、行内公式、独占一行的公式都在里面
            const tail = [
              "工具返回了,时间轴现在是空的。建议这样排:",
              "",
              "| 卡片 | 起 | 止 |",
              "| --- | ---: | ---: |",
              "| 金句卡 | 3.0 | 8.0 |",
              "| 数字滚动 | 8.0 | 10.5 |",
              "",
              "每张卡的时长 \\(d = t_1 - t_0\\),整段导出帧数:",
              "",
              "$$N = \\lceil (t_1 - t_0) \\times fps \\rceil$$",
            ].join("\n");
            setTimeout(() => {
              setMessages(prev => prev.map(m => m.id === asstMsgId
                ? { ...m, text: m.text + "\n" + tail, parts: appendTextPart(m.parts, "\n" + tail), pending: false }
                : m));
              setStreaming(false);
            }, 600);
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
          // 素材库里的东西一并列进附件清单:模型不用先花一轮 list_media 才知道
          // 手上有哪些素材,「给每个视频配字幕」这类要求也才有确定的对象。
          attachments: [...(attachments ?? []), ...mediaAsAttachments()],
          // 剧本每一轮都带上,由服务端拼进系统提示词 —— 多轮跑下来最容易跑偏,
          // 只在第一条消息里说一次是拉不住的。
          script: getScript(),
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
          setMessages(prev => prev.map(m => m.id === asstMsgId ? recordTrace(m, ev) : m));
          if (ev.type === "run" && ev.runId) {
            currentRunId.current = ev.runId;
          } else if (ev.type === "session" && ev.sessionId) {
            setSessionIds((prev) => ({ ...prev, [provider]: ev.sessionId! }));
            localStorage.setItem(`aiSession:${provider}`, ev.sessionId!);
          } else if (ev.type === "text" && ev.delta) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId
                  ? { ...m, text: m.text + ev.delta!, parts: appendTextPart(m.parts, ev.delta!) }
                  : m
              )
            );
          } else if (ev.type === "thinking" && ev.delta) {
            // 只进 parts,不进 m.text:m.text 是「回复正文」,会存进历史、也是简洁模式显示的内容
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, parts: appendThinkingPart(m.parts, ev.delta!) } : m
              )
            );
          } else if (ev.type === "tool_call" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                tools.push({ name: ev.name!, input: ev.input, callId: ev.callId, expanded: false });
                const parts: MessagePart[] = [
                  ...(m.parts || []),
                  { kind: "tool", name: ev.name!, input: ev.input, callId: ev.callId },
                ];
                return { ...m, tools, parts };
              })
            );
          } else if (ev.type === "tool_result" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                for (let i = tools.length - 1; i >= 0; i--) {
                  if ((ev.callId ? tools[i].callId === ev.callId : tools[i].name === ev.name) && tools[i].ok === undefined) {
                    tools[i].ok = ev.ok;
                    tools[i].summary = ev.summary;
                    tools[i].files = ev.files;
                    tools[i].durationMs = ev.durationMs;
                    break;
                  }
                }
                const parts = completeToolPart(m.parts, {
                  name: ev.name!,
                  ok: ev.ok,
                  summary: ev.summary,
                  files: ev.files,
                  callId: ev.callId,
                  durationMs: ev.durationMs,
                });
                return { ...m, tools, parts };
              })
            );
          } else if (ev.type === "progress") {
            setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, progress: { ...m.progress, ...ev } } : m));
          } else if (ev.type === "status" && ev.text) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const statuses = m.statuses ? [...m.statuses] : [];
                statuses.push(ev.text!);
                const parts: MessagePart[] = [...(m.parts || []), { kind: "status", text: ev.text! }];
                return { ...m, statuses, parts };
              })
            );
          } else if (ev.type === "error" && ev.message) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, error: ev.message, pending: false, finishedAt: Date.now(), outcome: "error" } : m
              )
            );
          } else if (ev.type === "done") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, pending: false, finishedAt: Date.now(), outcome: ev.outcome || m.outcome || "completed", usage: ev.usage } : m
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
              ? { ...m, error: "发生错误: " + e.message, pending: false, finishedAt: Date.now(), outcome: "error" }
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

  /**
   * 一键配特效:按顺序把 src/ai/roles/ 里的角色各跑一轮。
   *
   * 串行而不是拼成一段长提示词 —— 剪辑导演要先看齐全部素材才排得了片,
   * 特效助理要先有文字稿才配得了字幕和动效,合在一轮里模型会顾此失彼。
   * 每一轮都是完整的一次 send,所以中途出错或被用户停掉,后面的角色不会再跑。
   */
  const runWorkflow = useCallback(async () => {
    for (const role of WORKFLOW_ROLES) {
      await send(role.prompt);
      // 用户按了停止就别继续下一个角色了
      if (abortControllerRef.current?.signal.aborted) break;
    }
  }, [provider, sessionIds]);

  return {
    messages,
    providers,
    sttInfo,
    provider,
    setProvider: handleProviderChange,
    sessionIds,
    runWorkflow,
    workflowRoles: WORKFLOW_ROLES,
    streaming,
    send,
    abort,
    newChat,
    error,
    setMessages,
    login,
    loginState,
    setupJobs,
    cancelSetup,
    install,
    installState,
    installError,
    config,
    saveConfig,
    setupOpen,
    openSetup,
    closeSetup
  };
}
