import { serviceIdentity } from './descriptor.mjs';

/**
 * 「这个云端项目确实不在了」的证明：客户端一侧的信任表与核对（浏览器与 Node 通用，只用 WebCrypto）。
 *
 * 证明由云端文档服务签发（`server/account/authority.mjs` 的 `status` / `legacyGoneStatus`），只有它的账本里
 * 留有墓碑（登记为已删除）的项目才签。客户端只在三样都对上时才认：
 * - 签发方：项目文件里记的协作服务地址，必须在下面的信任表里对到一个签发方；证明里的 `authorityId` 与它一致；
 * - 项目号：证明里的 `projectId` 与文件里记的房间号逐字相同；
 * - 签名：用信任表里这个签发方、这个 `kid` 的公钥验 Ed25519 签名（签的是去掉 `signature` 后的规范化 JSON）。
 *
 * 断网、超时、5xx、认证失败、没有权限、服务回「查无此项目」而没有墓碑，都得不到证明，也就不转换。
 * 证明不是登录凭证，不授予任何访问权限。
 */

/** 与 `server/account/ledger.mjs` 的 `canonicalJson` 同一个写法（那边引了 Node 模块，浏览器里不能直接引） */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * 随软件分发的信任表：哪些协作服务地址归哪个签发方、它的公钥是什么。
 *
 * - `services`：旧项目文件里可能记着的协作服务地址（`descriptor.mjs` 的 `serviceIdentity` 归一后的写法；
 *   已换下来的托管主机名读文件时已经换成新的，这里只列新的）；
 * - `origin`：向哪里问（公网上文档服务的入口，路径固定为 `/hosted/shared/account/gone`）；
 * - `keys`：`kid` → Ed25519 公钥（32 字节原始公钥的 base64url）。**空表示这个签发方的证明一律不认。**
 *
 * 这张表是产品里信任表的**唯一来源**：页面（`src/editor/sync/syncManager.ts`）调 `queryGone` 时不传别的表，
 * 也没有环境变量、配置文件、页面钩子能扩充它（桌面版就是开发服务器，`import.meta.env` 能被运行目录的 `.env.local` 改，
 * 所以连「只在开发时生效」的口子也不留）。探针要指到自己起的假文档服务时，在自己起的浏览器里拦下本模块的请求换内容
 * （`scripts/probes/lib/gone-trust-intercept.mjs`），不经产品代码。`queryGone` 的 `authorities` 参数只给命令行工具和单测用。
 *
 * 生产签发方的 `authorityId` 与公钥要在部署后由主会话填进来（公钥不是秘密；取法见
 * `server/hosted/deploy/legacy-tombstones.mjs --print-public-key`）。没填之前旧文件一律不转换，只提示。
 */
export const TRUSTED_GONE_AUTHORITIES = deepFreeze([]);

/** 信任表连同里面每一条都冻住：运行时没有任何代码能往里加签发方或钥匙 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
}

const b64url = text => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError('base64url');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** 一条信任表记录形状对不对（探针、开发时注入的表也过这一关） */
export function validAuthority(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.authorityId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(entry.authorityId)) return false;
  try { if (new URL(entry.origin).origin !== entry.origin) return false; } catch { return false; }
  if (!Array.isArray(entry.services) || !entry.services.length || !entry.keys || typeof entry.keys !== 'object') return false;
  try { for (const s of entry.services) if (serviceIdentity(s) !== s) return false; } catch { return false; }
  return Object.entries(entry.keys).every(([kid, key]) => /^[A-Za-z0-9_.:-]{1,128}$/.test(kid) && typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key));
}

/** 文件里记的协作服务地址对到哪个签发方；对不到回 null（不认识的服务，谁签的都不认） */
export function authorityFor(descriptor, authorities = TRUSTED_GONE_AUTHORITIES) {
  let service;
  try { service = serviceIdentity(descriptor?.service); } catch { return null; }
  const hits = (authorities ?? []).filter(a => validAuthority(a) && a.services.includes(service));
  // 同一个服务地址对到两个签发方是配置错误：宁可不认
  return hits.length === 1 ? hits[0] : null;
}

