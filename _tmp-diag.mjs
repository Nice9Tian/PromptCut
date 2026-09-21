import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const root = 'C:/Users/admin/Documents/PromptCut/.claude/worktrees/agent-a671a2ddb0ba62cca';
const port = 5251;
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-diag-'));
const viteBin = path.join(path.dirname(createRequire(root + '/package.json').resolve('vite/package.json')), 'bin', 'vite.js');
const proc = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: root, env: { ...process.env, PROMPTCUT_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.on('data', () => {});
proc.stderr.on('data', (b) => process.stderr.write(String(b)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 200; i++) { try { const r = await fetch(origin + '/@vite/client'); if (r.ok) break; } catch {} await sleep(500); }

const browser = await puppeteer.launch({ headless: true, args: ['--window-position=-32000,-32000', '--no-first-run'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const log = [];
  await page.exposeFunction('__diag', (m) => log.push(m));
  await page.goto(origin + '/?editor&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  const initial = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    const p = getState().project;
    return { name: p.name, clips: p.tracks.flatMap((t) => t.clips.map((c) => ({ id: c.id, cardId: c.cardId, nodeId: c.nodeId, mediaId: c.mediaId }))) };
  });
  console.log('INITIAL PROJECT', JSON.stringify(initial));
  await page.waitForFunction(async () => (await import('/src/editor/stageBridge.ts')).backRole() === 'back', { timeout: 180000, polling: 300 });
  await sleep(3000);
  const early = await page.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
  console.log('PROGRESS BEFORE BUILD', JSON.stringify(early));
  const costs0 = await page.evaluate(async () => (await (await fetch('/api/data/costs')).json()).costs.length);
  console.log('COSTS BEFORE BUILD', costs0);

  const built = await page.evaluate(async () => {
    await import('/src/cards/index.ts');
    const { allCards } = await import('/src/kernel/registry.ts');
    const { actions, getState } = await import('/src/store/project.ts');
    const pinned = ['probe-css', 'probe-motion-js', 'particles-snow'];
    const ids = allCards().map((c) => c.id);
    const picked = [];
    for (const id of pinned) if (ids.includes(id)) picked.push(id);
    for (const id of ids) {
      if (picked.length >= 20) break;
      if (picked.includes(id) || id === 'composite' || (id.startsWith('particles-') && !pinned.includes(id))) continue;
      picked.push(id);
    }
    actions.newProject('probe-gate');
    for (const id of picked) actions.addCardClip(id, 0, { duration: 4 });
    const p = getState().project;
    return { picked, clips: p.tracks.flatMap((t) => t.clips.map((c) => ({ id: c.id, cardId: c.cardId, nodeId: c.nodeId }))) };
  });
  console.log('AFTER BUILD clips', built.clips.length, 'picked', built.picked.length);
  console.log('CLIPS', JSON.stringify(built.clips));
  await page.waitForFunction(async () => { const p = (await import('/src/editor/probeRunner.ts')).probeProgress(); return p.running === false && p.done > 0; }, { timeout: 600000, polling: 300 });
  const after = await page.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
  const costs1 = await page.evaluate(async () => (await (await fetch('/api/data/costs')).json()).costs.map((r) => r.identityKey));
  console.log('PROGRESS AFTER', JSON.stringify(after));
  console.log('COSTS AFTER', costs1.length);
  const keys = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    return clipIdentityOf(getState().project).identityKeys;
  });
  const known = new Set(Object.values(keys));
  console.log('PROJECT KEYS', known.size, 'EXTRA RECORDS', costs1.filter((k) => !known.has(k)));
} finally {
  await browser.close();
  proc.kill();
  await new Promise((r) => spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', r));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
