/**
 * 云端一轮的运行选项：成员发消息时点的模型、思考强度、创造力。
 *
 * 文档服务只核形状，核过的原样记在这条消息上，随消息记录交给任务进程；
 * 模型在不在托管方的清单里由任务进程按清单挑（不在就用清单第一个，`model-config.mjs` 的 `pickModel`）。
 * 档位清单只写在这里：`/v1/info` 报给页面的、任务进程认的，都取这一份。
 */

/**
 * 云端认的思考强度（不含「默认」：不带就是随模型自己的默认）。与本机 API 直连这条路的档位相同。
 * xhigh / max 网关接了但不换成思考模式（2026-10-18 节点实测，见 docs/semantics/mechanism/agent.md「Key 与模型」），不放进来。
 */
export const RUN_EFFORTS = Object.freeze(['low', 'medium', 'high']);
/** 与 `src/kernel/creativity.mjs` 的 CREATIVITY_LEVELS 相同（文档服务不引 src/，测试核两份一致） */
export const RUN_CREATIVITY = Object.freeze(['low', 'medium', 'high']);

const KEYS = ['model', 'effort', 'creativity'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * 页面给的选项 → 规范形状。空的项不留（`''`、`null` 都当没选），全空回 `null`；
 * 有不认识的键或值回 `undefined`，调用方按 400 拒，不悄悄丢掉。
 */
export function normalizeRunOptions(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !KEYS.includes(key))) return undefined;
  const out = {};
  for (const key of KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    const ok = key === 'model' ? typeof value === 'string' && MODEL_RE.test(value)
      : key === 'effort' ? RUN_EFFORTS.includes(value) : RUN_CREATIVITY.includes(value);
    if (!ok) return undefined;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}
