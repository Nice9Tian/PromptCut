/**
 * 云端 Agent 的浏览器出网:一切只经出网闸的代理,绕过代理的途径逐个堵上
 * (`server/web/hosted/network.mjs`、`session.mjs`;契约 `docs/plan/cloud-agent-contract.md` 第 9.6 节)。
 * 跑:npm test -- server/test/cloud-tools-w1-egress.test.mjs
 *
 * 真的:puppeteer 自带的 Chrome for Testing(无头);本测试在 127.0.0.1 上起的三个服务——
 *   「公网上的站」127.0.0.1:28390(出网闸的测试例外只放行这一个「IP:端口」)、
 *   「内网里的服务」127.0.0.1:28391(没有放行;它被连上一次就算漏)、
 *   「重绑定后的内网地址」127.0.0.2:28390(同端口、另一个回环地址,没有放行);
 *   另有一个收 UDP 的假 STUN(127.0.0.1:28392)。DNS 用可注入的解析函数模拟。全程不连公网。
 *
 *   W1-EGRESS-01  纯函数:地址规范化(只收 http/https)、页面请求按协议放行、部署者追加的启动参数过滤、启动参数里该有的都有
 *   W1-EGRESS-02  代理自己(不起浏览器):明文与 CONNECT 每个目标过闸;同一条连接上换目标照样重查;隧道数上限;关闭后连接都断
 *   W1-EGRESS-03  起浏览器时交给它的东西:用管道不开调试端口、无头、环境变量按白名单重建(没有 PROMPTCUT_*、没有代理变量)、
 *                 参数以探针那一个打头;部署者追加的参数里改代理、开调试口的被丢掉
 *   W1-EGRESS-04  工具入口:回环、内网、metadata、IPv6 的对应范围、各种写法、不许的端口、带口令的地址——web_open 当场拒,
 *                 浏览器都没碰;`file:`、`chrome:`、`view-source:`、`data:`、`javascript:` 等非 http(s) 协议当场拒
 *   W1-EGRESS-05  页面里发起的(fetch、XHR、图片、iframe、sendBeacon、WebSocket、preconnect / dns-prefetch / prefetch / preload):
 *                 去回环、内网、metadata、IPv6——每一个都到了代理并被拒(记录里有),「内网里的服务」一次都没被连上,页面上没有内网的字
 *   W1-EGRESS-06  对照:去掉「回环与链路本地也走代理」那个参数,同一个页面就直连到了「内网里的服务」(证明上一条不是空过)
 *   W1-EGRESS-07  跳转到内网:302、页面里的 meta 跳转、跳到 file:——都没到;「内网里的服务」零连接
 *   W1-EGRESS-08  DNS 重绑定:名字先解析到放行的地址、页面开着的时候改解析到内网——之后的请求被拒,重绑定后的地址零连接;
 *                 一个名字同时指着外网与内网的整个拒;解析到 metadata 的名字拒
 *   W1-EGRESS-09  WebRTC:收集不到任何带本机地址的候选,假 STUN 一个 UDP 包都没收到;对照(去掉策略参数)能收到;
 *                 走 TCP 的 TURN 中继指向本机假服务:零连接(那条 TCP 也只能经代理,被拒)
 *   W1-EGRESS-10  WebSocket 走的也是代理:连放行的站连得上(代理记录里有这条隧道),连内网被拒
 *   W1-EGRESS-11  页面里的 file: 链接与 iframe 读不到本机文件
 *   W1-EGRESS-13  下载的对照:把下载行为设成「允许」文件就真的落盘;云端的浏览器里同一个地址被拒、不落盘
 *   W1-EGRESS-14  弹出页(绕过了并回当前页的那道)抢在被关之前发的请求,也只能到代理:内网服务零连接
 *   W1-EGRESS-12  节点上装的那种浏览器(chrome-headless-shell,同版本):上面第 5、7、9 条在它身上同样成立
 *
 * 下载被拒在 `cloud-tools-w1-browser.test.mjs` 的 W1-TOOL-04。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { w1Fixture, item, sleep, until, testChromePath, testHeadlessShellPath, projectId, conversationId, TEST_CHROME_ARG_PREFIX, TEST_EXTRA_ARGS, isHeadlessShell, rawLaunchOptions } from './cloud-tools-w1-fixture.mjs';
import { startFakeSite, startInternalService } from './cloud-tools-w1-site.mjs';
import { createEgressGate } from '../agent/service/egress.mjs';
import { normalizeWebTarget, pageRequestAllowed, filterExtraArgs, ALLOWED_EXTRA_ARGS, hostedNetworkArgs, startBrowserProxy, egressRefusalText } from '../web/hosted/network.mjs';
import { launchHostedSession, HOSTED_BROWSER_ARG_PREFIX } from '../web/hosted/session.mjs';
import { HOSTED_BROWSER_DEFAULTS } from '../agent/service/hosted-browser.mjs';

const SITE_PORT = 28390;
const INTERNAL_PORT = 28391;
const STUN_PORT = 28392;
const TURN_PORT = 28393;
const ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
const INTERNAL = `http://127.0.0.1:${INTERNAL_PORT}`;
const ALLOW = [`127.0.0.1:${SITE_PORT}`];
const SECRET = 'INTERNAL-SECRET-DO-NOT-LEAK';
const scope = { projectId, conversationId };

let site;
let internal;
let rebound;
let stun;
let stunPackets = 0;
const dns = { rebind: false, calls: [] };

/** 模拟 DNS。没列的名字一律解析不了(测试不连公网) */
async function resolve(hostname) {
  dns.calls.push(hostname);
  if (hostname === 'localhost') return [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
  if (hostname === 'site.test') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'rebind.test') return [{ address: dns.rebind ? '127.0.0.2' : '127.0.0.1', family: 4 }];
  if (hostname === 'mixed.test') return [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.5', family: 4 }];
  if (hostname === 'metadata.google.internal') return [{ address: '169.254.169.254', family: 4 }];
  if (hostname === 'intranet.corp') return [{ address: '192.168.10.20', family: 4 }];
  throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
}

test.before(async () => {
  site = await startFakeSite(SITE_PORT, { internalUrl: `${INTERNAL}/from-redirect` });
  internal = await startInternalService(INTERNAL_PORT);
  rebound = await startInternalService(SITE_PORT, { host: '127.0.0.2' });
  stun = dgram.createSocket('udp4');
  stun.on('message', () => { stunPackets += 1; });
  await new Promise((r) => stun.bind(STUN_PORT, '127.0.0.1', r));
});
test.after(async () => {
  await site?.close(); await internal?.close(); await rebound?.close();
  await new Promise((r) => stun.close(r));
});

const readText = async (f, context) => (await f.tools.call('web_read', { limit: 20000 }, context)).text;
const untilText = (f, context, marker, ms = 60_000) => until(async () => {
  const text = await readText(f, context);
  return text.includes(marker) ? text : null;
}, { ms, step: 400, what: `页面出现 ${marker}` });
const refusedFor = (journal, host) => journal.filter((e) => !e.ok && e.host === host);

/** 页面要去连的「内网」地址,连同它在代理记录里的主机名与原因码 */
const LEAK_TARGETS = [
  { url: `${INTERNAL}/a`, host: '127.0.0.1', what: '回环(没放行的端口)' },
  { url: `http://localhost:${INTERNAL_PORT}/b`, host: 'localhost', what: 'localhost' },
  { url: `http://[::1]:${INTERNAL_PORT}/c`, host: '::1', what: 'IPv6 回环' },
  { url: `http://0.0.0.0:${INTERNAL_PORT}/d`, host: '0.0.0.0', what: '0.0.0.0' },
  { url: `http://2130706433:${INTERNAL_PORT}/e`, host: '127.0.0.1', what: '十进制写法的 127.0.0.1' },
  { url: 'http://10.0.0.1/f', host: '10.0.0.1', what: '内网 10/8' },
  { url: 'http://192.168.1.1:8080/g', host: '192.168.1.1', what: '内网 192.168/16' },
  { url: 'http://172.16.0.9/h', host: '172.16.0.9', what: '内网 172.16/12' },
  { url: 'http://169.254.169.254/latest/meta-data/', host: '169.254.169.254', what: '云厂商 metadata' },
  { url: 'http://[fd00:ec2::254]/latest/meta-data/', host: 'fd00:ec2::254', what: 'IPv6 的 metadata(唯一本地地址)' },
  { url: 'http://[::ffff:169.254.169.254]/i', host: '::ffff:a9fe:a9fe', what: '包着 metadata 的 IPv4 映射地址' },
  { url: 'http://[fe80::1]/j', host: 'fe80::1', what: 'IPv6 链路本地' },
  { url: 'http://metadata.google.internal/computeMetadata/v1/', host: 'metadata.google.internal', what: '解析到 metadata 的名字' },
  { url: 'http://intranet.corp/k', host: 'intranet.corp', what: '解析到内网的名字' },
];
const leakUrl = (origin = ORIGIN) => `${origin}/leak?${LEAK_TARGETS.map((t) => `t=${encodeURIComponent(t.url)}`).join('&')}`;

test('W1-EGRESS-01 纯函数:地址、协议、启动参数', () => {
  assert.equal(normalizeWebTarget('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeWebTarget('HTTP://Example.com'), 'HTTP://Example.com');
  assert.equal(normalizeWebTarget('  example.com/x '), 'https://example.com/x', '不带协议按 https 补(同桌面版)');
  assert.equal(normalizeWebTarget('example.com:8443/x'), 'https://example.com:8443/x', '「名字:端口」不是协议');
  assert.equal(normalizeWebTarget('localhost:8080'), 'https://localhost:8080');
  for (const bad of ['file:///etc/passwd', 'file://C:/Windows/win.ini', 'FILE:///x', 'chrome://version', 'chrome-extension://abc/x.html', 'view-source:https://example.com',
    'data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'about:blank', 'blob:https://example.com/uuid', 'ftp://example.com/x', 'ws://example.com/', 'wss://example.com/',
    'devtools://devtools/bundled/inspector.html', 'filesystem:https://example.com/temporary/x', 'mailto:a@b.c', 'tel:123', 'gopher://x', '//example.com/x', '\\\\server\\share\\x', 'smb://server/share']) {
    assert.throws(() => normalizeWebTarget(bad), { code: 'protocol' }, bad);
  }
  assert.throws(() => normalizeWebTarget(''), { code: 'empty' });
  assert.throws(() => normalizeWebTarget('   '), { code: 'empty' });
  assert.throws(() => normalizeWebTarget(`https://example.com/${'a'.repeat(5000)}`), { code: 'too-long' });
  assert.throws(() => normalizeWebTarget('https://example.com/\nHost: evil'), { code: 'protocol' });

  for (const ok of ['http://a/', 'https://a/', 'about:blank', 'about:srcdoc', 'data:image/png;base64,AA', 'blob:https://a/1']) assert.equal(pageRequestAllowed(ok), true, ok);
  for (const bad of ['file:///etc/passwd', 'chrome://settings', 'ftp://a/', 'ws://a/', 'filesystem:https://a/x', 'view-source:https://a', 'chrome-extension://x/y', '', 'nonsense', null]) assert.equal(pageRequestAllowed(bad), false, String(bad));

  const args = hostedNetworkArgs('http://127.0.0.1:1234');
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:1234'));
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'), '回环与链路本地也走代理');
  assert.ok(args.some((a) => a.startsWith('--host-resolver-rules=MAP * ~NOTFOUND')), '浏览器自己不解析主机名');
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(args.includes('--disable-quic'));
  assert.ok(args.includes('--disable-background-networking'));

  const extra = filterExtraArgs(['--no-sandbox', '--disable-gpu', '--proxy-server=http://evil:1', '--no-proxy-server', '--proxy-bypass-list=*', '--host-resolver-rules=MAP * 1.2.3.4',
    '--remote-debugging-port=9222', '--remote-debugging-address=0.0.0.0', '--disable-web-security', '--user-data-dir=/tmp/x', '--headless=old', '--load-extension=/x',
    '--force-webrtc-ip-handling-policy=default', 'not-a-flag', 42, '--ok\n--proxy-server=x', '--allow-file-access-from-files', '--enable-quic']);
  assert.deepEqual(extra.args, ['--no-sandbox', '--disable-gpu']);
  assert.equal(extra.dropped.length, 16);
  // 白名单:整条相等才留。黑名单时代漏掉的这些,现在一个都进不来
  const sneaky = ['--disable-extensions-except=/x', '--disk-cache-dir=/srv/other', '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list=abc',
    '--unsafely-treat-insecure-origin-as-secure=http://evil', '--allow-running-insecure-content', '--log-net-log=/tmp/net.json', '--ssl-key-log-file=/tmp/keys',
    '--explicitly-allowed-ports=22', '--disable-site-isolation-trials', '--single-process', '--enable-features=NetworkServiceInProcess', '--disable-features=IsolateOrigins',
    '--no-sandbox=1', '--NO-SANDBOX', ' --no-sandbox', '--no-sandbox --proxy-server=http://evil:1', '--disable-gpu-sandbox', '--renderer-cmd-prefix=sh', '--utility-cmd-prefix=sh',
    '--gpu-launcher=sh', '--enable-logging', '--user-agent=x', '--js-flags=--expose-gc', '--remote-debugging-pipe', '--auto-open-devtools-for-tabs', '--', '-no-sandbox', null, {}, ['--no-sandbox']];
  assert.deepEqual(filterExtraArgs(sneaky), { args: [], dropped: sneaky.map(String) });
  assert.deepEqual(filterExtraArgs([...ALLOWED_EXTRA_ARGS, '--no-sandbox']).args, [...ALLOWED_EXTRA_ARGS], '名单里的都留,重复的只留一个');
  assert.deepEqual([...ALLOWED_EXTRA_ARGS], ['--no-sandbox', '--disable-setuid-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer', '--disable-field-trial-config'],
    '名单改了要同时改报告里那张表');
  assert.deepEqual(filterExtraArgs('--no-sandbox'), { args: [], dropped: [] }, '不是数组:当没给');
  assert.match(egressRefusalText('blocked-address'), /内网/);
});

test('W1-EGRESS-02 代理自己:每个目标过闸,同一条连接上换目标照样重查', async () => {
  const log = [];
  const gate = createEgressGate({ testAllow: ALLOW, resolve });
  const proxy = await startBrowserProxy({ gate, maxTunnels: 2, log: (event, fields) => log.push({ event, ...fields }) });
  const before = { site: site.hits.length, internal: internal.state.connections };
  try {
    /** 经代理发一个明文请求(同一个 agent = 同一条到代理的连接) */
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const via = (target) => new Promise((resolvePromise, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: target, method: 'GET', headers: { host: new URL(target).host, 'proxy-authorization': 'Basic FAKE' }, agent }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolvePromise({ status: res.statusCode, refused: res.headers['x-egress-refused'] ?? null, body }));
      });
      req.on('error', reject);
      req.end();
    });
    const ok = await via(`${ORIGIN}/page2`);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /第二页/);
    // 同一条连接,换一个内网目标:照样被拒(不是「连接放行过就一直放行」)
    const second = await via(`${INTERNAL}/x`);
    assert.equal(second.status, 403);
    assert.equal(second.refused, 'port');
    assert.doesNotMatch(second.body, new RegExp(SECRET));
    assert.equal((await via('http://169.254.169.254/latest/meta-data/')).refused, 'blocked-address');
    assert.equal((await via('http://10.1.2.3/')).refused, 'blocked-address');
    assert.equal((await via('http://[::1]/')).refused, 'blocked-address');
    assert.equal((await via('http://mixed.test:28390/')).refused, 'port', '一个名字同时指着放行的与内网的:整个拒');
    assert.equal((await via('http://nowhere.test/')).refused, 'unresolved');
    assert.equal((await via(`${ORIGIN}/page2`)).status, 200, '拒过之后放行的照常');
    agent.destroy();
    // 请求行里不是绝对地址、不是 http
    const raw = (text) => new Promise((resolvePromise) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => s.write(text));
      let got = '';
      s.on('data', (c) => { got += c; });
      s.on('close', () => resolvePromise(got));
      s.on('error', () => resolvePromise(got));
      setTimeout(() => s.destroy(), 1500);
    });
    assert.match(await raw('GET /etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.match(await raw('GET file:///etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403/);
    // CONNECT
    assert.match(await raw(`CONNECT 127.0.0.1:${INTERNAL_PORT} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403 Forbidden\r\nx-egress-refused: port/);
    assert.match(await raw('CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n'), /x-egress-refused: blocked-address/);
    assert.match(await raw('CONNECT [fd00:ec2::254]:443 HTTP/1.1\r\n\r\n'), /x-egress-refused: blocked-address/);
    // 带方括号的 IPv6 字面量:代理把括号原样交给出网闸,出网闸去掉括号再判(回环、唯一本地、包着 IPv4 回环的映射地址)
    for (const target of ['[::1]:443', '[fd00::1]:443', '[::ffff:127.0.0.1]:443', '[::ffff:7f00:1]:443', '[fe80::1]:443', '[64:ff9b::7f00:1]:443']) {
      assert.match(await raw(`CONNECT ${target} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403 Forbidden\r\nx-egress-refused: blocked-address/, target);
    }
    assert.ok(proxy.journal().some((e) => !e.ok && e.kind === 'connect' && e.host === '::1' && e.port === 443), '记录里的主机名不带括号');
    assert.match(await raw('CONNECT not a target HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 400/, '不成样子的请求行:拒');
    assert.match(await raw('CONNECT nohost HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403 Forbidden\r\nx-egress-refused: protocol/, '没有端口的 CONNECT:拒');
    // 放行的 CONNECT:隧道通到假站;同时最多两条
    const tunnel = () => new Promise((resolvePromise) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:${SITE_PORT} HTTP/1.1\r\n\r\n`));
      s.once('data', (c) => resolvePromise({ s, head: String(c) }));
      s.on('error', () => {});
    });
    const t1 = await tunnel();
    const t2 = await tunnel();
    assert.match(t1.head, /^HTTP\/1\.1 200/);
    assert.match(t2.head, /^HTTP\/1\.1 200/);
    assert.equal(proxy.stats().tunnels, 2);
    const t3 = await tunnel();
    assert.match(t3.head, /x-egress-refused: busy/, '隧道数到上限');
    t1.s.write(`GET /page2 HTTP/1.1\r\nHost: 127.0.0.1:${SITE_PORT}\r\nConnection: close\r\n\r\n`);
    const through = await new Promise((r) => { let got = ''; t1.s.on('data', (c) => { got += c; }); t1.s.on('close', () => r(got)); });
    assert.match(through, /第二页/);
    t2.s.destroy(); t3.s.destroy();
    await until(() => proxy.stats().tunnels === 0, { what: '隧道数归零' });

    assert.equal(internal.state.connections, before.internal, '「内网里的服务」一次都没被连上');
    const journal = proxy.journal();
    assert.ok(journal.some((e) => e.ok && e.kind === 'http' && e.host === '127.0.0.1' && e.port === SITE_PORT && e.address === '127.0.0.1'));
    assert.ok(journal.some((e) => !e.ok && e.kind === 'connect' && e.host === '169.254.169.254' && e.code === 'blocked-address'));
    // 服务日志里只有原因码与端口,没有主机名
    assert.ok(log.length > 0);
    for (const line of log) assert.deepEqual(Object.keys(line).sort(), ['code', 'event', 'kind', 'port']);
  } finally {
    const closed = await proxy.close();
    assert.deepEqual(closed, { closed: true });
    assert.equal(proxy.stats().open, 0);
    await assert.rejects(new Promise((r, j) => { const s = net.connect(proxy.port, '127.0.0.1'); s.once('connect', r); s.once('error', j); }), '代理的端口放掉了');
  }
});

test('W1-EGRESS-03 起浏览器时交给它的东西:管道、无头、白名单环境变量、参数', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = createEgressGate({ testAllow: ALLOW, resolve });
  const captured = [];
  // 换掉「起浏览器进程」那一步:记下交给它的命令行、选项,然后装作没起来
  const spawnBrowser = (command, args, options) => {
    captured.push({ command, args, options });
    const fake = new EventEmitter();
    fake.pid = undefined;
    fake.stdio = [];
    fake.exitCode = null;
    fake.signalCode = null;
    fake.kill = () => false;
    setImmediate(() => fake.emit('error', new Error('stop here')));
    return fake;
  };
  const saved = { ...process.env };
  process.env.PROMPTCUT_AGENT_SECRET_FOR_TEST = 'FAKE-CREDENTIAL-DO-NOT-USE';
  process.env.HTTP_PROXY = 'http://corp-proxy.invalid:3128';
  process.env.HTTPS_PROXY = 'http://corp-proxy.invalid:3128';
  process.env.AWS_SECRET_ACCESS_KEY = 'FAKE-CREDENTIAL-DO-NOT-USE';
  t.after(() => { for (const k of ['PROMPTCUT_AGENT_SECRET_FOR_TEST', 'HTTP_PROXY', 'HTTPS_PROXY', 'AWS_SECRET_ACCESS_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const chrome = await testChromePath();
  const extraArgs = ['--no-sandbox', '--proxy-server=http://evil.invalid:1', '--remote-debugging-port=9222', '--headless=old', '--user-data-dir=/tmp/evil'];
  await assert.rejects(launchHostedSession({ sessionDir: path.join(dir, 's'), executablePath: chrome, gate, limits: HOSTED_BROWSER_DEFAULTS, extraArgs, spawnBrowser,
    argPrefix: [...HOSTED_BROWSER_ARG_PREFIX, '--proxy-server=http://evil.invalid:2', '--single-process', '--disk-cache-dir=/srv/evil'] }), { code: 'launch-failed' });
  const o = captured[0];
  assert.equal(o.command, chrome);
  assert.deepEqual(o.options.stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], '只有 3、4 号是管道:调试协议走它们');
  assert.equal(o.args.filter((a) => a === '--remote-debugging-pipe').length, 1, '用管道连');
  assert.ok(!o.args.some((a) => /^--remote-debugging-(port|address)/.test(a)), '不开调试端口');
  assert.deepEqual(o.args.filter((a) => /^--headless/.test(a)), [isHeadlessShell(chrome) ? '--headless' : '--headless=new'], '只用无头,而且只有本模块定的那一个');
  assert.deepEqual(o.args.filter((a) => a.startsWith('--user-data-dir=')), [`--user-data-dir=${path.join(dir, 's', 'profile')}`]);
  assert.equal(o.options.cwd, path.join(dir, 's'));
  assert.deepEqual(o.args.slice(0, HOSTED_BROWSER_ARG_PREFIX.length), [...HOSTED_BROWSER_ARG_PREFIX]);
  assert.deepEqual([...HOSTED_BROWSER_ARG_PREFIX], [...TEST_CHROME_ARG_PREFIX], '打头的参数与探针用的是同一个');
  assert.equal(o.args.filter((a) => a.startsWith('--proxy-server=')).length, 1);
  assert.match(o.args.find((a) => a.startsWith('--proxy-server=')), /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(o.args.includes('--no-sandbox'), '部署者追加的合规参数留着');
  assert.ok(!o.args.some((a) => /evil|no-proxy-server|single-process|disk-cache-dir/.test(a)), '改代理、换目录的被丢掉;打头的那几个参数过的是同一道白名单');
  for (const key of Object.keys(o.options.env)) assert.doesNotMatch(key, /^PROMPTCUT_|PROXY|AWS_|SECRET|TOKEN|KEY$/i, `环境变量里不该有 ${key}`);
  assert.equal(o.options.env.HOME, path.join(dir, 's'));
  assert.ok(String(o.options.env.TEMP).startsWith(path.join(dir, 's')));
  // chrome-headless-shell 的文件名:自动用它那种无头
  const shell = path.join(dir, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  fs.writeFileSync(shell, 'not a real browser');
  await assert.rejects(launchHostedSession({ sessionDir: path.join(dir, 's2'), executablePath: shell, gate, limits: HOSTED_BROWSER_DEFAULTS, spawnBrowser }), { code: 'launch-failed' });
  assert.deepEqual(captured[1].args.filter((a) => /^--headless/.test(a)), ['--headless']);
  // 没配、不是文件
  await assert.rejects(launchHostedSession({ sessionDir: path.join(dir, 's3'), executablePath: '', gate, limits: HOSTED_BROWSER_DEFAULTS, spawnBrowser }), { code: 'browser-missing' });
  await assert.rejects(launchHostedSession({ sessionDir: path.join(dir, 's3'), executablePath: dir, gate, limits: HOSTED_BROWSER_DEFAULTS, spawnBrowser }), { code: 'browser-missing' });
  assert.equal(captured.length, 2);
});

test('W1-EGRESS-04 工具入口:内网、metadata、IPv6、非 http(s) 协议当场拒,浏览器都没碰', async (t) => {
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const connectionsBefore = internal.state.connections;
  const cases = [
    [`${INTERNAL}/`, 'port'], [`http://localhost:${INTERNAL_PORT}/`, 'port'], [`http://[::1]:${INTERNAL_PORT}/`, 'port'],
    ['http://127.0.0.1/', 'blocked-address'], ['http://localhost/', 'blocked-address'], ['http://[::1]/', 'blocked-address'], ['http://0.0.0.0/', 'blocked-address'],
    ['http://2130706433/', 'blocked-address'], ['http://0x7f.0.0.1/', 'blocked-address'], ['http://127.1/', 'blocked-address'],
    ['http://10.0.0.1/', 'blocked-address'], ['http://172.16.5.5/', 'blocked-address'], ['http://192.168.0.1/', 'blocked-address'], ['http://100.64.0.1/', 'blocked-address'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked-address'], ['http://[fd00:ec2::254]/', 'blocked-address'], ['http://[::ffff:169.254.169.254]/', 'blocked-address'],
    ['http://[fe80::1]/', 'blocked-address'], ['http://[fc00::1]/', 'blocked-address'], ['http://[64:ff9b::a9fe:a9fe]/', 'blocked-address'], ['http://[2002:a9fe:a9fe::1]/', 'blocked-address'],
    ['http://metadata.google.internal/', 'blocked-address'], ['http://intranet.corp/', 'blocked-address'], [`http://mixed.test:${SITE_PORT}/`, 'port'],
    ['http://nowhere.test/', 'unresolved'], ['https://example.com:22/', 'unresolved'], [`http://user:pw@127.0.0.1:${SITE_PORT}/`, 'credentials'],
    [`http://site.test:${SITE_PORT + 5}/`, 'port'],
  ];
  for (const [url, code] of cases) {
    const result = await f.tools.call('web_open', { url }, context);
    assert.equal(result.ok, false, url);
    assert.equal(result.egress, code, `${url} → ${result.egress}`);
    assert.match(result.error, /^没有打开/);
  }
  const tmp = path.join(f.dataDir, 'w1-local-file.txt');
  fs.mkdirSync(f.dataDir, { recursive: true });
  fs.writeFileSync(tmp, 'LOCAL-FILE-MARKER');
  for (const url of [pathToFileURL(tmp).href, 'file:///etc/passwd', 'chrome://version', 'view-source:http://site.test/', 'data:text/html,<h1>x</h1>', 'javascript:alert(1)',
    'about:blank', 'ftp://site.test/', 'ws://site.test/', 'blob:http://site.test/x', 'chrome-extension://x/y.html', '//site.test/x']) {
    const result = await f.tools.call('web_open', { url }, context);
    assert.equal(result.ok, false, url);
    assert.equal(result.refused, 'protocol', url);
    assert.match(result.error, /http \/ https/, url);
  }
  // 这些全被拒在浏览器之外:浏览器起了(第一次调用就起),但它的代理一条记录都没有,站点与内网服务一个请求都没收到
  assert.deepEqual(f.tools.egressJournal(scope), []);
  assert.equal(internal.state.connections, connectionsBefore);
  assert.ok(f.egressLog.filter((e) => e.event === 'agent.egress.refused').length >= cases.length, '出网闸的日志里有每一次拒绝');
  // 放行的那个照常
  const ok = await f.tools.call('web_open', { url: `http://site.test:${SITE_PORT}/page2` }, context);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.title, 'W1 第二页');
  const journal = f.tools.egressJournal(scope);
  assert.ok(journal.some((e) => e.ok && e.host === 'site.test' && e.port === SITE_PORT && e.address === '127.0.0.1'), '正常出网走的是代理:记录里有这次连接,连的是核过的地址');
});

/** 第 5 条的主体:也给 chrome-headless-shell 那一条用 */
async function leakRound(f, context) {
  const before = { internal: internal.state.connections, requests: internal.state.requests.length };
  const opened = await f.tools.call('web_open', { url: leakUrl() }, context);
  assert.equal(opened.ok, true, opened.error);
  const text = await untilText(f, context, 'LEAK-DONE');
  const journal = f.tools.egressJournal(scope);
  assert.equal(internal.state.connections, before.internal, '「内网里的服务」一次都没被连上');
  assert.equal(internal.state.requests.length, before.requests);
  assert.doesNotMatch(text, new RegExp(SECRET), '页面上没有内网的字');
  for (const target of LEAK_TARGETS) {
    const refused = refusedFor(journal, target.host);
    assert.ok(refused.length >= 1, `${target.what}:请求到了代理并被拒(${target.url});记录:${JSON.stringify(journal.filter((e) => e.host === target.host))}`);
    // 明文的各种取法(fetch、XHR、图片、iframe、信标、预取)与 WebSocket 的隧道,都在记录里
    assert.ok(refused.some((e) => e.kind === 'http'), `${target.what}:明文请求经过了代理`);
    assert.ok(refused.some((e) => e.kind === 'connect'), `${target.what}:WebSocket 经过了代理`);
    assert.ok(!journal.some((e) => e.ok && e.host === target.host && e.port !== SITE_PORT), `${target.what}:没有一条被放行`);
    const line = text.split('\n').find((l) => l.startsWith(`${target.url} `));
    assert.ok(line, `${target.what}:页面跑完了这一项`);
    const result = JSON.parse(line.slice(target.url.length + 1));
    assert.notEqual(result.ws, 'open', `${target.what}:WebSocket 没连上`);
    assert.doesNotMatch(result.xhr, /^load\[.+\]/, `${target.what}:XHR 没读到内容`);
    assert.notEqual(result.img, 'load');
  }
  // 放行的只有假站自己
  assert.deepEqual([...new Set(journal.filter((e) => e.ok).map((e) => `${e.host}:${e.port}`))], [`127.0.0.1:${SITE_PORT}`]);
  return { journal, text };
}

test('W1-EGRESS-05 页面里发起的请求:回环、内网、metadata、IPv6 都到了代理并被拒', async (t) => {
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const { journal } = await leakRound(f, context);
  if (process.env.W1_VERBOSE) console.log('[w1] 页面试着连内网的代理记录(去重):', JSON.stringify([...new Set(journal.map((e) => `${e.kind} ${e.host}:${e.port} ${e.ok ? 'ok' : e.code}`))]));
});

test('W1-EGRESS-06 对照:去掉「回环与链路本地也走代理」的参数,页面就直连到了内网服务', async (t) => {
  // 这条不经过产品代码:直接用 puppeteer 起一个**少了那个参数**的浏览器,证明第 5 条断言的东西真的会漏
  const puppeteer = (await import('puppeteer')).default;
  const gate = createEgressGate({ testAllow: ALLOW, resolve });
  const proxy = await startBrowserProxy({ gate });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-control-'));
  const args = [...TEST_CHROME_ARG_PREFIX, ...hostedNetworkArgs(proxy.url).filter((a) => !a.startsWith('--proxy-bypass-list=')), ...TEST_EXTRA_ARGS];
  const browser = await puppeteer.launch({ ...rawLaunchOptions(await testChromePath()), userDataDir: dir, args });
  t.after(async () => {
    const pid = browser.process()?.pid;
    await browser.close().catch(() => {});
    await proxy.close();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { what: '对照浏览器退出' });
    for (let i = 0; i < 20 && fs.existsSync(dir); i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await sleep(200); } }
  });
  const before = internal.state.connections;
  const page = (await browser.pages())[0];
  await page.goto(`${ORIGIN}/blank`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const direct = await page.goto(`${INTERNAL}/control`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  assert.equal(direct.status(), 200);
  assert.match(await page.evaluate(() => document.body.innerText), new RegExp(SECRET), '少了那个参数:内网的字直接到了页面上');
  assert.ok(internal.state.connections > before, '内网服务被直连了');
  assert.ok(!proxy.journal().some((e) => e.host === '127.0.0.1' && e.port === INTERNAL_PORT), '而且根本没经过代理');
});

test('W1-EGRESS-07 跳转到内网、跳到 file::都没到', async (t) => {
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const before = internal.state.connections;
  for (const [url, what] of [
    [`${ORIGIN}/redir-internal`, '302 到回环'],
    [`${ORIGIN}/redir?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`, '302 到 metadata'],
    [`${ORIGIN}/redir?to=${encodeURIComponent(`http://[::1]:${INTERNAL_PORT}/`)}`, '302 到 IPv6 回环'],
    [`${ORIGIN}/redir?to=${encodeURIComponent('http://10.0.0.1/')}`, '302 到内网'],
    [`${ORIGIN}/redir?to=${encodeURIComponent('http://intranet.corp/')}`, '302 到解析成内网的名字'],
    [`${ORIGIN}/redir?to=${encodeURIComponent(`${ORIGIN}/redir-internal`)}`, '两跳之后到回环'],
  ]) {
    const result = await f.tools.call('web_open', { url }, context);
    assert.equal(result.ok, false, what);
    assert.ok(['port', 'blocked-address'].includes(result.egress), `${what}:${JSON.stringify(result).slice(0, 200)}`);
    assert.match(result.error, /跳转到的地址|被拒绝/, what);
  }
  // 跳到 file::浏览器自己就不跟(不安全的跳转);反正读不到
  const toFile = await f.tools.call('web_open', { url: `${ORIGIN}/redir?to=${encodeURIComponent('file:///etc/passwd')}` }, context);
  assert.equal(toFile.ok, false);
  // 页面加载完以后自己跳(meta refresh):第一跳是放行的,跳过去的那一下被代理拒
  const meta = await f.tools.call('web_open', { url: `${ORIGIN}/meta-refresh` }, context);
  await sleep(1500);
  const after = await f.tools.call('web_view', {}, context);
  assert.doesNotMatch(await readText(f, context), new RegExp(SECRET));
  // 那一跳发生在 web_open 里或它之后:哪一次的结果里说了「被出网限制拒绝」都算,但必须说过
  const said = [meta, after].some((r) => r.egress || (r.blocked ?? []).some((b) => b.kind === 'egress'));
  assert.ok(said, `页面自己跳去内网被拒这件事告诉了模型:${JSON.stringify([meta, after].map((r) => ({ ok: r.ok, egress: r.egress, blocked: r.blocked })))}`);
  assert.equal(internal.state.connections, before, '「内网里的服务」零连接');
  const journal = f.tools.egressJournal(scope);
  assert.ok(refusedFor(journal, '127.0.0.1').some((e) => e.port === INTERNAL_PORT), '跳转的那一跳到了代理并被拒');
  assert.ok(refusedFor(journal, '169.254.169.254').length >= 1);
  assert.ok(refusedFor(journal, '10.0.0.1').length >= 1);
  assert.ok(refusedFor(journal, 'intranet.corp').length >= 1);
});

test('W1-EGRESS-08 DNS 重绑定:页面开着的时候把名字改指内网,之后的请求被拒', async (t) => {
  dns.rebind = false;
  t.after(() => { dns.rebind = false; });
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const before = { rebound: rebound.state.connections, site: site.count('/whoami') };

  // 第一次解析:放行的地址。页面开在 http://rebind.test:28390 这个源上
  let view = await f.tools.call('web_open', { url: `http://rebind.test:${SITE_PORT}/rebind` }, context);
  assert.equal(view.ok, true, view.error);
  view = await f.tools.call('web_click', { u: item(view, '再取一次').u }, context);
  assert.match(await untilText(f, context, '取到(200)'), /W1 我是谁/, '重绑定之前:同源的请求到的是真站');
  assert.equal(site.count('/whoami'), before.site + 1);

  // 攻击者把名字改指「内网」(同端口的另一个地址)。页面还是那个源,再取一次
  dns.rebind = true;
  view = await f.tools.call('web_view', {}, context);
  view = await f.tools.call('web_click', { u: item(view, '再取一次').u }, context);
  const text = await untilText(f, context, '取到(403)');
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.equal(rebound.state.connections, before.rebound, '重绑定后的地址零连接');
  assert.equal(site.count('/whoami'), before.site + 1, '也没有悄悄连回原来的地址');
  const journal = f.tools.egressJournal(scope);
  const forName = journal.filter((e) => e.host === 'rebind.test');
  assert.ok(forName.some((e) => e.ok && e.address === '127.0.0.1'), '第一次:连的是核过的 127.0.0.1');
  assert.ok(forName.some((e) => !e.ok), '重绑定之后:被拒');
  assert.ok(!forName.some((e) => e.address === '127.0.0.2'), '从没连过重绑定后的地址');
  assert.ok(dns.calls.filter((h) => h === 'rebind.test').length >= 3, '每个请求都重新解析、重新核对(浏览器自己不解析)');

  // 重新打开这个名字:入口就拒
  const reopened = await f.tools.call('web_open', { url: `http://rebind.test:${SITE_PORT}/rebind` }, context);
  assert.equal(reopened.ok, false);
  assert.equal(rebound.state.connections, before.rebound);
  // 一个名字同时指着放行的与内网的:整个拒,不赌它这次连哪个
  assert.equal((await f.tools.call('web_open', { url: `http://mixed.test:${SITE_PORT}/` }, context)).ok, false);
});

/** 第 9 条的主体:回 `{ candidates, packets }` */
async function webrtcRound(f, context) {
  const packetsBefore = stunPackets;
  const opened = await f.tools.call('web_open', { url: `${ORIGIN}/webrtc?stun=127.0.0.1:${STUN_PORT}` }, context);
  assert.equal(opened.ok, true, opened.error);
  const text = await untilText(f, context, 'RTC-DONE');
  const candidates = JSON.parse(/RTC-DONE (\[.*\])/.exec(text)[1]);
  return { candidates, packets: stunPackets - packetsBefore };
}
const localAddresses = () => Object.values(os.networkInterfaces()).flat().map((i) => i?.address?.split('%')[0]).filter(Boolean);
function assertNoRtcLeak({ candidates, packets }) {
  assert.equal(packets, 0, '假 STUN 一个 UDP 包都没收到(不走代理的 UDP 一律不发)');
  const locals = localAddresses();
  for (const c of candidates) {
    for (const ip of locals) assert.ok(!c.includes(` ${ip} `), `候选里不该有本机地址 ${ip}:${c}`);
    assert.doesNotMatch(c, / typ (srflx|relay) /, `不该有经 STUN 拿到的候选:${c}`);
    assert.doesNotMatch(c, / (\d{1,3}\.){3}\d{1,3} \d+ typ host/, `不该有带明文 IPv4 的本机候选:${c}`);
  }
}

test('W1-EGRESS-09 WebRTC:不泄露本机地址,不发不走代理的 UDP;对照能收到', async (t) => {
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const result = await webrtcRound(f, context);
  assertNoRtcLeak(result);

  // 走 TCP 的 TURN 中继:浏览器要和「中继服务器」建 TCP 连接。指向本机的一个假服务(没有放行),它一次都不该被连上
  let turnConnections = 0;
  const turn = net.createServer((socket) => { turnConnections += 1; socket.destroy(); });
  await new Promise((r) => turn.listen(TURN_PORT, '127.0.0.1', r));
  t.after(() => new Promise((r) => turn.close(r)));
  for (const relay of ['', '&relay=1']) {
    const opened = await f.tools.call('web_open', { url: `${ORIGIN}/webrtc?stun=127.0.0.1:${STUN_PORT}&turn=127.0.0.1:${TURN_PORT}${relay}` }, context);
    assert.equal(opened.ok, true, opened.error);
    const text = await untilText(f, context, 'RTC-DONE');
    assertNoRtcLeak({ candidates: JSON.parse(/RTC-DONE (\[.*\])/.exec(text)[1]), packets: 0 });
  }
  await sleep(500);
  assert.equal(turnConnections, 0, '假 TURN 服务零连接');
  const turnTries = f.tools.egressJournal(scope).filter((e) => e.port === TURN_PORT);
  assert.ok(turnTries.every((e) => !e.ok), '要是去连了,也只到了代理并被拒');
  if (process.env.W1_VERBOSE) console.log(`[w1] TURN/TCP:假服务被连 ${turnConnections} 次;代理记录里指向它的 ${turnTries.length} 条(都被拒)`);

  // 对照:去掉两条 WebRTC 策略参数,同一个页面就向假 STUN 发了 UDP
  const puppeteer = (await import('puppeteer')).default;
  const gate = createEgressGate({ testAllow: ALLOW, resolve });
  const proxy = await startBrowserProxy({ gate });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-rtc-'));
  const args = [...TEST_CHROME_ARG_PREFIX, ...hostedNetworkArgs(proxy.url).filter((a) => !/webrtc-ip-handling-policy/.test(a)), ...TEST_EXTRA_ARGS];
  const browser = await puppeteer.launch({ ...rawLaunchOptions(await testChromePath()), userDataDir: dir, args });
  t.after(async () => {
    const pid = browser.process()?.pid;
    await browser.close().catch(() => {});
    await proxy.close();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { what: '对照浏览器退出' });
    for (let i = 0; i < 20 && fs.existsSync(dir); i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await sleep(200); } }
  });
  const before = stunPackets;
  const page = (await browser.pages())[0];
  await page.goto(`${ORIGIN}/webrtc?stun=127.0.0.1:${STUN_PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('out').textContent.startsWith('RTC-DONE'), { timeout: 20_000 });
  const controlCandidates = JSON.parse(/RTC-DONE (\[.*\])/.exec(await page.evaluate(() => document.getElementById('out').textContent))[1]);
  assert.ok(stunPackets > before || controlCandidates.length > 0, `对照:少了策略参数就有 UDP 出去或收集到候选(UDP ${stunPackets - before} 个,候选 ${controlCandidates.length} 个)`);
  if (process.env.W1_VERBOSE) console.log(`[w1] WebRTC:受控 UDP ${result.packets} 个、候选 ${result.candidates.length} 个;对照 UDP ${stunPackets - before} 个、候选 ${controlCandidates.length} 个`);
});

test('W1-EGRESS-10 WebSocket 走的也是代理', async (t) => {
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const upgradesBefore = site.count('<upgrade>');
  assert.equal((await f.tools.call('web_open', { url: `${ORIGIN}/ws` }, context)).ok, true);
  await until(() => site.count('<upgrade>') > upgradesBefore, { what: '假站收到 WebSocket 握手' });
  const journal = f.tools.egressJournal(scope);
  assert.ok(journal.some((e) => e.ok && e.kind === 'connect' && e.host === '127.0.0.1' && e.port === SITE_PORT), '代理记录里有这条隧道:握手是经代理到的');
});

test('W1-EGRESS-11 页面里的 file: 链接与 iframe 读不到本机文件', async (t) => {
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const local = path.join(f.dataDir, 'w1-local-file.txt');
  fs.mkdirSync(f.dataDir, { recursive: true });
  fs.writeFileSync(local, 'LOCAL-FILE-MARKER-9f3a');
  const fileUrl = pathToFileURL(local).href;
  let view = await f.tools.call('web_open', { url: `${ORIGIN}/file-link?to=${encodeURIComponent(fileUrl)}` }, context);
  assert.equal(view.ok, true, view.error);
  const clicked = await f.tools.call('web_click', { u: item(view, '本机文件').u }, context);
  // 点了以后:要么还在原页(浏览器不许网页跳到 file:),要么被请求拦截掐掉;无论哪种,地址不是 file:,读不到文件里的字
  view = await f.tools.call('web_view', {}, context);
  if (view.ok) assert.doesNotMatch(String(view.url), /^file:/i);
  const text = await readText(f, context);
  assert.doesNotMatch(String(text), /LOCAL-FILE-MARKER/);
  assert.doesNotMatch(JSON.stringify({ ...clicked, __image: undefined }), /LOCAL-FILE-MARKER/);
});

test('W1-EGRESS-12 节点上装的那种浏览器(chrome-headless-shell):出网限制同样成立', async (t) => {
  const shell = await testHeadlessShellPath();
  if (!shell) return t.skip('本机没有 chrome-headless-shell(puppeteer 缓存里没有同版本的);节点上的验证步骤见报告');
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve, runtime: { executablePath: shell } });
  const { context } = await f.newRun();
  await leakRound(f, context);
  assert.equal(f.tools.describe().sessions[0].mode, 'shell');
  if (process.env.W1_VERBOSE) console.log('[w1] chrome-headless-shell:', path.basename(path.dirname(path.dirname(shell))), path.basename(shell));
  // 七个工具在它身上也走得通(看、点、输入、读)
  let view = await f.tools.call('web_open', { url: `${ORIGIN}/` }, context);
  assert.equal(view.ok, true, view.error);
  assert.deepEqual(view.image, { width: 800, height: 500 });
  view = await f.tools.call('web_click', { u: item(view, '打招呼').u }, context);
  view = await f.tools.call('web_type', { u: item(view, '回显框').u, text: 'shell' }, context);
  assert.match(await readText(f, context), /点到了:你好[\s\S]*你输入了:shell/);
  // 跳转到内网、WebRTC
  const before = internal.state.connections;
  assert.equal((await f.tools.call('web_open', { url: `${ORIGIN}/redir-internal` }, context)).ok, false);
  assert.equal(internal.state.connections, before);
  assertNoRtcLeak(await webrtcRound(f, context));
  // 关:进程号查不到
  const pids = f.tools.describe().sessions[0].pids;
  await f.tools.call('web_close', {}, context);
  assert.deepEqual(pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }), []);
});

test('W1-EGRESS-13 下载的对照:不设「拒下载」时文件真的会落盘;云端的浏览器里落不了', async (t) => {
  // 对照(不经产品代码):同一个假站、同一个代理,把下载行为设成「允许」——文件落到指定目录。证明 W1-TOOL-04 断言的「哪儿都没有这个文件」不是空过
  const puppeteer = (await import('puppeteer')).default;
  const gate = createEgressGate({ testAllow: ALLOW, resolve });
  const proxy = await startBrowserProxy({ gate });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-dlctl-'));
  const downloads = path.join(dir, 'downloads');
  fs.mkdirSync(downloads);
  const args = [...TEST_CHROME_ARG_PREFIX, ...hostedNetworkArgs(proxy.url), ...TEST_EXTRA_ARGS];
  const browser = await puppeteer.launch({ ...rawLaunchOptions(await testChromePath()), userDataDir: path.join(dir, 'profile'), args });
  t.after(async () => {
    const pid = browser.process()?.pid;
    await browser.close().catch(() => {});
    await proxy.close();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { ms: 60_000, what: '对照浏览器退出' });
    for (let i = 0; i < 20 && fs.existsSync(dir); i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await sleep(200); } }
  });
  const name = `w1-control-${process.pid}.bin`;
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const page = (await browser.pages())[0];
  await page.goto(`${ORIGIN}/dl?name=${name}`).catch(() => {});
  await until(() => fs.existsSync(path.join(downloads, name)), { ms: 30_000, what: '对照:文件落盘' });
  assert.equal(fs.statSync(path.join(downloads, name)).size, 2048);

  // 云端的浏览器:同一个地址,被拒,会话目录里没有这个文件
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  await f.tools.call('web_open', { url: `${ORIGIN}/page2` }, context);
  const refused = await f.tools.call('web_open', { url: `${ORIGIN}/dl?name=${name}` }, context);
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, 'download');
  await sleep(800);
  const found = [];
  const walk = (d) => { let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of list) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes('w1-control-')) found.push(p); } };
  walk(f.dataDir);
  assert.deepEqual(found, []);
});

test('W1-EGRESS-14 弹出页抢在被关之前发的请求,也只能到代理', async (t) => {
  const f = await w1Fixture(t, { testAllow: ALLOW, resolve });
  const { context } = await f.newRun();
  const before = internal.state.connections;
  // 这一页用「程序里直接提交一个 target=_blank 的表单」开新标签页(不触发提交事件,并回当前页的那道拦不住它),新页直奔内网
  const opened = await f.tools.call('web_open', { url: `${ORIGIN}/popup-leak?to=${encodeURIComponent(`${INTERNAL}/from-popup`)}` }, context);
  assert.equal(opened.ok, true, opened.error);
  await until(() => refusedFor(f.tools.egressJournal(scope), '127.0.0.1').some((e) => e.port === INTERNAL_PORT), { ms: 30_000, what: '弹出页的请求到了代理并被拒' });
  const view = await f.tools.call('web_view', {}, context);
  assert.equal(internal.state.connections, before, '「内网里的服务」零连接:弹出页用的是同一个浏览器、同一个代理');
  assert.ok([...(opened.blocked ?? []), ...(view.blocked ?? [])].some((b) => b.kind === 'popup'), '多出来的那一页被关掉了,并且告诉了模型');
  assert.equal(view.title, 'W1 弹出页', '当前页还是原来那一页');
});
