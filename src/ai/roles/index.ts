/**
 * 角色提示词。一个角色一个 .md 文件,放进本目录即可,不用改这里。
 *
 * 「一键配特效」就是按 ORDER 里的顺序把这些角色依次跑一遍:
 * 先让剪辑导演把素材排成一条片子,再让特效助理配字幕和动效。
 * 拆成角色而不是一整段长提示词,是因为这两步要的东西不一样 ——
 * 排片得先看全部素材,配特效得先有文字稿 —— 混在一轮里模型容易顾此失彼。
 *
 * 文件名用 ASCII,中文名写在文件里的一级标题上:这些名字会进构建产物和
 * 打包脚本,ASCII 路径在 Windows 的各种命令行环境里最不容易出岔子。
 */

export interface Role {
  /** 文件名去掉扩展名,例如 director */
  id: string;
  /** 文件里的一级标题,例如「剪辑导演」 */
  name: string;
  /** 标题以下的全部正文,发给 AI 的就是它 */
  prompt: string;
}

/**
 * 跑的顺序。没列进来的文件仍然会被读出来(可以单独调用),但不进「一键配特效」。
 * 将来加角色:建好 .md,把 id 放进这个数组。
 */
export const WORKFLOW_ORDER = ["director", "fx-assistant"] as const;

const files = import.meta.glob<string>("./*.md", { eager: true, query: "?raw", import: "default" });

function parse(path: string, raw: string): Role {
  const id = path.replace(/^\.\//, "").replace(/\.md$/, "");
  const lines = raw.split(/\r?\n/);
  const headingAt = lines.findIndex((l) => l.startsWith("# "));
  const name = headingAt >= 0 ? lines[headingAt].slice(2).trim() : id;
  const prompt = (headingAt >= 0 ? lines.slice(headingAt + 1) : lines).join("\n").trim();
  return { id, name, prompt };
}

/** 目录里的全部角色,按文件名排序 */
export const ALL_ROLES: Role[] = Object.entries(files)
  .map(([path, raw]) => parse(path, raw))
  .filter((r) => r.prompt !== "")
  .sort((a, b) => a.id.localeCompare(b.id));

/** 「一键配特效」按顺序要跑的那几个角色 */
export const WORKFLOW_ROLES: Role[] = WORKFLOW_ORDER
  .map((id) => ALL_ROLES.find((r) => r.id === id))
  .filter((r): r is Role => !!r);
