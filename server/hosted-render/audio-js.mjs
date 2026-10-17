/**
 * 托管渲染侧的 `measure_audio_js` 签名路由处理器（拆包表 P6 `server/hosted-render/audio-js.mjs`）。
 *
 * 供下一棒中央接线挂载到 `/api/audio/measure-js` 或渲染服务内部端口：
 *   - 每次调用先经 `verifyServiceRequest`（或 `registry` 构造的签名核验器）核对 Agent 服务签名，拒绝浏览器请求与未签名请求；
 *   - 只接收已由 Agent 服务授权解出的 PCM 样本与测量脚本 `code`，绝不打开本地任意文件路径或网络地址；
 *   - 在断网、无 Node/文件/网络访问的隔离沙箱（`server/audio-sandbox.mjs`）中运行，严格执行本机同款的时间上限（默认 10s、最高 30s）、
 *     内存上限（256 MB）与 256 KiB JSON 输出上限；
 *   - 连接断开或调用 `close()` 时立即中止沙箱 worker 并等待真实进程退出。
 */
import { createAudioSandbox, SANDBOX_LIMITS, clampTimeout } from '../audio-sandbox.mjs';
import { PCM_LIMITS, pcmFormat, sampleBudgetError } from '../audio-pcm.mjs';
import { createLookVerifier } from './look.mjs';

export const HOSTED_AUDIO_JS_ROUTE = '/api/audio/measure-js';
export const HOSTED_AUDIO_JS_AUTH_HEADER = 'x-pc-service-auth';
export const HOSTED_AUDIO_JS_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * 把 Float32Array[] 编码成可经 JSON 传输的 base64 结构。
 * @param {Float32Array[]} channels
 */
export function encodePcmChannels(channels) {
  return {
    encoding: 'f32le-base64',
    frames: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    data: channels.map((ch) => Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength).toString('base64')),
  };
}

/**
 * 从请求体还原 Float32Array[] 声道数据，并核对样本数预算。
 * 支持：
 *   1. 直接传入 `Float32Array[]`（进程内调用）；
 *   2. `{ encoding: 'f32le-base64', data: string[] }` 或 `channels: string[]`（base64 Float32LE）；
 *   3. `channels: number[][]`（普通数组）。
 * @returns {{ ok: true, channels: Float32Array[], frames: number, numberOfChannels: number } | { ok: false, kind: string, error: string }}
 */
export function decodePcmPayload(body, pcmLimits = PCM_LIMITS) {
  const raw = body?.pcm ?? body?.channels;
  if (!raw) return { ok: false, kind: 'invalid', error: '沙箱没收到 PCM' };

  let list = null;
  if (Array.isArray(raw)) {
    if (!raw.length) return { ok: false, kind: 'invalid', error: '沙箱没收到 PCM' };
    if (raw.every((c) => c instanceof Float32Array)) {
      list = raw;
    } else if (raw.every((c) => typeof c === 'string')) {
      list = raw.map((b64) => {
        const buf = Buffer.from(b64, 'base64');
        const frames = Math.floor(buf.length / 4);
        const out = new Float32Array(frames);
        new Uint8Array(out.buffer).set(buf.subarray(0, frames * 4));
        return out;
      });
    } else if (raw.every((c) => Array.isArray(c))) {
      list = raw.map((arr) => Float32Array.from(arr, (v) => Number(v) || 0));
    }
  } else if (raw && typeof raw === 'object' && raw.encoding === 'f32le-base64' && Array.isArray(raw.data) && raw.data.length > 0) {
    list = raw.data.map((b64) => {
      const buf = Buffer.from(String(b64), 'base64');
      const frames = Math.floor(buf.length / 4);
      const out = new Float32Array(frames);
      new Uint8Array(out.buffer).set(buf.subarray(0, frames * 4));
      return out;
    });
  }

  if (!list || !list.length) return { ok: false, kind: 'invalid', error: '沙箱没收到合法的 PCM 声道数组' };
  if (list.length > pcmLimits.maxChannels) {
    return { ok: false, kind: 'invalid', error: `声道数 ${list.length} 超过上限 ${pcmLimits.maxChannels}` };
  }
  const frames = list[0].length;
  if (frames <= 0 || list.some((c) => c.length !== frames)) {
    return { ok: false, kind: 'no-audio', error: '解码出来是空的(这一段没有声音样本,或各声道帧数不一致)' };
  }
  const totalSamples = frames * list.length;
  if (totalSamples > pcmLimits.maxSamples) {
    return {
      ok: false,
      kind: 'too-many-samples',
      error: `要测的声音共 ${totalSamples} 个样本,超过上限 ${pcmLimits.maxSamples}。降 sampleRate、传 mono: true,或用 start / duration 只测一段。`,
    };
  }
  return { ok: true, channels: list, frames, numberOfChannels: list.length };
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error(`请求体超过 ${maxBytes} 字节`), { status: 413, code: 'too-large' }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(Object.assign(err, { status: 400, code: 'bad-request' })));
  });
}

