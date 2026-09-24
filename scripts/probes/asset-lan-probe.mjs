// 探针:局域网素材服务端到端(W2)。契约见 docs/plan/asset-store-contract.md 第 6 节末段。
//
//   node scripts/probes/asset-lan-probe.mjs --docservice <ws://…> [--asset <http://…/api/asset>] [--mb 20] [--timeout-ms 60000]
//
// 在另一台机器(笔记本)上跑,只用 Node 内置模块(要 Node 22 起的全局 WebSocket、fetch),不需要 node_modules。
// 集群令牌从环境变量 PROMPTCUT_CLUSTER_TOKEN 读,只放进 Authorization 头和 WebSocket 子协议,不打印。
//
// 素材服务地址:
//   - 没给 --asset:连 --docservice,发 service.watch { kinds: ['asset'] },按登记顺序取第一个
//     GET <url>/media/<一个不存在的哈希>/chunks 能通的地址(source: 'docservice')。地址来自控制面下发,不手填;
//   - 给了 --asset:直接用它(source: 'arg'),不连控制面。
//
// 断言(按顺序):
//   1. 随机生成 --mb MB 数据,算出 sha256;
//   2. 不带令牌 PUT 第 0 片 → 401;
//   3. 带令牌只传第 0、1 片,chunks 报 received: [0, 1];
//   4. 补传其余分片,complete → 200;
//   5. 带 Origin: http://192.168.50.247:9999 的 GET 回 Access-Control-Allow-Origin: *;
//   6. Range: bytes=100-199 → 206,字节正确;
//   7. 全件下载后 sha256 相符。
//
// 输出一行 JSON:{ ok, assetUrl, source, bytes, steps: [{ name, ok, ms }], fails: [{ step, detail }] }
// 退出码:0 全过;1 有断言失败(含超时);2 用法不对、没有令牌、连不上控制面或素材服务。
import crypto from 'node:crypto';

const USAGE = `用法:node scripts/probes/asset-lan-probe.mjs --docservice <ws://…> [--asset <http://…/api/asset>] [--mb 20] [--timeout-ms 60000]
  --docservice  控制面(文档服务)地址,ws:// 或 wss://;没给 --asset 时从这里订阅素材服务地址
  --asset       直接指定素材服务基址(…/api/asset),跳过控制面
  --mb          测试数据大小,单位 MB(缺省 20)
  --timeout-ms  整趟的超时(缺省 60000)
  令牌从环境变量 PROMPTCUT_CLUSTER_TOKEN 读。
  退出码:0 全过,1 有断言失败,2 连不上(或用法不对)。`;

const CHUNK_DEFAULT = 8 * 1024 * 1024;
const LAN_ORIGIN = 'http://192.168.50.247:9999';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { error: `多余的参数 ${a}` };
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (val === undefined) return { error: `--${key} 缺值` };
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (process.argv.length <= 2 || args.error || (!args.docservice && !args.asset) || args.help) {
  if (args.error) console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
const MB = Number(args.mb ?? 20);
const TIMEOUT_MS = Number(args['timeout-ms'] ?? 60000);
if (!(MB > 0) || !(TIMEOUT_MS > 0)) {
  console.error(USAGE);
  process.exit(2);
}
const TOKEN = process.env.PROMPTCUT_CLUSTER_TOKEN || '';

const result = { ok: false, assetUrl: null, source: args.asset ? 'arg' : 'docservice', bytes: 0, steps: [], fails: [] };
let finished = false;
/** 打一行 JSON 退出。令牌不在 result 里,保险起见再擦一遍 */
function finish(code) {
  if (finished) return;
  finished = true;
  result.ok = code === 0 && result.fails.length === 0;
  let line = JSON.stringify(result);
  if (TOKEN) line = line.split(TOKEN).join('<token>');
  process.exitCode = code;
  // 写完再退出:管道上的 stdout 可能是异步的
  process.stdout.write(`${line}\n`, () => process.exit(code));
}
/** 连不上一类:退出码 2 */
class Unreachable extends Error {}

const deadline = Date.now() + TIMEOUT_MS;
const left = () => Math.max(1, deadline - Date.now());
const watchdog = setTimeout(() => {
  result.fails.push({ step: 'timeout', detail: `整趟超过 ${TIMEOUT_MS} ms` });
  finish(1);
}, TIMEOUT_MS);
watchdog.unref?.();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const safe = (text) => (TOKEN ? String(text).split(TOKEN).join('<token>') : String(text));

async function request(url, init = {}, ms = left()) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(ms, left())) });
  } catch (err) {
    throw new Unreachable(`${init.method || 'GET'} ${url}:${safe(err?.cause?.message || err?.message || err)}`);
  }
}

