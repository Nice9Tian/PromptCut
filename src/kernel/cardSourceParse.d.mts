/** 一份卡片源码里定义的卡(不执行源码);认不出回空数组 */
export function parseCardSource(source: string): { id: string; name: string }[];
/** 内容库里的卡片源码键是不是一张用户卡的入口文件(`src/cards/user/<名>.tsx`) */
export function isUserCardEntryKey(key: unknown): boolean;
