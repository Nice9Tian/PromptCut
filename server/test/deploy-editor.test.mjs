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

test('DEP-4 换名脚本真跑两次：新版换上，旧版 assets 只保留一代，index.html 是新的', (t) => {
  const probe = spawnSync('bash', ['-c', 'find . -maxdepth 0 -printf "%f\\n"'], { encoding: 'utf8' });
  if (probe.status !== 0 || probe.error) return t.skip('本机没有带 GNU find 的 bash');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-editor-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `set -euo pipefail\ncd "$1"\n${editorSwapLines().join('\n')}\n`;
  const deploy = (gen, files) => {
    const inc = path.join(dir, '.incoming-editor');
    fs.mkdirSync(path.join(inc, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(inc, 'index.html'), `<!doctype html><title>${gen}</title>`);
    for (const f of files) fs.writeFileSync(path.join(inc, 'assets', f), `${gen}:${f}`);
    const r = spawnSync('bash', ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8' });
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
  const bad = spawnSync('bash', ['-s', dir.replace(/\\/g, '/')], { input: script, encoding: 'utf8' });
  assert.equal(bad.status, 4);
  assert.match(fs.readFileSync(path.join(dir, 'editor', 'index.html'), 'utf8'), /v3/, '旧版原样在位');
});
