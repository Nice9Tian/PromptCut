import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';

export const PUBLIC_ORIGIN = 'https://visuhive.com';
export const NATIVE_ORIGIN = 'http://127.0.0.1:6500';
export const NATIVE_CDP_PORT = 6508;
export function temporaryPath(value) {
  const target = path.resolve(value), relative = path.relative(os.tmpdir(), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('private-tmp-child-required');
  return target;
}
export function publicOptions(args) {
  const flags = new Set(['--run-public', '--dry-preflight']);
  const values = new Set(['--out', '--desktop-exe', '--desktop-profile-root', '--desktop-sha256', '--desktop-source-root']);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if ((!flags.has(key) && !values.has(key)) || Object.hasOwn(parsed, key)) throw new Error('unknown-or-duplicate-option');
    parsed[key] = flags.has(key) ? true : args[++i];
    if (!parsed[key] || typeof parsed[key] === 'string' && parsed[key].startsWith('--')) throw new Error('option-value-required');
  }
  if (parsed['--run-public'] && parsed['--dry-preflight']) throw new Error('conflicting-run-options');
  const desktop = parsed['--desktop-exe'] ? temporaryPath(parsed['--desktop-exe']) : null;
  const profile = parsed['--desktop-profile-root'] ? temporaryPath(parsed['--desktop-profile-root']) : null;
  const sha = parsed['--desktop-sha256'] ?? null;
  const nativeSource = parsed['--desktop-source-root'] ? temporaryPath(parsed['--desktop-source-root']) : null;
  if (desktop && (!profile || !nativeSource || path.extname(desktop).toLowerCase() !== '.exe' || !/^[0-9a-f]{64}$/.test(sha ?? ''))) throw new Error('native-private-build-source-and-sha-required');
  if (!desktop && (profile || sha || nativeSource)) throw new Error('native-option-without-exe');
  const out = temporaryPath(parsed['--out'] ?? path.join(os.tmpdir(), `pc-account-public-${randomUUID()}`));
  if (profile && (out === profile || out.startsWith(profile + path.sep) || profile.startsWith(out + path.sep))) throw new Error('native-profile-and-evidence-must-be-separate');
  return { run:parsed['--run-public'] === true, out, desktop, profile, sha, nativeSource };
}
export function testIdentities() {
  const marker = `pcpub_${randomBytes(6).toString('hex')}`;
  return { marker, accounts:['a', 'b'].map(suffix => ({ name:`${marker}_${suffix}`, password:randomBytes(24).toString('base64url') })) };
}
export function projectFromVisibleLink(value) {
  if (typeof value !== 'string') throw new Error('visible-project-link-required');
  const match = /https:\/\/visuhive\.com\/editor\?project=(sp_[a-z2-7]{26})(?![a-zA-Z0-9_-])/.exec(value);
  if (!match) throw new Error('visible-project-link-required');
  return { link:match[0], projectId:match[1] };
}
export function resourceMetadata(url, type, status, contentType) {
  const parsed = new URL(url);
  if (parsed.origin !== PUBLIC_ORIGIN || !['document', 'stylesheet', 'script', 'font', 'image'].includes(type) ||
      !/^\/(?:editor\/|assets\/)/.test(parsed.pathname)) return null;
  return { path:parsed.pathname, type, status,
    mime:typeof contentType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;\s*charset=[a-z0-9_-]+)?$/i.test(contentType) ? contentType : contentType === undefined ? 'missing' : 'unexpected-content-type' };
}
