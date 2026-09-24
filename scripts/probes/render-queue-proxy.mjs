/**
 * TCP 层代理探针：在节点与文档服务之间插一层，模拟延迟、队头阻塞、半开和断线。不解析 WebSocket。
 * 依据：`docs/plan/render-queue-contract.md` G.8。
 *
 * 跑：
 *   node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:8795 --target <host:port>
 *     [--delay-ms 200] [--loss 0.05] [--loss-hold-ms 200..1000] [--stall-after-ms N] [--cut-after-ms N]
 *
 * - --delay-ms：每个数据块晚这么久再转发（两个方向各自计）。
 * - --loss p：每个数据块以概率 p 被「扣住」一段随机时长（--loss-hold-ms 的区间，缺省 200..1000）再发；
 *   其后的块排在它后面、保持顺序，模拟 TCP 重传带来的队头阻塞。从不真丢字节：丢了会破坏 WebSocket 帧。
 * - --stall-after-ms N：连接建立 N 毫秒后两个方向都停止转发（收到的字节只攒着），但不关连接，模拟半开。
 * - --cut-after-ms N：连接建立 N 毫秒后两头直接断开。
 *
 * 每条连接关闭时往标准输出打一行 JSON 统计（event: conn.close）；Ctrl+C 结束时打一行汇总（event: summary）。
 * 本机测试用 8790～8799 的端口，不要用 5190～5192。
 * 退出码：参数不对 2；监听失败 1；正常结束 0。
 */
import { createServer, connect } from 'node:net';

const USAGE = `用法：node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:8795 --target <host:port>
  [--delay-ms 200] [--loss 0.05] [--loss-hold-ms 200..1000] [--stall-after-ms N] [--cut-after-ms N]`;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const VALUED = new Set(['--listen', '--target', '--delay-ms', '--loss', '--loss-hold-ms', '--stall-after-ms', '--cut-after-ms']);
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!VALUED.has(a)) usage(`不认识的参数：${a}`);
  const v = argv[++i];
  if (v === undefined) usage(`${a} 缺值`);
  args[a.slice(2)] = v;
}
if (!args.listen || !args.target) usage(argv.length ? '缺 --listen 或 --target' : undefined);

function hostPort(s, what) {
  const i = s.lastIndexOf(':');
  const host = i > 0 ? s.slice(0, i).replace(/^\[|\]$/g, '') : '127.0.0.1';
  const port = Number(i >= 0 ? s.slice(i + 1) : s);
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage(`${what} 的端口不对：${s}`);
  return { host, port };
}
const num = (name, dflt, { min = 0, max = Infinity } = {}) => {
  if (args[name] === undefined) return dflt;
  const n = Number(args[name]);
  if (!Number.isFinite(n) || n < min || n > max) usage(`--${name} 要是 ${min}～${max} 之间的数`);
  return n;
};

const listen = hostPort(args.listen, '--listen');
const target = hostPort(args.target, '--target');
const delayMs = num('delay-ms', 0);
const loss = num('loss', 0, { max: 1 });
let holdMin = 200;
let holdMax = 1000;
if (args['loss-hold-ms'] !== undefined) {
  const m = /^(\d+)(?:\.\.(\d+))?$/.exec(args['loss-hold-ms']);
  if (!m) usage('--loss-hold-ms 写成 200..1000 或单个数');
  holdMin = Number(m[1]);
  holdMax = m[2] === undefined ? holdMin : Number(m[2]);
  if (holdMax < holdMin) usage('--loss-hold-ms 的上界小于下界');
}
const stallAfterMs = args['stall-after-ms'] === undefined ? null : num('stall-after-ms', 0);
const cutAfterMs = args['cut-after-ms'] === undefined ? null : num('cut-after-ms', 0);

const out = (event, fields) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
const totals = { conns: 0, bytesUp: 0, bytesDown: 0, chunks: 0, held: 0, stalledConns: 0, cutConns: 0 };
const live = new Set();
let seq = 0;

