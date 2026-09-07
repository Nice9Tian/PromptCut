/**
 * kernel/combine.ts 的单测。跑:node --test src/kernel/combine.test.mjs
 *
 * 三方合并只有一条底线:**用户手里的东西不会被 Skill 的结果悄悄盖掉**。
 * 钉死:
 *   - theirs 新加的卡进来;落点撞上用户的卡就进「Skill 结果」序列,不盖;
 *   - theirs 改了、ours 没改 → 采用 theirs;两边都改 → 保留 ours 并记冲突;
 *   - theirs 删了、ours 没改 → 删;ours 改过 → 留;
 *   - 新序列、新剪辑、新素材整个搬过来;ours 删过的素材只在还被引用时捞回;
 *   - 合并是幂等的:同一份 theirs 合两遍,第二遍什么都不做。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyProject } from "./project.ts";
import { normalizeCuts } from "./cuts.ts";
import { combineProjects, describeReport, RESULT_TRACK_NAME } from "./combine.ts";

const clip = (id, start = 0, end = 1, extra = {}) => ({ id, cardId: "x", start, end, params: {}, ...extra });
const clone = (v) => JSON.parse(JSON.stringify(v));

/** 一份最简单的项目:一条序列,一张卡 */
function seed() {
  const p = normalizeCuts({
    ...createEmptyProject("测试"),
    tracks: [{ id: "t-1", name: "序列 1", clips: [clip("a", 0, 2)] }],
    duration: 10,
    media: [{ id: "m-1", kind: "video", name: "a.mp4", url: "a.mp4" }],
  });
  return p;
}

const clipsOf = (p, trackId) => p.tracks.find((t) => t.id === trackId)?.clips ?? [];
const findTrack = (p, name) => p.tracks.find((t) => t.name === name);

test("theirs 新加的卡进来,ours 原样保留", () => {
  const base = seed();
  const ours = clone(base);
  const theirs = clone(base);
  theirs.tracks[0].clips.push(clip("b", 3, 5));

  const { project, report } = combineProjects(base, ours, theirs);
  assert.deepEqual(clipsOf(project, "t-1").map((c) => c.id), ["a", "b"]);
  assert.equal(report.addedClips, 1);
  assert.equal(report.conflicts.length, 0);
});

test("落点撞上用户的卡:不盖,进「Skill 结果」序列", () => {
  const base = seed();
  const ours = clone(base);
  ours.tracks[0].clips.push(clip("mine", 3, 6)); // 用户后来加的
  const theirs = clone(base);
  theirs.tracks[0].clips.push(clip("b", 4, 5)); // agent 加在同一时段

  const { project, report } = combineProjects(base, ours, theirs);
  assert.deepEqual(clipsOf(project, "t-1").map((c) => c.id), ["a", "mine"]);
  const parked = findTrack(project, RESULT_TRACK_NAME);
  assert.ok(parked, "应该新建结果序列");
  assert.deepEqual(parked.clips.map((c) => c.id), ["b"]);
  assert.equal(report.parkedClips, 1);
});

test("theirs 改了、ours 没改 → 采用 theirs", () => {
  const base = seed();
  const ours = clone(base);
  const theirs = clone(base);
  theirs.tracks[0].clips[0].params = { text: "改过" };
  theirs.tracks[0].clips[0].end = 4;

  const { project, report } = combineProjects(base, ours, theirs);
  const a = clipsOf(project, "t-1").find((c) => c.id === "a");
  assert.deepEqual(a.params, { text: "改过" });
  assert.equal(a.end, 4);
  assert.equal(report.updatedClips, 1);
});

test("两边都改 → 保留 ours,记冲突", () => {
  const base = seed();
  const ours = clone(base);
  ours.tracks[0].clips[0].params = { text: "我的" };
  const theirs = clone(base);
  theirs.tracks[0].clips[0].params = { text: "它的" };

  const { project, report } = combineProjects(base, ours, theirs);
  assert.deepEqual(clipsOf(project, "t-1")[0].params, { text: "我的" });
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].clipId, "a");
  assert.match(describeReport(report).join("\n"), /冲突 a/);
});

test("两边改成了一样的 → 不算冲突", () => {
  const base = seed();
  const ours = clone(base);
  ours.tracks[0].clips[0].end = 3;
  const theirs = clone(base);
  theirs.tracks[0].clips[0].end = 3;
  const { report } = combineProjects(base, ours, theirs);
  assert.equal(report.conflicts.length, 0);
  assert.equal(report.updatedClips, 0);
});

test("theirs 删了、ours 没改 → 删;ours 改过 → 留并记冲突", () => {
  const base = seed();
  base.tracks[0].clips.push(clip("gone", 5, 6));
  base.tracks[0].clips.push(clip("kept", 7, 8));

  const ours = clone(base);
  ours.tracks[0].clips.find((c) => c.id === "kept").params = { text: "改了" };
  const theirs = clone(base);
  theirs.tracks[0].clips = theirs.tracks[0].clips.filter((c) => c.id === "a");

  const { project, report } = combineProjects(base, ours, theirs);
  assert.deepEqual(clipsOf(project, "t-1").map((c) => c.id), ["a", "kept"]);
  assert.equal(report.deletedClips, 1);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].clipId, "kept");
});

