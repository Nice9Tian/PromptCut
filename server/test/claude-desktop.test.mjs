// node --test server/test/claude-desktop.test.mjs
// 不碰真桌面版:深链、回车、归档全用假的,只验这个模块自己的逻辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { launchClaudeTask, trustFolder, findSessionSince, allowMcpInUserSettings } = await import('../claude-desktop.ts');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-claude-'));
}

function fakeHome({ claudeJson } = {}) {
  const home = tmp();
  if (claudeJson !== undefined) fs.writeFileSync(path.join(home, '.claude.json'), claudeJson);
  return home;
}

function writeSession(sessionsDir, { cwd, createdAt, id = 'local_' + Math.random().toString(36).slice(2) }) {
  const sub = path.join(sessionsDir, 'default');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `${id}.json`), JSON.stringify({ sessionId: id, cwd, createdAt, title: 'x' }));
  return id;
}

const sent = (trustDialog = 'none') => ({ autoSend: 'sent', trustDialog });

function deps(home, sessionsDir, extra = {}) {
  const calls = { urls: [], enters: [] };
  return {
    calls,
    deps: {
      home, sessionsDir,
      openUrl: async (u) => { calls.urls.push(u); },
      sendPrompt: async (dir, prompt, settle) => { calls.enters.push({ dir, prompt, settle }); return sent(); },
      settleMs: 0, verifyMs: 1500, pollMs: 20,
      ...extra,
    },
  };
}

test('成功路:预写信任 + 深链 + 点掉弹窗 + 回车 + 归档核对到任务目录', async () => {
  const home = fakeHome({ claudeJson: JSON.stringify({ projects: { 'C:\\other': { hasTrustDialogAccepted: true } }, numStartups: 3 }) });
  const sessionsDir = path.join(tmp(), 'claude-code-sessions');
  const dir = path.join(tmp(), 'job');
  fs.mkdirSync(dir);
  const { deps: d, calls } = deps(home, sessionsDir, {
    sendPrompt: async (_dir, prompt) => {
      assert.equal(prompt, '/promptcut');
      writeSession(sessionsDir, { cwd: dir, createdAt: Date.now() });
      return sent('clicked');
    },
  });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(r.kind, 'claude-deeplink');
  assert.equal(r.status, 'ready');
  assert.equal(r.autoSend, 'sent');
  assert.equal(r.sessionCwd, dir);
  assert.ok(r.sessionId?.startsWith('local_'));
  assert.match(r.detail, /已替你点掉信任弹窗/);
  // 一条深链,folder 和 q 都在,而且是编码过的
  assert.deepEqual(calls.urls, ['claude://code/new?folder=' + encodeURIComponent(dir) + '&q=%2Fpromptcut']);
  // ~/.claude.json:任务目录已信任、promptcut 已启用,别的条目和顶层键都还在
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(cfg.numStartups, 3);
  assert.equal(cfg.projects['C:\\other'].hasTrustDialogAccepted, true);
  const entry = cfg.projects[dir];
  assert.equal(entry.hasTrustDialogAccepted, true);
  assert.deepEqual(entry.enabledMcpjsonServers, ['promptcut']);
  assert.deepEqual(entry.disabledMcpjsonServers, []);
});

test('弹窗没点成:照样核对,但要提醒用户去点', async () => {
  const home = fakeHome({ claudeJson: '{}' });
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  const { deps: d } = deps(home, sessionsDir, { sendPrompt: async () => sent('failed'), verifyMs: 200 });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(r.status, 'ready');
  assert.match(r.detail, /信任弹窗没点成/);
});

test('目录芯片没出现就不发:原因翻成人话,弹窗点掉了也要说', async () => {
  const home = fakeHome({ claudeJson: '{}' });
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  const { deps: d } = deps(home, sessionsDir, { sendPrompt: async () => ({ autoSend: 'error', trustDialog: 'clicked', reason: 'NOFOLDER' }) });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(r.status, 'ready');
  assert.equal(r.autoSend, 'error');
  assert.equal(r.sessionId, undefined);
  assert.match(r.detail, /目录芯片没切到任务目录/);
  assert.match(r.detail, /已替你点掉信任弹窗/);
});

