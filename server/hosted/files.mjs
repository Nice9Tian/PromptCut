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
  'server/account',
  'server/auth',
  'server/hosting',
  'server/recovery',
  'server/asset-store',
  'server/render-queue',
]);

/** 单个文件：素材服务中间件及其依赖、地址登记、环境指纹 */
export const HOSTED_DEPLOY_FILES = Object.freeze([
  'server/asset-service.ts',
  'server/vite-plugin-media.ts',
  'server/http-guard.mjs',
  'server/asset-announce.mjs',
  // 地址登记的连接是一个会话（M8 计划 D9）：session-link.mjs，它再引 ws-transport.mjs 的退避与子协议常量
  'server/render-node/session-link.mjs',
  'server/render-node/ws-transport.mjs',
  // 成本记录模块按原始环境算指纹（与预渲染结果键同一套归一规则，C10 其余第 3 节）
  'server/render-node/fingerprint.mjs',
]);

/** 暂存目录根上的 package.json 内容 */
export const HOSTED_PACKAGE_JSON = `${JSON.stringify({ name: 'promptcut-hosted', private: true, type: 'module' }, null, 2)}\n`;

// `deploy`：server/hosted/deploy/ 是服务器配置模板（nginx、sysctl），不是运行时文件，不拷到远端
const skip = (name) => name === 'test' || name === 'deploy' || name === 'node_modules' || /\.test\.[cm]?[jt]s$/.test(name);

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

/** 独立asset入口的literal import闭包；不改变旧hosted打包策略，不携带私钥/依赖安装。 */
export const HOSTED_ASSET_DEPLOY_FILES = Object.freeze([
  'server/account/agent-instance-authority.mjs',
  'server/account/agent-instance-internal.mjs',
  'server/account/client.mjs',
  'server/account/ledger.mjs',
  'server/account/protocol.mjs',
  'server/account/run-asset-protocol.mjs',
  'server/asset-announce.mjs',
  'server/asset-client.ts',
  'server/asset-service.ts',
  'server/asset-store/atomic.mjs',
  'server/asset-store/blob-store.mjs',
  'server/asset-store/client.mjs',
  'server/asset-store/fs-store.mjs',
  'server/asset-store/index.mjs',
  'server/asset-store/memory-store.mjs',
  'server/asset-store/project-access.mjs',
  'server/asset-store/project-io.mjs',
  'server/asset-store/project-revocations.mjs',
  'server/asset-store/project-stores.mjs',
  'server/asset-store/px-evict.mjs',
  'server/asset-store/ranges.mjs',
  'server/asset-store/service-usage.mjs',
  'server/asset-store/shots-thumb.mjs',
  'server/asset-store/stream-store.mjs',
  'server/auth/asset-tickets.mjs',
  'server/auth/delegation.mjs',
  'server/auth/handshake.mjs',
  'server/auth/hosted-default.mjs',
  'server/auth/invite.mjs',
  'server/auth/origin.mjs',
  'server/auth/protocol.mjs',
  'server/auth/service-identity.mjs',
  'server/auth/store.mjs',
  'server/auth/tickets.mjs',
  'server/bake-store.mjs',
  'server/bakery/ffmpeg.mjs',
  'server/bandwidth-gate.mjs',
  'server/hosted/asset-doc-client.mjs',
  'server/hosted/asset-lifecycle.mjs',
  'server/hosted/asset-main.mjs',
  'server/hosted/asset-run-access.mjs',
  'server/hosted/asset-run-client.mjs',
  'server/hosted/asset-runtime.mjs',
  'server/hosted/run-assets-metadata.mjs',
  'server/hosted/run-assets-metadata-rpc.mjs',
  'server/hosted/run-assets-head-client.mjs',
  'server/hosted/ts-resolve.mjs',
  'server/http-guard.mjs',
  'server/media-pull.mjs',
  'server/media-tiers.mjs',
  'server/recovery/descriptor.mjs',
  'server/recovery/paths.mjs',
  'server/recovery/relocation.mjs',
  'server/render-node/session-link.mjs',
  'server/render-node/ws-transport.mjs',
  'server/render-role.mjs',
  'server/upload-queue.mjs',
  'server/vite-plugin-media.ts',
]);

export function stageHostedAssetFiles(repoRoot, outDir) {
  const root = path.resolve(repoRoot), out = path.resolve(outDir), copied = [];
  fs.mkdirSync(out, { recursive: true });
  if (fs.readdirSync(out).length) throw new Error('stageHostedAssetFiles: destination must be empty');
  for (const rel of HOSTED_ASSET_DEPLOY_FILES) { const dst = path.join(out, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(root, rel), dst); copied.push(dst); }
  const pkg = path.join(out, 'package.json'); fs.writeFileSync(pkg, HOSTED_PACKAGE_JSON); copied.push(pkg);
  return copied;
}
