/**
 * `deploy-hosted --stage-origins`(C10 契约第 2 节):只改脚本与运行配置的形状 —— 校验两个源、写进 editor/runtime-config.json、
 * 之后只给 --editor 换代时照样保留。
 * 跑:node --test server/test/c10-deploy-stage-origins.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStageOrigins, runtimeConfigLines, hostedDeployScript, hostedInstance, editorSwapLines, RUNTIME_CONFIG_FILE } from '../hosted/deploy.mjs';

test('C10-DS-01 --stage-origins:两个不同的合法源;不给回 undefined;写错抛错', () => {
  assert.equal(checkStageOrigins(undefined), undefined);
  assert.deepEqual(checkStageOrigins('https://s1.8-219-80-16.sslip.io,https://s2.8-219-80-16.sslip.io'),
    { v: 1, stageOrigins: ['https://s1.8-219-80-16.sslip.io', 'https://s2.8-219-80-16.sslip.io'] });
  assert.deepEqual(checkStageOrigins(' http://127.0.0.1:5421/ , http://127.0.0.1:5422 ').stageOrigins, ['http://127.0.0.1:5421', 'http://127.0.0.1:5422']);
  for (const bad of ['https://a.io', 'https://a.io,https://a.io', 'https://a.io/editor,https://b.io', 'ftp://a.io,https://b.io', 'a,b', 'https://a.io,https://b.io,https://c.io']) {
    assert.throws(() => checkStageOrigins(bad), /--stage-origins/, bad);
  }
});

test('C10-DS-02 部署脚本:给了运行配置就写进 editor/runtime-config.json(先写临时文件再换名);不给不写', () => {
  const inst = hostedInstance('main', {});
  const base = { pm2Config: 'module.exports = {};\n', save: false, replaceDocservice: false, token: null };
  const cfg = checkStageOrigins('https://s1.x.io,https://s2.x.io');
  const withCfg = hostedDeployScript(inst, { ...base, editor: true, runtimeConfig: cfg });
  assert.ok(withCfg.includes(`mv editor/.${RUNTIME_CONFIG_FILE}.tmp editor/${RUNTIME_CONFIG_FILE}`));
  assert.ok(withCfg.includes(JSON.stringify(cfg)));
  // 运行配置写在换代之后(新的 editor/ 已经换上)
  assert.ok(withCfg.indexOf('mv .incoming-editor editor') < withCfg.indexOf(`editor/.${RUNTIME_CONFIG_FILE}.tmp`));
  const without = hostedDeployScript(inst, { ...base, editor: true });
  assert.ok(!without.includes(`editor/.${RUNTIME_CONFIG_FILE}.tmp`));
  // 只写运行配置、不换在线构建也行
  const onlyCfg = hostedDeployScript(inst, { ...base, editor: false, runtimeConfig: cfg });
  assert.ok(onlyCfg.includes('mkdir -p editor') && onlyCfg.includes(`editor/${RUNTIME_CONFIG_FILE}`));
  assert.deepEqual(runtimeConfigLines(cfg).filter((l) => l === 'RUNTIMECONFIG').length, 1);
});

test('C10-DS-03 只给 --editor 换代时,上一代的运行配置照样保留', () => {
  const lines = editorSwapLines().join('\n');
  assert.match(lines, new RegExp(`cp -p editor/${RUNTIME_CONFIG_FILE.replace('.', '\\.')} \\.incoming-editor/`));
  assert.ok(lines.indexOf(`editor/${RUNTIME_CONFIG_FILE}`) < lines.indexOf('mv .incoming-editor editor'));
});
