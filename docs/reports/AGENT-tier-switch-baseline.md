# A4 + A5 集成验证的换档失败定位

专用分支 claude/tier-switch-baseline 从 claude/release-no-git 913f223e 分出，主会话自己查；没有调用顾问或子 Agent。代码尚未修改。

2026-10-02，按 verification.md 各子分支单跑失败项：skill-mcp 与 tray 的换档退出 0；release-no-git 退出 1（93.2 s）。T5a 182 个无显示样本；T5c 素材原尺寸超时、5436 个无显示样本；T5e 无对齐回调、198 个无显示样本。页面未捕获错误 0。其它分支继续串行定位。不能把真失败解释成机器差异。

三支 VideoTrack/mediaSync/mediaTier 实现相同。区别包括 Chrome 探针启动参数 PROBE_CHROME_ARGS，以及 main 后续的图卡素材取帧和导出取帧修复；还未证明哪一项造成失败。正在准备只增加观察记录的诊断探针，原有黑帧、帧误差、超时断言原样保留；先确定素材层消失与舞台角色、时刻、槽位事件的关系，再选修法。

尺子：原始 `node scripts/probes/tier-switch-probe.mjs --origin <isolated dev> --remote-port 6345 --out <unique>` 退出 0；门槛与采样断言不降低；如果改渲染路径，加 G0-R 与对 main 的零像素差异。
