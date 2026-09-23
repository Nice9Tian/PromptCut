# 任务报告

## 做了什么

- 在项目设置对话框加入“总时长（秒）”数字输入框，沿用现有 `pc-dialog-row`、`pc-dialog-label`、`pc-dialog-input` 样式类。
- 确认时校验正数，并通过现有 `actions.setDurationManual` 写入。该动作与 Agent 的 `set_project_meta` 共用，内部复用 `contentEndOf`、`manualDurationFor`、`effectiveDuration`；对话框没有另写时长规则。
- 新增 `src/store/actions/projectMeta.test.mjs`，覆盖截短、超出内容末尾时钳制并恢复跟随、空项目保留设置值。

## 验证

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npx --no-install tsc -b --force` | 0 | 零错误 |
| `node --experimental-test-module-mocks --test src/store/actions/projectMeta.test.mjs` | 0 | 3 通过，0 失败 |
| `npm test` | 0 | 1720 通过，1 跳过，0 失败 |
| `git diff --check` | 0 | 无空白错误；仅有 Git 的 LF/CRLF 提示 |

## 未做成的及原因

无。未跑渲染、导出探针或浏览器画面核对；本次只复用对话框现有控件类，没有改渲染或样式。

## 对任务或语义的更正建议

无。现有 store 动作已实现文档中的总时长语义，无需修改语义文档或 `src/kernel/duration.ts`。
