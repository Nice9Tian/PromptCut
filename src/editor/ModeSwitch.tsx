import { useEffect, useState } from "react";
import type { JSX } from "react";
import { type LayoutMode, setLayoutMode, useLayoutMode } from "./layoutMode";
import { closeSkillMode, subscribeSkill } from "../skill/skillMode";
import { onlinePage, onlineUnsupported } from "../online/pageFlag";
import "./ModeSwitch.css";

/**
 * 顶栏的模式开关:传统式 / 对话式 / SKILL,三选一。
 *
 * 做成**一个整体控件**而不是三个独立按钮:三个模式是互斥的一件事,滑块滑到哪一格就是哪一格,
 * 一眼看得出「现在在这个、还有那两个可以去」。下拉框做不到这一点 —— 收起来的时候只看得见
 * 当前值,得点开才知道有几个选项;而且 SKILL 也没法混进一个「布局」下拉里,它根本不是布局。
 *
 * SKILL 这一格和另外两格不一样,值得说清楚:
 *   * 它**不能靠点这里进入** —— 进 SKILL 模式要走「Skill 模式…」对话框,那里要选驱动、
 *     建任务目录、拉起桌面 app。所以没在 SKILL 模式时这一格是灰的,点了只提示去哪儿开;
 *   * 但**可以靠点这里退出**。用户要收回控制权的时候,手边最近的就是这个控件,
 *     不该逼他去 AI 面板里找按钮。点一下就关掉,滑块自己滑回原来那格。
 */

type Mode = LayoutMode | "skill";

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。在线页面进不了 SKILL 模式
 * (这一格置灰,`skillMode.ts` 也不轮询),订阅与退出在在线构建里剪掉,连同 `skillMode.ts` 背后的 /api 调用(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

const ITEMS: { id: Mode; label: string; hint: string }[] = [
  { id: "classic", label: "传统式", hint: "左中右三栏 + 时间轴" },
  { id: "chat", label: "对话式", hint: "AI 助手 + 预览" },
  { id: "skill", label: "SKILL", hint: "项目交给桌面版 AI 助手改" },
];

export function ModeSwitch(props: { onOpenSkill: () => void }): JSX.Element {
  const layout = useLayoutMode();
  const [skillOn, setSkillOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => (ONLINE_BUILD ? undefined : subscribeSkill((s) => setSkillOn(s.state.active))), []);

  // SKILL 一开就压过布局:那时候界面的主角是「有人在替你改项目」这件事
  const active: Mode = skillOn ? "skill" : layout;

  const pick = async (id: Mode) => {
    if (id === active) return;
    if (id === "skill") {
      // 进不去,只能引导 —— 真正的入口在对话框里(要选驱动、建任务目录、拉桌面 app)
      props.onOpenSkill();
      return;
    }
    if (skillOn && !ONLINE_BUILD) {
      // 从 SKILL 切回布局 = 退出 SKILL 模式。顺手把布局也切过去,少一步操作
      setBusy(true);
      try {
        await closeSkillMode("user");
      } finally {
        setBusy(false);
      }
    }
    setLayoutMode(id as LayoutMode);
  };

  const index = ITEMS.findIndex((i) => i.id === active);

  return (
    <div className="pc-modeswitch" role="group" aria-label="模式">
      {/* 滑块:绝对定位,按选中项的序号平移。三格等宽,所以位置就是 index/3 */}
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
            className={`pc-modeswitch-item${on ? " is-on" : ""}`}
            aria-pressed={on}
            // 在线浏览器模式:SKILL 要拉起桌面版的 AI 助手(C10 契约第 10 节),置灰
            disabled={busy || (item.id === "skill" && !on && onlinePage())}
            title={
              item.id === "skill" && !on && onlinePage()
                ? onlineUnsupported("SKILL 模式")
                : item.id === "skill"
                ? on
                  ? "当前为 SKILL 模式。点别的格子可以退出"
                  : "从「Skill 模式…」进入:要选驱动、建任务目录、拉起桌面 app"
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
