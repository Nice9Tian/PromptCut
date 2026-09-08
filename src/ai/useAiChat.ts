import { recordTrace } from './debug';
import { useState, useEffect, useRef, useCallback } from "react";
import type { AiProvider, ChatMessage, ChatAttachment, MessagePart, MessageRuntime, ProviderInfo, RunEvent, SttInfo, LoginState, PublicAiConfig, AiConfigPatch, CliSetupJob, KeyKind } from "./types";
import { parseSseChunks } from "./sse";
import { readChoice, compatToSend, normalizeModel, modelsFor, pairModelEffort } from "./modelOptions";
import { getScript } from "./script";
import { useChatMessages, getChatStore, MAIN_TAB } from "./liveChat";
import * as agentBus from "./agentBus";
import { WORKFLOW_ROLES, ALL_ROLES } from "./roles";
import { isTeamMode } from "./teamMode";
import { shouldOrchestrate } from "./triage";
import { buildPlan, runOrchestration, type OrchestrationState } from "./orchestrate";
import { runRoleTask } from "./runRoleTask";
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

export function useAiChat(opts?: { mock?: boolean; tabId?: string; getConversationId?: () => string | undefined }) {
  // 对话归项目所有(要随 .proc 存取、随项目切换),所以放在组件外的 store 里。
  // 多 Agent 分页:每页一份 store,主页(MAIN_TAB)那份才随 .proc 存取
  const tabId = opts?.tabId ?? MAIN_TAB;
  const store = getChatStore(tabId);
  const setMessages = store.set;
  const messages = useChatMessages(store);
  // CLI 驱动的会话 id 也按页分开:两页共用一个 sessionId 等于两个 Agent 接着同一段对话说
  const sessKey = (p: string) => (tabId === MAIN_TAB ? `aiSession:${p}` : `aiSession:${p}:${tabId}`);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sttInfo, setSttInfo] = useState<SttInfo | null>(null);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [sessionIds, setSessionIds] = useState<Partial<Record<AiProvider, string>>>({});
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setupOpen, setSetupOpen] = useState(false);
  const [loginState, setLoginState] = useState<Partial<Record<AiProvider, LoginState>>>({});
  const [config, setConfig] = useState<PublicAiConfig | null>(null);

  /** 分工模式这一轮的编排状态。界面(OrchestrationBlock)直接读它。 */
  const [orchestration, setOrchestration] = useState<OrchestrationState | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // 这一页被关掉(多 Agent 分页关页)时把还在跑的请求掐掉:连接一断服务端就会 abort 那一轮
  useEffect(() => () => { abortControllerRef.current?.abort(); }, []);
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
      setConfig({ version: 1, defaultProvider: null, toolProtocol: true, api: { vendor: "anthropic", baseUrl: "", model: "gpt-4o|gpt-4o-mini", maxTokens: 4096, apiKey: { set: false, last4: "" }, source: "" }, keys: { custom: { set: false, last4: "" }, router: { set: false, last4: "" } }, cliModels: { claude: "opus|sonnet|haiku", codex: "gpt-5.6-terra|gpt-5.6-sol", agy: "gemini-3.8-flash-high|gemini-3.8-flash-medium|gemini-3.8-flash-low|gemini-3.1-pro-high|gemini-3.1-pro-low|claude-sonnet-4-6" } });
      setProvider("claude");
      // ?nosetup=1 给自动化脚本用:不弹首启设置对话框
      if (tabId === MAIN_TAB && localStorage.getItem("aiSetupDone") === null && !new URLSearchParams(location.search).has("nosetup")) {
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
      if (tabId === MAIN_TAB && localStorage.getItem("aiSetupDone") === null && !new URLSearchParams(location.search).has("nosetup")) {
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
        // 假流也要照着真接口合并:漏掉哪个字段,界面上对应的开关就会在保存后
        // 弹回原值,看着像 bug 其实是假流没跟上(toolProtocol 就这么坑过一次)
        return {
          ...prev,
          defaultProvider: patch.defaultProvider !== undefined ? patch.defaultProvider : prev.defaultProvider,
          toolProtocol: patch.toolProtocol !== undefined ? patch.toolProtocol : prev.toolProtocol,
          cliModels: patch.cliModels ? { ...prev.cliModels, ...patch.cliModels } : prev.cliModels,
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

  /** 「清理密钥」:删掉那一路的密钥文件,拿回最新配置 */
  const clearKey = useCallback(async (kind: KeyKind) => {
    if (opts?.mock) {
      setConfig(prev => {
        if (!prev) return prev;
        const keys = { ...prev.keys, [kind]: { set: false, last4: "" } };
        const active = prev.api.source === kind;
        return { ...prev, keys, api: active ? { ...prev.api, apiKey: { set: false, last4: "" }, source: "" } : prev.api };
      });
      return;
    }
    const res = await fetch("/api/ai/config/clear-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "清理密钥失败");
    setConfig(data.config);
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
    // 换模型不动对话:对话属于这个项目,换个模型接着聊是合理的
    const sess = localStorage.getItem(sessKey(provider));
    if (sess) {
      setSessionIds((prev) => ({ ...prev, [provider]: sess }));
    }
  }, [provider]);

  const handleProviderChange = (newP: AiProvider) => {
    setProvider(newP);
    localStorage.setItem("aiProvider", newP);
  };

  const newChat = () => {
    if (!provider) return;
    localStorage.removeItem(sessKey(provider));
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

  /**
   * 分工模式：主管拆活 → 划依赖 → 按 DAG 并行派给各角色。
   *
   * 走到这里之前已经过了两道筛（teamMode 开着、shouldOrchestrate 说值得），
   * 所以这里不再判断划不划算。任何一步出错都**退回普通提问**而不是报错终止——
   * 编排只是加速手段，它失灵不该让用户连话都问不了。
   */
  const runTeamMode = async (text: string): Promise<boolean> => {
    const manager = ALL_ROLES.find((r) => r.id === "manager");
    if (!manager || !provider) return false;

    const ac = new AbortController();
    abortControllerRef.current = ac;
    setStreaming(true);
    setOrchestration({
      phase: "planning", query: text, plan: "", dag: "", tasks: [], waves: [],
    });

    try {
      // 用户那句原话在 send() 里已经先进了消息流(编排块就画在它下面),这里不再追加
      const plan = await buildPlan(text, { managerPrompt: manager.prompt, provider });

      await runOrchestration(
        plan,
        text,
        async (task, prompt, override) => {
          // 角色可以被派到别家驱动上跑,记录要跟着**实际用的那家**走,
          // 不是面板上选中的那家 —— 否则报告里整段对话看着都是同一个模型。
          const runProvider = override ?? provider;
          // override 来自角色卡,类型上是任意字符串。记录里只认已知的那几家,认不出就
          // 退回面板上选中的这家 —— 报告里宁可写得保守,也别塞一个野值进去。
          const recorded = (["claude", "agy", "codex", "api"] as const).find((p) => p === runProvider) ?? provider;
          const runtime: MessageRuntime = {
            provider: recorded, ...readChoice(recorded), toolProtocol: !!config?.toolProtocol,
          };
          return runRoleTask({
            provider: runProvider,
            prompt,
            // 分工出去的角色也算这一页的:不带的话它调 declare_scope 会被服务端拒(实测报告里就是这么失败的)
            conversationId: opts?.getConversationId?.(),
            roleId: task.roleId,
            signal: ac.signal,
            hooks: {
              createMessage: (roleId) => {
                const id = `${Date.now()}-${task.id}`;
                setMessages((prev) => [...prev, {
                  id, role: "assistant", roleId, text: "",
                  parts: [], tools: [], statuses: [], pending: true, startedAt: Date.now(), runtime,
                }]);
                return id;
              },
              updateMessage: (id, patch) =>
                setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m))),
            },
          });
        },
        setOrchestration,
        ac.signal,
      );
      return true;
    } catch (e) {
      // 编排本身失败（多半是没配 API 直连）：把原因显示出来，然后照常问一遍
      setOrchestration((s) =>
        s ? { ...s, phase: "error", error: e instanceof Error ? e.message : String(e) } : s);
      return false;
    } finally {
      setStreaming(false);
      if (abortControllerRef.current === ac) abortControllerRef.current = null;
    }
  };

  const send = async (text: string, attachments?: ChatAttachment[]) => {
    if (!provider) return;

    abort();

    // 用户那句话**发送的这一瞬间**就进消息流。以前分工模式下要等入口闸(可能打一次模型)
    // 和主管三步拆解全回来才追加,那几秒到几十秒里界面纹丝不动,用户以为没发出去。
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      text,
      attachments,
    };
    setMessages((prev) => [...prev, userMsg]);

    // 分工模式：先过便宜的闸，值得才编排；编排失败就落回下面的普通流程。
    // 闸还在判的时候编排块就先挂上「正在拆解」—— 它画在最后一条用户消息下面,
    // 用户能看见有东西在转;判定不值得编排就把块撤掉,走普通问答。
    if (isTeamMode() && !attachments?.length) {
      setOrchestration({ phase: "planning", query: text, plan: "", dag: "", tasks: [], waves: [] });
      const verdict = await shouldOrchestrate(text);
      if (verdict.parallel && (await runTeamMode(text))) return;
      if (!verdict.parallel) setOrchestration(null);
    }

    // 发送这一刻就把「这条用什么跑」定下来,而且**发出去的和记下来的是同一份**。
    // 分开各读一次的话,用户在流式过程中换了模型,记录就会和实际跑的对不上。
    const choice = readChoice(provider);
    /*
     * 模型名在这里再过一道清单。面板上早就这么做了(normalizeModel),但那只管下拉框
     * 显示成什么;发请求一直用的是 localStorage 里的原值。于是一个已经不在清单里的
     * 名字——设置改过、或者当初就手打错了一个字符——界面上显示「默认」,请求里却
     * 照旧带着它。CLI 拿到不存在的模型名当场退出,用户什么提示都看不到。
     * 显示和实际跑的必须是同一个值。
     */
    choice.model = normalizeModel(choice.model, modelsFor(provider, config));
    /*
     * agy 的模型名和思考档必须配对(gemini-3.8-flash-low 配 --effort high 会被它当场拒),
     * 而且每个模型自己有哪几档不一样。面板上是「基名 + 档位」两个框,发出去之前在这里
     * 拼成 agy 认的那一对;别的驱动原样返回。
     */
    {
      const pair = pairModelEffort(provider, choice.model, choice.effort, config);
      choice.model = pair.model;
      choice.effort = pair.effort;
    }
    // 参数兼容模式:锁死的驱动 / 模型不听本地偏好,按策略定论;可调的把偏好交给服务端
    choice.schemaCompat = compatToSend(provider, choice.model, config?.api?.vendor, choice.schemaCompat);
    const runtime: MessageRuntime = { provider, ...choice, toolProtocol: !!config?.toolProtocol };

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
      runtime,
      trace: [],
    };

    // 用户消息上面已经进去了,这里只追加助手那条
    setMessages((prev) => [...prev, asstMsg]);
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
      // 多 Agent:这一页的对话 ID 随请求带上,服务端把它塞给 MCP 进程,工具调用就知道是谁发的;
      // 其他 Agent 的动态(范围变动、给它的消息)拼在提示词前面 —— 只进模型,不进屏幕上那条用户消息
      const agentId = opts?.getConversationId?.();
      const notes = agentId ? agentBus.consumeNotes(agentId) : "";
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          prompt: notes ? `${notes}\n\n${text}` : text,
          conversationId: agentId,
          sessionId,
          // 模型 / 推理强度 / 加速档:上面发送那一刻已经读好(choice),用户在面板上
          // 换完下一条立刻生效。哪家支持哪几样由 runner 端翻译,这里只管把选择传过去。
          ...choice,
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
            localStorage.setItem(sessKey(provider), ev.sessionId!);
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
    orchestration,
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
    clearKey,
    setupOpen,
    openSetup,
    closeSetup
  };
}
