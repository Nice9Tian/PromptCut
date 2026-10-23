/**
 * 游客令牌的签名密钥：这台文档服务自己的一把 HMAC 密钥，只在进程里用，不发给任何人。
 *
 * 为什么要落盘：密钥一换，所有在手的游客令牌就全不认了 —— 游客会在重启的那一刻丢掉身份，
 * 连自己刚建的项目都进不去。所以第一次跑的时候生成一把存下来，之后每次读同一把。
 *
 * 放在数据目录的 `secrets/guest-key`，和集群令牌同一个地方、同样 0600。读不了也写不了时回 null，
 * 这时游客这条路整条关掉（路由回 503 `guest-unavailable`），而不是换一把新的把老游客全踢下线，
 * 也不是把整个文档服务拖垮 —— 账号那条路和它没关系。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const GUEST_KEY_FILE = 'guest-key';
/** 32 字节，HMAC-SHA256 的块大小之内，写成 base64url 存 */
const GUEST_KEY_BYTES = 32;

/**
 * 读出来，没有就生成一把存下。
 * @param {string} dataDir 文档服务的数据目录
 * @param {(event: object) => void} [onDiagnostic]
 * @returns {Buffer | null} 拿不到就是 null（游客这条路关掉）
 */
export function openGuestKey(dataDir, onDiagnostic = () => {}) {
  if (typeof dataDir !== 'string' || !dataDir) return null;
  const dir = path.join(dataDir, 'secrets');
  const file = path.join(dir, GUEST_KEY_FILE);
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    const key = Buffer.from(saved, 'base64url');
    if (key.length === GUEST_KEY_BYTES) return key;
    // 存坏了不自己改写:改写等于换一把,会把在手的令牌全作废。报出来,由人决定
    onDiagnostic({ code: 'guest-key-malformed' });
    return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') { onDiagnostic({ code: 'guest-key-unreadable', detail: String(error?.code ?? 'read') }); return null; }
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = randomBytes(GUEST_KEY_BYTES);
    // wx:两个进程同时起的时候只有一个写得成,另一个落到下面的重读,不会各写各的
    fs.writeFileSync(file, key.toString('base64url'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try {
        const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
        if (key.length === GUEST_KEY_BYTES) return key;
      } catch { /* 落到下面一起报 */ }
    }
    onDiagnostic({ code: 'guest-key-unwritable', detail: String(error?.code ?? 'write') });
    return null;
  }
}
