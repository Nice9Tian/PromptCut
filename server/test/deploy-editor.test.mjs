/**
 * `deploy-hosted` 的 C10a 参数（契约 `docs/plan/c10a-contract.md` 第 3 节）：`--doc-public-url`、`--asset-public-url`
 * 写进 PM2 配置；`--editor` 的远端换名脚本（旧版 assets/ 保留前 3 代）。编号 `DEP-…`（c10a-web 自测）。
 * 远端脚本在本机的 bash 里对临时目录真跑一遍（没有 bash 的机器跳过这一条）。
 *
 * 跑：node --test server/test/deploy-editor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { hostedInstance, hostedPm2Config, hostedDeployScript, editorSwapLines, checkPublicUrl, stageEditorBuild, PRECOMPRESS_EXTS } from '../hosted/deploy.mjs';

const pm2Env = (text) => {
  const mod = { exports: {} };
  new Function('module', text)(mod);
  return mod.exports.apps[0].env;
};

test('DEP-1 两个公网地址：给了就写进 PM2 配置，不给按主机名拼（旧行为）', () => {
  const main = hostedInstance('main', {});
  const given = pm2Env(hostedPm2Config(main, '8.219.80.16', {
    docPublicUrl: 'wss://8-219-80-16.sslip.io/hosted/',
    assetPublicUrl: 'https://8-219-80-16.sslip.io/media/api/asset',
  }));
  assert.equal(given.PROMPTCUT_DOCSERVICE_PUBLIC_URL, 'wss://8-219-80-16.sslip.io/hosted/');
  assert.equal(given.PROMPTCUT_ASSET_PUBLIC_URL, 'https://8-219-80-16.sslip.io/media/api/asset');
  const dflt = pm2Env(hostedPm2Config(main, 'h.example'));
  assert.equal(dflt.PROMPTCUT_DOCSERVICE_PUBLIC_URL, 'ws://h.example:8787');
  assert.equal(dflt.PROMPTCUT_ASSET_PUBLIC_URL, 'http://h.example:8788/api/asset');
  const one = pm2Env(hostedPm2Config(main, 'h.example', { docPublicUrl: 'wss://d.example/hosted/' }));
  assert.equal(one.PROMPTCUT_ASSET_PUBLIC_URL, 'http://h.example:8788/api/asset', '只给一个时另一个照旧拼');
});

test('DEP-2 地址参数校验：文档服务收 ws(s)/http(s)，素材服务只收 http(s)；写错抛错不换缺省', () => {
  assert.equal(checkPublicUrl(undefined, 'doc'), undefined);
  assert.equal(checkPublicUrl(' wss://a.example/hosted/ ', 'doc'), 'wss://a.example/hosted/');
  assert.equal(checkPublicUrl('https://a.example/media/api/asset', 'asset'), 'https://a.example/media/api/asset');
  assert.throws(() => checkPublicUrl('wss://a.example/x', 'asset'), /asset-public-url/);
  assert.throws(() => checkPublicUrl('ftp://a.example', 'doc'), /doc-public-url/);
  assert.throws(() => checkPublicUrl('not a url', 'doc'), /doc-public-url/);
});

test('DEP-3 部署脚本：--editor 时带换名几行，不带时没有；语法过 bash -n', () => {
  const inst = hostedInstance('main', {});
  const withEditor = hostedDeployScript(inst, { pm2Config: hostedPm2Config(inst, 'h'), save: false, replaceDocservice: false, token: null, editor: true });
  const without = hostedDeployScript(inst, { pm2Config: hostedPm2Config(inst, 'h'), save: false, replaceDocservice: false, token: null });
  assert.match(withEditor, /mv \.incoming-editor editor/);
  assert.doesNotMatch(without, /incoming-editor/);
  assert.doesNotMatch(withEditor, /ufw/i);
  const bash = spawnSync('bash', ['-n'], { input: withEditor, encoding: 'utf8', windowsHide: true });
  if (bash.status !== null && !bash.error) assert.equal(bash.status, 0, bash.stderr);
});

/**
 * DEP-4 用的 bash:要带 GNU find(换名脚本用 `find -printf`)。
 * - 非 Windows:PATH 上的 `bash`;
 * - Windows:只认 Git Bash(自带 GNU findutils)。由 `git --exec-path`、`where git` 推出 Git 的安装目录,再试常见安装路径;
 *   先取 `<Git>\bin\bash.exe`(它把 Git 的 usr/bin 放进 PATH,里面的 `find` 才是 GNU 的),其次 `<Git>\usr\bin\bash.exe`。
 *   不用 WSL 的 `C:\Windows\System32\bash.exe`(PATH 上它排在前面时,裸的 `bash` 就是它)。
 * 每个候选都要 `find --version` 报 GNU findutils 才用。回 `{ bash }` 或 `{ reason }`。
 */
