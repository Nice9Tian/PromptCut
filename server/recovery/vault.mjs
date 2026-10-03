/** Device-owned identity store. Atomic encrypted snapshots; no secrets in project files. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { identityKey, roomKey } from './descriptor.mjs';

function atomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let n = 0; ; n++) {
      try { fs.renameSync(tmp, file); break; } catch (e) {
        if (n >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (n + 1));
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* already renamed */ } }
}
export function systemProtector(dir) {
  if (process.platform === 'win32') {
    const run = (mode, value) => {
      const script = "Add-Type -AssemblyName System.Security; $j=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Convert]::FromBase64String($j.value); $e=[Text.Encoding]::UTF8.GetBytes('PromptCut-collaboration-v1'); if($j.mode -eq 'seal'){$r=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; [Console]::Write([Convert]::ToBase64String($r))";
      const p = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: JSON.stringify({ mode, value: Buffer.from(value).toString('base64') }), windowsHide: true, encoding: 'utf8', timeout: 15000,
      });
      if (p.status !== 0) throw new Error('系统保护存储不可用');
      return Buffer.from(p.stdout.trim(), 'base64');
    };
    return { kind: 'dpapi-current-user', seal: value => run('seal', value), open: value => run('open', value) };
  }
  // Non-Windows deployments: a private device key, separated from the ciphertext. Never a hardware-derived key.
  const file = path.join(dir, 'device.key');
  if (!fs.existsSync(file)) atomic(file, randomBytes(32));
  const key = fs.readFileSync(file); if (key.length !== 32) throw new Error('设备保护密钥损坏');
  return {
    kind: 'private-device-key',
    seal(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from('pc-collab-v1')); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
    open(value) { const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAAD(Buffer.from('pc-collab-v1')); d.setAuthTag(value.subarray(-16)); return Buffer.concat([d.update(value.subarray(12, -16)), d.final()]); },
  };
}
export function openRecoveryVault({ dir, protector, write = atomic }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const crypt = protector || systemProtector(dir);
  const file = path.join(dir, 'identities.json');
  const empty = () => ({ version: 1, identities: {}, bindings: {}, revoked: {}, hosts: {}, journals: {}, settings: {}, unregister: {} });
  let state = empty();
  const read = () => {
    if (!fs.existsSync(file)) { state = empty(); return; }
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j.version !== 1 || j.protection !== crypt.kind || typeof j.payload !== 'string') throw new Error();
      const bytes = crypt.open(Buffer.from(j.payload, 'base64'));
      if (createHash('sha256').update(bytes).digest('hex') !== j.digest) throw new Error();
      const v = JSON.parse(bytes);
      if (v.version !== 1 || !v.identities || !v.bindings || !v.revoked || !v.hosts) throw new Error();
      state = { ...v, journals: v.journals ?? {}, settings: v.settings ?? {}, unregister: v.unregister ?? {} };
    } catch { throw new Error('协作恢复数据损坏；保留原数据，请从备份恢复或重新认证'); }
  };
  read();
  const lockFile = path.join(dir, 'identities.lock');
  const acquire = () => {
    for (let n = 0; n < 120; n++) {
      const tmp = `${lockFile}.owner-${process.pid}-${randomBytes(6).toString('hex')}`;
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); fs.linkSync(tmp, lockFile); return fd; }
        catch (e) { fs.closeSync(fd); throw e; }
        finally { fs.unlinkSync(tmp); }
      }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid;
          if (Number.isSafeInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); } catch (err) { if (err.code === 'ESRCH') { fs.unlinkSync(lockFile); continue; } }
          }
        } catch { /* A partly written or damaged lock is never guessed away. */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    throw new Error('协作恢复记录正在被另一个实例保存，请重试');
  };
  const change = fn => {
    const lock = acquire();
    try {
    read();
    const draft = structuredClone(state); fn(draft);
    const bytes = Buffer.from(JSON.stringify(draft));
    const encoded = JSON.stringify({ version: 1, protection: crypt.kind, digest: createHash('sha256').update(bytes).digest('hex'), payload: crypt.seal(bytes).toString('base64') });
    if (fs.existsSync(file)) write(`${file}.bak`, fs.readFileSync(file));
    write(file, encoded); state = draft;
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  };
  return {
    protection: crypt.kind,
    list: descriptor => { read(); return Object.values(state.identities).filter(r => roomKey(r) === roomKey(descriptor)).map(r => structuredClone(r)); },
    select(descriptor, contentId) {
      read();
      if (state.revoked[roomKey(descriptor)]) return { revoked: true, identities: [] };
      const identities = Object.values(state.identities).filter(r => roomKey(r) === roomKey(descriptor)).map(r => structuredClone(r));
      const bound = state.bindings[JSON.stringify([roomKey(descriptor), contentId])];
      return { identities, selected: identities.find(r => identityKey(r) === bound) ?? (identities.length === 1 ? identities[0] : null), host: structuredClone(state.hosts[roomKey(descriptor)] ?? null), journal: structuredClone(state.journals[JSON.stringify([roomKey(descriptor), contentId])] ?? null) };
    },
    remember(record, contentId) {
      if (!['creator', 'member'].includes(record.as) || typeof record.username !== 'string' || !record.username || !/^[A-Za-z0-9_-]{43}$/.test(record.key)) throw new TypeError('身份恢复记录无效');
      const k = identityKey(record);
      change(s => { s.identities[k] = structuredClone(record); if (contentId) s.bindings[JSON.stringify([roomKey(record), contentId])] = k; });
    },
    host(descriptor) { read(); return structuredClone(state.hosts[roomKey(descriptor)] ?? null); },
    settings(descriptor) { read(); return structuredClone(state.settings[roomKey(descriptor)] ?? null); },
    saveSettings(descriptor, value) { change(s => { s.settings[roomKey(descriptor)] = structuredClone(value); }); },
    journal(descriptor, contentId, journal) {
      if (journal && (journal.version !== 1 || journal.projectId !== descriptor.roomId || !Array.isArray(journal.pending) || !Array.isArray(journal.project?.tracks))) throw new Error('离线操作记录无效');
      change(s => { s.journals[JSON.stringify([roomKey(descriptor), contentId])] = structuredClone(journal); });
    },
    bindHost(descriptor, deviceId) {
      read();
      if (state.revoked[roomKey(descriptor)]) throw new Error('房间已注销');
      const prior = state.hosts[roomKey(descriptor)];
      if (prior && prior.deviceId !== deviceId) throw new Error('主机设备冲突');
      if (!prior) change(s => {
        if (s.revoked[roomKey(descriptor)] || s.hosts[roomKey(descriptor)] && s.hosts[roomKey(descriptor)].deviceId !== deviceId) throw new Error('房间已注销或主机冲突');
        s.hosts[roomKey(descriptor)] ??= { deviceId, registrationKey: randomBytes(32).toString('base64url') };
      });
      return this.host(descriptor);
    },
    pendingUnregister() { read(); return Object.values(state.unregister ?? {}).map(r => structuredClone(r)); },
    completeUnregister(descriptor) { change(s => { delete s.unregister?.[roomKey(descriptor)]; }); },
    revoke(descriptor) { change(s => {
      s.revoked[roomKey(descriptor)] = Date.now();
      const host = s.hosts[roomKey(descriptor)];
      if (host) { s.unregister ??= {}; s.unregister[roomKey(descriptor)] = { descriptor, registrationKey: host.registrationKey }; }
      delete s.hosts[roomKey(descriptor)];
      delete s.settings[roomKey(descriptor)];
      for (const [k, r] of Object.entries(s.identities)) if (roomKey(r) === roomKey(descriptor)) delete s.identities[k];
    }); },
  };
}
