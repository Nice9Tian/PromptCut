/**
 * 托管组合要部署的文件清单（契约 `docs/plan/shared-project-contract.md` 第 2 节与第 10 节「实现补充」）。
 * `scripts/remote/docservice.mjs deploy-hosted` 按它在本机拼一个暂存目录再整个拷到远端；
 * 单测 SPH-deploy 在暂存目录里真起一次 `main.mjs`，保证清单是闭合的（入口的静态与动态 import 都落在清单里）。
 *
 * 暂存目录的根上另写一个 `package.json`（`{ "type": "module" }`）：部署目录里没有仓库的 package.json，
 * 而 `.ts` 文件按最近的 package.json 判模块格式。
 *
 * 只引 Node 内置模块。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 整个目录拷（递归，跳过 `test/` 子目录与 `*.test.*`） */
export const HOSTED_DEPLOY_DIRS = Object.freeze([
  'server/hosted',
  'server/docservice',
  'server/auth',
  'server/asset-store',
  'server/render-queue',
]);

/** 单个文件：素材服务中间件及其依赖、地址登记 */
export const HOSTED_DEPLOY_FILES = Object.freeze([
  'server/asset-service.ts',
  'server/vite-plugin-media.ts',
  'server/http-guard.mjs',
  'server/asset-announce.mjs',
  'server/render-node/ws-transport.mjs',
]);

/** 暂存目录根上的 package.json 内容 */
export const HOSTED_PACKAGE_JSON = `${JSON.stringify({ name: 'promptcut-hosted', private: true, type: 'module' }, null, 2)}\n`;

const skip = (name) => name === 'test' || name === 'node_modules' || /\.test\.[cm]?[jt]s$/.test(name);

function copyDir(from, to, out) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(ent.name)) continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(src, dst, out);
    else if (ent.isFile()) {
      fs.copyFileSync(src, dst);
      out.push(dst);
    }
  }
}

/**
 * 在 `outDir` 里按清单拼出部署目录（`outDir` 要是空的或不存在）。回拷过去的文件（绝对路径）。
 * @param {string} repoRoot  仓库根目录
 * @param {string} outDir
 */
export function stageHostedFiles(repoRoot, outDir) {
  const root = path.resolve(repoRoot);
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  if (fs.readdirSync(out).length > 0) throw new Error(`stageHostedFiles：${out} 不是空目录`);
  const copied = [];
  for (const rel of HOSTED_DEPLOY_DIRS) copyDir(path.join(root, rel), path.join(out, rel), copied);
  for (const rel of HOSTED_DEPLOY_FILES) {
    const dst = path.join(out, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dst);
    copied.push(dst);
  }
  const pkg = path.join(out, 'package.json');
  fs.writeFileSync(pkg, HOSTED_PACKAGE_JSON);
  copied.push(pkg);
  return copied;
}
