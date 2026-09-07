import { parseProc } from "./proc";
import { actions, getState } from "../../store/project";
import { combineProjects, describeReport, type CombineReport } from "../../kernel/combine";
import type { Project } from "../../kernel/project";

/**
 * 把一份 Skill 结果(theirs)按三方合并并进当前项目。
 *
 * base 是启动 Skill 时的快照;没有 base(比如用户随手挑了一个别处来的 .proc)就拿
 * 当前项目当 base —— 那时合并退化成「把对方多出来的东西加进来」,不会盖掉自己的。
 */
export function applyCombine(theirsText: string, baseText: string | null): CombineReport {
  const ours = getState().project;
  const theirs = parseProc(theirsText);
  const base = baseText ? parseProc(baseText) : ours;
  const { project, report } = combineProjects(base, ours, theirs);
  replaceProject(project);
  return report;
}

/**
 * 整份换掉当前项目,并标成「有未保存改动」。
 *
 * store 没有公开的「整份替换」动作,loadProject 是最接近的,但它会把脏标记清掉、
 * 撤销栈也清空 —— 合并完不能让「保存」按钮以为没事。setProjectMeta 走的是正常的
 * setProject 路径,会把脏标记打上;传当前名字等于什么都没改,只为这个副作用。
 * (store/project.ts 是别的会话正在改的文件,不往里加动作。)
 */
function replaceProject(project: Project): void {
  actions.loadProject(project, getState().filePath);
  actions.setProjectMeta({ name: project.name });
}

/** 合并后给用户看的一段话 */
export function summarizeCombine(report: CombineReport): string {
  return describeReport(report).join("\n");
}