/**
 * @param {object} [o]
 * @param {Function} [o.verifyServiceRequest] 服务请求签名验证器：支持 `(req, rawBody)` 或 `(header, rawBody)`
 * @param {object} [o.registry] 服务公钥登记表（未直接传 `verifyServiceRequest` 时由 `createLookVerifier` 使用）
 * @param {ReturnType<typeof createAudioSandbox>} [o.sandbox] 隔离沙箱实例；缺省内部新建并在 `close()` 时关闭
 * @param {Partial<typeof SANDBOX_LIMITS>} [o.limits] 沙箱限制覆盖
 * @param {typeof PCM_LIMITS} [o.pcmLimits] PCM 预算限制
 * @param {number} [o.maxBodyBytes] HTTP 请求体字节上限
 */
export function createHostedAudioJsHandler({
  verifyServiceRequest = null,
  registry = null,
  sandbox: injectedSandbox = null,
  limits: limitsIn = {},
  pcmLimits = PCM_LIMITS,
  maxBodyBytes = HOSTED_AUDIO_JS_MAX_BODY_BYTES,
  now = Date.now,
  log = () => {},
} = {}) {
  const ownsSandbox = !injectedSandbox;
  const sandbox = injectedSandbox ?? createAudioSandbox({ limits: limitsIn });
  const verifier = typeof verifyServiceRequest === 'function'
    ? verifyServiceRequest
    : (registry ? createLookVerifier({ registry, now }) : null);
  const say = (event, fields = {}) => { try { log(event, fields); } catch {} };

  let closing = false;
  const activeControllers = new Set();

  async function verifyAuth(req, rawBody) {
    if (!verifier) return { ok: false, reason: 'no-verifier' };
    const header = req?.headers?.[HOSTED_AUDIO_JS_AUTH_HEADER] ?? req?.headers?.['x-pc-service-auth'] ?? '';
    try {
      let res = await verifier(req, rawBody);
      if (res === true) return { ok: true };
      if (res && typeof res === 'object' && res.ok === true) return res;
      if (typeof header === 'string' && header && (!res || res.reason === 'format')) {
        const fallback = await verifier(header, rawBody);
        if (fallback === true) return { ok: true };
        if (fallback && typeof fallback === 'object' && fallback.ok === true) return fallback;
        return fallback && typeof fallback === 'object' ? fallback : { ok: false, reason: 'unauthorized' };
      }
      return res && typeof res === 'object' ? res : { ok: false, reason: 'unauthorized' };
    } catch (error) {
      return { ok: false, reason: error?.code ?? 'verify-error' };
    }
  }

  /**
   * 在隔离沙箱中执行已授权的 PCM 与测量脚本。
   * @param {object} body `{ code, channels|pcm, sampleRate?, mono?, duration?, timeoutMs?, meta?, source?, notes? }`
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function run(body, { signal = null } = {}) {
    if (closing) {
      return { status: 503, body: { ok: false, kind: 'closing', error: '音频测量沙箱正在关闭' } };
    }
    if (!body || typeof body !== 'object') {
      return { status: 400, body: { ok: false, kind: 'invalid', error: '请求体不对' } };
    }
    // 严禁接受文件路径或 URL
    if (body.path || body.file || body.url || body.media?.path || body.media?.url) {
      return { status: 400, body: { ok: false, kind: 'invalid', error: '音频测量沙箱只接收已解码的受权 PCM，不接受路径或 URL' } };
    }
    const code = body.code;
    if (typeof code !== 'string' || !code.trim()) {
      return { status: 200, body: { ok: false, kind: 'invalid', error: 'code 是空的:写一个函数体,收到 input(channels、sampleRate、duration……),用 return 返回结果' } };
    }
    if (code.length > sandbox.limits.maxCodeChars) {
      return { status: 200, body: { ok: false, kind: 'invalid', error: `code 有 ${code.length} 个字符,超过上限 ${sandbox.limits.maxCodeChars}` } };
    }

    const decoded = decodePcmPayload(body, pcmLimits);
    if (!decoded.ok) {
      return { status: 200, body: { ok: false, kind: decoded.kind, error: decoded.error } };
    }

    const { sampleRate } = pcmFormat(body, pcmLimits);
    const over = sampleBudgetError({
      duration: decoded.frames / sampleRate,
      sampleRate,
      channels: decoded.numberOfChannels,
    }, pcmLimits);
    if (over) {
      return { status: 200, body: { ok: false, kind: 'too-many-samples', error: over } };
    }

    const duration = Number.isFinite(Number(body.duration)) && Number(body.duration) > 0
      ? Number(body.duration)
      : +(decoded.frames / sampleRate).toFixed(6);
    const source = body.source && typeof body.source === 'object'
      ? body.source
      : { scope: body.scope ?? body.meta?.scope ?? 'media', start: Number(body.start) || 0 };
    const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
    const notes = Array.isArray(body.notes) ? body.notes.filter((n) => typeof n === 'string') : [];
    const timeoutMs = clampTimeout(body.timeoutMs, sandbox.limits);

    const ac = new AbortController();
    activeControllers.add(ac);
    const onExternalAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const r = await sandbox.run({
        code,
        channels: decoded.channels,
        sampleRate,
        duration,
        meta: { ...meta, scope: source.scope, start: source.start },
        timeoutMs,
        signal: ac.signal,
      });
      const input = {
        sampleRate,
        numberOfChannels: decoded.numberOfChannels,
        frames: decoded.frames,
        duration,
        ...source,
      };
      if (!r.ok) {
        return {
          status: 200,
          body: {
            ok: false,
            kind: r.kind,
            error: r.error,
            ...(Number.isInteger(r.line) ? { line: r.line, column: r.column } : null),
            input,
            ...(r.blockedRequests ? { blockedRequests: r.blockedRequests } : null),
            ...(notes.length ? { notes } : null),
          },
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          value: r.value,
          elapsedMs: r.elapsedMs,
          input,
          ...(r.blockedRequests ? { blockedRequests: r.blockedRequests } : null),
          ...(notes.length ? { notes } : null),
        },
      };
    } finally {
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      activeControllers.delete(ac);
    }
  }

  async function handle(req, res) {
    if (req.headers?.['sec-fetch-site'] || req.headers?.origin) {
      return sendJson(res, 403, { ok: false, code: 'forbidden', error: '禁止浏览器直接访问内部音频测量沙箱' });
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'POST only' });
    }
    let rawBody;
    try {
      rawBody = await readRawBody(req, maxBodyBytes);
    } catch (error) {
      return sendJson(res, error?.status ?? 400, { ok: false, code: error?.code ?? 'bad-request', error: error?.message ?? '读取请求体失败' });
    }

    const auth = await verifyAuth(req, rawBody);
    if (!auth || auth.ok !== true) {
      say('hosted-audio-js.auth-failed', { reason: auth?.reason ?? 'unauthorized' });
      const status = auth?.reason === 'no-verifier' || auth?.reason === 'no-registry' ? 503 : 403;
      return sendJson(res, status, {
        ok: false,
        code: status === 503 ? 'unavailable' : 'unauthorized',
        reason: auth?.reason ?? 'unauthorized',
        error: '服务请求签名核验未通过',
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { ok: false, kind: 'invalid', error: '请求体不是合法的 JSON' });
    }

    const reqAbort = new AbortController();
    const abortReq = () => reqAbort.abort();
    req.once('aborted', abortReq);
    res.once('close', () => { if (!res.writableEnded) abortReq(); });

    try {
      const out = await run(parsed, { signal: reqAbort.signal });
      return sendJson(res, out.status, out.body);
    } finally {
      req.removeListener('aborted', abortReq);
    }
  }

  async function close() {
    closing = true;
    for (const ac of activeControllers) {
      try { ac.abort(); } catch {}
    }
    activeControllers.clear();
    if (ownsSandbox || typeof sandbox?.close === 'function') {
      await sandbox.close();
    }
    return { closed: true, alive: Boolean(sandbox?.alive) };
  }

  return Object.assign(handle, {
    handle,
    run,
    close,
    get alive() { return Boolean(sandbox?.alive); },
    get limits() { return sandbox.limits; },
  });
}
