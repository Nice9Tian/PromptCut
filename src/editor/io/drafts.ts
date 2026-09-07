import { loadProc, serializeProc, forgetSaveTarget } from "./proc";
import { acquireDraftLock, releaseDraftLock } from "./procLock";
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
  /*
   * 先抢独占锁再读内容。顺序不能反 —— 读完再抢的话,两个实例可能都已经把项目
   * 载进内存了,再告诉其中一个「你没抢到」就晚了,它已经能编辑了。
   * SKILL 模式下服务端会直接放行(skipped),那时无头实例才是唯一的写者。
   */
  const lock = await acquireDraftLock(id);
  if (!lock.ok) throw new Error(lock.error || "这个项目正被另一个 PromptCut 打开");
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) {
    await releaseDraftLock();
    throw new Error(`打不开这份草稿(${res.status})`);
  }
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
  // 换草稿(含设成 null:新建项目、从文件打开)就把上一份的锁放掉。
  // 不 await:调用点大多在用户手势里,放锁慢一点不该卡住界面;放锁本身是幂等的。
  if (activeDraftId && activeDraftId !== id) void releaseDraftLock();
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
