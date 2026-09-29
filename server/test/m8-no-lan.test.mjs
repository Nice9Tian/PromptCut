// M8「异地接入」探针公共件 scripts/probes/m8/no-lan.mjs 的纯逻辑：netstat 行解析与按对端地址计数（Windows、Linux 两种格式）。
// 只数已建立（ESTABLISHED）的连接：上一项留下的 TIME_WAIT 不算（REPORT-render-queue-m8.md 第 13.5 节的弱点之一）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetstatLine, foreignIs, countTcpTo, judgeNoLanTcp, startNoLanWatch, COUNTED_STATES } from '../../scripts/probes/m8/no-lan.mjs';

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
    { proto: 'TCP', local: '192.168.50.79:52002', foreign: '192.168.50.96:5780', state: 'ESTABLISHED' });
  assert.equal(parseNetstatLine('  TCP    192.168.50.79:52003    192.168.50.96:5789     TIME_WAIT').state, 'TIME_WAIT');
  assert.equal(parseNetstatLine('  UDP    0.0.0.0:5353           *:*'), null);
  assert.equal(parseNetstatLine('  Proto  Local Address          Foreign Address        State'), null);
});

test('Linux 的 netstat 行：跳过 Recv-Q / Send-Q 两列', () => {
  assert.deepEqual(parseNetstatLine('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787      ESTABLISHED'),
    { proto: 'tcp', local: '10.0.0.5:40000', foreign: '192.168.50.96:8787', state: 'ESTABLISHED' });
  assert.equal(parseNetstatLine('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787').state, null, '没有状态列就是 null');
});

test('按对端地址计数：只数已建立的，TIME_WAIT 另记；本端是这个地址的不算', () => {
  assert.deepEqual(COUNTED_STATES, ['ESTABLISHED']);
  const w = countTcpTo(WINDOWS, '192.168.50.96');
  assert.equal(w.count, 1, 'TIME_WAIT 那一条不算');
  assert.deepEqual(w.lines.map((l) => l.foreign), ['192.168.50.96:5780']);
  assert.deepEqual(w.other.map((l) => `${l.foreign} ${l.state}`), ['192.168.50.96:5789 TIME_WAIT']);
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

/** 上一项刚跑完：到 PC 的连接全在 TIME_WAIT / CLOSE_WAIT / FIN_WAIT_2 */
const LEFTOVER = [
  '  Proto  Local Address          Foreign Address        State',
  '  TCP    192.168.50.79:52010    192.168.50.96:5780     TIME_WAIT',
  '  TCP    192.168.50.79:52011    192.168.50.96:5781     TIME_WAIT',
  '  TCP    192.168.50.79:52012    192.168.50.96:5789     CLOSE_WAIT',
  '  TCP    192.168.50.79:52013    192.168.50.96:5789     FIN_WAIT_2',
  '  TCP    192.168.50.79:52014    8.219.80.16:443        ESTABLISHED',
];

test('判法：上一项留下的 TIME_WAIT 等不判失败；真有已建立的连接才判失败；没采样到不算过', () => {
  const left = countTcpTo(LEFTOVER.join('\r\n'), '192.168.50.96');
  assert.equal(left.count, 0);
  assert.equal(left.other.length, 4);
  assert.equal(judgeNoLanTcp({ samples: 3, maxTcp: left.count }), true);
  const live = countTcpTo([...LEFTOVER, '  TCP    192.168.50.79:52015    192.168.50.96:5780     ESTABLISHED'].join('\r\n'), '192.168.50.96');
  assert.equal(live.count, 1);
  assert.equal(judgeNoLanTcp({ samples: 3, maxTcp: live.count }), false);
  assert.equal(judgeNoLanTcp({ samples: 0, maxTcp: 0 }), false, 'netstat 一次都没跑成不算过');
  assert.equal(countTcpTo('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787      TIME_WAIT', '192.168.50.96').count, 0, 'Linux 的 TIME_WAIT 也不算');
});
