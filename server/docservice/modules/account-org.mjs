/**
 * 账号级整理信息(云端分组):语义 `docs/semantics/product/document-service.md`「账号级整理信息」(拟稿,待用户过目)、
 * 设计与裁定见 `docs/reports/AGENT-claude-groups-local-cloud.md`、`docs/plan/release-021-rulings.md` 的 V22-05～09。
 *
 * 云端文档服务替每个**网站账号**存一份整理信息:云端分组、云端项目放在哪个分组、置顶、归档、手排顺序、云端对话的置顶归档。
 * 只有这个账号自己读写;**游客没有**(游客令牌一律拒);别的账号看不到。它只是对项目列表的整理,不改变项目存在状态、创建者、成员。
 *
 * 服务端把它当不透明的 JSON:**只做形状与大小检查,不认识项目**(陈旧的项目号无害,不核对成员关系)。
 * 存在文档服务数据目录下独立的文件 `accounts/<账号编号>.json`(`store.writeBlob`,先写临时文件、刷盘、改名),
 * **不进授权账本**(账本整本是一段 JSON、热路径每秒读几十上百次,不能往里加每个账号一份)。
 *
 * 版本号比较并替换:`put` 带 `baseVersion`(页面上次拿到的版本),等于当前才写、版本加一;不等回冲突并带回云端当前那份,
 * 页面据此三方合并后重传。存储接口是同步的、Node 单线程,读-比-写之间不会插进别的请求,所以这里不需要另加锁。
 *
 * 纯函数加一个存储对象,不碰 HTTP;路由在 `account-projects.mjs` 的 `/hosted/shared/account/start-org`。
 */
import { fileNameOf } from '../store/index.mjs';

/** 三级数字(2026-10-23 用户裁定 V22-07):整份、分组、项目条目、对话条目、名字与编号的上限 */
export const ORG_LIMITS = Object.freeze({
  BYTES: 256 * 1024,
  GROUPS: 200,
  PROJECTS: 5000,
  CHATS: 20000,
  NAME: 200,
  ID: 200,
});

/** 账号编号:只认网站账号(`acc_` + 24 位十六进制);游客 `gst_…` 不在内 */
export const ORG_ACCOUNT_RE = /^acc_[0-9a-f]{24}$/;

/**
 * `put` 的按账号写入限流(裁定 V22-10,三级):同一个账号任意连续 `windowMs` 里最多写 `max` 次;`get` 不限。
 * 数的由来:页面改动有 1 秒防抖(连着改只传一次),正常使用一分钟里传不了几次(改名、拖几下排序、各一次);
 * 冲突时一次同步最多多出几次重传(最多 5 次)。30 次 / 分钟 = 平均每 2 秒一次,正常用户碰不到,
 * 一个已登录账号想反复狂写同一个文件就被挡住。超了回 429 `org-rate-limited`(带 Retry-After),页面把这次改动标「待同步」稍后自动重试,不丢。
 * 限流件就是领游客令牌那条路由用的 `createGuestRateLimit`(`server/account/guest-rate.mjs`,滑动窗口、只在内存、按键各算各的),这里键是账号编号。
 */
export const ORG_WRITE_RATE = Object.freeze({ max: 30, windowMs: 60 * 1000 });

export class OrgRefused extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idOk = (v, limits) => typeof v === 'string' && v.length > 0 && v.length <= limits.ID;
const flags = (x) => ({ ...(x.pinned === true ? { pinned: true } : {}), ...(x.archived === true ? { archived: true } : {}) });
const rows = (name, v, max) => {
  if (!Array.isArray(v)) throw new OrgRefused(400, 'bad-org', `${name} 必须是数组`);
  if (v.length > max) throw new OrgRefused(413, 'org-too-large', `${name} 最多 ${max} 条`);
  for (const r of v) if (!isObj(r)) throw new OrgRefused(400, 'bad-org', `${name} 里有不是对象的条目`);
  return v;
};

/**
 * 形状与大小检查,回**只含已知字段**的拷贝(多余字段丢掉,不存别人塞进来的东西)。
 * 形状不对 400 `bad-org`;超整份大小或超条数 413 `org-too-large`。
 */
