# 分轨异步播放：设计与原型

2026-09-14。本文是「播放时各轨道异步播放」的方案，附带已经在本机跑通的拼合 alpha 流原型数据。实现尚未开始，这里只定方向、边界和落地顺序。

## 1. 现在为什么慢

预览里看到的画面全部是服务端整帧渲染的结果，浏览器不做分层合成：

- 暂停：`see_frames` 渲一张整帧 PNG，`<img>` 显示（`src/editor/preview/UnifiedPreview.tsx`）。
- 播放：`FramePlayback` 在无头 Chrome 里提前渲整帧 PNG，追加进 PNG 编码的 MOV（`server/frame-playback.mjs`、`server/frame-mov.mjs` 的 `PlaybackMovStore`）；浏览器每帧一次 Range 请求取回 PNG，`createImageBitmap` 解码后画到 canvas（`src/render/movPlayer.ts`）。
- 内置卡片几乎都被推导成 `frameMode: stateful`、`compositing: unknown`（`src/kernel/frameMode.mjs`），不能单独缓存。播放通道把它们所在的帧标成 incomplete，不发布到 MOV，界面只能显示沙漏占位。
- 安装版实测：热缓存播放约 1.09 fps，最长 4.4 秒没有新帧（`docs/python-card-installed-acceptance.md`）。

瓶颈不是编码格式，而是「每一帧都要一台软件光栅化的 Chrome 把整个画面重画一遍」。只要画面里有一张重卡片，整帧就都得等它。

## 2. 目标结构

播放时只剩两类东西在跑：

1. **前台实时层**：不依赖任何预渲染的轻卡片，由编辑器页面按播放头直接渲染（与导出页同一个 `Stage`/卡片组件，`t` 驱动）。
2. **N 条透明轨道流**：需要预渲染的卡片，由后台按时间线提前渲染、编码成带透明通道的视频流，边写边读；播放器追到哪一帧，就显示这一帧已经就绪的样本，未就绪显示透明。

每条流是一个独立的层，按它所在轨道的层序插在实时层之间（一个流一个 `<canvas>`，放在对应轨道的 DOM 位置上，靠 CSS 层叠定序，不需要把 DOM 画进 WebGL）。

## 3. 卡片属性

用户提出三类标注。对应到现有能力字段如下；新增的两个字段写进 `CardDef`，由 `cardCapabilities()` 统一推导，和现在的 `frameMode` / `compositing` / `need_prerendering` 放在一起。

| 标注 | 含义 | 播放时怎么走 | 与现有字段的关系 |
|---|---|---|---|
| （无标注） | 画面只由 `t` 和参数决定，不依赖别的层 | 前台实时层渲染 | `frameMode: direct` 且 `compositing: independent` |
| `need_prerendering` | 需要历史推进（Motion/rAF/模拟）或太重，但只画自己 | 后台渲成**本卡片的透明流**；追到时在自己的层位显示，平时透明 | 已有字段；`compositing: independent` 时一卡一流 |
| `need_all_scene` | 要根据整个画面计算自己（毛玻璃 backdrop-filter、屏幕空间滤镜、读取下层像素的 Python 卡） | 后台渲成**「本轨及以下全部层 + 本卡」的合成流**；某帧就绪时，这条流直接替代它下面的所有层（下面的层这一帧不再渲染），它上面的层照常叠加 | 相当于现在的 `compositing: context`；把「需要整幅画面」从隐含推导变成显式声明 |
| `need_HTMLdecoder` | 靠 HTML 快照归档重放（B 通道，`server/frame-archive.mjs`） | 在 Worker 里异步解包；只有解包完成的帧才把这张卡加入前台层，否则这一帧它透明 | 新字段；只对已有快照归档的卡有意义 |

推导规则（按优先级）：

