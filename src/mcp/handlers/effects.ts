import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { describeTransition, transitionsOf, type TransitionKind } from "../../kernel/transitions";
import { timelineDigest } from "../../editor/right/toolEcho";
import { listCuts, resolveCut } from "../../kernel/cuts";

import { clipGuard, filterTools, pixelMapTools } from "../common";

export const effectsHandlers = {
  listFilters: () => filterTools.listFilters(),
  createFilter: (args) => { const r = filterTools.createFilter(args); clipGuard.noteMutation(); return r; },
  updateFilter: (args) => { const r = filterTools.updateFilter(args); clipGuard.noteMutation(); return r; },
  removeFilter: (args) => { const r = filterTools.removeFilter(args); clipGuard.noteMutation(); return r; },
  applyFilter: (args) => { const r = filterTools.applyFilter(args); clipGuard.noteMutation(); return r; },
  listPixelMaps: () => pixelMapTools.listPixelMaps(),
  createPixelMap: (args) => { const r = pixelMapTools.createPixelMap(args); clipGuard.noteMutation(); return r; },
  updatePixelMap: (args) => { const r = pixelMapTools.updatePixelMap(args); clipGuard.noteMutation(); return r; },
  removePixelMap: (args) => { const r = pixelMapTools.removePixelMap(args); clipGuard.noteMutation(); return r; },
  applyPixelMap: (args) => { const r = pixelMapTools.applyPixelMap(args); clipGuard.noteMutation(); return r; },
  listMediaEffects: (args) => pixelMapTools.listMediaEffects(args),
  listTransitions: () => {
    const p = getState().project;
    return {
      ok: true,
      transitions: transitionsOf(p).map((tr) => ({ ...tr, describe: describeTransition(p, tr) })),
      hint: "转场把它引用的片段绑成一组:那几段的相对时间关系锁住了,单独改时长 / 换序列 / 切开都会被拒。整组平移不受限制。要单独调先 remove_transition。",
    };
  },
  addTransition: (args) => {
    const kind = String(args.kind ?? "") as TransitionKind;
    if (!["crossfade", "fadeIn", "fadeOut"].includes(kind)) {
      throw new Error(`kind 只能是 crossfade / fadeIn / fadeOut,收到 ${JSON.stringify(args.kind)}`);
    }
    const r = actions.addTransition({ kind, clipId: args.clipId, otherClipId: args.otherClipId, dur: args.dur });
    if (!r.ok) throw new Error(r.error);
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, transition: r.transition, describe: describeTransition(p, r.transition),
      group: [r.transition.aId, ...(r.transition.bId ? [r.transition.bId] : [])],
      note: "这几段现在绑成一组:相对时间关系锁住了(整组平移仍然可以)。要单独调先 remove_transition。",
      timeline: timelineDigest(p),
    };
  },
  removeTransition: (args) => {
    const r = actions.removeTransition(String(args.transitionId ?? ""));
    if (!r.ok) throw new Error(r.error);
    clipGuard.noteMutation();
    return { ok: true, ...(r.note ? { note: r.note } : {}), timeline: timelineDigest(getState().project) };
  },
  /* ---------- 剪辑(多条时间轴) ---------- */
  listCuts: () => ({ activeCutId: getState().project.activeCutId, cuts: listCuts(getState().project) }),
  switchCut: (args) => {
    const cut = resolveCut(getState().project, args);
    actions.switchCut(cut.id);
    clipGuard.noteMutation();
    const p = getState().project;
    return { ok: true, activeCutId: p.activeCutId, cuts: listCuts(p), timeline: timelineDigest(p) };
  },
  addCut: (args) => {
    const cut = actions.addCut(args?.name, { switchTo: args?.switch !== false });
    clipGuard.noteMutation();
    const p = getState().project;
    return { ok: true, cut: { id: cut.id, name: cut.name }, activeCutId: p.activeCutId, cuts: listCuts(p) };
  },
  renameCut: (args) => {
    const cut = resolveCut(getState().project, { cutId: args.cutId });
    actions.renameCut(cut.id, args.name);
    return { ok: true, cuts: listCuts(getState().project) };
  },
  removeCut: (args) => {
    const p = getState().project;
    const cut = resolveCut(p, { cutId: args.cutId });
    const info = listCuts(p).find((c) => c.id === cut.id)!;
    // 门槛和 remove_clip 一个道理:有内容的剪辑不能一句话删掉,要 force + reason,理由回显给用户
    if (info.clipCount > 0 && !args.force) {
      throw new Error(`「${cut.name}」里有 ${info.clipCount} 段内容,不能直接删;确实要删就传 force:true 并在 reason 里写明理由`);
    }
    if (args.force && !(args.reason && args.reason.trim())) throw new Error("force 删除必须在 reason 里写明理由");
    const before = p.activeCutId;
    actions.removeCut(cut.id);
    clipGuard.noteMutation();
    const q = getState().project;
    return {
      ok: true, removed: cut.id,
      ...(before === cut.id ? { switchedTo: q.activeCutId } : null),
      ...(args.reason ? { reason: args.reason } : null),
      cuts: listCuts(q),
    };
  },
} satisfies Partial<EditorApi>;
