/**
 * 在**真的 WebKit**（Playwright 装的那个，和 iOS 同一个引擎家族）里量一量缩略条的滚动区，
 * 把「占位 div」和「容器 padding」两种写法并排比。
 *
 *   node scripts/probes/strip-webkit-check.mjs
 *
 * 为什么要有它：这个病只在 WebKit 上犯 —— 用户 2026-10-24 在 iPhone 上滑不动，
 * 而本机无头 Chrome（Blink）怎么测都正常，白跑了两轮。2026-10-25 用户同意装
 * Playwright 的 WebKit 之后，这类「只在 iPhone 上犯」的毛病就能在本机复现，不用再来回问。
 *
 * 判定：占位 div 那版可滚 0、容器 padding 那版可滚 > 0，就是复现成功（退出码 0）。
 * 两版都能滚说明这个 WebKit 版本已经没有这个差异，会如实报出来、退出码 1 —— 那时别再拿它当证据。
 */
import { webkit } from 'playwright';

const W = 414; // 用户那台 iPhone 的 CSS 宽度
const CARD = 80, ADD = 46;

/** 两种写法：左右留白用占位 div / 用容器自己的 padding */
const PAGE = (mode) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .strip { display: flex; align-items: center; overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none; min-height: 80px; touch-action: pan-x;
    ${mode === 'padding' ? 'padding: 6px 50% 10px calc(50% - 46px);' : 'padding: 6px 0 10px;'} }
  .strip::-webkit-scrollbar { display: none; }
  .spl { flex: none; width: calc(50% - 46px); }
  .spr { flex: none; width: 50%; }
  .add { flex: none; width: 40px; height: 64px; margin-right: 6px; background: #333; }
  .blk { flex: none; width: 80px; height: 64px; background: #777; }
</style>
<div class="strip">${mode === 'padding' ? '' : '<div class="spl"></div>'}<div class="add"></div><div class="blk"></div>${mode === 'padding' ? '' : '<div class="spr"></div>'}</div>`;

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: W, height: 800 } });
const out = {};

for (const mode of ['spacer', 'padding']) {
  await page.setContent(PAGE(mode));
  await page.waitForTimeout(100);
  out[mode] = await page.evaluate(() => {
    const el = document.querySelector('.strip');
    const blk = document.querySelector('.blk');
    el.scrollLeft = 40;
    return {
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      range: el.scrollWidth - el.clientWidth,
      setTo40ReadBack: Math.round(el.scrollLeft),
      blockOffsetLeft: blk.offsetLeft,
    };
  });
}
await browser.close();

console.log(JSON.stringify({ engine: 'webkit', viewport: W, ...out }, null, 1));

const reproduced = out.spacer.range === 0 && out.padding.range > 0;
console.log(reproduced
  ? `\n==> 复现成功：占位 div 可滚 ${out.spacer.range}、容器 padding 可滚 ${out.padding.range}。`
    + `\n    和用户 2026-10-25 在 iPhone 上量到的一致（0 / 126）。`
  : `\n==> 没复现：占位 ${out.spacer.range}、padding ${out.padding.range}。`
    + `\n    这个 WebKit 版本看不出差异，别再拿本机读数当这条的证据。`);
process.exit(reproduced ? 0 : 1);