1. 显式声明优先，且声明需经审阅（与现在 `compositing` 的规则一致，不从源码猜）。
2. 读下层像素、带 `backdrop-filter` 的卡 → `need_all_scene`。
3. `frameMode: stateful` → `need_prerendering`。
4. 未知的旧卡 → `need_prerendering` + `compositing: unknown`，按 `need_all_scene` 处理（宁可慢，不可错）。

注意：`need_all_scene` 的流依赖下层内容，下层任何一张卡或素材改动都会让它的签名变化（见第 6 节），必须重渲。

## 4. 传输格式：上下拼合 alpha 的 H.264

### 4.1 布局与编码

一帧编码画面 = 上半 RGB + 下半 alpha 灰度，两半之间各留 8 行填充，编码高度对齐 16 像素宏块：

```
[RGB  H 行][填充 8 行][alpha H 行][填充 8 行]   编码高度 = 2 × (H + 8)
```

```bash
ffmpeg -framerate 30 -i src-%03d.png -filter_complex \
 "[0:v]format=rgba,split=2[c][a];\
  [c]format=rgb24,pad=W:H+8:0:0:black[rgb];\
  [a]alphaextract,format=gray,format=rgb24,pad=W:H+8:0:0:black[mask];\
  [rgb][mask]vstack=inputs=2,scale=out_range=pc,format=yuv420p" \
 -c:v libx264 -preset veryfast -crf 16 -g 30 -bf 0 -color_range pc \
 -movflags frag_keyframe+empty_moov+default_base_moof -an out.mp4
```

每个参数都是实测后才定下的：

- `-color_range pc` + `scale=out_range=pc`：full range，alpha 不被压到 16–235。
- `-bf 0`：没有 B 帧。有 B 帧时 fMP4 的第一帧显示时间被推后两帧（实测缓冲区从 0.0667 秒开始），按帧号 seek 会落到缓冲区外卡死；去掉后从 0 开始，解码延迟也最低。
- `frag_keyframe+empty_moov+default_base_moof`：分片 MP4，ffmpeg 边写，浏览器边读。
- 两半之间 8 行填充：去掉接缝串色（见 4.3）。
- 本机 ffmpeg 还有 `h264_nvenc` / `h264_qsv` / `h264_amf` 硬件编码器可选。

### 4.2 浏览器端还原

```glsl
vec3 rgb = texture(tex, vec2(uv.x, rgbTop   + uv.y * half_)).rgb;
float a  = texture(tex, vec2(uv.x, alphaTop + uv.y * half_)).r;
color = vec4(rgb, a);          // rgbTop=0, alphaTop=(H+8)/(2H+16), half_=H/(2H+16)
```

- 原型用 MSE：`SourceBuffer` 以 32 KB 为单位慢速追加，服务端也按 16 KB 慢速吐数据，模拟文件还在写。每次追加后 `buffered` 右端持续增长（0.13 → 3.0 秒），可以边追加边 seek。
- 逐帧精确的随机访问放到第二阶段：用 WebCodecs `VideoDecoder` + fMP4 解封装（mp4box.js 或自写 moof/mdat 解析，结构简单），从最近关键帧解到目标帧。MSE 的 seek 依赖 `<video>`，适合顺序播放，不适合拖动时的逐帧精确。

### 4.3 原型实测（640×360，90 帧，含柔边圆形 alpha、硬边方块和彩条）

浏览器（Chrome，WebGL2）里还原后与源 PNG 逐像素比较，取第 0/17/45/89 帧：

| 版本 | alpha 平均误差 | 半透明边缘平均误差 | alpha 最大误差 | 不透明区 RGB 平均 / 最大 |
|---|---|---|---|---|
| 有 B 帧 | — | — | — | seek 第 0 帧超时 |
| 无填充 | 0.33–0.40 | 0.95–1.03 | 50–54（均在 (0,0)，接缝串色） | 2.1–2.9 / 111–150 |
| **8 行填充** | **0.28–0.35** | **0.95–1.04** | **9–27（硬边方块角）** | 2.1–2.9 / 111–150 |

