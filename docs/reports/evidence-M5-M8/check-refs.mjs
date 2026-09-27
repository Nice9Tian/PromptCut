/**
 * 核对 `EVIDENCE-M5-M8.md` 里引用的文件名与提交号都真的存在，并确认文中没有 constraints.md「用词」一条禁用的两个旧词。
 *   - 反引号里的 `<提交>:<路径>`：该提交里有这个文件；
 *   - 反引号里 7～40 位十六进制：是仓库里的一个提交（`git cat-file -e <x>^{commit}`）；
 *   - 反引号里以 .md / .mjs / .ts / .tsx / .cjs 结尾的文件名：在当前工作区能找到（按路径，或按文件名在仓库文件与 docs/ 里找），
 *     找不到再到分支 claude/m8-plan、claude/m8-report 里找（m8-plan.md、REPORT-M5-M8.md 目前只在分支上）。
 * 用法（仓库根）：node docs/reports/evidence-M5-M8/check-refs.mjs [文件]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const file = process.argv[2] ?? path.join(root, 'docs', 'reports', 'EVIDENCE-M5-M8.md');
const text = fs.readFileSync(file, 'utf8');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const ok = (fn) => { try { fn(); return true; } catch { return false; } };

const tracked = git('ls-files').split('\n').filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
const all = [...tracked, ...untracked];
const byBase = new Map();
for (const p of all) { const b = path.posix.basename(p); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(p); }
const branchFiles = {};
for (const br of ['claude/m8-plan', 'claude/m8-report']) branchFiles[br] = ok(() => git('rev-parse', '--verify', br)) ? git('ls-tree', '-r', '--name-only', br).split('\n') : [];

const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
const results = [];
const seen = new Set();
for (const s of spans) {
  if (seen.has(s)) continue;
  seen.add(s);
  let m;
  if ((m = s.match(/^([0-9a-f]{7,40}):(\S+)$/))) {
    results.push({ kind: 'commit:path', ref: s, ok: ok(() => git('cat-file', '-e', `${m[1]}:${m[2]}`)) });
  } else if (/^[0-9a-f]{7,40}$/.test(s)) {
    results.push({ kind: 'commit', ref: s, ok: ok(() => git('cat-file', '-e', `${s}^{commit}`)) });
  } else if ((m = s.match(/(^|[\s(（])([\w./-]+\.(?:md|mjs|ts|tsx|cjs))$/))) {
    const name = m[2];
    let where = null;
    if (all.includes(name) || fs.existsSync(path.join(root, name))) where = name;
    else if (byBase.has(path.posix.basename(name))) {
      const hits = byBase.get(path.posix.basename(name)).filter((p) => p.endsWith(name));
      if (hits.length) where = hits[0];
    }
    if (!where) for (const [br, list] of Object.entries(branchFiles)) {
      const hit = list.find((p) => p.endsWith(name));
      if (hit) { where = `${br}:${hit}`; break; }
    }
    results.push({ kind: 'file', ref: name, ok: !!where, where });
  }
}
const banned = [String.fromCodePoint(0x70d8, 0x7119), String.fromCodePoint(0x51bb, 0x7ed3)].filter((w) => text.includes(w));
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.kind.padEnd(11)} ${r.ref}${r.where && r.where !== r.ref ? `  -> ${r.where}` : ''}`);
console.log(JSON.stringify({ checked: results.length, commits: results.filter((r) => r.kind === 'commit').length, commitPaths: results.filter((r) => r.kind === 'commit:path').length, files: results.filter((r) => r.kind === 'file').length, missing: bad.map((r) => r.ref), bannedWords: banned }));
process.exit(bad.length || banned.length ? 1 : 0);
