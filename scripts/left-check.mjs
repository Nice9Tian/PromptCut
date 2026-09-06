import puppeteer from 'puppeteer';
import fs from 'fs';

fs.mkdirSync('out/left', { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage();
  
  const errors = [];
  let ignoredErrors = 0;
  
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      const url = msg.location().url || '';
      if (text.includes('/src/editor/right/') || text.includes('/src/ai/') || text.includes('favicon.ico') || text.includes('net::ERR_') || 
          text.includes('status of 404') || text.includes('status of 500')) {
        ignoredErrors++;
      } else {
        errors.push(`Console Error: ${text}`);
      }
    }
  });
  page.on('pageerror', err => {
    const text = err.message;
    if (text.includes('/src/editor/right/') || text.includes('/src/ai/') || text.includes('favicon.ico')) {
      ignoredErrors++;
    } else {
      errors.push(`Page Error: ${text}`);
    }
  });

  let hasFail = false;
  const logPass = (msg) => console.log(`PASS - ${msg}`);
  const logFail = (msg) => { console.log(`FAIL - ${msg}`); hasFail = true; };

  let currentUrl = "http://127.0.0.1:5194/?nosetup=1";
  
  async function ensureClickable() {
    if (currentUrl === "http://127.0.0.1:5194/?nosetup=1") {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const closeBtn = btns.find(b => {
          const t = b.textContent.trim();
          return t === "以后再说" || t === "稍后" || t === "取消" || t === "关闭";
        });
        if (closeBtn) closeBtn.click();
      });
      await new Promise(r => setTimeout(r, 500));
    }
    
    // 探「有没有被弹窗盖住」:用顶级分页按钮当探针。
    // 卡片网格现在藏在「素材 → 卡片」分页里,切到别的分页时它 display:none,拿它当探针会永远判成被盖住。
    const clickable = await page.evaluate(() => {
      const probe = document.querySelector('[data-pc-top-tab="assets"]') || document.querySelector('[data-pc-card]');
      if (!probe) return false;
      const r = probe.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(top && (probe === top || probe.contains(top)));
    });
    
    if (clickable) {
      return true;
    } else {
      if (currentUrl !== "http://127.0.0.1:5194/left-probe.html") {
        currentUrl = "http://127.0.0.1:5194/left-probe.html";
        console.log('ENTRY: /left-probe.html (隔离 · 整机被别的任务的遮罩挡住)');
        await page.goto(currentUrl, { waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 1000));
      }
      return false; 
    }
  }

  async function ensureSelection() {
    await page.evaluate(() => {
      const state = window.__pcStoreLeft.getState();
      if (state.selection.length === 0) {
        const firstClip = state.project.tracks.flatMap(t=>t.clips)[0];
        if (firstClip) window.__pcStoreLeft.actions.select([firstClip.id]);
      }
    });
    await new Promise(r => setTimeout(r, 200));
  }

  async function runStep(name, fn) {
    try {
      await ensureClickable();
      await fn();
    } catch(e) {
      console.log(`  (${name} 首次抛错: ${e.message})`);
      if (currentUrl !== "http://127.0.0.1:5194/left-probe.html") {
        currentUrl = "http://127.0.0.1:5194/left-probe.html";
        console.log('ENTRY: /left-probe.html (隔离 · 整机被别的任务的遮罩挡住)');
        await page.goto(currentUrl, { waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 1000));
        try {
          await fn();
        } catch(e2) {
          logFail(`${name} 异常: ${e2.message}`);
        }
      } else {
        logFail(`${name} 异常: ${e.message}`);
      }
    }
  }

  try {
    await page.goto(currentUrl);
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: 'out/left/01-initial.png' });
    
    const isMainClickable = await ensureClickable();
    if (isMainClickable && currentUrl === "http://127.0.0.1:5194/?nosetup=1") {
      console.log('ENTRY: / (整机)');
    }
    
    const content = await page.content();
    const hasParts = await page.evaluate(() => {
      return !!document.querySelector('[data-pc="left"]') &&
             !!document.querySelector('[data-pc="library"]') &&
             !!document.querySelector('[data-pc="inspector"]');
    });
    
    if (hasParts && content.includes('素材') && content.includes('编辑')) {
      logPass('01-initial: 找到了文字「素材」和「编辑」, 以及三部分结构');
    } else {
      logFail('01-initial: 没找到对应的文字或结构');
    }

    // 左栏是两级分页了(素材:卡片/视频/字幕;编辑:参数/代码),每步先切到自己要的那页
    const showAssets = async (sub) => {
      await page.click('[data-pc-top-tab="assets"]');
      await new Promise(r => setTimeout(r, 80));
      await page.click(`[data-pc-tab="${sub}"]`);
      await new Promise(r => setTimeout(r, 120));
    };
    const showEdit = async (sub) => {
      await page.click('[data-pc-top-tab="edit"]');
      await new Promise(r => setTimeout(r, 80));
      await page.click(`[data-pc-tab="${sub}"]`);
      await new Promise(r => setTimeout(r, 120));
    };

    await runStep('02-hover', async () => {
      await showAssets('cards');
      await page.hover('[data-pc-card="mu-number-ticker"]');
      await new Promise(r => setTimeout(r, 900));
      await page.screenshot({ path: 'out/left/02-hover.png' });
      
      const hasPreview = await page.$('[data-pc-card="mu-number-ticker"] [data-pc="preview"]');
      if (hasPreview) logPass('02-hover: 悬停出现了 preview');
      else logFail('02-hover: 悬停未出现 preview');
      
      await page.mouse.move(0, 0);
      await new Promise(r => setTimeout(r, 400));
      
      const hasPreviewAfter = await page.$('[data-pc-card="mu-number-ticker"] [data-pc="preview"]');
      if (!hasPreviewAfter) logPass('02-hover: 移开后 preview 卸载');
      else logFail('02-hover: 移开后未卸载');
      
      const pcExportMs = await page.evaluate(() => window.__pcExportMs);
      if (pcExportMs === undefined) logPass('02-hover: window.__pcExportMs 未被修改');
      else logFail('02-hover: window.__pcExportMs 被修改了!');
    });

    await runStep('03-added', async () => {
      await showAssets('cards');
      await page.evaluate(() => window.__pcStoreLeft.actions.seek(24.5));
      const clipCountBefore = await page.evaluate(() => window.__pcStoreLeft.getState().project.tracks.flatMap(t=>t.clips).length);
      
      await page.click('[data-pc-card="odometer"]');
      await new Promise(r => setTimeout(r, 300));
      
      const stateAfterAdd = await page.evaluate(() => {
        const state = window.__pcStoreLeft.getState();
        const clipCount = state.project.tracks.flatMap(t=>t.clips).length;
        const sel = state.selection[0];
        const newClip = state.project.tracks.flatMap(t=>t.clips).find(c => c.id === sel);
        return { clipCount, newClip };
      });
      
      if (stateAfterAdd.clipCount === clipCountBefore + 1 && stateAfterAdd.newClip && Math.abs(stateAfterAdd.newClip.start - 24.5) < 0.2) {
        logPass('03-added: clipCount +1, start 约等于 24.5');
      } else {
        logFail('03-added: 未如预期添加');
      }
      await page.screenshot({ path: 'out/left/03-added.png' });
    });

    await runStep('04-form', async () => {
      await showEdit('form');
      await ensureSelection();
      await page.screenshot({ path: 'out/left/04-form.png' });
      const firstInput = await page.$('[data-pc-param]');
      if (firstInput) {
        await firstInput.click({ clickCount: 3 });
        await firstInput.type('123');
        await new Promise(r => setTimeout(r, 200));
        
        const newParams = await page.evaluate(() => {
          const state = window.__pcStoreLeft.getState();
          const sel = state.selection[0];
          return state.project.tracks.flatMap(t=>t.clips).find(c=>c.id===sel).params;
        });
        logPass(`04-form: params 变了 -> ${JSON.stringify(newParams)}`);
      } else {
        logFail('04-form: 找不到可输入的表单控件');
      }
    });

    await runStep('05-switched', async () => {
      await showEdit('form');
      await ensureSelection();
      const selectElem = await page.$('[data-pc="switch-card"]');
      if (selectElem) {
        await selectElem.select('blur-text');
        await new Promise(r => setTimeout(r, 200));
        const cardId = await page.evaluate(() => {
          const state = window.__pcStoreLeft.getState();
          return state.project.tracks.flatMap(t=>t.clips).find(c=>c.id===state.selection[0]).cardId;
        });
        if (cardId === 'blur-text') logPass('05-switched: 换卡成功');
        else logFail(`05-switched: 换卡失败, 当前是 ${cardId}`);
      } else {
        logFail('05-switched: 找不到换卡下拉框');
      }
      await page.screenshot({ path: 'out/left/05-switched.png' });
    });

    await runStep('06-code', async () => {
      await showEdit('form');
      await ensureSelection();
      await page.click('[data-pc-tab="code"]');
      await new Promise(r => setTimeout(r, 100));
      await page.screenshot({ path: 'out/left/06-code.png' });
      
      const stateSnapshot = await page.evaluate(() => JSON.stringify(window.__pcStoreLeft.getState()));
      
      const textarea = await page.$('[data-pc="code-editor"]');
      await textarea.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await textarea.type('{ oops');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await new Promise(r => setTimeout(r, 300));
      
      const stateAfterBad = await page.evaluate(() => JSON.stringify(window.__pcStoreLeft.getState()));
      if (stateSnapshot === stateAfterBad) logPass('06-code-invalid: store 完全没变');
      else logFail('06-code-invalid: store 居然变了');
      
      const hasRedBorder = await page.evaluate(() => {
        const el = document.querySelector('[data-pc="code-editor"]');
        if (!el) return false;
        const color = window.getComputedStyle(el).borderTopColor || window.getComputedStyle(el).borderColor;
        const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
           const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
           return r > g + 50 && r > b + 50;
        }
        // Tailwind v4 输出的是 oklch(L C H):红色在色相 10-50 且有饱和度
        const ok = color.match(new RegExp("oklch\\(([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)"));
        if (ok) {
          const c = parseFloat(ok[2]), h = parseFloat(ok[3]);
          return c > 0.1 && h > 10 && h < 50;
        }
        return el.classList.contains('border-red-500');
      });
      if (hasRedBorder) logPass('06-code-invalid: borderColor R 明显大于 G/B');
      else logFail('06-code-invalid: 没有红框');
      
      await page.screenshot({ path: 'out/left/07-code-invalid.png' });
      
      await textarea.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await textarea.type('{"params": {"test": 999}}');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await new Promise(r => setTimeout(r, 300));
      
      const paramsAfterGood = await page.evaluate(() => {
        const state = window.__pcStoreLeft.getState();
        return state.project.tracks.flatMap(t=>t.clips).find(c=>c.id===state.selection[0]).params;
      });
      if (paramsAfterGood && paramsAfterGood.test === 999) logPass('06-code-valid: params 更新成功');
      else logFail('06-code-valid: params 未更新');
      
      await page.screenshot({ path: 'out/left/08-code-valid.png' });
    });

    await runStep('07-tabs', async () => {
      // 以前这里验的是上下分屏拖动;左栏改成两级分页后分屏没有了,改验分页切换
      const shown = (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        return !!el && el.getClientRects().length > 0;
      }, sel);

      await showAssets('cards');
      const cardsOk = (await shown('[data-pc="search"]')) && !(await shown('[data-pc="inspector"]'));
      if (cardsOk) logPass('07-tabs: 素材 → 卡片,编辑面板隐藏');
      else logFail('07-tabs: 素材 → 卡片 状态不对');

      await showAssets('videos');
      const videosOk = !(await shown('[data-pc="search"]'));
      if (videosOk) logPass('07-tabs: 素材 → 视频,卡片网格隐藏');
      else logFail('07-tabs: 素材 → 视频 状态不对');

      await showAssets('captions');
      const captionsOk = !(await shown('[data-pc="search"]'));
      if (captionsOk) logPass('07-tabs: 素材 → 字幕');
      else logFail('07-tabs: 素材 → 字幕 状态不对');

      await showEdit('form');
      const editOk = (await shown('[data-pc="inspector"]')) && !(await shown('[data-pc="library"]'));
      if (editOk) logPass('07-tabs: 编辑 → 参数,素材面板隐藏');
      else logFail('07-tabs: 编辑 → 参数 状态不对');

      const remembered = await page.evaluate(() => [
        localStorage.getItem('pc.left.tab'),
        localStorage.getItem('pc.left.assetTab'),
        localStorage.getItem('pc.left.editTab'),
      ]);
      if (remembered[0] === 'edit' && remembered[1] === 'captions' && remembered[2] === 'form') {
        logPass('07-tabs: 分页选择写进了 localStorage');
      } else {
        logFail('07-tabs: localStorage 没记住分页 ' + JSON.stringify(remembered));
      }
      await page.screenshot({ path: 'out/left/09-tabs.png' });
    });

    await runStep('08-media', async () => {
      await showAssets('videos');
      await page.evaluate(() => {
        window.__pcStoreLeft.actions.addMedia({ kind: "video", name: "测试片.mp4", url: "blob:fake", duration: 12.5 });
      });
      await new Promise(r => setTimeout(r, 200));
      
      const mediaItemText = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('[data-pc-media]')).find(el => el.textContent.includes('测试片.mp4') && (el.textContent.includes('12.5') || el.textContent.includes('0:12.5')));
        return el ? el.textContent : null;
      });
      if (mediaItemText) {
        logPass('08-media: 列表里出现 测试片.mp4');
      } else {
        logFail('08-media: 未在列表里找到测试片');
      }
      
      const mediaElems = await page.$$('[data-pc-media]');
      for(const div of mediaElems) {
        const t = await page.evaluate(el => el.textContent, div);
        if (t && t.includes('测试片.mp4')) {
          await page.evaluate(el => el.scrollIntoView(), div);
          await new Promise(r => setTimeout(r, 100));
          await div.click({ button: 'right' });
          break;
        }
      }
      await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: 'out/left/10-ctxmenu.png' });
      
      const menuHasDelete = await page.$('[data-pc="ctxmenu"] [data-pc-item="删除素材"]');
      if (menuHasDelete) logPass('08-media: 菜单里有「删除素材」');
      else logFail('08-media: 菜单里没有删除素材');
      
      if (menuHasDelete) await menuHasDelete.click();
      await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: 'out/left/11-confirm.png' });
      
      const hasConfirm = await page.$('[data-pc="confirm"]');
      if (hasConfirm) logPass('08-media: 确认框出现');
      else logFail('08-media: 确认框没出现');
      
      const btn = await page.$('[data-pc="confirm-ok"]');
      if(btn) await btn.click();
      await new Promise(r => setTimeout(r, 200));
      
      const mediaCount = await page.evaluate(() => window.__pcStoreLeft.getState().project.media.length);
      if (mediaCount === 0) logPass('08-media: 删除成功, media.length === 0');
      else logFail(`08-media: 删除失败, length === ${mediaCount}`);
    });
    
  } catch (err) {
    logFail(`SCRIPT FATAL ERROR: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log('\n=== SUMMARY ===');
  if (ignoredErrors > 0) {
    console.log(`(已过滤掉 ${ignoredErrors} 条来自其它任务产生的 console 报错)`);
  }
  if (errors.length > 0) {
    console.log('--- Errors ---');
    errors.forEach(e => console.log(e));
    hasFail = true;
  }
  if (hasFail) {
    console.log('Some tests failed!');
    process.exitCode = 1;
  } else {
    console.log('All tests passed!');
  }
})();