test('发进了别的目录:报 failed 并说出落在哪', async () => {
  const home = fakeHome({ claudeJson: '{}' });
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  const elsewhere = path.join(tmp(), 'someone-elses-project');
  const { deps: d } = deps(home, sessionsDir, {
    sendPrompt: async () => { writeSession(sessionsDir, { cwd: elsewhere, createdAt: Date.now() }); return sent(); },
    verifyMs: 300,
  });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(r.status, 'failed');
  assert.equal(r.autoSend, 'sent');
  assert.equal(r.sessionCwd, elsewhere);
  assert.match(r.detail, /别的目录/);
});

test('归档里一直没出现新会话:不装成功,说清没核对到', async () => {
  const home = fakeHome({ claudeJson: '{}' });
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  const { deps: d } = deps(home, sessionsDir, { verifyMs: 200 });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(r.status, 'ready');
  assert.equal(r.autoSend, 'sent');
  assert.equal(r.sessionId, undefined);
  assert.match(r.detail, /没在会话归档里看到/);
});

test('发送那步报了别的状态:不核对,让用户自己按', async () => {
  const home = fakeHome({ claudeJson: '{}' });
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  const { deps: d } = deps(home, sessionsDir, { sendPrompt: async () => ({ autoSend: 'nofocus', trustDialog: 'none' }) });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(r.status, 'ready');
  assert.equal(r.autoSend, 'nofocus');
  assert.match(r.detail, /按一下回车/);
});

test('旧会话不算数:只认 createdAt >= t0 的', () => {
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  const t0 = Date.now();
  writeSession(sessionsDir, { cwd: dir, createdAt: t0 - 60_000 });
  assert.equal(findSessionSince(sessionsDir, t0, dir), null);
  const fresh = writeSession(sessionsDir, { cwd: dir, createdAt: t0 + 5 });
  const r = findSessionSince(sessionsDir, t0, dir);
  assert.equal(r.sessionId, fresh);
  assert.equal(r.matches, true);
});

test('cwd 大小写 / 斜杠不同也算同一个目录', () => {
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'Job');
  const t0 = Date.now();
  const variant = process.platform === 'win32' ? dir.toLowerCase().replace(/\\/g, '/') : dir + '/';
  writeSession(sessionsDir, { cwd: variant, createdAt: t0 + 1 });
  assert.equal(findSessionSince(sessionsDir, t0, dir)?.matches, true);
});

test('~/.claude.json 解析不了就不覆盖,拉起照常进行', async () => {
  const home = fakeHome({ claudeJson: '{ this is not json' });
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  assert.equal(trustFolder(home, dir, ['promptcut']), false);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ this is not json');
  const { deps: d, calls } = deps(home, sessionsDir, {
    sendPrompt: async () => { writeSession(sessionsDir, { cwd: dir, createdAt: Date.now() }); return sent(); },
  });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(calls.urls.length, 1);
  assert.equal(r.status, 'ready');
  assert.match(r.detail, /没能预写/);
});

test('allowMcpInUserSettings:没有文件就建;有就合并、别的键不动;第二次 present;坏 JSON 不覆盖', () => {
  const home = fakeHome();
  const file = path.join(home, '.claude', 'settings.json');
  assert.equal(allowMcpInUserSettings(home, ['mcp__promptcut']), 'added');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { permissions: { allow: ['mcp__promptcut'] } });
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(git:*)'], deny: ['Read(.env)'] }, hooks: { PreToolUse: [] } }));
  assert.equal(allowMcpInUserSettings(home, ['mcp__promptcut']), 'added');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.model, 'opus');
  assert.deepEqual(cfg.permissions.allow, ['Bash(git:*)', 'mcp__promptcut']);
  assert.deepEqual(cfg.permissions.deny, ['Read(.env)']);
  assert.deepEqual(cfg.hooks, { PreToolUse: [] });
  assert.equal(allowMcpInUserSettings(home, ['mcp__promptcut']), 'present');
  fs.writeFileSync(file, '{ nope');
  assert.equal(allowMcpInUserSettings(home, ['mcp__promptcut']), 'failed');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
});

test('第一次放行 MCP 工具要在 detail 里说一声', async () => {
  const home = fakeHome({ claudeJson: '{}' });
  const sessionsDir = path.join(tmp(), 's');
  const dir = path.join(tmp(), 'job');
  const { deps: d } = deps(home, sessionsDir, {
    sendPrompt: async () => { writeSession(sessionsDir, { cwd: dir, createdAt: Date.now() }); return sent(); },
  });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.match(r.detail, /放行 promptcut 的 MCP 工具/);
  const r2 = await launchClaudeTask(dir, '/promptcut', d);
  assert.doesNotMatch(r2.detail, /放行 promptcut/);
});

