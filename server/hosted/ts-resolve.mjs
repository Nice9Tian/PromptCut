/**
 * 让托管组合在纯 Node 下载入素材服务的中间件（`server/asset-service.ts` 与它引的 `vite-plugin-media.ts`）。
 *
 * Node 22.18 / 24 起默认对 `.ts` 做类型剥离，能直接 import；但这两个文件是按 vite 的写法写的，
 * 兄弟模块的相对引用不带扩展名（`./vite-plugin-media`），Node 的 ESM 解析不补扩展名。
 * 这里用同步的解析钩子（`module.registerHooks`）只补这一种情况：**引用方是 `.ts` 文件、说明符是相对路径且不带扩展名**，
 * 依次试 `.ts`、`.mjs`、`.js`，命中哪个用哪个；别的一律原样交给默认解析。
 *
 * 不引任何依赖（远端没有 `node_modules`，也不跑转译）。重复调用只注册一次。
 */
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGISTERED = Symbol.for('promptcut.hosted.ts-resolve');
const RELATIVE = /^\.{1,2}\//;
const HAS_EXT = /\.[cm]?[jt]s$/;

export function registerTsResolve() {
  if (globalThis[REGISTERED]) return;
  if (typeof registerHooks !== 'function') throw new Error('这个 Node 没有 module.registerHooks（要 ≥ 22.15 / 23.5）');
  globalThis[REGISTERED] = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context?.parentURL;
      if (parent && parent.startsWith('file:') && parent.endsWith('.ts') && RELATIVE.test(specifier) && !HAS_EXT.test(specifier)) {
        for (const ext of ['.ts', '.mjs', '.js']) {
          const candidate = new URL(specifier + ext, parent);
          if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
