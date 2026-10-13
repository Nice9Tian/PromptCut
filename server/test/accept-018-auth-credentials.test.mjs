/**
 * 0.7.18 验收补证据（组名 auth）：账号任务书「逐项验收」两行的公网路径证据。
 *   2.1-13 内部核对口与凭证：未授权调用均拒绝且不能只靠回环地址；日志与设备上的文件里没有密码、令牌、会话值；恢复凭证可撤销。
 *   2.1-1  云端登录与限次数：错误名称与错误密码同文案；网站与编辑器共用限次数（走真实的公网入口，不是单元）。
 *
 * 搭法：account-dual-user-path 那套真实组合（账号后端源码、文档服务、独立素材进程、公网入口），不改它；
 * 在它外面再打一遍请求，并在运行期间截获本进程与子进程的全部输出，结束后把整个数据目录和输出里找一遍这些秘密值。
 * 跑法：npm test -- server/test/accept-018-auth-credentials.test.mjs（先设好两个环境变量，值见 docs/local.md）。
 * 手动跑可设 ACCEPT018_AUTH_PORT_BASE=28570。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { acceptPorts, httpsJson, SKIP_WITHOUT_PROVIDER } from './fixtures/accept-018-auth-kit.mjs';

const mtls = (port, route, { method = 'POST', body, files, ca, headers = {} } = {}) => new Promise(resolve => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const options = { host: '127.0.0.1', port, path: route, method, ca, agent: false, timeout: 5000, rejectUnauthorized: true,
    headers: { ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...headers } };
  if (files) { options.key = fs.readFileSync(files.key); options.cert = fs.readFileSync(files.cert); }
  const req = https.request(options, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.once('end', () => { let parsed = null; try { parsed = JSON.parse(Buffer.concat(chunks)); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, body: parsed }); });
  });
  req.once('error', error => resolve({ failed: true, code: error.code ?? error.message }));
  req.once('timeout', () => req.destroy(Error('mtls-timeout')));
  req.end(text);
});
const plain = (port, route, { method = 'POST', body } = {}) => new Promise(resolve => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 5000,
    headers: text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {} }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.once('end', () => { let parsed = null; try { parsed = JSON.parse(Buffer.concat(chunks)); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, body: parsed }); });
  });
  req.once('error', error => resolve({ failed: true, code: error.code ?? error.message }));
  req.end(text);
});
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const scan = (dir, needles) => {
  const hits = [];
  for (const file of walk(dir)) {
    let bytes; try { bytes = fs.readFileSync(file); } catch { continue; }
    for (const [label, value] of Object.entries(needles)) if (bytes.includes(Buffer.from(value))) hits.push(`${label}@${path.relative(dir, file)}`);
  }
  return hits;
};

test('公网路径：内部口拒绝未授权调用（含回环）、日志与数据目录里没有秘密值、恢复凭证可撤销；错误名称与错误密码同文案、网站与编辑器共用限次数',
  { skip: SKIP_WITHOUT_PROVIDER, timeout: 120_000 }, async t => {
  const captured = [], sources = { child: 0, proc: 0 };
  const realSpawn = childProcess.spawn, realOut = process.stdout.write.bind(process.stdout), realErr = process.stderr.write.bind(process.stderr);
  childProcess.spawn = (...args) => {
    const child = realSpawn(...args);
    child.stdout?.on('data', data => { captured.push(String(data)); sources.child += String(data).length; }); child.stderr?.on('data', data => { captured.push(String(data)); sources.child += String(data).length; });
    return child;
  };
  syncBuiltinESMExports();
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); sources.proc += String(chunk).length; return realOut(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); sources.proc += String(chunk).length; return realErr(chunk, ...rest); };
  const restore = () => { childProcess.spawn = realSpawn; syncBuiltinESMExports(); process.stdout.write = realOut; process.stderr.write = realErr; };
  let fx;
  try {
    const { startAccountDualUserFixture } = await import('./fixtures/account-dual-user-path.mjs');
    fx = await startAccountDualUserFixture({ ports: await acceptPorts(7) });
    const ca = fs.readFileSync(fx.caFile);
    const edge = (route, opts) => httpsJson(fx.origin, ca, route, opts);
    const dir = fx.fixtureDir;
    const secrets = {};

    // —— 登录：桌面（编辑器）与网站各一次，另有一次错误密码 ——
    const user = fx.accounts[0];
    const editorLogin = await edge('/api/account/editor/login', { method: 'POST', body: { name: user.name, password: user.password, deviceId: 'accept-device', deviceName: 'Accept PC', requestId: 'accept-login-1' } });
    assert.equal(editorLogin.status, 200, JSON.stringify(editorLogin.body));
    secrets.accessToken = editorLogin.body.accessToken; secrets.recoveryToken = editorLogin.body.recoveryToken;
    assert.ok(secrets.accessToken && secrets.recoveryToken);
    secrets.password = user.password;
    let cookie = '', csrf = '';
    const site = async (route, body) => {
      const result = await edge('/api/account' + route, { method: body ? 'POST' : 'GET', body, headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: fx.origin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
      if (result.cookie) cookie = result.cookie; if (result.body?.csrfToken) csrf = result.body.csrfToken; return result;
    };
    await site('/me');
    const websiteLogin = await site('/login', { name: user.name, password: user.password, remember: true });
    assert.equal(websiteLogin.status, 200);
    secrets.sessionCookie = cookie.split('=')[1];
    const wrongPassword = 'ACCEPT-WRONG-PASSWORD-9d41';
    secrets.wrongPassword = wrongPassword;
    const wrongTry = await edge('/api/account/editor/login', { method: 'POST', body: { name: user.name, password: wrongPassword, deviceId: 'accept-device', requestId: 'accept-wrong-1' } });
    assert.equal(wrongTry.status, 401);
    // 用拿到的令牌真的走一遍文档服务（令牌会经过文档服务的核对口）
    const session = await edge('/hosted/shared/account/session', { method: 'POST', body: { projectId: fx.projectId, deviceId: 'accept-device', requestId: 'accept-doc-session' }, headers: { authorization: `Bearer ${secrets.accessToken}` } });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    secrets.connectionTicket = session.body.connectionTicket;

    await t.test('2.1-13 内部口：没有证书、证书不对、身份没登记都被拒，从回环地址来、带上回环的转发头也一样；公网和账号公共端口根本没有这条路', async () => {
      const verify = '/internal/v2/credentials/verify';
      const body = { accessToken: secrets.accessToken, audience: 'doc', requestId: 'accept-verify-1' };
      const files = name => ({ key: path.join(dir, `${name}.key`), cert: path.join(dir, `${name}.crt`) });
      // 对照：登记过的文档服务身份能核对（证明路和令牌本身是好的）
      const good = await mtls(fx.ports.accountInternal, verify, { body, files: files('doc'), ca });
      assert.equal(good.status, 200); assert.equal(good.body.principal.accountId, websiteLogin.body.account.id);
      // 以下都是从 127.0.0.1 发出的（回环），仍然被拒
      assert.equal((await mtls(fx.ports.accountInternal, verify, { body, ca })).failed, true, '不带客户端证书');
      assert.equal((await mtls(fx.ports.accountInternal, verify, { body, ca, headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } })).failed, true, '不带证书，自报回环');
      const wrong = await mtls(fx.ports.accountInternal, verify, { body, files: files('wrong'), ca });
      assert.ok(wrong.failed || wrong.status === 403, `同一个根签发但没登记的身份：${JSON.stringify(wrong)}`);
      assert.ok(!JSON.stringify(wrong.body ?? {}).includes('principal'));
      const asset = await mtls(fx.ports.accountInternal, verify, { body, files: files('asset'), ca });
      assert.ok(asset.failed || asset.status === 403, '别的服务的身份不能调账号的核对口');
      assert.equal((await plain(fx.ports.accountInternal, verify, { body })).failed, true, '明文 HTTP 连内部口');
      // 文档服务与素材服务各自的内部口同样要证书
      for (const port of [fx.ports.docInternal, fx.ports.assetInternal])
        assert.equal((await mtls(port, '/internal/v2/projects?accountId=acc_0123456789abcdef01234567', { method: 'GET', ca })).failed, true, `端口 ${port} 不带证书`);
      // 公网入口和账号服务的公共端口上没有这条路由
      for (const route of [verify, '/api/account' + verify, '/hosted' + verify, '/media' + verify]) {
        const viaEdge = await edge(route, { method: 'POST', body });
        assert.ok(viaEdge.status === 404 || viaEdge.status === 400 || viaEdge.status === 403, `公网 ${route}：${viaEdge.status}`);
        assert.ok(!viaEdge.body?.principal, '公网没有核对结果');
      }
      // 文档服务、素材服务的内部路由名在公网入口（/hosted、/media）下同样不通
      for (const route of ['/internal/v2/projects?accountId=acc_0123456789abcdef01234567', '/internal/v2/access/events?after=0', '/internal/v2/access/check',
        '/internal/v2/runs/pending', '/internal/v2/runs/admit', '/internal/v2/conversations/send', '/internal/v2/instances/challenge', '/internal/v2/status']) {
        for (const prefix of ['/hosted', '/media']) for (const method of ['GET', 'POST']) {
          const answer = await edge(prefix + route, { method, body: method === 'POST' ? { projectId: fx.projectId } : undefined });
          assert.ok(answer.status >= 400 && answer.status !== 500, `${method} ${prefix}${route} -> ${answer.status}`);
          assert.ok(!answer.body?.owned && !answer.body?.principal && !answer.body?.allowed, `${prefix}${route} 没有返回内部数据`);
        }
      }
      const siteDirect = await plain(fx.ports.site, verify, { body });
      assert.equal(siteDirect.status, 404, '账号公共端口直接打');
    });

    await t.test('2.1-13 恢复凭证可撤销：轮换一次旧的立刻作废；退出登录之后最新的恢复凭证和访问令牌都被拒', async () => {
      const verifyWith = token => mtls(fx.ports.accountInternal, '/internal/v2/credentials/verify', { body: { accessToken: token, audience: 'doc', requestId: 'accept-verify-' + Math.random().toString(36).slice(2, 8) }, files: { key: path.join(dir, 'doc.key'), cert: path.join(dir, 'doc.crt') }, ca });
      const recover = (token, requestId) => edge('/api/account/editor/recover', { method: 'POST', body: { recoveryToken: token, deviceId: 'accept-device', requestId } });
      const rotated = await recover(secrets.recoveryToken, 'accept-rotate-1');
      assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
      assert.notEqual(rotated.body.recoveryToken, secrets.recoveryToken);
      secrets.recoveryToken2 = rotated.body.recoveryToken; secrets.accessToken2 = rotated.body.accessToken;
      const reused = await recover(secrets.recoveryToken, 'accept-rotate-2');
      assert.ok([401, 409].includes(reused.status) && reused.body.code === 'token-reused', `旧的恢复凭证已作废：${JSON.stringify(reused.body)}`);
      assert.equal((await verifyWith(secrets.accessToken2)).status, 200, '新的访问令牌有效');
      const out = await edge('/api/account/editor/logout', { method: 'POST', body: {}, headers: { authorization: `Bearer ${secrets.accessToken2}` } });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const afterRecover = await recover(secrets.recoveryToken2, 'accept-rotate-3');
      assert.equal(afterRecover.status, 401); assert.equal(afterRecover.body.code, 'credential-revoked');
      const afterVerify = await verifyWith(secrets.accessToken2);
      assert.equal(afterVerify.status, 401); assert.equal(afterVerify.body.code, 'credential-revoked');
      const docAfter = await edge('/hosted/shared/account/session', { method: 'POST', body: { projectId: fx.projectId, deviceId: 'accept-device', requestId: 'accept-doc-session-2' }, headers: { authorization: `Bearer ${secrets.accessToken2}` } });
      assert.equal(docAfter.status, 401, '撤销后文档服务也不认');
    });

    await t.test('2.1-1 错误的名称与错误的密码同一个回答；网站与编辑器共用限次数（走公网入口）', async () => {
      // 名称不存在 vs 名称对密码错：状态、代码、文案逐字相同
      const unknown = await edge('/api/account/editor/login', { method: 'POST', body: { name: 'accNoSuchUser', password: wrongPassword, deviceId: 'accept-device', requestId: 'accept-unknown-1' } });
      const wrong = await edge('/api/account/editor/login', { method: 'POST', body: { name: user.name, password: wrongPassword, deviceId: 'accept-device', requestId: 'accept-wrong-2' } });
      assert.equal(unknown.status, 401);
      assert.deepEqual(unknown.body, wrong.body, '同一个回答，说不出是名称错还是密码错');
      const webUnknown = await site('/login', { name: 'accNoSuchUser', password: wrongPassword });
      const webWrong = await site('/login', { name: user.name, password: wrongPassword });
      assert.equal(webUnknown.status, 401); assert.deepEqual(webUnknown.body, webWrong.body);
      assert.equal(webUnknown.body.code, unknown.body.code, '网站与编辑器是同一句话');
      assert.equal(webUnknown.body.message, unknown.body.message);
      // 限次数：同一个名称，网站 5 次 + 编辑器 5 次（上面已经各错了 2~3 次，补到合计 10 次），第 11 次不论对错都被限
      const limitName = fx.accounts[1].name;
      for (let i = 0; i < 5; i++) assert.equal((await site('/login', { name: limitName, password: wrongPassword + i })).status, 401);
      for (let i = 0; i < 5; i++) assert.equal((await edge('/api/account/editor/login', { method: 'POST', body: { name: limitName, password: wrongPassword + i, deviceId: 'accept-limit', requestId: `accept-limit-${i}` } })).status, 401);
      const blockedEditor = await edge('/api/account/editor/login', { method: 'POST', body: { name: limitName, password: fx.accounts[1].password, deviceId: 'accept-limit', requestId: 'accept-limit-right' } });
      assert.equal(blockedEditor.status, 429, '网站与编辑器的错误次数合在一起算，正确密码也要等');
      assert.equal(blockedEditor.body.code, 'too-many');
      const blockedWeb = await site('/login', { name: limitName, password: fx.accounts[1].password });
      assert.equal(blockedWeb.status, 429);
    });

    await t.test('2.1-13 日志与数据目录里没有密码、令牌、会话值（先证明扫描器找得到）', async () => {
      const canary = path.join(dir, 'accept-canary.txt');
      fs.writeFileSync(canary, `x${secrets.recoveryToken}y`);
      assert.ok(scan(dir, { recoveryToken: secrets.recoveryToken }).some(hit => hit.endsWith('accept-canary.txt')), '扫描器能在文件里找到');
      fs.rmSync(canary);
      const output = captured.join('');
      assert.ok(sources.child > 0, '素材子进程的输出确实被截获了（否则这条查不到它）');
      const needles = Object.fromEntries(Object.entries(secrets).filter(([, value]) => typeof value === 'string' && value.length >= 8));
      assert.ok(Object.keys(needles).length >= 7, '被查的秘密值：' + Object.keys(needles).join(','));
      assert.deepEqual(scan(dir, needles), [], '数据目录（账号库、文档数据、素材数据、证书目录）里没有这些值');
      const inOutput = Object.entries(needles).filter(([, value]) => output.includes(value)).map(([label]) => label);
      assert.deepEqual(inOutput, [], `本进程与素材子进程输出（${output.length} 字符）里没有这些值`);
      t.diagnostic(`captured child=${sources.child} chars, in-process=${sources.proc} chars; scanned ${walk(dir).length} files and ${output.length} chars of output for ${Object.keys(needles).length} secret values`);
    });
  } finally {
    restore();
    await fx?.close();
  }
});
