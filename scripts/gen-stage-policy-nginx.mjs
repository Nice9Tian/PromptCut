/**
 * 生成(或核对)nginx 模板里的两个策略片段,见 `server/hosted/stage-policy-nginx.mjs`。
 *
 *   node scripts/gen-stage-policy-nginx.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePolicySnippets } from '../server/hosted/stage-policy-nginx.mjs';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'hosted', 'deploy');
const check = process.argv.includes('--check');
let stale = 0;
for (const [name, text] of Object.entries(stagePolicySnippets())) {
  const file = path.join(dir, name);
  const had = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (had === text) { console.log(`一致  ${name}`); continue; }
  if (check) { console.error(`不一致  ${name}(重新运行本脚本生成)`); stale++; continue; }
  fs.writeFileSync(file, text);
  console.log(`已写  ${name}`);
}
process.exit(stale ? 1 : 0);
