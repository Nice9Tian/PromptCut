/**
 * 解开「API 配置分发密文」(`PCAI1.` 开头的那一段文本)——Agent 服务节点上的 Key 导入用。
 *
 * 信封与 `src/ai/configShare.ts`、`tools/api-share-gui/src/share.rs`、`tools/make-api-share.py` 逐字节相同:
 *   PCAI1. + base64url( 迭代轮数(4 字节大端) + salt(16) + iv(12) + AES-256-GCM 密文 + 标签(16) )
 *   口令:本机识别码归一化之后的 20 个字符(`normalizePassword`);PBKDF2-SHA256;AAD 是 `PromptCut-api-share-v1`。
 * 用户在自己的电脑上用 `make-api-share.bat` 把 Key 加密成这样一段,口令是节点报出的识别码——只有这台节点算得出同一串码,
 * 密文转发给别的机器解不开。明文 Key 只经用户自己的手,会话与传输途中只有这段密文。
 *
 * 本文件只解不加(加密在用户的电脑上做;测试里用 `src/ai/configShare.ts` 的 `encryptConfig` 生成,它与这里是同一份信封的两端)。
 * 不引用 `src/`(独立入口对前端代码的依赖只经一处载入缝);不打印任何内容,出错只抛带中文原因的 `ShareBlobError`。
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';

export const SHARE_PREFIX = 'PCAI1.';
const AAD = Buffer.from('PromptCut-api-share-v1');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 解不开或内容不对的原因。`code`:`not-a-blob` | `bad-format` | `truncated` | `bad-header` | `wrong-machine` | `bad-content` */
export class ShareBlobError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShareBlobError';
    this.code = code;
  }
}

/**
 * 口令归一化,与 `configShare.ts` 的 `normalizePassword` 一步不差:识别码(PCM 开头)是人从聊天窗口抄来的,
 * 去掉分隔符、统一大写、纠形近字(O→0、I/L→1、U→V);别的口令原样用。
 */
export function normalizePassword(input) {
  const text = String(input ?? '').trim();
  if (!/^PCM/i.test(text)) return text;
  return text.toUpperCase().replace(/^PCM/, '').replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}

/**
 * 解开密文。
 * @param {string} blob 密文文本(聊天软件插进来的空白、换行会被先去掉)
 * @param {string} code 这台机器的识别码(`server/runners/machine-id.mjs` 的 `machineCode()`)
 * @returns {{ vendor: string, baseUrl: string, model: string, apiKey: string, maxTokens?: number, note?: string, expiresAt?: number }}
 */
export function decryptShareBlob(blob, code) {
  const text = String(blob ?? '').replace(/\s+/g, '');
  if (!text.startsWith(SHARE_PREFIX)) throw new ShareBlobError('not-a-blob', '这段文本不是 PromptCut 的配置密文(应以 PCAI1. 开头)。请确认交来的是 make-api-share.bat 生成的那一整段。');
  const body = text.slice(SHARE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new ShareBlobError('bad-format', '密文格式不对:里面有不该出现的字符,可能夹进了别的内容或被改过。请让对方重新复制完整的密文。');
  const raw = Buffer.from(body, 'base64url');
  if (raw.length < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES) throw new ShareBlobError('truncated', '密文被截断了,没有复制全。请让对方重发完整内容。');
  const iterations = raw.readUInt32BE(0);
  // 别拿密文里的轮数去跑一个能把节点卡死的数
  if (iterations < 10_000 || iterations > 5_000_000) throw new ShareBlobError('bad-header', '密文头部异常(迭代轮数不在合理范围),拒绝解析。密文可能被改过,请重新生成。');
  const salt = raw.subarray(4, 4 + SALT_BYTES);
  const iv = raw.subarray(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
  const cipher = raw.subarray(4 + SALT_BYTES + IV_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const password = normalizePassword(code);
  if (!password) throw new ShareBlobError('wrong-machine', '没有取到这台机器的识别码,没法解密。');
  let plain;
  try {
    const key = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(AAD);
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(cipher), d.final()]).toString('utf8');
  } catch {
    // AES-GCM 的校验标签对不上:口令不对(密文不是按这台机器的识别码生成的)和密文被改过,在密码学上分不出来,两种原因一并说
    throw new ShareBlobError('wrong-machine', '解不开:这份密文不是按这台机器的识别码生成的(识别码对不上),或者内容在传输中被改过。请核对节点报出的识别码,用它重新生成。');
  }
  let parsed;
  try { parsed = JSON.parse(plain); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') throw new ShareBlobError('bad-content', '密文解开了,但内容不是有效的配置。');
  if (typeof parsed.apiKey !== 'string' || !parsed.apiKey) throw new ShareBlobError('bad-content', '密文解开了,但里面没有 API Key。');
  return {
    vendor: typeof parsed.vendor === 'string' ? parsed.vendor : '',
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
    model: typeof parsed.model === 'string' ? parsed.model : '',
    apiKey: parsed.apiKey,
    ...(Number.isSafeInteger(parsed.maxTokens) && parsed.maxTokens > 0 ? { maxTokens: parsed.maxTokens } : {}),
    ...(typeof parsed.note === 'string' && parsed.note ? { note: parsed.note } : {}),
    ...(Number.isFinite(parsed.expiresAt) ? { expiresAt: parsed.expiresAt } : {}),
  };
}
