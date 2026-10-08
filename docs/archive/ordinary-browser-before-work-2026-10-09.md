# 开工前普通档 C10 单次对照

工作树 acceptance-main-baseline。开工前先核git status为空，整树reparsePointCount=0，node_modules为普通目录；仅 git switch --detach 301c3092565588362764975c9cde2418ece3b3b9，未reset/pull/合并/编辑仓库文件。

命令为该提交原始 node scripts/probes/c10-browser-probe.mjs --base-port 6320 --keep-temp --out <本前缀-out>。未复制后续c10-judge/用户CPU卡/全文回读夹具，没有新增开关。默认普通档mode=a1-a5、role=all，实浏览器。启动前6320–6329零LISTEN。runner仅从根cbe安全运行器替换tree/source/唯一TMP前缀；Python cuda_Vit两个显式变量、主库models、绝对silent preload、PYTHONDONTWRITEBYTECODE、canonical PSModulePath均只进程设置；Popen CREATE_NO_WINDOW。原probe PID25424，自然结束，无手工中止、无native retry、无第二轮。

结果：exit1 / okfalse / 3fails / pending0；wall1075.843秒，script1075771ms，A5阶段924723ms。源码前后相同，git status为空。

3条失败均在原A5 host链：
1. 原15分钟hostDidWork等待超时。
2. 独立渲染主机(host档)认领、切分、完成断言失败。
3. claimed为空，后续主机环境指纹断言也失败；它是该未取得成功claimant的后续断言，不证明真实host指纹相同。

已发布页面plan为成功/open、10个clips；最终claimant=null。原脚本没有保留等待末次node计数，不能从null编造claimed/plans/completed具体值。后续页面新快照正常：by=page、envFingerprint258acaaa7c5fe509、ready120、新resultKey37011400458b；播放shown非空。A4原始播放占位和暂停活渲截图都在-out。没有将页面赢推断为本次host失败唯一根因。

与根当前cbe8398dccffc84760ed8db734777ee0d88cd607对照：cbe首轮exit1/2fails/pending0/wall200.313秒，失败在新增“文档服务接受的当前全文”前置超时及对应异常，host未启动。本次原301也失败，但走过原页面流程、实际启动host，失败是原A5 host完成标准。不能据此声称两次失败具有相同根因，也不能把cbe新增前置失败归为新CPU卡测轻。原301新层判据允许页面或host指纹；后续候选新增了专用用户重卡及严格同目标host完成证据，两套夹具并不完全相同。单次对照证明原普通档当前环境下也未全绿，不单独证明产品回归来源或排除环境/竞争因素。

清理：探针自身报告deleted=shared.admin.ok、listening=[]，保留自己的TMP证据。事后外部核6320–6329零LISTEN；原probe PID25424不存在；按本轮唯一TMP前缀/工作树匹配的node/chrome/chromium/ffmpeg/python进程为空（详postflight）。未结束其它进程或删除工作区。

证据文件都在系统TMP，前缀pc-baseline-c10-301c3092-20261009：.py安全runner、.log完整原始输出、.result.json运行摘要、.probe-result.json原最后JSON全文、.handle.json启动归属、.postflight.json清理与源码证明、-out/a4-placeholder-while-playing.png、-out/a4-settled-live.png、-out/creator-editor.log、-out/host.log。未运行npm/目标/full/type/TLS附加测试/节点或其它探针。
