/**
 * 渲染面时钟的安装入口。**必须是 main.tsx 的第一个 import。**
 *
 * Motion 在自己的模块初始化时就把 requestAnimationFrame 抓进了帧循环里
 * (createRenderBatcher(requestAnimationFrame, ...)),晚于它安装的补丁对它无效——
 * 那样卡片还是按墙上时钟播,拖播放头就又变成「从头重播一遍」。
 * 所以这个文件要排在所有会牵出 motion 的 import 之前。
 *
 * 只在 ?stage=1 的渲染面里装;编辑器主文档不能装,不然它自己的界面动画会被一起冻住。
 */
import { installStageClock } from "./stageClock";

if (typeof window !== "undefined" && new URLSearchParams(location.search).has("stage")) {
  installStageClock();
}
