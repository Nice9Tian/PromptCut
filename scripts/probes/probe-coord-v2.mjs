/**
 * 会话信箱 v2：服务端验证的身份、按主体寻址、幂等发送、收到 / 已处理 / 失败、设备授权（RFC 8628）。
 * 设计见 `docs/plan/coord-mailbox-identity.md`。与 `probe-coord.mjs` 的旧信箱是两个独立进程，互不读写；旧客户端零改动。
 * 只用 Node 内置模块。加密只用现成的：随机数 `randomBytes`，口令 `scrypt`，比较 `timingSafeEqual`，令牌秘密存 SHA-256。
 *
 * 对外 HTTP（nginx 只转发 `/coord/v2/` → 本进程 `/v2/`；TLS 在 nginx 终止）：
 *   GET  /v2/health                              `{ ok: true }`，不要令牌
 *   GET  /v2/whoami                              scope `status`
 *   GET  /v2/inbox?after=<seq>&wait=<秒>          scope `inbox:read`：只回发给自己的、未过期的消息
 *   POST /v2/messages                            scope `send`；头 `Idempotency-Key`；体 `{ to, kind, body, replyTo?, ttlSeconds? }`
 *   GET  /v2/messages/<id>                       发送方（send）或接收方（inbox:read）可看，别人 404
 *   POST /v2/messages/<id>/state                 接收方（inbox:read）：`{ state: received|processed|failed, detail? }`
 *   POST /v2/device/code、/v2/device/token        设备授权（客户端）
 *   GET  /v2/device、POST /v2/login、/v2/logout、/v2/device/approve   设备授权（用户浏览器里的批准页）
 * 管理口只在本机 Unix 套接字（0600）上：`POST /admin/<命令>`，网络不可达。
 *
 * 命令行：
 *   serve  --port 8800 [--host 127.0.0.1] --store <文件> --audit <文件> --admin-socket <路径> --public-base <https://…/coord/v2>
 *   admin  --socket <路径> principal-add --id <主体> --kind doger|codex|claude|other [--label <说明>] [--max-scopes a,b] [--send-to x,y]
 *          admin … principal-list | principal-disable --id <主体> | token-list [--principal <主体>] | token-revoke --token-id <id>
 *          admin … token-issue --principal <主体> [--scopes a,b] [--send-to x,y] --ttl-days N --token-out <文件>   （令牌只写进 0600 文件）
 *          admin … passphrase-set   （口令从标准输入读一行）
 *   login  --base <https://…/coord/v2> --principal <主体> [--scopes status,inbox:read,send] [--send-to x,y] [--label <说明>] --token-file <文件>
 *   whoami | send --to <主体> --kind <种类> (--body <文本> | --body-file <文件>) [--reply-to <id>] [--ttl-seconds N] [--idempotency-key <键>]
 *   wait [--after <seq> | --state <文件>] [--timeout-min N] | state --id <消息 id> --state received|processed|failed [--detail <文本>]
 *     客户端命令都要 `--base`，令牌取 `--token-file` 或环境变量 `PROBE_MAIL_V2_TOKEN`，绝不收命令行里的令牌、绝不打印令牌。
 *
 * 收到 `instruction` 不等于用户批准：信箱只传消息，接收会话照它自己的授权规则决定做不做。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const V2 = Object.freeze({
  SCOPES: Object.freeze(['status', 'inbox:read', 'send']),
  DEFAULT_SCOPES: Object.freeze(['status', 'inbox:read']),
  KINDS: Object.freeze(['instruction', 'receipt', 'question', 'status']),
  PRINCIPAL_KINDS: Object.freeze(['doger', 'codex', 'claude', 'other']),
  STATES: Object.freeze(['received', 'processed', 'failed']),
  MAX_WAIT_MS: 25_000,
  MAX_BATCH: 100,
  MAX_MESSAGE_BYTES: 256 * 1024,
  MAX_BODY_BYTES: 512 * 1024,
  DEFAULT_TTL_S: 3 * 86_400,
  MAX_TTL_S: 30 * 86_400,
  ADMIN_TOKEN_MAX_DAYS: 90,
  DEVICE_TOKEN_MAX_DAYS: 30,
  RETENTION_DAYS: 14,
  AUDIT_RETENTION_DAYS: 30,
  DEVICE_CODE_TTL_S: 600,
  DEVICE_INTERVAL_S: 5,
  MAX_PENDING_DEVICE: 20,
  SESSION_TTL_S: 900,
  LOGIN_MAX_FAILS: 10,
  LOGIN_LOCK_S: 900,
  PRUNE_EVERY_MS: 3_600_000,
});

const PRINCIPAL_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const TOKEN_RE = /^pcm2_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const IDEM_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // RFC 8628 §6.1 建议的去元音字母表
const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (n) => crypto.randomBytes(n).toString('base64url');
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const sameStr = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const uniq = (xs) => [...new Set(xs)];
const iso = (ms) => new Date(ms).toISOString();

/** 写成 0600，先写临时文件再换名 */
function writeSecretFile(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${b64url(6)}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上忽略 */ }
}

/* ───────────────────────── 存储 ───────────────────────── */

/**
 * JSON 存储（主体、令牌哈希、口令哈希、消息、各收件箱 seq、幂等记录）；每次改动整份重写（0600）。
 * 量很小（几个主体、几百条消息），整份重写够用，换来重启后 seq 与游标不丢。
 */
