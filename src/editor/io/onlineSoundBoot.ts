/**
 * 把在线声音判定(`onlineSoundJudge.ts`)接到页面的档位与页面内快照库 L2 的成本表。
 * 单独一个文件:`planDispatch.ts` 在 Node 单测里载不进来(它一路引到 `import.meta.glob`),判定本身要能在单测里跑。
 * 由预览的声音层(`src/editor/preview/MediaLayers.tsx`)引入,编辑器页面一打开就接好。
 */
import { createMemorySoundCostStore, type SoundCostStore } from "../../audio/soundCost";
import { pageL2 } from "../../online/l2";
import { planLowMemory } from "../planDispatch";
import { configureOnlineSoundJudge } from "./onlineSoundJudge";

const fallback = createMemorySoundCostStore();
configureOnlineSoundJudge({
  lowMemory: planLowMemory,
  // L2 打不开(没有 IndexedDB、被浏览器拒)时只记在页面内存
  store: () => pageL2({ lowMemory: planLowMemory() }).then((store) => store as SoundCostStore, () => fallback),
});
