// /api/** 同源守卫这一层的中间件本身。http-guard.test.mjs 测的是判据函数,
// 这里测的是「哪些路由被放行、哪些被拒」—— 尤其是原始字节体的白名单。
//
// 起因是一个真 bug:对话附件的「+」上传(/api/chats/attach/upload)把 File 原样当 body,
// Content-Type 是 video/mp4,而白名单里只有素材上传和导出两条,于是附件一个都传不上去,
// 界面只说「导入失败,点击重试」。跑法:node --test server/test/api-guard.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-api-guard-test-'));

const guardUrl = pathToFileURL(path.join(ROOT, 'server', 'http-guard.mjs')).href;
const src = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-api-guard.ts'), 'utf8')
  .split('from "./http-guard.mjs"').join(`from "${guardUrl}"`);
const js = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const file = path.join(OUT, 'api-guard.mjs');
fs.writeFileSync(file, js);
const { apiGuardPlugin } = await import(pathToFileURL(file).href);

/** 把中间件拿出来 */
function handlerOf() {
  let fn;
  apiGuardPlugin().configureServer({ middlewares: { use(f) { fn = f; } } });
  assert.ok(fn, '插件没有注册中间件');
  return fn;
}

/** 发一个请求:返回 'next'(放行)或拒绝时的状态码 */
function pass(fn, { method = 'POST', url, headers = {} }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: JSON.parse(String(body)) }); },
    };
    fn({ method, url, headers }, res, () => resolve('next'));
  });
}

const SAME = { origin: 'http://127.0.0.1:5190', host: '127.0.0.1:5190' };

test('对话附件上传是原始字节体,同源时必须放行(回归)', async () => {
  const fn = handlerOf();
  const r = await pass(fn, {
    url: '/api/chats/attach/upload?conversationId=c1&name=x.mp4',
    headers: { ...SAME, 'content-type': 'video/mp4' },
  });
  assert.equal(r, 'next', '附件上传的 Content-Type 由文件类型决定,不能按 JSON 要求');
});

test('素材上传、导出媒体、听写上传这几条原始体路由同样放行', async () => {
  const fn = handlerOf();
  // 听写那条是诊断报告里抓到的:transcribe_media 上传素材被 403,整个转写起不来
  for (const url of ['/api/media/upload/a.mp4', '/api/export/media/x', '/api/stt/upload/job1/a.mp4']) {
    const r = await pass(fn, { url, headers: { ...SAME, 'content-type': 'application/octet-stream' } });
    assert.equal(r, 'next', url);
  }
});

test('普通接口带非 JSON 的 body 要拒:这是挡 CSRF 简单请求的那一道', async () => {
  const fn = handlerOf();
  const r = await pass(fn, { url: '/api/ai/config', headers: { ...SAME, 'content-type': 'text/plain' } });
  assert.notEqual(r, 'next');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /application\/json/);
});

test('跨源请求哪怕是原始体路由也拒', async () => {
  const fn = handlerOf();
  const r = await pass(fn, {
    url: '/api/chats/attach/upload?conversationId=c1&name=x.mp4',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:5190', 'content-type': 'video/mp4' },
  });
  assert.notEqual(r, 'next');
  assert.equal(r.status, 403);
});

test('GET 和不带 body 的 POST 不受 Content-Type 那一道限制', async () => {
  const fn = handlerOf();
  assert.equal(await pass(fn, { method: 'GET', url: '/api/collect/status', headers: SAME }), 'next');
  assert.equal(await pass(fn, { url: '/api/shots/install', headers: SAME }), 'next');
});

test('不是 /api/ 的路径直接放行', async () => {
  const fn = handlerOf();
  assert.equal(await pass(fn, { url: '/@media/x.mp4', headers: { 'content-type': 'text/plain' } }), 'next');
});
