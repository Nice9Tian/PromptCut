/*
 * Probe: 导出页里一个 fill="url(#id)" 的 SVG 形状,序列化出来到底是相对形式还是带页面 URL 的绝对形式?
 *
 * 为什么要问:A2(7) 的消费侧改名(src/render/snapshotRename.ts)照抄了 export-frames.mjs:215 的正则
 *   (url\((?:&quot;|["'])?[^)"'&]*#)<id>((?:&quot;|["'])?\))
 * 那条 `[^)"'&]*` 把 `&` 排除在外。而导出页地址本身含 `&`(server/frame-pipeline.mjs:183 的
 * '/?export=1&timeline='),`outerHTML` 会把 `&` 序列化成 `&amp;`。只要 Chrome 在冻结时把 fill
 * 写成绝对 URL,这条正则就一条都匹配不上 —— 共享快照挂到多个片段上时渐变会串台。
 *
 * 跑法:node scripts/probes/svg-url-serialize-probe.mjs
 * (自己起 vite 5208;用户的编辑台在 5190 / 验证在 5197,别碰。)
 *
 * 启动参数抄 scripts/headless.mjs:204-216 那一套(headless:true + swiftshader),
 * 不用 export-frames.mjs 的 CHROME_ARGS:那边的 --enable-begin-frame-control 要靠 CDP
 * 手动发 BeginFrame 才出帧,页面里的 rAF 会挂住。fill 的序列化形式和出帧管线无关。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const PORT = 5208;
const ROOT = path.resolve(import.meta.dirname, '..', '..');

// docs/compare-pitfalls.md #8:dev server 会把端口写进全局的 %TEMP%\promptcut\port.json,
// MCP 客户端会照它去连。实验服务器把 TEMP 指到临时目录,别覆盖用户真实软件的那份。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-svg-probe-'));

const timeline = {
  width: 1920, height: 1080, fps: 30, duration: 2,
  clips: [{ id: 'probe-clip', cardId: 'growth-curve', start: 0, end: 2, params: {} }],
};
const timelineUrl = 'data:application/json,' + encodeURIComponent(JSON.stringify(timeline));
// 和 frame-pipeline.mjs:183 同一个形状:页面地址里有一个真正的 `&`
const pageUrl = `http://127.0.0.1:${PORT}/?export=1&timeline=${encodeURIComponent(timelineUrl)}`;

const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, env: { ...process.env, TEMP: tmp, TMP: tmp }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let viteLog = '';
vite.stdout.on('data', (d) => { viteLog += d; });
vite.stderr.on('data', (d) => { viteLog += d; });

const waitHttp = async (url, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error('vite 没起来:\n' + viteLog);
    await new Promise((r) => setTimeout(r, 300));
  }
};

let browser;
try {
  await waitHttp(`http://127.0.0.1:${PORT}/`, 90000);

  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 120000,
    args: ['--window-position=-32000,-32000', '--hide-scrollbars', '--no-first-run',
      '--disable-gpu', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('pageerror', (e) => console.log('[页面错误]', e.message));
  await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__pcReady === true', { timeout: 60000 });
  await page.waitForFunction(
    () => !![...document.querySelectorAll('[fill^="url("], [style*="url(#"]')].length, { timeout: 30000 });

  const out = await page.evaluate(() => {
    const el = document.querySelector('path[fill^="url("], rect[fill^="url("]');
    if (!el) return { error: '没找到 fill="url(#…)" 的形状' };
    const cs = getComputedStyle(el);
    const before = el.outerHTML;

    // 冻结过程的写法,照 export-frames.mjs:176-180:把全部计算样式内联成 style 属性
    const clone = el.cloneNode(true);
    let s = '';
    for (let k = 0; k < cs.length; k++) { const q = cs.item(k); s += q + ':' + cs.getPropertyValue(q) + ';'; }
    clone.setAttribute('style', s);
    const frozen = clone.outerHTML;
    // 前面要带 `;` 或 `"`,否则 column-fill:balance 会先撞上;
    // 值里可能是 url(&quot;…&quot;),`&quot;` 自带分号,所以 url(…) 要整段吃掉,不能用 [^;]*
    const mFrozen = /[;"]fill:\s*(?:url\([^)]*\)|[^;]*)/.exec(frozen);

    // 单独跑一遍 el.style.fill = getComputedStyle(el).fill(任务书点名的那一条)
    const probe = el.cloneNode(true);
    probe.style.fill = cs.fill;
    const inlineOnly = probe.outerHTML;

    // 整个 control 子树按 __bfFreeze 的写法冻一遍,把里面出现的全部 url(…) / href="#…" 形式列出来。
    // 只看一个 <path> 容易漏掉别处(mask / filter / clip-path)可能有的绝对形式。
    const host = el.closest('[data-pc-clip]') ?? el.closest('svg') ?? el.parentElement;
    const subtree = host.cloneNode(true);
    const origAll = [host, ...host.querySelectorAll('*')];
    const copyAll = [subtree, ...subtree.querySelectorAll('*')];
    for (let i = 0; i < origAll.length; i++) {
      const c2 = getComputedStyle(origAll[i]);
      let t = '';
      for (let k = 0; k < c2.length; k++) { const q = c2.item(k); t += q + ':' + c2.getPropertyValue(q) + ';'; }
      copyAll[i].setAttribute('style', t);
    }
    const frozenHtml = subtree.outerHTML;
    const urlForms = [...new Set((frozenHtml.match(/url\((?:&quot;|["'])?[^)]*?#[^)]*?\)/g) || []))];
    const hrefForms = [...new Set((frozenHtml.match(/(?:xlink:)?href="#[^"]*"/g) || []))];
    const idForms = [...new Set((frozenHtml.match(/\sid="[^"]*"/g) || []))];

    // 顺带验一条消费侧改名(src/render/snapshotRename.ts)的前提:它在浏览器里走 DOMParser 收 id、
    // 在 Node 单测里走正则扫描收 id,两条路径必须对同一份字符串给出同一个集合。下面两段是
    // snapshotRename.ts 里 collectIdsByParse / collectIdsByScan 的镜像(改那边记得同步这里)。
    const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
    const doc = new DOMParser().parseFromString(frozenHtml, 'text/html');
    const byParse = [...doc.querySelectorAll('[id]')].map((e) => escapeAttr(e.getAttribute('id'))).sort();
    const byScan = [];
    const idRe = /\sid=(["'])([^"']*)\1/g;
    for (let m = idRe.exec(frozenHtml); m; m = idRe.exec(frozenHtml)) if (m[2]) byScan.push(m[2]);
    byScan.sort();

    return {
      idsByParse: byParse,
      idsByScan: [...new Set(byScan)].sort(),
      idsAgree: JSON.stringify([...new Set(byParse)]) === JSON.stringify([...new Set(byScan)]),
      pageUrl: location.href,
      frozenLen: frozenHtml.length,
      urlForms, hrefForms, idForms,
      frozenHasAmp: frozenHtml.includes('&amp;'),
      attrFill: el.getAttribute('fill'),
      computedFill: cs.fill,
      cssTextFill: /(?:^|;)fill:[^;]*/.exec(s)?.[0]?.replace(/^;/, '') ?? null,
      outerHTMLBefore: before.slice(0, 400),
      frozenFillInOuterHTML: mFrozen ? mFrozen[0].slice(0, 400) : null,
      inlineOnlyOuterHTML: inlineOnly.slice(0, 400),
      gradientIds: [...document.querySelectorAll('linearGradient[id], radialGradient[id]')].map((g) => g.id),
    };
  });

  if (out.error) throw new Error('探针没测到东西:' + out.error);

  const j = (k, v) => console.log(k.padEnd(24) + ' ' + v);
  console.log('──── 观测 ────');
  j('page url', out.pageUrl);
  j('gradient ids', JSON.stringify(out.gradientIds));
  j('getAttribute("fill")', JSON.stringify(out.attrFill));
  j('computed .fill', JSON.stringify(out.computedFill));
  j('cssText 里的 fill', JSON.stringify(out.cssTextFill));
  console.log('outerHTML(原样):\n  ' + out.outerHTMLBefore);
  console.log('冻结后 outerHTML 里的 fill:\n  ' + out.frozenFillInOuterHTML);
  console.log('el.style.fill=computed 后的 outerHTML:\n  ' + out.inlineOnlyOuterHTML);
  console.log(`整棵 control 冻结后(${out.frozenLen} 字节)出现过的形式:`);
  j('  url(…#…)', JSON.stringify(out.urlForms));
  j('  href="#…"', JSON.stringify(out.hrefForms));
  j('  id="…"', JSON.stringify(out.idForms));
  j('  含 &amp;', String(out.frozenHasAmp));
  j('DOMParser 收 id', JSON.stringify(out.idsByParse));
  j('正则扫描收 id', JSON.stringify(out.idsByScan));
  j('两条路径一致', String(out.idsAgree));

  const absolute = /^url\(["']?https?:/.test(String(out.computedFill))
    || out.urlForms.some((u) => /^url\((?:&quot;|["'])?https?:/.test(u));
  const hasAmp = String(out.frozenFillInOuterHTML ?? '').includes('&amp;')
    || out.urlForms.some((u) => u.includes('&amp;'));
  console.log('\n──── 结论 ────');
  console.log(absolute
    ? '计算样式是【绝对形式】url("<页面 URL>#id");属性值仍是相对形式 url(#id)。'
    : '计算样式是【相对形式】url(#id)。');
  console.log(hasAmp
    ? '冻结后的 outerHTML 里含 &amp;(页面 URL 的 & 被序列化),export-frames.mjs:215 的 [^)"\'&]* 会漏。'
    : '冻结后的 outerHTML 里不含 &amp;。');
  console.log(absolute || hasAmp
    ? '→ 改名正则必须放开到 [^)"\']*,并把绝对前缀整段丢掉,改写成 url(#新id),快照才与 host 无关。'
    : '→ [^)"\'&]* 就够用;snapshotRename.ts 仍放开成 [^)"\']* 并丢掉 `#` 前的前缀,属于防御。');
  console.log(out.idsAgree
    ? '收 id 的两条路径(浏览器 DOMParser / Node 正则扫描)在这份真快照上一致。'
    : '⚠ 收 id 的两条路径结果不一致,snapshotRename.ts 的 Node 单测钉不住浏览器行为。');
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => process.exit(0), 1500).unref();
}
