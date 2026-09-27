
- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3610、pass 3568、fail 0、cancelled 0、skipped 41、todo 1。
  - 跳过 41 = 原有 2 条（`/api/cards/layout` 集成、SKILL 闸门集成，都要真 dev server）+ 本分支按门跳过 39 条：
    D4 1、D1 队列 6、D2 队列 4、D9 6（`normalizeOwner` 1 条的门在 `protocol.mjs`，其余 5 条的门是 `.owner`）、D10 3、D14 1、D1 切分 4、D2 判定 1、D12 v3 3、页面节点 10（条件 1、hello 1、第 4.1 节 1、D8 4、D6 3）。M7 集成后这 39 条必须全部转为真跑。
  - todo 1 是上面「tier 一条」：node:test 把失败的 todo 列进 failing 清单，但不计失败、不改退出码。
- 计时：全部用假时钟或「让出宏任务回合」，没有真实耗时断言，忙机上不会误报。
