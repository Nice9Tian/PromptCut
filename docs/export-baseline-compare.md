# 全长导出逐字节相同:基线对账怎么跑

C1(挂载算式统一)和 H7 的验收口径是一句话:**不含 Python 卡的项目,全长导出的每一帧和
`git HEAD`(0ba58cb)导出的那一帧逐字节相同。** 工具是 `scripts/probes/export-baseline-compare.mjs`。

口径是 sha256 逐字节,不是「看着一样」。只有在**已经不同**的帧上才再算一次像素差 ——
那一步只用来区分「抗锯齿末位差几个像素」和「真的画错了」,两种都不通过。
方法学上的坑见 `docs/compare-pitfalls.md`(预热错帧、样式写法、浮点末位、WAAPI 与 JS 两条动画路径)。

## 0. 前置:两棵树、两台 dev server、一份素材

基线必须跑 **HEAD 那棵树自己的** `scripts/export-frames.mjs`(引擎在 `server/bakery/`)(引擎在 `server/bakery/`) —— 这次重构改的就是它,
拿工作树的脚本去烘基线不是 apples-to-apples。所以基线用 git worktree,不动主树的 git 状态:

```bash
cd C:/Users/admin/Documents/PromptCut
git worktree add <scratch>/pc-head 0ba58cb
# package.json / package-lock.json 在这次重构里没动过,node_modules 直接共享,省一次 npm ci
cmd /c mklink /J <scratch>\pc-head\node_modules C:\Users\admin\Documents\PromptCut\node_modules
```

素材(ffmpeg testsrc2)两棵树的 `out/media` 各放一份,两边都按 `/@media/<文件名>` 取:
HEAD 只有文件名路由,工作树 A1 换成了内容哈希键但保留了文件名迁移兜底,所以同一个 URL 两边都通。

```bash
ffmpeg -f lavfi -i "testsrc2=s=320x180:r=30:d=8" -c:v libx264 -pix_fmt yuv420p -g 30 -y pc-baseline-fixture.mp4
cp pc-baseline-fixture.mp4 C:/Users/admin/Documents/PromptCut/out/media/
cp pc-baseline-fixture.mp4 <scratch>/pc-head/out/media/
```

两台服务器。**端口避开用户的 5190(编辑台)和 5197(dev-test)**;
`TEMP` 指到 scratch,别让实验服务器覆盖全局的 `%TEMP%\promptcut\port.json`
(`docs/compare-pitfalls.md` 第 8 条):

```bash
cd <scratch>/pc-head && TEMP=<scratch>/tmp-head TMP=<scratch>/tmp-head npx vite --port 5215 --strictPort --host 127.0.0.1
cd C:/Users/admin/Documents/PromptCut && TEMP=<scratch>/tmp-work TMP=<scratch>/tmp-work npx vite --port 5216 --strictPort --host 127.0.0.1
# 开工前先确认素材两边都取得到(都要 200 和同一个字节数)
curl -o /dev/null -w "%{http_code} %{size_download}\n" http://127.0.0.1:5215/@media/pc-baseline-fixture.mp4
curl -o /dev/null -w "%{http_code} %{size_download}\n" http://127.0.0.1:5216/@media/pc-baseline-fixture.mp4
```

## 1. Fixture

`<scratch>/export-fixture/project.json`,由同目录的 `make-fixture.mjs` 生成:
1280×720、30 fps、8 秒(**240 帧**,`000000.png` ~ `000239.png`),不含 Python 卡。
一层一张,覆盖各类渲染路径:

| 序列 | 片段 | 覆盖什么 |
| --- | --- | --- |
| 文字层 | `punch-pill` 0–2.5 / `odometer` 2.5–5 / `mu-word-rotate` 5–8 | 纯 DOM 文字 + Motion 卡 |
| 常驻层 | `chapter-bar` 0–8 | 跟时间轴走的 evolve 卡 |
| 图表层 | `growth-curve` 2–6 | SVG 渐变 id(`useId()` 改名那条路) |
| 三维层 | `scene-3d` 1–5 | WebGL,挂载那一帧动态 `import("three")` |
| 粒子层 | `particles` 0–8 | canvas / tsparticles,带 seed |
| 素材层 | `pc-baseline-fixture.mp4` 0–8 | 视频层 + 毛玻璃背景采样 |

项目由 `?timeline=data:application/json,…` 带进导出页(和 `scripts/verify-*.mjs` 一个写法),
不落盘、不经 `/@export/<id>`,两棵树拿到的是同一份字节。

## 2. 跑

基线(HEAD 那棵树的脚本 + 5215):

```bash
node scripts/probes/export-baseline-compare.mjs run \
  --tree <scratch>/pc-head --origin http://127.0.0.1:5215 \
  --project <scratch>/export-fixture/project.json \
  --out <scratch>/export-fixture/baseline
```

候选(工作树的脚本 + 5216)。树安静下来之后随时可以重跑这一条:

```bash
node scripts/probes/export-baseline-compare.mjs run \
  --origin http://127.0.0.1:5216 \
  --project <scratch>/export-fixture/project.json \
  --out <scratch>/export-fixture/candidate \
  --baseline <scratch>/export-fixture/baseline/frames
```

(`--baseline` 可以不给,那就只出帧;之后单独比:)

```bash
node scripts/probes/export-baseline-compare.mjs \
  --baseline <scratch>/export-fixture/baseline/frames \
  --candidate <scratch>/export-fixture/candidate/frames
```

`--baseline` / `--candidate` 给 `<out>` 或 `<out>/frames` 都认。**有任何不同就退出码 1。**

## 3. 为什么是这些开关

- `--no-video`:验收比的是帧,不是编码产物。ffmpeg / ProRes / 合成那一段不进对账。
- `--workers 1`:分片计划(`src/render/shardPlan.mjs`)本身也在重构范围内,
  两边分片数不同会把「分片边界重新挂载」的差异混进来,那不是要测的东西。
- Chrome 参数(`--disable-gpu`、软件光栅化、`--font-render-hinting=none`、
  `--disable-partial-raster` …)都在各自那棵树的 `server/bakery/chrome.mjs` `CHROME_ARGS` 里,
  探针**不覆盖** —— 它们正是要比的东西之一。
- fps 取项目里的 30,两边同一个值。

## 4. 输出长什么样

```
基线   …\baseline\frames  240 帧
候选   …\candidate\frames  240 帧

逐字节:相同 240/240

✅ 全长导出逐字节相同
```

不通过时(下面是拿相邻帧冒充自己做的反向对照,证明比对器真的会报):

```
逐字节:相同 3/4,不同 1
第一处不同:000102.png
  000102.png  464465B/462854B  sha 5faa7eb1eaa9…/c94e9b0c3137…  像素差 423551/921600(45.9582%)最大通道差 253 首处 (321,0)

❌ 不通过
```

「像素差几个、最大通道差 1~2」是抗锯齿末位那一类;
「像素差几十万、最大通道差 200 以上」是错帧或真的画错了 —— 先按 `docs/compare-pitfalls.md`
第一条规矩,把那一帧拼成「A | B | 差异 ×8」看一眼再下结论。

## 5. 2026-09-17 的一次实跑

- 基线:HEAD 工作树 + 5215,240 帧,17.7 s。
- 候选:工作树(步骤 1–3 改到一半的状态)+ 5216,240 帧,36.0 s。
- 结果:**240/240 逐字节相同**,退出码 0。

工作树当时仍在被其他 agent 编辑,这一趟只能说明**那一刻**的树与 HEAD 一致;
落定之后要按上面第 2 节的候选命令再跑一遍。
