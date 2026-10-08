/**
 * 已定卡片策略的真实浏览器验收：外链 image/font/style/script 正常；无 Allowlist/Trusted Types 仍执行。
 * 实际调用 harden/isolationCheck/execGate 和 hosted-render/vite-gate，不以手写结论替代自检。
 * 正反向检查 SOP、header/meta、父页开关、票据闸、管理 API 和素材 cookie 路径。
 * node scripts/probes/card-policy-probe.mjs --base-port 5900 [--out <TMP>] [--font <公开字体>]
 * 仅启用四个回环端口；字体从已安装的公开系统字体读取，不打包、不安装依赖。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { stageSecurityHeaders, STAGE_CSP_META, editorCspHeader } from '../../src/online/stagePolicy.mjs';
import { installHostedGate } from '../../server/hosted-render/vite-gate.mjs';
import { checkSyncedSource, normalizeBrowserCssImports } from '../../server/hosted-render/source-gate.mjs';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const arg = (k, d) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d;
const BASE = Number(arg('--base-port', 5900));
const OUT = arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-card-policy-')));
fs.mkdirSync(OUT, { recursive: true });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EDITOR = `http://pc.localhost:${BASE}`;
const STAGE = `http://s1.pc.localhost:${BASE + 1}`;
const EXTERNAL = `http://127.0.0.1:${BASE + 2}`;
const CLOUD = `http://127.0.0.1:${BASE + 3}`;
const cssSource = [
  `@import "${EXTERNAL}/import-1.css";`,
  `@import url("${EXTERNAL}/import-2.css") screen;`,
  `@import "${EXTERNAL}/import-3.css" layer(probe);`,
  `@import url("${EXTERNAL}/import-4.css") supports(display: grid) screen;`,
  `@import "//127.0.0.1:${BASE + 2}/import-5.css" layer(relative);`,
  `@import url(//127.0.0.1:${BASE + 2}/import-6.css) screen;`,
].join('\n');
const cssVerdict = checkSyncedSource('src/cards/user/card-policy-imports.css', cssSource);
if (!cssVerdict.ok) throw new Error(JSON.stringify(cssVerdict));
const cssId = path.join(ROOT, 'src/cards/user/card-policy-imports.css').replaceAll('\\', '/');
const cssBuilder = await createServer({ configFile: false, root: ROOT, cacheDir: path.join(OUT, 'vite-cache'), server: { middlewareMode: true, hmr: false }, plugins: [
  { name: 'card-policy-public-css-fixture', enforce: 'pre', resolveId(id) { if (id.split('?')[0].endsWith('card-policy-imports.css')) return cssId + (id.includes('?') ? '?' + id.split('?')[1] : ''); }, load(id) { if (id.split('?')[0] === cssId) return normalizeBrowserCssImports(cssSource); } },
  tailwindcss({ optimize: false }),
] });
let compiledImports;
try { compiledImports = (await cssBuilder.transformRequest('/src/cards/user/card-policy-imports.css?direct')).code; } finally { await cssBuilder.close(); }
const fontPath = [arg('--font', ''), 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((p) => p && fs.existsSync(p));
if (!fontPath) throw new Error('需要一份已安装的公开字体；用 --font 指定，不安装依赖');
const font = fs.readFileSync(fontPath);
const png = new PNG({ width: 4, height: 4 });
for (let i = 0; i < 16; i++) png.data.set([10, 200, 30, 255], i * 4);
const image = PNG.sync.write(png);
const modules = {};
for (const p of ['src/online/stagePolicy.mjs', 'src/online/isolation/harden.ts', 'src/online/isolation/isolationCheck.ts', 'src/online/isolation/execGate.ts', 'src/online/cardRuntime/loader.ts']) {
  modules[`/${p}`] = ts.transpileModule(fs.readFileSync(path.join(ROOT, p), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowJs: true } }).outputText;
}
const loader = `const sources=${JSON.stringify(modules)}, cache={}; function load(id){if(cache[id])return cache[id].exports; const m={exports:{}};cache[id]=m; const req=(name)=>load(new URL(name,'http://fixture'+id).pathname);new Function('require','exports','module',sources[id])(req,m.exports,m);return m.exports;}`;
const boot = `${loader}
window.runFixture=async function(){
  // 在脚本执行前仿不提供 Trusted Types 的浏览器；真实 CSP 没有 TT 强制指令。
  try{Object.defineProperty(window,'trustedTypes',{value:undefined,configurable:true});}catch{}
  const H=load('/src/online/isolation/harden.ts'), I=load('/src/online/isolation/isolationCheck.ts'), G=load('/src/online/isolation/execGate.ts');
  const rtcBefore=typeof RTCPeerConnection;const harden=H.installStageHardening({win:window,onBreach:()=>G.noteBreach()});
  G.markIsolatedStageDocument(); const report=await I.runIsolationCheck({win:window,base:'/',harden,timeoutMs:1000});G.setIsolationReport(report);
  window.fixture={report,harden,rtcBefore,rtcAfter:typeof RTCPeerConnection,modules:false};
  addEventListener('message',e=>{if(e.origin!==${JSON.stringify(EDITOR)}||e.source!==parent||e.data?.kind!=='fixture-allow'||e.data.nonce!=='policy-nonce')return;G.noteMediaPolicy({cardExec:true});window.fixture.handshake=true;window.fixture.gate=G.cardExecGate();});
  parent.postMessage({kind:'fixture-ready',nonce:'policy-nonce'},${JSON.stringify(EDITOR)});
  await new Promise(r=>setTimeout(r,100)); window.fixture.gate=G.cardExecGate();
  if(G.cardVisualExecAllowed()){
    window.fixture.modules=true; const E=${JSON.stringify(EXTERNAL)};
    const img=new Image();img.id='external-image';img.src=E+'/image.png';document.body.append(img);await img.decode();
    const css=document.createElement('link');css.rel='stylesheet';css.href=E+'/style.css';const cssReady=new Promise((r,j)=>{css.onload=r;css.onerror=j});document.head.append(css);await cssReady;
    const script=document.createElement('script');script.src=E+'/script.js';const scriptReady=new Promise((r,j)=>{script.onload=r;script.onerror=j});document.head.append(script);await scriptReady;
    const face=new FontFace('PolicyFixture','url('+E+'/font.ttf)');document.fonts.add(await face.load());
    const imports=document.createElement('link');imports.rel='stylesheet';imports.href='/imports.css';const importsReady=new Promise((r,j)=>{imports.onload=r;imports.onerror=j});document.head.append(imports);await importsReady;
    window.fixture.cssImports=Array.from({length:6},(_,i)=>getComputedStyle(document.documentElement).getPropertyValue('--import-'+(i+1)).trim());
    imports.remove();
    const L=load('/src/online/cardRuntime/loader.ts');let pendingStyles=[];
    const cardLoader=L.createCardLoader({runtime:'fixture',host:{packages:{},builtin:()=>null},onStyles:(entry,files)=>{
      for(const old of document.head.querySelectorAll('style[data-fixture-card-style]'))old.remove();pendingStyles=[];
      for(const css of files){const style=document.createElement('style');style.setAttribute('data-fixture-card-style',entry);if(css.includes('@import'))pendingStyles.push(new Promise((r,j)=>{style.onload=r;style.onerror=j}));style.textContent=css;document.head.append(style)}
    }});
    const cardBundle={runtime:'fixture',entry:'public.tsx',generation:'1',modules:[{key:'public.tsx',imports:{},js:'exports.probe={id:"public",name:"public",defaults:{},controls:[],Component:()=>null};'}],styles:[{key:'first.css',css:':root{--first-file:loaded}'},{key:'later.css',css:${JSON.stringify(compiledImports)}}],tailwind:':root{--last-tailwind:loaded}'};
    const loaded=await cardLoader.setBundles([cardBundle]);await Promise.all(pendingStyles);
    window.fixture.loaderStyles={loaded:loaded[0]?.ok,imports:Array.from({length:6},(_,i)=>getComputedStyle(document.documentElement).getPropertyValue('--import-'+(i+1)).trim()),count:document.head.querySelectorAll('style[data-fixture-card-style]').length,first:getComputedStyle(document.documentElement).getPropertyValue('--first-file').trim(),last:getComputedStyle(document.documentElement).getPropertyValue('--last-tailwind').trim()};
    await cardLoader.setBundles([{...cardBundle,generation:'bad',runtime:'wrong'}]);window.fixture.loaderStyles.failedClear=document.head.querySelectorAll('style[data-fixture-card-style]').length===0;
    await cardLoader.setBundles([cardBundle]);await Promise.all(pendingStyles);await cardLoader.setBundles([]);window.fixture.loaderStyles.unloadClear=document.head.querySelectorAll('style[data-fixture-card-style]').length===0;
    await cardLoader.setBundles([cardBundle]);await Promise.all(pendingStyles);cardLoader.clear();window.fixture.loaderStyles.clear=document.head.querySelectorAll('style[data-fixture-card-style]').length===0;
    const parsed=document.createElement('div');parsed.innerHTML='<style>.policy-parsed{color:rgb(7,8,9)}</style><p class="policy-parsed">正常HTML与外链</p><img src="'+E+'/image.png">';document.body.append(parsed);await parsed.querySelector('img').decode();
    window.fixture.normalHtml=getComputedStyle(parsed.querySelector('p')).color==='rgb(7, 8, 9)';
    window.fixture.resources={image:img.naturalWidth===4,style:getComputedStyle(document.body).backgroundColor==='rgb(20, 30, 40)',script:window.externalScript==='loaded',font:face.status==='loaded'};
    let parentRead='';try{parentRead=parent.document.title;}catch(e){parentRead=e.name;}
    let localRead='';try{localRead=parent.localStorage.getItem('credential');}catch(e){localRead=e.name;}
    window.fixture.boundaries={parentRead,localRead,cookie:document.cookie,editorAccount:await fetch(${JSON.stringify(EDITOR + '/account')},{credentials:'include'}).then(r=>r.text()).catch(e=>e.name),ownMedia:await fetch('/media-s/projectA/media/image').then(r=>r.status),otherMedia:await fetch('/media-s/projectB/media/image').then(r=>r.status),ownCloudApi:await fetch(${JSON.stringify(CLOUD + '/api/vision/frame')}).then(r=>r.status).catch(e=>e.name)};
    window.fixture.structure={};for(const [name,fn] of Object.entries({innerHTML:()=>{document.createElement('div').innerHTML='<iframe></iframe>'},insertAdjacentHTML:()=>document.body.insertAdjacentHTML('beforeend','<object></object>'),range:()=>document.createRange().createContextualFragment('<iframe></iframe>'),template:()=>{document.createElement('template').innerHTML='<iframe></iframe>'},shadow:()=>{const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<iframe></iframe>'}})){try{fn();window.fixture.structure[name]='accepted'}catch(e){window.fixture.structure[name]=e.name}}
  }
  window.fixture.done=true;
};runFixture().catch(e=>{window.fixture={...window.fixture,error:String(e.stack),done:true}});`;
const requests = [];
const servers = [];
const reply = (res, code, type, body, headers = {}) => { res.writeHead(code, { 'content-type': type.startsWith('text/') ? type+'; charset=utf-8' : type, 'cache-control': 'no-store', ...headers });res.end(body); };
async function serve(port, handler) { const server = http.createServer(handler); servers.push(server);await new Promise((resolve, reject) => { server.once('error', reject);server.listen(port, '127.0.0.1', resolve); });return server; }
const frameHtml = `<meta http-equiv="Content-Security-Policy" content="${STAGE_CSP_META}"><body><h1>外链卡片策略</h1><script src="/boot.js"></script>`;
const parentHtml = (mode) => `<title>编辑器凭证边界</title><body><script>localStorage.setItem('credential','fixture-editor-secret');window.__ticket='fixture-editor-ticket';addEventListener('message',e=>{if(e.origin===${JSON.stringify(STAGE)}&&e.source===document.querySelector('iframe').contentWindow&&e.data?.kind==='fixture-ready'&&e.data.nonce==='policy-nonce')e.source.postMessage({kind:'fixture-allow',nonce:'policy-nonce'},e.origin)});</script><iframe sandbox="allow-scripts allow-same-origin" width="640" height="320" src="${mode === 'same' ? EDITOR : STAGE}/stage?mode=${mode}"></iframe>`;
let gateMiddleware;
const cloudServer = http.createServer((req, res) => gateMiddleware(req, res, () => reply(res, 200, 'application/json', '{"ok":true}', { 'access-control-allow-origin': STAGE })));
servers.push(cloudServer);
await installHostedGate({ middlewares: { use: (fn) => { gateMiddleware = fn; } }, httpServer: cloudServer }, { prerender: true, env: { PROMPTCUT_RENDER_BROKER: 'fixture', PROMPTCUT_RENDER_BROKER_KEY: 'fixture-manager-only-key' }, write: () => {} });
await new Promise((resolve, reject) => { cloudServer.once('error', reject);cloudServer.listen(BASE + 3, '127.0.0.1', resolve); });
await serve(BASE, (req, res) => {
  if (req.url === '/account') return reply(res, 403, 'text/plain', 'denied');
  if (req.url.startsWith('/stage')) return reply(res, 200, 'text/html', frameHtml, stageSecurityHeaders(EDITOR));
  if (req.url === '/boot.js') return reply(res, 200, 'application/javascript', boot);
  if (req.url === '/imports.css') return reply(res, 200, 'text/css', compiledImports);
  return reply(res, 200, 'text/html', parentHtml(new URL(req.url, EDITOR).searchParams.get('mode') || 'full'), { 'content-security-policy': editorCspHeader([STAGE]), 'set-cookie': 'fixtureAccount=editor-secret; HttpOnly; Path=/; SameSite=Strict' });
});
await serve(BASE + 1, (req, res) => {
  if (req.url.startsWith('/stage')) { const mode = new URL(req.url, STAGE).searchParams.get('mode');return reply(res, 200, 'text/html', frameHtml, { ...(mode === 'meta' ? {} : stageSecurityHeaders(EDITOR)), 'set-cookie': 'pc_rt=fixture-project-A; HttpOnly; Path=/media-s/projectA/; SameSite=Strict' }); }
  if (req.url === '/boot.js') return reply(res, 200, 'application/javascript', boot);
  if (req.url === '/imports.css') return reply(res, 200, 'text/css', compiledImports);
  if (req.url.startsWith('/media-s/')) return reply(res, req.url.startsWith('/media-s/projectA/') && req.headers.cookie?.includes('pc_rt=fixture-project-A') ? 200 : 401, 'image/png', image);
  return reply(res, 404, 'text/plain', 'missing');
});
await serve(BASE + 2, (req, res) => {
  requests.push(req.url);
  const headers = { 'access-control-allow-origin': '*' };
  if (req.url === '/image.png') return reply(res, 200, 'image/png', image, headers);
  if (req.url === '/style.css') return reply(res, 200, 'text/css', 'body{background:rgb(20,30,40);color:white}', headers);
  if (/^\/import-[1-6]\.css$/.test(req.url)) return reply(res, 200, 'text/css', `:root{--import-${req.url.match(/[1-6]/)[0]}:loaded}`, headers);
  if (req.url === '/script.js') return reply(res, 200, 'application/javascript', 'window.externalScript="loaded";', headers);
  if (req.url === '/font.ttf') return reply(res, 200, 'font/ttf', font, headers);
  return reply(res, 404, 'text/plain', 'missing', headers);
});
const browser = await puppeteer.launch({ headless: !process.argv.includes('--headful'), pipe: true, args: [...PROBE_CHROME_ARGS, '--no-sandbox'] });
const browserVersion = await browser.version();
const checks = [], results = {};
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail });console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
try {
  const page = await browser.newPage();
  for (const mode of ['full', 'meta', 'same']) {
    await page.goto(`${EDITOR}/?mode=${mode}`, { waitUntil: 'domcontentloaded' });
    const frame = page.frames().find((f) => f !== page.mainFrame());
    await frame.waitForFunction(() => window.fixture?.done, { timeout: 15_000 });
    const result = await frame.evaluate(() => window.fixture);results[mode] = result;
    if (mode === 'full') {
      check('真实 header/base-uri 自检与跨源握手通过，无 Allowlist/TT 仍可执行', result.report?.ok && result.report.csp === 'header' && result.report.egress === 'none' && result.handshake && result.modules, result);
      for (const kind of ['image', 'font', 'style', 'script']) check(`外链 ${kind} 实际载入`, result.resources?.[kind]);
      check('真实 Vite/Tailwind 编译后的六种远端 CSS @import 在浏览器加载', result.cssImports?.length === 6 && result.cssImports.every(value => value === 'loaded'), result.cssImports);
      check('真实 createCardLoader 多CSS中的后续外链导入加载，文件与Tailwind顺序保留', result.loaderStyles?.loaded && result.loaderStyles.count===3 && result.loaderStyles.first==='loaded' && result.loaderStyles.last==='loaded' && result.loaderStyles.imports.every(value=>value==='loaded'), result.loaderStyles);
      check('真实 createCardLoader 换代失败/卸载/clear 清空全部CSS标签', result.loaderStyles?.failedClear && result.loaderStyles.unloadClear && result.loaderStyles.clear, result.loaderStyles);
      check('WebRTC 构造器保留', result.rtcBefore === result.rtcAfter, { before: result.rtcBefore, after: result.rtcAfter });
      check('无TT的HTML解析保护允许正常样式与外链图片', result.normalHtml);
      check('innerHTML/insertAdjacentHTML/Range/template/shadow结构入口拒绝子框架', Object.values(result.structure ?? {}).length === 5 && Object.values(result.structure).every(v => v === 'TypeError'), result.structure);
      check('编辑器 DOM/localStorage 读取被 SOP 拒绝', result.boundaries?.parentRead === 'SecurityError' && result.boundaries.localRead === 'SecurityError');
      check('账号与素材票据没有交给卡片，另项目素材拒绝', result.boundaries?.cookie === '' && result.boundaries.ownMedia === 200 && result.boundaries.otherMedia === 401 && !JSON.stringify(result).includes('editor-secret'));
      await page.screenshot({ path: path.join(OUT, 'external-resources.png') });
    } else check(`${mode} 缺少 ${mode === 'meta' ? 'header' : '跨源'} 时真实自检拒绝执行`, result.report?.ok === false && result.gate?.allowed === false && !result.modules, result.report);
  }
  const cloud = await browser.newPage();await cloud.goto(`${CLOUD}/`, { waitUntil: 'domcontentloaded' });
  const structure = await cloud.evaluate(async external => {
    const seen=[];addEventListener('securitypolicyviolation',event=>seen.push(event.effectiveDirective));
    const frame=document.createElement('iframe');frame.src=external+'/cloud-frame';document.body.append(frame);
    const object=document.createElement('object');object.data=external+'/cloud-object';document.body.append(object);
    const base=document.createElement('base');base.href=external+'/cloud-base/';document.head.append(base);
    await new Promise(resolve=>setTimeout(resolve,200));
    return {seen,baseURI:document.baseURI,href:location.href};
  }, EXTERNAL);
  check('经典云预渲页 CSP 拒绝 frame/object/base，未恢复资源出口限制', ['frame-src','object-src','base-uri'].every(d=>structure.seen.includes(d)) && structure.baseURI===structure.href && !requests.some(p=>p.startsWith('/cloud-')), structure);
  const denied = await cloud.evaluate(() => fetch('/api/vision/frame').then(r => r.status));
  check('真实 hosted Vite 页面闸拒绝管理 API', denied === 403, denied);
  const withoutKey = await fetch(`${CLOUD}/api/vision/frame`).then(r => r.status);
  check('Node 管理调用无口令也拒绝', withoutKey === 403, withoutKey);
  const withKey = await fetch(`${CLOUD}/api/vision/frame`, { headers: { 'x-pc-look-key': 'fixture-manager-only-key' } }).then(r => r.status);
  check('正确管理口令的 Node 调用通过', withKey === 200, withKey);
  check('资源站四类请求均真实到达', ['/image.png', '/font.ttf', '/style.css', '/script.js'].every(p => requests.includes(p)), requests);
} finally { await browser.close();for (const server of servers) { server.closeAllConnections?.();await new Promise(r => server.close(r)); } }
const out = { ok: checks.every(c => c.ok), browser: 'Chrome for Testing', browserVersion, untested: ['Firefox', 'Safari'], checks, results, out: OUT, obsolete: ['卡片外发为零', 'Connection-Allowlist/Trusted Types/WebRTC 为执行前提'] };
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));process.exitCode = out.ok ? 0 : 1;
