/**
 * 测试里要空闲端口：自己挑一个并试着监听确认空着，一次要多个时两两不同。
 * 不写死端口号，所以同一次 npm test 里的各文件之间、同一台机器上同时跑的两个 npm test 之间都不会撞端口。
 * 端口在 20000～49151 里随机挑，不会落在 5xxx、58xx、59xx 这些保留段。
 */
import net from 'node:net';

export async function freePorts(count = 1, host = '127.0.0.1') {
  // 这台机器的系统临时端口区间是 1024～15000，会落进 58xx 这类保留段，所以自己在 20000～49151 里随机挑、逐个试着监听确认空着。
  const servers = [], ports = [];
  while (ports.length < count) {
    const port = 20000 + Math.floor(Math.random() * (49152 - 20000));
    if (ports.includes(port)) continue;
    try {
      servers.push(await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
      }));
      ports.push(port);
    } catch { /* 被占了，换一个 */ }
  }
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

export async function freePort(host = '127.0.0.1') {
  return (await freePorts(1, host))[0];
}

/**
 * 要一段连续的、都空闲的端口（夹具里「基准端口 + 代号」那种用法）：先挑一个空闲的，再试它后面 count-1 个是否也空闲，不行就换一个重来。
 * 返回起点。
 */
export async function freePortRange(count, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = await freePort(host);
    if (base + count > 65535) continue;
    const servers = [];
    try {
      for (let i = 0; i < count; i += 1) {
        servers.push(await new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(base + i, host, () => resolve(server));
        }));
      }
    } catch { /* 这一段里有被占的，换一个起点 */ }
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    if (servers.length === count) return base;
  }
  throw new Error('free-port-range-unavailable');
}

/** startRunnerProcessFixture 要的那一组端口，全部取自系统给的空闲端口（identityBase、controlBase 各带一段给「代号」往上加）。 */
export async function runnerPorts() {
  const [a, b, c, d, e, f, g, agent, masterEvents, look, renderWorker] = await freePorts(11);
  return { combo: [a, b, c, d, e, f, g], agent, masterEvents, look, renderWorker,
    identityBase: await freePortRange(16), controlBase: await freePortRange(16) };
}
