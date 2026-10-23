/**
 * A2 的凭据保管:把 refresh token 加密存在拉取方这一侧
 * (任务书 `docs/plan/drive-connector-task.md` 第 3 节「A2 的保管规矩」)。
 *
 * 用户 2026-10-22 授权「凭证由云端代替保存」,2026-10-23 又定不押后。这一层就是落实那条授权。
 *
 * # 按「项目 × 成员 × 提供方」分开
 *
 * 一份凭据只在它那一格里有效。别的成员读不到,别的项目用不了 —— 和素材服务「不能跨项目读」同一条线
 * (语义 `docs/semantics/product/asset-service.md`)。
 *
 * # 加密落盘,而且和它那一格绑死
 *
 * AES-256-GCM,密钥是 `<dir>/connector-key` 里的 32 字节(首次用时随机生成)。**附加认证数据(AAD)取那一格的
 * 标识**:把文件挪到另一个项目 / 另一个成员的格子里,解密就失败。这比现有项目凭证的明文落盘高一档,
 * 因为这是第三方凭据 —— 泄漏的后果落在用户的 Google 账号上,不只落在这个项目里。
 *
 * 写入走临时文件加改名(照 `../auth/store.mjs` 的做法),中途断电不会留下半份。
 *
 * # 明文一律不出这个模块
 *
 * `list` 只回元信息,不回令牌。错误信息里不带令牌。调用方要用就调 `get`,用完别往别处传。
 *
 * 只用 Node 内置模块。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageConnectorError } from './provider.mjs';

const KEY_FILE = 'connector-key';
const SUB_DIR = 'connectors';
const VERSION = 1;
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/** 一格的标识:三段拼起来。既当文件名的来源,也当 AAD */
function scopeKey({ projectId, userId, provider }) {
  for (const [k, v] of Object.entries({ projectId, userId, provider })) {
    if (typeof v !== 'string' || !v) throw new TypeError(`scope.${k} required`);
    if (v.includes('\u0000')) throw new TypeError(`scope.${k} has NUL`);
  }
  return `${projectId}\u0000${userId}\u0000${provider}`;
}

function fileFor(dir, key) {
  return path.join(dir, SUB_DIR, `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
}

/**
 * 取(必要时生成)这台机器上的加密密钥。
 *
 * 和 `../auth/store.mjs` 的 `auth/server.json` 一样:首次用时生成,之后只读。生成用 `wx`,
 * 几个进程同时起也只会有一份。
 */
function loadKey(dir) {
  const file = path.join(dir, KEY_FILE);
  try {
    const raw = fs.readFileSync(file);
    const key = Buffer.from(raw.toString('utf8').trim(), 'base64');
    if (key.length === 32) return key;
    throw new StorageConnectorError(`凭据密钥长度不对(${file})`, 'bad-key');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, key.toString('base64'), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    // 另一个进程抢先生成了,用它那份
    return Buffer.from(fs.readFileSync(file).toString('utf8').trim(), 'base64');
  }
  return key;
}

/**
 * @param {object} p
 * @param {string} p.dir 放密钥与凭据的目录。这个目录不经任何静态服务暴露
 * @param {() => number} [p.now]
 */
export function createCredentialStore({ dir, now = Date.now }) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir required');
  let key = null;
  const theKey = () => (key ??= loadKey(dir));

  /** 把明文裹成落盘的形状 */
  function seal(scope, secret) {
    const aad = Buffer.from(scopeKey(scope), 'utf8');
    const iv = crypto.randomBytes(IV_BYTES);
    const c = crypto.createCipheriv(ALGO, theKey(), iv);
    c.setAAD(aad);
    const data = Buffer.concat([c.update(Buffer.from(secret, 'utf8')), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  function open(scope, rec) {
    const aad = Buffer.from(scopeKey(scope), 'utf8');
    const d = crypto.createDecipheriv(ALGO, theKey(), Buffer.from(rec.iv, 'base64'));
    d.setAAD(aad);
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8');
  }

  return {
    /**
     * 存一份。同一格再存就覆盖(用户重新授权时就该覆盖)。
     * @param {{projectId: string, userId: string, provider: string}} scope
     * @param {{ refreshToken: string, scope?: string }} cred
     */
    async put(scope, cred) {
      const k = scopeKey(scope);
      if (typeof cred?.refreshToken !== 'string' || !cred.refreshToken) throw new TypeError('refreshToken required');
      const file = fileFor(dir, k);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const existing = await readRaw(file);
      const rec = {
        v: VERSION,
        projectId: scope.projectId,
        userId: scope.userId,
        provider: scope.provider,
        grantedScope: typeof cred.scope === 'string' ? cred.scope : '',
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        ...seal(scope, cred.refreshToken),
      };
      // 临时文件加改名:中途断电不会留下半份
      const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(rec), { mode: 0o600 });
      await fsp.rename(tmp, file);
      return { createdAt: rec.createdAt, updatedAt: rec.updatedAt };
    },

    /** 取出来用。没有回 null;解密不过(密钥换了、文件被挪过格子)抛 `bad-credential` */
    async get(scope) {
      const k = scopeKey(scope);
      const rec = await readRaw(fileFor(dir, k));
      if (!rec) return null;
      let refreshToken;
      try {
        refreshToken = open(scope, rec);
      } catch (e) {
        throw new StorageConnectorError(
          '存着的网盘授权解不开:密钥变了,或者这份记录不属于这个项目 / 成员。请重新授权',
          'bad-credential',
          { cause: e },
        );
      }
      return {
        refreshToken,
        grantedScope: String(rec.grantedScope || ''),
        createdAt: Number(rec.createdAt) || 0,
        updatedAt: Number(rec.updatedAt) || 0,
      };
    },

    /** 删掉一格。本来就没有也算成功(撤销要幂等) */
    async remove(scope) {
      await fsp.rm(fileFor(dir, scopeKey(scope)), { force: true });
    },

    /**
     * 列出有哪些格子有凭据。**只回元信息,不回令牌** —— 这是给「已连接的网盘」那个管理界面用的。
     * @param {{ projectId?: string, userId?: string }} [filter]
     */
    async list(filter = {}) {
      let names;
      try { names = await fsp.readdir(path.join(dir, SUB_DIR)); } catch (e) {
        if (e?.code === 'ENOENT') return [];
        throw e;
      }
      const out = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const rec = await readRaw(path.join(dir, SUB_DIR, name));
        if (!rec) continue;
        if (filter.projectId && rec.projectId !== filter.projectId) continue;
        if (filter.userId && rec.userId !== filter.userId) continue;
        out.push({
          projectId: rec.projectId,
          userId: rec.userId,
          provider: rec.provider,
          grantedScope: String(rec.grantedScope || ''),
          createdAt: Number(rec.createdAt) || 0,
          updatedAt: Number(rec.updatedAt) || 0,
        });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /** 踢人、改密退出、删项目时一把清掉。回清掉了几格 */
    async removeAll(filter) {
      const rows = await this.list(filter);
      for (const r of rows) await this.remove({ projectId: r.projectId, userId: r.userId, provider: r.provider });
      return rows.length;
    },
  };
}

async function readRaw(file) {
  try {
    const rec = JSON.parse(await fsp.readFile(file, 'utf8'));
    return rec?.v === VERSION ? rec : null;
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    return null;   // 文件坏了当没有,别让一份坏记录挡住整个列表
  }
}
