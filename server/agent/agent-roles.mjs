/**
 * `spawn_agent` 的预设角色(计划 `docs/plan/agent-workflow-plan.md` A3;`user-workflow.md`「多 Agent」:
 * 主 Agent 拉起其它 Agent 时可以给它们附加预设的角色)。
 *
 * 角色提示词就是 `src/ai/roles/` 下的那几份 .md(页面的「一键配特效」也读它们,`src/ai/roles/index.ts`),
 * 这里在服务端按同样的规则读:一级标题是中文名,标题以下是提示词,开头的 frontmatter 去掉。
 * 分工模式归档后,只做拆解调度的「制片主管」(manager.md)一并删了;能被拉起的是下面 `SPAWN_ROLE_IDS` 列的几个。
 *
 * 子 Agent 每一轮的系统提示词里都拼上它的角色提示词(`vite-plugin-ai.ts` 的 `/api/ai/chat`),不只第一条消息:
 * 多轮跑下来最容易忘掉自己是谁。
 */
import fs from 'node:fs';

/** 能被拉起的预设角色(`spawn_agent` 的 `role` 可选值),顺序即工具说明里的顺序 */
export const SPAWN_ROLE_IDS = Object.freeze(['director', 'fx-assistant', 'collector']);

/** 工具表里给模型看的一句话说明(工具表是静态的,不在加载时读文件) */
export const SPAWN_ROLE_HINTS = Object.freeze({
  director: '剪辑导演:看齐素材,排顺序放上时间轴,编排剧本',
  'fx-assistant': '特效助理:给视频配字幕,按内容配动效卡',
  collector: '素材收集员:把网页链接里的视频抓进素材库',
});

const ROLES_DIR = new URL('../../src/ai/roles/', import.meta.url);

function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length) : raw;
}

/** 读一份角色;文件不在回 null */
export function loadRole(id) {
  if (!SPAWN_ROLE_IDS.includes(id)) return null;
  let raw;
  try {
    raw = fs.readFileSync(new URL(`${id}.md`, ROLES_DIR), 'utf8');
  } catch {
    return null;
  }
  const lines = splitFrontmatter(raw).split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('# '));
  const name = at >= 0 ? lines[at].slice(2).trim() : id;
  const prompt = (at >= 0 ? lines.slice(at + 1) : lines).join('\n').trim();
  return prompt ? { id, name, prompt } : null;
}

/** 角色 id → 中文名(页签名、提示里用);不认识的原样回 */
export function roleName(id) {
  return loadRole(id)?.name ?? (typeof id === 'string' ? id : '');
}
