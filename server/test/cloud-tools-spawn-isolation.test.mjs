/**
 * 云端 Agent 起 Python 的四处(语音转写、主体识别、运动追踪、网页采集)都用隔离模式:
 * 对话工作区根下放着同名的恶意模块时,它们一个都不会被导入。
 *
 * 为什么要守:子进程的工作目录是这个对话的工作区,里面是成员和模型弄进来的文件(附件、下载、取来的素材)。
 * `python -m 包名` 会把当前目录排在模块搜索路径最前面,工作区根下出现一个 `json.py` 就等于在节点上执行任意代码。
 * 隔离模式(`-I`)不看 PYTHON* 环境变量、不把当前目录和用户 site 放进搜索路径;包目录只由部署配置经引导代码递进去。
 *
 * 真东西:真 Python、仓库里真的四个包、真工作区、真运行资源登记器与作业表。每个用例只跑「查状态」。
 * 没有 Python 时整份 skip(不假绿)。
 * 跑:npm test -- server/test/cloud-tools-spawn-isolation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { p2Fixture } from './cloud-tools-p2-fixture.mjs';
import { makeP4Fixture } from './cloud-tools-p4-fixture.mjs';
import { buildTrackEnv, contextOf } from './cloud-tools-p3-kit.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { createCollect, newCollectState } from '../agent/service/hosted-collect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES = path.join(ROOT, 'python');

function findPython() {
  for (const cand of [process.env.PROMPTCUT_TEST_PYTHON, process.env.PROMPTCUT_PYTHON, 'python', 'python3'].filter(Boolean)) {
    const r = spawnSync(cand, ['-I', '-c', 'import sys;sys.stdout.write(sys.executable)'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim() && fs.existsSync(r.stdout.trim())) return r.stdout.trim();
  }
  return null;
}
const python = findPython();
const skip = python ? false : '没有可用的 Python';

/** 标准库里每个包都会 import 的两个名字,加上四个包自己的名字(`-m 包名` 时当前目录里的同名模块会顶掉真包) */
const EVIL_NAMES = ['json', 'argparse', 'promptcut_stt', 'promptcut_subject', 'promptcut_track', 'promptcut_collect'];

/** 往工作区根下放恶意模块:被导入就往标记文件里写一行自己的名字。回 `{ marker, imported() }` */
function plantEvil(t, workDir) {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-spawn-evil-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, 'imported.txt');
  for (const name of EVIL_NAMES) {
    fs.writeFileSync(path.join(workDir, `${name}.py`),
      `with open(${JSON.stringify(marker)}, 'a', encoding='utf-8') as _f:\n    _f.write(${JSON.stringify(`${name}\n`)})\n`);
  }
  return { marker, imported: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean) : []) };
}

test('语音转写:工作区根下的同名模块不被导入,状态照常查得到', { skip, timeout: 120_000 }, async (t) => {
  const f = await p2Fixture(t, { realPython: true, runtime: { pythonPath: python, sourceRoot: PACKAGES } });
  const evil = plantEvil(t, f.ws.dir());
  const status = await f.tools.call('stt_status', {}, f.context);
  assert.deepEqual(evil.imported(), [], `恶意模块被导入了:${evil.imported().join('、')}`);
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.match(String(status.python), /^\d+\.\d+/, '真包跑出了状态');
});

test('主体识别:工作区根下的同名模块不被导入,状态照常查得到', { skip, timeout: 120_000 }, async (t) => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-spawn-models-'));
  t.after(() => fs.rmSync(models, { recursive: true, force: true }));
  const fx = await makeP4Fixture(t, { config: { python, modelsDir: models, pythonPath: PACKAGES } });
  const evil = plantEvil(t, fx.ws.dir());
  const status = await fx.tools.call('subject_status', {}, fx.context);
  assert.deepEqual(evil.imported(), [], `恶意模块被导入了:${evil.imported().join('、')}`);
  assert.ok(status.detail && typeof status.detail.light === 'object', `真包跑出了状态:${JSON.stringify(status)}`);
});

test('运动追踪:工作区根下的同名模块不被导入,状态照常查得到', { skip, timeout: 120_000 }, async (t) => {
  const env = await buildTrackEnv(t, { runtime: null, python: { executable: python, packageRoot: PACKAGES } });
  const ctx = env.access.trust(contextOf());
  const ws = await env.workspace(ctx);
  const evil = plantEvil(t, ws.dir());
  const status = await env.tracks.call('track_status', {}, ctx);
  assert.deepEqual(evil.imported(), [], `恶意模块被导入了:${evil.imported().join('、')}`);
  assert.ok(status.fallback && status.runtime, `真包跑出了状态:${JSON.stringify(status)}`);
  await env.close();
});

test('网页采集:工作区根下的同名模块不被导入,状态照常查得到', { skip, timeout: 120_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-spawn-collect-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  const workspaces = createWorkspaces({ dataDir });
  const ws = workspaces.open({ projectId: 'proj_a', ownerKey: 'owner1234', conversationId: 'conv_a' });
  // 状态查询不出网:代理给一个连不上的回环地址即可
  const egress = { startProxy: async () => ({ url: 'http://127.0.0.1:9', close: async () => {} }) };
  const collect = createCollect({ config: { python, pythonPath: PACKAGES }, egress });
  const tools = collect.forConversation({ state: newCollectState(), workspace: () => ws, ensureCanWrite: async () => {}, importFile: async () => ({}), conversationId: 'conv_a' });
  const evil = plantEvil(t, ws.dir());
  const status = await tools.collect_status();
  assert.deepEqual(evil.imported(), [], `恶意模块被导入了:${evil.imported().join('、')}`);
  assert.ok(status.ytdlp && typeof status.ytdlp.installed === 'boolean' && !/起不来/.test(String(status.hint)), `真包跑出了状态:${JSON.stringify(status)}`);
});
