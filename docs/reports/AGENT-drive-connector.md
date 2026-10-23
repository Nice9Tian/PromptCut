# AGENT 报告：网盘连接器（`claude/drive-connector`）

2026-10-23，Claude 主会话。任务书 `docs/plan/drive-connector-task.md`。

从用户自己的 Google Drive 直接把素材取进项目，不必先下载到本机再上传。

## 1. 做了什么

| 步 | 内容 | 状态 |
|---|---|---|
| D0 | Google Cloud 登记（项目、同意屏幕、OAuth 客户端、API 密钥） | 完成 |
| D1 | 可行性探针：`drive.file` 够不够用、Drive 支不支持 Range | **通过** |
| D2 | `StorageProvider` 接口、Google Drive 实现、分段拉取与入库 | 完成，**真机跑通** |
| D3 | 断点续传 | 单测覆盖，真机待验 |
| D4 | A2 凭据托管与撤销 | 服务端完成，页面那一半未做 |
| D5 | HTTP 入口与素材页「从网盘导入」 | 完成，**真机跑通** |
| D6 | 项目 × 成员的隔离 | 单测覆盖 |

### 新增文件

```
server/storage-connectors/   index  provider  google-drive  pull  import  route
                             google-oauth  credentials  managed-token      （9 个）
server/test/                 storage-connectors.test.mjs  storage-credentials.test.mjs
src/editor/io/               googlePicker.ts  storageImport.ts
src/editor/left/             StorageImportButton.tsx
scripts/probes/              drive-range-probe.html
```

改到的既有文件只有四个，都很浅：`server/vite-plugin-media.ts`（+29 行路由）、`src/editor/left/LibrarySection.tsx`（+7 行）、`src/editor/left/left.css`（末尾追加样式）、`.gitignore`（`client_secret*.json` 兜底）。

## 2. 验证结果

| 项 | 结果 |
|---|---|
| 类型检查 `npx tsc -b` | **零错误** |
| 受影响测试（10 个文件，含 `vite-plugin-media` 的全部下游） | **168 个用例全过** |
| 本任务新增测试 | `storage-connectors` 32 个 + `storage-credentials` 22 个，**全过**，不碰网络 |
| D1 探针 | **通过**，结果见任务书 6.1 |
| 界面 | 真机看过：按钮、网盘菜单、Dropbox 置灰 |

全量测试按 2026-10-23 用户改定的规矩不在本阶段跑（挪到发版前）。

### D1 的两个结论（任务书 6.1）

- **`drive.file` 够用**：Picker 选中的文件直接读到元信息，不需要受限范围 `drive.readonly`。「选中即授权」成立。**这条决定了整个方案躲开 Google 每年一次的 CASA 安全评估。**
- **Drive 支持 Range**：头段与中段都回 206、都恰好 1024 字节、两段哈希不同——确认按偏移给字节。所以断点续传落到片级，不用整件重来。

## 3. 没做成的，和原因

1. ~~真机端到端没跑完~~ **已跑通**（2026-10-23，用户本人完成 Google 授权那一步）：从他自己 Drive 里选的 mp4 进了素材库、片段上了时间轴、画面正常。过程中查出并修掉一个早就存在的缺陷，见下文第 5 节第 4 条。
2. **A2 只有服务端那一截**。页面侧的授权码流程还没写，所以真机验不了「关掉页面后继续拉完」。要做还得先定客户端密钥在部署配置里怎么放。
3. **共享项目里用不了**。`POST /api/media/storage/import` 照 `vite-plugin-collect.ts` 的样子只传 `origin`，没带 `ownership` 与素材票据，所以只在本机项目里管用。
4. **网盘导入的素材暂时不能语音转写**。页面手里没有 `File`，`io/stt.ts` 回「素材文件不在内存里」。这和「打开一个已有项目之后的素材」是同一种情形，**不是本条路新引入的**；要修得让 STT 改成按内容哈希向素材服务取字节。

## 4. 对任务书与语义的更正建议

- **语义文档一个字都还没改。** 第 7 节的 dry run（`product/asset-service.md` 新增「从第三方存储导入」、`workflow/materials.md` 加一行、`mechanism/asset-service.md` 加三级细节、`glossary.md` 加「第三方存储」、`TODO.md` 更新那条待办）已经给用户看过，**还没拿到逐条确认，所以没写**。合入 main 前要补这一步。
- 任务书第 8.2 节原先写「品牌验证是否必填未核实」，已换成 2026-10-23 在控制台上实地核到的事实。
- 任务书第 9 节原先有「不支持 Range 就只能整件拉」的退路，D1 之后作废。

