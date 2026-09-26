/**
 * C6.5 页面一侧的验收探针(c65-editor 分支):真浏览器里点一遍同步、撤销、离线、本地备份、共享项目,并截图。
 *
 * 用法:
 *   node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5510 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots [--phases local,shared]
 *   node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5513 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots --phases lan
 *
 * - `--origin`:本分支的编辑器(`?editor` 页面);`--hosted`:本机起的托管组合(`server/hosted/main.mjs`),
 *   代替阿里云,绝不连真正的托管端;`lan` 阶段要求编辑器以 `PROMPTCUT_LAN_HOST=1` 启动。
 * - 阶段:
 *   local  V2 真实页面版(两页交错编辑,两页与文档服务三份摘要相同)、部分没撤 / 全部没撤提示条、别人改动描边、
 *          离线对话框(丢弃 / 重放)、被覆盖的备份与气泡、本地备份列表、AI 栏「撤销这一步」(注入事件)
 *   shared 新建共享项目(托管)、打开共享项目、成员列表(重名、Agent 展开)、创建者操作(验证、改密码、踢人、禁入列表、删项目)、
 *          被踢的阻断弹窗、密码被改气泡、局域网模式要重启的提示
 *   lan    局域网模式新建 + 同名托管项目 → 打开对话框里并列两个候选
 * 结果:每项一行 JSON(`{ check, ok, ... }`),最后一行 `{ summary }`;有失败退出码 1。截图写进 `--out`。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildAuthProtocols } from '../../server/auth/client.mjs';
import { createSharedProject } from '../../server/auth/route.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const origin = arg('--origin', 'http://127.0.0.1:5510');
const hosted = arg('--hosted', 'http://127.0.0.1:5518');
const outDir = path.resolve(arg('--out', 'out/c65-editor-shots'));
const phases = arg('--phases', 'local,shared').split(',');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10_000, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时`);
    await sleep(100);
  }
}

const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
});

async function shot(page, name) {
  await page.bringToFront();
  await sleep(150);
  await closeAiSetup(page);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ shot: file }));
  return file;
}

/** 开一个编辑器页面,等同步接上;顺手关掉首次打开的「选择 AI 助手」对话框 */
async function openEditor(query = '') {
  if (process.env.PROBE_TRACE) console.error('[step] open', query);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(JSON.stringify({ pageerror: String(e?.message ?? e).slice(0, 300) })));
  // 原生弹框会卡住页面里的 evaluate:记下来并关掉
  page.on('dialog', (d) => { console.log(JSON.stringify({ dialog: d.type(), message: d.message().slice(0, 300) })); void d.dismiss(); });
  // 后台页面里 page.click / page.type 要等滚动与可见性,会一直挂着:点、打字之前先把它放到前面
  for (const m of ['click', 'type']) {
    const orig = page[m].bind(page);
    page[m] = async (...a) => { await page.bringToFront(); return orig(...a); };
  }
  await page.goto(`${origin}/?editor${query}`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 30_000, '页面同步接上');
  await sleep(800);
  await closeAiSetup(page);
  return page;
}

async function closeAiSetup(page) {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click();
  });
  await sleep(200);
}

const P = (page, fn, ...args) => {
  if (process.env.PROBE_TRACE) console.error('[eval]', page.url().slice(-40), String(fn).slice(0, 80).replace(/s+/g, ' '));
  return page.evaluate(fn, ...args);
};

/** 页面里当前项目的摘要 */
const pageDigest = (page) => P(page, async () => {
  const S = await import('/src/store/project.ts');
  const json = JSON.stringify(S.getState().project);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return { sha256: [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''), rev: window.__pcSyncTest.rev(), status: window.__pcSyncTest.view().status };
});

