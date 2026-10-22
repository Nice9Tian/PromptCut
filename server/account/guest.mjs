/**
 * 游客主体：没有网站账号的人在云端的那一个身份（2026-10-23 用户定）。
 *
 * 和账号的区别只有两条，别的地方一律按同一套走（同一个权限判断、同一套票据、同一份成员名单）：
 *
 * 1. **谁签发、谁核对**：账号的访问令牌由 VisuHive 账号服务签发、文档服务拿去问它（`client.mjs` 的 `verify`）；
 *    游客令牌由文档服务**自己**签发、自己核对，不问账号服务。所以账号服务不认识游客，也不必认识。
 * 2. **能做的事有限**：自己建的项目最多一个、素材最多三条每条 100 MB、三天清理；进别人的项目一律只读。
 *    前两条在这里，只读在 `authority.mjs` 的 `joinProject`（游客入别人的名单时按 `'r'` 落账）。
 *
 * 令牌是**持有即身份**的东西：编号由服务端随机生成，不收页面报上来的编号，否则谁都能自称是别人。
 * 页面把令牌存在自己那一侧（`src/account/guest.ts`），续期时把旧的交回来换一张新的；过期了就换一个新身份。
 *
 * 形状：`gst1` + `base64url(JSON)` + 43 个字符的 `base64url(HMAC-SHA256)`，整串只有 `[A-Za-z0-9_-]`。
 * **不带点号**是硬要求：它要当 `Authorization: Bearer` 送出去，而那一层只认这个字符集
 * （`server/docservice/modules/account-projects.mjs` 的 `bearer`），带点号会被当成没登录挡回来。
 * 签名段定长，所以从尾部切就分得开两段，不需要分隔符。先验签名再采信字段。
 *
 * 「这张是不是游客令牌」由**签名**说了算，不由前缀说了算：验得过就一定是本服务发的，
 * 验不过就交给账号服务去认。前缀只在「这台没配密钥」时拿来说一句人话。令牌原文不进日志、不进错误信息。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { accountError } from './client.mjs';

/** 游客编号：`gst_` + 24 位十六进制。和账号编号 `acc_` + 24 位同形状，成员名单、权限判断里当一类键用 */
export const GUEST_ID_RE = /^gst_[0-9a-f]{24}$/;
export const isGuestId = value => typeof value === 'string' && GUEST_ID_RE.test(value);

/** 令牌的前缀。和 `v1.`（连接票据、委托）岔开，拿错了一眼就看得出 */
const GUEST_TOKEN_PREFIX = 'gst1';
/** 签名段的长度：HMAC-SHA256 的 32 字节写成 base64url 固定 43 个字符。定长才能从尾部切开 */
const SIGNATURE_LENGTH = 43;
/** 跟着连接票据那一套，允许 30 秒时钟偏差 */
const CLOCK_SKEW_MS = 30_000;
/** 令牌最长多少字节：超过的连解都不解，免得拿超大串去喂哈希 */
const MAX_TOKEN_LENGTH = 1024;

/**
 * 游客的限额（三级机制的数，2026-10-23 用户定）。要改只改这里：
 *   projects    自己能建几个项目
 *   assets      能传几条素材
 *   assetBytes  一条素材最大多少字节
 *   ttlMs       建起来多久之后清理（项目和素材一起清）
 *   tokenTtlMs  一张令牌多久过期。比 ttlMs 短，页面在这期间续期；过了就换一个新身份
 */
export const GUEST_LIMITS = Object.freeze({
  projects: 1,
  assets: 3,
  assetBytes: 100 * 1024 * 1024,
  ttlMs: 3 * 24 * 60 * 60 * 1000,
  tokenTtlMs: 24 * 60 * 60 * 1000,
});

