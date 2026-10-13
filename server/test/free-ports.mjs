/**
 * 测试里向系统要空闲端口：同时监听若干个端口 0、读回实际端口再一起关掉，保证同一次要到的端口两两不同。
 * 不写死端口号，所以同一次 npm test 里的各文件之间、同一台机器上同时跑的两个 npm test 之间都不会撞端口。
 * 系统分配的是临时端口区间（Windows 49152 起），不会落在 5xxx、58xx、59xx 这些保留段。
 */
import net from 'node:net';

export async function freePorts(count = 1, host = '127.0.0.1') {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  })));
  const ports = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

export async function freePort(host = '127.0.0.1') {
  return (await freePorts(1, host))[0];
}

/**
 * 要一段连续的、都空闲的端口（夹具里「基准端口 + 代号」那种用法）：先让系统给一个，再试它后面 count-1 个是否也空闲，不行就换一个重来。
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