/** 文档服务里的真身(本机 local 空间):一条回环连接 project.open */
function docState(projectId, base = origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/docservice`, ['promptcut.v1']);
    const parts = [];
    const done = (project, rev) => {
      const json = JSON.stringify(project);
      resolve({ rev, sha256: createHash('sha256').update(json).digest('hex'), project });
      ws.close();
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'project.open', projectId })));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.state' && m.project) done(m.project, m.rev);
      else if (m.type === 'project.state.part') parts[m.index] = m.data;
      else if (m.type === 'project.state.end') done(JSON.parse(parts.join('')), m.rev);
    });
    ws.addEventListener('error', () => reject(new Error('连不上文档服务')));
    setTimeout(() => reject(new Error('project.open 超时')), 8000);
  });
}

const clipIds = (page) => P(page, async () => {
  const S = await import('/src/store/project.ts');
  return S.getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id));
});
const clipOf = (page, id) => P(page, async (id) => {
  const S = await import('/src/store/project.ts');
  return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
}, id);
const setParam = (page, id, params) => P(page, async (id, params) => {
  const S = await import('/src/store/project.ts');
  S.actions.setClipParams(id, params);
}, id, params);
/** 一次提交里改两个片段的参数(撤销时是一步) */
const setTwo = (page, a, b, text) => P(page, async (a, b, text) => {
  const S = await import('/src/store/project.ts');
  S.actions.editCardProject((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === a || c.id === b ? { ...c, params: { ...c.params, text } } : c)) })) }));
}, a, b, text);
async function pressUndo(page, redo = false) {
  await P(page, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.down('Control');
  if (redo) await page.keyboard.down('Shift');
  await page.keyboard.press('KeyZ');
  if (redo) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}
const settle = async (...pages) => {
  for (const p of pages) {
    await waitFor(() => P(p, () => window.__pcSyncTest.view().status === 'online'), 15_000, '回到 online').catch(async (e) => {
      throw new Error(`${e.message}:${JSON.stringify(await P(p, () => ({ status: window.__pcSyncTest.view().status, url: location.search })))}`);
    });
  }
  await sleep(600);
};
/** 按文字点按钮(在 selector 范围里) */
async function clickText(page, text, scope = 'body') {
  if (process.env.PROBE_TRACE) console.error('[step] click', text);
  const ok = await P(page, (text, scope) => {
    const root = document.querySelector(scope) ?? document.body;
    const el = [...root.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim().includes(text) && !b.disabled);
    if (!el) return false;
    el.click();
    return true;
  }, text, scope);
  if (!ok) throw new Error(`找不到按钮「${text}」`);
  await sleep(250);
}
async function typeInto(page, selector, text) {
  if (process.env.PROBE_TRACE) console.error('[step] type', selector);
  await page.click(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, text);
}
async function openProjectMenu(page) {
  for (let i = 0; i < 3; i++) {
    await closeAiSetup(page);
    await page.click('.pc-proj-btn');
    await sleep(300);
    if (await P(page, () => !!document.querySelector('.pc-proj-menu'))) return;
  }
  throw new Error('项目菜单没打开');
}

/* ======================================================================== local */

async function phaseLocal() {
  const A = await openEditor();
  const docId = await P(A, () => window.__pcSyncTest.docProjectId());
  const B = await openEditor(`&join=${encodeURIComponent(docId)}`);
  check('join-page-gets-docservice-content', (await pageDigest(A)).sha256 === (await pageDigest(B)).sha256, { docId });

  // ---------- V2 真实页面版:两页交错各 100 次(拖动 / 改参数)
  const run = (page, seed, n) => P(page, async (seed, n) => {
    const S = await import('/src/store/project.ts');
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    let edits = 0;
    for (let i = 0; i < n; i++) {
      const clips = S.getState().project.tracks.flatMap((t) => t.clips);
      const c = clips[Math.floor(rnd() * clips.length)];
      if (rnd() < 0.5) {
        const dt = (rnd() - 0.5) * 0.6;
        S.actions.moveClip(c.id, { start: Math.max(0, c.start + dt), end: Math.max(0.1, c.end + dt) });
      } else S.actions.setClipParams(c.id, { v2: `s${seed}-${i}` });
      edits++;
      await new Promise((r) => setTimeout(r, 3 + Math.floor(rnd() * 25)));
    }
    return edits;
  }, seed, n);
  const [ea, eb] = await Promise.all([run(A, 101, 100), run(B, 202, 100)]);
  await settle(A, B);
  const [da, db, ds] = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('V2-page-real', da.sha256 === db.sha256 && db.sha256 === ds.sha256 && da.rev === ds.rev && db.rev === ds.rev, { edits: [ea, eb], a: da, b: db, doc: { rev: ds.rev, sha256: ds.sha256 } });
  await shot(A, 'v2-page-a');
  await shot(B, 'v2-page-b');

  const ids = await clipIds(A);
  const [c1, c2, c3, c4, c5, c6, c7, c8] = ids;

  // ---------- 撤销:部分没撤(A 一步改片段 1、2;B 随后改片段 2;A 撤销)
  await setTwo(A, c1, c2, 'A改');
  await settle(A, B);
  const beforeC1 = (await docState(docId)).project.tracks.flatMap((t) => t.clips).find((c) => c.id === c1);
  await setParam(B, c2, { text: 'B改' });
  await settle(A, B);
  await pressUndo(A);
  await sleep(500);
  const notice = await P(A, () => document.querySelector('[data-pc=undo-notice]')?.innerText ?? null);
  const a1 = await clipOf(A, c1);
  const a2 = await clipOf(A, c2);
  check('undo-partial-notice', !!notice && notice.includes('撤销了，但这几处被后续的新修改覆盖，未做退回：') && a2.params.text === 'B改' && a1.params.text !== 'A改', { notice, c1: a1.params.text, c2: a2.params.text, c1WasBefore: beforeC1?.params?.text });
  await shot(A, 'undo-partial-notice');
  // 点实体名跳过去并选中
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-entity')?.click());
  await sleep(300);
  const sel = await P(A, async () => (await import('/src/store/project.ts')).getState().selection);
  check('undo-notice-jump-selects', sel[0] === c2, { selection: sel });
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-bar-close')?.click());

  // ---------- 撤销:全部没撤
  await settle(A, B);
  await setParam(A, c3, { text: 'A3' });
  await settle(A, B);
  await setParam(B, c3, { text: 'B3' });
  await settle(A, B);
  await pressUndo(A);
  await sleep(500);
  const none = await P(A, () => document.querySelector('[data-pc=undo-notice]')?.innerText ?? null);
  check('undo-none-notice', !!none && none.includes('没撤成。这几处后来都被改过了，保留了现在的样子：') && none.includes('查看被修改处的现状'), { notice: none, c3: (await clipOf(A, c3)).params.text });
  await shot(A, 'undo-none-notice');
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-bar-close')?.click());

  // ---------- 按钮禁用态与悬停提示
  const btn = await P(A, () => ({
    undoTitle: document.querySelector('[data-pc=undo-btn]')?.getAttribute('title'),
    redoTitle: document.querySelector('[data-pc=redo-btn]')?.getAttribute('title'),
    undoDisabled: document.querySelector('[data-pc=undo-btn] button')?.disabled,
    redoDisabled: document.querySelector('[data-pc=redo-btn] button')?.disabled,
  }));
  check('undo-buttons', btn.undoTitle === '撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的' && btn.redoTitle === '重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）', btn);
  const fresh = await openEditor(`&join=${encodeURIComponent(docId)}`);
  const freshBtn = await P(fresh, () => ({ undo: document.querySelector('[data-pc=undo-btn] button')?.disabled, redo: document.querySelector('[data-pc=redo-btn] button')?.disabled }));
  check('undo-buttons-disabled-when-empty', freshBtn.undo === true && freshBtn.redo === true, freshBtn);
  await fresh.close();

  // Ctrl+Y 重做
  await setParam(A, c4, { text: 'A4' });
  await settle(A, B);
  await pressUndo(A);
  await settle(A, B);
  const afterUndo = (await clipOf(A, c4)).params.text;
  await P(A, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await A.keyboard.down('Control');
  await A.keyboard.press('KeyY');
  await A.keyboard.up('Control');
  await settle(A, B);
  check('ctrl-y-redo', afterUndo !== 'A4' && (await clipOf(A, c4)).params.text === 'A4', { afterUndo });

  // ---------- 别人的改动:时间轴描边 1.5 s
  await A.bringToFront();
  await setParam(B, c4, { text: 'B 改了这里' });
  await sleep(300);
  const flashed = await P(A, (id) => !!document.querySelector(`[data-clip-id="${id}"][data-remote-flash]`), c4);
  await A.screenshot({ path: path.join(outDir, 'remote-flash.png') });
  await sleep(1700);
  const gone = await P(A, (id) => !document.querySelector(`[data-clip-id="${id}"][data-remote-flash]`), c4);
  check('remote-flash-1.5s', flashed && gone, { flashed, goneAfter: gone });

  // ---------- 被覆盖:A 改了片段 6,B 随后改同一片段 → A 先存本地备份,出气泡
  await setParam(A, c6, { text: 'A6' });
  await settle(A, B);
  await setParam(B, c6, { text: 'B6' });
  await settle(A, B);
  const toast = await waitFor(() => P(A, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('覆盖')) ?? null), 5000, '覆盖气泡').catch(() => null);
  check('overwritten-toast', !!toast && toast.startsWith('你的近期修改已被 你在另一个页面 覆盖。'), { toast });
  await shot(A, 'overwritten-toast');

  // ---------- 离线:A 断网期间改 3 次,B 期间也改;A 回来 → 第一条被拒 → 离线对话框
  const offline = async (value, choice) => {
    await P(A, () => window.__pcSyncTest.drop(4000));
    await waitFor(() => P(A, () => window.__pcSyncTest.view().status === 'offline'), 5000, 'A 离线');
    for (let i = 0; i < 3; i++) await setParam(A, c5, { text: `${value}${i}` });
    await setParam(B, c7, { text: `B7-${value}` });
    await setParam(B, c5, { text: `B5-${value}` });
    await sleep(300);
    const chip = await P(A, () => document.querySelector('[data-pc=sync-offline]')?.innerText ?? null);
    await waitFor(() => P(A, () => window.__pcSyncTest.view().status === 'paused'), 15_000, 'A 暂停');
    await sleep(300);
    const dlg = await P(A, () => document.querySelector('[data-pc=offline-dialog]')?.innerText ?? null);
    return { chip, dlg };
  };
  const off1 = await offline('离线', 'discard');
  check('offline-dialog', !!off1.dlg && off1.dlg.includes('断网期间项目有新改动') && off1.dlg.includes('你有 3 步断网期间的修改') && off1.chip === '离线', off1);
  await shot(A, 'offline-dialog');
  await P(A, () => document.querySelector('[data-pc=offline-dialog] .pc-dialog-x')?.click());
  await sleep(300);
  const pausedChip = await P(A, () => document.querySelector('[data-pc=sync-paused]')?.innerText ?? null);
  check('paused-chip-after-close', pausedChip === '同步已暂停', { pausedChip });
  await shot(A, 'sync-paused-chip');
  await P(A, () => document.querySelector('[data-pc=sync-paused]')?.click());
  await sleep(300);
  check('paused-chip-reopens-dialog', await P(A, () => !!document.querySelector('[data-pc=offline-dialog]')));
  await clickText(A, '不要了，用现在的最新版本', '[data-pc=offline-dialog]');
  await settle(A, B);
  const afterDiscard = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('offline-discard', afterDiscard[0].sha256 === afterDiscard[2].sha256 && afterDiscard[1].sha256 === afterDiscard[2].sha256 && (await clipOf(A, c5)).params.text === 'B5-离线', { c5: (await clipOf(A, c5)).params.text });

  const off2 = await offline('重放', 'replay');
  check('offline-dialog-2', !!off2.dlg);
  await clickText(A, '加进去（可能会盖掉他们刚改的地方）', '[data-pc=offline-dialog]');
  await settle(A, B);
  const afterReplay = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('offline-replay', afterReplay[0].sha256 === afterReplay[2].sha256 && afterReplay[1].sha256 === afterReplay[2].sha256 && (await clipOf(A, c5)).params.text === '重放2' && (await clipOf(A, c7)).params.text === 'B7-重放', { c5: (await clipOf(A, c5)).params.text, c7: (await clipOf(A, c7)).params.text });

  // ---------- 本地备份列表(丢弃前的那批 + 被覆盖的那一版);恢复 = 一次新写入
  await openProjectMenu(A);
  await clickText(A, '本地备份…', '.pc-proj-menu');
  await waitFor(() => P(A, () => document.querySelectorAll('[data-pc=backup-row]').length > 0), 5000, '备份列表');
  const rows = await P(A, () => [...document.querySelectorAll('[data-pc=backup-row]')].map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('backups-list', rows.some((r) => r.includes('离线时丢弃')) && rows.some((r) => r.includes('覆盖')), { rows: rows.slice(0, 6) });
  await shot(A, 'backups-dialog');
  // 恢复被覆盖的那一版(片段 6 回到 A6)
  const revBefore = (await docState(docId)).rev;
  await P(A, (c6) => {
    const row = [...document.querySelectorAll('[data-pc=backup-row]')].find((r) => r.dataset.entity?.endsWith(`/@${c6}`) && r.innerText.includes('被 你在另一个页面 覆盖'));
    row?.querySelector('button')?.click();
  }, c6);
  await settle(A, B);
  const d6 = await docState(docId);
  check('backup-restore-is-new-write', d6.project.tracks.flatMap((t) => t.clips).find((c) => c.id === c6)?.params.text === 'A6' && d6.rev > revBefore && (await clipOf(B, c6)).params.text === 'A6', { revBefore, revAfter: d6.rev });
  await clickText(A, '关闭', '[data-pc=backups-dialog]');

  // ---------- AI 栏「撤销这一步」:Agent 的提交(一条回环连接模拟) + 注入带 opId 的完成事件
  const agentOp = (ops) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/docservice`, ['promptcut.v1']);
    const opId = `agent-op-${Date.now()}`;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'project.open', projectId: docId }));
      ws.send(JSON.stringify({ type: 'project.op', projectId: docId, opId, session: 'agent-conv-1', ops }));
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.op.ok' && m.opId === opId) { resolve({ opId, rev: m.rev }); ws.close(); }
      if (m.type === 'project.op.rejected' && m.opId === opId) { reject(new Error(JSON.stringify(m))); ws.close(); }
    });
  });
  const path8 = (await docState(docId)).project.tracks.map((t, ti) => ({ t, ti })).find(({ t }) => t.clips.some((c) => c.id === c8));
  const before8 = (await clipOf(A, c8)).params.text ?? null;
  const { opId: agentOpId, rev: agentRev } = await agentOp([{ op: 'set', path: `/tracks/@${path8.t.id}/clips/@${c8}/params/text`, value: 'Agent 改的' }]);
  await settle(A, B);
  await P(A, (opId, rev) => window.__pcSyncTest.inject({ type: 'events.event', phase: 'complete', eventId: 'ev-probe-1', callId: 'call-probe-1', opId, rev, status: 'ok' }), agentOpId, agentRev);
  const reverted = await P(A, async () => {
    const m = await import('/src/editor/sync/syncManager.ts');
    const rec = m.agentOpFor('call-probe-1');
    const r = rec ? m.revertAgentOp(rec) : null;
    return { found: !!rec, done: r?.done ?? null, state: m.agentOpFor('call-probe-1')?.state ?? null };
  });
  await settle(A, B);
  const d8 = await docState(docId);
  const log8 = d8.project.tracks.flatMap((t) => t.clips).find((c) => c.id === c8).params.text ?? null;
  const canUndo = await P(A, async () => (await import('/src/store/project.ts')).actions.canUndo());
  check('agent-undo-step', reverted.found && reverted.done && reverted.state === 'done' && log8 === before8 && canUndo, { reverted, before8, now: log8 });
  // 进了用户自己的撤销栈:Ctrl+Z 把 Agent 的改动恢复回来
  await pressUndo(A);
  await settle(A, B);
  check('agent-undo-in-user-stack', (await clipOf(B, c8)).params.text === 'Agent 改的');

  await B.close();
  return { A, docId };
}

