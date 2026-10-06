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

const HOSTED_HOST = '149.88.94.84';

export const DEFAULT_HOSTED_URL = `http://${HOSTED_HOST}:8787`;

/**
 * 换下来的托管端（2026-10-06 用户定：阿里云到期不续，托管端换到新云节点，数据已整体拷过去）。
 * 旧项目文件、本机记的恢复凭证与托管地址里写的是旧主机名；读进来时一律换成新主机名（协议、端口、路径不变），
 * 用户不用重新认证，存回去时写的就是新地址。只换主机名这一段：IP 形式与 sslip.io 形式（含 s1.、s2. 舞台子域）各一条。
 */
export const RETIRED_HOSTED_HOSTS = Object.freeze([
  ['8.219.80.16', HOSTED_HOST],
  ['8-219-80-16.sslip.io', '149-88-94-84.sslip.io'],
]);

const RETIRED_RE = /(^|[/@.])(8\.219\.80\.16|8-219-80-16\.sslip\.io)(?=[:/"\\]|$)/g;
const RETIRED_MAP = new Map(RETIRED_HOSTED_HOSTS);

/** 一个字符串里出现的旧托管主机名换成新的；不含旧主机名的原样返回 */
export function migrateHostedText(text) {
  if (typeof text !== 'string' || !(text.includes('8.219.80.16') || text.includes('8-219-80-16.sslip.io'))) return text;
  return text.replace(RETIRED_RE, (_, pre, host) => pre + RETIRED_MAP.get(host));
}

/**
 * 深拷一份，把其中所有字符串（含对象的键：恢复记录的键是 JSON 串，里面带服务地址）里的旧托管主机名换成新的。
 * 没有要换的就返回原值本身。
 */
export function migrateHostedDeep(value) {
  if (typeof value === 'string') return migrateHostedText(value);
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  if (Array.isArray(value)) {
    const out = value.map((v) => { const m = migrateHostedDeep(v); if (m !== v) changed = true; return m; });
    return changed ? out : value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const mk = migrateHostedText(k), mv = migrateHostedDeep(v);
    if (mk !== k || mv !== v) changed = true;
    out[mk] = mv;
  }
  return changed ? out : value;
}

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