test('trustFolder:没有 ~/.claude.json 也能建;已有条目的别的字段保留', () => {
  const home = fakeHome();
  const dir = path.join(tmp(), 'job');
  assert.equal(trustFolder(home, dir, ['promptcut']), true);
  let cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(cfg.projects[dir].hasTrustDialogAccepted, true);
  // 第二次:已有条目里有别的字段(allowedTools)和 disabled 里有 promptcut,要保留前者、清掉后者
  cfg.projects[dir].allowedTools = ['Bash'];
  cfg.projects[dir].disabledMcpjsonServers = ['promptcut', 'other'];
  cfg.projects[dir].enabledMcpjsonServers = ['x'];
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cfg));
  assert.equal(trustFolder(home, dir, ['promptcut']), true);
  cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(cfg.projects[dir].allowedTools, ['Bash']);
  assert.deepEqual(cfg.projects[dir].enabledMcpjsonServers, ['x', 'promptcut']);
  assert.deepEqual(cfg.projects[dir].disabledMcpjsonServers, ['other']);
  assert.equal(Object.keys(cfg.projects).length, 1);
});

test('重新拉起:任务目录里已有会话就走 code/continue,不再开 code/new(那会开成 No folder)', async () => {
  const { resumeClaudeSession } = await import('../claude-desktop.ts');
  const home = fakeHome();
  const sessionsDir = path.join(tmp(), 'claude-code-sessions');
  const dir = path.join(tmp(), 'job');
  fs.mkdirSync(dir);
  // 归档里有一条落在任务目录的旧会话(createdAt 很早也算:重新拉起不限时间)
  const id = writeSession(sessionsDir, { cwd: dir, createdAt: Date.now() - 3600_000 });
  const { deps: d, calls } = deps(home, sessionsDir);
  const r = await resumeClaudeSession(dir, undefined, d);
  assert.equal(r?.kind, 'claude-continue');
  assert.equal(r?.sessionId, id);
  assert.equal(calls.urls.length, 1);
  assert.match(calls.urls[0], /^claude:\/\/code\/continue\?session=local_/);
  assert.equal(calls.enters.length, 0, '续开原会话不该再替用户回车');
});

test('重新拉起:上次核对到的会话 id 优先;归档里什么都没有就返回 null 让调用方走新建', async () => {
  const { resumeClaudeSession } = await import('../claude-desktop.ts');
  const home = fakeHome();
  const sessionsDir = path.join(tmp(), 'claude-code-sessions');
  const dir = path.join(tmp(), 'job');
  fs.mkdirSync(dir);
  const { deps: d, calls } = deps(home, sessionsDir);
  const r = await resumeClaudeSession(dir, 'local_abc-123', d);
  assert.equal(r?.sessionId, 'local_abc-123');
  assert.match(calls.urls[0], /session=local_abc-123$/);
  const none = await resumeClaudeSession(dir, 'not a session id', d);
  assert.equal(none, null);
  assert.equal(calls.urls.length, 1);
});

test('归档核对的期限从回车之后起算:UIA 那段拖了很久也不会错过会话', async () => {
  const home = fakeHome();
  const sessionsDir = path.join(tmp(), 'claude-code-sessions');
  const dir = path.join(tmp(), 'job');
  fs.mkdirSync(dir);
  let clock = 1_000_000;
  const { deps: d } = deps(home, sessionsDir, {
    now: () => clock,
    settleMs: 100, verifyMs: 500, pollMs: 5,
    // 回车那一步耗时远超 settleMs + verifyMs,会话在这期间落盘
    sendPrompt: async () => { writeSession(sessionsDir, { cwd: dir, createdAt: clock + 10 }); clock += 60_000; return sent(); },
  });
  const r = await launchClaudeTask(dir, '/promptcut', d);
  assert.equal(r.status, 'ready');
  assert.equal(r.sessionCwd, dir, '回车之后才开始核对,应该看得到这条会话');
  assert.doesNotMatch(r.detail, /没在会话归档里看到/);
});
