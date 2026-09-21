import {
  switchCut as switchCutPure, addCut as addCutPure, renameCut as renameCutPure,
  removeCut as removeCutPure
} from "../../kernel/cuts";

import { state, set, setProject } from "../core";

export const cuts = {

  /* ---------- 剪辑(多条时间轴) ---------- */
  /**
   * 切到另一条剪辑。当前的 tracks / duration / 播放头存回它的条目,目标的换进来。
   * 进撤销栈(整份 project 一起,撤销就是切回去);选中清空、停播、总时长手动值清掉 —— 这些都是
   * 上一条剪辑的东西。播放头用目标上次离开时的。
   */
  switchCut(cutId: string) {
    const { project, t } = switchCutPure(state.project, cutId, state.t);
    if (project === state.project) return;
    setProject(project);
    set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
  },
  /** 新建一条剪辑,默认切过去(和剪辑软件新建序列的习惯一致) */
  addCut(name?: string, opts: { switchTo?: boolean } = {}) {
    const { project, cut } = addCutPure(state.project, name);
    setProject(project);
    if (opts.switchTo !== false) cuts.switchCut(cut.id);
    return cut;
  },
  renameCut(cutId: string, name: string) {
    setProject(renameCutPure(state.project, cutId, name));
  },
  /** 删一条剪辑。删激活那条会先切到相邻的;最后一条不能删(纯逻辑里会抛) */
  removeCut(cutId: string) {
    const { project, switchedTo, t } = removeCutPure(state.project, cutId, state.t);
    setProject(project);
    if (switchedTo) set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
  },
};