/* ======================================================================== shared */

async function setHosted(page) {
  await P(page, (u) => localStorage.setItem('pc.shared.hostedUrl', u), hosted);
}

async function phaseShared() {
  const A = await openEditor();
  const B = await openEditor();
  await setHosted(A);
  await setHosted(B);
  const name = `c65-demo-${Date.now().toString(36)}`;

  // ---------- 新建共享项目:先看限定进入的名单表,再以自由进入建成
  await openProjectMenu(A);
  await clickText(A, '新建共享项目', '.pc-proj-menu');
  await typeInto(A, '#pc-ns-name', name);
  await typeInto(A, '#pc-ns-creator', 'alice');
  await typeInto(A, '#pc-ns-cpw', 'alice-pw');
  await clickText(A, '限定进入', '[data-pc=new-shared-dialog]');
  await A.type('[data-pc=list-editor] .pc-sync-list-row:last-child input:nth-child(1)', 'render-host');
  await A.type('[data-pc=list-editor] .pc-sync-list-row:last-child input:nth-child(2)', 'rh-pw');
  await clickText(A, '添加', '[data-pc=list-editor]');
  await P(A, () => document.querySelector('[data-pc=new-shared-dialog]')?.scrollTo(0, 9999));
  await shot(A, 'new-shared-restricted');
  await clickText(A, '局域网模式', '[data-pc=new-shared-dialog]');
  await sleep(200);
  const lanHint = await P(A, () => document.querySelector('[data-pc=lan-restart-hint]')?.innerText ?? null);
  check('lan-needs-restart-hint', !!lanHint && lanHint.includes('PROMPTCUT_LAN_HOST=1'), { lanHint });
  await shot(A, 'new-shared-lan-restart');
  await clickText(A, '互联网模式', '[data-pc=new-shared-dialog]');
  await clickText(A, '自由进入', '[data-pc=new-shared-dialog]');
  await typeInto(A, '#pc-ns-ppw', 'team-pw');
  await P(A, () => document.querySelector('[data-pc=new-shared-dialog]')?.scrollTo(0, 0));
  await shot(A, 'new-shared-dialog');
  await clickText(A, '创建', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(A, () => document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText.includes('创建成功') ? document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line').innerText : null), 20_000, '创建成功').catch(() => null);
  const aView = await P(A, () => { const v = window.__pcSyncTest.view(); return { kind: v.kind, shared: v.shared, status: v.status }; });
  check('new-shared-hosted', created === '创建成功，已进入项目。' && aView.kind === 'shared', { created, aView });
  await shot(A, 'new-shared-done');
  await clickText(A, '返回', '[data-pc=new-shared-dialog]');
  const sharedId = aView.shared?.projectId;

  // ---------- 打开共享项目(B):查找 → 验证 → 进入
  await openProjectMenu(B);
  await clickText(B, '打开共享项目', '.pc-proj-menu');
  await B.type('#pc-os-name', name);
  await clickText(B, '托管地址', '[data-pc=open-shared-dialog]');
  await shot(B, 'open-shared-find');
  await clickText(B, '查找', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  await waitFor(() => P(B, () => !!document.querySelector('#pc-os-user')), 15_000, '进入验证步');
  await shot(B, 'open-shared-verify');
  await typeInto(B, '#pc-os-pw', 'wrong-pw');
  await typeInto(B, '#pc-os-user', 'bob');
  await clickText(B, '进入', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  const wrong = await waitFor(() => P(B, () => document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText ?? null), 15_000, '密码错提示').catch(() => null);
  check('open-shared-wrong-password', wrong === '用户名或密码不对。忘了的话找创建者问一下。', { wrong });
  await typeInto(B, '#pc-os-pw', 'team-pw');
  await clickText(B, '进入', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  await waitFor(() => P(B, () => window.__pcSyncTest.view().kind === 'shared'), 15_000, 'B 进入共享项目').catch(async (e) => {
    throw new Error(`${e.message}:${JSON.stringify(await P(B, () => ({ line: document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText, pw: document.querySelector('#pc-os-pw')?.value, user: document.querySelector('#pc-os-user')?.value })))}`);
  });
  await settle(A, B);
  check('open-shared-enter', (await pageDigest(A)).sha256 === (await pageDigest(B)).sha256, { a: await pageDigest(A), b: await pageDigest(B) });

  // ---------- 成员列表:同名不同设备、Agent 对话
  const device = await P(B, () => window.__pcSyncTest.view().device);
  const wsBase = hosted.replace(/^http/, 'ws');
  const extra = [];
  const conn = async (o) => {
    const protocols = await buildAuthProtocols({ base: hosted, projectId: sharedId, deviceName: o.deviceName ?? device.deviceName, ...o });
    const ws = new WebSocket(wsBase, protocols);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    extra.push(ws);
    return ws;
  };
  await conn({ username: 'bob', deviceId: device.deviceId, password: 'team-pw', role: 'agent', conversation: 2 });
  await conn({ username: 'bob', deviceId: 'pc-macbook-probe-0001', deviceName: 'MacBook', password: 'team-pw', role: 'page' });
  await sleep(800);
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.includes('Agent'));
    row?.click();
  });
  await sleep(200);
  const pop = await P(A, () => document.querySelector('[data-pc=members-pop]')?.innerText ?? '');
  check('members-list', pop.includes('alice (自己)') && pop.includes('[创建者]') && pop.includes('[编辑中]') && pop.includes('[Agent ×1]') && pop.includes('bob (MacBook)') && pop.includes('bob · Agent · 第 2 个对话') && pop.includes('项目管理（仅创建者可见）'), { pop });
  await shot(A, 'members-list');
  const btnText = await P(A, () => document.querySelector('[data-pc=members-button]')?.innerText ?? '');
  check('members-button-badge', /成员: \d+ 人/.test(btnText), { btnText });

  // ---------- 创建者操作:改项目密码(验证 → 改),成员收到气泡
  await clickText(A, '改项目密码', '[data-pc=members-pop]');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, '验证弹窗');
  await typeInto(A, '#pc-cv-pw', 'wrong');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  const verr = await waitFor(() => P(A, () => document.querySelector('[data-pc=creator-verify] .pc-sync-err')?.innerText ?? null), 8000, '密码错误').catch(() => null);
  check('creator-verify-wrong', verr === '密码错误。', { verr });
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await shot(A, 'creator-verify');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=project-password]')), 8000, '改密码弹窗');
  await typeInto(A, '#pc-pw-a', 'team-pw-2');
  await typeInto(A, '#pc-pw-b', 'team-pw-2');
  await shot(A, 'creator-change-password');
  await clickText(A, '确认修改', '[data-pc=project-password]');
  const pwToast = await waitFor(() => P(B, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('项目密码已被修改')) ?? null), 8000, '密码被改气泡').catch(() => null);
  check('member-password-changed-toast', pwToast?.startsWith('项目密码已被修改。你当前的连接不受影响，但下次进入需要新密码。'), { pwToast });
  await shot(B, 'member-password-changed-toast');

  // ---------- 踢人(踢 MacBook 上的 bob):验证 → 确认
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.includes('bob (MacBook)'));
    row?.querySelector('.pc-members-kick')?.click();
  });
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, '验证弹窗');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=kick-dialog]')), 8000, '踢人确认');
  const kickText = await P(A, () => document.querySelector('[data-pc=kick-dialog]')?.innerText ?? '');
  check('kick-confirm-text', kickText.includes('确定要把 bob (MacBook) 踢出项目吗？'), { kickText });
  await shot(A, 'creator-kick-confirm');
  await clickText(A, '踢出', '[data-pc=kick-dialog] .pc-dialog-foot');
  const kickToast = await waitFor(() => P(A, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('已踢出')) ?? null), 8000, '踢人气泡').catch(() => null);
  check('kick-free-mode-hint', kickToast?.startsWith('已踢出。自由进入模式下，想彻底挡住，要改项目密码。'), { kickToast });

  // ---------- 已禁入的设备
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, '已禁入的设备', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=bans-dialog]')), 8000, '禁入列表');
  const bans = await P(A, () => document.querySelector('[data-pc=bans-dialog]')?.innerText ?? '');
  check('bans-list', bans.includes('pc-macbook-probe-0001') && bans.includes('撤销'), { bans });
  await shot(A, 'creator-bans');
  await clickText(A, '返回', '[data-pc=bans-dialog]');

  // ---------- 删项目对话框(手打项目名)
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, '删除项目', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=delete-dialog]')), 8000, '删项目弹窗');
  const delDisabled = await P(A, () => [...document.querySelectorAll('[data-pc=delete-dialog] button')].find((b) => b.textContent.includes('永久删除项目'))?.disabled);
  await A.type('[data-pc=delete-dialog] input', name);
  const delEnabled = await P(A, () => !([...document.querySelectorAll('[data-pc=delete-dialog] button')].find((b) => b.textContent.includes('永久删除项目'))?.disabled));
  check('delete-needs-typed-name', delDisabled === true && delEnabled === true);
  await shot(A, 'creator-delete');
  await clickText(A, '取消', '[data-pc=delete-dialog] .pc-dialog-foot');

  // ---------- 踢 B:B 看到阻断弹窗
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.startsWith('bob') && !r.innerText.includes('MacBook'));
    row?.querySelector('.pc-members-kick')?.click();
  });
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, '验证弹窗');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=kick-dialog]')), 8000, '踢人确认');
  await clickText(A, '踢出', '[data-pc=kick-dialog] .pc-dialog-foot');
  const blocked = await waitFor(() => P(B, () => document.querySelector('[data-pc=blocked-dialog]')?.innerText ?? null), 8000, 'B 的阻断弹窗').catch(() => null);
  check('kicked-blocking-dialog', blocked?.includes('你已被创建者踢出该项目，无法继续编辑。想回来，找创建者撤销。') && blocked.includes('开始页'), { blocked });
  await shot(B, 'blocked-kicked');

  // 收尾:真的删掉(验证删除流程与自己回开始页)
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, '删除项目', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=delete-dialog]')), 8000, '删项目弹窗');
  await A.type('[data-pc=delete-dialog] input', name);
  await clickText(A, '永久删除项目', '[data-pc=delete-dialog] .pc-dialog-foot');
  const gone = await waitFor(async () => (await fetch(`${hosted}/shared/lookup?name=${encodeURIComponent(name)}`)).status === 404, 8000, '项目删掉').catch(() => false);
  const aAfter = await P(A, () => window.__pcSyncTest.view().kind);
  check('delete-project', gone && aAfter === 'local', { aAfter });
  for (const ws of extra) ws.close();
  await A.close();
  await B.close();
}