function findGnuBash() {
  const isGnu = (bash) => {
    const r = spawnSync(bash, ['-c', 'find --version'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 && !r.error && /GNU findutils/.test(r.stdout);
  };
  if (process.platform !== 'win32') return isGnu('bash') ? { bash: 'bash' } : { reason: 'PATH 上的 bash 没有 GNU find' };
  const roots = new Set();
  // 形如 C:/Program Files/Git/mingw64/libexec/git-core → C:/Program Files/Git
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  if (execPath.status === 0 && execPath.stdout.trim()) roots.add(path.resolve(execPath.stdout.trim(), '..', '..', '..'));
  // 形如 …\Git\cmd\git.exe、…\Git\bin\git.exe、…\Git\mingw64\bin\git.exe
  const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  for (const line of where.status === 0 ? where.stdout.split(/\r?\n/) : []) {
    const dir = line.trim() ? path.dirname(line.trim()) : '';
    if (!dir) continue;
    const inMingw = path.basename(dir).toLowerCase() === 'bin' && path.basename(path.dirname(dir)).toLowerCase() === 'mingw64';
    roots.add(path.resolve(dir, inMingw ? '../..' : '..'));
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) roots.add(path.join(base, 'Git'));
  }
  const tried = [];
  for (const root of roots) {
    for (const bash of [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]) {
      if (/[\\/]windows[\\/]system32[\\/]/i.test(bash) || !fs.existsSync(bash)) continue;
      tried.push(bash);
      if (isGnu(bash)) return { bash };
    }
  }
  return { reason: tried.length
    ? `找到的 Git Bash 都没有 GNU find:${tried.join('、')}`
    : '本机没有 Git Bash(git --exec-path、where git 与常见安装路径下都没有 bin\\bash.exe);不用 WSL 的 bash' };
}

test('DEP-4 换名脚本真跑多次：新版换上，旧版 assets 保留前 3 代，同名的用新版，index.html 是新的', (t) => {
  const found = findGnuBash();
  if (!found.bash) return t.skip(found.reason);
  const bashExe = found.bash;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-editor-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `set -euo pipefail\ncd "$1"\n${editorSwapLines().join('\n')}\n`;
  const deploy = (gen, files) => {
    const inc = path.join(dir, '.incoming-editor');
    fs.mkdirSync(path.join(inc, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(inc, 'index.html'), `<!doctype html><title>${gen}</title>`);
    for (const f of files) fs.writeFileSync(path.join(inc, 'assets', f), `${gen}:${f}`);
    const r = spawnSync(bashExe, ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  deploy('v1', ['index-aaa.js', 'index-aaa.css']);
  deploy('v2', ['index-bbb.js', 'index-aaa.css']);
  let names = fs.readdirSync(path.join(dir, 'editor', 'assets')).sort();
  assert.deepEqual(names, ['index-aaa.css', 'index-aaa.js', 'index-bbb.js'], 'v1 的 js 保留一代');
  assert.equal(fs.readFileSync(path.join(dir, 'editor', 'assets', 'index-aaa.css'), 'utf8'), 'v2:index-aaa.css', '同名的用新版');
  deploy('v3', ['index-ccc.js']);
  names = fs.readdirSync(path.join(dir, 'editor', 'assets')).sort();
  assert.deepEqual(names, ['index-aaa.css', 'index-aaa.js', 'index-bbb.js', 'index-ccc.js'], 'v1（前第 2 代）与 v2（前第 1 代）都保留');
  deploy('v4', ['index-ddd.js']);
  names = fs.readdirSync(path.join(dir, 'editor', 'assets')).sort();
  assert.deepEqual(names, ['index-aaa.css', 'index-aaa.js', 'index-bbb.js', 'index-ccc.js', 'index-ddd.js'], 'v1～v3 前 3 代都保留');
  deploy('v5', ['index-eee.js']);
  names = fs.readdirSync(path.join(dir, 'editor', 'assets')).sort();
  assert.deepEqual(names, ['index-aaa.css', 'index-bbb.js', 'index-ccc.js', 'index-ddd.js', 'index-eee.js'], 'v1 独有的 index-aaa.js（前第 4 代）不再保留，v2 里也有的 index-aaa.css 仍保留');
  assert.match(fs.readFileSync(path.join(dir, 'editor', 'index.html'), 'utf8'), /v5/);
  assert.ok(!fs.existsSync(path.join(dir, '.incoming-editor')) && !fs.existsSync(path.join(dir, 'editor.prev')));
  // 没有 index.html 的构建不换上去
  fs.mkdirSync(path.join(dir, '.incoming-editor', 'assets'), { recursive: true });
  const bad = spawnSync(bashExe, ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 4);
  assert.match(fs.readFileSync(path.join(dir, 'editor', 'index.html'), 'utf8'), /v5/, '旧版原样在位');
});

test('DEP-5 暂存在线构建：assets 下大于 1 KB 的 js/mjs/css/json/svg/wasm 都有 .gz，解压后与原文件逐字相同；别的不压，源目录不动', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-editor-stage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'dist-online');
  fs.mkdirSync(path.join(src, 'assets', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(src, 'catalog'), { recursive: true });
  const big = (seed) => Buffer.from(Array.from({ length: 4000 }, (_, i) => `${seed}-${i % 97};`).join(''));
  const want = [];
  for (const ext of PRECOMPRESS_EXTS) {
    fs.writeFileSync(path.join(src, 'assets', `a-x1${ext}`), big(ext));
    want.push(`a-x1${ext}.gz`);
  }
  fs.writeFileSync(path.join(src, 'assets', 'UP.JS'), big('upper'));
  want.push('UP.JS.gz');
  fs.writeFileSync(path.join(src, 'assets', 'sub', 'w.wasm'), crypto.randomBytes(5000));
  want.push('sub/w.wasm.gz');
  fs.writeFileSync(path.join(src, 'assets', 'small.js'), Buffer.alloc(1024, 97)); // 恰好 1 KB：不压
  fs.writeFileSync(path.join(src, 'assets', 'pic.png'), crypto.randomBytes(5000)); // 扩展名不在表里
  fs.writeFileSync(path.join(src, 'assets', 'font.woff2'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(src, 'catalog', 'big.json'), big('catalog')); // 不在 assets/ 下
  fs.writeFileSync(path.join(src, 'index.html'), '<!doctype html>');
  const before = fs.readdirSync(path.join(src, 'assets')).sort();

  const out = path.join(dir, 'stage', '.incoming-editor');
  const { gz } = stageEditorBuild(src, out);
  assert.deepEqual(gz, want.sort());
  for (const rel of gz) {
    const orig = fs.readFileSync(path.join(out, 'assets', rel.replace(/\.gz$/, '')));
    const packed = fs.readFileSync(path.join(out, 'assets', rel));
    assert.ok(orig.equals(zlib.gunzipSync(packed)), `${rel} 解压后与原文件逐字相同`);
  }
  // 最高压缩级别：与 level 9 的结果同样大小（gzip 头的时间戳为 0，逐字相同）
  const js = fs.readFileSync(path.join(out, 'assets', 'a-x1.js'));
  assert.ok(fs.readFileSync(path.join(out, 'assets', 'a-x1.js.gz')).equals(zlib.gzipSync(js, { level: 9 })));
  for (const f of ['small.js.gz', 'pic.png.gz', 'font.woff2.gz']) assert.ok(!fs.existsSync(path.join(out, 'assets', f)), `${f} 不该有`);
  assert.ok(!fs.existsSync(path.join(out, 'catalog', 'big.json.gz')));
  assert.ok(fs.existsSync(path.join(out, 'index.html')) && fs.existsSync(path.join(out, 'catalog', 'big.json')), '其余文件原样拷过去');
  assert.deepEqual(fs.readdirSync(path.join(src, 'assets')).sort(), before, '源目录不动');
});

test('DEP-6 换名脚本对 .gz：本代的 .gz 进清单、后续换代随原文件保留前 3 代；清单里没记 .gz 的老一代也随原文件补上', (t) => {
  const found = findGnuBash();
  if (!found.bash) return t.skip(found.reason);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-editor-swapgz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `set -euo pipefail\ncd "$1"\n${editorSwapLines().join('\n')}\n`;
  const deploy = (gen, files) => {
    const inc = path.join(dir, '.incoming-editor');
    fs.mkdirSync(path.join(inc, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(inc, 'index.html'), `<!doctype html><title>${gen}</title>`);
    for (const f of files) fs.writeFileSync(path.join(inc, 'assets', f), `${gen}:${f}`);
    const r = spawnSync(found.bash, ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  };
  const assets = () => fs.readdirSync(path.join(dir, 'editor', 'assets')).sort();
  // v0：老一代，清单里没有 .gz；之后像服务器上那样手工补一个 .gz（不在 .assets-own 里）
  deploy('v0', ['index-000.js']);
  fs.writeFileSync(path.join(dir, 'editor', 'assets', 'index-000.js.gz'), 'manual');
  deploy('v1', ['index-aaa.js', 'index-aaa.js.gz', 'index-aaa.css', 'index-aaa.css.gz']);
  assert.deepEqual(assets(), ['index-000.js', 'index-000.js.gz', 'index-aaa.css', 'index-aaa.css.gz', 'index-aaa.js', 'index-aaa.js.gz'],
    '老一代手工生成的 .gz 随原文件补上');
  const own1 = fs.readFileSync(path.join(dir, 'editor', '.assets-own'), 'utf8').trim().split('\n');
  assert.deepEqual(own1, ['index-aaa.css', 'index-aaa.css.gz', 'index-aaa.js', 'index-aaa.js.gz'], '本代的 .gz 写进清单，补进来的上一代不写');
  deploy('v2', ['index-bbb.js', 'index-bbb.js.gz', 'index-aaa.css', 'index-aaa.css.gz']);
  assert.deepEqual(assets(), ['index-000.js', 'index-000.js.gz', 'index-aaa.css', 'index-aaa.css.gz', 'index-aaa.js', 'index-aaa.js.gz', 'index-bbb.js', 'index-bbb.js.gz'],
    'v0（前第 2 代）与 v1（前第 1 代）的 js 与 .gz 都保留');
  assert.equal(fs.readFileSync(path.join(dir, 'editor', 'assets', 'index-aaa.css.gz'), 'utf8'), 'v2:index-aaa.css.gz', '同名的 .gz 用新版');
  deploy('v3', ['index-ccc.js']);
  assert.deepEqual(assets(), ['index-000.js', 'index-000.js.gz', 'index-aaa.css', 'index-aaa.css.gz', 'index-aaa.js', 'index-aaa.js.gz', 'index-bbb.js', 'index-bbb.js.gz', 'index-ccc.js'],
    'v0～v2 前 3 代的 js 与 .gz 都保留');
  deploy('v4', ['index-ddd.js']);
  assert.deepEqual(assets(), ['index-aaa.css', 'index-aaa.css.gz', 'index-aaa.js', 'index-aaa.js.gz', 'index-bbb.js', 'index-bbb.js.gz', 'index-ccc.js', 'index-ddd.js'],
    'v0（前第 4 代）不再保留，只留 v1～v3 前 3 代');
});

test('DEP-7 换名脚本连续换代 6 次并核对清单文件，再验证从旧布局（只有 .assets-own）平滑升级', (t) => {
  const found = findGnuBash();
  if (!found.bash) return t.skip(found.reason);
  const bashExe = found.bash;
  const script = `set -euo pipefail\ncd "$1"\n${editorSwapLines().join('\n')}\n`;

  // 1) 全新连续换代 6 次：每次核对 editor/assets/ 里的全部文件以及 .assets-own / .assets-own.1 / .assets-own.2
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-editor-swap6-'));
  t.after(() => fs.rmSync(dir1, { recursive: true, force: true }));
  const deployTo = (baseDir, gen, files) => {
    const inc = path.join(baseDir, '.incoming-editor');
    fs.mkdirSync(path.join(inc, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(inc, 'index.html'), `<!doctype html><title>${gen}</title>`);
    for (const f of files) fs.writeFileSync(path.join(inc, 'assets', f), `${gen}:${f}`);
    const r = spawnSync(bashExe, ['-s', baseDir.replace(/\\/g, '/')], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  };
  const assetsOf = (baseDir) => fs.readdirSync(path.join(baseDir, 'editor', 'assets')).sort();
  const manifestOf = (baseDir, name) => {
    const p = path.join(baseDir, 'editor', name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : null;
  };

  deployTo(dir1, 'g1', ['a1.js', 'a1.js.gz', 'shared.css']);
  assert.deepEqual(assetsOf(dir1), ['a1.js', 'a1.js.gz', 'shared.css']);
  assert.deepEqual(manifestOf(dir1, '.assets-own'), ['a1.js', 'a1.js.gz', 'shared.css']);
  assert.equal(manifestOf(dir1, '.assets-own.1'), null);
  assert.equal(manifestOf(dir1, '.assets-own.2'), null);

  deployTo(dir1, 'g2', ['a2.js', 'shared.css']);
  assert.deepEqual(assetsOf(dir1), ['a1.js', 'a1.js.gz', 'a2.js', 'shared.css']);
  assert.deepEqual(manifestOf(dir1, '.assets-own'), ['a2.js', 'shared.css']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.1'), ['a1.js', 'a1.js.gz', 'shared.css']);
  assert.equal(manifestOf(dir1, '.assets-own.2'), null);

  deployTo(dir1, 'g3', ['a3.js']);
  assert.deepEqual(assetsOf(dir1), ['a1.js', 'a1.js.gz', 'a2.js', 'a3.js', 'shared.css']);
  assert.deepEqual(manifestOf(dir1, '.assets-own'), ['a3.js']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.1'), ['a2.js', 'shared.css']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.2'), ['a1.js', 'a1.js.gz', 'shared.css']);

  deployTo(dir1, 'g4', ['a4.js']);
  assert.deepEqual(assetsOf(dir1), ['a1.js', 'a1.js.gz', 'a2.js', 'a3.js', 'a4.js', 'shared.css'], 'g4 时保留 g1、g2、g3 前 3 代');
  assert.deepEqual(manifestOf(dir1, '.assets-own'), ['a4.js']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.1'), ['a3.js']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.2'), ['a2.js', 'shared.css']);

  deployTo(dir1, 'g5', ['a5.js']);
  assert.deepEqual(assetsOf(dir1), ['a2.js', 'a3.js', 'a4.js', 'a5.js', 'shared.css'], 'g5 时淘汰 g1 独有的 a1.js / a1.js.gz，保留 g2、g3、g4');
  assert.deepEqual(manifestOf(dir1, '.assets-own'), ['a5.js']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.1'), ['a4.js']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.2'), ['a3.js']);

  deployTo(dir1, 'g6', ['a6.js']);
  assert.deepEqual(assetsOf(dir1), ['a3.js', 'a4.js', 'a5.js', 'a6.js'], 'g6 时淘汰 g2 的 a2.js 与 shared.css，只保留 g3、g4、g5');
  assert.deepEqual(manifestOf(dir1, '.assets-own'), ['a6.js']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.1'), ['a5.js']);
  assert.deepEqual(manifestOf(dir1, '.assets-own.2'), ['a4.js']);

  // 2) 从旧布局（只有 editor/.assets-own，没有 .assets-own.1 / .assets-own.2）升级
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-editor-legacy-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir2, 'editor', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'editor', 'index.html'), '<!doctype html><title>old-1</title>');
  // 旧目录里既有上一代遗留但不在 .assets-own 里的 old-0.js，也有旧版自己的 old-1.js
  fs.writeFileSync(path.join(dir2, 'editor', 'assets', 'old-0.js'), 'old0');
  fs.writeFileSync(path.join(dir2, 'editor', 'assets', 'old-1.js'), 'old1');
  fs.writeFileSync(path.join(dir2, 'editor', '.assets-own'), 'old-1.js\n');

  deployTo(dir2, 'new-2', ['new-2.js']);
  assert.deepEqual(assetsOf(dir2), ['new-2.js', 'old-1.js'], '第一次跑新脚本：缺的旧清单当空，old-1.js 照常保留');
  assert.deepEqual(manifestOf(dir2, '.assets-own'), ['new-2.js']);
  assert.deepEqual(manifestOf(dir2, '.assets-own.1'), ['old-1.js']);
  assert.equal(manifestOf(dir2, '.assets-own.2'), null);

  deployTo(dir2, 'new-3', ['new-3.js']);
  assert.deepEqual(assetsOf(dir2), ['new-2.js', 'new-3.js', 'old-1.js']);
  assert.deepEqual(manifestOf(dir2, '.assets-own.2'), ['old-1.js']);

  deployTo(dir2, 'new-4', ['new-4.js']);
  assert.deepEqual(assetsOf(dir2), ['new-2.js', 'new-3.js', 'new-4.js', 'old-1.js'], 'old-1.js 到第 3 代仍保留');

  deployTo(dir2, 'new-5', ['new-5.js']);
  assert.deepEqual(assetsOf(dir2), ['new-2.js', 'new-3.js', 'new-4.js', 'new-5.js'], '第 4 次换代后 old-1.js 自然淘汰');
});

test('DEP-8 vite.config.ts 在线构建产出 version.json（codeVersion 与 __PC_CODE_VERSION__ 完全一致），桌面配置不含该插件', async () => {
  const { register } = await import('node:module');
  try {
    register(new URL('../../src/testing/resolveTs.mjs', import.meta.url));
  } catch {
    /* 已注册过则跳过 */
  }
  const mod = await import(new URL('../../vite.config.ts', import.meta.url).href);
  const cfg = await mod.default({ mode: 'online', command: 'build' });
  const plugin = (cfg.plugins ?? []).find((p) => p && p.name === 'promptcut-version-json');
  assert.ok(plugin, 'online 配置应包含 promptcut-version-json 插件');
  assert.equal(plugin.apply, 'build');

  const emitted = [];
  const gen = typeof plugin.generateBundle === 'function' ? plugin.generateBundle : plugin.generateBundle.handler;
  gen.call({ emitFile: (f) => emitted.push(f) }, {}, {});
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'asset');
  assert.equal(emitted[0].fileName, 'version.json');
  assert.deepEqual(JSON.parse(emitted[0].source), {
    codeVersion: JSON.parse(cfg.define.__PC_CODE_VERSION__),
  });
  // 打包结果里有入口块：写上编辑器页入口脚本的文件名（门面是 index.html 的那一块），只改依赖时靠它看出新版本
  const withEntry = [];
  gen.call({ emitFile: (f) => withEntry.push(f) }, {}, {
    'assets/vendor-x.js': { type: 'chunk', isEntry: false, fileName: 'assets/vendor-x.js', facadeModuleId: null },
    'assets/stage-y.js': { type: 'chunk', isEntry: true, fileName: 'assets/stage-y.js', facadeModuleId: 'C:/r/stage.html' },
    'assets/index-z.js': { type: 'chunk', isEntry: true, fileName: 'assets/index-z.js', facadeModuleId: 'C:\\r\\index.html' },
    'assets/a.css': { type: 'asset', fileName: 'assets/a.css' },
  });
  assert.deepEqual(JSON.parse(withEntry[0].source), { codeVersion: JSON.parse(cfg.define.__PC_CODE_VERSION__), entry: 'assets/index-z.js' });

  for (const mode of ['development', 'production']) {
    const desk = await mod.default({ mode, command: 'build' });
    const found = (desk.plugins ?? []).find((p) => p && p.name === 'promptcut-version-json');
    assert.equal(found, undefined, `桌面配置（mode=${mode}）不应包含 promptcut-version-json 插件`);
  }
});

test('DEP-9 换名脚本的重跑：同一份构建再换一次不算新的一代、前几代不被挤掉；上次停在两次换名之间（只剩 editor.prev）的先挪回来', (t) => {
  const found = findGnuBash();
  if (!found.bash) return t.skip(found.reason);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-editor-rerun-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `set -euo pipefail\ncd "$1"\n${editorSwapLines().join('\n')}\n`;
  const deploy = (gen, files) => {
    const inc = path.join(dir, '.incoming-editor');
    fs.mkdirSync(path.join(inc, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(inc, 'index.html'), `<!doctype html><title>${gen}</title>`);
    for (const f of files) fs.writeFileSync(path.join(inc, 'assets', f), `${gen}:${f}`);
    const r = spawnSync(found.bash, ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const assets = () => fs.readdirSync(path.join(dir, 'editor', 'assets')).sort();
  const manifest = (name) => {
    const p = path.join(dir, 'editor', name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : null;
  };
  deploy('g1', ['a1.js']);
  deploy('g2', ['a2.js']);
  deploy('g3', ['a3.js']);
  deploy('g4', ['a4.js']);
  assert.deepEqual(assets(), ['a1.js', 'a2.js', 'a3.js', 'a4.js']);
  // 同一份构建（g4）再换两次：清单不顺延，g1～g3 照旧都在
  deploy('g4', ['a4.js']);
  deploy('g4', ['a4.js']);
  assert.deepEqual(assets(), ['a1.js', 'a2.js', 'a3.js', 'a4.js'], '重跑不挤掉前 3 代');
  assert.deepEqual([manifest('.assets-own'), manifest('.assets-own.1'), manifest('.assets-own.2')], [['a4.js'], ['a3.js'], ['a2.js']]);
  // 下一份真正的新构建照常顺延，淘汰 g1
  deploy('g5', ['a5.js']);
  assert.deepEqual(assets(), ['a2.js', 'a3.js', 'a4.js', 'a5.js']);
  assert.deepEqual([manifest('.assets-own'), manifest('.assets-own.1'), manifest('.assets-own.2')], [['a5.js'], ['a4.js'], ['a3.js']]);

  // 模拟上次停在 `mv editor editor.prev` 之后、`mv .incoming-editor editor` 之前
  fs.renameSync(path.join(dir, 'editor'), path.join(dir, 'editor.prev'));
  const out = deploy('g6', ['a6.js']);
  assert.match(out, /editor\.prev 挪回 editor/);
  assert.deepEqual(assets(), ['a3.js', 'a4.js', 'a5.js', 'a6.js'], '挪回后前 3 代照常保留');
  assert.match(fs.readFileSync(path.join(dir, 'editor', 'index.html'), 'utf8'), /g6/);
  assert.ok(!fs.existsSync(path.join(dir, 'editor.prev')));
});
