# AGENT-rr-play-alive:桌面版播放保活

分支 `claude/rr-play-alive`(从 main 162a72be 分出)。任务:播放期间页面定时向 `/api/data/playhead` 发保活,免得预渲染进程在「播放头下没有缺口」时误判用户不在播放、在播放中恢复产流(违反 `docs/semantics/mechanism/rendering.md`「重管线:预渲染」第 103 行「之后要补的只在暂停时产,播放时不产」)。

## 进度

- [ ] 复现探针 `scripts/probes/play-idle-probe.mjs`(main 上应不过)
- [ ] 页面一侧保活(`src/render/dataMirror.ts`)
- [ ] 单测(页面一侧、服务端一侧)
- [ ] 修后重跑探针、`sparse-stream-probe`
- [ ] 基线(tsc、npm test、键比对)
