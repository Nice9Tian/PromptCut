import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { AiProvider, PublicAiConfig } from "../../ai/types";
import {
  CAPABILITIES,
  EFFORT_LABEL,
  modelsFor,
  readChoice,
  writeChoice,
  normalizeModel,
  compatPolicy,
  type EffortLevel,
  type SchemaCompat,
} from "../../ai/modelOptions";
import "./ModelBar.css";

/**
 * 输入框旁边的一条:模型 / 推理强度 / 加速。
 *
 * 三样都是「这一次要怎么跑」,所以贴着输入框放,不进 AI 设置 —— 设置里管的是
 * 「有哪些可选」,这里管的是「现在用哪个」。选择按 provider 分开记在本地,
 * 从 Claude 切到 Codex 不会把对面不存在的模型名带过去。
 *
 * 某一家不支持的就灰掉并说明原因,不做点了没反应的假开关:
 * 加速只有 Claude Code 有(设置项 fastMode),推理强度 API 直连还没接。
 */
export function ModelBar(props: {
  provider: AiProvider | null;
  config: PublicAiConfig | null;
  disabled?: boolean;
}): JSX.Element | null {
  const { provider, config, disabled } = props;
  const [choice, setChoice] = useState(() => ({ model: "", effort: "" as EffortLevel, fast: false, deepAuto: false, schemaCompat: "auto" as SchemaCompat }));

  // 换 provider 就把那一家自己的选择读出来
  useEffect(() => {
    if (provider) setChoice(readChoice(provider));
  }, [provider]);

  if (!provider) return null;
  const cap = CAPABILITIES[provider];

  // 和 useAiChat 发请求时用的是同一个函数 —— 下拉框显示什么,请求里就得是什么
  const models = modelsFor(provider, config);

  // 设置里把某个模型删掉之后,别再拿一个已经不存在的名字去跑
  const model = normalizeModel(choice.model, models);

  const update = (patch: Partial<typeof choice>) => {
    writeChoice(provider, patch);
    setChoice((prev) => ({ ...prev, ...patch }));
  };

  // 参数兼容:Claude / GPT 锁关、Gemini 锁开,别家让用户点
  const compat = compatPolicy(provider, model, config?.api?.vendor, choice.schemaCompat);
  const compatHint = compat.locked
    ? compat.reason
    : `参数兼容模式(${compat.on ? "开" : "关"}):把工具参数的 schema 按 Gemini 那套最窄子集清洗。${compat.reason}`;

  /*
   * 深度自主:轮次上限换成设置里的「自主轮次」(默认 300,填 0 就是不限),
   * 并且不再往模型手里塞任何关于轮次的话。
   *
   * 每家驱动都支持 —— 这道闸是 PromptCut 自己的循环在管的,不是各家 CLI 的能力,
   * 所以不进 CAPABILITIES,也不会因为换了驱动就灰掉。
   */
  const rounds = config?.deepAutoRounds;
  const deepHint = choice.deepAuto
    ? (rounds === 0
        ? "深度自主：不限轮次，会一直跑到它自己认为做完或你点停止。想改成有限轮次去「AI 设置 → 更多 → 自主轮次」"
        : `深度自主：轮次上限放宽到 ${rounds ?? 300} 轮，且不给模型任何轮次提示。在「AI 设置 → 更多 → 自主轮次」里改`)
    : `深度自主：把轮次上限放宽到 ${rounds === 0 ? "不限" : `${rounds ?? 300} 轮`}，并且不给模型任何轮次提示。常规上限是用来拦住跑偏的运行的，长任务再开`;

  const fastHint = cap.fast
    ? "加速：出字更快，不换模型"
    : provider === "codex" ? "Codex 没有加速档"
      : provider === "agy" ? "Antigravity 没有加速档"
      : "API 直连没有加速档";

  return (
    <div className="ai-modelbar">
      <label className="ai-modelbar-item">
        <span className="ai-modelbar-label">模型</span>
        <select
          className="ai-modelbar-select"
          value={model}
          disabled={disabled || models.length === 0}
          title={models.length === 0 ? `还没配可选模型：${cap.modelsHint}` : "这次用哪个模型"}
          onChange={(e) => update({ model: e.target.value })}
        >
          <option value="">默认</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </label>

      <label className="ai-modelbar-item">
        <span className="ai-modelbar-label">思考</span>
        <select
          className="ai-modelbar-select"
          value={choice.effort}
          disabled={disabled || cap.efforts.length === 0}
          title={cap.efforts.length === 0 ? "API 直连这边还没接推理强度" : "推理强度：越高想得越久"}
          onChange={(e) => update({ effort: e.target.value as EffortLevel })}
        >
          {cap.efforts.length === 0
            ? <option value="">不支持</option>
            : cap.efforts.map((lv) => (
                <option key={lv} value={lv}>{EFFORT_LABEL[lv]}</option>
              ))}
        </select>
      </label>

      <button
        type="button"
        className={`ai-modelbar-fast${choice.fast && cap.fast ? " is-on" : ""}`}
        disabled={disabled || !cap.fast}
        title={fastHint}
        aria-pressed={cap.fast && choice.fast}
        onClick={() => update({ fast: !choice.fast })}
      >
        Fast
      </button>

      <button
        type="button"
        data-pc="deep-auto"
        className={`ai-modelbar-fast${choice.deepAuto ? " is-on" : ""}`}
        disabled={disabled}
        title={deepHint}
        aria-pressed={choice.deepAuto}
        onClick={() => update({ deepAuto: !choice.deepAuto })}
      >
        深度自主
      </button>

      <button
        type="button"
        data-pc="schema-compat"
        className={`ai-modelbar-fast${compat.on ? " is-on" : ""}`}
        disabled={disabled || compat.locked}
        title={compatHint}
        aria-pressed={compat.on}
        onClick={() => update({ schemaCompat: compat.on ? "off" : "on" })}
      >
        参数兼容
      </button>
    </div>
  );
}
