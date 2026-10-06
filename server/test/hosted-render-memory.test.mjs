/**
 * 托管方渲染服务的内存看护：量法与判定（契约 `docs/plan/hosted-render-contract.md` 第 4 节；用例 HR33～HR37）。
 * 跑：npm test -- server/test/hosted-render-memory.test.mjs（不起浏览器、不起工作进程；Linux 一支用夹具文件，不读真的 /proc；HR37 在本机真量一次）
 *
 *   HR33  Linux 按进程量：累加 `smaps_rollup` 的 Pss，共享页不重复计（同一棵树按 VmRSS 累加会多出几倍）；读不到 Pss 时退到
 *         `RssAnon + RssShmem`，口径写进 `method`；僵尸进程算 0；进程中途没了不算失败
 *   HR34  Linux 有独立 cgroup（`systemd-run --scope`）：读那个 cgroup 的 `memory.current` 减 `inactive_file`；管理进程自己所在的 cgroup 不算独立；
 *         读不到 `memory.current` 退回按进程量；两棵树在同一个 cgroup 里只记一次；Windows：私有工作集，没有的进程退到私有已提交
 *   HR35  量不了就是量不了：不当成 0、也不当成超限（读不了的进程、查询失败、根进程没了、不认识的平台），这一拍不判；量得出的那一棵不替它凑数
 *   HR36  判定：合起来超限时先结束隔离的那一棵、只有常驻的在跑才结束常驻的；刚结束过的那一棵在冷却内不再判（不记两次、不连杀）；
 *         有独立 cgroup 时上限放宽一档（内核先动手，不双杀），没有时就是硬上限
 *   HR37  本机真量一次：量本进程这棵树得到一个正数与口径；对着本进程树的真读数判不超限
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  measureTrees, createMemoryWatch, parseCgroupPath, cgroupMemory, pidMemoryLinux, treeMembers, sumTree, MEMORY_METHOD_RANK,
} from '../hosted-render/limits.mjs';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/* ------------------------------------------------------------------ 夹具：假的 /proc 与 /sys/fs/cgroup */

const enoent = (file) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
const eacces = (file) => Object.assign(new Error(`EACCES: ${file}`), { code: 'EACCES' });

/** `/proc/<pid>/stat`：`pid (comm) S ppid ...`，第 22 个字段（括号之后第 21 个）是 rss 页数 */
const statLine = (pid, ppid, rssBytes) => {
  const rest = ['S', String(ppid), ...Array(18).fill('0'), String(Math.round(rssBytes / 4096)), '0'];
  return `${pid} (chrome) ${rest.join(' ')}\n`;
};
const kb = (bytes) => `${Math.round(bytes / 1024)} kB`;
const rollup = (pssBytes) => `00400000-7fff0000 ---p 00000000 00:00 0   [rollup]\nRss:        ${kb(pssBytes * 3)}\nPss:                ${kb(pssBytes)}\nPss_Anon:           ${kb(pssBytes / 2)}\n`;
const statusText = ({ anon, shmem, state = 'S (sleeping)' }) => `Name:\tchrome\nState:\t${state}\nVmRSS:\t${kb((anon ?? 0) + (shmem ?? 0) + 100 * MiB)}\n${anon === undefined ? '' : `RssAnon:\t${kb(anon)}\nRssFile:\t${kb(100 * MiB)}\nRssShmem:\t${kb(shmem ?? 0)}\n`}`;

/**
 * `procs`: pid → { ppid, rss（stat 里的，工作集口径）, pss（smaps_rollup；省略 = 读不了）, status（省略 = 不单独给）, cgroup }
 * `files`: 另外的文件（cgroup 的 memory.current 等）。
 */
