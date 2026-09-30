/**
 * Agent 会话登记表(计划 `docs/plan/agent-workflow-plan.md` A1,供 A2～A4 用):对话 ID → 这个会话是谁。
 *
 *   - `type`:`api`(AI 栏 API 直连)/ `cli`(AI 栏走命令行工具,经 MCP 回调)/ `desktop`(桌面 APP 的会话:
 *     今后经 MCP 直连来的,现在的 SKILL 无头实例也算);
 *   - `vendor`:厂商(claude、codex、agy,API 直连填设置里的厂商);
 *   - `role`:角色(现在只有 AI 栏的主对话 `main`;A3 多 Agent 拉起的子 Agent 带自己的角色);
 *   - `override`:这个对话单独设的创造力等级,`null` = 跟项目。
 *
 * 等级规则(`user-workflow.md`「创造力等级」):AI 栏的对话取自己的覆盖值,没有就跟项目;
 * 桌面 APP 的会话一律跟项目。**没登记过的对话 ID 当桌面 APP 会话**:AI 栏的对话每次发消息都会先登记
 * (`/api/ai/chat`),登记表里没有的调用只可能来自别处(SKILL 无头实例、手工挂上的 MCP 客户端)。
 *
 * 登记表只在内存里,进程重启就清空 —— AI 栏下一次发消息会重新登记,没有要持久化的东西。
 */
import { effectiveCreativity, normalizeCreativity } from '../../src/kernel/creativity.mjs';

export const SESSION_TYPES = Object.freeze(['api', 'cli', 'desktop']);

/** 登记表的上限:超了按最久没动的先丢(一个编辑器进程正常只有几个对话) */
const MAX_SESSIONS = 256;

/**
 * @param {{ headless?: boolean, now?: () => number }} [options]
 *   headless:这个进程是 SKILL 无头实例(`PROMPTCUT_HEADLESS=1`),进来的调用都是桌面 APP 会话
 */
export function createAgentSessions({ headless = false, now = () => Date.now() } = {}) {
  /** key('' = 没带对话 ID)→ 记录 */
  const sessions = new Map();

  const keyOf = (id) => (typeof id === 'string' ? id : '');

  function desktopEntry(key) {
    return { id: key, type: 'desktop', vendor: null, role: null, override: null, registeredAt: null, lastSeen: null };
  }

  return {
    /**
     * 登记或更新一个对话。AI 栏每次发消息调一次:驱动、等级都可能在两条消息之间被用户换掉。
     * 无头实例里不登记 AI 栏的对话 —— 那边的调用都按桌面 APP 会话算。
     */
    register(id, { type, vendor = null, role = 'main', creativity = null } = {}) {
      const key = keyOf(id);
      if (headless) return this.get(key);
      const t = SESSION_TYPES.includes(type) ? type : 'desktop';
      const entry = {
        id: key,
        type: t,
        vendor: typeof vendor === 'string' && vendor ? vendor.slice(0, 64) : null,
        role: typeof role === 'string' && role ? role.slice(0, 64) : null,
        // 桌面 APP 的会话跟随项目,不收覆盖值
        override: t === 'desktop' ? null : normalizeCreativity(creativity),
        registeredAt: sessions.get(key)?.registeredAt ?? now(),
        lastSeen: now(),
      };
      sessions.delete(key);
      sessions.set(key, entry);
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      return { ...entry };
    },

    /** 这个对话的记录;没登记过回一条桌面 APP 会话的记录(不写进表) */
    get(id) {
      const key = keyOf(id);
      const hit = headless ? null : sessions.get(key);
      return hit ? { ...hit } : desktopEntry(key);
    },

    /** 这个对话生效的等级与来源。`projectLevel` 是项目当前的默认等级 */
    creativityOf(id, projectLevel) {
      const entry = this.get(id);
      const level = effectiveCreativity(entry.override, projectLevel);
      const source = entry.override
        ? '这个对话单独设的'
        : entry.type === 'desktop' ? '桌面 APP 会话跟随项目的默认等级' : '跟随项目的默认等级';
      return { level, source, entry };
    },

    /** 记一次调用(给 A2 起的「谁在动」用;没登记过的不写进表) */
    touch(id) {
      const hit = sessions.get(keyOf(id));
      if (hit) hit.lastSeen = now();
    },

    list() {
      return [...sessions.values()].map((e) => ({ ...e }));
    },
  };
}
