// Keep this Vite macro unconditional: conditional import.meta.glob is not
// transformed into the eager raw module table.
const globbed = import.meta.glob([
  '/src/cards/**/*.{ts,tsx,mjs,css}', '/src/parts/**/*.{ts,tsx,mjs,css}',
  '/src/render/**/*.{ts,tsx,mjs,css}', '/src/kernel/**/*.{ts,tsx,mjs,css}',
  '!/src/**/*.test.{ts,tsx,mjs,js}',
], { query: '?raw', import: 'default', eager: true });

/*
 * 热更新的边界(C6.6 集成 3b):卡片、部件、render、kernel 下任何一个文件改了,这张源码表就要重算。
 * 以前它不接热更新,于是沿「本模块 → costIdentity → probeRunner → ProbeGate / Preview」一路冒到编辑器,
 * Preview 的 effect 在 Fast Refresh 里重跑、清掉舞台的 RPC 客户端。
 * 现在本模块自己接住:重跑时把新表**原地**写进第一次导出的那个对象(引用它的模块手里拿的一直是那一个),
 * 所以不用通知谁换引用,下次算源码版本 / 身份键时读到的就是新的。
 */
const kept = import.meta.hot?.data?.files;
if (kept) {
  for (const k of Object.keys(kept)) if (!(k in globbed)) delete kept[k];
  Object.assign(kept, globbed);
}
export const builtinCardSourceFiles = kept ?? globbed;
if (import.meta.hot) {
  import.meta.hot.data.files = builtinCardSourceFiles;
  import.meta.hot.accept();
}
