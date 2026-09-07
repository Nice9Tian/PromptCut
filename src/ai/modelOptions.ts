import type { AiProvider } from "./types";

/**
 * 每家驱动到底支持哪几样,以及当前这次运行选了什么。
 *
 * 能力表不是拍脑袋写的,是在本机逐个问过 CLI 的 --help 得来的:
 *   claude  --model / --effort low|medium|high|xhigh|max / fastMode(经 --settings 传)
 *   codex   -m --model / 推理档只能走 -c model_reasoning_effort= / 没有加速档
 *   agy     --model / --effort low|medium|high / 没有加速档
 * 不支持的就在界面上灰掉,不做假开关 —— 点了没反应比没有这个开关更糟。
 */

/** 推理强度。空字符串 = 跟随各家自己的默认,不传标志 */
export type EffortLevel = "" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderCapability {
  /** 支持哪几档推理强度;空数组 = 这家不支持,界面上灰掉 */
  efforts: EffortLevel[];
  /** 支不支持「加速」。只有 Claude Code 有(settings 里的 fastMode) */
  fast: boolean;
  /** 没配模型清单时的兜底建议,用户可以在 AI 设置里改 */
  suggestedModels: string;
  /** 这家的模型清单从哪来 */
  modelsHint: string;
}

export const CAPABILITIES: Record<AiProvider, ProviderCapability> = {
  claude: {
    efforts: ["", "low", "medium", "high", "xhigh", "max"],
    fast: true,
    suggestedModels: "opus|sonnet|haiku",
    modelsHint: "填别名就行（opus / sonnet / haiku），也可以填完整模型名",
  },
  codex: {
    // codex 没有 --effort,只能用 -c model_reasoning_effort= 覆盖配置项
    efforts: ["", "minimal", "low", "medium", "high", "xhigh"],
    fast: false,
    suggestedModels: "",
    modelsHint: "填 codex 支持的模型名，多个用 | 分开",
  },
  agy: {
    efforts: ["", "low", "medium", "high"],
    fast: false,
    suggestedModels: "",
    modelsHint: "可以点「从 CLI 读取」直接拉 agy models 的清单",
  },
  api: {
    // 推理强度是各家 API 自己的参数,harness 现在没接,先不给假选项
    efforts: [],
    fast: false,
    suggestedModels: "",
    modelsHint: "多个模型用 | 分开，面板上就能切",
  },
};

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  "": "默认",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

/** `a|b|c` → ["a","b","c"]。空段和首尾空格都去掉,允许用户随手写成 `a | b` */
export function parseModelList(raw: string | undefined | null): string[] {
  return String(raw ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ── 这一次运行选了什么 ──────────────────────────────────
 * 存 localStorage 而不是 ai.json:这是「这台机器上我现在想用哪个」,
 * 换个模型不该算改配置,也不该跟着项目文件走。按 provider 分开记,
 * 从 Claude 切到 Codex 不会把模型名带过去(那个名字在对面根本不存在)。
 */

const KEY = (kind: string, provider: AiProvider) => `pc.ai.${kind}.${provider}`;

function read(kind: string, provider: AiProvider): string {
  try {
    return localStorage.getItem(KEY(kind, provider)) ?? "";
  } catch {
    return "";
  }
}

function write(kind: string, provider: AiProvider, value: string): void {
  try {
    if (value) localStorage.setItem(KEY(kind, provider), value);
    else localStorage.removeItem(KEY(kind, provider));
  } catch {
    /* 无痕模式记不住就算了,本次会话内仍然生效 */
  }
}

export interface RunChoice {
  /** 空 = 用该驱动自己的默认模型 */
  model: string;
  effort: EffortLevel;
  fast: boolean;
}

export function readChoice(provider: AiProvider): RunChoice {
  return {
    model: read("model", provider),
    effort: read("effort", provider) as EffortLevel,
    fast: read("fast", provider) === "1",
  };
}

export function writeChoice(provider: AiProvider, patch: Partial<RunChoice>): void {
  if (patch.model !== undefined) write("model", provider, patch.model);
  if (patch.effort !== undefined) write("effort", provider, patch.effort);
  if (patch.fast !== undefined) write("fast", provider, patch.fast ? "1" : "");
}

/**
 * 选中的模型不在清单里就退回「默认」。
 * 用户在设置里把某个模型删掉之后,面板不该继续拿一个已经没有的名字去跑。
 */
export function normalizeModel(model: string, available: string[]): string {
  return model && available.includes(model) ? model : "";
}