/** 一步:计时、记结果;断言失败记进 fails 但继续跑后面的步骤,连不上就整趟停 */
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    result.steps.push({ name, ok: true, ms: Date.now() - t0 });
    return true;
  } catch (err) {
    result.steps.push({ name, ok: false, ms: Date.now() - t0 });
    if (err instanceof Unreachable) throw err;
    result.fails.push({ step: name, detail: safe(err?.message || err) });
    return false;
  }
}
function check(cond, detail) {
  if (!cond) throw new Error(detail);
}

/** 连控制面,订阅 asset 登记,按顺序找第一个能通的地址 */
async function discover(docservice) {
  let parsed;
  try { parsed = new URL(docservice); } catch { throw new Unreachable(`--docservice 不是合法地址:${docservice}`); }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Unreachable('--docservice 要 ws:// 或 wss://');
  if (typeof WebSocket !== 'function') throw new Unreachable('这个 Node 没有全局 WebSocket(要 Node 22 起)');
  const protocols = TOKEN ? ['promptcut.v1', `promptcut.token.${TOKEN}`] : ['promptcut.v1'];
  const ws = new WebSocket(docservice, protocols);
  try {
    const registrations = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Unreachable('等控制面的 service.endpoints 超时')), Math.min(left(), 15000));
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'service.watch', kinds: ['asset'] })));
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Unreachable(`连不上控制面 ${parsed.protocol}//${parsed.host}${parsed.pathname}`)); });
      ws.addEventListener('close', (e) => { clearTimeout(timer); reject(new Unreachable(`控制面关了连接(${e.code}${e.reason ? ` ${e.reason}` : ''})`)); });
      ws.addEventListener('message', (e) => {
        let m;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m?.type === 'error') { clearTimeout(timer); reject(new Unreachable(`控制面回 error:${m.reason ?? ''}`)); return; }
        if (m?.type !== 'service.endpoints' || !Array.isArray(m.endpoints)) return;
        const list = m.endpoints.filter((x) => x?.kind === 'asset' && Array.isArray(x.urls) && x.urls.length);
        if (list.length) { clearTimeout(timer); resolve(list); }
        // 空表:等后续推送
      });
    });
    const missing = sha256(crypto.randomBytes(32));
    for (const reg of registrations) {
      for (const u of reg.urls) {
        const base = String(u).replace(/\/+$/, '');
        try {
          const r = await request(`${base}/media/${missing}/chunks`, {}, 3000);
          await r.arrayBuffer().catch(() => {});
          if (r.status === 200) return base;
        } catch { /* 下一个 */ }
      }
    }
    throw new Unreachable(`控制面登记的素材服务地址都不通:${registrations.flatMap((r) => r.urls).join(', ')}`);
  } finally {
    try { ws.close(); } catch { /* 已关 */ }
  }
}