## 5. 踩到并记下的三个坑

1. **`FileHandle.createWriteStream({ autoClose: false })` 不发 `close` 事件**，而 `stream/promises` 的 `pipeline` 要等到 `close` 才算完——五个会落盘的用例全部 15 秒超时，而且一行输出都没有，看着像死锁。改用 `fs.createWriteStream(dest, { flags: 'r+', start })`。注释写在 `pull.mjs` 的 `appendStream` 上。
2. **`Content-Range` 跨源读不到**（Google 没放进 `Access-Control-Expose-Headers`）。浏览器里的探针读不到它；服务端读得到，但拉取代码仍然自己记偏移，不依赖它。
3. **改了配置要等**。控制台自己写「设置可能需要 5 分钟到几小时才会生效」。探针报来源不匹配时先等，别急着改配置。

另外有一次是我自己的操作失误：填完重定向 URI 就导航去了别的页面，Chrome 弹「要离开此网站吗」把未保存的改动丢了，那个对话框同时挡住了扩展，表现为连着几次截图超时。后来改成填完守在那一页不动。

## 6. 需要用户决定的

1. 语义 dry run 要不要按原样写（第 4 节第一条）。
2. 真机端到端那一步什么时候做（第 3 节第一条）。
3. 接下来做哪一块：A2 的页面那一半、共享项目支持、还是 Dropbox。

## 7. 和别的会话的交接

- **发版会话**（`版本 0.21 发版准备`）已定：0.7.21 只带服务端那一层当死代码，网盘连接器这个功能**不随 0.7.21 发**。本分支已把 main 合进来（`e55003c6`），0 落后，冲突只有 `LibrarySection.tsx` 的一行 import，已解。
  **提醒**：如果整支合进 main，素材页上会出现「从网盘导入」按钮——没配环境变量时它显示「未配置」，但那仍是用户看得见的变化。要只带服务端层，合到 `2fc05059` 为止。
- **账号登录会话**（`接通 Google 账号登录`）与本分支**共用同一个 Google Cloud 项目**。配套规矩写在任务书 8.4：这个项目的范围列表只许加非敏感范围；JavaScript 来源各管各的（5321 归探针，5830 归登录）。两边已互相确认。

## 8. 补记（2026-10-23 晚，端到端跑通之后）

端到端通了：用户在 5321 上走完「从网盘导入 → Google Drive → 授权 → Picker 选文件」，他自己 Drive 里的 `【托业单词神器】墨墨背单词操作.mp4` 进了素材库、片段上了时间轴、画面正常。

**顺带查出并修掉一个早就存在的缺陷。** 用户报「添加的时候预览失败，但是最终导入成功」，控制台对应 `An empty string ("") was passed to the src attribute`。根因在 `src/render/FrameScene.tsx` 的 `srcOf`：`mediaTier.ts` 的 `playbackUrl` 在素材还没有地址时回空串，它的文件头明写「调用方拿到 `""` 就不挂 src」，`srcOf` 却把空串原样传进了 `<video src>`，浏览器当成「再下载一遍当前页面」。

**不是网盘这条路引入的**：素材入库前一律挂 `pending: true` + `url: ""`，本地导入这个窗口只有毫秒级所以从没被发现，从网盘拉要几十秒到几分钟，整段都看得见。改了三处（`FrameScene` 的 `srcOf`、`VideoTrack` 的两处），并加了守门测试 `src/render/emptyMediaSrc.test.mjs`。

验证：守门测试 3 条过；受影响的渲染测试 52 条 + 31 条全过；`tsc -b` 零错误；页面重新加载后 `emptySrc: 0`、无新报错。

**语义也写进去了**（用户 2026-10-23 逐条认可 dry run）：`product/asset-service.md` 新增「从第三方存储导入」、`workflow/materials.md` 加一行、`mechanism/asset-service.md` 新增同名一节、`glossary.md` 加「第三方存储」、`docs/plan/TODO.md` 更新旧待办并加索引行。所以第 4 节第一条「语义文档一个字都还没改」已经不成立。

**另外报两处 `promptcut-dev` 技能与仓库对不上的地方**（按技能规则五）：① 技能说 `.gitignore` 里有 `/my_agent/`，实际没有，照技能把 `my_agent/` 复制到仓库根目录会被 git 看见——已在本分支的 `.gitignore` 补上，主工作区没动；② 技能多处指向 `docs/semantics/README.md`，仓库里是 `developer_guide.md`。
