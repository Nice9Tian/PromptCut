import { useEffect, useState } from "react";
import type { JSX } from "react";
import { closeSkillMode, subscribeSkill } from "../skill/skillMode";
import { onlinePage, onlineUnsupported } from "../online/pageFlag";
import "./ModeSwitch.css";

/**
 * 顶栏的工作方式开关:传统式 / SKILL,二选一(`user-workflow.md`「工作方式」)。
 *
 * 做成**一个整体控件**而不是两个独立按钮:两种方式是互斥的一件事,滑块滑到哪一格就是哪一格。
 *
 *   * 传统式:用户和 AI 栏里的 Agent 动手;桌面 APP 的会话被 SKILL 闸拦下(`server/skill-gate.mjs`)。
 *   * SKILL:桌面 APP 里的 Agent 经 MCP 直连这个项目(计划 `docs/plan/agent-workflow-plan.md` A4),AI 栏照常可用。
 *     进 SKILL 走「SKILL…」对话框(登记到 Claude Code / Codex、看接进来的会话、进入 SKILL);
 *     退出就点这里的「传统式」,手边最近的就是这个控件。
 *
 * 原来还有一格「对话式」布局,已去掉(TODO「工作方式」:语义只有传统式与 SKILL 两种工作方式)。
 */

type Mode = "classic" | "skill";

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。在线页面进不了 SKILL 模式
 * (这一格置灰,`skillMode.ts` 也不轮询),订阅与退出在在线构建里剪掉,连同 `skillMode.ts` 背后的 /api 调用(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

const ITEMS: { id: Mode; label: string; hint: string }[] = [
  { id: "classic", label: "传统式", hint: "用户和 AI 栏里的 Agent 一起改" },
  { id: "skill", label: "SKILL", hint: "桌面 APP 里的 Agent 经 MCP 改这个项目" },
];

export function ModeSwitch(props: { onOpenSkill: () => void }): JSX.Element {
  const [skillOn, setSkillOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => (ONLINE_BUILD ? undefined : subscribeSkill((s) => setSkillOn(s.state.active))), []);

  const active: Mode = skillOn ? "skill" : "classic";

  const pick = async (id: Mode) => {
    if (id === "skill") {
      // 进 SKILL(或已经在 SKILL 时看接进来的会话、登记)都在对话框里
      props.onOpenSkill();
      return;
    }
    if (id === active || ONLINE_BUILD) return;
    // 切回传统式 = 退出 SKILL 模式:之后桌面 APP 会话的工具调用都会被拒
    setBusy(true);
    try {
      await closeSkillMode("user");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const index = ITEMS.findIndex((i) => i.id === active);

  return (
    <div className="pc-modeswitch" role="group" aria-label="工作方式" data-pc="mode-switch">
      {/* 滑块:绝对定位,按选中项的序号平移。两格等宽,所以位置就是 index/2 */}
      <span
        className={`pc-modeswitch-thumb${active === "skill" ? " is-skill" : ""}`}
        style={{ transform: `translateX(${index * 100}%)` }}
        aria-hidden="true"
      />
      {ITEMS.map((item) => {
        const on = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            data-pc={`mode-${item.id}`}
            className={`pc-modeswitch-item${on ? " is-on" : ""}`}
            aria-pressed={on}
            // 在线浏览器模式:SKILL 要本机的桌面 APP 与编辑器进程(C10 契约第 10 节),置灰
            disabled={busy || (item.id === "skill" && !on && onlinePage())}
            title={
              item.id === "skill" && !on && onlinePage()
                ? onlineUnsupported("SKILL 模式")
                : item.id === "skill"
                ? on
                  ? "当前为 SKILL 模式。点这里看接进来的桌面 APP 会话;点「传统式」退出"
                  : "打开 SKILL 对话框:登记到 Claude Code / Codex,进入 SKILL"
                : item.hint
            }
            onClick={() => void pick(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
