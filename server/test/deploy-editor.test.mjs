/**
 * `deploy-hosted` 的 C10a 参数（契约 `docs/plan/c10a-contract.md` 第 3 节）：`--doc-public-url`、`--asset-public-url`
 * 写进 PM2 配置；`--editor` 的远端换名脚本（旧版 assets/ 保留一代）。编号 `DEP-…`（c10a-web 自测）。
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
import { hostedInstance, hostedPm2Config, hostedDeployScript, editorSwapLines, checkPublicUrl } from '../hosted/deploy.mjs';

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
  const bash = spawnSync('bash', ['-n'], { input: withEditor, encoding: 'utf8' });
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

test('DEP-4 换名脚本真跑两次：新版换上，旧版 assets 只保留一代，index.html 是新的', (t) => {
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
    const r = spawnSync(bashExe, ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8' });
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
  assert.deepEqual(names, ['index-aaa.css', 'index-bbb.js', 'index-ccc.js'], 'v1 独有的不再保留，只留 v2 一代');
  assert.match(fs.readFileSync(path.join(dir, 'editor', 'index.html'), 'utf8'), /v3/);
  assert.ok(!fs.existsSync(path.join(dir, '.incoming-editor')) && !fs.existsSync(path.join(dir, 'editor.prev')));
  // 没有 index.html 的构建不换上去
  fs.mkdirSync(path.join(dir, '.incoming-editor', 'assets'), { recursive: true });
  const bad = spawnSync(bashExe, ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8' });
  assert.equal(bad.status, 4);
  assert.match(fs.readFileSync(path.join(dir, 'editor', 'index.html'), 'utf8'), /v3/, '旧版原样在位');
});
