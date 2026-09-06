/**
 * 分工模式的入口闸：这条请求值不值得走 manager 编排。
 *
 * 「分工模式」勾上以后每条提问都会走 manager → DAG → JSON 三轮往返。给
 * 「现在几点了」也走一遍的话，这个本来为了提速的功能反而更慢。所以先筛一道。
 *
 * 两级筛，越前面越便宜：
 *   1. 本地启发式——零成本，只处理**明显**的两端，拿不准就放行到第 2 级。
 *   2. 一次极小的 LLM 调用（/api/ai/triage，无工具、无历史、maxTokens 16）。
 *
 * 第 2 级不可用（没配 API 直连，只有 CLI 驱动——大多数用户）时不是直接判「简单」，
 * 而是退回一个放宽版的本地启发式。理由见 looseTriage：一律判简单会让分工模式
 * 变成一个勾了等于没勾、还看不出为什么的复选框。
 */

export type TriageVerdict = {
  parallel: boolean;
  /** heuristic = 本地判的（没花钱）；llm = 问过模型；fallback = 闸门不可用 */
  by: "heuristic" | "llm" | "fallback";
  reason: string;
};

/**
 * 本地启发式。只在**很有把握**时下结论，其余交给 LLM。
 *
 * 这里刻意不做复杂的自然语言分析：正则判意图很脆，判错了要么白跑三轮编排，
 * 要么该并行的没并行。只捞两端最明显的情形。
 */
export function heuristicTriage(query: string): TriageVerdict | null {
  const q = query.trim();

  // 太短的基本都是提问或一句话小改动，编排不划算
  if (q.length <= 8) {
    return { parallel: false, by: "heuristic", reason: "太短，多半是提问或小改动" };
  }

  // 纯疑问句：问信息，不产生任务
  if (/^(什么|为什么|怎么|如何|哪|谁|是不是|能不能|可不可以)/.test(q) || /[?？]\s*$/.test(q)) {
    if (!/[，,；;、]/.test(q)) {
      return { parallel: false, by: "heuristic", reason: "是一句提问，没有要执行的任务" };
    }
  }

  // 明确点名要多件事：并列连词 + 多个动词，这种编排几乎总是划算
  const conj = countConj(q);
  if (conj >= 2) {
    return { parallel: true, by: "heuristic", reason: `出现 ${conj} 处并列词，明显是多步任务` };
  }

  return null; // 拿不准，交给 LLM
}

/**
 * 表示「还有下一件事」的词。
 *
 * 「分别」也算：它说的是同一件事要对多个对象各做一遍，那正是最值得并行的形状。
 * 反过来「再」「和」这种没进来——它们太常出现在单步句子里（「再快一点」「音量和亮度」）。
 */
const CONJ = /(并且|然后|同时|以及|接着|再给|还要|另外|之后|最后|分别|其次|顺便)/g;

function countConj(q: string): number {
  return (q.match(CONJ) || []).length;
}

/**
 * 放宽版启发式：**只在闸门不可用时**用。
 *
 * 严格版拿不准就交给 LLM，可 CLI 用户根本没有那个 LLM 闸（起进程要好几秒，
 * 拿它做闸是净亏损）。如果这时还按「拿不准 = 不编排」处理，分工模式对大多数
 * 用户就是个静默失效的复选框——勾了和没勾一模一样，还看不出为什么。
 *
 * 所以门槛降到「一处并列词 + 句子不是一句短应答」。判错的代价是白跑一轮编排（几十秒），
 * 但用户是**主动勾上**分工模式的，这个方向上宁可多跑。
 */
export function looseTriage(query: string): TriageVerdict {
  const q = query.trim();
  const conj = countConj(q);
  if (conj >= 1 && q.length >= 10) {
    return { parallel: true, by: "heuristic", reason: `闸门不可用，本地判断：${conj} 处并列词` };
  }
  return { parallel: false, by: "fallback", reason: "闸门不可用，本地看不出是多步任务" };
}

/** 问一次极小的 LLM 闸。不可用或出错都返回 null，由调用方兜底。 */
async function askGate(query: string): Promise<TriageVerdict | null> {
  try {
    const r = await fetch("/api/ai/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    if (!d.ok || !d.available) return null;
    return {
      parallel: !!d.parallel,
      by: "llm",
      reason: d.parallel ? "模型判断可以拆成并行子任务" : "模型判断这是单步请求",
    };
  } catch {
    return null;
  }
}

/**
 * 决定这条请求走不走分工编排。
 *
 * 闸门不可用（没配 API 直连、超时、报错）时退回 looseTriage，而不是一律
 * 不编排——本机实测过：只有 CLI 驱动的时候闸门永远返回 available:false，
 * 于是勾上分工模式发多步请求，链路会一声不响地走回普通提问。
 */
export async function shouldOrchestrate(query: string): Promise<TriageVerdict> {
  const local = heuristicTriage(query);
  if (local) return local;

  const gate = await askGate(query);
  if (gate) return gate;

  return looseTriage(query);
}
