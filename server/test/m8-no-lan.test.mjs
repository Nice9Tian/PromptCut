// M8「异地接入」探针公共件 scripts/probes/m8/no-lan.mjs 的纯逻辑：netstat 行解析与按对端地址计数（Windows、Linux 两种格式）
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetstatLine, foreignIs, countTcpTo, startNoLanWatch } from '../../scripts/probes/m8/no-lan.mjs';

const WINDOWS = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING',
  '  TCP    192.168.50.79:52001    8.219.80.16:443        ESTABLISHED',
  '  TCP    192.168.50.79:52002    192.168.50.96:5780     ESTABLISHED',
  '  TCP    192.168.50.79:52003    192.168.50.96:5789     TIME_WAIT',
  '  TCP    [::1]:5580             [::]:0                 LISTENING',
  '  UDP    0.0.0.0:5353           *:*',
].join('\r\n');

const LINUX = [
  'Active Internet connections (servers and established)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
  'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN',
  'tcp        0      0 10.0.0.5:40000          192.168.50.96:8787      ESTABLISHED',
  'tcp6       0      0 :::22                   :::*                    LISTEN',
  'udp        0      0 0.0.0.0:68              0.0.0.0:*',
].join('\n');

test('Windows 的 netstat 行：取本端与对端，UDP 与表头不算', () => {
  assert.deepEqual(parseNetstatLine('  TCP    192.168.50.79:52002    192.168.50.96:5780     ESTABLISHED'),
    { proto: 'TCP', local: '192.168.50.79:52002', foreign: '192.168.50.96:5780' });
  assert.equal(parseNetstatLine('  UDP    0.0.0.0:5353           *:*'), null);
  assert.equal(parseNetstatLine('  Proto  Local Address          Foreign Address        State'), null);
});

test('Linux 的 netstat 行：跳过 Recv-Q / Send-Q 两列', () => {
  assert.deepEqual(parseNetstatLine('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787      ESTABLISHED'),
    { proto: 'tcp', local: '10.0.0.5:40000', foreign: '192.168.50.96:8787' });
});

test('按对端地址计数：任何状态都算，本端是这个地址的不算', () => {
  assert.equal(countTcpTo(WINDOWS, '192.168.50.96').count, 2);
  assert.equal(countTcpTo(WINDOWS, '8.219.80.16').count, 1);
  assert.equal(countTcpTo(WINDOWS, '192.168.50.79').count, 0);
  assert.equal(countTcpTo(LINUX, '192.168.50.96').count, 1);
  assert.equal(countTcpTo(LINUX, '192.168.50.9').count, 0, '前缀相同的地址不算');
});

test('IPv4 映射的 IPv6 对端也认', () => {
  assert.equal(foreignIs('[::ffff:192.168.50.96]:5780', '192.168.50.96'), true);
  assert.equal(foreignIs('192.168.50.960:1', '192.168.50.96'), false);
});

test('地址不是 IPv4 就拒绝开始', () => {
  assert.throws(() => startNoLanWatch('pc.local'), /IPv4/);
});
