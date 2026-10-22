#!/usr/bin/env node
/**
 * 0.7.19「低内存档的设置项、提示文字、自动降档都没有了;搜不到残留的调用」(`docs/plan/online-browser-task.md` 做完的标准第 3 条末项)的检查。
 * 只读,不起服务、不改文件。
 *
 *   node scripts/acceptance/v19-lowmem-residue.mjs [--ref <分支或提交>]
 *
 * 缺省查当前检出(工作区);给 --ref 就查那个提交里的文件(`git grep <ref>`、`git cat-file -e <ref>:<路径>`),
 * 用来在合入前先对着 claude/online-browser 核一遍。
 *
 * 查四样(只查 src/ 下非测试的源文件;注释里讲历史的不算残留,所以第 3 条只认引号里的字样):
 *   R1 撤档时删掉的模块文件不在了:src/online/lowMemory.ts、src/editor/lowMemoryBackfill.ts、src/render/lowMemorySettle.ts、
 *      src/editor/lowMemorySearch.ts、src/editor/LowMemoryGate.tsx
 *   R2 没有任何源文件还 import 这几个模块
 *   R3 没有用户看得见的「低内存」字样(引号或反引号里的字符串)
 *   R4 没有低内存档专有的标识:运行状态 'low-memory'、设备设置的 DisplayTierPicker、补发任务的 __pcBackfill
 * 有意留下的(在线浏览器分支报告写明的):成本记录设备串的历史字段名 `lowMemory=`(src/render/costDevice.mjs 的
 * COST_DEVICE_COMPACT_FIELD,改名会让每台桌面版升级后整套卡重测),它不在引号里的「低内存」、也不是 import,不会被上面四条拦。
 *
 * stdout 最后一行是一行 JSON `{ ok, ref, fails, checks }`;退出码 0 过、1 有残留、2 跑不起来(不是 git 检出等)。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const at = argv.indexOf('--ref');
const REF = at >= 0 ? argv[at + 1] : null;
if (at >= 0 && !REF) { console.error('--ref 缺少参数'); process.exit(2); }

const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const SRC = ['--', 'src', ':(exclude)*.test.mjs', ':(exclude)*.test.ts', ':(exclude)*.test.tsx'];

/** git grep -E 的命中行;没有命中回 [];git 出错就退出码 2 */
function grep(pattern) {
  const r = git(['grep', '-n', '-I', '-E', pattern, ...(REF ? [REF] : []), ...SRC]);
  if (r.status === 1) return [];
  if (r.status !== 0) { console.error(`git grep 出错:${r.stderr}`); process.exit(2); }
  return r.stdout.split(/\r?\n/).filter(Boolean);
}
function fileThere(file) {
  if (REF) return git(['cat-file', '-e', `${REF}:${file}`]).status === 0;
  return git(['ls-files', '--error-unmatch', file]).status === 0 || spawnSync(process.execPath, ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(path.join(ROOT, file))})?0:1)`], { windowsHide: true }).status === 0;
}

const checks = [];
const fails = [];
const check = (id, ok, label, hits = []) => {
  checks.push({ id, ok, label, hits: hits.slice(0, 20) });
  if (!ok) fails.push(`${id} ${label}${hits.length ? `:${hits.slice(0, 5).join(' | ')}` : ''}`);
  process.stderr.write(`${ok ? '过' : '不过'}  ${id} ${label}${hits.length ? `(${hits.length} 处)` : ''}\n`);
};

const REMOVED = ['src/online/lowMemory.ts', 'src/editor/lowMemoryBackfill.ts', 'src/render/lowMemorySettle.ts', 'src/editor/lowMemorySearch.ts', 'src/editor/LowMemoryGate.tsx'];
const stillThere = REMOVED.filter(fileThere);
check('R1', stillThere.length === 0, '撤档删掉的模块文件不在了', stillThere);

const imports = grep(`(from|import\\()[[:space:]]*['"][^'"]*/(lowMemory|lowMemoryBackfill|lowMemorySettle|lowMemorySearch|LowMemoryGate)(\\.[a-z]+)?['"]`);
check('R2', imports.length === 0, '没有源文件再 import 这几个模块', imports);

const visible = grep(`["'\`][^"'\`]*低内存[^"'\`]*["'\`]`);
check('R3', visible.length === 0, '没有用户看得见的「低内存」字样(引号里的字符串)', visible);

const idents = grep(`['"]low-memory['"]|DisplayTierPicker|__pcBackfill`);
check('R4', idents.length === 0, "没有低内存档专有的标识('low-memory' 运行状态、DisplayTierPicker、__pcBackfill)", idents);

const ok = fails.length === 0;
console.log(JSON.stringify({ ok, ref: REF || '(工作区)', fails, checks }));
process.exit(ok ? 0 : 1);
