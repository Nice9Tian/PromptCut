# AGENT 报告：browser-export-hang

分支 `claude/browser-export-hang`（起点 main `a55d8199`），工作区 `.worktrees/browser-export-hang`，端口 5380–5389。

任务：查清并修复「浏览器导出成片卡住不返回」（`window.__pcIo.exportVideoBrowser()` 在本机 dev server 上一张卡的项目也不返回；探针 `scripts/probes/lowmem-export-compare.mjs` 也卡住）。

## 进度

- [ ] 复现、定位卡在哪一步
- [ ] 找出引入的提交
- [ ] 判断缺陷还是环境问题，修复与回归测试
- [ ] 探针跑通
- [ ] 验证（tsc、npm test、端到端导出看图）
