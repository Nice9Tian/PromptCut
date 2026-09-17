/**
 * 编辑台冒烟(第 3 步 E0 / D3 页面侧):真的打开编辑台(?editor),经 store 加两张卡、seek,
 * 看 Preview 是否只经 RPC 把项目和时间送到了舞台 iframe、命中测试和选中描边是否照常工作。
 *
 *   node scripts/probes/editor-preview-smoke.mjs [--origin http://127.0.0.1:5197]
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const origin = (args.includes('--origin') ? args[args.indexOf('--origin') + 1] : null) || process.env.PC_STAGE_TEST_URL || 'http://127.0.0.1:5197';
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
const out = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + '/?editor', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 120000 });
  // 舞台握手 → stageBridge 里登记了 front 客户端
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage();
  }, { timeout: 120000, polling: 500 });

  await page.evaluate(() => { window.__smokeMarker = 1; });
  const ids = await page.evaluate(async () => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.newProject('smoke'); // 编辑台可能带着上次的草稿进来,先换成空项目
    const a = actions.addCardClip('odometer', 0, { duration: 10 });
    const b = actions.addCardClip('punch-pill', 0, { duration: 10, params: { text: '冒烟' } });
    actions.seek(1.5);
    return { odo: a?.id, pill: b?.id, tracks: getState().project.tracks.map((t) => t.clips.length) };
  });
  out.ids = ids;
  check(ids.odo && ids.pill, 'clips added', ids);
  await sleep(1500);

  const stageState = await page.evaluate(async () => {
    const { frontStage, pushedProject } = await import('/src/editor/stageBridge.ts');
    const { getState } = await import('/src/store/project.ts');
    const f = document.querySelector('iframe[data-pc="stage-frame"]');
    const doc = f.contentDocument;
    const wraps = [...doc.querySelectorAll('[data-pc-clip]')].map((el) => ({ id: el.getAttribute('data-pc-clip'), frame: el.getAttribute('data-pc-local-frame') }));
    const synced = pushedProject('front') === getState().project;
    const size = await frontStage().size();
    return { wraps, synced, size, t: getState().t };
  });
  out.stage = stageState;
  check(stageState.wraps.length === 2 && stageState.wraps.every((w) => w.frame === '45'), 'stage shows both clips at local frame 45 (t=1.5s @30fps)', stageState);
  check(stageState.synced, 'stageBridge baseline equals the store project after sync', stageState.synced);

  // 描边:选中 odometer 后描边应贴着内容(比整幅小)
  const sel = await page.evaluate(async (odo) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.select([odo]);
    await new Promise((r) => setTimeout(r, 400));
    // 再拨一次时间让 refreshRects 走一遍
    actions.seek(1.6);
    await new Promise((r) => setTimeout(r, 600));
    const hit = document.querySelector('.pc-pv-hit');
    const frame = document.querySelector('.pc-pv-frame');
    const r = hit?.getBoundingClientRect(); const fr = frame?.getBoundingClientRect();
    return { selection: getState().selection, hit: r ? { w: r.width, h: r.height } : null, frame: fr ? { w: fr.width, h: fr.height } : null };
  }, ids.odo);
  out.sel = sel;
  check(sel.hit && sel.frame && sel.hit.w < sel.frame.w * 0.9 && sel.hit.h < sel.frame.h * 0.9, 'selection outline hugs the odometer content (smaller than the frame)', sel);

  // 点击:在 odometer 内容中心点一下,选中的应是它(命中经 RPC 往返)
  const click = await page.evaluate(async (odo) => {
    const { frontStage } = await import('/src/editor/stageBridge.ts');
    const { actions } = await import('/src/store/project.ts');
    actions.select([]);
    const list = await frontStage().rectsWithBounds({ pixels: 'all' });
    const b = list.find((x) => x.clipId === odo)?.bounds;
    // 内容框的正中可能落在两位数字之间的空隙上(透明处穿透),在框内扫一个小网格找一个真能命中它的点
    let px = null;
    for (let iy = 1; iy < 6 && !px; iy++) for (let ix = 1; ix < 12 && !px; ix++) {
      const x = b.left + (b.width * ix) / 12, y = b.top + (b.height * iy) / 6;
      const h = await frontStage().hitTest(x, y);
      if (h && h.clipId === odo) px = { x, y };
    }
    const frame = document.querySelector('.pc-pv-frame').getBoundingClientRect();
    const scale = frame.width / 1920;
    if (!px) return null;
    const pt = { x: frame.left + px.x * scale, y: frame.top + px.y * scale };
    // 选中之后编辑台会在预览上方弹出建议卡(.ais-card)之类的浮层,点在它上面就不是点预览;先按 Escape 收掉,再确认最上层是预览覆盖层
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const top = document.elementFromPoint(pt.x, pt.y);
    return { ...pt, top: top ? top.tagName + '.' + top.className : null, inPreview: !!top?.closest('.pc-pv-frame') };
  }, ids.odo);
  check(!!click, 'found a solid point inside the odometer content box');
  check(click && click.inPreview, 'the click point is on the preview overlay (no floating panel over it)', click);
  if (click) await page.mouse.click(click.x, click.y);
  await sleep(1200);
  const after = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    return getState().selection;
  });
  out.clickSelection = after;
  check(after.length === 1 && after[0] === ids.odo, 'clicking the odometer content selects it via async hitTest', after);

  // 点空白:取消选中
  const blank = await page.evaluate(() => { const fr = document.querySelector('.pc-pv-frame').getBoundingClientRect(); return { x: fr.left + 20, y: fr.top + 20 }; });
  await page.mouse.click(blank.x, blank.y);
  await sleep(400);
  out.blankSelection = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().selection);
  check(out.blankSelection.length === 0, 'clicking blank deselects', out.blankSelection);

  // 播放 1 秒:store 的 t 前进,舞台跟着(过渡期父页每帧发 setTime)
  const play = await page.evaluate(async () => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.seek(0.5); actions.play();
    await new Promise((r) => setTimeout(r, 1000));
    actions.pause();
    const t = getState().t;
    const f = document.querySelector('iframe[data-pc="stage-frame"]');
    const frames = [...f.contentDocument.querySelectorAll('[data-pc-clip]')].map((el) => Number(el.getAttribute('data-pc-local-frame')));
    return { t, frames };
  });
  out.play = play;
  check(play.t > 1.0 && play.frames.every((n) => Math.abs(n - Math.round(play.t * 30)) <= 1), 'after 1s of playback the stage local frame follows store.t', play);

  // 其它 agent 改文件会让 vite 整页重载,那样的一轮结果不可信:标记丢了就报出来
  out.reloaded = await page.evaluate(() => window.__smokeMarker !== 1);
  check(!out.reloaded, 'page was not reloaded by HMR during the run (rerun when the tree is quiet)');
  out.errors = errors.filter((e) => !/favicon|Download the React DevTools|Failed to load resource/i.test(e));
  check(out.errors.length === 0, 'no page errors', out.errors.slice(0, 5));
} catch (err) {
  fails.push('exception: ' + (err && err.stack || err));
} finally {
  await browser.close();
}
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
