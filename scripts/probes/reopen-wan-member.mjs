/** External member on a machine that can only dial out: authenticate into a reopened room through the
 * temporary public entry, read ticketed assets, then make one edit and read the project back.
 * The member chose its own password earlier (reopen-sealed.mjs member-secret, same --dir) and the
 * host admitted the sealed copy; nothing secret is passed on the command line or printed here.
 * The edit comes last on purpose: the host waits for it, so it must not arrive while the assets
 * are still being read.
 *
 *   node scripts/probes/reopen-wan-member.mjs --dir <owned dir> --service <url> --room <id> --expected <project name>
 *     [--asset-hash <sha256> --asset-size <bytes>] [--edit <new project name>]
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
const peerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reopen-wan-peer.mjs');

/** One connection of the existing WAN peer. It reads its configuration, password included, from stdin only. */
async function connect(step, more) {
  const peer = spawn(process.execPath, [peerScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; peer.stdout.on('data', b => { out += b; }); peer.stderr.on('data', b => { err += b; });
  const timer = setTimeout(() => peer.kill(), 120000);
  peer.stdin.end(JSON.stringify({ op: 'member', dir: path.resolve(dir), service, roomId, password, expected, ...more }) + '\n');
  const exitCode = await new Promise(resolve => peer.once('exit', resolve)); clearTimeout(timer);
  let result; try { result = JSON.parse(out.trim()); } catch { result = null; }
  if (exitCode === 0 && result?.ok) return result;
  // On failure the peer names only the step it was in.
  console.log(JSON.stringify({ ok: false, step, stage: /"stage":"([a-z-]{1,40})"/.exec(err)?.[1] ?? null, error: 'external member failed; secrets omitted', service, exitCode }));
  process.exit(1);
}

const read = asset ? await connect('read-assets', { asset }) : null;
const last = edit ? await connect('edit', { edit }) : read ?? await connect('open', {});
console.log(JSON.stringify({ ok: true, roomId: last.roomId, username: last.username, role: last.role, service, revBeforeEdit: last.rev, edit: edit ?? null,
  assets: read?.assets ?? [], connections: [read, edit ? last : null].filter(Boolean).length || 1, restoredDeviceIdentityOnLastConnection: last.restoredDeviceIdentity }));
