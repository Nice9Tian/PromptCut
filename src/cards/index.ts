import { registerCards, resetCards, allCards } from "../kernel/registry";
import { magicuiCards } from "./magicui";
import { nativeCards } from "./native";
import { userCards } from "./user";
import { assetCards } from "./assets";
// 部件库(组合卡的零件)和卡片一起装:src/parts/index.ts 自己注册,这里只要确保它被加载
import "../parts";
import { probeCards } from "./_probe";

// 这个模块会被 HMR 重新执行(新建或修改 src/cards/user/ 下的卡就会触发),
// 所以每次都从空开始重装一遍:删掉的卡片文件不会赖在库里,重复注册也不会报错。
resetCards();
// 素材封装卡(Lottie / 粒子目录翻译出来的)和内置卡一起注册:它们是构建时生成的,id 有保留前缀
registerCards([...magicuiCards, ...nativeCards, ...assetCards, ...probeCards]);

// 用户 / AI 建的卡最后注册,并且要先滤掉和内置卡撞车的 id。
// 这些文件是运行时新增的,一张撞车的卡不该让整个编辑器起不来 ——
// 建卡这条路不能有「写错一次就打不开软件」的失败模式。
// create_card 那边也会提前拦一次,这里是兜底。
const taken = new Set(allCards().map((c) => c.id));
const safeUserCards = userCards.filter((c) => {
  if (taken.has(c.id)) {
    console.warn(`[cards/user] 卡片 id "${c.id}" 和已有卡片重复,已跳过。改个 id 再试。`);
    return false;
  }
  taken.add(c.id);
  return true;
});
registerCards(safeUserCards);
