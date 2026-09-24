/**
 * 文档服务骨架的连通性探针：真正发起一条 WebSocket 连接，按渲染节点、发布方的身份报到，逐项断言回包。
 *
 * 跑：node scripts/probes/ws-client-test.mjs [ws://host:port]      缺省 ws://127.0.0.1:8787
 * 只用 Node 内置的 WebSocket 与 fetch（Node >= 22），不装依赖。全过退出码 0，有失败 1，连不上 2。
 *
 * 断言依据：`docs/plan/render-queue-contract.md` A.6（node.hello → node.welcome、publisher.hello → publisher.welcome、
 * queue.watch → queue.snapshot、格式错误 → error bad-message），以及 server/docservice/service.mjs 的 /healthz。
 */
const url = process.argv[2] ?? 'ws://127.0.0.1:8787';
const TIMEOUT_MS = 10_000;
const nodeId = `probe-node-${process.pid}`;
const publisherId = `probe-page-${process.pid}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); reject(new Error(`${TIMEOUT_MS} ms 内没连上`)); }, TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(ws); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message ?? '连接出错')); }, { once: true });
  });
}

/** 发一条带 reqId 的消息，等 reqId 相同的回包；返回 { msg, rttMs } */
function request(ws, message) {
  return new Promise((resolve, reject) => {
    const sentAt = performance.now();
    const onMessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.reqId !== message.reqId) return;
      cleanup();
      resolve({ msg, rttMs: Math.round(performance.now() - sentAt) });
    };
    const t = setTimeout(() => { cleanup(); reject(new Error(`${message.type} 在 ${TIMEOUT_MS} ms 内没有回包`)); }, TIMEOUT_MS);
    const cleanup = () => { clearTimeout(t); ws.removeEventListener('message', onMessage); };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

console.log(`target ${url}`);
let ws;
const t0 = performance.now();
try {
  ws = await connect();
} catch (err) {
  check('WebSocket 握手', false, err.message);
  process.exit(2);
}
check('WebSocket 握手', true, `${Math.round(performance.now() - t0)} ms`);

try {
  // 1. 渲染节点报到
  const hello = {
    type: 'node.hello', reqId: 'hello-1', nodeId, profile: 'host',
    capabilities: { transcode: false }, codeVersions: [], maxConcurrent: 1,
  };
  console.log(`>>> ${JSON.stringify(hello)}`);
  const { msg: welcome, rttMs } = await request(ws, hello);
  console.log(`<<< ${JSON.stringify(welcome)}`);
  check('node.hello → node.welcome', welcome.type === 'node.welcome', `${rttMs} ms`);
  check('welcome.nodeId 回显', welcome.nodeId === nodeId);
  check('welcome 带 resumed / lost 数组', Array.isArray(welcome.resumed) && Array.isArray(welcome.lost));
  check('welcome 带队列 epoch', typeof welcome.epoch === 'string' && welcome.epoch.length > 0);

  // 2. 同一连接再以发布方报到（契约 A.5：一条连接可以两者都是）
  const { msg: pub } = await request(ws, { type: 'publisher.hello', reqId: 'hello-2', publisherId });
  check('publisher.hello → publisher.welcome', pub.type === 'publisher.welcome' && pub.publisherId === publisherId);

  // 3. 节点订阅队列
  const { msg: snap } = await request(ws, { type: 'queue.watch', reqId: 'watch-1', projects: 'all' });
  check('queue.watch → queue.snapshot', snap.type === 'queue.snapshot' && Array.isArray(snap.tasks), `tasks=${snap.tasks?.length}`);

  // 4. 格式错误的消息
  const { msg: bad } = await request(ws, { type: 'node.hello', reqId: 'bad-1', nodeId, profile: 'toaster' });
  check('格式错误 → error bad-message', bad.type === 'error' && bad.reason === 'bad-message', bad.detail);

  // 5. 服务端记下了这条连接的身份（HTTP 同端口）
  const health = await fetch(url.replace(/^ws/, 'http').replace(/\/?$/, '/healthz')).then((r) => r.json());
  console.log(`healthz ${JSON.stringify(health)}`);
  check('healthz 里记到节点与发布方', health.ok === true && health.nodes >= 1 && health.publishers >= 1);
} catch (err) {
  check('请求过程', false, err.message);
}

ws.close(1000, 'probe done');
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
