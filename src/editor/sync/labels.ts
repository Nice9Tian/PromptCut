/**
 * 撤销提示条、离线对话框、本地备份列表里「哪一处」「谁改的」的说法(c65-undo-draft.md 第 2 节)。
 *
 * - 实体按顶层计,前缀带类别:片段「开头空镜」、序列「主序列」、项目设置「帧率」;
 * - 身份:另一位成员(用户名)、Agent 的某个对话、你在另一个页面。
 *
 * 纯函数,不读 store:项目与「我是谁」都由调用方传进来。
 */
import { entityValuePath, getAt, parsePath } from "../../kernel/diffProject";
import type { Project } from "../../kernel/project";
import { getCard } from "../../kernel/registry";
import type { Writer } from "../../store/docsync";

/** 集合名 → 类别 */
const KIND: Record<string, string> = {
  tracks: "序列",
  clips: "片段",
  transitions: "转场",
  cuts: "剪辑",
  media: "素材",
  cardNodes: "图卡节点",
  cardDefinitions: "卡片定义",
  filters: "滤镜",
  pixelMaps: "像素映射",
  audioFx: "音频效果",
  captions: "字幕",
};

/** 项目顶层字段 → 名字 */
const META: Record<string, string> = {
  name: "名称",
  fps: "帧率",
  width: "宽度",
  height: "高度",
  duration: "时长",
  themeId: "主题",
  camera3dFov: "三维视角",
  glRoute: "渲染路线",
  media: "素材",
  tracks: "序列",
  cuts: "剪辑",
};

const quoted = (s: string) => `「${s}」`;

/**
 * 片段怎么称呼:和时间轴上片段的标题一致(ClipView:卡片片段用卡片名,素材段用它的标签),
 * 同一张卡出现好几次时,后面带上开始时间好区分;都没有就用 id。
 */
function clipName(c: Record<string, unknown> | undefined, id: string): string {
  if (!c) return id;
  let name = "";
  if (typeof c.cardId === "string" && c.cardId) name = getCard(c.cardId)?.name ?? c.cardId;
  else if (typeof c.label === "string" && c.label.trim()) name = c.label.trim();
  if (!name) return id;
  return typeof c.start === "number" ? `${name} @${c.start.toFixed(1)}s` : name;
}

/** 实体 → 给人看的名字,例如 `片段「开头空镜」`、`序列「序列 1」`、`项目设置「帧率」` */
export function entityLabel(entity: string, project: Project | null): string {
  if (entity === "*") return "整个项目";
  if (entity.startsWith("/meta/")) {
    const key = entity.slice("/meta/".length).replace(/~1/g, "/").replace(/~0/g, "~");
    return `项目设置${quoted(META[key] ?? key)}`;
  }
  const segs = parsePath(entity);
  if (!segs || segs.length < 2) return entity;
  const coll = segs[segs.length - 2];
  const id = segs[segs.length - 1].replace(/^@/, "");
  const kind = KIND[coll] ?? "条目";
  const value = project ? (getAt(project, entityValuePath(entity)) as Record<string, unknown> | undefined) : undefined;
  if (coll === "clips") return `片段${quoted(clipName(value, id))}`;
  const name = value && typeof value.name === "string" && value.name.trim() ? value.name.trim() : id;
  return `${kind}${quoted(name)}`;
}

/** 实体能不能点过去看:片段(选中并把播放头挪到开头)、序列、项目设置 */
export function clipOfEntity(entity: string): string | null {
  const m = /\/clips\/@([^/]+)$/.exec(entity);
  return m ? m[1].replace(/~1/g, "/").replace(/~0/g, "~") : null;
}

/** 本页面是谁:会话号,和连接的身份(本机空间是 `local`,共享项目是 `用户名@设备`) */
export interface Me {
  session: string;
  userId: string | null;
}

type Actor = { userId?: string; username?: string; deviceId?: string; deviceName?: string; role?: string; conversation?: number; session?: string };

/** 共享项目里的显示名:成员列表给的 displayName(重名时带设备名),按 userId 查 */
export type DisplayNames = Map<string, string>;

/** 写入身份 → 给人看的说法:`张三`、`Agent「第 2 个对话」`、`张三 · Agent · 第 2 个对话`、`你在另一个页面` */
export function writerLabel(by: Writer | undefined, me: Me, names: DisplayNames = new Map()): string {
  // 两种形状都认:`{ actor, session }`(DocSync 记的),和文档服务直接给的 actor 本身(`project.overwritten.by`)
  const raw = by as (Writer & Actor) | undefined;
  const actor = ((raw?.actor && typeof raw.actor === "object" ? raw.actor : raw && typeof raw.userId === "string" ? raw : {}) as Actor);
  const session = by?.session ?? actor.session;
  const sameUser = !!actor.userId && actor.userId === me.userId;
  if (!actor.userId && session === me.session) return "你在这个页面";
  if (actor.role === "agent") {
    const n = typeof actor.conversation === "number" ? `第 ${actor.conversation} 个对话` : "某个对话";
    if (sameUser || !actor.username) return `Agent${quoted(n)}`;
    return `${names.get(actor.userId ?? "") ?? actor.username} · Agent · ${n}`;
  }
  if (session === me.session && (sameUser || !actor.userId)) return "你在这个页面";
  if (sameUser) return "你在另一个页面";
  if (actor.userId && names.has(actor.userId)) return names.get(actor.userId)!;
  return actor.username ?? actor.userId ?? "别人";
}
