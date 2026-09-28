/**
 * `--assert-no-lan <PC 局域网地址>`（`docs/plan/m8-plan.md` 第 2.3 节「异地接入托管」）：证明这一端全程没走局域网。
 *
 * 只读、不改任何设置（约束「不动宿主机的网络」）：
 *   - 从开始到 `stop()`，每 `everyMs`（缺省 2 s）跑一次 `netstat -an`，数本机到这个地址的 TCP 连接（对端地址是它的行，
 *     任何状态都算），记采样次数、最大值与出现过的行（至多 5 条）；
 *   - `stop()` 时再做一次一次性的局域网发现（`server/lan/discovery.mjs` 的 `discoverLan`，缺省 3 s），记发现到的主机数。
 * 两项都是 0 才算没走局域网；分成 `tcpOk`、`discoveryOk` 两项交给调用方各自判（局域网里别的程序在广播时，发现结果不为 0
 * 不等于这一端连了局域网，两项分开才说得清）。结果只有计数与地址，没有凭证。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `netstat -an` 的一行 → `{ proto, local, foreign }`；不是 TCP 行回 null。Windows 与 Linux 的列序不同，按「像地址的列」取前两个 */
export function parseNetstatLine(line) {
  const cols = String(line).trim().split(/\s+/);
  if (!/^tcp/i.test(cols[0] ?? '')) return null;
  const addrs = cols.filter((c) => /[:.]\d+$/.test(c) && /\d/.test(c) && c !== cols[0]);
  if (addrs.length < 2) return null;
  return { proto: cols[0], local: addrs[0], foreign: addrs[1] };
}

/** 对端地址是不是这个 IPv4（`a.b.c.d:port`，也认 IPv4 映射的 `[::ffff:a.b.c.d]:port`） */
export function foreignIs(foreign, ip) {
  const f = String(foreign);
  return f.startsWith(`${ip}:`) || f.startsWith(`[::ffff:${ip}]:`);
}

/** 数 `netstat -an` 输出里对端是 `ip` 的 TCP 行 */
export function countTcpTo(text, ip) {
  const lines = String(text).split(/\r?\n/).map(parseNetstatLine).filter(Boolean).filter((x) => foreignIs(x.foreign, ip));
  return { count: lines.length, lines };
}

function netstat() {
  const r = spawnSync('netstat', ['-an'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { ok: r.status === 0 && typeof r.stdout === 'string', text: r.stdout ?? '', error: r.error ? String(r.error.message ?? r.error) : null };
}

/**
 * @param {string} ip  PC 的局域网地址
 * @param {{ everyMs?: number, discoverMs?: number, log?: (event: string, fields: object) => void }} [o]
 */
export function startNoLanWatch(ip, { everyMs = 2000, discoverMs = 3000, log = () => {} } = {}) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip ?? ''))) throw new TypeError(`--assert-no-lan 要给 IPv4 地址，收到 ${ip}`);
  const state = { ip, samples: 0, failedSamples: 0, maxTcp: 0, seen: [] };
  const sample = () => {
    const n = netstat();
    if (!n.ok) { state.failedSamples += 1; return; }
    const { count, lines } = countTcpTo(n.text, ip);
    state.samples += 1;
    if (count > state.maxTcp) state.maxTcp = count;
    for (const l of lines) {
      const key = `${l.local}>${l.foreign}`;
      if (state.seen.length < 5 && !state.seen.includes(key)) state.seen.push(key);
    }
    if (count > 0) log('no-lan.tcp-seen', { ip, count });
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      sample();
      let discovery;
      try {
        const { discoverLan } = await import(pathToFileURL(path.join(ROOT, 'server/lan/discovery.mjs')).href);
        const d = await discoverLan({ timeoutMs: discoverMs });
        discovery = { hosts: d.hosts.length, interfaces: d.interfaces.length, sent: d.sent, errors: d.errors.length };
      } catch (error) {
        discovery = { hosts: null, error: String(error?.message ?? error) };
      }
      return { ...state, discovery, tcpOk: state.samples > 0 && state.maxTcp === 0, discoveryOk: discovery.hosts === 0 };
    },
  };
}