/**
 * 单向转发：每块算一个放行时刻 = max(上一块的放行时刻, 现在 + 延迟 + 扣住时长)，按时刻依次写出，
 * 所以顺序永远不变，被扣住的块会把后面的块一起挡住（队头阻塞）。停转后只攒不写。
 */
function pipeWithFaults(from, to, conn, dir) {
  const queue = [];
  let lastRelease = 0;
  let timer = null;
  const flush = () => {
    timer = null;
    if (conn.stalled || to.destroyed) return;
    const now = Date.now();
    while (queue.length && queue[0].at <= now) {
      const { chunk } = queue.shift();
      to.write(chunk);
    }
    if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].at - now));
  };
  from.on('data', (chunk) => {
    conn[dir === 'up' ? 'bytesUp' : 'bytesDown'] += chunk.length;
    conn.chunks += 1;
    let hold = 0;
    if (loss > 0 && Math.random() < loss) {
      hold = holdMin + Math.random() * (holdMax - holdMin);
      conn.held += 1;
    }
    const at = Math.max(lastRelease, Date.now() + delayMs + hold);
    lastRelease = at;
    queue.push({ chunk, at });
    if (!conn.stalled && timer === null) timer = setTimeout(flush, Math.max(0, at - Date.now()));
  });
  return {
    pending: () => queue.length,
    stop: () => { clearTimeout(timer); timer = null; },
  };
}

const server = createServer((client) => {
  const id = ++seq;
  const startedAt = Date.now();
  const conn = { id, bytesUp: 0, bytesDown: 0, chunks: 0, held: 0, stalled: false, cut: false };
  totals.conns += 1;
  const upstream = connect(target.port, target.host);
  const timers = [];
  let closed = false;
  live.add(conn);
  client.on('error', () => {});
  upstream.on('error', () => {});
  const up = pipeWithFaults(client, upstream, conn, 'up');
  const down = pipeWithFaults(upstream, client, conn, 'down');
  out('conn.open', { id, from: `${client.remoteAddress}:${client.remotePort}` });

  const close = (why) => {
    if (closed) return;
    closed = true;
    live.delete(conn);
    for (const t of timers) clearTimeout(t);
    up.stop();
    down.stop();
    client.destroy();
    upstream.destroy();
    totals.bytesUp += conn.bytesUp;
    totals.bytesDown += conn.bytesDown;
    totals.chunks += conn.chunks;
    totals.held += conn.held;
    out('conn.close', {
      id, why, durationMs: Date.now() - startedAt, bytesUp: conn.bytesUp, bytesDown: conn.bytesDown,
      chunks: conn.chunks, held: conn.held, stalled: conn.stalled, cut: conn.cut,
      unsentUp: up.pending(), unsentDown: down.pending(),
    });
  };
  client.on('close', () => close('client-closed'));
  upstream.on('close', () => close('upstream-closed'));

  if (stallAfterMs !== null) {
    timers.push(setTimeout(() => {
      conn.stalled = true;
      totals.stalledConns += 1;
      up.stop();
      down.stop();
      out('conn.stall', { id });
    }, stallAfterMs));
  }
  if (cutAfterMs !== null) {
    timers.push(setTimeout(() => {
      conn.cut = true;
      totals.cutConns += 1;
      out('conn.cut', { id });
      close('cut');
    }, cutAfterMs));
  }
});

server.on('error', (err) => {
  out('listen.error', { message: err.message });
  process.exit(1);
});
server.listen(listen.port, listen.host, () => {
  const a = server.address();
  out('listen', { host: a.address, port: a.port, target: `${target.host}:${target.port}`, delayMs, loss, lossHoldMs: [holdMin, holdMax], stallAfterMs, cutAfterMs });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    out('summary', { ...totals, open: live.size });
    server.close();
    process.exit(0);
  });
}
