import { useEffect, useState } from "react";
import type { JSX } from "react";
import { closeSkillMode, subscribeSkill, type SkillSnapshot } from "../../skill/skillMode";
import "./SkillLock.css";

/**
 * SKILL 模式下盖住 AI 面板的那一层。
 *
 * 为什么要锁:进了 Skill 模式,活交给无头实例上的 agent 干,用户手里这份 PromptCut 只是
 * 个观察窗。这时候还能在自己的 AI 面板里发消息,就会出现两个 agent 同时改同一个项目 ——
 * 谁后写谁赢,而且用户根本看不出自己刚才那句话被覆盖了。所以整块盖住,只留一个出口:
 * 「关闭 SKILL 模式」。
 *
 * 盖而不是禁用输入框:禁用只挡住输入框,滚动区里的重试按钮、工具卡片上的操作还点得动。
 * 一整层盖上去,顺便有地方把「现在是什么状态、agent 改到哪了」讲清楚。
 */
export function SkillLock(): JSX.Element | null {
  const [snap, setSnap] = useState<SkillSnapshot | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => subscribeSkill(setSnap), []);

  if (!snap?.state.active) return null;
  const { state, proc } = snap;

  const close = async () => {
    setClosing(true);
    setError("");
    try {
      await closeSkillMode("user");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClosing(false);
    }
  };

  return (
    <div className="pc-skill-lock" role="status" aria-live="polite">
      <div className="pc-skill-lock-card">
        <div className="pc-skill-lock-badge">当前为 SKILL 模式</div>
        <div className="pc-skill-lock-body">
          项目正交给桌面版的 AI 助手改,这里的 AI 面板暂时锁住 —— 两边同时改同一个项目,
          后写的会把先写的整份盖掉。
        </div>

        <div className="pc-skill-lock-meta">
          {state.jobId && <div><span>任务</span><code>{state.jobId}</code></div>}
          {proc && (
            <div>
              <span>进度</span>
              <code>{proc.clips} 张卡 · 更新于 {new Date(proc.updatedAt).toLocaleTimeString()}</code>
            </div>
          )}
        </div>

        {error && <div className="pc-skill-lock-err">{error}</div>}

        <button type="button" className="pc-skill-lock-btn" onClick={close} disabled={closing}>
          {closing ? "关闭中…" : "关闭 SKILL 模式"}
        </button>
        <div className="pc-skill-lock-hint">
          关掉之后 agent 那边再想改项目会被拒绝,并收到一句说明;你可以接着自己编辑。
        </div>
      </div>
    </div>
  );
}
