import { actions, getState } from "../../store/project";
import { createEmptyProject } from "../../kernel/project";
import type { Project } from "../../kernel/project";
import { exportProjectJson } from "./index";

/**
 * `.proc` —— PromptCut 自己的项目文件。
 *
 * 里面就是一层薄壳加一份编排:壳记住格式和版本,方便以后改结构时认得出老文件。
 * 兼容读入旧的 `.promptcut.json`(那时候是裸的 Project),所以 `parseProc` 两种都吃。
 *
 * 素材本身不进 .proc,只记文件名 —— 一份编排几十 KB,塞进视频就没法发给别人了。
 *
 * 一条不变量:**读回来的 clip.params 必须原样保留,这里绝不补默认值。**
 * clip.params 现在是写入时物化的(store 的 addCardClip / setClipCard 会把 defaults
 * 展开成全量存进 clip),所以文件里存的就是全套真值;这里再合一次 defaults 只会
 * 把用户改过的值悄悄盖回去。Stage 里那层 {...defaults, ...params} 只是给
 * 「卡片后来新增了参数、老 clip 缺这个键」兜底,不是这里的职责。
 * 已验证:内存往返和过磁盘往返,params 都逐字节相同。
 */

export const PROC_EXT = ".proc";
export const PROC_FORMAT = "promptcut-project";
export const PROC_VERSION = 1;

export interface ProcFile {
  format: typeof PROC_FORMAT;
  version: number;
  savedAt: string;
  /** 列表里的封面,留给以后填;现在一律 null */
  thumbnail: string | null;
  project: Project;
}

/** 当前项目 → .proc 文本 */
export function serializeProc(thumbnail: string | null = null): string {
  const project = JSON.parse(exportProjectJson()) as Project;
  const doc: ProcFile = {
    format: PROC_FORMAT,
    version: PROC_VERSION,
    savedAt: new Date().toISOString(),
    thumbnail,
    project,
  };
  return JSON.stringify(doc, null, 2);
}

/** .proc 文本 → Project。旧的裸 Project JSON 也认 */
export function parseProc(text: string): Project {
  const doc = JSON.parse(text);
  const project = doc?.format === PROC_FORMAT ? doc.project : doc;
  if (!project || typeof project !== "object" || !Array.isArray(project.tracks)) {
    throw new Error("这不是一个 PromptCut 项目文件");
  }
  return { ...createEmptyProject(), ...project };
}

/** 当前项目名,拿来当默认文件名 */
export function currentProjectName(): string {
  return getState().project.name || "未命名";
}

/** 新建一个空项目并载入(顶栏「新建项目」和开始页「开始创作」都走这里) */
export function newProject(name = "未命名"): Project {
  const project = createEmptyProject(name);
  actions.loadProject(project, `${name}${PROC_EXT}`);
  return project;
}
