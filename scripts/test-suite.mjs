import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exitDescription, retryReason, summarizeTestEvents } from './test-suite-policy.mjs';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const reporter = path.join(root, 'scripts', 'test-event-reporter.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-test-'));
const files = process.argv.length > 2 ? process.argv.slice(2) : ['server/test/*.test.mjs', 'src/**/*.test.mjs', 'tools/report-worker/*.test.mjs'];
const baseArgs = ['--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test'];

async function run(testFiles, attempt) {
  const report = path.join(temp, `events-${attempt}.ndjson`);
  const args = [...baseArgs, '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${pathToFileURL(reporter).href}`, `--test-reporter-destination=${report}`, ...testFiles];
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => { console.error(`测试进程启动失败：${error.message}`); resolve(1); });
    child.once('close', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
  let events = [];
  if (fs.existsSync(report)) {
    try {
      events = fs.readFileSync(report, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      console.error(`测试事件报告读取失败：${error.message}`);
      return { code: 1, files: [], reportError: true };
    }
  }
  return { code, files: summarizeTestEvents(events, root), reportError: !fs.existsSync(report) };
}

function note(file, attempt, retriable) {
  const { exitCode, signal } = file.processFailure;
  const status = signal ? `signal=${signal}` : `exitCode=${exitDescription(exitCode)}`;
  console.error(`\n${retriable ? '⚠ 测试文件进程异常' : '✖ 文件级失败（不重跑）'}：${file.file}（第 ${attempt} 次）`);
  console.error(`  ${status}；已报用例=${file.testCases}；stderr=${file.stderrLines} 行${retriable ? '；参考 nodejs/node#65756：https://github.com/nodejs/node/issues/65756' : ''}`);
}

async function main() {
  const first = await run(files, 'all');
  if (first.code === 0) {
    console.log('✓ npm test 最终结果：零失败');
    return 0;
  }
  if (first.reportError) return 1;

  const failures = first.files.filter((file) => file.assertionFailures > 0 || file.processFailure);
  const retryable = failures.filter((file) => retryReason(file));
  for (const file of failures) if (file.processFailure) note(file, 1, Boolean(retryReason(file)));
  let unrecovered = failures.length !== retryable.length || retryable.length === 0;
  for (const file of retryable) {
    let recovered = false;
    for (let retry = 1; retry <= 2; retry++) {
      console.error(`↻ 单独重跑 ${file.file}（${retry}/2）`);
      const result = await run([file.file], `${path.basename(file.file)}-${retry}`);
      if (result.code === 0 && !result.reportError) {
        console.error(`✓ ${file.file} 重跑通过；首次异常已记录`);
        recovered = true;
        break;
      }
      const next = result.files.find((entry) => path.normalize(entry.file).toLowerCase() === path.normalize(file.file).toLowerCase());
      if (!next || !retryReason(next)) {
        if (next?.processFailure) note(next, retry + 1, false);
        console.error(`✖ ${file.file} 重跑出现断言或加载错误，保留失败`);
        break;
      }
      note(next, retry + 1, true);
    }
    if (!recovered) unrecovered = true;
  }
  if (unrecovered) {
    console.error('✖ npm test 最终结果：仍有失败');
    return 1;
  }
  console.log(`✓ npm test 最终结果：零失败（${retryable.length} 个异常退出文件重跑通过）`);
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  const relative = path.relative(path.resolve(os.tmpdir()), temp);
  if (!relative.startsWith('promptcut-test-') || relative.includes(path.sep)) throw new Error(`拒绝清理非本次测试临时目录：${temp}`);
  fs.rmSync(temp, { recursive: true, force: true });
}