function fakeProcfs({ procs, files = {}, selfCgroup = '0::/system.slice/pm2-render.service\n', denyRollup = [] }) {
  const data = new Map(Object.entries(files));
  data.set('/proc/self/cgroup', selfCgroup);
  for (const [pid, p] of Object.entries(procs)) {
    data.set(`/proc/${pid}/stat`, statLine(pid, p.ppid, p.rss ?? 800 * MiB));
    if (p.pss !== undefined && !denyRollup.includes(Number(pid))) data.set(`/proc/${pid}/smaps_rollup`, rollup(p.pss));
    data.set(`/proc/${pid}/status`, p.status ?? statusText({ anon: p.pss ?? 0, shmem: 0 }));
    if (p.cgroup !== undefined) data.set(`/proc/${pid}/cgroup`, p.cgroup);
  }
  return {
    read(file) {
      if (denyRollup.includes(Number(/^\/proc\/(\d+)\/smaps_rollup$/.exec(file)?.[1])) && /smaps_rollup/.test(file)) throw eacces(file);
      if (!data.has(file)) throw enoent(file);
      return data.get(file);
    },
    list(dir) {
      if (dir !== '/proc') throw enoent(dir);
      return ['self', 'cpuinfo', ...Object.keys(procs)];
    },
  };
}

/** Chrome 式的一棵树：根 100（Node）→ 101 浏览器进程 → 102 GPU、103、104 渲染进程；每个进程的工作集 800 MiB，其中大部分是共享页，均摊后各 200 MiB */
const chromeTree = (over = {}) => ({
  100: { ppid: 1, rss: 300 * MiB, pss: 150 * MiB },
  101: { ppid: 100, rss: 800 * MiB, pss: 200 * MiB },
  102: { ppid: 101, rss: 800 * MiB, pss: 200 * MiB },
  103: { ppid: 101, rss: 800 * MiB, pss: 200 * MiB },
  104: { ppid: 101, rss: 800 * MiB, pss: 200 * MiB },
  900: { ppid: 1, rss: 5 * GiB, pss: 5 * GiB }, // 不相干的进程，不能算进来
  ...over,
});

const PSS_TOTAL = (150 + 200 * 4) * MiB;
const RSS_TOTAL = (300 + 800 * 4) * MiB;

/* ------------------------------------------------------------------ HR33 */

test('HR33 Linux 按进程量：累加 Pss 不重复计共享页；树外的进程不算；口径写进 method', () => {
  const fsx = fakeProcfs({ procs: chromeTree() });
  const [r] = measureTrees([100], { platform: 'linux', fsx });
  assert.equal(r.method, 'pss');
  assert.equal(r.procs, 5, '根与它的四个后代，不含不相干的 900');
  assert.equal(r.bytes, PSS_TOTAL, '按 Pss 累加');
  assert.ok(RSS_TOTAL > 3 * r.bytes, `按 VmRSS 累加是 ${RSS_TOTAL / MiB} MiB，比不重复的口径多出好几倍（${r.bytes / MiB} MiB）：这就是原来误杀的原因`);
  // 只量其中一棵子树
  assert.equal(measureTrees([101], { platform: 'linux', fsx })[0].bytes, 200 * 4 * MiB);
  // 两棵树一起量，各自一项；没在跑的那一棵是 null
  const both = measureTrees([100, null], { platform: 'linux', fsx });
  assert.equal(both[0].bytes, PSS_TOTAL);
  assert.equal(both[1], null);
});