const b64url = buffer => Buffer.from(buffer).toString('base64url');
const unb64url = text => Buffer.from(text, 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/** 随机一个游客编号。只有服务端生成，不收页面报上来的 */
export const newGuestId = () => 'gst_' + randomBytes(12).toString('hex');

/**
 * 签一张游客令牌。
 * @param {object} options
 * @param {Buffer|string} options.key HMAC 密钥（`guestKey`，由部署方给，和票据密钥各一份）
 * @param {string} [options.guestId] 续期时传旧编号接着用；不传就随机一个新的
 * @param {number} options.at 现在是什么时候（毫秒）
 * @param {number} [options.ttlMs] 有效期，缺省 `GUEST_LIMITS.tokenTtlMs`
 * @returns {{ token: string, guestId: string, issuedAt: number, expiresAt: number }}
 */
export function signGuestToken({ key, guestId, at, ttlMs = GUEST_LIMITS.tokenTtlMs }) {
  if (!key) throw accountError(503, 'guest-configuration');
  if (!Number.isSafeInteger(at)) throw accountError(503, 'guest-configuration');
  const id = guestId === undefined ? newGuestId() : guestId;
  if (!isGuestId(id)) throw accountError(400, 'invalid-guest');
  const payload = { v: 1, k: 'gst', g: id, iat: at, exp: at + ttlMs };
  const body = `${GUEST_TOKEN_PREFIX}${b64url(JSON.stringify(payload))}`;
  return { token: `${body}${b64url(hmac(key, body))}`, guestId: id, issuedAt: payload.iat, expiresAt: payload.exp };
}

/**
 * 这串看着像不像游客令牌。**只用来在「这台没配密钥」时说一句人话**：真正认不认由签名决定
 * （`readGuestToken`），前缀谁都写得出来。
 */
export const looksLikeGuestToken = token =>
  typeof token === 'string' && token.length <= MAX_TOKEN_LENGTH &&
  new RegExp(`^${GUEST_TOKEN_PREFIX}[A-Za-z0-9_-]{${SIGNATURE_LENGTH + 16},}$`).test(token);

/**
 * 核一张游客令牌：先验签名，再采信里面的字段。
 *
 * @returns {{ guestId: string, issuedAt: number, expiresAt: number, expired: boolean } | null}
 *   `null` 表示「这不是本服务发的」（签名对不上、形状不对），调用方该把它交给账号服务去认；
 *   回了对象就一定是本服务发的，`expired` 为真表示签名没问题但已经过期 —— 这时不能再放行，
 *   但也不该拿去问账号服务（问了只会得到一个莫名其妙的错）。不说别的细节。
 */
export function readGuestToken(token, { key, at }) {
  if (typeof token !== 'string' || token.length <= GUEST_TOKEN_PREFIX.length + SIGNATURE_LENGTH ||
    token.length > MAX_TOKEN_LENGTH || !token.startsWith(GUEST_TOKEN_PREFIX) || !key || !Number.isSafeInteger(at)) return null;
  const body = token.slice(0, -SIGNATURE_LENGTH);
  let given;
  try { given = unb64url(token.slice(-SIGNATURE_LENGTH)); } catch { return null; }
  const want = hmac(key, body);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let payload;
  try { payload = JSON.parse(unb64url(body.slice(GUEST_TOKEN_PREFIX.length)).toString('utf8')); } catch { return null; }
  if (payload?.v !== 1 || payload.k !== 'gst' || !isGuestId(payload.g)) return null;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat) return null;
  return { guestId: payload.g, issuedAt: payload.iat, expiresAt: payload.exp, expired: at > payload.exp + CLOCK_SKEW_MS };
}

/**
 * 令牌核过之后，摆成 `authority.mjs` 里主体该有的样子。字段名和账号主体一一对应，
 * 下游（`authorizePrincipal`、`checkAccess`、票据签发）不用区分这是账号还是游客。
 *
 * - `accountId` 就是游客编号，成员名单、禁入表都用它当键；
 * - `loginId` 带 `guest:` 前缀，和账号的登录号不会撞，撤销表（`revokedLogins`）照样按它查；
 * - `accountEventSeq` 恒为 0：游客不在账号服务的事件流里，不能让它把文档服务卡在「等账号事件」上。
 */
export function guestPrincipal({ guestId, issuedAt, expiresAt }) {
  return {
    guest: true,
    accountId: guestId,
    accountName: null,
    loginId: `guest:${guestId}`,
    credentialId: `guest:${guestId}:${issuedAt}`,
    loginGeneration: 1,
    accountEventSeq: 0,
    expiresAt,
  };
}

/**
 * 游客自己建的项目到上限了没有。由 `authority.mjs` 的 `checkCreateProject` 直接问，
 * 不走部署方可配的 `createPolicy`：这一条是游客身份自带的，不该因为某次部署忘了配就没了。
 * 账号一律回 false，它的数量由 `maxProjectsPerAccount` 管。
 */
export const guestProjectLimitReached = ({ accountId, ownedCount }) =>
  isGuestId(accountId) && (ownedCount ?? 0) >= GUEST_LIMITS.projects;

/**
 * 这条素材收不收：游客只能传 `GUEST_LIMITS.assets` 条，每条不超过 `assetBytes`。
 * 账号不受这两条限制，直接放行。
 *
 * @param {object} args
 * @param {string} args.accountId 谁在传
 * @param {number} args.bytes 这一条多大
 * @param {number} args.storedCount 他已经存着几条
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function checkGuestAsset({ accountId, bytes, storedCount }) {
  if (!isGuestId(accountId)) return { ok: true };
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, code: 'invalid-asset' };
  if (bytes > GUEST_LIMITS.assetBytes) return { ok: false, code: 'guest-asset-too-large' };
  if ((storedCount ?? 0) >= GUEST_LIMITS.assets) return { ok: false, code: 'guest-asset-limit' };
  return { ok: true };
}

/** 这个游客建的东西该清了没有（三天）。`createdAt` 是落账时刻 */
export const guestExpired = (createdAt, at, ttlMs = GUEST_LIMITS.ttlMs) =>
  Number.isSafeInteger(createdAt) && Number.isSafeInteger(at) && at - createdAt >= ttlMs;

/** 人话的错误文案。页面照 `accountErrorText` 那张表显示，这里给服务端日志和测试对照用 */
export const GUEST_ERROR_TEXT = Object.freeze({
  'guest-project-limit': `游客只能建 ${GUEST_LIMITS.projects} 个项目。`,
  'guest-asset-limit': `游客最多上传 ${GUEST_LIMITS.assets} 条素材。`,
  'guest-asset-too-large': `游客上传的每条素材不能超过 ${GUEST_LIMITS.assetBytes / 1024 / 1024} MB。`,
  'guest-read-only': '游客在别人的项目里只能查看。',
});
