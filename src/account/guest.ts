/**
 * 游客身份：没有网站账号的人进来时随机分配的那一个身份（2026-10-23 用户定）。
 *
 * 为什么要有它：在线页面的开始页原先只有一个登录框（`src/StartPage.tsx` 的 `OnlineStartPage`），
 * 没账号的人一件事也做不了；本地共享项目也得自己先想一个用户名（`src/editor/sync/JoinForm.tsx`）。
 * 游客身份把这一步去掉 —— 进来就有一个 ID 和一张头像。
 *
 * 身份在这台机器 / 这个浏览器里记住（`localStorage`）：刷新、关掉重开还是同一个人。
 * 不记住的话本地协作里别人每看一眼都是张新面孔，成员列表也对不上。想换就 `resetGuest()`，界面上叫「换一个」。
 *
 * 头像不用图片资源，和 `src/editor/right/RoleAvatar.tsx` 一个路子：颜色和图形都从 ID 哈希出来，
 * 所以同一个 ID 每次画出来都一样（不能用 `Math.random`，否则每次重渲染头像都在变），不同 ID 之间几乎不会撞。
 *
 * 游客能做什么、不能做什么由服务端说了算（`server/account/guest.mjs`）：这一份只管「我是谁、我长什么样」。
 */

/** 游客编号的样子：`gst_` + 24 位十六进制。和账号编号 `acc_` + 24 位（`server/account/protocol.mjs`）同一个形状，服务端好认也好校验 */
export const GUEST_ID_RE = /^gst_[0-9a-f]{24}$/;

/**
 * 界面上说的那几个限额。真正说了算的是服务端（`server/account/guest.mjs` 的 `GUEST_LIMITS`）——
 * `videos` 只数视频（小档预览不算），图片、音频不计数；`assetMB` 是每一条源文件（不管什么类型）的上限。
 * 这里只是为了在界面上先讲清楚，省得人传到一半被拒。两边的数必须一致，`guest.test.mjs` 有一条守着。
 */
export const GUEST_LIMITS = Object.freeze({ projects: 1, videos: 3, assetMB: 100, ttlDays: 3 });

/** 进来之前先说清楚游客能干到哪一步，免得做了一半才发现存不住 */
export const GUEST_LIMITS_TEXT =
  `游客可以建 ${GUEST_LIMITS.projects} 个项目、传 ${GUEST_LIMITS.videos} 条视频（每条源文件不超过 ${GUEST_LIMITS.assetMB} MB），` +
  `${GUEST_LIMITS.ttlDays} 天后自动清理；进别人的项目只能查看。要长期保存，注册一个账号。`;

/** 身份在本机存哪儿。带版本号：以后字段改了，老的直接当没有、重新随机，不去写迁移 */
export const GUEST_STORAGE_KEY = 'pc.guest.v1';

export interface GuestIdentity {
  /** `gst_` + 24 位十六进制 */
  id: string;
  /** 显示名：「游客-7F3A」。后四位取自 ID，所以看到的名字和 ID 对得上 */
  name: string;
  /** 什么时候分配的（毫秒）。三天清理是服务端按它自己的记录算的，这里只用来排查 */
  createdAt: number;
  /**
   * 云端那一张令牌（`server/account/guest.mjs` 签的），只有进过云端才有。
   * 持有即身份：和账号的访问令牌一样，不进地址、不进日志，只留在这里和内存里。
   */
  token?: string;
  /** 令牌什么时候过期（毫秒） */
  expiresAt?: number;
  /**
   * 他自己建的那一个云端项目（游客只能建一个）。游客没有「我创建的」列表可查
   * ——那张表是向官网账号要的——所以回来时靠这里找回自己的项目。
   */
  project?: { id: string; name: string };
}

/** 头像长什么样：色相 + 第几号图形。两样都是从 ID 推出来的，不单独存 */
export interface GuestAvatarSpec {
  /** 0～359 */
  hue: number;
  /** `GUEST_SHAPES` 的下标 */
  shape: number;
}

/**
 * 头像里的图形。十二个，都是一笔能画完的几何形：和界面上那套线条图标同一种画法
 * （`viewBox` 24×24、`stroke-width` 1.6、圆头），这样放在成员列表里不会显得突兀。
 *
 * 每条就是 `<path d>` 的内容，闭合的那几个自己带 `Z`。
 */
export const GUEST_SHAPES: readonly string[] = [
  'M12 5.2a6.8 6.8 0 1 0 0 13.6a6.8 6.8 0 1 0 0-13.6',                      // 圆
  'M12 5.4 19 18.6 H5 Z',                                                   // 三角
  'M6.2 6.2 H17.8 V17.8 H6.2 Z',                                            // 方
  'M12 4.8 19.2 12 12 19.2 4.8 12 Z',                                       // 菱形
  'M12 4.6 14.1 9.6 19.4 10 15.4 13.5 16.6 18.8 12 16 7.4 18.8 8.6 13.5 4.6 10 9.9 9.6 Z', // 星
  'M12 4.4 18.6 8.2 V15.8 L12 19.6 5.4 15.8 V8.2 Z',                        // 六边形
  'M12 6 A6 6 0 0 1 12 18 A6 6 0 0 1 12 6 M12 9.4 A2.6 2.6 0 0 1 12 14.6 A2.6 2.6 0 0 1 12 9.4', // 同心环
  'M5.6 18.4 18.4 5.6 M5.6 12.8 12.8 5.6 M11.2 18.4 18.4 11.2',             // 斜条纹
  'M4.8 13.5c1.8-3 3.6-3 5.4 0s3.6 3 5.4 0 3.6-3 3.6-3',                    // 波浪
  'M5.4 15.6 A6.6 6.6 0 0 1 18.6 15.6 Z',                                   // 半圆
  'M12 5 V19 M5 12 H19',                                                    // 十字
  'M8.4 8.4 h.01 M15.6 8.4 h.01 M8.4 15.6 h.01 M15.6 15.6 h.01 M12 12 h.01', // 五点
];

