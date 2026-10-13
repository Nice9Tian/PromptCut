/**
 * 守门：产品代码里「已不存在」证明的信任表只有随软件分发的那一张。
 *
 * 桌面版本身就是开发服务器，前端的 `import.meta.env` 能被运行目录里的 `.env.local` 改；信任表一旦能被环境变量、
 * 配置或页面钩子扩充，放一个自带公钥的签发方就能把还活着的云端文件转成本地项目。所以：
 * - 页面一侧只有 `syncManager.ts` 引证明模块，只引 `queryGone`，调用时不传 `authorities`；
 * - 证明模块自己不读任何环境、存储、全局钩子；表连同里面每一条都是冻住的；
 * - 仓库的产品代码里没有那条已去掉的环境变量名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRUSTED_GONE_AUTHORITIES, validAuthority } from '../recovery/gone-proof.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'target', 'dist', 'dist-online', 'out', '.git', '.worktrees', 'runtime']);
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|cjs|rs|json|toml)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const isTest = file => /\.test\.mjs$/.test(file) || /(^|\/)test\//.test(rel(file)) || /(^|\/)testing\//.test(rel(file));
const product = ['src', 'server', 'desktop'].flatMap(dir => fs.existsSync(path.join(ROOT, dir)) ? walk(path.join(ROOT, dir)) : []).filter(file => !isTest(file));

test('已去掉的环境变量通道没有回来', () => {
  const hits = product.filter(file => fs.readFileSync(file, 'utf8').includes('VITE_PC_GONE')).map(rel);
  assert.deepEqual(hits, []);
});

test('页面一侧只有 syncManager 引证明模块，只引 queryGone，调用时不传信任表', () => {
  const users = product.filter(file => rel(file).startsWith('src/') && /(?:from\s*|import\(\s*)["'][^"']*gone-proof\.mjs["']/.test(fs.readFileSync(file, 'utf8'))).map(rel);
  assert.deepEqual(users, ['src/editor/sync/syncManager.ts']);
  const text = fs.readFileSync(path.join(ROOT, users[0]), 'utf8');
  const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*gone-proof\.mjs"/g)].map(m => m[1].split(',').map(x => x.trim()).filter(Boolean));
  assert.deepEqual(imports, [['queryGone']]);
  const calls = [...text.matchAll(/queryGone\(([^;]*)\);?/g)].map(m => m[1]);
  assert.equal(calls.length, 1, '只有一处调用');
  assert.equal(/authorities/.test(calls[0]), false, calls[0]);
  assert.equal(/TRUSTED_GONE_AUTHORITIES|validAuthority|authorityFor/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), false, '页面代码不碰信任表本身');
});

test('服务端产品代码里，带着自备信任表调用的只有登记墓碑的命令行工具', () => {
  const callers = product.filter(file => rel(file).startsWith('server/') && /queryGone\(/.test(fs.readFileSync(file, 'utf8'))).map(rel).sort();
  assert.deepEqual(callers, ['server/hosted/deploy/legacy-tombstones.mjs', 'server/recovery/gone-proof.mjs']);
});

test('证明模块不读环境、存储或全局钩子；表是冻住的', () => {
  const text = fs.readFileSync(path.join(ROOT, 'server/recovery/gone-proof.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['import.meta.env', 'process.env', 'localStorage', 'sessionStorage', 'window.', 'globalThis.__', 'location.']) assert.equal(text.includes(banned), false, banned);
  assert.equal(Object.isFrozen(TRUSTED_GONE_AUTHORITIES), true);
  assert.throws(() => TRUSTED_GONE_AUTHORITIES.push({}), TypeError);
  for (const entry of TRUSTED_GONE_AUTHORITIES) {
    assert.equal(validAuthority(entry), true);
    assert.equal(Object.isFrozen(entry) && Object.isFrozen(entry.services) && Object.isFrozen(entry.keys), true);
    assert.equal(/^https:\/\//.test(entry.origin), true, '正式签发方只走 https');
    assert.equal(/localhost|127\.0\.0\.1|\.invalid|\.test|\.example/.test(JSON.stringify(entry)), false, '表里没有测试用的条目');
  }
});