export function createStore({ file = null, now = () => Date.now() } = {}) {
  let data = { version: 1, principals: {}, tokens: {}, admin: { passphrase: null }, inboxes: {}, messages: {}, idem: {} };
  if (file && fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded?.version !== 1) throw new Error('v2 存储版本不认识');
    data = { ...data, ...loaded };
  }
  const index = new Map(); // 主体 → 按 seq 排好的消息
  const reindex = () => {
    index.clear();
    for (const m of Object.values(data.messages)) {
      if (!index.has(m.to)) index.set(m.to, []);
      index.get(m.to).push(m);
    }
    for (const list of index.values()) list.sort((a, b) => a.seq - b.seq);
  };
  reindex();
  const save = () => { if (file) writeSecretFile(file, JSON.stringify(data)); };
  return {
    data, save, now,
    inboxOf: (pid) => index.get(pid) ?? [],
    addMessage(m) {
      data.messages[m.id] = m;
      if (!index.has(m.to)) index.set(m.to, []);
      index.get(m.to).push(m);
    },
    nextSeq(pid) {
      const box = data.inboxes[pid] ?? (data.inboxes[pid] = { last: 0 });
      box.last += 1;
      return box.last;
    },
    lastSeq: (pid) => data.inboxes[pid]?.last ?? 0,
    /** 过期超过 retentionDays 的消息、作废超过 retentionDays 的令牌从存储里删；幂等记录随消息一起删 */
    prune(retentionDays = V2.RETENTION_DAYS) {
      const cutoff = now() - retentionDays * 86_400_000;
      let removed = 0;
      for (const [id, m] of Object.entries(data.messages)) {
        if (Date.parse(m.expiresAt) < cutoff) { delete data.messages[id]; removed += 1; }
      }
      for (const [k, v] of Object.entries(data.idem)) if (!data.messages[v.id]) delete data.idem[k];
      for (const [id, t] of Object.entries(data.tokens)) {
        const dead = Math.min(t.revokedAt ? Date.parse(t.revokedAt) : Infinity, Date.parse(t.expiresAt));
        if (dead < cutoff) delete data.tokens[id];
      }
      if (removed) reindex();
      save();
      return removed;
    },
  };
}

/* ───────────────────────── 审计日志（脱敏） ───────────────────────── */

/** 允许进日志的字段；别的一律丢掉（防止将来有人顺手把正文或令牌塞进来） */
const AUDIT_FIELDS = new Set(['principal', 'tokenId', 'reason', 'to', 'from', 'kind', 'id', 'seq', 'bytes', 'state', 'scopes', 'sendTo', 'userCodePrefix', 'expiresAt', 'via', 'replayed', 'cmd', 'status']);

export function createAudit({ file = null, now = () => Date.now(), retentionDays = V2.AUDIT_RETENTION_DAYS, echo = null } = {}) {
  const prune = () => {
    if (!file || !fs.existsSync(file)) return 0;
    const cutoff = now() - retentionDays * 86_400_000;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter((l) => { try { return Date.parse(JSON.parse(l).t) >= cutoff; } catch { return false; } });
    writeSecretFile(file, keep.length ? `${keep.join('\n')}\n` : '');
    return lines.length - keep.length;
  };
  prune();
  return {
    prune,
    log(event, fields = {}) {
      const clean = { t: iso(now()), event };
      for (const [k, v] of Object.entries(fields)) if (AUDIT_FIELDS.has(k) && v !== undefined) clean[k] = v;
      const line = JSON.stringify(clean);
      if (file) {
        if (!fs.existsSync(file)) writeSecretFile(file, '');
        fs.appendFileSync(file, `${line}\n`);
      }
      echo?.(line);
    },
  };
}

/* ───────────────────────── 令牌 ───────────────────────── */

export function issueToken(store, { principal, scopes = V2.DEFAULT_SCOPES, sendTo = [], ttlSeconds, via, label = '' }) {
  const p = store.data.principals[principal];
  if (!p || p.disabledAt) throw Object.assign(new Error('主体不存在或已停用'), { code: 'no-principal' });
  const sc = uniq(scopes);
  if (sc.some((s) => !V2.SCOPES.includes(s))) throw Object.assign(new Error('未知 scope'), { code: 'bad-scope' });
  if (sc.some((s) => !p.maxScopes.includes(s))) throw Object.assign(new Error('scope 超过主体上限'), { code: 'scope-over-limit' });
  const st = uniq(sendTo);
  if (st.length && !sc.includes('send')) throw Object.assign(new Error('没有 send 不能给接收方'), { code: 'send-to-without-send' });
  if (st.some((x) => !p.sendTo.includes(x))) throw Object.assign(new Error('接收方超过主体上限'), { code: 'send-to-over-limit' });
  const maxDays = via === 'device' ? V2.DEVICE_TOKEN_MAX_DAYS : V2.ADMIN_TOKEN_MAX_DAYS;
  if (!(Number.isFinite(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= maxDays * 86_400)) throw Object.assign(new Error(`有效期要在 (0, ${maxDays}] 天`), { code: 'bad-ttl' });
  const id = crypto.randomBytes(8).toString('hex');
  const secret = b64url(32);
  const t = store.now();
  const record = { id, principal, scopes: sc, sendTo: st, label: String(label).slice(0, 80), via, secretHash: sha256(secret), createdAt: iso(t), expiresAt: iso(t + ttlSeconds * 1000), revokedAt: null };
  store.data.tokens[id] = record;
  store.save();
  return { token: `pcm2_${id}_${secret}`, record };
}

export function verifyToken(store, raw) {
  if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'missing' };
  const m = TOKEN_RE.exec(raw);
  if (!m) return { ok: false, reason: 'malformed' };
  const record = store.data.tokens[m[1]];
  if (!record) return { ok: false, reason: 'unknown', tokenId: m[1] };
  if (!sameHex(sha256(m[2]), record.secretHash)) return { ok: false, reason: 'bad-secret', tokenId: m[1] };
  if (record.revokedAt) return { ok: false, reason: 'revoked', tokenId: m[1] };
  if (Date.parse(record.expiresAt) <= store.now()) return { ok: false, reason: 'expired', tokenId: m[1] };
  const p = store.data.principals[record.principal];
  if (!p || p.disabledAt) return { ok: false, reason: 'principal-disabled', tokenId: m[1] };
  return { ok: true, record, principal: p };
}

const publicToken = (t) => ({ id: t.id, principal: t.principal, scopes: t.scopes, sendTo: t.sendTo, label: t.label, via: t.via, createdAt: t.createdAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt });

/* ───────────────────────── 口令（scrypt） ───────────────────────── */

