import { loadProc, serializeProc, forgetSaveTarget } from "./proc";
import { actions } from "../../store/project";
import type { Project } from "../../kernel/project";

/** 本地草稿:服务端 `.pc-projects/` 目录里的一个 .proc 文件 */
export interface DraftInfo {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
  duration: number;
  clips: number;
  thumbnail: string | null;
  /** 文件坏了(解析不出来)。仍然列出来,好让用户删掉 */
  broken: boolean;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `请求失败(${res.status})`);
  }
  return data as T;
}

export async function listDrafts(): Promise<DraftInfo[]> {
  const data = await json<{ projects: DraftInfo[] }>(await fetch("/api/projects"));
  return data.projects ?? [];
}

/** 草稿 id:时间戳打头,列表按名字排也大致是按时间 */
export function newDraftId(): string {
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveDraft(id: string, thumbnail: string | null = null): Promise<DraftInfo> {
  return json<DraftInfo>(
    await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: serializeProc(thumbnail),
    }),
  );
}

/** 读一份草稿并载入 store。返回载入后的 Project */
export async function openDraft(id: string): Promise<Project> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`打不开这份草稿(${res.status})`);
  const project = loadProc(await res.text());
  // 换了草稿就换了落点,不能再覆盖上一个项目的文件
  forgetSaveTarget();
  actions.loadProject(project, `${project.name}.proc`);
  return project;
}

export async function deleteDraft(id: string): Promise<void> {
  await json(await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/**
 * 当前编辑的是哪份草稿。
 *
 * 放模块级变量而不是 store:它只影响「保存」往哪个文件写,不参与撤销重做,
 * 也不该进 .proc 文件本身。开始页选中草稿时写入,顶栏保存时读出。
 */
let activeDraftId: string | null = null;

export function setActiveDraftId(id: string | null): void {
  activeDraftId = id;
}

/** 没有就现开一个,这样「保存」永远有地方写 */
export function ensureActiveDraftId(): string {
  if (!activeDraftId) activeDraftId = newDraftId();
  return activeDraftId;
}

export function getActiveDraftId(): string | null {
  return activeDraftId;
}