/**
 * 从字符串定出 32 位。要求只有一条：同一个 ID 每次都得到同一个数。
 * FNV-1a：短字符串上散得开，一行能写完，不值得为它拉一个依赖。
 */
function hash32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 色相和图形各取哈希的不同几位，免得「同色的一定同形」 */
export function guestAvatar(id: string): GuestAvatarSpec {
  const h = hash32(id);
  return { hue: h % 360, shape: (h >>> 11) % GUEST_SHAPES.length };
}

/** 显示名。取 ID 末四位大写，看到的名字和 ID 对得上，出事时好核对 */
export function guestName(id: string): string {
  return `游客-${id.slice(-4).toUpperCase()}`;
}

export function isGuestId(value: unknown): value is string {
  return typeof value === 'string' && GUEST_ID_RE.test(value);
}

/** 24 位十六进制的随机串。`crypto.getRandomValues` 在浏览器和 Node 18+ 都有 */
export function newGuestId(random: (n: number) => Uint8Array = bytes): string {
  return 'gst_' + Array.from(random(12), b => b.toString(16).padStart(2, '0')).join('');
}

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function guestFrom(id: string, createdAt: number, cloud?: { token: string; expiresAt: number },
  project?: { id: string; name: string }): GuestIdentity {
  return { id, name: guestName(id), createdAt,
    ...(cloud ? { token: cloud.token, expiresAt: cloud.expiresAt } : {}),
    ...(project ? { project } : {}) };
}

/**
 * 本机存身份的地方。无痕窗口、禁了站点数据、或者在 Node 里跑测试时 `localStorage` 可能不存在、
 * 也可能一读就抛；读写都兜住，取不到就当「这次没记住」，不让它把进入流程挡下来。
 */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(given?: Store | null): Store | null {
  if (given) return given;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 本机记着的那个游客身份；没有、或者存坏了，回 null */
export function loadGuest(given?: Store | null): GuestIdentity | null {
  const s = store(given);
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(GUEST_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GuestIdentity> | null;
    if (!isGuestId(value?.id)) return null;
    // 名字不单独信存下来的那一份:ID 对得上就按 ID 重算,免得手改过存档之后名字和 ID 对不上
    const cloud = typeof value?.token === 'string' && value.token && typeof value?.expiresAt === 'number'
      ? { token: value.token, expiresAt: value.expiresAt } : undefined;
    const project = typeof value?.project?.id === 'string' && value.project.id && typeof value.project?.name === 'string'
      ? { id: value.project.id, name: value.project.name } : undefined;
    return guestFrom(value.id, typeof value?.createdAt === 'number' ? value.createdAt : Date.now(), cloud, project);
  } catch {
    return null;
  }
}

function save(identity: GuestIdentity, given?: Store | null): GuestIdentity {
  const s = store(given);
  try {
    s?.setItem(GUEST_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // 存不下(无痕、配额满)不影响这一次用,下次再随机一个就是了
  }
  return identity;
}

/** 有就用本机记着的，没有就随机分一个并记下来。进入流程调它 */
export function ensureGuest(given?: Store | null, now: () => number = Date.now): GuestIdentity {
  return loadGuest(given) ?? save(guestFrom(newGuestId(), now()), given);
}

/** 「换一个」：丢掉旧的，重新随机。回新的那一个 */
export function resetGuest(given?: Store | null, now: () => number = Date.now): GuestIdentity {
  return save(guestFrom(newGuestId(), now()), given);
}

/**
 * 认下服务端发的那一个游客身份：云端的编号由服务端给（页面报什么都不算数，见 `server/account/guest.mjs`），
 * 所以拿到之后就以它为准 —— 本机原先那个随机编号是没进过云端时的临时身份，服务端给了新的就把它换掉。
 * 编号变了意味着换了个人，`createdAt` 跟着重记。
 */
export function adoptGuestSession(session: { id: string; token: string; expiresAt: number },
  given?: Store | null, now: () => number = Date.now): GuestIdentity {
  if (!isGuestId(session?.id)) throw new TypeError('adoptGuestSession: 不是游客编号');
  const had = loadGuest(given);
  const same = had && had.id === session.id;
  // 换了编号就是换了个人:上一个人建的项目不归他,别一起带过来
  return save(guestFrom(session.id, same ? had.createdAt : now(),
    { token: session.token, expiresAt: session.expiresAt }, same ? had.project : undefined), given);
}

/**
 * 记下游客自己建的那个项目（只有一个）。回来时开始页靠它把项目列出来 ——
 * 「我创建的」那张表是向官网账号要的，游客没有账号，查不到。
 */
export function rememberGuestProject(project: { id: string; name: string }, given?: Store | null): GuestIdentity | null {
  const had = loadGuest(given);
  if (!had) return null;
  return save({ ...had, project }, given);
}

/** 这个项目没了（三天清理、或者创建者删了）：把记的那一条划掉，不然开始页上一直挂着一个打不开的项目 */
export function forgetGuestProject(given?: Store | null): GuestIdentity | null {
  const had = loadGuest(given);
  if (!had?.project) return had;
  const { project: _gone, ...rest } = had;
  return save(rest, given);
}

/** 登录了账号之后把游客身份清掉：账号才是这台设备之后的身份 */
export function clearGuest(given?: Store | null): void {
  const s = store(given);
  try {
    s?.removeItem(GUEST_STORAGE_KEY);
  } catch {
    // 清不掉也不拦着登录
  }
}
