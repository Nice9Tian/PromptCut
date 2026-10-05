/** External member on a machine that can only dial out: authenticate into a reopened room through the
 * temporary public entry, make one edit, read it back and read ticketed assets.
 * The member chose its own password earlier (reopen-sealed.mjs member-secret, same --dir) and the
 * host admitted the sealed copy; nothing secret is passed on the command line or printed here.
 *
 *   node scripts/probes/reopen-wan-member.mjs --dir <owned dir> --service <url> --room <id> --expected <project name>
 *     [--edit <new project name>] [--asset-hash <sha256> --asset-size <bytes>]
 */
import '../lib/no-user-dirs.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownedMemberSecret } from './reopen-sealed.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg('--dir'), service = arg('--service'), roomId = arg('--room'), expected = arg('--expected'), edit = arg('--edit');
assert(dir && service && roomId && expected, '--dir, --service, --room and --expected are required');
assert(/^https:\/\/[a-z0-9.-]+$/.test(service), 'service must be an https origin');
const asset = arg('--asset-hash') ? { hash: arg('--asset-hash'), size: Number(arg('--asset-size')) } : undefined;
const { password } = ownedMemberSecret(path.resolve(dir), 'wan-member');
// The peer reads its configuration, including the password, from stdin only.
const peer = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'reopen-wan-peer.mjs')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let out = ''; peer.stdout.on('data', b => { out += b; }); peer.stderr.resume();
const timer = setTimeout(() => peer.kill(), 120000);
peer.stdin.end(JSON.stringify({ op: 'member', dir: path.resolve(dir), service, roomId, password, expected, edit, asset }) + '\n');
const code = await new Promise(resolve => peer.once('exit', resolve)); clearTimeout(timer);
let result; try { result = JSON.parse(out.trim()); } catch { result = { ok: false, error: 'external member failed; secrets omitted' }; }
console.log(JSON.stringify({ ...result, service, edit: result.ok ? edit ?? null : undefined, exitCode: code }));
process.exitCode = code === 0 && result.ok ? 0 : 1;
