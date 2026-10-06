/**
 * 云端 Agent 服务节点上外部服务 Key 的加密分发(任务书 `docs/plan/cloud-agent-task.md` F;契约 `docs/plan/cloud-agent-contract.md` 第 8 节)。
 * 跑:npm test -- server/test/cloud-agent-keys.test.mjs
 *
 * 整条流程在测试里走通,**一律用假 Key 与临时目录**,不读这台 PC 上任何真实的 Key 文件:
 *   节点报出机器识别码(machine-id.mjs)→ 「用户的电脑」把 Key 加密成密文 → 节点上 import-key.mjs 解开、按落盘加密存进数据目录 → model-config 读得到。
 * 「用户的电脑」那一步用的是 `src/ai/configShare.ts` 的 `encryptConfig`:它就是 `tools/api-share-gui`(make-api-share.bat 打开的那个程序)与
 * `tools/make-api-share.py` 的同一份信封的 TypeScript 一端(Rust 一端的 `share.rs` 里有一条 JS 生成的基准密文在 `cargo test` 里互相对着;
 * 本文件的 CAU-KEY-02 把同一条基准密文交给节点这边的 Node 解密,于是三端逐字节兼容)。测试里不编译、不启动任何可执行文件。
 *
 *   CAU-KEY-01  机器识别码命令:只在标准输出打一行码;`--json`;取不到系统标识时的兜底会警告;码与密文用的是同一串
 *   CAU-KEY-02  节点这边的解密与前端、Rust 两端兼容:Rust 测试里那条 JS 生成的基准密文在这里解得开,抄码时的大小写、分隔符、形近字、聊天软件插的换行都不影响
 *   CAU-KEY-03  整条流程(模型):加密 → import-key → 落盘是密文(PCENC1.)、明文不在任何文件里 → model-config 读得到;输出里只有厂商、模型清单与末四位
 *   CAU-KEY-04  给别的机器的密文被拒,什么都不写,报「不是按这台机器的识别码生成的」
 *   CAU-KEY-05  格式不对、被截断、头部异常、被改过、已过期、厂商不对、没写模型,各给明确的报错,什么都不写;报错与输出里没有 Key、没有密文
 *   CAU-KEY-06  按服务名导入:配音 Key 用另一把封装(PCVOC1.),与模型 Key 互不相通;不认识的服务名被拒
 *   CAU-KEY-07  命令行:--file 与标准输入两种给法;密文写在命令行上被拒;退出码 0/1/2
 *   CAU-KEY-08  换 Key 再导入一次:替换并写明;模型清单里的 token 上限沿用原来的
 *   CAU-KEY-09  远程子命令(docservice.mjs 的 machine-id-agent / import-key-agent)的计划:--dry-run、脚本里没有 Key、密文只经 ssh 标准输入、写完删掉临时文件
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { encryptConfig } from '../../src/ai/configShare.ts';
import { machineCode } from '../runners/machine-id.mjs';
import { openKey, sealedKind } from '../runners/config-crypt.mjs';
import { readModelConfig, modelConfigPaths } from '../agent/service/model-config.mjs';
import { decryptShareBlob, ShareBlobError } from '../agent-service/share-blob.mjs';
import { importServiceKey, readServiceKey, ImportKeyError, voicePaths } from '../agent-service/service-keys.mjs';
import { runImportKey } from '../agent-service/import-key.mjs';
import { describeMachine, runMachineId } from '../agent-service/machine-id.mjs';
import { planKeyCommand, KEY_COMMANDS } from '../agent-service/key-deploy.mjs';

const FAST = { iterations: 20_000 };
const NODE_CODE = machineCode('linux:0123456789abcdef0123456789abcdef');
const OTHER_CODE = machineCode('linux:fedcba9876543210fedcba9876543210');
const KEY = 'sk-ant-FAKE-test-0123456789abcdefWXYZ';
const VOICE_KEY = 'voice-FAKE-token-9876543210ABCDEFPQRS';
const cfg = (extra = {}) => ({ vendor: 'anthropic', baseUrl: 'https://api.example.test', model: 'model-a|model-b', apiKey: KEY, ...extra });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-keys-'));
const sink = () => { const out = []; return { out, stream: { write: (s) => { out.push(String(s)); return true; } }, text: () => out.join('') }; };
const allFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);
const everything = (dir) => allFiles(dir).map((f) => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : ''; }).join('\n');
const stdinOf = (text, tty = false) => { const s = new PassThrough(); s.isTTY = tty; s.end(text); return s; };

test('CAU-KEY-01 机器识别码命令:标准输出只有一行码;--json;兜底会警告;码与密文用的是同一串', () => {
  const o = sink(); const e = sink();
  assert.equal(runMachineId({ argv: [], stdout: o.stream, stderr: e.stream, fingerprint: 'linux:0123456789abcdef0123456789abcdef' }), 0);
  assert.equal(o.text(), `${NODE_CODE}\n`, '标准输出只有码,便于 $(…) 取用');
  assert.match(NODE_CODE, /^PCM-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  assert.match(e.text(), /重装系统后会变/);
  const j = sink();
  runMachineId({ argv: ['--json'], stdout: j.stream, stderr: sink().stream, fingerprint: 'linux:abc' });
  const info = JSON.parse(j.text());
  assert.deepEqual(Object.keys(info).sort(), ['code', 'platform', 'source', 'stable']);
  assert.equal(info.source, 'machine-id');
  assert.equal(info.stable, true);
  assert.equal(JSON.stringify(info).includes('abc'), false, '原始指纹不出来');
  const f = sink(); const fe = sink();
  runMachineId({ argv: [], stdout: f.stream, stderr: fe.stream, fingerprint: 'fallback:host|linux|x64|aa:bb' });
  assert.match(fe.text(), /警告/);
  assert.equal(describeMachine('fallback:x').stable, false);
  assert.equal(runMachineId({ argv: ['--nope'], stdout: sink().stream, stderr: sink().stream }), 2);
  assert.equal(describeMachine().code, machineCode(), '默认取的就是这台机器的码,与落盘加密用的指纹同源');
});

test('CAU-KEY-02 节点这边的解密与前端、Rust 两端兼容(同一条基准密文)', async () => {
  // 取自 tools/api-share-gui/src/share.rs 的 decrypts_blob_made_by_the_typescript_side:由前端 configShare.ts 生成,Rust 那边在 cargo test 里解它
  const FROM_JS = 'PCAI1.AABOIG47vZ1SBN5tqedIRq251y5sP9VNFy4KEQxL44s-6JIpvYxC2g5PXjImKFJNEedRVQ5rua1o4_AqXZVTlrlCKYosGs4mLR81kPohqxW7bFXQ2vq3NtL-qN-w860YAhLnaEWP4BSzeDxME91xc1zPsokSq0adM3ebiiYrC1hFIRQGq01nQLNeG1wN3Env2Oc2On0sVSBq';
  const got = decryptShareBlob(FROM_JS, 'PCM-C3KK8-JF2R3-QKWC3-AAGNQ');
  assert.equal(got.vendor, 'gemini');
  assert.equal(got.model, 'gemini-2.0-flash');
  assert.equal(got.apiKey, 'sk-JS-SIDE-1234');
  assert.equal(got.note, '来自 JS');
  // 前端现生成的也解得开;抄码与传输中的形变不影响
  const blob = await encryptConfig(cfg(), NODE_CODE, FAST);
  assert.equal(decryptShareBlob(blob, NODE_CODE).apiKey, KEY);
  for (const variant of [NODE_CODE.toLowerCase(), NODE_CODE.replace(/-/g, ''), NODE_CODE.replace(/0/g, 'O'), ` ${NODE_CODE} `]) {
    assert.equal(decryptShareBlob(blob, variant).apiKey, KEY, `变体解不开:${variant}`);
  }
  assert.equal(decryptShareBlob(blob.replace(/(.{40})/g, '$1\n  '), NODE_CODE).model, 'model-a|model-b', '聊天软件插进来的换行与空格不影响');
});

test('CAU-KEY-03 整条流程(模型):加密 → import-key → 落盘是密文 → model-config 读得到;输出只有厂商、模型清单与末四位', async () => {
  const dataDir = tmpDir();
  try {
    const blob = await encryptConfig(cfg({ maxTokens: 8192, note: '给云端 Agent 用' }), NODE_CODE, FAST);
    const file = path.join(dataDir, 'incoming.txt');
    fs.writeFileSync(file, `${blob}\n`);
    const o = sink();
    const code = await runImportKey({ argv: ['--file', file], env: { PROMPTCUT_AGENT_DATA: dataDir }, stdout: o.stream, code: NODE_CODE });
    assert.equal(code, 0, o.text());
    const text = o.text();
    assert.match(text, /厂商:anthropic/);
    assert.ok(text.includes('模型:model-a、model-b(缺省 model-a)'));
    assert.match(text, /Key 末四位:WXYZ/);
    assert.equal(text.includes(KEY), false, '输出里没有 Key');
    assert.equal(text.includes(blob.slice(0, 40)), false, '输出里没有密文');
    // 落盘:密文(PCENC1.),明文不在任何文件里;读得回
    const { file: ai, keyFile } = modelConfigPaths(dataDir);
    const sealed = fs.readFileSync(keyFile, 'utf8').trim();
    assert.equal(sealedKind(sealed), 'custom');
    assert.match(sealed, /^PCENC1\./);
    assert.equal(openKey(sealed, 'custom'), KEY);
    const disk = everything(dataDir).replace(blob, '');
    assert.equal(disk.includes(KEY), false, '明文 Key 不在数据目录的任何文件里(密文文件 incoming.txt 除外,它本来就是密文)');
    assert.equal(fs.readFileSync(ai, 'utf8').includes(KEY), false);
    assert.deepEqual(readModelConfig(dataDir), { vendor: 'anthropic', baseUrl: 'https://api.example.test', model: 'model-a|model-b', maxTokens: 8192, apiKey: KEY });
    assert.deepEqual(readServiceKey(dataDir, 'model'), readModelConfig(dataDir));
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('CAU-KEY-03b 默认用这台机器自己的识别码(不传 code):用 machineCode() 加密的密文导得进', async () => {
  const dataDir = tmpDir();
  try {
    const blob = await encryptConfig(cfg(), machineCode(), FAST);
    const r = importServiceKey({ dataDir, blob });
    assert.equal(r.tail, 'WXYZ');
    assert.equal(readModelConfig(dataDir).apiKey, KEY);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('CAU-KEY-04 给别的机器的密文被拒,什么都不写', async () => {
  const dataDir = tmpDir();
  try {
    const blob = await encryptConfig(cfg(), OTHER_CODE, FAST);
    assert.throws(() => importServiceKey({ dataDir, blob, code: NODE_CODE }), (e) => e instanceof ShareBlobError && e.code === 'wrong-machine' && /不是按这台机器的识别码生成的/.test(e.message));
    assert.deepEqual(allFiles(dataDir), [], '被拒之后数据目录里什么都没有');
    const o = sink();
    assert.equal(await runImportKey({ argv: ['--stdin'], env: { PROMPTCUT_AGENT_DATA: dataDir }, stdin: stdinOf(blob), stdout: o.stream, code: NODE_CODE }), 1);
    assert.match(o.text(), /没有导入:解不开:这份密文不是按这台机器的识别码生成的/);
    assert.equal(o.text().includes(KEY), false);
    assert.deepEqual(allFiles(dataDir), []);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('CAU-KEY-05 各种不行的密文各给明确的报错,什么都不写;报错里没有 Key 与密文', async () => {
  const dataDir = tmpDir();
  try {
    const good = await encryptConfig(cfg(), NODE_CODE, FAST);
    const flip = (s, at) => s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);
    const cases = [
      ['not-a-blob', '这是一段普通文本', /不是 PromptCut 的配置密文/],
      ['bad-format', `${good.slice(0, 60)}!!${good.slice(60)}`, /格式不对/],
      ['truncated', good.slice(0, 40), /被截断/],
      ['wrong-machine', flip(good, good.length - 6), /被改过/],
    ];
    for (const [code, blob, re] of cases) {
      assert.throws(() => importServiceKey({ dataDir, blob, code: NODE_CODE }), (e) => e instanceof ShareBlobError && e.code === code && re.test(e.message), code);
    }
    // 头部的轮数被改成离谱的数
    const raw = Buffer.from(good.slice('PCAI1.'.length), 'base64url');
    raw.writeUInt32BE(2_000_000_000, 0);
    assert.throws(() => importServiceKey({ dataDir, blob: `PCAI1.${raw.toString('base64url')}`, code: NODE_CODE }), (e) => e.code === 'bad-header' && /头部异常/.test(e.message));
    // 已过期、厂商不对、没写模型、地址不对
    const expired = await encryptConfig(cfg({ expiresAt: Date.now() - 1000 }), NODE_CODE, FAST);
    assert.throws(() => importServiceKey({ dataDir, blob: expired, code: NODE_CODE }), (e) => e instanceof ImportKeyError && e.code === 'expired' && /已过期/.test(e.message));
    const badVendor = await encryptConfig(cfg({ vendor: 'deepseek' }), NODE_CODE, FAST);
    assert.throws(() => importServiceKey({ dataDir, blob: badVendor, code: NODE_CODE }), (e) => e.code === 'bad-content' && /厂商只能是/.test(e.message));
    const noModel = await encryptConfig(cfg({ model: ' ' }), NODE_CODE, FAST);
    assert.throws(() => importServiceKey({ dataDir, blob: noModel, code: NODE_CODE }), (e) => e.code === 'bad-content' && /没有写模型清单/.test(e.message));
    const badUrl = await encryptConfig(cfg({ baseUrl: 'ftp://x' }), NODE_CODE, FAST);
    assert.throws(() => importServiceKey({ dataDir, blob: badUrl, code: NODE_CODE }), (e) => e.code === 'bad-content' && /http/.test(e.message));
    assert.deepEqual(allFiles(dataDir), [], '这些都被拒,数据目录里什么都没有');
    // 数据目录不存在
    assert.throws(() => importServiceKey({ dataDir: path.join(dataDir, 'nope'), blob: good, code: NODE_CODE }), (e) => e.code === 'bad-data-dir');
    // 报错与输出里没有 Key、没有密文
    for (const blob of [cases[3][1], expired, badVendor]) {
      const o = sink();
      assert.equal(await runImportKey({ argv: ['--stdin'], env: { PROMPTCUT_AGENT_DATA: dataDir }, stdin: stdinOf(blob), stdout: o.stream, code: NODE_CODE }), 1);
      assert.equal(o.text().includes(KEY), false);
      assert.equal(o.text().includes(blob.slice(10, 50)), false);
    }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('CAU-KEY-06 按服务名导入:配音 Key 用另一把封装,与模型 Key 互不相通;不认识的服务名被拒', async () => {
  const dataDir = tmpDir();
  try {
    importServiceKey({ dataDir, blob: await encryptConfig(cfg(), NODE_CODE, FAST), code: NODE_CODE });
    const voiceBlob = await encryptConfig({ vendor: 'openai', baseUrl: 'https://voice.example.test/', model: 'minimax', apiKey: VOICE_KEY }, NODE_CODE, FAST);
    const r = importServiceKey({ dataDir, blob: voiceBlob, service: 'voice', code: NODE_CODE });
    assert.equal(r.service, 'voice');
    assert.equal(r.tail, 'PQRS');
    assert.deepEqual(r.models, ['minimax']);
    const { keyFile, file } = voicePaths(dataDir);
    const sealed = fs.readFileSync(keyFile, 'utf8').trim();
    assert.equal(sealedKind(sealed), 'voice');
    assert.match(sealed, /^PCVOC1\./);
    assert.equal(openKey(sealed, 'custom'), '', '配音那把用对话 Key 的封装解不出来');
    assert.equal(fs.readFileSync(file, 'utf8').includes(VOICE_KEY), false);
    assert.deepEqual(readServiceKey(dataDir, 'voice'), { baseUrl: 'https://voice.example.test', provider: 'minimax', apiKey: VOICE_KEY });
    assert.equal(readModelConfig(dataDir).apiKey, KEY, '模型 Key 没被动');
    // 配音提供方不对
    const badProvider = await encryptConfig({ vendor: 'openai', baseUrl: '', model: 'suno', apiKey: VOICE_KEY }, NODE_CODE, FAST);
    assert.throws(() => importServiceKey({ dataDir, blob: badProvider, service: 'voice', code: NODE_CODE }), (e) => e.code === 'bad-content' && /minimax \/ kling \/ vidu/.test(e.message));
    assert.throws(() => importServiceKey({ dataDir, blob: voiceBlob, service: 'telegram', code: NODE_CODE }), (e) => e.code === 'bad-service');
    assert.throws(() => readServiceKey(dataDir, 'telegram'), (e) => e.code === 'bad-service');
    const o = sink();
    assert.equal(await runImportKey({ argv: ['--service', 'telegram', '--stdin'], env: { PROMPTCUT_AGENT_DATA: dataDir }, stdin: stdinOf(voiceBlob), stdout: o.stream }), 2);
    assert.match(o.text(), /不认识的服务名/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('CAU-KEY-07 命令行:标准输入与 --file 两种给法;密文写在命令行上被拒;缺数据目录、缺密文的退出码是 2', async () => {
  const dataDir = tmpDir();
  try {
    const blob = await encryptConfig(cfg(), NODE_CODE, FAST);
    const env = { PROMPTCUT_AGENT_DATA: dataDir };
    const viaArg = sink();
    assert.equal(await runImportKey({ argv: [blob], env, stdout: viaArg.stream, code: NODE_CODE }), 2);
    assert.match(viaArg.text(), /密文不能写在命令行上/);
    assert.equal(viaArg.text().includes(blob.slice(10, 50)), false, '报错里不复述密文');
    const noData = sink();
    assert.equal(await runImportKey({ argv: ['--stdin'], env: {}, stdin: stdinOf(blob), stdout: noData.stream, code: NODE_CODE }), 2);
    const tty = sink();
    assert.equal(await runImportKey({ argv: [], env, stdin: stdinOf('', true), stdout: tty.stream, code: NODE_CODE }), 2);
    assert.match(tty.text(), /没有给密文/);
    const both = sink();
    assert.equal(await runImportKey({ argv: ['--file', 'x', '--stdin'], env, stdout: both.stream }), 2);
    const missing = sink();
    assert.equal(await runImportKey({ argv: ['--file', path.join(dataDir, 'nope.txt')], env, stdout: missing.stream }), 2);
    assert.deepEqual(allFiles(dataDir), []);
    const ok = sink();
    assert.equal(await runImportKey({ argv: [], env, stdin: stdinOf(blob), stdout: ok.stream, code: NODE_CODE }), 0, '没给 --file 且标准输入不是终端:从标准输入读');
    assert.equal(readModelConfig(dataDir).apiKey, KEY);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('CAU-KEY-08 换 Key 再导入一次:替换并写明;没写 token 上限时沿用原来的', async () => {
  const dataDir = tmpDir();
  try {
    importServiceKey({ dataDir, blob: await encryptConfig(cfg({ maxTokens: 8192 }), NODE_CODE, FAST), code: NODE_CODE });
    const NEW = 'sk-ant-FAKE-second-0123456789abcdef1234';
    const r = importServiceKey({ dataDir, blob: await encryptConfig(cfg({ apiKey: NEW, model: 'model-c' }), NODE_CODE, FAST), code: NODE_CODE });
    assert.equal(r.replaced, true);
    assert.equal(r.tail, '1234');
    const c = readModelConfig(dataDir);
    assert.equal(c.apiKey, NEW);
    assert.equal(c.model, 'model-c');
    assert.equal(c.maxTokens, 8192);
    const o = sink();
    await runImportKey({ argv: ['--stdin'], env: { PROMPTCUT_AGENT_DATA: dataDir }, stdin: stdinOf(await encryptConfig(cfg(), NODE_CODE, FAST)), stdout: o.stream, code: NODE_CODE });
    assert.match(o.text(), /替换了原来的/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('CAU-KEY-09 远程子命令的计划:--dry-run 不连远端;脚本里没有 Key;密文只经 ssh 标准输入;导入完删掉临时文件', async () => {
  assert.deepEqual([...KEY_COMMANDS], ['machine-id-agent', 'import-key-agent']);
  const env = { PROMPTCUT_AGENT_DATA: '/var/lib/promptcut/agent' };
  const id = planKeyCommand('machine-id-agent', ['--dry-run'], env);
  assert.equal(id.dryRun, true);
  assert.match(id.script, /node server\/agent-service\/machine-id\.mjs/);
  assert.match(id.script, /cd '\/opt\/promptcut-render\/current'/);

  const blob = await encryptConfig(cfg(), NODE_CODE, FAST);
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'blob.txt');
    fs.writeFileSync(f, `${blob}\n`);
    const plan = planKeyCommand('import-key-agent', ['--file', f, '--service', 'voice', '--dry-run'], env);
    assert.equal(plan.dryRun, true);
    assert.match(plan.script, /import-key\.mjs --file "\$BLOB" --service 'voice'/);
    assert.match(plan.script, /rm -f "\$BLOB"/, '导入完(成功或失败)都删掉临时文件');
    assert.match(plan.script, /trap /);
    assert.ok(plan.script.includes(blob), '密文本身进脚本(经 ssh 标准输入),脚本里没有明文 Key');
    assert.equal(plan.script.includes(KEY), false);
    assert.equal(plan.preview.includes(blob), false, 'dry-run 打印的预览里不整段显示密文');
    assert.equal(plan.preview.includes(KEY), false);
    assert.match(plan.preview, /PCAI1\.…/);
    // 不是密文的文件、缺 --file、不认识的服务名与参数
    const junk = path.join(dir, 'junk.txt');
    fs.writeFileSync(junk, "x'; rm -rf / #");
    assert.throws(() => planKeyCommand('import-key-agent', ['--file', junk, '--dry-run'], env), /不是一份 PCAI1\./);
    assert.throws(() => planKeyCommand('import-key-agent', ['--dry-run'], env), /--file/);
    assert.throws(() => planKeyCommand('import-key-agent', ['--file', f, '--service', 'x y', '--dry-run'], env), /服务名/);
    assert.throws(() => planKeyCommand('import-key-agent', ['--file', f, '--zzz'], env), /不认识的参数/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
