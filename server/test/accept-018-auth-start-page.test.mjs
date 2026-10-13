/**
 * 0.7.18 验收补证据（组名 auth）：在线浏览器开始页（online-browser-task.md 第一步第 1、2 条的界面部分）。
 * 把真实的 src/account/AccountProjects.tsx 用服务端渲染出「还没登录」时的页面，核对：登录表单和「加入别人的项目」都在，
 * 「新建」的表单和按钮不在（新建前要先登录）。只是静态首屏，不是真浏览器；登录之后出现新建按钮要真浏览器验。
 * 跑法：npm test -- server/test/accept-018-auth-start-page.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('在线浏览器开始页（未登录）：有登录表单和加入别人的项目，没有新建项目的入口', { timeout: 120_000 }, async () => {
  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    globalThis.location = { origin: 'https://example.invalid', href: 'https://example.invalid/editor/' };
    const { renderToString } = await import('react-dom/server');
    const React = await import('react');
    const { AccountProjects } = await vite.ssrLoadModule('/src/account/AccountProjects.tsx');
    const html = renderToString(React.createElement(AccountProjects, { online: true, onEnterEditor() {} }));
    assert.match(html, /data-pc="account-projects"/);
    assert.match(html, /name="username"/, '未登录：有账号名输入框');
    assert.match(html, /name="password"/, '未登录：有密码输入框');
    assert.match(html, /data-pc="cloud-project-link"/, '加入别人的项目的入口在');
    assert.doesNotMatch(html, /data-pc="cloud-create"/, '未登录：没有新建项目的按钮');
    assert.doesNotMatch(html, /data-pc="cloud-project-name"/, '未登录：没有项目名输入框');
  } finally { await vite.close(); }
});
