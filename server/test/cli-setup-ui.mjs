// Run against a local dev server. All setup endpoints are intercepted: no real
// installers, account logins, or permission changes are triggered by this test.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const providers = ['claude', 'codex', 'agy'].map(id => ({ id, label: id, available: false, auth: { loggedIn: false } }));
  let jobs = [];
  let serial = 0;
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/ai/')) return request.continue();
    const body = JSON.parse(request.postData() || '{}');
    let data = { ok: true };
    if (url.pathname === '/api/ai/providers') data.providers = providers;
    else if (url.pathname === '/api/ai/setup') data.jobs = jobs;
    else if (url.pathname === '/api/ai/config') data.config = { version: 1, defaultProvider: null, toolProtocol: false, api: { vendor: 'anthropic', baseUrl: '', model: '', maxTokens: 4096, apiKey: { set: false, last4: '' } } };
    else if (url.pathname === '/api/ai/agy-permissions') data = { ok: true, path: 'test', total: 0, missing: [], granted: [] };
    else if (url.pathname === '/api/ai/install' || url.pathname === '/api/ai/login') {
      if (body.dryRun) data.command = '从官方下载安装';
      else {
        const job = { id: String(++serial), provider: body.provider, kind: url.pathname.endsWith('install') ? 'install' : 'login', state: 'running', message: '正在处理', logs: [] };
        jobs = [...jobs.filter(j => j.provider !== body.provider), job]; data.job = job;
      }
    }
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto((process.env.BASE || 'http://127.0.0.1:5192') + '/?nosetup=1', { waitUntil: 'networkidle2' });
  const button = await page.$eval('.ai-gear-btn', e => ({ text: e.textContent, height: e.getBoundingClientRect().height }));
  assert.ok(button.text.includes('AI 设置')); assert.ok(button.height >= 32);
  await page.click('.ai-gear-btn');
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].filter(e => ['claude', 'codex', 'agy'].includes(e.querySelector('.ais-row-name')?.textContent)).every(e => [...e.querySelectorAll('button')].some(b => b.textContent === '安装')));
  const clickRowButton = async (id, label) => page.evaluate(({ id, label }) => {
    const row = [...document.querySelectorAll('.ais-row')].find(e => e.querySelector('.ais-row-name').textContent === id);
    [...row.querySelectorAll('button')].find(e => e.textContent.trim() === label).click();
  }, { id, label });
  await clickRowButton('claude', '安装'); await clickRowButton('codex', '安装');
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].filter(e => e.textContent.includes('安装中')).length === 2);
  jobs.find(j => j.provider === 'claude').state = 'failed';
  jobs.find(j => j.provider === 'claude').message = '下载失败，请检查网络';
  await page.waitForFunction(() => document.body.textContent.includes('下载失败，请检查网络'));
  assert.ok(await page.$eval('.ais-dialog', e => e.textContent.includes('重试安装')));
  await page.keyboard.press('Escape'); await page.click('.ai-gear-btn');
  await page.waitForFunction(() => document.querySelector('.ais-dialog').textContent.includes('下载失败，请检查网络'));
  providers.find(p => p.id === 'codex').available = true;
  jobs.find(j => j.provider === 'codex').state = 'succeeded';
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].find(e => e.querySelector('.ais-row-name').textContent === 'codex').textContent.includes('未登录'));
  await clickRowButton('codex', '登录');
  await page.waitForFunction(() => document.body.textContent.includes('等待登录'));
  jobs.find(j => j.provider === 'codex').url = 'https://auth.openai.com/example';
  await page.waitForSelector('a[href="https://auth.openai.com/example"]');
  jobs.find(j => j.provider === 'codex').state = 'succeeded';
  providers.find(p => p.id === 'codex').auth.loggedIn = true;
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].find(e => e.querySelector('.ais-row-name').textContent === 'codex').textContent.includes('已登录'));
  console.log('PASS: settings entry, concurrent installs, failure/retry, dialog recovery, browser login link, verified login refresh');
} finally { await browser.close(); }
