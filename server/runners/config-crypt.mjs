/**
 * ai.json 里的 API Key 落盘加密。
 *
 * 用的是和分发密文同一套信封(PBKDF2-SHA256 + AES-256-GCM),口令换成本机指纹,
 * AAD 换成落盘专用的那一串——所以分发密文和落盘密文不会互相解错。
 *
 * 它挡的是「明文躺在文件里」这一类意外:同步盘、备份、误提交、截屏、别人借用
 * 你电脑时随手打开配置目录。它**挡不住**能在这台机器上以你的身份跑代码的人——
 * 口令是机器自己算出来的,推导逻辑也随软件一起发出去了,他跑一遍就有。
 * 想要更硬的,该上 Windows DPAPI / macOS Keychain 这类由操作系统托管密钥的方案。
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { machineFingerprint } from "./machine-id.mjs";

const PREFIX = "PCENC1.";
const AAD = Buffer.from("PromptCut-config-at-rest-v1");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ITERATIONS = 600_000;

/**
 * 派生结果按 salt 缓存。readConfig() 每次请求都会被调到,
 * 不缓存的话每次都要跑 60 万轮 PBKDF2,接口会明显变慢。
 */
const keyCache = new Map();

function deriveKey(salt, iterations) {
  const cacheKey = `${salt.toString("hex")}:${iterations}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = pbkdf2Sync(`PromptCut-at-rest|${machineFingerprint()}`, salt, iterations, 32, "sha256");
    // 只可能有「当前这份配置」和「刚换过的上一份」,不会长
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(cacheKey, key);
  }
  return key;
}

/** 这个值是不是已经加密过了 */
export function isSealed(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** 明文 Key → 落盘密文。空值原样返回,不给空串套一层壳 */
export function sealKey(plain) {
  if (!plain) return "";
  if (isSealed(plain)) return plain;
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt, ITERATIONS), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(ITERATIONS, 0);
  return PREFIX + Buffer.concat([header, salt, iv, body, cipher.getAuthTag()]).toString("base64url");
}

/**
 * 落盘密文 → 明文 Key。
 *
 * 不是密文就原样返回:老配置里存的是明文,不能因为升级了就把人家的 Key 弄丢;
 * 解不开也返回空串而不是抛错——换了机器、拷贝过来的配置就该表现为「没设 Key」,
 * 让用户重新填,而不是让整个设置接口 500。
 */
export function openKey(sealed) {
  if (!sealed) return "";
  if (!isSealed(sealed)) return String(sealed);
  try {
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64url");
    if (raw.length < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES) return "";
    const iterations = raw.readUInt32BE(0);
    if (iterations < 10_000 || iterations > 5_000_000) return "";
    const salt = raw.subarray(4, 4 + SALT_BYTES);
    const iv = raw.subarray(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
    const body = raw.subarray(4 + SALT_BYTES + IV_BYTES, raw.length - TAG_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt, iterations), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
