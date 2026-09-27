import { useEffect, useState } from "react";
import { getState, useStore } from "../store/project";
import { previewMode } from "./previewMode";
import { setPlanProject } from "./planDispatch";
import { onProbeProgress, probeProgress, requeueProbeRun, syncProbeRun, type ProbeProgress } from "./probeRunner";
import { whenStageReady } from "./stageBridge";
import { cardsStamp, onCardsUpdated } from "../kernel/registry";
import { whenStagesHaveCards } from "./stageCards";
import { ONLINE } from "../online/mode";
import { lowMemoryMode } from "../online/lowMemory";
import "./ProbeGate.css";

/**
 * K1 的**加载遮罩**：打开项目时把所有活跃卡逐张测完才进编辑（pinned 渲染 5）。
 *
 * - 由 `Editor.tsx` 渲 `<Preview />` 的那一层同时渲。**遮罩不另起 iframe** ——
 *   两个舞台 iframe 照常由 `Preview` 挂（E1），探针跑在后台那一个上。
 * - 盖住整个编辑器界面，**编辑操作被挡**。加载阶段的遮罩不算 pinned 渲染 1 的交互卡顿
 *   （渲染 1 的括号已钉入这条例外）。
 * - **只用已有的主题变量**，不引入新的固定配色（pinned 交互 2 / 3，见 `ProbeGate.css`）。
 * - `costs` 全命中时**一帧都不出现**：`probeRunner` 先拉一次记录，要测的张数为 0 时
 *   `running` 从来不会翻成 true，这个组件一直回 `null`。
 * - 之后新添加的卡、或 `cardCostKey` 变了的卡在后台补测，那时 `blocking` 已经是 false，
 *   遮罩不再出现（K1：「兜底分派只用于『新卡还没测完』那几秒」）。
 * - **legacy 下不挂**：R2～R6 的新东西全藏在 `?preview=stage` 后面，而常驻探针要的是
 *   一个真正的后台舞台（legacy 只有一个同源舞台，对它跑探针就是把用户眼前的画面拨走）。
 */
export function ProbeGate() {
  const project = useStore((s) => s.project);
  // `?preview=stage` 才有后台舞台（E1）；缺省的 legacy 一个字都不受影响。
  // 在线普通档恢复（C10 契约第 3 节：打开项目在加载遮罩下测完；后台舞台握不上手、退回单舞台时探针等不到后台舞台，遮罩不出现）；
  // 低内存档不测（c10a 第 8 节：不开后台舞台、不跑 ProbeGate；界限搜索归 `claude/c10-cost`）
  const staged = previewMode() === "stage";
  const enabled = staged && !(ONLINE && lowMemoryMode(true));
  const [p, setP] = useState<ProbeProgress>(probeProgress);

  useEffect(() => {
    if (!enabled) return;
    return onProbeProgress(setP);
  }, [enabled]);

  /*
   * 项目变了按新项目重排队列（K1）。store 是不可变更新，引用没变就什么都没变，
   * `syncProbeRun` 自己会早退，所以这个 effect 每次 project 变都跑一遍也不贵。
   */
  useEffect(() => {
    if (!staged) return;
    // K2 的分派表也跟着项目走（E0 的 setPlan；`costs` / `tuning` 由 probeRunner 喂）。
    // 低内存档不测，但分派表照样要有项目：显示表（全部判重）与界限搜索的判定表都靠它（C10 集成：只关测量，不关分派）
    setPlanProject(project);
    if (enabled) syncProbeRun(project);
  }, [staged, enabled, project]);

  /*
   * 卡片代码换了(C6.6 第 5 节「卡片代码变了要由页面显式触发重测」:同步装上别人改的卡,或本机改卡):
   * 项目没变、卡的代码变了,按当前项目重排一轮,身份键变了的卡补测。
   * 信号来自注册表的 `onCardsUpdated`(`cards/index.ts` 接住热更新、重装整套卡片之后发),
   * 它在这一批热更新全部落地之后才发,卡片源码表已是新的。舞台不重载(集成 3b):RPC 客户端一直在,
   * 这里仍等一下后台舞台就绪,免得页面刚打开、舞台还没握手时白排一轮。
   */
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const off = onCardsUpdated(() => {
      // 先等两个舞台都换上这一版卡片(没换上的会被重载),再等后台舞台就绪,才排重测:
      // 不然会在后台舞台还是旧卡、或正在换卡的当口测(测到旧代码,或那一轮被打断、等 RPC 超时)
      void whenStagesHaveCards(cardsStamp())
        .then(() => whenStageReady("back"))
        .then(() => { if (active) requeueProbeRun(getState().project); });
    });
    return () => { active = false; off(); };
  }, [enabled]);

  if (!enabled || !p.running || !p.blocking) return null;

  const total = Math.max(1, p.total);
  const done = Math.min(p.done, p.total);
  return (
    <div
      className="pc-probe-gate"
      data-pc="probe-gate"
      role="status"
      aria-live="polite"
      // 遮罩期间鼠标、键盘都不该落到下面的编辑器上
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="pc-probe-gate-ring" aria-hidden="true" />
      <div className="pc-probe-gate-title">正在测量卡片 {done + 1} / {p.total}</div>
      <div className="pc-probe-gate-bar" aria-hidden="true"><i style={{ width: `${(done / total) * 100}%` }} /></div>
      {p.card && <div className="pc-probe-gate-card">{p.card}</div>}
      {p.failed.length > 0 && <div className="pc-probe-gate-note">{p.failed.length} 张没测出来，按声明兜底分派</div>}
    </div>
  );
}

export default ProbeGate;
