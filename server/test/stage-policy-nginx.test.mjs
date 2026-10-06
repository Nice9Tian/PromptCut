/**
 * nginx 模板里与「在线执行用户卡与图卡」的隔离有关的部分(契约 `docs/plan/online-card-exec-contract.md` 第 3.3、4.1 节):
 * 两个策略片段与 `src/online/stagePolicy.mjs` 同出一处;舞台源的每个 location 都带策略头;票据换 cookie 的两条路由;舞台入口 `stage.html`。
 * 跑:node --test server/test/stage-policy-nginx.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePolicySnippets, STAGE_HEADERS_SNIPPET_FILE, EDITOR_POLICY_SNIPPET_FILE } from '../hosted/stage-policy-nginx.mjs';
import { stageEntryHtml, STAGE_ENTRY_FILE } from '../stage-entry.mjs';
import { STAGE_CSP_META, STAGE_CONNECTION_ALLOWLIST, stageCspHeader, editorCspHeader, MEDIA_COOKIE, MEDIA_COOKIE_MAX_AGE_S, SID_PATTERN, MEDIA_S_PATH_PATTERN, TICKET_PATTERN, ASSET_API_PREFIX } from '../../src/online/stagePolicy.mjs';

const DEPLOY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hosted', 'deploy');
const read = (name) => fs.readFileSync(path.join(DEPLOY, name), 'utf8').replace(/\r\n/g, '\n');

/** 把一个 server 块里的 location 逐个切出来(模板里花括号只嵌到 if / limit_except 一层) */
function locations(conf) {
  const out = [];
  // 正则写的 location 用双引号包着(里面有花括号),引号里的不当块的开头
  const re = /\n\s*location\s+((?:[=~^*]+\s+)?(?:"[^"\n]*"|[^\s{"]+))\s*\{/g;
  let m;
  while ((m = re.exec(conf))) {
    let depth = 1, i = m.index + m[0].length;
    while (i < conf.length && depth > 0) { if (conf[i] === '{') depth++; else if (conf[i] === '}') depth--; i++; }
    out.push({ match: m[1].trim(), body: conf.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

test('OCS-N-01 仓库里的两个策略片段与 stagePolicy.mjs 生成的逐字相同(改策略后要重新运行 scripts/gen-stage-policy-nginx.mjs)', () => {
  const want = stagePolicySnippets();
  assert.deepEqual(Object.keys(want).sort(), [EDITOR_POLICY_SNIPPET_FILE, STAGE_HEADERS_SNIPPET_FILE].sort());
  for (const [name, text] of Object.entries(want)) assert.equal(read(name), text, name);
  const stage = read(STAGE_HEADERS_SNIPPET_FILE);
  assert.ok(stage.includes(`add_header Content-Security-Policy "${stageCspHeader('https://{{DOMAIN}}', { template: true })}" always;`));
  assert.ok(stage.includes(`add_header Connection-Allowlist "${STAGE_CONNECTION_ALLOWLIST}" always;`));
  assert.ok(stage.includes('add_header X-DNS-Prefetch-Control "off" always;'));
  assert.ok(stage.includes('add_header Origin-Agent-Cluster "?1" always;'));
  assert.ok(read(EDITOR_POLICY_SNIPPET_FILE).includes(`add_header Content-Security-Policy "${editorCspHeader(['https://s1.{{DOMAIN}}', 'https://s2.{{DOMAIN}}'], { template: true })}" always;`));
});

test('OCS-N-02 舞台源的 server 块:每个 location 都 include 策略片段(nginx 的 add_header 不跨层继承),没有漏掉的', () => {
  const conf = read('nginx-site-promptcut-stages.conf');
  const locs = locations(conf);
  assert.ok(locs.length >= 12, `切出 ${locs.length} 个 location`);
  for (const l of locs) assert.ok(l.body.includes('include snippets/promptcut-stage-headers.conf;'), `location ${l.match} 没带策略片段`);
  // 策略头只出自片段:模板里不再手写这几条
  assert.ok(!/add_header\s+(Content-Security-Policy|Connection-Allowlist|Origin-Agent-Cluster)\b/.test(conf));
  // 舞台入口、自检用的两个地址、兜底
  const of = (match) => locs.find((l) => l.match === match);
  assert.ok(of('= /editor/stage.html'), '有舞台入口的 location');
  assert.ok(/return 204;/.test(of('= /editor/_iso/ok').body));
  assert.ok(/return 302 \/editor\/_iso\/ok;/.test(of('= /editor/_iso/redirect').body));
  assert.ok(/return 404;/.test(of('/').body));
  // 舞台源不给文档服务
  assert.ok(!/location\s+\/hosted/.test(conf));
});

test('OCS-N-03 票据换 cookie 的两条路由与 stagePolicy.mjs 的判定同形', () => {
  const conf = read('nginx-site-promptcut-stages.conf');
  const locs = locations(conf);
  const grant = locs.find((l) => l.match.includes('/_grant$'));
  const mediaS = locs.find((l) => l.match.includes('pc_mpath'));
  assert.ok(grant && mediaS);
  // 形状:会话号、放行的路径、票据
  assert.ok(grant.match.includes(`(?<pc_sid>${SID_PATTERN})`));
  assert.ok(mediaS.match.includes(`(?<pc_sid>${SID_PATTERN})`) && mediaS.match.includes(`(?<pc_mpath>${MEDIA_S_PATH_PATTERN})`));
  assert.ok(conf.includes(`"~^Bearer (?<pc_gt>${TICKET_PATTERN})$" $pc_gt;`));
  // 交接:只认编辑器页的源(整串相等,不是正则)、只认 POST、票据形状不对 400;cookie 的属性
  assert.ok(conf.includes('map $http_origin $pc_grant_origin_ok {\n  default 0;\n  "https://{{DOMAIN}}" 1;\n}'));
  assert.ok(/if \(\$pc_grant_origin_ok = 0\) \{ return 403; \}/.test(grant.body));
  assert.ok(/if \(\$request_method != POST\) \{ return 405; \}/.test(grant.body));
  assert.ok(/if \(\$pc_grant_ticket = ""\) \{ return 400; \}/.test(grant.body));
  assert.ok(grant.body.includes('add_header Set-Cookie $pc_grant_cookie always;'));
  assert.ok(conf.includes(`"${MEDIA_COOKIE}=$pc_gt2; Path=/media-s/$pc_sid/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MEDIA_COOKIE_MAX_AGE_S}";`));
  assert.ok(grant.body.includes('add_header Access-Control-Allow-Origin "https://{{DOMAIN}}" always;') && grant.body.includes('add_header Access-Control-Allow-Credentials "true" always;'));
  assert.ok(!grant.body.includes('proxy_pass'), '交接请求不转给素材服务');
  // 读素材:只放行 GET / HEAD;cookie 换成 Authorization 头、不转发 cookie;转到素材服务的 API 基址下
  assert.ok(mediaS.body.includes('limit_except GET HEAD { deny all; }'));
  assert.ok(mediaS.body.includes(`proxy_pass http://{{BIND_ADDR}}:8788${ASSET_API_PREFIX}/$pc_mpath;`));
  assert.ok(mediaS.body.includes(`proxy_set_header Authorization "Bearer $cookie_${MEDIA_COOKIE}";`));
  assert.ok(mediaS.body.includes('proxy_set_header Cookie "";'));
  assert.ok(/if \(\$cookie_pc_rt = ""\) \{ return 401; \}/.test(mediaS.body));
  // 形状不对的 /media-s/ 路径不落进 /media 那条反代
  assert.ok(/return 404;/.test(locs.find((l) => l.match === '/media-s/').body));
  // 旧办法的 /media 路由保留(旧版页面、没隔离的舞台照旧带 ?t= 读)
  assert.ok(locs.some((l) => l.match === '/media'));
});

test('OCS-N-04 主站:/editor 的各个 location 多带 frame-src 片段,原有的头不动;别的 location 不带', () => {
  const conf = read('nginx-site-promptcut.conf');
  const locs = locations(conf);
  const editor = locs.filter((l) => /\/editor/.test(l.match));
  assert.ok(editor.length >= 4);
  for (const l of editor) {
    assert.ok(l.body.includes('include snippets/promptcut-editor-policy.conf;'), `location ${l.match}`);
    assert.ok(l.body.includes('add_header Origin-Agent-Cluster "?1" always;'), `location ${l.match} 原有的头还在`);
  }
  for (const l of locs.filter((x) => /^\/(hosted|media)/.test(x.match))) assert.ok(!l.body.includes('promptcut-editor-policy'), `location ${l.match}`);
  // 编辑器页只加 frame-src 一条,不上全套
  assert.ok(!/default-src|script-src|connect-src/.test(read(EDITOR_POLICY_SNIPPET_FILE).split('\n').filter((x) => x.startsWith('add_header')).join('\n')));
});

test('OCS-N-05 README 写明两个片段放哪、先改 nginx 再换页面、总开关怎么关', () => {
  const readme = read('README.md');
  for (const need of [STAGE_HEADERS_SNIPPET_FILE, EDITOR_POLICY_SNIPPET_FILE, '/etc/nginx/snippets/', '先改 nginx 再换页面', 'nginx -t', 'onlineCardExec', 'gen-stage-policy-nginx.mjs']) {
    assert.ok(readme.includes(need), `README 里没有「${need}」`);
  }
});

test('OCS-N-06 舞台入口 stage.html:index.html 加一条 <meta> 策略,别的一个字不变', () => {
  const index = '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <script type="module" crossorigin src="/editor/assets/index-abc.js"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n';
  const stage = stageEntryHtml(index);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STAGE_CSP_META}" />`;
  assert.ok(stage.includes(meta));
  assert.equal(stage.replace(`\n    ${meta}`, ''), index);
  // 策略排在别的东西之前(<head> 里第一个)
  assert.ok(stage.indexOf(meta) < stage.indexOf('<meta charset'));
  assert.ok(stage.indexOf(meta) < stage.indexOf('<script'));
  assert.equal(STAGE_ENTRY_FILE, 'stage.html');
  assert.throws(() => stageEntryHtml('<html><body></body></html>'), /没有 <head>/);
});