const PROOF_KEYS = ['authorityId', 'issuedAt', 'kid', 'projectId', 'signature', 'state', 'tombstoneRevision', 'v'];

/**
 * 核对一份证明。通过回 `{ ok: true, proof }`（只含证明自己的字段），不通过回 `{ ok: false, reason }`。
 * `reason`：`shape`（形状不对）、`authority`（签发方对不上）、`project`（项目号对不上）、`key`（没有这把钥匙）、`signature`（签名不对）。
 */
export async function verifyGoneProof(value, { descriptor, authority, subtle = globalThis.crypto?.subtle } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('shape');
  const proof = Object.fromEntries(PROOF_KEYS.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
  if (Object.keys(proof).length !== PROOF_KEYS.length || proof.v !== 1 || proof.state !== 'gone' ||
    typeof proof.authorityId !== 'string' || typeof proof.projectId !== 'string' || typeof proof.kid !== 'string' ||
    !Number.isSafeInteger(proof.tombstoneRevision) || proof.tombstoneRevision < 0 || !Number.isSafeInteger(proof.issuedAt) || proof.issuedAt < 0 ||
    typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) return fail('shape');
  if (!validAuthority(authority) || proof.authorityId !== authority.authorityId) return fail('authority');
  if (!/^sp_[a-z2-7]{26}$/.test(proof.projectId) || proof.projectId !== descriptor?.roomId) return fail('project');
  const raw = Object.hasOwn(authority.keys, proof.kid) ? authority.keys[proof.kid] : null;
  if (!raw || !subtle) return fail('key');
  const { signature, ...payload } = proof;
  try {
    const key = await subtle.importKey('raw', b64url(raw), { name: 'Ed25519' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'Ed25519' }, key, b64url(signature), new TextEncoder().encode(canonicalJson(payload)));
    return ok ? { ok: true, proof } : fail('signature');
  } catch { return fail('signature'); }
}

export const GONE_PATH = '/hosted/shared/account/gone';

/**
 * 向可信签发方问一次。结果只有四种，调用方照它办：
 * - `{ state: 'gone', proof, authority }`：拿到并核对过证明，可以转成本地项目；
 * - `{ state: 'no-tombstone' }`：签发方明确答了「没有这个项目的墓碑」，不能转换；
 * - `{ state: 'proof-rejected', reason }`：回来的东西核对不过（连错了节点、被改过），不能转换；
 * - `{ state: 'untrusted-service' }`：文件里记的服务不在信任表里，没处可问，不能转换。
 * 网络错误、超时、限速、5xx、回的不是约定的 JSON 一律抛错（`reason: 'gone-check-unavailable'`）：说不清，稍后再问。
 */
export async function queryGone(descriptor, { authorities = TRUSTED_GONE_AUTHORITIES, fetch: fetcher = globalThis.fetch, signal, subtle, timeoutMs = 8000 } = {}) {
  const authority = authorityFor(descriptor, authorities);
  if (!authority || !/^sp_[a-z2-7]{26}$/.test(descriptor?.roomId ?? '')) return { state: 'untrusted-service' };
  const unavailable = detail => Object.assign(new Error('暂时无法向云端确认项目状态'), { reason: 'gone-check-unavailable', detail });
  const url = new URL(GONE_PATH, authority.origin);
  url.searchParams.set('authorityId', authority.authorityId); url.searchParams.set('projectId', descriptor.roomId);
  let response, body;
  try {
    const limits = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    response = await fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.any(limits) });
    body = await response.json();
  } catch (error) { throw unavailable(error?.name ?? 'network'); }
  if (!body || typeof body !== 'object') throw unavailable('protocol');
  if (response.status === 404 && body.ok === false && body.code === 'no-tombstone') return { state: 'no-tombstone' };
  if (response.status === 409 && body.ok === false && body.code === 'wrong-authority') return { state: 'proof-rejected', reason: 'authority' };
  if (response.status !== 200 || body.ok !== true) throw unavailable(`http-${response.status}`);
  const checked = await verifyGoneProof(body, { descriptor, authority, subtle });
  return checked.ok ? { state: 'gone', proof: checked.proof, authority } : { state: 'proof-rejected', reason: checked.reason };
}
