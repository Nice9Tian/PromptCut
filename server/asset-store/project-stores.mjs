/** 项目物理素材库；不拥有项目/成员权威。只由可信服务接线传 projectId，不从 HTTP body 选库。 */
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createFsStore } from './fs-store.mjs';
import { createMemoryStore } from './memory-store.mjs';

const ROOTS = Symbol.for('promptcut.asset.project-roots.v2');
const roots = () => (globalThis[ROOTS] ??= new Map());
export const PROJECT_ASSET_LAYOUT_VERSION = 2;
export function assertProjectId(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new TypeError('invalid-project-id');
  return value;
}
export function projectStorageKey(projectId) { return crypto.createHash('sha256').update(assertProjectId(projectId)).digest('hex'); }
/** 内部 root 注册表使用全局 symbol，兼容 Vite 打包与直接模块实例；环境变量不能覆盖项目 root。 */
export function projectScopeOfRoot(root) { return roots().get(path.resolve(root)) ?? null; }

/**
 * createProjectAssetStores({ dir, kind:'fs'|'memory', contentTypeForExt?, chunkSize? })
 * -> { v:2, project(id):{projectId,root,dir,stores:{media,snap,px}}, store(id,ns), removeProject(id) }
 * 每项目独立完整库/分片/索引/tiers/queue/px usage；同 hash 不跨库复用。removeProject 是内部删除机制，非用户权限决策。
 */
export function createProjectAssetStores({ dir, kind = 'fs', contentTypeForExt, chunkSize } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('project asset dir required');
  if (!['fs', 'memory'].includes(kind)) throw new TypeError('unsupported-project-store');
  const base = path.resolve(dir), projects = new Map(), removed = new Set();
  function project(projectId) {
    assertProjectId(projectId);
    if (removed.has(projectId)) throw Object.assign(new Error('project-gone'), { code: 'project-gone', status: 404 });
    if (projects.has(projectId)) return projects.get(projectId);
    const root = path.join(base, 'projects', projectStorageKey(projectId));
    const dirs = { media: path.join(root, 'out', 'media'), snap: path.join(root, 'out', 'asset-store', 'snap'), px: path.join(root, 'out', 'asset-store', 'px') };
    let active = true;
    const assertActive = () => { if (!active) throw Object.assign(new Error('project-gone'), { code: 'project-gone', status: 404 }); };
    const stores = {};
    for (const ns of Object.keys(dirs)) {
      const hooks = { contentTypeForExt: ext => ext === 'html' ? 'text/html; charset=utf-8' : ext === 'm4s' ? 'video/iso.segment' : contentTypeForExt?.(ext) ?? 'application/octet-stream' };
      const raw = kind === 'fs' ? createFsStore({ dir: dirs[ns], hooks, chunkSize }) : createMemoryStore({ chunkSize });
      Object.defineProperty(raw, 'projectId', { value: projectId });
      Object.defineProperty(raw, 'namespace', { value: ns });
      stores[ns] = new Proxy(raw, { get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? (...args) => { assertActive(); return value.apply(target, args); } : value; } });
    }
    const scope = Object.freeze({ v: 2, projectId, root, dir: root, dirs: Object.freeze(dirs), stores: Object.freeze(stores), assertActive, retire: () => { active = false; } });
    roots().set(root, scope);
    projects.set(projectId, scope);
    return scope;
  }
  return {
    v: 2, dir: base, project,
    store(projectId, ns) { if (!['media', 'snap', 'px'].includes(ns)) throw new TypeError('invalid-namespace'); return project(projectId).stores[ns]; },
    async removeProject(projectId) {
      const p = project(projectId);
      // 从注册表撤去前先移走物理目录；旧引用不能被重用为新库。调用者必须先关闭该项目任务/流。
      removed.add(projectId);
      p.retire();
      if (kind === 'fs') await fs.rm(p.dir, { recursive: true, force: true });
      projects.delete(projectId);
      // 保持 root 身份，避免删除后迟到代码退回全局环境路径。中央 owner 必须授权重新创建。
      return { projectId, removed: true };
    },
  };
}