test('HR33 读不到 Pss 时退到 RssAnon + RssShmem（不含文件映射的共享页）；再读不到就量不了；僵尸算 0；进程中途没了不算失败', () => {
  // 一个进程无权读 smaps_rollup：退到 status（只在这个进程上；其余仍是 Pss，口径取最粗的）
  const procs = chromeTree();
  procs[103].status = statusText({ anon: 300 * MiB, shmem: 50 * MiB });
  const fsx = fakeProcfs({ procs, denyRollup: [103] });
  const [r] = measureTrees([100], { platform: 'linux', fsx });
  assert.equal(r.method, 'rss-anon-shmem', '用到的最粗的一级');
  assert.equal(r.bytes, PSS_TOTAL - 200 * MiB + 350 * MiB);
  assert.equal(MEMORY_METHOD_RANK.pss < MEMORY_METHOD_RANK['rss-anon-shmem'], true);

  // status 里也没有 RssAnon（很老的内核）：这一个进程量不了 → 整棵树量不了，不拿 VmRSS 顶
  const noFields = chromeTree();
  noFields[102].status = 'Name:\tchrome\nState:\tS (sleeping)\nVmRSS:\t999999 kB\n';
  const bad = measureTrees([100], { platform: 'linux', fsx: fakeProcfs({ procs: noFields, denyRollup: [102] }) })[0];
  assert.deepEqual([bad.bytes, bad.reason], [null, 'unreadable:102:no-rss-fields']);

  // 僵尸：地址空间已经释放，算 0
  const zombie = chromeTree();
  zombie[104].status = statusText({ state: 'Z (zombie)' });
  assert.equal(pidMemoryLinux(104, fakeProcfs({ procs: zombie, denyRollup: [104] })).bytes, 0);

  // 中途没了：smaps_rollup 与 status 都 ENOENT → gone，不算失败，不计入
  const fs2 = fakeProcfs({ procs: chromeTree() });
  const racy = { ...fs2, read: (f) => { if (/^\/proc\/103\/(smaps_rollup|status)$/.test(f)) throw enoent(f); return fs2.read(f); } };
  assert.deepEqual(pidMemoryLinux(103, racy), { gone: true });
  const [rr] = measureTrees([100], { platform: 'linux', fsx: racy });
  assert.equal(rr.bytes, PSS_TOTAL - 200 * MiB, '那个进程没了就不计，其余照量');

  // 辅助函数
  assert.deepEqual([...treeMembers(101, new Map([[101, 100], [102, 101], [103, 102], [104, 1]]))].sort(), [101, 102, 103]);
  assert.deepEqual(treeMembers(7, new Map([[1, 0]])), []);
  assert.equal(sumTree(1, new Map([[1, { ppid: 0, rss: 10 }], [2, { ppid: 1, rss: 20 }], [3, { ppid: 9, rss: 400 }]])), 30);
});

/* ------------------------------------------------------------------ HR34 */

test('HR34 有独立 cgroup：memory.current 减 inactive_file；管理进程自己所在的 cgroup 不算独立；两棵树同一个 cgroup 只记一次', () => {
  const scope = '/promptcut-render.slice/run-r1.scope';
  const iso = '/promptcut-render.slice/run-r2.scope';
  const files = {
    [`/sys/fs/cgroup${scope}/memory.current`]: `${3 * GiB + 200 * MiB}\n`,
    [`/sys/fs/cgroup${scope}/memory.stat`]: `anon ${2 * GiB}\nfile ${GiB}\ninactive_file ${200 * MiB}\nactive_file ${800 * MiB}\n`,
    [`/sys/fs/cgroup${iso}/memory.current`]: `${GiB}\n`,
  };
  const procs = chromeTree({
    100: { ppid: 1, rss: 300 * MiB, pss: 150 * MiB, cgroup: `0::${scope}\n` },
    200: { ppid: 1, rss: 300 * MiB, pss: 150 * MiB, cgroup: `0::${iso}\n` },
    201: { ppid: 200, rss: 300 * MiB, pss: 150 * MiB, cgroup: `0::${iso}\n` },
  });
  const fsx = fakeProcfs({ procs, files });
  const [res, isoRes] = measureTrees([100, 200], { platform: 'linux', fsx });
  assert.deepEqual([res.method, res.bytes, res.cgroup], ['cgroup', 3 * GiB, scope], '文件缓存里不活跃的那部分不算');
  assert.equal(res.current, 3 * GiB + 200 * MiB);
  assert.deepEqual([isoRes.bytes, isoRes.method], [GiB, 'cgroup'], '没有 memory.stat 就用 memory.current');

  // 同一个 cgroup 里的两棵树：账只记一次
  const same = measureTrees([100, 101], { platform: 'linux', fsx: fakeProcfs({ procs: { ...procs, 101: { ...procs[101], cgroup: `0::${scope}\n` } }, files }) });
  assert.equal(same[0].bytes, 3 * GiB);
  assert.deepEqual([same[1].bytes, same[1].sharedWith], [0, 100]);

  // 管理进程自己所在的 cgroup、根 cgroup、cgroup v1 的行：都不算独立，按进程量
  for (const cgroup of ['0::/system.slice/pm2-render.service\n', '0::/\n', '4:memory:/legacy\n3:cpu:/legacy\n']) {
    const p = chromeTree({ 100: { ppid: 1, rss: 300 * MiB, pss: 150 * MiB, cgroup } });
    const [r] = measureTrees([100], { platform: 'linux', fsx: fakeProcfs({ procs: p, files }) });
    assert.equal(r.method, 'pss', cgroup);
    assert.equal(r.bytes, PSS_TOTAL);
  }

  // 独立 cgroup 里读不到 memory.current（没开 memory 控制器）：退回按进程量
  const [fallback] = measureTrees([100], { platform: 'linux', fsx: fakeProcfs({ procs, files: {} }) });
  assert.deepEqual([fallback.method, fallback.bytes], ['pss', PSS_TOTAL]);

  // 解析与取值
  assert.equal(parseCgroupPath('0::/a/b.scope\n'), '/a/b.scope');
  assert.equal(parseCgroupPath('0::/a/b.scope (deleted)\n'), '/a/b.scope');
  assert.equal(parseCgroupPath('4:memory:/x\n'), null);
  assert.equal(cgroupMemory('/a/../etc', { fsx }), null, '路径里有 .. 不读');
  assert.equal(cgroupMemory(scope, { fsx })?.bytes, 3 * GiB);
  // inactive_file 比 current 还大（读数不同步）：不出负数
  const odd = fakeProcfs({ procs: {}, files: { '/sys/fs/cgroup/x/memory.current': '100\n', '/sys/fs/cgroup/x/memory.stat': 'inactive_file 500\n' } });
  assert.equal(cgroupMemory('/x', { fsx: odd }).bytes, 0);
});

