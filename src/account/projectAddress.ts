/**
 * 在线浏览器里云端项目的两种地址（`docs/semantics/product/platforms.md`「项目直达地址」「分享链接」，2026-10-23 用户定；
 * 形式见 `docs/semantics/mechanism/platforms.md`「项目地址」）：
 *   直达地址 `/editor/p/<项目号>`；分享链接 `/editor/s/<项目号>/<链接令牌>`。都不带软件版本。
 * 旧的 `/editor?project=…&token=…`（或 `linkToken=`）照旧认。这里只管地址的拼和读，进不进项目由 `useAccountProjects.ts` 决定。
 */
export const PROJECT_ID_RE = /^(?:sp_[a-z2-7]{26}|[A-Za-z0-9_-]{8,64})$/;
/** 链接令牌是服务端 `randomBytes(16).toString('base64url')`（`server/account/authority.mjs`），本来就能直接放进路径 */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

export type ProjectAddress =
  | { kind: 'project'; projectId: string }
  | { kind: 'share'; projectId: string; token: string };

const slashed = (base: string) => (base.endsWith('/') ? base : `${base}/`);

/** 直达地址的路径部分；`base` 是在线构建的 `/editor/` */
export function projectPath(projectId: string, base = '/editor/'): string {
  return `${slashed(base)}p/${projectId}`;
}

/** 分享链接的路径部分 */
export function sharePath(projectId: string, token: string, base = '/editor/'): string {
  return `${slashed(base)}s/${projectId}/${token}`;
}

/**
 * 从地址里读出项目：新的两种路径，或旧的 `?project=&token=`。读不出、形状不对回 null。
 * 只认 `base` 底下的路径；旧形式只认 `base` 本身（`/editor` 或 `/editor/`）。
 */
export function readProjectAddress(url: URL, base = '/editor/'): ProjectAddress | null {
  const b = slashed(base);
  if (url.pathname.startsWith(b)) {
    const parts = url.pathname.slice(b.length).split('/');
    if (parts[parts.length - 1] === '') parts.pop(); // 末尾多一个斜杠也认
    if (parts.length === 2 && parts[0] === 'p' && PROJECT_ID_RE.test(parts[1])) return { kind: 'project', projectId: parts[1] };
    if (parts.length === 3 && parts[0] === 's' && PROJECT_ID_RE.test(parts[1]) && TOKEN_RE.test(parts[2])) {
      return { kind: 'share', projectId: parts[1], token: parts[2] };
    }
  }
  if (url.pathname === b || url.pathname === b.slice(0, -1)) {
    const projectId = url.searchParams.get('project') ?? '';
    if (!PROJECT_ID_RE.test(projectId)) return null;
    const token = url.searchParams.get('token') || url.searchParams.get('linkToken') || '';
    return token && TOKEN_RE.test(token) ? { kind: 'share', projectId, token } : { kind: 'project', projectId };
  }
  return null;
}