async function main() {
  const base = args.asset ? String(args.asset).replace(/\/+$/, '') : await discover(args.docservice);
  result.assetUrl = base;
  if (!TOKEN) throw new Unreachable('没有令牌:设环境变量 PROMPTCUT_CLUSTER_TOKEN');

  let buf;
  let hash;
  let chunkSize = CHUNK_DEFAULT;
  await step('generate', async () => {
    buf = crypto.randomBytes(Math.round(MB * 1024 * 1024));
    hash = sha256(buf);
    result.bytes = buf.length;
    const r = await request(`${base}/media/${hash}/chunks`);
    check(r.status === 200, `chunks 回 ${r.status}`);
    const st = await r.json();
    check(st.complete === false && Array.isArray(st.received) && st.received.length === 0, `新哈希的对账不对:${JSON.stringify(st)}`);
    if (Number.isSafeInteger(st.chunkSize) && st.chunkSize > 0) chunkSize = st.chunkSize;
  });
  if (!buf) return;
  const count = Math.max(1, Math.ceil(buf.length / chunkSize));
  const slice = (n) => buf.subarray(n * chunkSize, Math.min(buf.length, (n + 1) * chunkSize));
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'bin' };
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const putChunk = async (n, withToken) => {
    const r = await request(`${base}/media/${hash}/${n}`, { method: 'PUT', body: slice(n), headers: withToken ? { ...headers, ...auth } : headers });
    const text = await r.text().catch(() => '');
    return { status: r.status, text };
  };

  await step('put-without-token-401', async () => {
    const r = await putChunk(0, false);
    check(r.status === 401, `不带令牌 PUT 第 0 片回 ${r.status}:${r.text.slice(0, 200)}`);
  });

  const first = Math.min(2, count);
  await step('put-0-1-received', async () => {
    for (let n = 0; n < first; n++) {
      const r = await putChunk(n, true);
      check(r.status === 200, `PUT 第 ${n} 片回 ${r.status}:${r.text.slice(0, 200)}`);
    }
    const st = await (await request(`${base}/media/${hash}/chunks`)).json();
    const want = Array.from({ length: first }, (_, i) => i);
    check(JSON.stringify(st.received) === JSON.stringify(want), `chunks 报 received ${JSON.stringify(st.received)},应为 ${JSON.stringify(want)}`);
  });

  await step('put-rest-complete', async () => {
    for (let n = first; n < count; n++) {
      const r = await putChunk(n, true);
      check(r.status === 200, `PUT 第 ${n} 片回 ${r.status}:${r.text.slice(0, 200)}`);
    }
    const r = await request(`${base}/media/${hash}/complete`, { method: 'POST', headers: auth });
    const text = await r.text().catch(() => '');
    check(r.status === 200, `complete 回 ${r.status}:${text.slice(0, 200)}`);
  });

  await step('cors-get', async () => {
    const r = await request(`${base}/media/${hash}`, { headers: { Origin: LAN_ORIGIN, Range: 'bytes=0-0' } });
    await r.arrayBuffer().catch(() => {});
    check(r.status === 200 || r.status === 206, `GET 回 ${r.status}`);
    check(r.headers.get('access-control-allow-origin') === '*', `Access-Control-Allow-Origin 是 ${r.headers.get('access-control-allow-origin')}`);
  });

  await step('range-206', async () => {
    const r = await request(`${base}/media/${hash}`, { headers: { Range: 'bytes=100-199' } });
    const got = Buffer.from(await r.arrayBuffer());
    check(r.status === 206, `Range 回 ${r.status}`);
    check(got.equals(buf.subarray(100, 200)), `Range 字节不对(收到 ${got.length} 字节)`);
  });

  await step('download-sha256', async () => {
    const r = await request(`${base}/media/${hash}`);
    const got = Buffer.from(await r.arrayBuffer());
    check(r.status === 200, `GET 全件回 ${r.status}`);
    check(got.length === buf.length, `长度 ${got.length},应为 ${buf.length}`);
    check(sha256(got) === hash, 'sha256 不符');
  });
}

main().then(
  () => finish(result.fails.length ? 1 : 0),
  (err) => {
    result.fails.push({ step: 'connect', detail: safe(err?.message || err) });
    finish(err instanceof Unreachable ? 2 : 1);
  },
);