/** Windows 的一次查询输出：`pid ppid 私有工作集|- 私有已提交|-` */
const winOut = (rows) => rows.map((r) => r.join(' ')).join('\r\n');
const winSpawn = (stdout, status = 0) => () => ({ status, stdout, stderr: '' });

test('HR34 Windows：累加私有工作集（不是工作集）；这一项没有的进程退到私有已提交；一次查询量几棵树', () => {
  const stdout = winOut([
    [4000, 1, 120 * MiB, 200 * MiB], // 树根（Node）
    [4001, 4000, 300 * MiB, 900 * MiB], // 浏览器进程
    [4002, 4001, 150 * MiB, 600 * MiB],
    [4003, 4001, '-', 700 * MiB], // 性能计数器里没有这个进程：退到私有已提交
    [5000, 1, 90 * MiB, 100 * MiB], // 隔离的那棵
    [9999, 1, 8 * GiB, 9 * GiB], // 不相干
  ]);
  let calls = 0;
  const [res, isoRes, none] = measureTrees([4000, 5000, null], { platform: 'win32', spawnSync: (...a) => { calls += 1; return winSpawn(stdout)(...a); } });
  assert.equal(calls, 1, '一次查询');
  assert.deepEqual([res.method, res.bytes, res.procs], ['private-bytes', (120 + 300 + 150 + 700) * MiB, 4], '用到的最粗的一级');
  assert.deepEqual([isoRes.method, isoRes.bytes], ['private-ws', 90 * MiB]);
  assert.equal(none, null);
  // 全都有私有工作集时口径就是 private-ws
  const clean = winOut([[1, 0, 10 * MiB, 20 * MiB], [2, 1, 30 * MiB, 40 * MiB]]);
  assert.deepEqual(measureTrees([1], { platform: 'win32', spawnSync: winSpawn(clean) })[0], { bytes: 40 * MiB, method: 'private-ws', procs: 2 });
});

/* ------------------------------------------------------------------ HR35 */

