import {
  switchCut as switchCutPure, addCut as addCutPure, renameCut as renameCutPure,
  removeCut as removeCutPure, placeCutSegment,
} from "../../kernel/cuts";
import { cutCycleReason, cutReferences } from "../../kernel/cutSegments";
import { newId, type Track, type TrackClip } from "../../kernel/project";

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
  /**
   * 删一条剪辑。删激活那条会先切到相邻的;最后一条不能删(纯逻辑里会抛)。
   * 被别的剪辑引用着时,引用它的剪辑段连同转场一起删(说明与确认是调用方的事:素材库弹确认、
   * Agent 工具要 force)。一步撤销就全回来。返回删掉的剪辑段在哪些剪辑里。
   */
  removeCut(cutId: string) {
    const { project, switchedTo, t, removedSegments } = removeCutPure(state.project, cutId, state.t);
    setProject(project);
    if (switchedTo) set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
    else set({ selection: state.selection.filter((id) => !removedSegments.some((r) => r.clipIds.includes(id))) });
    return { removedSegments };
  },
  /** 直接引用了这条剪辑的那些剪辑(删之前给人看) */
  cutReferences(cutId: string) {
    return cutReferences(state.project, cutId);
  },
  /** 把剪辑 `childCutId` 放进激活剪辑会不会循环引用;会的话返回原因 */
  cutCycleReason(childCutId: string): string | null {
    const host = state.project.activeCutId;
    return host ? cutCycleReason(state.project, host, childCutId) : null;
  },
  /**
   * 在激活剪辑里放一个引用 `childCutId` 的剪辑段(拖放、Agent 工具)。`newTrackIndex` 给了就新建一条序列放上去;
   * 循环引用、找不到剪辑、序列放不下都抛,错误信息给人看。默认长度 = 被引用剪辑(从 offset 起)剩下的长度。
   */
  addCutSegment(childCutId: string, start: number, opts: { trackId?: string; newTrackIndex?: number; duration?: number; offset?: number } = {}): TrackClip {
    let p = state.project;
    let trackId = opts.trackId;
    if (opts.newTrackIndex !== undefined || (!trackId && !p.tracks.length)) {
      const track: Track = { id: newId("t"), name: `序列 ${p.tracks.length + 1}`, clips: [] };
      const tracks = [...p.tracks];
      const at = Math.max(0, Math.min(tracks.length, opts.newTrackIndex ?? tracks.length));
      tracks.splice(at, 0, track);
      p = { ...p, tracks };
      trackId = track.id;
    } else if (!trackId) {
      // 不指定序列:挑第一条这段时间空着、没锁的
      const free = p.tracks.find((t) => !t.locked && !t.clips.some((c) => c.start < start + 0.05 && start < c.end));
      trackId = (free ?? p.tracks.find((t) => !t.locked))?.id;
    }
    const { project, clip } = placeCutSegment(p, childCutId, start, { trackId, duration: opts.duration, offset: opts.offset });
    setProject(project);
    set({ selection: [clip.id] });
    return clip;
  },
};
