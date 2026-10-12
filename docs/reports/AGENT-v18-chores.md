# 报告:块九 零碎(分支 claude/v18-chores)

## 做了什么
1. 三个测试文件(server/test/account-hosted-wiring、asset-wiring-integration、account-projects-provider 的 .test.mjs)去掉写死的 VisuHive 工作区路径。缺省改为空串,没设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 就跳过,跳过原因里写明要设哪个变量(asset-wiring 和 hosted-wiring 还写了 PROMPTCUT_PASSWORD_ORDER_MODULE)。account-projects-provider 原来读 ACCOUNT_PROVIDER_DIR,已统一成 PROMPTCUT_ACCOUNT_PROVIDER_ROOT。
2. 起子进程补 windowsHide: true,共 72 处:scripts/probes 37 处(26 个文件)、desktop/scripts 29 处(9 个文件)、scripts/remote/docservice.mjs 5 处、scripts/archive 2 处。只加选项,没有 detached: true 的调用;没有"选项来自变量"的调用,全部是字面量对象或无选项参数。渲染相关的探针文件只加了这一个选项。
3. 守门测试 windows-hide-silent-spawn.test.mjs 的扫描范围扩为 server/(不含 server/test)、scripts/ 整个目录树、desktop/scripts/。

## 验证
- 设两个变量时三个文件:account-hosted-wiring 4 条、asset-wiring-integration 1 条、account-projects-provider 17 条,共 22 条,全过、0 跳过。不设变量:这三个文件共 3 条用例跳过(带原因),0 失败(同批 6 条里另 3 条是同目录别的文件)。
- 此前这组用例确实在被跳过(account-projects-provider 读错变量名,退回的路径不存在);统一后跑起来无不过的,没有改松任何断言。
- asset-wiring-integration 单独跑第一次出现 Node 内部断言崩溃(InternalCallbackScope::Close,已知忙时偶发),重跑两次都过。
- npm test(设两个变量):退出码 0,tests 5909、pass 5906、fail 0、skipped 3(3 条是 Windows 平台跳过,与本任务无关)。
- npx tsc -b --force:退出码 0。
- 守门测试:4 条全过;故意去掉 scripts/probes/reveal-probe.mjs 的一处 windowsHide,变红(fail 1,报出该文件第 76 行),还原后恢复绿。
- 探针抽测三支(前后查可见窗口,均无):stream-encoder-params(--repeats 1,三种编码器全 PASS)、sound-effects-probe --node-only(正常出报告)、videodecoder-probe(端口 28041,无头 Chrome,出完整解码数据)。

## 仓库里其它写死本机路径的地方(没动,按说明)
- scripts/probes/export-baseline-compare.mjs:19 注释里的 node_modules 联接路径。
- src/editor/io/procp.test.mjs:364 测试数据里的字符串 `C:\Users\admin\Videos\...`(夹具样例路径,不访问文件系统)。
- python/tests/test_subject_dino.py:7 文档字符串;tools/subject/README.md、fetch_dino.py、fetch_light_models.py 里写 anaconda 解释器路径(说明文字)。
- archive/python-cards/docs/*.md 里的历史记录。
这些都是注释、说明或样例字符串,不是缺省值,不影响别的机器上跑。是否清掉由主会话定。

## 没做成 / 注意
- 没有。守门测试没有新增例外条目。
- 〔裁〕把 scripts/remote 和 scripts/archive 也纳入守门并补上选项(任务只点名探针、acceptance、scripts 下别的、desktop/scripts;这两处属于"scripts 下别的")。

## 对任务书或语义的更正建议
- verification.md「Windows 验证静默运行」可补一句:守门范围含 scripts/ 全树和 desktop/scripts/。
