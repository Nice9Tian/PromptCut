# 发版耗时记录

规则见 `docs/semantics/guide_files/verification.md`「耗时只记录，不当闸门」（2026-10-07 用户改定）：验收项里的时间数字不决定过不过，跟着发版记在这里。一个版本一节，新的写在最上面。

## 怎么出一节

在发版提交上跑一遍本地验证，带 `--release-timings`：

```
node scripts/acceptance/four-stage-acceptance.mjs --out <输出目录> --release-timings "<版本号>"
```

跑完后这一节的文本在 `<输出目录>/release-timings-section.md`（同时打印在终端），整段贴到本文件「各版本」标题下面的最上面。机器配置（哪台、处理器、核数、内存、显卡、系统）由运行器起跑时自动采集，不含任何凭证；`--machine-name <名字>` 可以把「哪台」写成更好认的名字。已经跑过、只想重出这一节：

```
node scripts/acceptance/four-stage-acceptance.mjs --timings-from <输出目录>/results.json --release-timings "<版本号>"
```

在哪台机器上跑都行，写明是哪台。机器有降频的时段时，可以配 `scripts/acceptance/sample-cpu-performance.ps1` 把采样期间的频率读数一起记下。

## 怎么读

- 「各项整项用时」是验收运行器里每一项从开始到结束的秒数，含起服务、建项目、等待。
- 「探针量的耗时」是探针自己量的数字。最后一列是这个数字原来的门槛，现在只作对照，不作通过条件。
- 相邻两版之间某项明显变差，在发版汇报里指出来，由用户决定要不要查；不挡发版。
- 不同机器之间的数字不能直接比，先看「机器」一行。

## 各版本

