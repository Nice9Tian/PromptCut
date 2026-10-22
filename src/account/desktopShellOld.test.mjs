/**
 * 桌面外壳比 0.2.8 老（打了更新补丁、没换外壳）时，`account_bridge` 命令不存在：账号入口要认出来并说明「要装完整安装包」，
 * 而真正的错误（新外壳自己的 `desktop-account-*` 代号、权限配错、网络错）要照常报错。
 *
 * 「命令不存在」时 Tauri 拒绝的原话来自 tauri 2.11 的 `src/webview/mod.rs`、`src/ipc/authority.rs`：
 *   发布版  `Command account_bridge not allowed by ACL`（页面是 127.0.0.1:5210 的远程来源，ACL 里没有它）
 *   没有应用权限清单的本地来源  `Command account_bridge not found`
 *   调试版  `account_bridge not allowed. Command not found` / `... Plugin not found`
 * 三句都是 `invoke` 的 Promise 以字符串拒绝（不是 Error 对象）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ACCOUNT_BRIDGE_MIN_SHELL, DesktopShellTooOldError, OLD_SHELL_ACCOUNT_TEXT, desktopAccountBridge, isDesktopShellTooOld,
  isMissingAccountBridgeRejection, shellHasAccountBridge,
} from './desktopVault.ts';

const SHAPES = [
  'Command account_bridge not allowed by ACL',
  'Command account_bridge not found',
  'account_bridge not allowed. Command not found',
  'account_bridge not allowed. Plugin not found',
];

/** 在 `window.__TAURI__` 上装一个外壳替身，跑完还原 */
async function withShell(shell, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = { __TAURI__: shell };
  try { return await fn(); } finally { if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window; }
}
/** 外壳替身：`reject` 给了就让 `account_bridge` 以它拒绝；`versionFails` 是读版本的命令也被拒（更老的外壳没给远程页面 core:default） */
const shellWith = ({ reject, version, versionFails }) => {
  const calls = [];
  return { calls, tauri: {
    core: { invoke: async (command, args) => { calls.push({ command, args }); if (reject !== undefined) throw reject; return { origin: 'https://visuhive.com' }; } },
    app: { getVersion: async () => { if (versionFails) throw 'plugin:app|version not allowed by ACL'; return version; } },
  } };
};
const outcome = async (promise) => { try { return { value: await promise }; } catch (error) { return { error }; } };

test('Tauri 拒绝「命令不存在」的几种原话都认得', () => {
  for (const text of SHAPES) {
    assert.equal(isMissingAccountBridgeRejection(text), true, text);
    assert.equal(isMissingAccountBridgeRejection(new Error(text)), true, `${text}（包成 Error）`);
    assert.equal(isMissingAccountBridgeRejection({ message: ` ${text}\n` }), true, `${text}（带空白、对象）`);
  }
});

