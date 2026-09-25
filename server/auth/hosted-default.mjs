/**
 * 缺省托管地址（契约 `docs/plan/shared-project-contract.md` 第 3 节、验收 SP6）。
 *
 * `DEFAULT_HOSTED_URL` 是源码里**唯一**写出阿里云托管端 IP 的地方（守门测试 `sp-routing.test.mjs` 的 SPR-6 扫全仓源码，
 * 测试、文档、探针除外）。别处要托管地址，一律经 `resolveHostedUrl` 取。
 *
 * 覆盖顺序（先到先得）：
 * 1. 界面上改过的值（C6.5 接上，调用方以 `ui` 传进来）；
 * 2. 否则环境变量 `PROMPTCUT_HOSTED_URL`；
 * 3. 否则 `DEFAULT_HOSTED_URL`。
 *
 * 空串、只有空白、`null`、`undefined` 都算「没设」，往下一级找。设了但不是 `http(s)://` 或 `ws(s)://` 地址的，抛 TypeError：
 * 用户写错的地址不悄悄换成缺省值，免得连到别处还以为连的是自己设的那台。
 *
 * 浏览器与 Node 通用：不引任何模块；浏览器里没有 `process`，第 2 级自然跳过。
 */

export const DEFAULT_HOSTED_URL = 'http://8.219.80.16:8787';

export const HOSTED_URL_ENV = 'PROMPTCUT_HOSTED_URL';

const isSet = (v) => typeof v === 'string' && v.trim() !== '';

function checked(value, from) {
  const text = value.trim();
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new TypeError(`托管地址（${from}）不是合法的地址`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new TypeError(`托管地址（${from}）必须是 http(s):// 或 ws(s)://`);
  return text.replace(/\/+$/, '');
}

/**
 * 按覆盖顺序取托管地址和它的来处。
 * @param {object} [options]
 * @param {string | null} [options.ui] 界面上改过的值
 * @param {Record<string, string | undefined>} [options.env] 缺省 `process.env`（浏览器里没有就当空）
 * @returns {{ url: string, from: 'ui' | 'env' | 'default' }}
 */
export function hostedUrlChoice({ ui, env = globalThis.process?.env ?? {} } = {}) {
  if (isSet(ui)) return { url: checked(ui, 'ui'), from: 'ui' };
  const fromEnv = env?.[HOSTED_URL_ENV];
  if (isSet(fromEnv)) return { url: checked(fromEnv, 'env'), from: 'env' };
  return { url: DEFAULT_HOSTED_URL, from: 'default' };
}

/** 只要地址：`hostedUrlChoice(options).url` */
export function resolveHostedUrl(options) {
  return hostedUrlChoice(options).url;
}
