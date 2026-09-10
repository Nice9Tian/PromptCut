/**
 * 渲染面时钟的安装入口。**必须是 main.tsx 的第一个 import。**
 *
 * Motion 在自己的模块初始化时就把 requestAnimationFrame 抓进了帧循环里
 * (createRenderBatcher(requestAnimationFrame, ...)),晚于它安装的补丁对它无效——
 * 那样卡片还是按墙上时钟播,拖播放头就又变成「从头重播一遍」。
 * 所以这个文件要排在所有会牵出 motion 的 import 之前。
 *
 * 只在 ?stage=1 的渲染面里装;编辑器主文档不能装,不然它自己的界面动画会被一起冻住。
 *
 * 同一个道理也管随机数和墙上时钟:第三方库在模块加载时就抓走 Math.random(lottie-web 的
 * `BMMath.random = Math.random`),所以 pinEntropy 也要在这里、赶在所有 import 之前装上 ——
 * 导出视图(?export=1)和渲染面(?stage=1)都装。导出视图的 performance.now / rAF 仍由
 * ExportView 里的 installExportClock 装,时机不变(提前装会换掉 Motion 的时间戳来源)。
 * proto-main.tsx 也把这个文件放在第一行,proto.html 的导出入口同样罩得住。
 */
import { installStageClock } from "./stageClock";
import { installPinnedEntropy } from "../kernel/pinEntropy";

if (typeof window !== "undefined") {
  const q = new URLSearchParams(location.search);
  if (q.has("stage")) {
    installStageClock();
    installPinnedEntropy(); // 在舞台时钟之后:Date 要读得到舞台时间
  } else if (q.has("export")) {
    installPinnedEntropy();
  }
}
