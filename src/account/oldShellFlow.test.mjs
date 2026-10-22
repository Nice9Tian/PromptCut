/**
 * 「搬到云端」一侧（`src/editor/sync/accountMoveFlow.ts`）对老外壳的反应：用真模块（Vite 服务端加载），
 * 页面全局换成外壳替身。外壳没有账号桥时 `accountCloud()` 回 null，并记下「外壳太老」，设置据此说明要装完整安装包；
 * 真错误、没有外壳（开发服务器）回 null 但不记；外壳有账号桥时一切照旧。
 * 跑法：npm test -- src/account/oldShellFlow.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('accountCloud / accountShellTooOld / oldShellBlocksAccountMove：老外壳说明，真错误不吞，有账号桥不变', { timeout: 120_000 }, async () => {
  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const saved = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  try {
    globalThis.location = { origin: 'http://127.0.0.1:5910', href: 'http://127.0.0.1:5910/', hostname: '127.0.0.1' };
    globalThis.fetch = async (url) => {
      if (String(url) !== '/api/docservice/device') throw new Error(`unexpected fetch ${url}`);
      return new Response(JSON.stringify({ ok: true, deviceId: 'device-old-shell-test', deviceName: 'fixture', lanHost: false }), { headers: { 'content-type': 'application/json' } });
    };
    const flow = await vite.ssrLoadModule('/src/editor/sync/accountMoveFlow.ts');
    const { DEFAULT_HOSTED_URL } = (await vite.ssrLoadModule('/src/editor/sync/sharedApi.ts')).hosted;
    const shell = (invoke, version = { fails: true }) => ({ core: { invoke }, app: { getVersion: async () => { if (version.fails) throw 'plugin:app|version not allowed by ACL'; return version.value; } } });
    const calls = [];
    const lacking = (text) => async (command, args) => { calls.push({ command, args }); throw text; };

    // 没问过之前：不是「外壳太老」
    assert.equal(flow.accountShellTooOld(), false);
    assert.equal(flow.oldShellBlocksAccountMove(''), false);

    // 老外壳（发布版 Tauri 对不存在的命令的原话）
    globalThis.window = { __TAURI__: shell(lacking('Command account_bridge not allowed by ACL')) };
    assert.equal(await flow.accountCloud(), null, '没有账号桥：回 null，不抛异常');
    assert.equal(flow.accountShellTooOld(), true);
    assert.deepEqual(calls, [{ command: 'account_bridge', args: { operation: 'configuration', args: {} } }]);
    // 缺省云端（没填、内置缺省地址）要说明；用户自己填的别的节点仍走旧办法，不说明
    for (const url of ['', null, undefined, DEFAULT_HOSTED_URL, DEFAULT_HOSTED_URL + '/']) assert.equal(flow.oldShellBlocksAccountMove(url), true, String(url));
    for (const url of ['https://my-own-node.example.com', 'http://192.168.1.5:8787']) assert.equal(flow.oldShellBlocksAccountMove(url), false, url);
    // 没取到不记住：再问一次还是老外壳，且每次都真问
    assert.equal(await flow.accountCloud(), null);
    assert.equal(calls.length, 2);

    // 真错误（新外壳自己的代号）：回 null，但不是「外壳太老」，设置里不会改说装安装包
    globalThis.window = { __TAURI__: shell(lacking('desktop-account-forbidden'), { value: '0.2.8' }) };
    assert.equal(await flow.accountCloud(), null);
    assert.equal(flow.accountShellTooOld(), false, '真错误不是外壳太老');
    assert.equal(flow.oldShellBlocksAccountMove(''), false);

    // 新外壳上权限配错：原话和老外壳一样，但版本是 0.2.8，不当成外壳太老
    globalThis.window = { __TAURI__: shell(lacking('Command account_bridge not allowed by ACL'), { value: '0.2.8' }) };
    assert.equal(await flow.accountCloud(), null);
    assert.equal(flow.accountShellTooOld(), false);

    // 没有桌面外壳（开发服务器）：照旧回 null，不是外壳太老
    globalThis.window = {};
    assert.equal(await flow.accountCloud(), null);
    assert.equal(flow.accountShellTooOld(), false);

    // 外壳有账号桥：拿到账号云端，不是外壳太老
    globalThis.window = { __TAURI__: shell(async () => ({ origin: 'https://visuhive.com/some/path' }), { value: '0.2.8' }) };
    const cloud = await flow.accountCloud();
    assert.equal(cloud?.origin, 'https://visuhive.com');
    assert.equal(flow.accountShellTooOld(), false);
    assert.equal(flow.oldShellBlocksAccountMove(''), false);
    assert.equal(flow.targetsAccountCloud('', cloud), true, '账号云端照旧认缺省地址');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    await vite.close();
  }
});
