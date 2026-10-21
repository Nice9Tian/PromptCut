/**
 * 云端 Agent 发布预渲染之前的轻重判定(语义 `product/agent.md`「发出任务后可以离开」:托管方的渲染节点生成的是**被改动的重卡**
 * 给成员预览用的轨道流;`product/rendering.md`「轻卡、重卡」:轻重靠实测)。
 *
 * Agent 服务自己不测卡(没有舞台;`mechanism/rendering.md`「多项目模式的做法」:轻重只在用户设备的编辑页面里测),
 * 它能拿到的实测是文档服务里的**共享成本记录**(`mechanism/document-service.md`「成本记录」,页面测完写进去的那一份)。
 * 判定照在线页面的同一套走,不另设数字:
 *
 * - 片段 → 成本身份:`costIdentity.ts` 的 `clipIdentityOf`(页面的探针与分派表同一份;剪辑段里的卡按摊平视图的虚拟片段给身份);
 * - 每张卡的耗时:同一身份的各条记录(来自不同环境)取中位数(`boundarySearch.mjs` 的 `representativeCosts`,界限搜索的代表耗时);
 * - 分派:`pipelinePlan.mjs` 的 `planPipelines`(预算 B、成本倍率、按位置贪心、推帧卡、3D 视图都在里面),每张重卡每拍的固定成本
 *   取在线普通档的换帧成本(`swapCost.ts` 的 `layerSwapMs`,与 `Preview` 交给 `planDispatch` 的同一个);
 * - 没有成本记录的卡按 `clipWeight` 的兜底:声明了 `direct` 的判轻,其余判重(页面测完之前的同一条);
 *   服务端注册表里没有定义的卡(项目自带的用户卡还没登记进来、未知卡片)没有身份、没有声明,一律判重,照原来发。
 *
 * 结果是 `prerenderSet`(任一位置判重的卡)与候选片段的交集。本文件在 Agent 服务里经 ssr-host 的载入缝载入
 * (`server/agent/service/render-clips.mjs` 的 `HEAVY_JUDGE_MODULE`),页面不用它。
 */
import type { Project } from "../kernel/project";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { representativeCosts } from "../render/boundarySearch.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { planPipelines } from "../render/pipelinePlan.mjs";
import { resolveTuning } from "../render/pipelineTuning.mjs";
import { clipIdentityOf } from "./costIdentity";
import { layerSwapMs } from "./swapCost";

/** 文档服务 `cost.list` 回的一条(只用到这两项) */
export interface SharedCostLike {
  identityKey: string;
  stepMs: number;
}

/**
 * @param project 写入之后的项目(激活剪辑在顶层;剪辑段里的卡按摊平视图的虚拟片段 id 判)
 * @param records 本项目的共享成本记录(`cost.list` 的 `records`)
 * @param candidates 这次要发布的候选片段 id(`render-clips.mjs` 挑出来的)
 * @returns 候选里判重的(`heavy`)与判轻的(`light`),各自保持候选的顺序;不在摊平视图里的候选两边都不放
 */
export function judgeHeavyClips(project: Project | null, records: readonly SharedCostLike[] | null | undefined, candidates: readonly string[]): { heavy: string[]; light: string[] } {
  if (!project || !candidates.length) return { heavy: [], light: [] };
  // 共享记录只有单帧耗时(`clipWeight` 只认得到的几项:没有 `kind` / `seekOk` / `catchUpMs` 时按推帧卡在一拍内追得上算,权重 = stepMs)
  const costs = [...representativeCosts(records ?? [])].map(([identityKey, stepMs]) => ({ identityKey, stepMs })) as unknown as CardCostRecord[];
  const { identityKeys, frameModes } = clipIdentityOf(project);
  const fps = Math.max(1, Number(project.fps) || 30);
  const planned = flatPlanProject(project);
  const plan = planPipelines(planned, costs, fps, {
    tuning: resolveTuning(null), identityKeys, frameModes,
    deadMs: (clipId: string) => layerSwapMs(project, clipId),
  });
  const present = new Set(planned.tracks.flatMap((tr) => tr.clips.map((c) => c.id)));
  const heavy: string[] = [];
  const light: string[] = [];
  for (const id of candidates) {
    if (!present.has(id)) continue;
    (plan.prerenderSet.has(id) ? heavy : light).push(id);
  }
  return { heavy, light };
}
