/**
 * HR22：渲染服务的部署脚本与模板（契约 `docs/plan/hosted-render-contract.md` 第 7 节、10.1 节；`server/hosted-render/deploy.mjs`、
 * `server/hosted/deploy/` 的模板、`scripts/remote/docservice.mjs` 的渲染服务子命令）。全部只在本机验：不连任何远端。
 * 跑：node --test server/test/hosted-render-deploy.test.mjs
 *
 *   HR22a 参数：缺省值与契约第 7.2 节一致；环境变量可改；不合格的值（相对路径、带引号、坏端口、坏用户名、坏地址）一律拒
 *   HR22b 模板：占位符都认得、填完不剩；PM2 配置求值后的字段与环境变量；slice 单元；没有任何令牌、私钥、密码
 *   HR22c 远端脚本：install / deploy / rollback / stop / status / keygen 的步骤与顺序（自检在换 current 之前、78 不换、--no-start 不动 PM2）；
 *         没有 systemd 时的降级写在脚本里；脚本能过 bash -n；没有秘密
 *   HR22d 命令行：参数解析与校验（planRenderCommand）；docservice.mjs 的 --dry-run 不连远端、退出码；错参数退出码 2
 *   HR22e 托管组合的部署清单没变：渲染服务不进 hosted 的暂存目录
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  renderInstance, renderTemplateValues, fillTemplate, renderPm2Config, renderSliceUnit, releaseIdOf, readTemplate, RENDER_PM2_TEMPLATE, RENDER_SLICE_TEMPLATE,
  renderInstallScript, renderDeployScript, renderRollbackScript, renderStopScript, renderStatusScript, renderKeygenScript, planRenderCommand,
  RENDER_APT_PACKAGES, RENDER_COMMANDS, DeployUsageError, NO_SYSTEMD_NOTE,
} from '../hosted-render/deploy.mjs';
import { stageHostedFiles } from '../hosted/files.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const CLI = path.join(ROOT, 'scripts', 'remote', 'docservice.mjs');
const ID = '0123456789ab';

const inst = renderInstance({});

/** 把 PM2 配置当 CommonJS 求值 */
function evalConfig(text) {
  const module = { exports: {} };
  new Function('module', 'exports', text)(module, module.exports);
  return module.exports.apps[0];
}

