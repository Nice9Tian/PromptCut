/**
 * `--assert-no-lan <PC 局域网地址>`（`docs/plan/m8-plan.md` 第 2.3 节「异地接入托管」）：证明这一端全程没走局域网。
 *
 * 只读、不改任何设置（约束「不动宿主机的网络」）：
 *   - 从开始到 `stop()`，每 `everyMs`（缺省 2 s）跑一次 `netstat -an`，数本机到这个地址的**已建立**（`ESTABLISHED`）TCP 连接，
 *     记采样次数、最大值与出现过的行（至多 5 条）。别的状态（`TIME_WAIT`、`CLOSE_WAIT`、`SYN_SENT` 等）不算：上一项刚跑完时
 *     留下的 `TIME_WAIT` 会在 netstat 里挂一两分钟，数进去就误判；它们另记在 `maxOther` / `seenOther` 里，只供排查；
 *   - `stop()` 时再做一次一次性的局域网发现（`server/lan/discovery.mjs` 的 `discoverLan`，缺省 3 s），记发现到的主机数。
 * 两项都是 0 才算没走局域网；分成 `tcpOk`、`discoveryOk` 两项交给调用方各自判（局域网里别的程序在广播时，发现结果不为 0
 * 不等于这一端连了局域网，两项分开才说得清）。结果只有计数与地址，没有凭证。判法的纯函数是 `judgeNoLanTcp`（单测 `m8-no-lan.test.mjs`）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 算「已建立」的状态（netstat 在 Windows 与 Linux 上都写英文大写的状态名） */
export const COUNTED_STATES = Object.freeze(['ESTABLISHED']);

/**
 * `netstat -an` 的一行 → `{ proto, local, foreign, state }`；不是 TCP 行回 null。Windows 与 Linux 的列序不同，
 * 按「像地址的列」取前两个；`state` 取对端之后的那一列（全大写字母与下划线），没有就是 null
 */
export function parseNetstatLine(line) {
  const cols = String(line).trim().split(/\s+/);
  if (!/^tcp/i.test(cols[0] ?? '')) return null;
  const addrs = cols.filter((c) => /[:.]\d+$/.test(c) && /\d/.test(c) && c !== cols[0]);
  if (addrs.length < 2) return null;
  const after = cols[cols.lastIndexOf(addrs[1]) + 1];
  const state = typeof after === 'string' && /^[A-Z][A-Z_0-9]*$/.test(after) ? after : null;
  return { proto: cols[0], local: addrs[0], foreign: addrs[1], state };
}

/** 对端地址是不是这个 IPv4（`a.b.c.d:port`，也认 IPv4 映射的 `[::ffff:a.b.c.d]:port`） */
export function foreignIs(foreign, ip) {
  const f = String(foreign);
  return f.startsWith(`${ip}:`) || f.startsWith(`[::ffff:${ip}]:`);
}

/**
 * 数 `netstat -an` 输出里对端是 `ip` 的 TCP 行：`count` / `lines` 只含已建立的（`COUNTED_STATES`），
 * 别的状态进 `other`（只供排查）
 */
export function countTcpTo(text, ip, { states = COUNTED_STATES } = {}) {
  const all = String(text).split(/\r?\n/).map(parseNetstatLine).filter(Boolean).filter((x) => foreignIs(x.foreign, ip));
  const lines = all.filter((x) => states.includes(x.state));
  return { count: lines.length, lines, other: all.filter((x) => !states.includes(x.state)) };
}

/** 判法：采样过至少一次、且全程没见到到这个地址的已建立连接 */
export function judgeNoLanTcp({ samples, maxTcp }) {
  return samples > 0 && maxTcp === 0;
}

function netstat() {
  const r = spawnSync('netstat', ['-an'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { ok: r.status === 0 && typeof r.stdout === 'string', text: r.stdout ?? '', error: r.error ? String(r.error.message ?? r.error) : null };
}

/**
 * @param {string} ip  PC 的局域网地址
 * @param {{ everyMs?: number, discoverMs?: number, log?: (event: string, fields: object) => void, netstat?: () => { ok: boolean, text: string } }} [o]
 *   `netstat` 只给单测注入
 */
export function startNoLanWatch(ip, { everyMs = 2000, discoverMs = 3000, log = () => {}, netstat: run = netstat } = {}) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip ?? ''))) throw new TypeError(`--assert-no-lan 要给 IPv4 地址，收到 ${ip}`);
  const state = { ip, samples: 0, failedSamples: 0, maxTcp: 0, seen: [], maxOther: 0, seenOther: [] };
  const remember = (list, l) => {
    const key = `${l.local}>${l.foreign}${l.state ? ` ${l.state}` : ''}`;
    if (list.length < 5 && !list.includes(key)) list.push(key);
  };
  const sample = () => {
    const n = run();
    if (!n.ok) { state.failedSamples += 1; return; }
    const { count, lines, other } = countTcpTo(n.text, ip);
    state.samples += 1;
    if (count > state.maxTcp) state.maxTcp = count;
    if (other.length > state.maxOther) state.maxOther = other.length;
    for (const l of lines) remember(state.seen, l);
    for (const l of other) remember(state.seenOther, l);
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
      return { ...state, discovery, tcpOk: judgeNoLanTcp(state), discoveryOk: discovery.hosts === 0 };
    },
  };
}
