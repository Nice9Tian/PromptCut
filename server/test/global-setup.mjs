/**
 * 仅供测试。`npm test` 的全局准备（`node --test --test-global-setup=server/test/global-setup.mjs`），
 * 在测试运行器的主进程里跑一次，早于所有测试文件的子进程。
 *
 * 做一件事：**在整个测试期间占住 fetch 规范里的「坏端口」**，让各测试文件 `listen(0)` 拿不到它们。
 *
 * 为什么：Node 的 `fetch` 和内置 `WebSocket`（都是 undici）按 WHATWG fetch 规范拒绝连这些端口，
 * 报 `TypeError: fetch failed`（cause `bad port`）或 WebSocket 直接 error / 1006，连都不连。
 * 测试里的服务几乎都是 `listen(0)` 让系统给端口；系统的临时端口段缺省是 49152～65535，碰不到这份名单，
 * 但 Windows 的临时端口段可以被改到低段（有的机器就是），而且 Windows 是**全机一个计数器顺序发号**，
 * 并行跑的几十个测试进程一起往前走：走过 1719、4190、6000、6665～6669、10080 这些号时，恰好拿到它的服务
 * 就连不上。表现是全量测试偶发失败、单独跑必过，而且常常几个文件同时挂在 30 ms 左右（6665～6669 连着 5 个）。
 *
 * 占法：每个端口在 127.0.0.1 和 ::1 上各绑一个不接连接的监听（只绑回环，不开防火墙口子）。
 * 实测 Windows 给 `listen(0)` 发号时会跳过这些已占用的号，不论调用方绑的是 127.0.0.1、::1、0.0.0.0、:: 还是缺省。
 * 绑不上（端口已经被别的程序占着）就跳过：别人占着，系统同样不会把它发给测试。
 *
 * 子进程从环境变量 `PROMPTCUT_TEST_BAD_PORTS_HELD` 知道占住了哪些（`bad-ports.test.mjs` 用它自检）。
 */
import net from 'node:net';

/**
 * WHATWG fetch 规范「bad port」名单里 ≥ 1024 的部分（低于 1024 的系统不会当临时端口发）。
 * 最大的是 10080；`scripts/headless.mjs` 的 `freePort` 因此从 20000 以上挑。
 */
export const FETCH_BAD_PORTS = Object.freeze([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const HOSTS = ['127.0.0.1', '::1'];
const held = [];

function hold(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.unref();
      held.push(server);
      resolve(true);
    });
  });
}

export async function globalSetup() {
  const got = [];
  for (const port of FETCH_BAD_PORTS) {
    let any = false;
    for (const host of HOSTS) if (await hold(port, host)) any = true;
    if (any) got.push(port);
  }
  process.env.PROMPTCUT_TEST_BAD_PORTS_HELD = got.join(',');
}

export async function globalTeardown() {
  await Promise.all(held.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
}
