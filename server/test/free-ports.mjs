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
