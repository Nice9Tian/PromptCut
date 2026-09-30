/**
 * 多 Agent 的「范围」(计划 `docs/plan/agent-workflow-plan.md` A3;语义 `user-workflow.md`「多 Agent」「保护」)。
 *
 * 范围写成「剪辑X->序列X」,多个用逗号分开。这里只放页面与服务端共用的纯逻辑:
 *   - `diffScopes(before, after)`:一次改动前后,当前剪辑里哪些「剪辑->序列」变了;
 *   - `scopeOverlaps(a, b)` / `overlappingScopes(written, declared)`:两个范围是否重叠(同名,或一方是另一方的上级);
 *   - `splitScopes(s)`:把声明的文字拆成一条条范围。
 *
 * 为什么是 `.mjs`:服务端(`server/agent/agent-board.mjs`,由文档服务的提交流喂)和页面(没接文档服务时,
 * 页面执行器在工具调用前后算)用同一份口径,Node 直接 import 不了 `.ts`。
 *
 * 只看项目里的 `tracks`(激活那条剪辑的内容住在 Project 上)与 `cuts` / `activeCutId`;序列的 `clips` 数组换了引用
 * 就算改了 —— store 每次改动都产新数组,文档服务的操作引擎(写时复制)也只换改到的那一路,没改到的引用不变。
 */

/** 当前剪辑的名字;项目没有 cuts(旧文件)时就是「剪辑1」 */
export function cutNameOf(project) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  const hit = cuts.find((c) => c && c.id === project?.activeCutId) ?? cuts[0];
  return typeof hit?.name === 'string' && hit.name ? hit.name : '剪辑1';
}

const tracksOf = (p) => (Array.isArray(p?.tracks) ? p.tracks.filter((t) => t && typeof t === 'object') : []);

/**
 * 一次改动前后,项目里哪些「剪辑->序列」变了。切了剪辑就整条剪辑算作范围;只调了序列的上下顺序记「剪辑->序列顺序」;
 * 主题变了记「全局主题」。别的(项目名、效果库、卡片)不算范围。
 */
export function diffScopes(before, after) {
  if (!before || !after || before === after) return [];
  const out = [];
  if ((before.activeCutId ?? null) !== (after.activeCutId ?? null)) return [cutNameOf(after)];
  const name = cutNameOf(after);
  const prev = new Map(tracksOf(before).map((t) => [t.id, t]));
  for (const t of tracksOf(after)) {
    const b = prev.get(t.id);
    if (!b || b.clips !== t.clips || b.name !== t.name || !!b.hidden !== !!t.hidden || !!b.muted !== !!t.muted || !!b.locked !== !!t.locked) {
      out.push(`${name}->${t.name}`);
    }
  }
  for (const b of tracksOf(before)) {
    if (!tracksOf(after).some((t) => t.id === b.id)) out.push(`${name}->${b.name}(已删)`);
  }
  if (out.length === 0) {
    const order = (p) => tracksOf(p).map((t) => t.id).join('\n');
    if (order(before) !== order(after)) out.push(`${name}->序列顺序`);
  }
  if (out.length === 0 && before.theme !== after.theme && JSON.stringify(before.theme ?? null) !== JSON.stringify(after.theme ?? null)) {
    out.push('全局主题');
  }
  return out;
}

/** 声明的文字 → 一条条范围(逗号、分号、顿号分开;「(已删)」这类后缀去掉再比) */
export function splitScopes(text) {
  if (typeof text !== 'string') return [];
  return text.split(/[,,;;、]/).map((x) => x.trim()).filter(Boolean);
}

const bare = (s) => s.replace(/[((]已删[))]$/, '').trim();

/** 两段范围文字有没有重叠:同名,或一方是另一方的上级(「剪辑1」包含「剪辑1->序列2」) */
export function scopeOverlaps(a, b) {
  const xs = splitScopes(a).map(bare);
  const ys = splitScopes(b).map(bare);
  return xs.some((x) => ys.some((y) => x === y || x.startsWith(y + '->') || y.startsWith(x + '->')));
}

/** 写到的范围里,落在声明范围之内的那几条 */
export function overlappingScopes(written, declared) {
  const list = Array.isArray(written) ? written : splitScopes(written);
  return list.filter((w) => scopeOverlaps(w, declared));
}
