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
 * 判不准的时候一律**当成简单请求**。多跑一次编排的代价是几十秒，
 * 而漏掉一次编排只是少了点并行——前者用户能感觉到，后者感觉不到。
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
  const conj = (q.match(/(并且|然后|同时|以及|接着|再给|还要|另外)/g) || []).length;
  if (conj >= 2) {
    return { parallel: true, by: "heuristic", reason: `出现 ${conj} 处并列词，明显是多步任务` };
  }

  return null; // 拿不准，交给 LLM
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
 * 闸门本身不可用（没配 API 直连、超时、报错）时**不编排**：CLI 驱动光启动
 * 进程就要好几秒，拿它做闸是净亏损；而没有闸又全量编排，等于回到最慢的那条路。
 */
export async function shouldOrchestrate(query: string): Promise<TriageVerdict> {
  const local = heuristicTriage(query);
  if (local) return local;

  const gate = await askGate(query);
  if (gate) return gate;

  return { parallel: false, by: "fallback", reason: "闸门不可用，按单步处理" };
}
