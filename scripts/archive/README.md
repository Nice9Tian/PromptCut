# 归档:已撤下的渲染管线

这里的脚本**不被任何代码引用**,只留作对账和考古。要改导出,改 `scripts/export-frames.mjs`。

## export-frames-virtual-time.mjs

0.3.x 的导出后端:CDP 虚拟时间推一格 → `__pcSyncAnims` 钉动画 → `page.screenshot`(截图时临时放开虚拟时间)。
0.4.0 换成 chrome-headless-shell 的 `HeadlessExperimental.beginFrame`,理由和实测见
`docs/render-rebuild-plan.md` 阶段 1,摘要:

| | 虚拟时间(这里) | beginFrame(现行) |
|---|---|---|
| demo 全长 1800 帧 | 107.7 ms/帧 | 26.9 ms/帧 |
| 自己连导两趟 | 偶发不一致(一次 600 帧里 13 帧) | 四次两两比对全部一致 |
| 两者对账 | 1753/1800 相同,其余 47 帧全部来自系统字体回退,主题字体栈补齐后消失 |

它和现行后端的接口完全相同(`openBakery` / `bakeFrames` / `exportFrames`),仍可单独运行,
用来和现行后端逐帧对账:

```bash
node scripts/archive/export-frames-virtual-time.mjs --url "http://127.0.0.1:5197/?export=1" --frames 0-599 --out out/legacy --no-video
```

唯一改过的地方:`import('./mux-audio.mjs')` 改成了 `import('../mux-audio.mjs')`,因为挪了一层目录。
