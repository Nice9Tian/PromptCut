import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';
const PORT = 5243;
const OUT = path.join(REPO, 'out', 'ro-explore'); fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ro-'));
const server = await startDevServer({ port: PORT, logFile: path.join(tmp, 'vite.log'), env: { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0', PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'), PROMPTCUT_WORK_DIR: path.join(tmp, 'work'), PROMPTCUT_DATA_DIR: path.join(tmp, 'data'), PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json') } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1600, height: 1000 }, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto(`${server.origin}/?editor&aimock=1&nosetup=1`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 400; i++) { if (await page.evaluate(() => !!window.__pcStore && !document.body.innerText.includes('正在测量卡片')).catch(() => false)) break; await sleep(300); }
  await sleep(2000);
  await page.screenshot({ path: path.join(OUT, 'normal.png') });
  console.log('done', server.origin);
} finally { await browser.close(); await server.stop?.(); }
