/**
 * 声音线程的起法(只在浏览器里用)。这里是最朴素的一种:从同源的模块地址起。
 *
 * 舞台的内容安全策略只许从 blob 地址起后台线程(`worker-src blob:`,`docs/plan/online-card-exec-contract.md` 3.3:
 * blob 线程继承舞台文档的策略,同源地址起的不继承)。带策略的舞台入口接上之后,舞台改给 `createSoundHost` 一个
 * 「blob 引导 + 引入本模块地址」的 `spawn`;在那之前(本机开发、探针)用这一个把功能跑通。
 */
import type { WorkerLike } from "./soundHost.ts";

export function spawnSoundWorker(): WorkerLike {
  return new Worker(new URL("./soundWorker.ts", import.meta.url), { type: "module", name: "pc-card-sound" }) as unknown as WorkerLike;
}



