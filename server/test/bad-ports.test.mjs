/**
 * `global-setup.mjs` 的自检：坏端口名单与本机 Node 的 fetch 一致；`npm test` 下这些端口确实被占住了。
 * 跑：npm test（单独跑本文件时没有全局准备，第二条跳过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { FETCH_BAD_PORTS } from './global-setup.mjs';

const causeOf = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return 'ok';
  } catch (err) {
    return String(err?.cause?.message ?? err?.cause?.code ?? err?.name);
  }
};

test('名单里的每个端口，本机 fetch 都报 bad port；名单之外的邻号不报', async () => {
  for (const port of FETCH_BAD_PORTS) assert.equal(await causeOf(port), 'bad port', `端口 ${port}`);
  for (const port of [1718, 6001, 6670, 10081]) assert.notEqual(await causeOf(port), 'bad port', `端口 ${port}`);
});

test('npm test 下坏端口在 127.0.0.1 上已被全局准备占住，listen 拿不到', async (t) => {
  const held = process.env.PROMPTCUT_TEST_BAD_PORTS_HELD;
  if (held === undefined) { t.skip('没有经 npm test 的全局准备（单独跑本文件）'); return; }
  const ports = held.split(',').filter(Boolean).map(Number);
  assert.ok(ports.length >= FETCH_BAD_PORTS.length - 3, `大部分坏端口都该占住：${held}`);
  for (const port of ports) {
    const code = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (err) => resolve(err.code));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve('listening')));
    });
    assert.equal(code, 'EADDRINUSE', `端口 ${port}`);
  }
});