test('HR35 量不了就是量不了：回 bytes: null 和原因，不是 0 也不是超限', () => {
  // Linux：一个后代读不了
  const procs = chromeTree();
  const fsx = fakeProcfs({ procs, denyRollup: [102] });
  const denied = { ...fsx, read: (f) => { if (f === '/proc/102/status') throw eacces(f); return fsx.read(f); } };
  const [r] = measureTrees([100], { platform: 'linux', fsx: denied });
  assert.deepEqual([r.bytes, r.reason], [null, 'unreadable:102:EACCES']);
  // 根进程不在进程表里
  assert.deepEqual(measureTrees([4242], { platform: 'linux', fsx: fakeProcfs({ procs }) })[0], { bytes: null, reason: 'root-gone' });
  // 整个 /proc 列不出来
  const broken = measureTrees([100], { platform: 'linux', fsx: { read: () => { throw enoent('x'); }, list: () => { throw eacces('/proc'); } } })[0];
  assert.equal(broken.bytes, null);
  assert.match(broken.reason, /^measure-error:/);
  // Windows：查询失败 / 超时 / 空表 / 没有私有内存的进程
  assert.deepEqual(measureTrees([1], { platform: 'win32', spawnSync: winSpawn('', 1) })[0], { bytes: null, reason: 'query-failed' });
  assert.deepEqual(measureTrees([1], { platform: 'win32', spawnSync: () => ({ status: null, error: new Error('ETIMEDOUT') }) })[0], { bytes: null, reason: 'query-failed' });
  assert.deepEqual(measureTrees([1], { platform: 'win32', spawnSync: winSpawn('') })[0], { bytes: null, reason: 'empty-process-table' });
  assert.equal(measureTrees([1], { platform: 'win32', spawnSync: winSpawn(winOut([[1, 0, '-', '-']])) })[0].reason, 'unreadable:1:no-private-memory');
  assert.deepEqual(measureTrees([77], { platform: 'win32', spawnSync: winSpawn(winOut([[1, 0, 10, 10]])) })[0], { bytes: null, reason: 'root-gone' });
  // 不认识的平台
  assert.deepEqual(measureTrees([5, null], { platform: 'darwin' }), [{ bytes: null, reason: 'unsupported-platform' }, null]);
});

test('HR35 判定遇到量不了的读数：这一拍不判（不凑数、不当成 0），读数恢复后照常判', () => {
  const watch = createMemoryWatch({ max: 6 * GiB, now: () => 0 });
  const fail = { bytes: null, reason: 'unreadable:5:EACCES' };
  const ok = (gb) => ({ bytes: gb * GiB, method: 'pss' });
  // 常驻量不了：即便隔离的一棵单独就超了，也不凑数——量不了就是量不了
  let v = watch.judge({ resident: fail, iso: ok(7) });
  assert.deepEqual([v.verdict, v.total, v.victim], ['unmeasured', null, null]);
  assert.deepEqual(v.failures, [{ who: 'resident', reason: 'unreadable:5:EACCES' }]);
  // 量不了不是 0：另一棵没超时也不算「合起来没超」，同样是不判
  v = watch.judge({ resident: ok(1), iso: fail });
  assert.deepEqual([v.verdict, v.victim], ['unmeasured', null]);
  // 两棵都量不了
  assert.equal(watch.judge({ resident: fail, iso: fail }).failures.length, 2);
  // 恢复
  assert.equal(watch.judge({ resident: ok(1), iso: ok(1) }).verdict, 'ok');
  // 一棵都没在跑
  assert.deepEqual([watch.judge({}).verdict, watch.judge({ resident: null, iso: null }).total], ['idle', null]);
  // NaN、undefined 的 bytes 同样当量不了
  assert.equal(watch.judge({ resident: { bytes: NaN } }).verdict, 'unmeasured');
});

/* ------------------------------------------------------------------ HR36 */