test("ours 删了、theirs 改了 → 保持删除,记冲突", () => {
  const base = seed();
  const ours = clone(base);
  ours.tracks[0].clips = [];
  const theirs = clone(base);
  theirs.tracks[0].clips[0].end = 9;

  const { project, report } = combineProjects(base, ours, theirs);
  assert.equal(clipsOf(project, "t-1").length, 0);
  assert.equal(report.conflicts.length, 1);
});

test("theirs 新建的序列和剪辑整个搬过来", () => {
  const base = seed();
  const ours = clone(base);
  const theirs = clone(base);
  theirs.tracks.push({ id: "t-new", name: "字幕", clips: [clip("s1", 0, 1), clip("s2", 1, 2)] });
  theirs.cuts.push({ id: "cut-x", name: "花絮", tracks: [{ id: "t-x", name: "序列 1", clips: [clip("x1", 0, 3)] }], duration: 5 });

  const { project, report } = combineProjects(base, ours, theirs);
  assert.deepEqual(findTrack(project, "字幕").clips.map((c) => c.id), ["s1", "s2"]);
  assert.ok(project.cuts.some((c) => c.id === "cut-x"));
  // 剪辑1 里新加的「字幕」+ 新剪辑自带的那条,两条都算新增
  assert.equal(report.addedTracks, 2);
  assert.equal(report.addedCuts, 1);
  // 新序列里的卡只算一次
  assert.equal(report.addedClips, 3);
});

test("theirs 移动了卡到别的序列:ours 没改就跟着搬", () => {
  const base = seed();
  base.tracks.push({ id: "t-2", name: "序列 2", clips: [] });
  const ours = clone(base);
  const theirs = clone(base);
  const moved = theirs.tracks[0].clips.pop();
  theirs.tracks[1].clips.push(moved);

  const { project, report } = combineProjects(base, ours, theirs);
  assert.equal(clipsOf(project, "t-1").length, 0);
  assert.deepEqual(clipsOf(project, "t-2").map((c) => c.id), ["a"]);
  assert.equal(report.updatedClips, 1);
});

test("素材:新的进来;ours 删过的只在还被引用时捞回", () => {
  const base = seed();
  base.media.push({ id: "m-del", kind: "video", name: "del.mp4", url: "del.mp4" });
  const ours = clone(base);
  ours.media = ours.media.filter((m) => m.id === "m-1"); // 用户删了 m-del
  const theirs = clone(base);
  theirs.media.push({ id: "m-new", kind: "image", name: "new.png", url: "new.png" });

  // 第一种:theirs 没用 m-del → 不捞
  let r = combineProjects(base, ours, theirs);
  assert.deepEqual(r.project.media.map((m) => m.id), ["m-1", "m-new"]);

  // 第二种:theirs 加了一张引用 m-del 的卡 → 捞回来并说明
  const theirs2 = clone(theirs);
  theirs2.tracks[0].clips.push(clip("v", 3, 4, { mediaId: "m-del" }));
  r = combineProjects(base, ours, theirs2);
  assert.ok(r.project.media.some((m) => m.id === "m-del"));
  assert.match(r.report.notes.join("\n"), /捞回来/);
});

test("时长不够装 theirs 的卡就拉长,不截", () => {
  const base = seed();
  const ours = clone(base);
  const theirs = clone(base);
  theirs.tracks[0].clips.push(clip("late", 20, 25));
  const { project, report } = combineProjects(base, ours, theirs);
  assert.equal(project.duration, 25);
  assert.match(report.notes.join("\n"), /拉长/);
});

test("幂等:同一份结果合两遍,第二遍没有改动", () => {
  const base = seed();
  const ours = clone(base);
  const theirs = clone(base);
  theirs.tracks[0].clips.push(clip("b", 3, 5));
  theirs.tracks[0].clips[0].params = { text: "改过" };

  const first = combineProjects(base, ours, theirs);
  const second = combineProjects(theirs, first.project, theirs);
  assert.equal(second.report.addedClips, 0);
  assert.equal(second.report.updatedClips, 0);
  assert.equal(second.report.conflicts.length, 0);
  assert.deepEqual(second.project.tracks, first.project.tracks);
});

test("三边各自 normalize 补出来的空序列不算新增", () => {
  // base 是裸快照,ours / theirs 各自在页面里 normalize 过:停放的剪辑各有一套随机 id 的空序列
  const raw = { ...createEmptyProject("裸"), tracks: [{ id: "t-1", name: "序列 1", clips: [clip("a", 0, 2)] }], duration: 10 };
  const base = clone(raw);
  const ours = normalizeCuts(clone(raw));
  const theirs = normalizeCuts(clone(raw));
  theirs.tracks[0].clips.push(clip("b", 3, 4));
  const { project, report } = combineProjects(base, ours, theirs);
  assert.equal(report.addedTracks, 0);
  assert.equal(report.addedClips, 1);
  // 停放的剪辑里还是各两条空序列,没有变成四条
  for (const c of project.cuts.filter((c) => c.id !== project.activeCutId)) assert.equal(c.tracks.length, 2);
});

test("激活的剪辑还是 ours 的那条,停放的条目不带重复内容", () => {
  const base = seed();
  const ours = clone(base);
  const theirs = clone(base);
  theirs.tracks[0].clips.push(clip("b", 3, 5));
  const { project } = combineProjects(base, ours, theirs);
  assert.equal(project.activeCutId, ours.activeCutId);
  const active = project.cuts.find((c) => c.id === project.activeCutId);
  assert.equal(active.tracks, undefined);
});