export function checkOrg(org, limits = ORG_LIMITS) {
  if (!isObj(org)) throw new OrgRefused(400, 'bad-org', 'org 必须是对象');
  if (org.v !== 1 || org.realm !== 'cloud') throw new OrgRefused(400, 'bad-org', 'org 必须是 v1、realm 为 cloud');
  const groups = rows('groups', org.groups, limits.GROUPS).map((g) => {
    if (!idOk(g.id, limits) || typeof g.name !== 'string' || g.name.trim() === '' || g.name.length > limits.NAME)
      throw new OrgRefused(400, 'bad-org', 'groups 里有编号或名字不合法的条目');
    return { id: g.id, name: g.name, ...flags(g) };
  });
  const projects = rows('projects', org.projects, limits.PROJECTS).map((p) => {
    if (!idOk(p.id, limits) || !(p.groupId === null || idOk(p.groupId, limits)))
      throw new OrgRefused(400, 'bad-org', 'projects 里有编号不合法的条目');
    return { id: p.id, groupId: p.groupId, ...flags(p) };
  });
  const chats = rows('chats', org.chats, limits.CHATS).map((c) => {
    if (!idOk(c.id, limits) || !idOk(c.projectId, limits)) throw new OrgRefused(400, 'bad-org', 'chats 里有编号不合法的条目');
    return { id: c.id, projectId: c.projectId, ...flags(c) };
  });
  const clean = { v: 1, realm: 'cloud', groups, projects, chats };
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > limits.BYTES) throw new OrgRefused(413, 'org-too-large', `整份超过 ${limits.BYTES} 字节`);
  return clean;
}

/**
 * @param {object} options
 * @param {{ readBlob(name: string): string | null, writeBlob(name: string, text: string): void }} options.store
 * @param {() => number} [options.now]
 * @param {typeof ORG_LIMITS} [options.limits] 单测换小数字用
 */
export function createAccountOrgStore({ store, now = Date.now, limits = ORG_LIMITS } = {}) {
  if (!store || typeof store.readBlob !== 'function' || typeof store.writeBlob !== 'function') throw new TypeError('createAccountOrgStore: store 必须有 readBlob / writeBlob');
  const nameOf = (accountId) => `accounts/${fileNameOf(accountId)}.json`;
  const need = (accountId) => {
    if (typeof accountId !== 'string' || !ORG_ACCOUNT_RE.test(accountId)) throw new OrgRefused(403, 'guest-org-unavailable', '游客没有分组');
  };

  function read(accountId) {
    const text = store.readBlob(nameOf(accountId));
    if (text === null) return { version: 0, org: null, updatedAt: 0 };
    try {
      const r = JSON.parse(text);
      // 文件名按账号编号定,内容里的编号对不上(被人换了文件)当没有:不把别人的整理信息给出去
      if (r?.accountId !== accountId || !Number.isSafeInteger(r.version) || r.version < 1) return { version: 0, org: null, updatedAt: 0 };
      return { version: r.version, org: r.org, updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0 };
    } catch {
      return { version: 0, org: null, updatedAt: 0 };
    }
  }

  return {
    limits,
    /** 读:没存过是 version 0、org null */
    get(accountId) {
      need(accountId);
      return read(accountId);
    },
    /**
     * 写:`baseVersion` 必须等于当前版本。不等回 `{ conflict: true, version, org }`(不抛),页面三方合并后重传;
     * 超限、形状不对抛 `OrgRefused`。
     */
    put(accountId, baseVersion, org) {
      need(accountId);
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new OrgRefused(400, 'bad-org', 'baseVersion 必须是非负整数');
      const clean = checkOrg(org, limits);
      const cur = read(accountId);
      if (cur.version !== baseVersion) return { conflict: true, version: cur.version, org: cur.org, updatedAt: cur.updatedAt };
      const next = { accountId, version: cur.version + 1, updatedAt: now(), org: clean };
      store.writeBlob(nameOf(accountId), JSON.stringify(next));
      return { conflict: false, version: next.version, org: clean, updatedAt: next.updatedAt };
    },
  };
}

export default createAccountOrgStore;
