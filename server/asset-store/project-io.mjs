/** 项目文件读写收口：异步open/发布/回退都属于lease，不以HTTP finish替代实际I/O完成。 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const locks = new Map();
export const publicationMarker = target => `${target}.project-publication.json`;
export async function projectFileAccepted(target) { try { await fs.stat(publicationMarker(target)); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; return true; } }

/** 重启仅回收本项目未完成发布的意图；路径严格限制在本目录，不能据文件内容碰其它项目。 */
export function recoverProjectPublications(root) {
  const base = path.resolve(root);
  const walk = dir => {
    let entries; try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('project-publication-symlink');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith('.project-publication.json')) continue;
      const record = JSON.parse(fsSync.readFileSync(file, 'utf8'));
      for (const value of [record.target, record.temp, record.backup].filter(Boolean)) if (!path.resolve(value).startsWith(base + path.sep) || path.dirname(path.resolve(value)) !== dir) throw new Error('invalid-project-publication-path');
      if (record.v !== 1 || publicationMarker(record.target) !== file) throw new Error('invalid-project-publication');
      if (record.backup) fsSync.renameSync(record.backup, record.target);
      else fsSync.rmSync(record.target, { force: true });
      fsSync.rmSync(record.temp, { force: true }); fsSync.rmSync(file);
    }
  };
  walk(base);
}

/** 同目标串行事务：未通过commit重核的文件带持久intent且不可读；回退完成才关闭lease资源。 */
export function publishProjectFile({ temp, target, assert, lease, io = fs, replace = false, afterCommit = async () => {}, rollback = async () => {} }) {
  const work = async () => {
    let had = false, backup = null, intent = false, changed = false, afterStarted = false;
    const marker = publicationMarker(target);
    try {
      await assert();
      if (!await projectFileAccepted(target)) throw new Error('project-publication-pending');
      try { await io.stat(target); had = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (had && !replace) { await io.rm(temp, { force: true }); afterStarted = true; await afterCommit(); await assert(); return { had }; }
      if (had) { backup = `${target}.${crypto.randomUUID()}.backup`; await io.copyFile(target, backup); }
      const handle = await io.open(marker, 'wx');
      try { await handle.writeFile(JSON.stringify({ v: 1, target, temp, backup })); await handle.sync(); } finally { await handle.close(); }
      intent = true;
      await assert();
      await io.rename(temp, target); changed = true;
      afterStarted = true; await afterCommit();
      await assert(); // 接受发布点；之后撤销保留这份已接受内容，仍等intent清理实际收口。
      await io.rm(marker); intent = false;
      if (backup) await io.rm(backup, { force: true }).catch(() => {}); // 已接受内容不能因私有backup清理失败被回滚。
      return { had };
    } catch (error) {
      try {
        if (changed) { if (backup) await io.rename(backup, target); else await io.rm(target, { force: true }); }
        if (afterStarted) await rollback();
        if (intent) { await io.rm(marker, { force: true }); intent = false; }
        if (backup) await io.rm(backup, { force: true });
      } catch (cleanupError) { lease?.failClose(cleanupError); throw new AggregateError([error, cleanupError], 'project-publication-cleanup-failed'); }
      throw error;
    } finally { await io.rm(temp, { force: true }); }
  };
  const previous = locks.get(target) ?? Promise.resolve();
  const execute = () => previous.catch(() => {}).then(work);
  const result = lease ? lease.run(execute) : execute();
  locks.set(target, result);
  void result.finally(() => { if (locks.get(target) === result) locks.delete(target); }).catch(() => {});
  return result;
}

export function readProjectFile(file, lease, io = fs) {
  if (!lease) return io.readFile(file);
  return lease.run(async () => {
    let handle;
    try {
      if (!await projectFileAccepted(file)) throw new Error('project-publication-pending');
      await lease.assert();
      handle = await io.open(file, 'r');
      lease.trackHandle(handle);
      const bytes = await handle.readFile({ signal: lease.signal });
      await lease.assert();
      return bytes;
    } finally { await handle?.close(); }
  });
}