test('HR36 超限先结束隔离的那一棵；只有常驻的在跑才结束常驻的；刚结束过的在冷却内不再判', () => {
  let now = 1_000_000;
  const watch = createMemoryWatch({ max: 6 * GiB, cooldownMs: 30_000, now: () => now });
  const m = (gb) => ({ bytes: gb * GiB, method: 'pss' });

  // 合起来没超（各自都不到，合起来 5.5G）
  assert.deepEqual(watch.judge({ resident: m(3), iso: m(2.5) }), { total: 5.5 * GiB, limit: 6 * GiB, verdict: 'ok', victim: null, failures: [], methods: { resident: 'pss', isolated: 'pss' } });

  // 合起来 6.75G：先结束隔离的（跑的是项目带来的代码），常驻的留着
  let v = watch.judge({ resident: m(3.5), iso: m(3.25) });
  assert.deepEqual([v.verdict, v.victim], ['over', 'isolated']);
  assert.equal(v.total, 6.75 * GiB);

  // 隔离的还在退出、读数还是旧的：冷却内不再判，不记第二次，不连杀
  now += 5000;
  v = watch.judge({ resident: m(3.5), iso: m(3.25) });
  assert.deepEqual([v.verdict, v.victim], ['cooling', null]);

  // 隔离的走了，常驻的单独超限：结束常驻的（隔离那一棵的冷却不挡它）
  now += 5000;
  v = watch.judge({ resident: m(6.5) });
  assert.deepEqual([v.verdict, v.victim], ['over', 'resident']);
  // 常驻的刚结束，重起之后马上又超：冷却内不判
  now += 1000;
  assert.equal(watch.judge({ resident: m(6.5) }).verdict, 'cooling');
  // 过了冷却再超就再判
  now += 31_000;
  assert.deepEqual([watch.judge({ resident: m(6.5) }).verdict, watch.judge({ iso: m(7) }).victim], ['over', 'isolated']);

  // 刚好等于上限不算超
  const edge = createMemoryWatch({ max: 6 * GiB, now: () => now });
  assert.equal(edge.judge({ resident: m(6) }).verdict, 'ok');
  // 只有隔离的在跑：结束隔离的
  assert.equal(createMemoryWatch({ max: GiB }).judge({ iso: m(2) }).victim, 'isolated');
  // 上限没配（null）：不判
  assert.equal(createMemoryWatch({ max: null }).judge({ resident: m(99) }).verdict, 'ok');
});

test('HR36 有独立 cgroup 时内核先动手：进程内的上限放宽 5%，没有时就是硬上限', () => {
  const watch = createMemoryWatch({ max: 6 * GiB, now: () => 0 });
  const cg = (gb) => ({ bytes: gb * GiB, method: 'cgroup' });
  const pss = (gb) => ({ bytes: gb * GiB, method: 'pss' });
  // 内核已经在 6G 动手的那一拍，读数最多到 6G 多一点：不越过 6.3G，进程内不再动手（不双杀）
  let v = watch.judge({ resident: cg(6.2) });
  assert.deepEqual([v.verdict, v.limit], ['ok', Math.round(6 * GiB * 1.05)]);
  // 内核没执行（slice 没装、MemoryMax 没生效，或两个 scope 各自没超而合起来超了）：越过放宽的线，进程内兜底
  v = watch.judge({ resident: cg(3.5), iso: cg(3.4) });
  assert.deepEqual([v.verdict, v.victim], ['over', 'isolated']);
  // 同样的 6.2G，没有 cgroup（按进程量）时就是超限
  const plain = createMemoryWatch({ max: 6 * GiB, now: () => 0 });
  v = plain.judge({ resident: pss(6.2) });
  assert.deepEqual([v.verdict, v.limit, v.victim], ['over', 6 * GiB, 'resident']);
});

/* ------------------------------------------------------------------ HR37 */

test('HR37 本机真量一次：量本进程这棵树得到一个正数与口径；对着真读数判不超限', () => {
  const [r, none] = measureTrees([process.pid, null]);
  assert.equal(none, null);
  assert.ok(Number.isFinite(r.bytes) && r.bytes > 10 * MiB, `本进程的物理内存 ${JSON.stringify(r)}`);
  assert.ok(r.bytes < 32 * GiB);
  assert.ok(Object.hasOwn(MEMORY_METHOD_RANK, r.method), `口径 ${r.method}`);
  if (process.platform === 'win32') assert.match(r.method, /^private-/);
  // 按不重复的口径，本进程这棵树远小于一个 6 GB 的上限
  assert.equal(createMemoryWatch({ max: 6 * GiB }).judge({ resident: r }).verdict, 'ok');
});