test('别的错误都不认：新外壳自己的代号、权限配错、别的命令、网络错、带多余内容的句子', () => {
  const rust = fs.readFileSync(new URL('../../desktop/src-tauri/src/account_vault.rs', import.meta.url), 'utf8');
  const codes = [...rust.matchAll(/"(desktop-account-[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 4, `account_vault.rs 里的错误代号：${codes.join(',')}`);
  for (const code of codes) assert.equal(isMissingAccountBridgeRejection(code), false, code);
  const others = [
    'desktop-account-bridge',
    'Command other_cmd not found',
    'Command other_cmd not allowed by ACL',
    'account_bridge not allowed on window "main", webview "main", URL: http://127.0.0.1:5210/\n\nallowed on: [windows: "main", URL: http://127.0.0.1:5210/*]\n\nreferenced by: capability: account, permission: allow-account-bridge',
    'account_bridge not allowed on origin [http://127.0.0.1:5199/]. Please create a capability that has this origin on the context field.',
    'Command account_bridge not found, please retry',
    'xCommand account_bridge not allowed by ACL',
    'Failed to fetch', 'timeout', 'login-failed', '',
  ];
  for (const text of others) assert.equal(isMissingAccountBridgeRejection(text), false, text);
  for (const value of [null, undefined, 42, {}, [], true]) assert.equal(isMissingAccountBridgeRejection(value), false, String(value));
});

test('外壳版本：0.2.8 起有账号桥，读不出版本是 null', () => {
  for (const v of ['0.2.8', '0.2.9', '0.2.10', '0.3.0', '1.0.0', ' 0.2.8 ', '0.2.8-beta']) assert.equal(shellHasAccountBridge(v), true, v);
  for (const v of ['0.2.7', '0.2.0', '0.1.99', '0.0.9']) assert.equal(shellHasAccountBridge(v), false, v);
  for (const v of [undefined, null, '', 'abc', '0.2', 28, {}]) assert.equal(shellHasAccountBridge(v), null, String(v));
  assert.equal(ACCOUNT_BRIDGE_MIN_SHELL, '0.2.8');
});

test('仓库里的外壳版本不低于「有账号桥」的那一版，且账号桥确实登记在外壳里', () => {
  const conf = JSON.parse(fs.readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(shellHasAccountBridge(conf.version), true, conf.version);
  assert.match(fs.readFileSync(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8'), /account_vault::account_bridge/);
  assert.match(fs.readFileSync(new URL('../../desktop/src-tauri/build.rs', import.meta.url), 'utf8'), /"account_bridge"/);
});

test('老外壳：任何一种「命令不存在」的原话都变成 DesktopShellTooOldError，带说明；读不出版本或版本低于 0.2.8 都算', async () => {
  for (const reject of SHAPES) for (const version of [{ versionFails: true }, { version: '0.2.7' }, { version: '0.2.0' }]) {
    const { tauri, calls } = shellWith({ reject, ...version });
    const got = await withShell(tauri, () => outcome(desktopAccountBridge('configuration')));
    assert.ok(got.error instanceof DesktopShellTooOldError, `${reject} ${JSON.stringify(version)}`);
    assert.equal(got.error.code, 'desktop-shell-too-old');
    assert.equal(got.error.message, OLD_SHELL_ACCOUNT_TEXT);
    assert.equal(isDesktopShellTooOld(got.error), true);
    assert.deepEqual(calls, [{ command: 'account_bridge', args: { operation: 'configuration', args: {} } }]);
  }
  assert.match(OLD_SHELL_ACCOUNT_TEXT, /这个功能要装完整安装包/);
});

test('真错误照常抛出：新外壳的代号、网络错、权限配错的长句，一律原样，不说成外壳太老', async () => {
  const real = ['desktop-account-forbidden', 'desktop-account-request', 'desktop-account-bridge', 'Failed to fetch',
    'account_bridge not allowed on window "other", webview "other", URL: http://127.0.0.1:5210/'];
  for (const reject of real) for (const version of [{ versionFails: true }, { version: '0.2.7' }, { version: '0.2.8' }]) {
    const { tauri } = shellWith({ reject, ...version });
    const got = await withShell(tauri, () => outcome(desktopAccountBridge('login', { name: 'x' })));
    assert.equal(got.error, reject, `${reject} ${JSON.stringify(version)}`);
    assert.equal(isDesktopShellTooOld(got.error), false);
  }
  const err = new Error('boom');
  const got = await withShell(shellWith({ reject: err, versionFails: true }).tauri, () => outcome(desktopAccountBridge('recover')));
  assert.equal(got.error, err);
});

test('新外壳（版本不低于 0.2.8）上权限配错，拒绝的原话和老外壳一样，也照常报原来的错', async () => {
  for (const reject of SHAPES) for (const version of ['0.2.8', '0.2.9', '0.3.1']) {
    const { tauri } = shellWith({ reject, version });
    const got = await withShell(tauri, () => outcome(desktopAccountBridge('configuration')));
    assert.equal(got.error, reject, `${reject} ${version}`);
    assert.equal(isDesktopShellTooOld(got.error), false);
  }
});

test('外壳有账号桥：调用和返回值原样，读版本的命令一次也不碰', async () => {
  let versionAsked = 0;
  const calls = [];
  const tauri = { core: { invoke: async (command, args) => { calls.push({ command, args }); return { origin: 'https://visuhive.com' }; } }, app: { getVersion: async () => { versionAsked++; return '0.2.8'; } } };
  const value = await withShell(tauri, () => desktopAccountBridge('configuration'));
  assert.deepEqual(value, { origin: 'https://visuhive.com' });
  assert.deepEqual(calls, [{ command: 'account_bridge', args: { operation: 'configuration', args: {} } }]);
  const again = await withShell(tauri, () => desktopAccountBridge('request', { path: '/x' }));
  assert.deepEqual(again, { origin: 'https://visuhive.com' });
  assert.deepEqual(calls[1], { command: 'account_bridge', args: { operation: 'request', args: { path: '/x' } } });
  assert.equal(versionAsked, 0);
});

test('没有桌面外壳（在线页面、开发服务器）：照旧报「此环境没有桌面账号安全存储」，不说外壳太老', async () => {
  for (const tauri of [undefined, {}, { core: {} }]) {
    const got = await withShell(tauri, () => outcome(desktopAccountBridge('configuration')));
    assert.ok(got.error instanceof Error);
    assert.match(got.error.message, /此环境没有桌面账号安全存储/);
    assert.equal(isDesktopShellTooOld(got.error), false);
  }
});

test('isDesktopShellTooOld 只认这个错误，不认文案', () => {
  assert.equal(isDesktopShellTooOld(new DesktopShellTooOldError()), true);
  assert.equal(isDesktopShellTooOld({ code: 'desktop-shell-too-old' }), true);
  for (const value of [new Error(OLD_SHELL_ACCOUNT_TEXT), OLD_SHELL_ACCOUNT_TEXT, null, undefined, 'desktop-shell-too-old', { code: 'other' }]) assert.equal(isDesktopShellTooOld(value), false);
});