const scrypt = (pass, salt, { N, r, p, keylen, maxmem }) => new Promise((res, rej) => crypto.scrypt(pass, salt, keylen, { N, r, p, maxmem }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassphrase(passphrase, params = SCRYPT) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('管理口令至少 12 个字符');
  const salt = crypto.randomBytes(16);
  const key = await scrypt(passphrase, salt, params);
  return { alg: 'scrypt', N: params.N, r: params.r, p: params.p, keylen: params.keylen, salt: salt.toString('base64'), hash: key.toString('base64') };
}

export async function checkPassphrase(stored, passphrase) {
  if (!stored || typeof passphrase !== 'string') return false;
  const key = await scrypt(passphrase, Buffer.from(stored.salt, 'base64'), { N: stored.N, r: stored.r, p: stored.p, keylen: stored.keylen, maxmem: SCRYPT.maxmem });
  const want = Buffer.from(stored.hash, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

/* ───────────────────────── HTTP 小工具 ───────────────────────── */

const API_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const sendJson = (res, status, body, extra = {}) => { res.writeHead(status, { ...API_HEADERS, ...extra }); res.end(JSON.stringify(body)); };
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readBody(req, limit = V2.MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too-large'), { code: 'too-large' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('bad-json'), { code: 'bad-json' }); }
}
async function readForm(req) {
  const text = await readBody(req, 16 * 1024);
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('application/json')) { try { return JSON.parse(text || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}
const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
};
const bearer = (req) => {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer (\S+)$/.exec(h);
  return m ? m[1] : '';
};
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};
const formatUserCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const normUserCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

/* ───────────────────────── 服务端 ───────────────────────── */

/**
 * 起 v2 服务。
 * @param {object} o
 * @param {number} o.port 0 取随机端口
 * @param {string} [o.host] 缺省 127.0.0.1（生产只给 nginx 转发）
 * @param {string|null} [o.storeFile] / [o.auditFile] 不给就只在内存里（测试用）
 * @param {string|null} [o.adminSocket] 管理口 Unix 套接字路径；不给就不开管理口
 * @param {string} [o.publicBase] 对外基址（设备授权的 verification_uri 与 Cookie 路径用），如 `https://example/coord/v2`
 * @param {() => number} [o.now] 测试用时钟
 * @param {object} [o.scryptParams] 测试可调小，生产不要给
 */
export async function startV2Server({
  port = 0, host = '127.0.0.1', storeFile = null, auditFile = null, adminSocket = null,
  publicBase = 'http://127.0.0.1/v2', now = () => Date.now(), echo = null, scryptParams = SCRYPT,
  retentionDays = V2.RETENTION_DAYS, auditRetentionDays = V2.AUDIT_RETENTION_DAYS,
} = {}) {
  const store = createStore({ file: storeFile, now });
  const audit = createAudit({ file: auditFile, now, retentionDays: auditRetentionDays, echo });
  store.prune(retentionDays);
  const base = new URL(publicBase);
  const cookiePath = base.pathname.replace(/\/+$/, '') || '/';
  const waiters = new Map(); // 主体 → Set<wake>
  const devices = new Map(); // sha256(device_code) → 记录（只在内存：重启后待批的码作废，客户端重来即可）
  const sessions = new Map(); // sha256(会话 Cookie) → { expiresAt, csrf }
  const login = { fails: [], lockedUntil: 0 };

  const wake = (pid) => { for (const w of [...(waiters.get(pid) ?? [])]) w(); };
  const live = (m) => Date.parse(m.expiresAt) > now();
  const envelope = (m) => ({ id: m.id, seq: m.seq, from: m.from, to: m.to, kind: m.kind, replyTo: m.replyTo, body: m.body, createdAt: m.createdAt, expiresAt: m.expiresAt, state: m.state });

  function auth(req, res, scope) {
    const v = verifyToken(store, bearer(req));
    if (!v.ok) {
      audit.log('auth.fail', { reason: v.reason, tokenId: v.tokenId });
      sendJson(res, 401, { ok: false, error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      return null;
    }
    if (scope && !v.record.scopes.includes(scope)) {
      audit.log('auth.forbidden', { principal: v.record.principal, tokenId: v.record.id, reason: `need ${scope}` });
      sendJson(res, 403, { ok: false, error: 'insufficient_scope', need: scope }, { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"` });
      return null;
    }
    return v.record;
  }

  /* ── 消息 ── */

  async function postMessage(req, res) {
    const tok = auth(req, res, 'send');
    if (!tok) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEM_RE.test(key)) return sendJson(res, 400, { ok: false, error: 'bad-idempotency-key' });
    let b;
    try { b = await readJson(req); } catch (e) { return sendJson(res, e.code === 'too-large' ? 413 : 400, { ok: false, error: e.code }); }
    const from = tok.principal;
    const { to, kind, body, replyTo = null } = b;
    const ttlSeconds = b.ttlSeconds ?? V2.DEFAULT_TTL_S;
    if (typeof to !== 'string' || !PRINCIPAL_RE.test(to)) return sendJson(res, 400, { ok: false, error: 'bad-to' });
    if (!V2.KINDS.includes(kind)) return sendJson(res, 400, { ok: false, error: 'bad-kind' });
    if (body === undefined) return sendJson(res, 400, { ok: false, error: 'no-body' });
    if (!(Number.isInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= V2.MAX_TTL_S)) return sendJson(res, 400, { ok: false, error: 'bad-ttl' });
    if (replyTo !== null && !(typeof replyTo === 'string' && UUID_RE.test(replyTo))) return sendJson(res, 400, { ok: false, error: 'bad-reply-to' });
    // 接收方：令牌授权里有、主体上限里也有、接收方存在且没停用（任何一条不满足都回同一个 403，不暴露主体是否存在）
    const fromP = store.data.principals[from];
    const toP = store.data.principals[to];
    if (!tok.sendTo.includes(to) || !fromP.sendTo.includes(to) || !toP || toP.disabledAt) {
      audit.log('message.forbidden', { principal: from, tokenId: tok.id, to });
      return sendJson(res, 403, { ok: false, error: 'recipient-not-allowed' });
    }
    if (replyTo !== null) {
      const orig = store.data.messages[replyTo];
      if (!orig || orig.to !== from) return sendJson(res, 400, { ok: false, error: 'bad-reply-to' });
    }
    const hash = sha256(canonical({ to, kind, body, replyTo, ttlSeconds }));
    const idemKey = `${from}\n${key}`;
    const prior = store.data.idem[idemKey];
    if (prior && store.data.messages[prior.id]) {
      if (prior.hash !== hash) return sendJson(res, 409, { ok: false, error: 'idempotency-conflict' });
      const m = store.data.messages[prior.id];
      audit.log('message.post', { principal: from, id: m.id, to: m.to, kind: m.kind, replayed: true });
      return sendJson(res, 200, { ok: true, replayed: true, message: envelope(m) });
    }
    const t = now();
    const m = { id: crypto.randomUUID(), seq: 0, from, to, kind, replyTo, body, createdAt: iso(t), expiresAt: iso(t + ttlSeconds * 1000), state: { received: null, processed: null, failed: null } };
    const bytes = Buffer.byteLength(JSON.stringify(m), 'utf8');
    if (bytes > V2.MAX_MESSAGE_BYTES) return sendJson(res, 413, { ok: false, error: 'too-large' });
    m.seq = store.nextSeq(to);
    store.addMessage(m);
    store.data.idem[idemKey] = { id: m.id, hash };
    store.save();
    audit.log('message.post', { principal: from, tokenId: tok.id, id: m.id, to, kind, seq: m.seq, bytes });
    wake(to);
    return sendJson(res, 201, { ok: true, replayed: false, message: envelope(m) });
  }

  async function readInbox(req, res, url) {
    const tok = auth(req, res, 'inbox:read');
    if (!tok) return undefined;
    const me = tok.principal;
    const since = Number(url.searchParams.get('after') ?? 0);
    if (!Number.isInteger(since) || since < 0) return sendJson(res, 400, { ok: false, error: 'bad-after' });
    const waitS = Number(url.searchParams.get('wait') ?? 0);
    const waitMs = Math.max(0, Math.min(Number.isFinite(waitS) ? waitS * 1000 : 0, V2.MAX_WAIT_MS));
    const pick = () => store.inboxOf(me).filter((m) => m.seq > since && live(m)).slice(0, V2.MAX_BATCH);
    let got = pick();
    if (got.length === 0 && waitMs > 0) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); waiters.get(me)?.delete(finish); resolve(); };
        const timer = setTimeout(finish, waitMs);
        if (!waiters.has(me)) waiters.set(me, new Set());
        waiters.get(me).add(finish);
        req.on('close', finish);
      });
      got = pick();
    }
    if (res.destroyed || res.writableEnded) return undefined;
    return sendJson(res, 200, { ok: true, principal: me, messages: got.map(envelope), last: store.lastSeq(me) });
  }

  function getMessage(req, res, id) {
    const tok = auth(req, res, null);
    if (!tok) return undefined;
    const m = UUID_RE.test(id) ? store.data.messages[id] : null;
    const asSender = m && m.from === tok.principal && tok.scopes.includes('send');
    const asRecipient = m && m.to === tok.principal && tok.scopes.includes('inbox:read');
    if (!asSender && !asRecipient) return sendJson(res, 404, { ok: false, error: 'not-found' });
    return sendJson(res, 200, { ok: true, message: envelope(m) });
  }

  async function setState(req, res, id) {
    const tok = auth(req, res, 'inbox:read');
    if (!tok) return undefined;
    const m = UUID_RE.test(id) ? store.data.messages[id] : null;
    if (!m || m.to !== tok.principal) return sendJson(res, 404, { ok: false, error: 'not-found' });
    let b;
    try { b = await readJson(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.code }); }
    const { state } = b;
    const detail = b.detail === undefined ? null : String(b.detail).slice(0, 2000);
    if (!V2.STATES.includes(state)) return sendJson(res, 400, { ok: false, error: 'bad-state' });
    if (!live(m)) return sendJson(res, 410, { ok: false, error: 'expired' });
    const at = iso(now());
    const terminal = m.state.processed ? 'processed' : m.state.failed ? 'failed' : null;
    if (state === 'received') {
      if (!m.state.received) m.state.received = { at };
    } else if (terminal && terminal !== state) {
      return sendJson(res, 409, { ok: false, error: 'state-conflict', state: terminal });
    } else if (!terminal) {
      if (!m.state.received) m.state.received = { at };
      m.state[state] = { at, detail };
    }
    store.save();
    audit.log('message.state', { principal: tok.principal, id: m.id, state });
    return sendJson(res, 200, { ok: true, message: envelope(m) });
  }

  /* ── 设备授权（RFC 8628）── */

  function pruneDevices() {
    for (const [k, d] of devices) if (d.expiresAt <= now() || d.status === 'consumed') devices.delete(k);
  }

  async function deviceCode(req, res) {
    let b;
    try { b = await readForm(req); } catch { return sendJson(res, 400, { error: 'invalid_request' }); }
    pruneDevices();
    if ([...devices.values()].filter((d) => d.status === 'pending').length >= V2.MAX_PENDING_DEVICE) return sendJson(res, 429, { error: 'slow_down' });
    const principal = String(b.principal ?? '');
    const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[ ,]+/)).map(String).filter(Boolean);
    const scopes = uniq(list(b.scopes ?? b.scope).length ? list(b.scopes ?? b.scope) : V2.DEFAULT_SCOPES);
    const sendTo = uniq(list(b.sendTo ?? b.send_to));
    if (!PRINCIPAL_RE.test(principal) || scopes.some((s) => !V2.SCOPES.includes(s)) || sendTo.some((x) => !PRINCIPAL_RE.test(x))) return sendJson(res, 400, { error: 'invalid_request' });
    const deviceCodeRaw = b64url(32);
    let userCode = '';
    for (const byte of crypto.randomBytes(8)) userCode += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    devices.set(sha256(deviceCodeRaw), {
      userCode, principal, scopes, sendTo, label: String(b.label ?? '').slice(0, 80),
      expiresAt: now() + V2.DEVICE_CODE_TTL_S * 1000, interval: V2.DEVICE_INTERVAL_S, lastPoll: 0, status: 'pending', grant: null,
    });
    audit.log('device.code', { principal, scopes, sendTo, userCodePrefix: userCode.slice(0, 2) });
    return sendJson(res, 200, {
      device_code: deviceCodeRaw, user_code: formatUserCode(userCode), verification_uri: `${base.origin}${cookiePath === '/' ? '' : cookiePath}/device`,
      expires_in: V2.DEVICE_CODE_TTL_S, interval: V2.DEVICE_INTERVAL_S,
    });
  }

  async function deviceToken(req, res) {
    let b;
    try { b = await readForm(req); } catch { return sendJson(res, 400, { error: 'invalid_request' }); }
    if (b.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') return sendJson(res, 400, { error: 'unsupported_grant_type' });
    const d = devices.get(sha256(String(b.device_code ?? '')));
    if (!d || d.status === 'consumed') return sendJson(res, 400, { error: 'invalid_grant' });
    if (d.expiresAt <= now()) { devices.delete(sha256(String(b.device_code))); return sendJson(res, 400, { error: 'expired_token' }); }
    if (d.status === 'denied') { d.status = 'consumed'; return sendJson(res, 400, { error: 'access_denied' }); }
    if (d.status === 'pending') {
      const t = now();
      if (t - d.lastPoll < d.interval * 1000) { d.interval += 5; d.lastPoll = t; return sendJson(res, 400, { error: 'slow_down' }); }
      d.lastPoll = t;
      return sendJson(res, 400, { error: 'authorization_pending' });
    }
    // approved：一次性兑换
    d.status = 'consumed';
    try {
      const { token, record } = issueToken(store, { principal: d.principal, scopes: d.grant.scopes, sendTo: d.grant.sendTo, ttlSeconds: d.grant.ttlSeconds, via: 'device', label: d.label });
      audit.log('device.token', { principal: record.principal, tokenId: record.id, scopes: record.scopes, sendTo: record.sendTo, expiresAt: record.expiresAt });
      return sendJson(res, 200, { access_token: token, token_type: 'Bearer', expires_in: d.grant.ttlSeconds, scope: record.scopes.join(' ') });
    } catch {
      return sendJson(res, 400, { error: 'access_denied' });
    }
  }

  /* ── 批准页（用户自己的浏览器）── */

  const sessionOf = (req) => {
    const raw = cookieOf(req, 'pcm2_admin');
    if (!raw) return null;
    const s = sessions.get(sha256(raw));
    if (!s || s.expiresAt <= now()) { if (s) sessions.delete(sha256(raw)); return null; }
    return s;
  };
  const page = (res, status, title, inner, extra = {}) => {
    res.writeHead(status, { ...PAGE_HEADERS, ...extra });
    res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${inner}</body></html>`);
  };
  const loginForm = (msg = '') => `${msg ? `<p>${esc(msg)}</p>` : ''}<form method="post" action="login"><label>管理口令 <input type="password" name="passphrase" autocomplete="current-password" required></label> <button>登录</button></form>`;

  function devicePage(req, res, url, msg = '') {
    const s = sessionOf(req);
    if (!s) return page(res, 200, 'PromptCut 信箱授权：登录', loginForm(msg));
    const code = normUserCode(url.searchParams.get('user_code'));
    if (!code) {
      return page(res, 200, 'PromptCut 信箱授权', `${msg ? `<p>${esc(msg)}</p>` : ''}<form method="get" action="device"><label>设备上显示的代码 <input name="user_code" autocomplete="off" required></label> <button>下一步</button></form><form method="post" action="logout"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button>退出</button></form>`);
    }
    const d = [...devices.values()].find((x) => x.userCode === code && x.status === 'pending' && x.expiresAt > now());
    if (!d) return page(res, 404, 'PromptCut 信箱授权', '<p>代码无效、已过期或已处理。</p><p><a href="device">重新输入</a></p>');
    const p = store.data.principals[d.principal];
    const scopes = V2.SCOPES.map((sc) => {
      const can = p && !p.disabledAt && p.maxScopes.includes(sc);
      return `<li><label><input type="checkbox" name="scope" value="${esc(sc)}"${d.scopes.includes(sc) && can ? ' checked' : ''}${can ? '' : ' disabled'}> ${esc(sc)}${d.scopes.includes(sc) ? '（申请）' : ''}${can ? '' : '（超过主体上限，不能给）'}</label></li>`;
    }).join('');
    const sendTo = (p?.sendTo ?? []).map((x) => `<li><label><input type="checkbox" name="send_to" value="${esc(x)}"${d.sendTo.includes(x) ? ' checked' : ''}> ${esc(x)}${d.sendTo.includes(x) ? '（申请）' : ''}</label></li>`).join('') || '<li>（主体上限里没有接收方）</li>';
    const notAllowed = d.sendTo.filter((x) => !(p?.sendTo ?? []).includes(x));
    return page(res, 200, 'PromptCut 信箱授权：批准？', `
      <p>申请主体：<strong>${esc(d.principal)}</strong>${p && !p.disabledAt ? '' : '（不存在或已停用，只能拒绝）'}；说明：${esc(d.label || '无')}；代码 ${esc(formatUserCode(d.userCode))}</p>
      ${notAllowed.length ? `<p>申请里超过主体上限、不会给的接收方：${esc(notAllowed.join(', '))}</p>` : ''}
      <form method="post" action="device/approve">
        <input type="hidden" name="csrf" value="${esc(s.csrf)}"><input type="hidden" name="user_code" value="${esc(d.userCode)}">
        <p>权限（可以收窄）：</p><ul>${scopes}</ul>
        <p>允许发给（勾 send 才生效）：</p><ul>${sendTo}</ul>
        <p><label>有效天数（1～${V2.DEVICE_TOKEN_MAX_DAYS}） <input type="number" name="ttl_days" min="1" max="${V2.DEVICE_TOKEN_MAX_DAYS}" value="7" required></label></p>
        <p>注意：批准只授予收发消息的权限。对方发来的 instruction 不代表你批准了任何操作。</p>
        <button name="decision" value="approve">批准</button> <button name="decision" value="deny">拒绝</button>
      </form>`);
  }

  async function doLogin(req, res) {
    const t = now();
    if (login.lockedUntil > t) return page(res, 429, 'PromptCut 信箱授权：登录', loginForm('失败次数过多，稍后再试。'));
    const b = await readForm(req).catch(() => ({}));
    const okPass = store.data.admin.passphrase ? await checkPassphrase(store.data.admin.passphrase, String(b.passphrase ?? '')) : false;
    if (!okPass) {
      login.fails = login.fails.filter((x) => x > t - V2.LOGIN_LOCK_S * 1000);
      login.fails.push(t);
      if (login.fails.length >= V2.LOGIN_MAX_FAILS) { login.lockedUntil = t + V2.LOGIN_LOCK_S * 1000; login.fails = []; }
      audit.log('login.fail', { reason: store.data.admin.passphrase ? 'bad-passphrase' : 'no-passphrase-set' });
      return page(res, 401, 'PromptCut 信箱授权：登录', loginForm('口令不对。'));
    }
    login.fails = [];
    const raw = b64url(32);
    sessions.set(sha256(raw), { expiresAt: t + V2.SESSION_TTL_S * 1000, csrf: b64url(24) });
    audit.log('login.ok', {});
    res.writeHead(303, { ...PAGE_HEADERS, Location: 'device', 'Set-Cookie': `pcm2_admin=${raw}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${V2.SESSION_TTL_S}` });
    return res.end();
  }

  async function doLogout(req, res) {
    const b = await readForm(req).catch(() => ({}));
    const raw = cookieOf(req, 'pcm2_admin');
    const s = sessionOf(req);
    if (s && raw && sameStr(String(b.csrf ?? ''), s.csrf)) sessions.delete(sha256(raw));
    res.writeHead(303, { ...PAGE_HEADERS, Location: 'device', 'Set-Cookie': `pcm2_admin=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    return res.end();
  }

  async function doApprove(req, res) {
    const s = sessionOf(req);
    if (!s) return page(res, 401, 'PromptCut 信箱授权：登录', loginForm('请先登录。'));
    const text = await readBody(req, 16 * 1024).catch(() => '');
    const form = new URLSearchParams(text);
    if (!sameStr(form.get('csrf') ?? '', s.csrf)) return page(res, 403, 'PromptCut 信箱授权', '<p>表单已失效，请重新打开页面。</p>');
    const code = normUserCode(form.get('user_code'));
    const d = [...devices.values()].find((x) => x.userCode === code && x.status === 'pending' && x.expiresAt > now());
    if (!d) return page(res, 404, 'PromptCut 信箱授权', '<p>代码无效、已过期或已处理。</p>');
    if (form.get('decision') !== 'approve') {
      d.status = 'denied';
      audit.log('device.deny', { principal: d.principal, userCodePrefix: d.userCode.slice(0, 2) });
      return page(res, 200, 'PromptCut 信箱授权', '<p>已拒绝。</p><p><a href="../device">返回</a></p>');
    }
    const p = store.data.principals[d.principal];
    if (!p || p.disabledAt) return page(res, 400, 'PromptCut 信箱授权', '<p>主体不存在或已停用，不能批准。</p>');
    const scopes = uniq(form.getAll('scope')).filter((x) => V2.SCOPES.includes(x) && p.maxScopes.includes(x));
    const sendTo = scopes.includes('send') ? uniq(form.getAll('send_to')).filter((x) => p.sendTo.includes(x)) : [];
    const days = Number(form.get('ttl_days'));
    if (!scopes.length || !(Number.isInteger(days) && days >= 1 && days <= V2.DEVICE_TOKEN_MAX_DAYS)) return page(res, 400, 'PromptCut 信箱授权', '<p>至少给一个权限，天数在范围内。</p><p><a href="../device">返回</a></p>');
    d.status = 'approved';
    d.grant = { scopes, sendTo, ttlSeconds: days * 86_400 };
    audit.log('device.approve', { principal: d.principal, scopes, sendTo, userCodePrefix: d.userCode.slice(0, 2) });
    return page(res, 200, 'PromptCut 信箱授权', `<p>已批准 ${esc(d.principal)}：${esc(scopes.join(', '))}${sendTo.length ? `；可发给 ${esc(sendTo.join(', '))}` : ''}；${days} 天。回到设备上等它自己取走授权即可。</p>`);
  }

  /* ── 路由 ── */

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://v2.local');
      const p = url.pathname;
      const M = req.method;
      if (M === 'GET' && p === '/v2/health') return sendJson(res, 200, { ok: true });
      if (M === 'GET' && p === '/v2/whoami') {
        const tok = auth(req, res, 'status');
        if (!tok) return undefined;
        return sendJson(res, 200, { ok: true, principal: tok.principal, kind: store.data.principals[tok.principal].kind, tokenId: tok.id, scopes: tok.scopes, sendTo: tok.sendTo, expiresAt: tok.expiresAt });
      }
      if (M === 'GET' && p === '/v2/inbox') return await readInbox(req, res, url);
      if (M === 'POST' && p === '/v2/messages') return await postMessage(req, res);
      let m = /^\/v2\/messages\/([^/]+)$/.exec(p);
      if (m && M === 'GET') return getMessage(req, res, m[1]);
      m = /^\/v2\/messages\/([^/]+)\/state$/.exec(p);
      if (m && M === 'POST') return await setState(req, res, m[1]);
      if (M === 'POST' && p === '/v2/device/code') return await deviceCode(req, res);
      if (M === 'POST' && p === '/v2/device/token') return await deviceToken(req, res);
      if (M === 'GET' && p === '/v2/device') return devicePage(req, res, url);
      if (M === 'POST' && p === '/v2/login') return await doLogin(req, res);
      if (M === 'POST' && p === '/v2/logout') return await doLogout(req, res);
      if (M === 'POST' && p === '/v2/device/approve') return await doApprove(req, res);
      return sendJson(res, 404, { ok: false, error: 'no-route' });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
      return undefined;
    }
  });

  /* ── 管理口（Unix 套接字）── */

  async function adminHandle(cmd, b) {
    const d = store.data;
    switch (cmd) {
      case 'principal-add': {
        if (!PRINCIPAL_RE.test(String(b.id ?? ''))) return [400, { ok: false, error: 'bad-id' }];
        if (d.principals[b.id]) return [409, { ok: false, error: 'exists' }];
        if (!V2.PRINCIPAL_KINDS.includes(b.kind)) return [400, { ok: false, error: 'bad-kind' }];
        const maxScopes = uniq(b.maxScopes ?? V2.DEFAULT_SCOPES);
        const sendTo = uniq(b.sendTo ?? []);
        if (maxScopes.some((s) => !V2.SCOPES.includes(s)) || sendTo.some((x) => !PRINCIPAL_RE.test(x))) return [400, { ok: false, error: 'bad-policy' }];
        d.principals[b.id] = { id: b.id, kind: b.kind, label: String(b.label ?? '').slice(0, 80), maxScopes, sendTo, createdAt: iso(now()), disabledAt: null };
        store.save();
        audit.log('admin', { cmd, principal: b.id, scopes: maxScopes, sendTo });
        return [200, { ok: true, principal: d.principals[b.id] }];
      }
      case 'principal-list': return [200, { ok: true, principals: Object.values(d.principals) }];
      case 'principal-disable': {
        const pr = d.principals[b.id];
        if (!pr) return [404, { ok: false, error: 'not-found' }];
        pr.disabledAt = pr.disabledAt ?? iso(now());
        store.save();
        audit.log('admin', { cmd, principal: b.id });
        return [200, { ok: true, principal: pr }];
      }
      case 'token-issue': {
        try {
          const { token, record } = issueToken(store, { principal: b.principal, scopes: b.scopes ?? V2.DEFAULT_SCOPES, sendTo: b.sendTo ?? [], ttlSeconds: Number(b.ttlDays) * 86_400, via: 'admin', label: b.label ?? '' });
          audit.log('token.issue', { principal: record.principal, tokenId: record.id, scopes: record.scopes, sendTo: record.sendTo, expiresAt: record.expiresAt, via: 'admin' });
          return [200, { ok: true, token, record: publicToken(record) }];
        } catch (e) { return [400, { ok: false, error: e.code ?? 'bad-request' }]; }
      }
      case 'token-list': return [200, { ok: true, tokens: Object.values(d.tokens).filter((t) => !b.principal || t.principal === b.principal).map(publicToken) }];
      case 'token-revoke': {
        const t = d.tokens[b.tokenId];
        if (!t) return [404, { ok: false, error: 'not-found' }];
        t.revokedAt = t.revokedAt ?? iso(now());
        store.save();
        audit.log('token.revoke', { principal: t.principal, tokenId: t.id });
        return [200, { ok: true, token: publicToken(t) }];
      }
      case 'passphrase-set': {
        try { d.admin.passphrase = await hashPassphrase(String(b.passphrase ?? ''), scryptParams); } catch (e) { return [400, { ok: false, error: e.message }]; }
        sessions.clear();
        store.save();
        audit.log('admin', { cmd });
        return [200, { ok: true }];
      }
      default: return [404, { ok: false, error: 'no-command' }];
    }
  }

  let adminServer = null;
  if (adminSocket) {
    const isPipe = adminSocket.startsWith('\\\\.\\pipe\\'); // Windows 命名管道：没有文件可删、可 chmod
    if (!isPipe && fs.existsSync(adminSocket)) fs.unlinkSync(adminSocket);
    adminServer = http.createServer(async (req, res) => {
      const m = /^\/admin\/([a-z-]+)$/.exec(req.url ?? '');
      if (req.method !== 'POST' || !m) return sendJson(res, 404, { ok: false, error: 'no-route' });
      let b;
      try { b = await readJson(req); } catch { return sendJson(res, 400, { ok: false, error: 'bad-json' }); }
      const [status, body] = await adminHandle(m[1], b);
      return sendJson(res, status, body);
    });
    const oldMask = process.umask(0o177);
    try { await new Promise((r, j) => { adminServer.once('error', j); adminServer.listen(adminSocket, r); }); } finally { process.umask(oldMask); }
    if (!isPipe) fs.chmodSync(adminSocket, 0o600);
  }

  const pruneTimer = setInterval(() => { store.prune(retentionDays); audit.prune(); pruneDevices(); }, V2.PRUNE_EVERY_MS);
  pruneTimer.unref();

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  audit.log('v2.listen', { status: 'ok' });
  return {
    server, adminServer, store, audit, port: actual, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`,
    adminHandle,
    close: () => new Promise((r) => {
      clearInterval(pruneTimer);
      for (const set of waiters.values()) for (const w of [...set]) w();
      adminServer?.close();
      server.close(() => r());
      server.closeAllConnections?.();
    }),
  };
}

/* ───────────────────────── 客户端 ───────────────────────── */

/** v2 客户端。`base` 形如 `https://8-219-80-16.sslip.io/coord/v2`（测试里是 `http://127.0.0.1:<端口>/v2`） */
export function v2Client(base, token) {
  const root = String(base).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  const call = async (method, p, body, extra = {}, timeoutMs = 15_000) => {
    const res = await fetch(`${root}${p}`, {
      method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw Object.assign(new Error(`v2 ${method} ${p} 回 ${res.status}${j?.error ? `：${j.error}` : ''}`), { status: res.status, error: j?.error });
    return j;
  };
  return {
    whoami: () => call('GET', '/whoami'),
    /** 网络错误（不是 4xx/5xx 回包）时带同一个 Idempotency-Key 重发，服务端去重 */
    async send({ to, kind, body, replyTo = null, ttlSeconds, idempotencyKey = crypto.randomUUID() }, { retries = 4 } = {}) {
      let backoff = 1000;
      for (let i = 0; ; i += 1) {
        try { return await call('POST', '/messages', { to, kind, body, replyTo, ...(ttlSeconds ? { ttlSeconds } : {}) }, { 'Idempotency-Key': idempotencyKey }); } catch (e) {
          if (e.status || i >= retries) throw e;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 16_000);
        }
      }
    },
    inbox: (after = 0, waitS = 0) => call('GET', `/inbox?after=${after}&wait=${waitS}`, undefined, {}, (waitS + 15) * 1000),
    get: (id) => call('GET', `/messages/${encodeURIComponent(id)}`),
    state: (id, state, detail) => call('POST', `/messages/${encodeURIComponent(id)}/state`, { state, ...(detail !== undefined ? { detail } : {}) }),
  };
}

/**
 * 设备授权：申请码 → 让用户在浏览器批准 → 轮询换令牌 → 写进 0600 的令牌文件。令牌不经 `onPrompt`、不打印。
 * @param {(info: { user_code: string, verification_uri: string, expires_in: number }) => void} onPrompt 只拿到给人看的部分
 */
export async function deviceLogin(base, { principal, scopes, sendTo = [], label = '', tokenFile, onPrompt, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const root = String(base).replace(/\/+$/, '');
  const post = async (p, form) => {
    const res = await fetch(`${root}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) });
    return { status: res.status, j: await res.json().catch(() => ({})) };
  };
  const code = await post('/device/code', { principal, scopes: scopes.join(' '), send_to: sendTo.join(' '), label });
  if (code.status !== 200) throw new Error(`申请设备码失败：${code.status} ${code.j.error ?? ''}`);
  onPrompt({ user_code: code.j.user_code, verification_uri: code.j.verification_uri, expires_in: code.j.expires_in });
  let interval = code.j.interval;
  const deadline = Date.now() + code.j.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await post('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.j.device_code });
    if (r.status === 200 && r.j.access_token) {
      writeSecretFile(tokenFile, `${r.j.access_token}\n`);
      return { scope: r.j.scope, expires_in: r.j.expires_in };
    }
    if (r.j.error === 'authorization_pending') continue;
    if (r.j.error === 'slow_down') { interval += 5; continue; }
    throw new Error(`授权没成：${r.j.error ?? r.status}`);
  }
  throw new Error('授权没成：expired_token');
}

/* ───────────────────────── 命令行 ───────────────────────── */

function adminCall(socketPath, cmd, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: `/admin/${cmd}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, j: JSON.parse(t) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const has = (n) => rest.includes(n);
  const arg = (n, fb) => (has(n) ? rest[rest.indexOf(n) + 1] : fb);
  const list = (n) => (arg(n, '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (cmd === 'serve') {
    const c = await startV2Server({
      port: Number(arg('--port', '8800')), host: arg('--host', '127.0.0.1'), storeFile: arg('--store', null), auditFile: arg('--audit', null),
      adminSocket: arg('--admin-socket', null), publicBase: arg('--public-base', 'http://127.0.0.1:8800/v2'), echo: (line) => process.stdout.write(`${line}\n`),
    });
    out({ t: new Date().toISOString(), event: 'v2.serve', port: c.port });
    return new Promise(() => {});
  }
  if (cmd === 'admin') {
    const socket = arg('--socket', null);
    const sub = rest.find((x, i) => !x.startsWith('--') && (i === 0 || !rest[i - 1].startsWith('--')));
    if (!socket || !sub) { console.error('用法：admin --socket <路径> <子命令> …'); return 2; }
    let body = {};
    if (sub === 'principal-add') body = { id: arg('--id'), kind: arg('--kind'), label: arg('--label', ''), maxScopes: has('--max-scopes') ? list('--max-scopes') : undefined, sendTo: list('--send-to') };
    else if (sub === 'principal-disable') body = { id: arg('--id') };
    else if (sub === 'token-list') body = { principal: arg('--principal', null) };
    else if (sub === 'token-revoke') body = { tokenId: arg('--token-id') };
    else if (sub === 'passphrase-set') {
      const line = fs.readFileSync(0, 'utf8').split(/\r?\n/)[0];
      body = { passphrase: line };
    } else if (sub === 'token-issue') {
      const outFile = arg('--token-out', null);
      if (!outFile) { console.error('token-issue 要 --token-out <文件>（令牌只写进 0600 文件，不打印）'); return 2; }
      if (fs.existsSync(outFile)) { console.error('--token-out 文件已存在，不覆盖'); return 2; }
      const r = await adminCall(socket, sub, { principal: arg('--principal'), scopes: has('--scopes') ? list('--scopes') : undefined, sendTo: list('--send-to'), ttlDays: Number(arg('--ttl-days')), label: arg('--label', '') });
      if (r.status !== 200) { out(r.j); return 1; }
      writeSecretFile(outFile, `${r.j.token}\n`);
      out({ ok: true, record: r.j.record, tokenFile: outFile });
      return 0;
    }
    const r = await adminCall(socket, sub, body);
    out(r.j);
    return r.status === 200 ? 0 : 1;
  }
  const base = arg('--base', null);
  if (!base) { console.error('要给 --base'); return 2; }
  if (cmd === 'login') {
    const tokenFile = arg('--token-file', null);
    if (!tokenFile) { console.error('要给 --token-file'); return 2; }
    const r = await deviceLogin(base, {
      principal: arg('--principal'), scopes: has('--scopes') ? list('--scopes') : [...V2.DEFAULT_SCOPES], sendTo: list('--send-to'), label: arg('--label', ''), tokenFile,
      onPrompt: (info) => process.stderr.write(`请在你自己的浏览器打开 ${info.verification_uri}，登录后输入代码 ${info.user_code}（${Math.round(info.expires_in / 60)} 分钟内有效）\n`),
    });
    out({ ok: true, scope: r.scope, expires_in: r.expires_in, tokenFile });
    return 0;
  }
  const tokenFile = arg('--token-file', null);
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : process.env.PROBE_MAIL_V2_TOKEN;
  if (!token) { console.error('要给 --token-file 或环境变量 PROBE_MAIL_V2_TOKEN'); return 2; }
  const c = v2Client(base, token);
  if (cmd === 'whoami') { out(await c.whoami()); return 0; }
  if (cmd === 'send') {
    const bodyFile = arg('--body-file', null);
    const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : arg('--body', null);
    if (body === null) { console.error('要给 --body 或 --body-file'); return 2; }
    const r = await c.send({ to: arg('--to'), kind: arg('--kind', 'instruction'), body, replyTo: arg('--reply-to', null), ttlSeconds: has('--ttl-seconds') ? Number(arg('--ttl-seconds')) : undefined, idempotencyKey: arg('--idempotency-key', undefined) });
    out({ ok: true, replayed: r.replayed, id: r.message.id, seq: r.message.seq, to: r.message.to, expiresAt: r.message.expiresAt });
    return 0;
  }
  if (cmd === 'state') { const r = await c.state(arg('--id'), arg('--state'), arg('--detail', undefined)); out({ ok: true, id: r.message.id, state: r.message.state }); return 0; }
  if (cmd === 'wait') {
    const stateFile = arg('--state', null);
    let after = Number(arg('--after', '0'));
    if (stateFile && fs.existsSync(stateFile)) after = Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).after ?? after);
    const timeoutMin = Number(arg('--timeout-min', '0'));
    const deadline = timeoutMin > 0 ? Date.now() + timeoutMin * 60_000 : Infinity;
    let backoff = 1000;
    while (Date.now() < deadline) {
      try {
        const r = await c.inbox(after, 25);
        backoff = 1000;
        if (r.messages.length) {
          for (const m of r.messages) out(m);
          after = r.messages.at(-1).seq;
          if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ after }));
          return 0;
        }
      } catch (e) {
        if (e.status === 401 || e.status === 403) { console.error(String(e.message)); return 2; }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    return 3;
  }
  console.error('用法见文件头');
  return 2;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code; }, (e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
}