- 3 秒 640×720/736 的流约 540–590 KB（CRF 16）。
- RGB 最大误差集中在彩条的锐利色边，是 4:2:0 色度下采样的固有限制，预览可接受；成片导出仍走无损 PNG / ProRes，不受影响。

## 5. 播放器

- 单一主时钟（现有 `Preview.tsx` 的 rAF 播放头），所有层按同一个 `t` 取帧。
- 每条流维护「已就绪帧表」（来自服务端，见第 6 节）。追到的帧已就绪就绘制，未就绪清空该层（透明），不回退显示旧帧，避免错位。
- `need_all_scene` 流就绪的帧，隐藏它下面的层（实时层暂停挂载、下层流不绘制），这一帧只画它和上面的层。
- 同时解码的流数设上限（先按 4 条），超出的层回退到现有整帧通道；并发硬件解码上限没有权威数据，要在目标机器上实测后再定。

## 6. 与缓存校验的关系

第 5 项已经在 `MovFrameStore` 里为每帧记录签名：截图代码指纹、渲染倍率、这一帧可见卡片的哈希（`server/frame-mov.mjs`、`frame-pipeline.mjs` 的 `renderSignature`），并把透明帧当成「等待渲染」，直到第二次渲染确认。轨道流沿用同一张表：

- 流的每个样本登记它的签名；播放器请求就绪帧表时，服务端用当前项目重算签名，不一致的样本从表中剔除，并在流里换回透明占位（`PlaybackMovStore.evict` 已实现同样的语义）。
- `need_all_scene` 的签名包含它下面全部层的卡片哈希和素材指纹。

## 7. 分阶段落地

1. **卡片属性**：`CardDef` 增加 `need_all_scene`、`need_HTMLdecoder`，`cardCapabilities()` 推导；右侧面板显示；给内置卡补声明（先从已知独立的轻卡开始）。
2. **前台实时层**：编辑器预览在播放时直接渲染无标注卡片（复用 `Stage`），其余层暂时仍走整帧通道。
3. **单卡透明流**：`need_prerendering` 且 `independent` 的卡在后台渲成拼合 alpha 的 fMP4；前台一卡一个 canvas，MSE 顺序播放。
4. **合成流**：`need_all_scene`，含「替代下层」的绘制规则。
5. **逐帧随机访问**：WebCodecs + fMP4 解封装，拖动播放头时帧精确。
6. **`need_HTMLdecoder`**：Worker 解包归档，完成的帧加入前台。

每阶段都要跑安装版的播放验收（`scripts/verify-installed-python-cards.mjs`：帧率 ≥ 80%、空白采样 < 5%、最长间隔 < 300 ms）。

## 8. 风险

- **并发解码数**：多条 1080p（编码高度 2176）流同时硬解的上限因显卡和驱动而异，需要实测。
- **色边精度**：4:2:0 下锐利色边 RGB 误差可达 100 以上；如果预览里文字边缘发虚明显，可改用更低 CRF 或对文字类卡片保留整帧通道。
- **WebView2 编解码器**：桌面版运行在 WebView2，需确认目标机器的 H.264 MSE 支持（`MediaSource.isTypeSupported`），不支持时回退整帧通道。
- **层序和 3D**：流是平面 canvas；`camera3dFov` 下有三维变换的卡必须把变换烘进流里，前台不再二次变换。

## 9. 原型复现

原型文件在会话临时目录，没有进仓库：

1. 用 ffmpeg `testsrc2` + `geq` 生成 90 帧 RGBA PNG。
2. 按 4.1 编码。
3. 用一个本地 HTTP 服务慢速吐出 mp4，页面用 MSE 分块追加。
4. WebGL 按 4.2 还原，`readPixels` 读回后与源 PNG 逐像素比较。

需要时可以把它整理进 `scripts/`。
