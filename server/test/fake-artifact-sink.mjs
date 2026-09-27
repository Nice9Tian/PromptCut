/**
 * 仅供测试与进程内集成，生产代码不得引用。
 *
 * 内存产物库（契约 `docs/plan/render-queue-contract.md` D.1 的 `sink`、D.3）。M5 起由素材服务实现，
 * 语义见 `mechanism/asset-service.md`「先推送、确认收全，再报完成」与设计 4.4「开工前先问素材服务这一段是不是已经有了」。
 *
 *   sink.has({ resultKey, kind, tier, range })                         → Promise<boolean>
 *   sink.put({ resultKey, kind, tier, range, artifacts, meta })        → Promise<{ complete: boolean }>
 *
 * 一段 = 一个结果键的一个范围（`resultKey` + `range.from`～`range.to`）。按内容寻址：同一段再推一次不覆盖
 * 第一次收全的那份，只记进推送历史。
 *
 * 测试用的附加接口：
 *   entries()           收全了的段：[{ resultKey, kind, tier, range, artifacts, meta }]，按收全的先后
 *   seed({ resultKey, range, kind?, tier? })   预置一段为已收全（meta 为 null）
 *   failNextPut(n)      接下来 n 次 put 回 { complete: false }，不存
 *   putCount(resultKey) 对这个结果键调过几次 put（含没收全的）
 *   puts()              全部 put 的记录：[{ resultKey, range, meta, complete }]
 *   hasCalls()          全部 has 的记录：[{ resultKey, range, answer }]
 *   misuse()            参数不合 D.1 的调用（缺 resultKey / range、meta 缺字段）：测试断言为空
 *
 * 所有方法都立即落定（回的是已兑现的 Promise），不依赖任何计时器。
 */

const segmentKey = (resultKey, range) => `${resultKey}#${range.from}-${range.to}`;

const clone = value => (value === undefined ? undefined : structuredClone(value));

function badArgs(what, args) {
  if (!args || typeof args !== 'object') return `${what}：参数不是对象`;
  if (typeof args.resultKey !== 'string' || args.resultKey === '') return `${what}：resultKey 必须是非空字符串`;
  const r = args.range;
  if (!r || typeof r !== 'object' || !Number.isInteger(r.from) || !Number.isInteger(r.to)) return `${what}：range 必须带整数 from / to`;
  return null;
}

export function createArtifactSink() {
  /** segmentKey → 收全了的一段 */
  const stored = new Map();
  const putLog = [];
  const hasLog = [];
  const misuse = [];
  let failing = 0;

  function has(args) {
    const bad = badArgs('has', args);
    if (bad) {
      misuse.push(bad);
      return Promise.reject(new TypeError(bad));
    }
    const answer = stored.has(segmentKey(args.resultKey, args.range));
    hasLog.push({ resultKey: args.resultKey, range: clone(args.range), answer });
    return Promise.resolve(answer);
  }

  function put(args) {
    const bad = badArgs('put', args);
    if (bad) {
      misuse.push(bad);
      return Promise.reject(new TypeError(bad));
    }
    const { resultKey, kind, tier, range, artifacts, meta } = args;
    // D.1：meta = { taskId, nodeId, token }，供记账（设计第 7 节「节点信任」）
    if (!meta || typeof meta.taskId !== 'string' || typeof meta.nodeId !== 'string' || !Number.isInteger(meta.token)) {
      misuse.push(`put：meta 必须是 { taskId: string, nodeId: string, token: int }，实际 ${JSON.stringify(meta)}`);
    }
    let complete = true;
    if (failing > 0) {
      failing -= 1;
      complete = false;
    }
    putLog.push({ resultKey, range: clone(range), meta: clone(meta), complete });
    const key = segmentKey(resultKey, range);
    if (complete && !stored.has(key)) {
      stored.set(key, { resultKey, kind, tier, range: clone(range), artifacts: clone(artifacts), meta: clone(meta) });
    }
    return Promise.resolve({ complete });
  }

  return {
    has,
    put,
    entries: () => [...stored.values()].map(entry => clone(entry)),
    seed({ resultKey, range, kind = null, tier = null }) {
      const bad = badArgs('seed', { resultKey, range });
      if (bad) throw new TypeError(bad);
      const key = segmentKey(resultKey, range);
      if (!stored.has(key)) stored.set(key, { resultKey, kind, tier, range: clone(range), artifacts: null, meta: null });
    },
    failNextPut(n = 1) {
      if (!Number.isInteger(n) || n < 0) throw new TypeError('failNextPut：n 必须是非负整数');
      failing += n;
    },
    putCount: resultKey => putLog.filter(p => p.resultKey === resultKey).length,
    puts: () => putLog.map(p => clone(p)),
    hasCalls: () => hasLog.map(h => clone(h)),
    misuse: () => misuse.slice(),
    /** 这一段收全了没有（同步，给断言用） */
    holds: (resultKey, range) => stored.has(segmentKey(resultKey, range)),
  };
}