/** 文本里不许有的东西：令牌、私钥、密码的样子 */
function assertNoSecrets(text, what) {
  assert.doesNotMatch(text, /PROMPTCUT_CLUSTER_TOKEN/, `${what}：不带集群令牌的环境变量`);
  assert.doesNotMatch(text, /BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY/, `${what}：没有私钥正文`);
  assert.doesNotMatch(text, /"priv"\s*:/, `${what}：没有私钥文件的内容`);
  assert.doesNotMatch(text, /(?:password|passwd|token)\s*[=:]\s*['"]?[A-Za-z0-9_-]{8,}/i, `${what}：没有口令或令牌的赋值`);
  // 32 位以上的 base64url 串（令牌、签名、私钥的样子）：路径、地址、哈希引用里的不算
  const loose = text.split('\n').filter((l) => !l.trimStart().startsWith('#') && !l.trimStart().startsWith('//'))
    .join('\n').match(/(?<![\w/.:@-])[A-Za-z0-9_-]{32,}(?![\w/.:@-])/g);
  assert.equal(loose, null, `${what}：不该出现长的随机串：${loose}`);
}

const bashAvailable = (() => {
  const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'ok';
})();
function bashSyntaxOk(script, what) {
  if (!bashAvailable) return;
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `${what} 过不了 bash -n：${r.stderr}`);
}

test('HR22a 参数:缺省值与契约第 7.2 节一致;环境变量可改', () => {
  assert.equal(inst.app, 'promptcut-render');
  assert.equal(inst.dir, '/opt/promptcut-render');
  assert.equal(inst.current, '/opt/promptcut-render/current');
  assert.equal(inst.releases, '/opt/promptcut-render/releases');
  assert.equal(inst.data, '/var/lib/promptcut/render');
  assert.equal(inst.secrets, '/var/lib/promptcut/render-secrets');
  assert.equal(inst.hostedData, '/var/lib/promptcut/hosted');
  assert.equal(inst.docUrl, 'ws://127.0.0.1:8787');
  assert.equal(inst.statusPort, 5399);
  assert.equal(inst.workerPort, 5400);
  assert.equal(inst.maxConcurrent, 2);
  assert.equal(inst.maxProjects, 16);
  assert.equal(inst.memoryMax, '6G');
  assert.equal(inst.memoryHigh, '5G');
  assert.equal(inst.cpuQuota, '400%');
  assert.equal(inst.user, 'promptcut-render');
  assert.equal(inst.userCards, 'isolated');
  assert.equal(inst.maxMemoryRestart, '300M');
  assert.equal(inst.killTimeoutMs, 20_000);
  const custom = renderInstance({ PROMPTCUT_RENDER_DIR: '/srv/render/', PROMPTCUT_RENDER_USER: '', PROMPTCUT_RENDER_MAX_CONCURRENT: '1', PROMPTCUT_RENDER_MEMORY_MAX: '3G', PROMPTCUT_RENDER_USER_CARDS: 'off', PROMPTCUT_RENDER_DOC_URL: 'wss://example.test/hosted/' });
  assert.equal(custom.dir, '/srv/render');
  assert.equal(custom.current, '/srv/render/current');
  assert.equal(custom.user, '', '空串表示与管理进程同一用户');
  assert.equal(custom.maxConcurrent, 1);
  assert.equal(custom.memoryMax, '3G');
  assert.equal(custom.userCards, 'off');
  assert.equal(custom.docUrl, 'wss://example.test/hosted/');
});

test('HR22a 不合格的值一律拒:相对路径、路径里有上跳或引号、坏端口、坏大小、坏用户名、坏地址、坏取值', () => {
  const bad = [
    { PROMPTCUT_RENDER_DIR: 'relative/path' },
    { PROMPTCUT_RENDER_DIR: '/opt/../etc' },
    { PROMPTCUT_RENDER_DIR: "/opt/x'; rm -rf /; '" },
    { PROMPTCUT_RENDER_DATA: '/var/lib/$(whoami)' },
    { PROMPTCUT_RENDER_SECRETS: '/var/lib/a b' },
    { PROMPTCUT_RENDER_PORT: '80' },
    { PROMPTCUT_RENDER_PORT: 'abc' },
    { PROMPTCUT_RENDER_STATUS_PORT: '70000' },
    { PROMPTCUT_RENDER_MAX_CONCURRENT: '9' },
    { PROMPTCUT_RENDER_MAX_PROJECTS: '0' },
    { PROMPTCUT_RENDER_MEMORY_MAX: '6 GB' },
    { PROMPTCUT_RENDER_MEMORY_HIGH: 'x' },
    { PROMPTCUT_RENDER_CPU_QUOTA: '400' },
    { PROMPTCUT_RENDER_USER: 'Root User' },
    { PROMPTCUT_RENDER_USER: 'a;b' },
    { PROMPTCUT_RENDER_USER_CARDS: 'maybe' },
    { PROMPTCUT_RENDER_DOC_URL: 'http://127.0.0.1:8787' },
    { PROMPTCUT_RENDER_DOC_URL: "ws://127.0.0.1:8787/'; id; '" },
    { PROMPTCUT_RENDER_DOC_URL: 'not a url' },
  ];
  for (const env of bad) assert.throws(() => renderInstance(env), DeployUsageError, JSON.stringify(env));
});

test('HR22b 模板:占位符都认得、填完不剩;认不得的占位符与残留的花括号抛错', () => {
  for (const name of [RENDER_PM2_TEMPLATE, RENDER_SLICE_TEMPLATE]) {
    const text = readTemplate(name);
    const names = [...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
    assert.ok(names.length > 0, `${name} 里有占位符`);
    const values = renderTemplateValues(inst);
    for (const n of names) assert.ok(Object.hasOwn(values, n), `${name} 的占位符 ${n} 在取值表里`);
    const filled = fillTemplate(text, values);
    assert.doesNotMatch(filled, /\{\{|\}\}/, `${name} 填完不剩占位符`);
  }
  assert.throws(() => fillTemplate('a {{NOPE}} b', renderTemplateValues(inst)), /认不得的占位符/);
  assert.throws(() => fillTemplate('a {{ oops }} b', renderTemplateValues(inst)), /还剩/);
  // 取值表里没有会破坏引号的字符
  for (const [k, v] of Object.entries(renderTemplateValues(inst))) assert.doesNotMatch(v, /['"\\`${}]/, `${k} 的值里没有引号、反斜杠、$、花括号`);
});

test('HR22b PM2 配置:求值后的字段、环境变量、应用名与入口;不含任何秘密', () => {
  const text = renderPm2Config(inst);
  const app = evalConfig(text);
  assert.equal(app.name, 'promptcut-render');
  assert.equal(app.script, 'server/hosted-render/main.mjs');
  assert.equal(app.cwd, '/opt/promptcut-render/current');
  assert.equal(app.exec_mode, 'fork');
  assert.equal(app.instances, 1);
  assert.equal(app.autorestart, true);
  assert.equal(app.max_memory_restart, '300M');
  assert.equal(app.kill_timeout, 20000);
  assert.deepEqual(app.stop_exit_codes, [78], '自检不过(78)就停着不反复拉起');
  assert.deepEqual(app.env, {
    NODE_ENV: 'production',
    PROMPTCUT_RENDER_DOC_URL: 'ws://127.0.0.1:8787',
    PROMPTCUT_RENDER_SECRETS: '/var/lib/promptcut/render-secrets',
    PROMPTCUT_RENDER_DATA: '/var/lib/promptcut/render',
    PROMPTCUT_RENDER_PORT: '5400',
    PROMPTCUT_RENDER_STATUS_PORT: '5399',
    PROMPTCUT_RENDER_MAX_CONCURRENT: '2',
    PROMPTCUT_RENDER_MAX_PROJECTS: '16',
    PROMPTCUT_RENDER_MEMORY_MAX: '6G',
    PROMPTCUT_RENDER_MEMORY_HIGH: '5G',
    PROMPTCUT_RENDER_CPU_QUOTA: '400%',
    PROMPTCUT_RENDER_USER: 'promptcut-render',
    PROMPTCUT_RENDER_USER_CARDS: 'isolated',
    PROMPTCUT_RENDER_EDITOR_DIR: '/opt/promptcut-hosted/editor',
    PUPPETEER_CACHE_DIR: '/opt/promptcut-render/current/.cache/puppeteer',
  });
  assertNoSecrets(text, 'PM2 配置');
  // 换了参数,配置跟着换
  const other = evalConfig(renderPm2Config(renderInstance({ PROMPTCUT_RENDER_DIR: '/srv/r', PROMPTCUT_RENDER_MAX_CONCURRENT: '3' })));
  assert.equal(other.cwd, '/srv/r/current');
  assert.equal(other.env.PROMPTCUT_RENDER_MAX_CONCURRENT, '3');
  assert.equal(other.env.PUPPETEER_CACHE_DIR, '/srv/r/current/.cache/puppeteer');
  // 模板文件本身(占位符版)同样不含秘密
  assertNoSecrets(readTemplate(RENDER_PM2_TEMPLATE), 'PM2 配置模板');
  assertNoSecrets(readTemplate(RENDER_SLICE_TEMPLATE), 'slice 模板');
});

test('HR22b slice 单元:内存、CPU、IO、任务数的上限;只管 slice 认得的项', () => {
  const unit = renderSliceUnit(inst);
  for (const line of ['MemoryHigh=5G', 'MemoryMax=6G', 'CPUQuota=400%', 'CPUWeight=20', 'IOWeight=20', 'TasksMax=4096']) assert.ok(unit.split('\n').includes(line), line);
  assert.match(unit, /^\[Unit\]/m);
  assert.match(unit, /^\[Slice\]/m);
  assert.doesNotMatch(unit, /^(?:Nice|OOMScoreAdjust)=/m, 'slice 不认 Nice 与 OOMScoreAdjust(它们是进程的设置,由管理进程起工作进程时设)');
  const small = renderSliceUnit(renderInstance({ PROMPTCUT_RENDER_MEMORY_MAX: '2G', PROMPTCUT_RENDER_MEMORY_HIGH: '1G', PROMPTCUT_RENDER_CPU_QUOTA: '200%' }));
  assert.match(small, /^MemoryMax=2G$/m);
  assert.match(small, /^CPUQuota=200%$/m);
  assertNoSecrets(unit, 'slice 单元');
});

test('HR22c install 脚本:系统包、服务用户与目录权限、slice、没有 systemd 时降级', () => {
  const script = renderInstallScript(inst);
  for (const pkg of ['fonts-noto-cjk', 'fonts-noto-color-emoji', 'fonts-liberation', 'ffmpeg', 'libgbm1', 'libnss3', 'libxss1']) assert.ok(script.includes(`'${pkg}'`), `装 ${pkg}`);
  assert.ok(RENDER_APT_PACKAGES.includes('ffmpeg'));
  assert.match(script, /libasound2t64/, '24.04 起 libasound2 改名');
  assert.match(script, /useradd --system --no-create-home .* --shell \/usr\/sbin\/nologin "\$RUSER"/, '无登录权限的服务用户');
  assert.match(script, /install -d -o root -g root -m 0700 "\$SECRETS"/, '私钥目录 root 0700');
  assert.match(script, /install -d -o "\$RUSER" -g "\$RUSER" -m 0750 "\$DATA"/);
  assert.match(script, /\/etc\/systemd\/system\/promptcut-render\.slice/);
  assert.match(script, /systemctl daemon-reload/);
  assert.match(script, /if \[ -d \/run\/systemd\/system \]; then/, '先判有没有 systemd');
  assert.ok(script.includes(NO_SYSTEMD_NOTE), '没有 systemd 时打一行说明、不当错误');
  assert.ok(script.includes('MemoryMax=6G'), 'slice 内容就在脚本里');
  assert.doesNotMatch(script, /build-essential/);
  assert.match(renderInstallScript(inst, { withBuildTools: true }), /'build-essential'/);
  // 用户为空串:不建用户
  const noUser = renderInstallScript(renderInstance({ PROMPTCUT_RENDER_USER: '' }));
  assert.match(noUser, /RUSER=''/);
  // 不用 grep -q 接管道(pipefail 下会把「有字体」判成「没有」)
  assert.doesNotMatch(script, /fc-list \| grep -qi/);
  assertNoSecrets(script, 'install 脚本');
  bashSyntaxOk(script, 'install 脚本');
});

test('HR22c deploy 脚本:自检在换 current 之前,78 不换,换完才重载;--save 与 --no-start', () => {
  const script = renderDeployScript(inst, { id: ID });
  const at = (needle) => {
    const i = script.indexOf(needle);
    assert.ok(i >= 0, `脚本里要有：${needle}`);
    return i;
  };
  const extract = at('tar -xzf ".incoming-$ID.tar.gz"');
  const install = at('npm ci --no-audit --no-fund');
  const chrome = at('npx puppeteer browsers install chrome-headless-shell');
  const config = at('pm2.config.cjs.new" <<\'PCRENDERPM2\'');
  const check = at('server/hosted-render/main.mjs","--check"');
  const fail = at('exit 78');
  const swap = at('mv -T "$DIR/current.new" "$DIR/current"');
  const reload = at('pm2 startOrReload "$DIR/pm2.config.cjs" --update-env');
  assert.ok(extract < install && install < chrome, '先解包、再 npm ci、再装 Chrome');
  assert.ok(chrome < config && config < check, '先写配置,再用它的环境自检');
  assert.ok(check < fail && fail < swap, '自检没过(78)就退出,不换 current');
  assert.ok(swap < reload, '换完 current 才重载');
  assert.match(script, /ID='0123456789ab'/);
  assert.match(script, /REL="\$DIR\/releases\/\$ID"/, '按提交分目录');
  assert.match(script, /echo "\$CURRENT" > |basename "\$PREV" > "\$DIR\/\.previous"/, '换之前记下上一份');
  assert.match(script, /pm2 save: skipped/, '缺省不 pm2 save');
  assert.doesNotMatch(script, /^pm2 save$/m);
  assert.match(script, /if \[ -d \/run\/systemd\/system \]; then[\s\S]*pm2 startup systemd/, '开机自启只在有 systemd 时装');
  assert.ok(script.includes(NO_SYSTEMD_NOTE));
  assert.match(script, /KEEP=5/);
  assert.match(script, /不留超过|旧发布目录只留最近/);
  // Chrome 用发布目录里那份来自检,不是还没换的 current
  assert.match(script, /PUPPETEER_CACHE_DIR:process\.argv\[2\]\+"\/\.cache\/puppeteer"/);

  const saved = renderDeployScript(inst, { id: ID, save: true });
  assert.match(saved, /^pm2 save$/m);
  assert.doesNotMatch(saved, /pm2 save: skipped/);

  const noStart = renderDeployScript(inst, { id: ID, noStart: true });
  assert.doesNotMatch(noStart, /^pm2 startOrReload/m, '--no-start 不动 PM2');
  assert.doesNotMatch(noStart, /pm2 startup/);
  assert.doesNotMatch(noStart, /exit 78/, '--no-start 不卡自检(第一次部署缺私钥是正常的)');
  assert.match(noStart, /current -> releases\/\$ID/);
  assert.match(noStart, /keygen-render/);

  assert.match(renderDeployScript(inst, { id: ID, keep: 3 }), /KEEP=3/);
  assert.throws(() => renderDeployScript(inst, { id: 'not-hex' }), DeployUsageError);
  assert.throws(() => renderDeployScript(inst, { id: ID, keep: 1 }), DeployUsageError);
  // 只有一个 heredoc 结束标记,且不会在内容里提前出现
  for (const marker of ['PCRENDERPM2']) assert.equal(script.split('\n').filter((l) => l === marker).length, 1);
  assertNoSecrets(script, 'deploy 脚本');
  for (const [name, s] of [['deploy', script], ['deploy --save', saved], ['deploy --no-start', noStart]]) bashSyntaxOk(s, name);
});

test('HR22c rollback / stop / status / keygen 脚本', () => {
  const rb = renderRollbackScript(inst);
  assert.match(rb, /TO=''/);
  assert.match(rb, /cat "\$DIR\/\.previous"/, '缺省回到上一份');
  assert.match(rb, /\.extracted-ok/, '上一份必须还在、装好了');
  assert.match(rb, /mv -T "\$DIR\/current\.new" "\$DIR\/current"/);
  assert.ok(rb.indexOf('mv -T') < rb.indexOf('pm2 startOrReload'), '先换链接再重载');
  const rbTo = renderRollbackScript(inst, { to: ID });
  assert.match(rbTo, /TO='0123456789ab'/);
  assert.throws(() => renderRollbackScript(inst, { to: '../etc' }), DeployUsageError);

  const stop = renderStopScript(inst);
  assert.match(stop, /pm2 stop "\$APP"/);
  assert.doesNotMatch(stop, /promptcut-hosted/, '托管服务不动');
  assert.match(stop, /pm2 save/);
  assert.match(renderStopScript(inst, { remove: true }), /pm2 delete "\$APP"/);

  const status = renderStatusScript(inst);
  assert.match(status, /codeVersion/);
  assert.match(status, /x1b\[31m/, '代码版本不一致标红');
  assert.match(status, /v\.match===false/);
  assert.match(status, /\.service-usage\/render\.ndjson/, '产物容量记账');
  assert.match(status, /systemctl show "\$SLICE"/);
  assert.match(status, /readlink "\$DIR\/current"/);

  const kg = renderKeygenScript(inst, { instanceName: 'render-hk-1' });
  assert.match(kg, /cd '\/opt\/promptcut-render\/current'/);
  assert.match(kg, /node server\/hosted-render\/keygen\.mjs --hosted-data '\/var\/lib\/promptcut\/hosted' --secrets '\/var\/lib\/promptcut\/render-secrets' --instance-name 'render-hk-1'/);
  assert.match(kg, /umask 077/);
  assert.match(renderKeygenScript(inst, { retire: 'abcd1234' }), /--retire 'abcd1234'/);
  assert.match(renderKeygenScript(inst, { list: true }), /--list/);
  assert.match(renderKeygenScript(inst, { release: ID }), /cd '\/opt\/promptcut-render\/releases\/0123456789ab'/);
  assert.throws(() => renderKeygenScript(inst, { retire: 'x; rm' }), DeployUsageError);
  assert.throws(() => renderKeygenScript(inst, { instanceName: "a'b" }), DeployUsageError);
  assert.throws(() => renderKeygenScript(inst, { instanceName: 'a$(id)' }), DeployUsageError);
  for (const [name, s] of [['rollback', rb], ['stop', stop], ['status', status], ['keygen', kg]]) {
    assertNoSecrets(s, `${name} 脚本`);
    bashSyntaxOk(s, `${name} 脚本`);
  }
});

test('HR22d 参数解析:命令与参数的校验、提交号解析、只收各自的参数', () => {
  const resolveCommit = (ref) => (ref === 'HEAD' ? 'a'.repeat(40) : ref === 'v1' ? '0123456789abcdef0123456789abcdef01234567' : (() => { throw new DeployUsageError(`解析不了提交 ${ref}`); })());
  const deploy = planRenderCommand('deploy-render', [], {}, { resolveCommit });
  assert.equal(deploy.id, 'aaaaaaaaaaaa');
  assert.equal(deploy.commit, 'a'.repeat(40));
  assert.deepEqual(deploy.upload, { archive: '.incoming-aaaaaaaaaaaa.tar.gz', remote: '/opt/promptcut-render/.incoming-aaaaaaaaaaaa.tar.gz' });
  assert.equal(deploy.dryRun, false);
  const v1 = planRenderCommand('deploy-render', ['--commit', 'v1', '--save', '--no-start', '--keep', '3', '--dry-run'], {}, { resolveCommit });
  assert.equal(v1.id, '0123456789ab');
  assert.equal(v1.dryRun, true);
  assert.match(v1.script, /KEEP=3/);
  assert.match(v1.script, /pm2 config|pm2\.config\.cjs/);
  assert.doesNotMatch(v1.script, /^pm2 startOrReload/m, '--no-start');
  assert.throws(() => planRenderCommand('deploy-render', ['--commit', 'nope'], {}, { resolveCommit }), /解析不了提交/);
  assert.throws(() => planRenderCommand('deploy-render', ['--commit'], {}, { resolveCommit }), /要跟一个值/);
  assert.throws(() => planRenderCommand('deploy-render', ['--keep', '1'], {}, { resolveCommit }), DeployUsageError);
  assert.throws(() => planRenderCommand('deploy-render', ['--bogus'], {}, { resolveCommit }), /不认识的参数/);
  assert.throws(() => planRenderCommand('install-render', ['--commit', 'v1'], {}, { resolveCommit }), /不收 --commit/);
  assert.throws(() => planRenderCommand('status-render', ['--save'], {}), /不收 --save/);
  assert.throws(() => planRenderCommand('rollback-render', ['--to', 'xyz'], {}), DeployUsageError);
  assert.throws(() => planRenderCommand('frobnicate', [], {}), /不认识的命令/);
  assert.match(planRenderCommand('install-render', ['--with-build-tools'], {}).script, /build-essential/);
  assert.match(planRenderCommand('stop-render', ['--delete'], {}).script, /pm2 delete/);
  assert.match(planRenderCommand('keygen-render', ['--list'], {}).script, /--list/);
  assert.match(planRenderCommand('status-render', [], { PROMPTCUT_RENDER_STATUS_PORT: '5500' }).script, /STATUS_PORT=5500/, '环境变量带进脚本');
  assert.deepEqual([...RENDER_COMMANDS].sort(), ['deploy-render', 'install-render', 'keygen-render', 'rollback-render', 'status-render', 'stop-render']);
  assert.equal(releaseIdOf('ABCDEF0123456789AB'), 'abcdef012345');
  assert.throws(() => releaseIdOf('abc'), DeployUsageError);
  assert.throws(() => releaseIdOf('zzzzzzzzzzzzzz'), DeployUsageError);
});

test('HR22d 命令行:--dry-run 不连远端(不要 PROMPTCUT_REMOTE)、退出码 0;错参数退出码 2;没有 --dry-run 又没有 PROMPTCUT_REMOTE 退出码 2', () => {
  const env = { ...process.env };
  delete env.PROMPTCUT_REMOTE;
  delete env.PROMPTCUT_REMOTE_KEY;
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  for (const [cmd, expect] of [
    [['install-render', '--dry-run'], /apt-get install/],
    [['status-render', '--dry-run'], /pm2 describe "\$APP"/],
    [['stop-render', '--dry-run'], /pm2 stop "\$APP"/],
    [['rollback-render', '--dry-run'], /releases\/\$TO\/\.extracted-ok/],
    [['keygen-render', '--dry-run', '--list'], /keygen\.mjs --hosted-data/],
  ]) {
    const r = run(cmd);
    assert.equal(r.status, 0, `${cmd.join(' ')}：${r.stderr}`);
    assert.match(r.stdout, /\[dry-run\]/);
    assert.match(r.stdout, expect, cmd.join(' '));
    assertNoSecrets(r.stdout, `${cmd.join(' ')} 的干跑输出`);
  }
  const d = run(['deploy-render', '--dry-run']);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /git archive --format=tar\.gz -o <暂存目录>\/\.incoming-[0-9a-f]{12}\.tar\.gz [0-9a-f]{40}/);
  assert.match(d.stdout, /scp <暂存目录>\/\.incoming-[0-9a-f]{12}\.tar\.gz <user@host>:\/opt\/promptcut-render\//);
  assert.match(d.stdout, /npm ci --no-audit --no-fund/);
  assert.match(d.stdout, /exit 78/);
  assert.equal(run(['deploy-render', '--dry-run', '--bogus']).status, 2);
  assert.equal(run(['deploy-render', '--dry-run', '--commit', 'definitely-not-a-ref-xyz']).status, 2);
  assert.equal(run(['install-render']).status, 2, '没有 --dry-run 又没有 PROMPTCUT_REMOTE');
  assert.equal(run(['stop-render', '--dry-run', '--commit', 'x']).status, 2);
});

test('HR22e 托管组合的部署清单没变:渲染服务(跑完整仓库加依赖)不进 hosted 的暂存目录,模板也不拷', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr22-stage-'));
  try {
    const files = stageHostedFiles(ROOT, path.join(out, '.incoming')).map((f) => path.relative(out, f).split(path.sep).join('/'));
    assert.ok(files.length > 50);
    assert.ok(files.every((f) => !f.includes('hosted-render/')), '托管组合里没有渲染服务的管理进程');
    assert.ok(files.every((f) => !/hosted\/deploy\/(?:promptcut-render|pm2-promptcut-render)/.test(f)), '模板不拷到远端');
    assert.ok(files.some((f) => f.endsWith('server/asset-store/service-usage.mjs')), '容量记账随 asset-store 目录一起去');
    assert.ok(files.some((f) => f.endsWith('server/asset-store/px-evict.mjs')), 'service-usage 引的 px-evict 也在');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