/* ======================================================================== lan */

async function phaseLan() {
  const C = await openEditor();
  await setHosted(C);
  const lan = await P(C, () => window.__pcSyncTest.view().device);
  if (!check('lan-host-editor', lan?.lanHost === true, { device: lan })) return;
  const name = `c65-lan-${Date.now().toString(36)}`;
  // 同名的托管项目(直接经托管端建)
  await createSharedProject({ where: 'hosted', hostedUrl: hosted, name, mode: 'free', creator: { username: 'zed', password: 'zed-pw' }, password: 'x-pw', kdf: { alg: 'pbkdf2-sha256', iter: 100000 } });
  // 局域网模式新建(本机当主机)
  await openProjectMenu(C);
  await clickText(C, '新建共享项目', '.pc-proj-menu');
  await typeInto(C, '#pc-ns-name', name);
  await typeInto(C, '#pc-ns-creator', 'carol');
  await typeInto(C, '#pc-ns-cpw', 'carol-pw');
  await clickText(C, '局域网模式', '[data-pc=new-shared-dialog]');
  await typeInto(C, '#pc-ns-ppw', 'lan-pw');
  await shot(C, 'new-shared-lan');
  await clickText(C, '创建', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(C, () => { const t = document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText; return t?.includes('创建成功') ? t : null; }), 20_000, '局域网建成').catch(() => null);
  check('new-shared-lan', created === '创建成功。让成员在同一个网段下查项目名就能进。记住本机要保持开着。', { created });
  await clickText(C, '返回', '[data-pc=new-shared-dialog]');
  await sleep(1500);
  // 另一个页面查找:局域网(本机主机经组播应答)+ 托管端各一个 → 并列
  const D = await openEditor();
  await setHosted(D);
  await openProjectMenu(D);
  await clickText(D, '打开共享项目', '.pc-proj-menu');
  await D.type('#pc-os-name', name);
  await clickText(D, '查找', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  const cands = await waitFor(() => P(D, () => { const el = document.querySelector('[data-pc=shared-candidates]'); return el ? el.innerText : null; }), 15_000, '并列候选').catch(() => null);
  check('open-shared-two-candidates', !!cands && cands.includes('[互联网模式] 托管在阿里云') && cands.includes('[局域网模式] 主机：'), { cands, title: await P(D, () => document.querySelector('[data-pc=open-shared-dialog] .pc-dialog-body')?.innerText.split('\n')[0]) });
  await shot(D, 'open-shared-choose');
  await C.close();
  await D.close();
}

try {
  if (phases.includes('local')) await phaseLocal();
  if (phases.includes('shared')) await phaseShared();
  if (phases.includes('lan')) await phaseLan();
} catch (e) {
  const stack = String(e?.stack ?? e);
  const lines = stack.split(/\r?\n/);
  check('probe-error', false, { message: lines[0].slice(0, 300), at: lines.filter((l) => l.includes('c65-editor-probe')).map((l) => l.trim()).slice(0, 4) });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.check) } }));
process.exitCode = failed.length ? 1 : 0;
