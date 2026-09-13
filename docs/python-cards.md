# Python 自定义卡片

Agent 可以通过 `create_card` 提交 Python 源码来新增转场、滤镜、动画、强调或音频效果，再用 `apply_card` 将同一个定义应用到不同片段。源码和实例参数随 `.proc` 项目保存。修改现有效果先用 `get_card_source` 读取，再用 `edit_card` 修改定义。

## 运行契约

```python
from promptcut_cards import GLSL

class ColorFilter:
    need_prerendering = False

    def __init__(self, style=None):
        self.style = style or {}
        self.shader = GLSL('''
            uniform sampler2D u_input0;
            uniform float amount;
            void main() {
                vec4 c = texture(u_input0, v_uv);
                outColor = vec4(mix(c.rgb, 1.0-c.rgb, amount), c.a);
            }
        ''')

    def card(self, source, time):
        return self.shader(source.time(time), amount=self.params['amount'])
```

对应定义设置 `language: "python"`、`entry: "ColorFilter"`、`kind: "filter"`、`defaults: {"amount": 0.5}`、`need_prerendering: false`、`compositing: "independent"`。`self.params` 在构造完成后由运行器注入，因此应在 `card` 中读取实例参数。`style` 在构造时传入；`styleKeys: []` 表示不消费全局风格，数组指定需要的顶层字段，省略或 `null` 表示全部风格。

`time` 是片段的局部时间。`source.time(t)` 查询输入在指定时间的结果，不移动编辑器或其他消费者的播放位置。只有一个输入时可直接使用 `source`；多输入使用 `source['A']`、`source['B']` 等名字。输入可以是素材，也可以是另一个节点。输入引用的 `offset` 和 `rate` 描述时间映射。

视觉接口也接受半开区间 `[start, end)`，按项目帧率产生一组结果。`source.time((start, end))` 同样返回该范围的输入帧；范围有帧数上限。音频使用精确采样范围 `TimeRange(start, count, sample_rate)`，避免把音频块边界按视频帧取整。

## 两路转场

```python
from promptcut_cards import GLSL

class Crossfade:
    need_prerendering = False

    def __init__(self, style=None):
        self.shader = GLSL('''
            uniform sampler2D u_input0;
            uniform sampler2D u_input1;
            uniform float progress;
            void main() {
                outColor = mix(texture(u_input0, v_uv),
                               texture(u_input1, v_uv),
                               clamp(progress, 0.0, 1.0));
            }
        ''')

    def card(self, source, time):
        return self.shader(source['A'].time(time), source['B'].time(time),
                           progress=time / self.params['duration'])
```

这里的钳位在 GLSL 中完成。Python 符号时间支持明确的算术表达式及提供的 `sin`、`cos`，不支持把任意 Python 分支、库调用或算法自动编译成 GPU 程序。不支持注册的代码会按 Python 路径执行，而不会被当作已编译的实时程序。

## Python 像素算法与音频

使用 `source.time(time).array()` 按需取得 NumPy 像素。输入是只读的；修改前调用 `.copy()`。返回值可为 `uint8` 的 RGBA 数组或 Pillow 图片。像素使用直通 Alpha。这个路径需要物化与传输像素，冷启动和复杂算法可能明显慢于注册的着色器。

音频卡片的 `card` 接收 `TimeRange`。例如读取原块、改变增益，再保留原采样范围：

```python
from promptcut_cards import AudioBlock

class Gain:
    need_prerendering = False

    def __init__(self, style=None):
        pass

    def card(self, source, time):
        block = source.block(time.start, time.count)
        return AudioBlock(block.samples * self.params['gain'],
                          time.sample_rate, time.start)
```

音频样本使用 `frames × channels` 的浮点数组。非有限样本、错误采样范围等会被拒绝。输入音频的速率变换需要明确的重采样卡片。

## 预渲染与合成

`need_prerendering` 判断是否需要历史推进；`compositing` 判断能否脱离背景单独缓存。这两项独立。只有能由指定时间得到正确结果的卡片才能声明无需历史预渲染。依赖前一帧状态的卡片需要顺序推进。依赖下方画面的毛玻璃等效果以及尚未确认的 Chrome 卡片保留完整浏览器合成上下文。

后台先处理必须预渲染的实例，再生成可独立渲染控件的 MOV，最后生成整片 MOV。编辑器用明确的动态占位表示尚未完成的内容；占位不会作为真实成片缓存。看帧会先复用整片缓存，再混合控件缓存和现场求值，必要时按历史推进，并明确报告不完整结果。

注册 GLSL 能减少逐帧 Python 往返，但不能保证任意效果、任意素材和任意硬件都达到项目帧率。重型 Python 算法、背景依赖的 Chrome 效果和冷缓存需要预渲染。缓存完成后的播放与冷启动播放应分别测量。

## 安装与隔离边界

当前 Python 自定义代码依赖 Windows 的 rappct/LPAC 隔离能力。导入、构造和执行都在受限进程内；允许的输入只读，任务输出和临时目录可写。运行器管理常驻 Python 工作进程并支持取消，不能建立隔离时会报错，不回退到普通 Python 执行。

完整安装包包含经过实际验证的 Python 3.11.9、NumPy 2.2.6 和 Pillow 12.3.0。首次启用这套运行时应安装完整包；仅更新 Node 源码的旧式补丁不能提供新增的 Rust/Python 运行时。
