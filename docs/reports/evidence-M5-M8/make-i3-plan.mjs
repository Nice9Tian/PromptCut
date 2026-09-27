/**
 * 证据补跑：C6.1 的 I3 / I5 按主执行计划 I 表的口径（待发上限 1 MB、RSS 增长 < 50 MB）重跑。
 *
 * 做法：把 `server/test/docservice-backpressure.test.mjs` 复制一份到给定路径，只改这几处，断言一条不删：
 *   - I3：高水位 8 KiB → 64 KiB（核心缺省 `CORE_DEFAULTS.HIGH_WATER_BYTES`），上限 64 KiB → 1 MiB（缺省 `MAX_PENDING_BYTES`）；
 *     发布时限 10 s → 90 s、任务数上限 4000 → 60000（门槛变大，要多灌才会触发背压）；
 *     另记 RSS（进程常驻内存）并加断言 RSS 增长 < 50 MB。服务与 200 个客户端在同一进程，RSS 是服务的上界。
 *   - I5：同样改成 64 KiB / 1 MiB，灌水时限 8 s → 60 s。
 *   - 相对 import 改成指向仓库里的原文件。
 *
 * 用法（仓库根）：
 *   node docs/reports/evidence-M5-M8/make-i3-plan.mjs <输出文件>
 *   node --experimental-test-module-mocks --test --test-name-pattern="^I3|^I5" --test-reporter=spec <输出文件>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = process.argv[2];
if (!out) { console.error('用法：node make-i3-plan.mjs <输出文件>'); process.exit(2); }

let s = fs.readFileSync(path.join(root, 'server', 'test', 'docservice-backpressure.test.mjs'), 'utf8').replace(/\r\n/g, '\n');
const server = pathToFileURL(path.join(root, 'server')).href + '/';
s = s.replace(/from '\.\.\//g, `from '${server}`).replace(/from '\.\//g, `from '${server}test/`);

const edits = [
  ['const HW = 8 * 1024;\n    const MAX = 64 * 1024;', 'const HW = 64 * 1024;   // 计划口径：缺省高水位\n    const MAX = 1024 * 1024; // 计划口径：1 MB 待发'],
  ['const deadline = Date.now() + 10_000;', 'const deadline = Date.now() + 90_000;'],
  ['published < 4000', 'published < 60000'],
  ['gc();\n    const heap0 = process.memoryUsage();', 'gc();\n    const heap0 = process.memoryUsage(); const rss0 = heap0.rss;'],
  ['const grow = (heap1.heapUsed - heap0.heapUsed) / 1024 / 1024;',
    'const grow = (heap1.heapUsed - heap0.heapUsed) / 1024 / 1024; const rssGrow = (heap1.rss - rss0) / 1048576; '
    + 't.diagnostic(`PLAN-I3 HW=${HW} MAX=${MAX} rss0=${(rss0/1048576).toFixed(1)}MB rss1=${(heap1.rss/1048576).toFixed(1)}MB rss增长=${rssGrow.toFixed(1)}MB heapUsed增长=${grow.toFixed(1)}MB arrayBuffers增长=${((heap1.arrayBuffers-heap0.arrayBuffers)/1048576).toFixed(1)}MB pendingBytes@close=${logged[0].pendingBytes}`); '
    + 'assert.ok(rssGrow < 50, `RSS 增长 ${rssGrow.toFixed(1)} MB`);'],
  ['{ timeout: 50_000 }, async (t) => {\n  const rounds', '{ timeout: 400_000 }, async (t) => {\n  const rounds'],
  ["{ timeout: 40_000 }, async (t) => {\n  const env = await startService({ highWaterBytes: 8 * 1024, maxPendingBytes: 64 * 1024 });",
    "{ timeout: 120_000 }, async (t) => {\n  const env = await startService({ highWaterBytes: 64 * 1024, maxPendingBytes: 1024 * 1024 }); t.diagnostic('PLAN-I5 HW=65536 MAX=1048576');"],
  ['const deadline = Date.now() + 8_000;', 'const deadline = Date.now() + 60_000;'],
];
for (const [from, to] of edits) {
  if (!s.includes(from)) { console.error(`没找到要改的一处：${from.slice(0, 60)}`); process.exit(1); }
  s = s.replace(from, to);
}
fs.writeFileSync(out, s);
console.log(`已写 ${out}（${edits.length} 处改动）`);
