/** 未正常收口的旧实例不能在重启时被空ACK抹掉；root提供旧cgroup实际为空的单实例证明。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { X509Certificate, randomUUID } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { syncProjectDirectory } from '../asset-store/project-io.mjs';

export async function openAssetLifecycle({ root, instanceId, cert, recoveryFence, serviceIdentity = null, allowFixtureRecoveryFence = false }) {
  const file = path.join(root, 'asset-instance.json'), lock = path.join(root, '.asset-owner.lock');
  let previous;
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw accountError(503, 'asset-recovery-required'); }
  if (previous) {
    if (previous.v !== 1 || previous.serviceId !== 'asset' || !['running', 'clean'].includes(previous.state) ||
        typeof previous.instanceId !== 'string' || !previous.instanceId || !Number.isInteger(previous.pid) || previous.pid < 1 ||
        !Number.isSafeInteger(previous.startedAt) || previous.startedAt < 0 || !/^[a-f0-9]{64}$/.test(previous.fingerprint256)) throw accountError(503, 'asset-recovery-required');
    if (previous.state !== 'clean') {
      try {
        if (!path.isAbsolute(recoveryFence ?? '')) throw new Error();
        const st = await fs.lstat(recoveryFence), parent = await fs.lstat(path.dirname(recoveryFence));
        if (!st.isFile() || st.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
        if (!allowFixtureRecoveryFence && (process.platform === 'win32' || st.uid !== 0 || parent.uid !== 0 || (st.mode & 0o022) || (parent.mode & 0o022))) throw new Error();
        if (!allowFixtureRecoveryFence) {
          // 每层祖先都由root控制；仅检查直接父目录会留下可替换祖先的缝。
          for (let dir = path.dirname(recoveryFence); ; dir = path.dirname(dir)) {
            const entry = await fs.lstat(dir);
            if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022)) throw new Error();
            if (path.dirname(dir) === dir) break;
          }
          if (!previous.serviceIdentity || previous.serviceIdentity !== serviceIdentity) throw new Error();
        }
        const proof = JSON.parse(await fs.readFile(recoveryFence, 'utf8'));
        if (proof.v !== 1 || proof.serviceId !== 'asset' || proof.previousInstanceId !== previous.instanceId || proof.previousPid !== previous.pid ||
            proof.previousServiceFingerprint256 !== previous.fingerprint256 || proof.closed !== true ||
            !Number.isSafeInteger(proof.observedAt) || proof.observedAt < previous.startedAt || proof.observedAt > Date.now() + 5000 ||
            (allowFixtureRecoveryFence ? !['owned-tree-close', 'cgroup-empty'].includes(proof.kind) : proof.kind !== 'cgroup-empty') ||
            typeof proof.scope !== 'string' || !proof.scope || (!allowFixtureRecoveryFence && proof.scope !== previous.serviceIdentity)) throw new Error();
      } catch { throw accountError(503, 'asset-recovery-required'); }
    }
  }
  const state = { v: 1, serviceId: 'asset', serviceIdentity, instanceId, pid: process.pid, fingerprint256: certificateFingerprint(new X509Certificate(cert).fingerprint256), startedAt: Date.now(), state: 'running' };
  // 清理旧锁只在上述真实关闭证明/clean记录成立时；并发启动不能覆盖另一实例的marker。
  try { const old = JSON.parse(await fs.readFile(lock, 'utf8')); if (!previous || old.instanceId !== previous.instanceId) throw new Error(); await fs.rm(lock); }
  catch (error) { if (error.code !== 'ENOENT') throw accountError(503, 'asset-instance-busy'); }
  let lockHandle;
  try { lockHandle = await fs.open(lock, 'wx'); await lockHandle.writeFile(JSON.stringify(state)); await lockHandle.sync(); }
  catch { throw accountError(503, 'asset-instance-busy'); }
  finally { await lockHandle?.close(); }
  async function persist(value) {
    const temp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file); await syncProjectDirectory(root);
  }
  await persist(state);
  return { file, state, async closeClean() { await persist({ ...state, state: 'clean', closedAt: Date.now() }); await fs.rm(lock); await syncProjectDirectory(root); } };
}
