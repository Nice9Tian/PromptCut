/**
 * 搬到云端之前的预检：先问目标节点，它接受不接受旧办法（房间、项目密码、创建者口令）的导入。
 * 只发一个只读的 GET，问的是文档服务本来就有的 `/healthz`——账号模式的节点会在里面报 `accountMode` / `accountRequired`。
 * 必须在封锁本机房间、停本机托管、写任何东西之前调用；回 `{ ok: false }` 时调用方就地停下，本机房间原样可用。
 *
 * 回的 `error`：
 * - `account-mode`：节点是账号模式，只认网站账号，旧办法的房间搬不上去；
 * - `relocation-network`：问不到或答得不像文档服务（超时、非 200、不是 JSON）：确认不了就不动手。
 */
import { serviceIdentity } from './descriptor.mjs';

export async function legacyImportAccepted({ service, fetchImpl = fetch, timeoutMs = 5000, attempts = 2 }) {
  let url;
  try { url = `${serviceIdentity(service)}/healthz`; } catch { return { ok: false, error: 'relocation-network' }; }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (response.ok) {
        const health = await response.json();
        if (!health || typeof health !== 'object' || health.ok !== true) return { ok: false, error: 'relocation-network' };
        if (health.accountRequired === true || (health.accountMode !== undefined && health.accountMode !== null)) return { ok: false, error: 'account-mode' };
        return { ok: true };
      }
    } catch { /* 暂时性的失败：退避后再问一次 */ }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 400 * attempt));
  }
  return { ok: false, error: 'relocation-network' };
}
