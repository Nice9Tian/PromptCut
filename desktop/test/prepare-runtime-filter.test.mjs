// prepare-runtime 拷源码树时的过滤:`.git` 不论是文件还是目录都不能进 runtime/app。
//
// 背景:build-release --from-head 用一棵临时 git worktree 当源码根,worktree 根上的 `.git`
// 是 `gitdir: …` 指针**文件**。过滤原先只对目录生效,这个文件被拷进了运行时目录、补丁清单
// (0.7.13 的 manifest 里第一个键就是 ".git")和安装包。
// 跑法:node --test desktop/test/prepare-runtime-filter.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { shouldCopyApp, copyRecursive } from '../scripts/prepare-runtime.mjs';

/** 递归列出目录下所有文件的相对路径(正斜杠,已排序) */
function listFiles(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function write(root, rel, body = 'x') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-prep-filter-'));
  try { fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('shouldCopyApp:.git 作为文件和作为目录都被挡,正常名字放行', () => {
  assert.equal(shouldCopyApp('.git', '/src/.git', false), false, '.git 文件(worktree 指针)');
  assert.equal(shouldCopyApp('.git', '/src/.git', true), false, '.git 目录');
  assert.equal(shouldCopyApp('package.json', '/src/package.json', false), true);
  assert.equal(shouldCopyApp('src', '/src/src', true), true);
  // 只有 .git 按名字不分文件/目录;其它 SKIP_DIRS 名字仍只对目录生效,同名源码文件照拷
  assert.equal(shouldCopyApp('node_modules', '/src/node_modules', true), false);
  assert.equal(shouldCopyApp('release', '/src/docs/release', false), true);
  // .gitignore 之类不是 .git,必须保留
  assert.equal(shouldCopyApp('.gitignore', '/src/.gitignore', false), true);
  assert.equal(shouldCopyApp('.github', '/src/.github', true), true);
});

test('copyRecursive + shouldCopyApp:根上的 .git 指针文件不进目标,正常文件都在', () => {
  withTmp((tmp) => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    write(src, '.git', 'gitdir: D:/somewhere/.git/worktrees/release-src\n');
    write(src, 'package.json', '{}');
    write(src, 'src/main.ts', 'export {};');
    write(src, 'server/a.mjs', '1');
    write(src, '.gitignore', 'node_modules');
    write(src, 'node_modules/foo/index.js', 'skip');

    copyRecursive(src, dest, shouldCopyApp);

    assert.deepEqual(listFiles(dest), ['.gitignore', 'package.json', 'server/a.mjs', 'src/main.ts']);
    assert.equal(fs.existsSync(path.join(dest, '.git')), false);
  });
});

test('copyRecursive + shouldCopyApp:.git 目录(含子目录里的子模块 .git 文件)都不进目标', () => {
  withTmp((tmp) => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    write(src, '.git/HEAD', 'ref: refs/heads/main\n');
    write(src, '.git/objects/ab/cdef', 'blob');
    write(src, 'vendor/sub/.git', 'gitdir: ../../.git/modules/sub\n'); // 子模块:嵌套层的 .git 文件
    write(src, 'vendor/sub/lib.js', 'ok');
    write(src, 'vendor/nested/.git/config', 'cfg'); // 嵌套层的 .git 目录
    write(src, 'vendor/nested/index.js', 'ok');
    write(src, 'README.md', 'hi');

    copyRecursive(src, dest, shouldCopyApp);

    assert.deepEqual(listFiles(dest), ['README.md', 'vendor/nested/index.js', 'vendor/sub/lib.js']);
    assert.equal(fs.existsSync(path.join(dest, '.git')), false);
    assert.equal(fs.existsSync(path.join(dest, 'vendor', 'sub', '.git')), false);
    assert.equal(fs.existsSync(path.join(dest, 'vendor', 'nested', '.git')), false);
  });
});

test('当脚本直接执行时 main 照跑(--check 只读,退出码取决于本机有没有运行时,这里只认它起来了)', () => {
  const script = fileURLToPath(new URL('../scripts/prepare-runtime.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', timeout: 120_000 });
  assert.match(r.stdout, /PromptCut prepare-runtime \(--check\)/);
});
