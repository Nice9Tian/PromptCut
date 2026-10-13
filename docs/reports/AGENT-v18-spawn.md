# AGENT-v18-spawn:云端 Agent 服务起子进程的加固

分支 `claude/v18-spawn`,从 main `1ed2b5b8` 起。这是主会话审三个工具包(语音转写、运动追踪、主体识别)的差异时发现的两处加固,不是新功能,用户看不出区别(三级:具体机制)。

## 1. 做了什么

### 1.1 一处公共实现:`server/agent/service/perception/runner.mjs`(新文件,只用 Node 标准库)

| 导出 | 管什么 |
|---|---|
| `spawnTree(command, args, { cwd, env, stdio }, { spawnImpl })` | 起一个子进程当一棵树的根:不弹窗口、不经 shell;Linux / macOS 上是新进程组的组长(`detached: true`)。回的 `child.kill()` 被换成杀整棵树,所以只会 `child.kill()` 的旧代码(`server/audio-loudness.mjs` 的超时)杀的也是整棵树 |
| `killTree(child, signal = 'SIGKILL')` | Linux:`process.kill(-pid, 信号)` 按组杀;组长先退、孙进程还握着管道时照样按组杀;`exit` 与 `close` 都到了之后不再发信号(进程号可能已归别人)。Windows:系统目录里的 `taskkill /F /T /PID`,没杀成退回只杀根 |
| 组长退出时扫一次组 | `spawnTree` 里挂的:组长自己退了,组里还剩的(它起的、没等的孙进程)一并 SIGKILL,不留孤儿。只在非 Windows |
| `whenClosed(child)` | 等到 `exit` 与 `close` 都到(或根本没起来) |
| `treeResource(child)` | 给运行资源登记器(`run-resources.mjs`,kind `child`)的外壳:`kill()` 杀整棵树,`exit` + `close` 都到才算关,起不来的也补上这两个事件 |
| `superviseChild(child, { resources, context, timeoutMs, signal, onStdout, onStderr })` | 登记进运行资源登记器;登记被拒就杀掉、等收干净再抛;超时与外部取消信号都杀整棵树;`done` 在子进程 `exit` + `close`、且登记器也看到它关了之后才解决。起都没起来的不登记,`done` 里带 `spawnError` |
| `groupAlive(pid)` | 进程组里还有没有活进程(非 Windows);Windows 回 null(不知道)。现在没人用,留给接线包做「整棵树都退了」的凭据(`run-resources.mjs` 的 `childTreeWitness` 现在没有人给) |
| `isolatedPythonArgs(模块名, { roots, args })`、`PYTHON_ISOLATED_FLAGS`、`PYTHON_BOOTSTRAP`、`splitRoots` | Python 隔离模式的命令行,见 1.3 |

### 1.2 五处调用方

| 调用方 | 改之前 | 改之后 |
|---|---|---|
| `workspace.mjs` 的 `spawn()` | 不建进程组;自带的超时只 `child.kill('SIGKILL')` | 经 `spawnTree` 起;自带的超时 `killTree`;`killTree` 也从 `workspace.mjs` 转出。`hosted-tools.mjs` 里那处 ffprobe 没改代码,跟着得到同样的行为 |
| `perception/stt.mjs` | 自己的 spawn + 自己的 `killTree`(Windows、Linux 都对);把 `child.kill` 换成 `killTree` 而 `killTree` 的退路又调 `child.kill`,按组杀抛错时会互相递归 | `spawnTree` + `superviseChild`;自己的 `killTree`、引导代码删掉;递归没有了(退路用的是原来的 `kill`) |
| `perception/subject.mjs` | Windows `taskkill /T`,Linux 只杀 Python 本身 | `workspace.spawn()` + `superviseChild`;自己的 `killTree`、`childResource` 删掉 |
| `perception/track.mjs` | 两个平台都只 `child.kill()`(Linux 上还是 SIGTERM) | `workspace.spawn()` + `superviseChild`;`close()` 里的 `child.kill()` 现在就是杀整棵树 |
| `hosted-collect.mjs` | 取消与超限 Windows `taskkill /T`、Linux 只杀本身;**超时走的是工作区自带的那个,两个平台都只杀 Python 本身** | `workspace.spawn()` + `superviseChild`(超时、取消信号都杀整棵树;出网代理在整棵树收干净之后才关) |
| `hosted-audio.mjs` | `workspace.spawn()` 起 ffmpeg / ffprobe | 代码没改(只改了文件头的说明):经 `workspace.spawn()` 得到进程树与按树杀的超时 |

没有接运行资源登记器的两处:`hosted-collect.mjs` 与 `hosted-audio.mjs`。它们是旧式的托管工具,拿不到这一轮的可信上下文(ToolRunContext),登记器的 `register(context, …)` 没法调;接线在 `hosted-tools.mjs`,归最后的接线包。现状:采集的取消走 `stopAll()` 的信号(现在杀整棵树),测响度靠 55 秒的超时。见第 5 节。

### 1.3 Python 隔离模式

四处起 Python 的命令行现在都是

```
python -I -X utf8 -u -B -c <引导代码> <目录个数> <目录…> <包名> <包自己的参数…>
```

(没有包目录要递时是 `python -I -X utf8 -u -B -m <包名> …`,`-I` 之下 `-m` 也不把当前目录放进搜索路径。)

- `-I`:不看 PYTHON* 环境变量,不把当前目录(对话工作区)和用户 site 放进模块搜索路径。
- 引导代码(`PYTHON_BOOTSTRAP`,一行):从命令行取目录,插到 `sys.path` 最前,再 `runpy.run_module(包名, run_name='__main__', alter_sys=True)`,等同 `-m`。目录只来自部署配置:`stt` 的 `runtime.sourceRoot`、`subject` 的 `config.pythonPath`(仓库 `python/` 与受控安装目录)、`track` 的 `python.packageRoot`、`collect` 的 `config.pythonPath`。配置的形状没变(仍是用路径分隔符连起来的串),读配置的函数没动。
- 环境变量 `PYTHONPATH`、`PYTHONUTF8`、`PYTHONIOENCODING`、`PYTHONUNBUFFERED`、`PYTHONDONTWRITEBYTECODE`、`PYTHONNOUSERSITE` 不再设(设了也不生效),换成 `-X utf8`、`-u`、`-B`;`stt.mjs` 原来设的 `PYTHONNOUSERSITE`、`PYTHONUTF8` 是摆设,一并删了并补上 `-X utf8`。
- 各包自己的 `--pylibs`、`--models-dir`、`--models`、`--ffmpeg`、`--requirements` 照用。
- `config.args`(`subject`、`collect` 的替身入口,只给单测与探针:把解释器整个换成一个 node 脚本)照旧整段替换,不加 Python 的开关。

### 1.4 `python/` 下的小改(三个文件,各一行加一行注释)

`promptcut_stt`、`promptcut_subject`、`promptcut_track` 的 `__main__.py` 里起 pip 的那一行,从 `[sys.executable, "-m", "pip", …]` 改成本进程是隔离模式时带上 `-I`:

```python
isolated = ["-I"] if sys.flags.isolated else []
cmd = [sys.executable, *isolated, "-m", "pip", "install", "--target", …]
```

为什么有必要:包被隔离模式起来之后,它再起的 `python -m pip` 是一个新的解释器,工作目录还是对话工作区,`-m` 又会把当前目录排到搜索路径最前——工作区根下一个 `pip.py` 或 `json.py` 就在安装时被执行,第 2 个问题原样搬到了孙进程。桌面版不是隔离模式起的(`sys.flags.isolated` 为 0),行为不变。`promptcut_collect` 的安装云端从不调(`collect_install` 不起进程),没改。

## 2. 验证结果

机器:Windows 11,Node v24.19.0,Python 3.11.15(`anaconda3\envs\cuda_Vit\python.exe`)。耗时只记录。

### 2.1 恶意同名模块(`server/test/cloud-tools-spawn-isolation.test.mjs`,真 Python)

做法:在对话工作区根下放 `json.py`、`argparse.py`、`promptcut_stt.py`、`promptcut_subject.py`、`promptcut_track.py`、`promptcut_collect.py`,内容是往工作区外的一个标记文件里写一行自己的名字;分别调四个调用方的状态查询(`stt_status`、`subject_status`、`track_status`、`collect_status`),断言标记文件没有被写,并断言真包确实跑出了状态。

**没改的代码上(main `1ed2b5b8`)**:`npm test -- server/test/cloud-tools-spawn-isolation.test.mjs` → `pass 1 / fail 3`,红的三条原样:

```
✖ 主体识别:工作区根下的同名模块不被导入,状态照常查得到
  AssertionError [ERR_ASSERTION]: 恶意模块被导入了:promptcut_subject
✖ 运动追踪:工作区根下的同名模块不被导入,状态照常查得到
  AssertionError [ERR_ASSERTION]: 恶意模块被导入了:promptcut_track
✖ 网页采集:工作区根下的同名模块不被导入,状态照常查得到
  AssertionError [ERR_ASSERTION]: 恶意模块被导入了:promptcut_collect
✖ npm test 最终结果：仍有失败
```

(`python -m promptcut_subject` 在工作区里直接把工作区根下的 `promptcut_subject.py` 当成了要跑的包;语音转写那一条本来就是绿的。)

**改之后**:同一条命令 → `tests 4 / pass 4 / fail 0`,`✓ npm test 最终结果：零失败`。

### 2.2 进程树(`server/test/cloud-tools-spawn-tree.test.mjs`,Windows 上真跑)

子进程是真 Python,它再起一个真 Python 孙进程(继承标准流,像 Python 起 ffmpeg),两个进程号由它自己报出;每个用例之后用 `process.kill(pid, 0)` 核对两个进程号都查不到。

| 层 | 用例 | 结果 |
|---|---|---|
| 公共实现 | 登记器撤销(`abortForFence`),并核对撤销后再起的子进程登记被拒、被杀、收干净才抛 | 过 |
| 公共实现 | 超时两种:`superviseChild` 的、`workspace.spawn()` 自带的 | 过 |
| 公共实现 | 外部取消信号;只会 `child.kill()` 的旧代码;登记器 `close()` | 过 |
| 公共实现 | 起不来的解释器不登记、不悬着 | 过 |
| 运动追踪 | 超时、撤销、`close()`(包目录指到替身包,解释器是真的,走 `track.mjs` 真实的起进程路径) | 过 |
| 主体识别 | 超时、撤销、`close()` | 过 |
| 语音转写 | 超时、撤销、`close()` | 过 |
| 网页采集 | 超时、取消(`stopAll`),并核对代理在进程树收干净之后关掉 | 过 |
| 平台分支 | 用假子进程与注入的杀法核对:非 Windows 起成组长、按组杀、组长先退仍按组杀、收干净后收手、按组杀失败退回只杀组长;Windows 用 taskkill、不重复起、没杀成退回、根退了收手 | 过 |
| 隔离模式 | 命令行形状;真 Python 核对当前目录不在 `sys.path`、包目录排最前、参数与 `sys.argv[0]` 同 `-m`、UTF-8、不写字节码,且环境里故意设的 `PYTHONPATH=当前目录` 不生效 | 过 |

`npm test -- server/test/cloud-tools-spawn-tree.test.mjs` → `pass 22 / fail 0`。

**同一份测试放到没改的服务代码上**(临时把五个服务文件换回 `1ed2b5b8` 跑,跑完换回):运动追踪三条全红、网页采集红(超时那一步)、经 `workspace.spawn()` 的公共用例红;主体识别、语音转写在 Windows 上本来就绿。红的时候留下了 4 个孤儿孙进程(`python -I -c "import time; time.sleep(600)"`,父进程已死),测试挂在等它们;我按进程号把这 4 个和测试进程收掉了。这同时说明一件派活时没写到的事:**采集的超时在 Windows 上原来也杀不干净**(它走的是工作区自带的超时)。

### 2.3 三个工具包原有的测试与探针

- `npm test -- cloud-tools-p2-stt、p2-real-lib、p2-stt-real、p3-track、p3-motion、p3-authority、p4-subject、cloud-agent-collect、cloud-agent-audio、audio-measure、maint-3-loudness-pts、cloud-agent-tools、windows-hide-silent-spawn、两个新测试`(15 个文件)→ `tests 136 / pass 131 / fail 0 / skipped 5`;跳过的 5 条是 `cloud-tools-p2-stt-real` 里要先跑探针准备依赖的 4 条和要 `P2_PIP=1` 的 1 条,它们在下面的 P2 探针里跑了。
- `node scripts/probes/cloud-tools-p2-stt-probe.mjs` → 退出码 0,`tests 27 / pass 27 / fail 0 / skipped 0`(含真 faster-whisper 转写、真撤销、真超时、**真 pip 安装**——pip 现在是 `-I` 起的)。
- `node scripts/probes/cloud-tools-p3-probe.mjs` → 退出码 0,`PROBE-RESULT pass`;关键行:`追踪 OK … 最大误差=0.67px`、`取消 OK … 进程已退出=true`、`超时 OK`、`无残留进程 OK`、`无新窗口 OK`。
- `node scripts/probes/cloud-tools-p4-subject-probe.mjs` → 退出码 0,`ALL PASS (39/39)`;关键行:`取消:进程树真被杀(Python 与它的 ffmpeg 都没了)`、`重启:close 等到子进程真关,无残留进程`、`没有新冒出来的可见命令行窗口 — 前 4 后 4`。
- 探针前后各查一次可见窗口(通用规矩里的那条 PowerShell):前后都没有新窗口;探针后也没有本工作区起的 Python / ffmpeg 残留。

改了断言的现有测试(都是把「命令行开头是 `-m 包名`」换成隔离模式的开头,没有放松):`cloud-tools-p2-stt.test.mjs` 一处(并加了一条「环境里没有 PYTHON* 变量」);`cloud-tools-p3-track.test.mjs` 两处(同样加了一条环境断言)和一句注释。

### 2.4 基线

- `npx tsc -b --force` → 退出码 0,零输出。
- `npm test`(设了那两个环境变量)→ 没有拿到零失败的一次:机器上同时有别的子 Agent 在跑全量,跑了两遍,失败的都与本分支改的文件无关,单独重跑都过。
  - 第一遍:`tests 6147 / pass 6140 / fail 3 / skipped 4`,退出码 1。失败的三条:`agent-live-selection.test.mjs`(等 actual model tool route 超时 8000 ms;在通用规矩的已知偶发名单里)、`card-lock-pipeline.test.mjs` 的 L9(计时器重判的时序断言)、`reopen-hosting.test.mjs` 的「真实中继 free」(`expiresAt` 读到 null)。后两个**不在已知偶发名单里**,请主会话留意。
  - 三个文件各自单独重跑:`agent-live-selection` 1/1 过、`card-lock-pipeline` 21/21 过、`reopen-hosting` 3/3 过。三个文件都不引用本分支改的任何文件。
  - 第二遍:`tests 6147 / pass 6142 / fail 1 / skipped 4`,退出码 1。失败的只有 `agent-live-selection.test.mjs` 同一条(同样是等 8000 ms 超时)。
  - 另:第一次我把 `npm test` 放在工具的后台里跑,被工具的 10 分钟上限掐掉了(没跑完,不算一遍);后两遍是脱离工具、隐藏窗口起的。
- windows-hide 守门(`server/test/windows-hide-silent-spawn.test.mjs`)在上面 15 个文件那一次里跑过,过。

## 3. Linux 的进程组:要主会话到节点上跑

这台 Windows 机器没有 WSL 发行版,Linux 上真的按组杀我验不了。演示脚本 `scripts/probes/cloud-tools-spawn-linux-demo.mjs` 自带一切:只用 Node 标准库和系统的 `python3`(没有就用 `sh` + `sleep`);杀法是从公共实现里直接 import 的,不是抄的。

**拷哪两个文件**到节点上同一个临时目录(不用检出仓库):

```
scripts/probes/cloud-tools-spawn-linux-demo.mjs
server/agent/service/perception/runner.mjs
```

**命令**(在那个目录里):`node cloud-tools-spawn-linux-demo.mjs`

**期望的输出**(进程号每次不同;7 行「通过」,最后一行 `全部通过 7/7`,退出码 0):

```
[demo] 平台 linux …,node v…,python /usr/bin/python3
[demo] 公共实现:/tmp/…/runner.mjs
[demo] 隔离模式的命令行开头:-I -X utf8 -u -B -c …
[demo] 通过  对照:普通起法 + child.kill() 只杀得掉子进程,孙进程留下  —— 子进程 A(进程组 X)、孙进程 B(进程组 X);杀子进程后孙进程还在(已另按进程号收掉)
[demo] 通过  killTree:直接按树杀  —— 子进程 C(进程组 C)、孙进程 D(进程组 C) → 子进程 gone、孙进程 gone
[demo] 通过  child.kill():拿到子进程的旧代码只会这样杀,杀的也是整棵树  —— 子进程 gone、孙进程 gone
[demo] 通过  superviseChild:超时  —— 子进程 gone、孙进程 gone;退出 code=null signal=SIGKILL
[demo] 通过  superviseChild:登记器撤销(登记器调的是登记进去的那个 kill)  —— 子进程 gone、孙进程 gone
[demo] 通过  superviseChild:外面给的取消信号  —— 子进程 gone、孙进程 gone
[demo] 通过  子进程自己先退、留下不握管道的孙进程:退出时按组扫一次,不留孤儿  —— 子进程 gone、孙进程 gone
[demo] 全部通过 7/7
```

要看的三点:① 对照行里子进程与孙进程的进程组号等于 node 自己的那一组(X 不等于 A),杀子进程后孙进程还在;② `killTree` 那一行里**子进程的进程组号等于它自己的进程号,孙进程的进程组号也等于子进程的进程号**(起成了组长);③ 每个用例末尾两个都是 `gone`。如果出现 `zombie`(进程已死、没人收尸,容器里 1 号进程不收尸时会这样)脚本也算过,但值得记一笔。脚本收尾会把还活着的按进程号杀掉,不留进程。

这份脚本在本机(Windows)跑过:`全部通过 5/5`(Windows 上「对照」与「子进程先退」两条不适用,跳过),并且按上面的办法只拷两个文件到临时目录也跑通。

## 4. 没做成的及原因

- **`npm test` 没有拿到零失败的一次**:见 2.4,两遍分别有 3 条、1 条与本分支无关的时序类失败,单独重跑都过。
- **Linux 上的按组杀没有真跑**:原因见第 3 节。平台分支的决定用注入的杀法单测过,但那不能替代节点上的那一次。
- **Windows 上「根进程自己先退、留下孙进程」收不回来**:Windows 没有进程组,`taskkill /T` 只在根还活着时找得到整棵树;要管住得用作业对象(Job Object),Node 标准库没有,要原生模块(新增依赖,不在这次范围)。生产节点是 Linux,不受影响;桌面版不经这条路。
- **`run-resources.mjs` 的 `childTreeWitness`(「整棵树都退了」的凭据)没有接**:那是登记器的配置项,由宿主给,归接线包;我留了 `groupAlive(pid)` 可以拿去做。现在登记器的回执里 `witnessMissing` 仍是 true。

## 5. 要主会话决定或注意的事

1. **节点上的 Python 要过一遍隔离模式**。`-I` 不看用户 site(`pip install --user` 装的包)、不看 `PYTHONPATH`。节点上主体识别、运动追踪、采集用的解释器如果依赖装在用户 site 或靠 `PYTHONPATH`,改完之后会「缺依赖」。部署前在节点上各跑一句确认(换成各自配置的解释器):`<python> -I -c "import numpy, onnxruntime"`、`<python> -I -c "import yt_dlp"`。装在解释器自己的 site-packages、虚拟环境、系统的 dist-packages 里的不受影响。另外 `-X utf8` 要 Python 3.7 以上。
2. **采集与测响度没有登记进运行资源登记器**(第 1.2 节末)。接线包接 `hosted-tools.mjs` 时,若要「对话被设为私有 / 被停止时采集的下载立刻停」,需要在那里把 `stopAll()` 接到 fence 事件上,或者给 `runCollect` 递 `resources` 与 `context`(`superviseChild` 已经支持,`hosted-collect.mjs` 里只差把这两个参数传进去)。
3. **子进程在 Linux 上是新会话的组长**(`detached: true`,`stt.mjs` 原来就是这样)。Agent 服务被 systemd 停止时按 cgroup 一起杀,没问题;如果节点上不是 systemd 管(nohup、pm2 之类)而 Agent 服务被 SIGKILL,正在跑的子进程树会留下——这点和改之前一样,只是说明一下。
4. `workspace.spawn()` 回的 `child.kill(信号)`:Linux 上把信号发给整个组,**不带参数时是 SIGKILL**(Node 原来的缺省是 SIGTERM)。受限子进程本来就是要它死,登记器的 `kill()` 也不带参数;现有调用方没有依赖 SIGTERM 的。
5. 现有测试里有两处命令行断言跟着改了(第 2.3 节末),审差异时请看一眼。

## 6. 裁定与对任务书或语义的更正建议

- 〔裁〕公共实现放在 `server/agent/service/perception/runner.mjs`(拆包表留的名字),但 `workspace.mjs`(上一级目录)和 `hosted-collect.mjs` 也 import 它。理由:派活指令要「一处公共实现」,演示脚本又要求它能单独拷走,所以做成一个只用标准库的文件;代价是目录名「感知」比它的实际用途窄。主会话觉得别扭的话,把它挪到 `server/agent/service/` 下只是改四行 import。
- 〔裁〕组长退出时按组扫一次(第 1.1 节)。派活指令没有要求,是我加的:否则「Python 自己退了但它起的 ffmpeg 没等」这种情况在 Linux 上仍会留孤儿。
- 〔裁〕`python/` 下三个包的 pip 一行(第 1.4 节)。
- 语义文档没有要改的:这两条都是三级(具体机制),`docs/semantics/mechanism/agent.md` 现在没有写到起子进程这一层。建议主会话合入时在那里补一句「云端 Agent 服务起的子进程是进程树,取消按树杀并等到 exit + close;Python 一律隔离模式起,包目录只来自部署配置」,原文由主会话定。
- 拆包表(`docs/plan/cloud-agent-tools-implementation.md`)里 `perception/runner.mjs` 那一格现在有了实物,可以把说明对上。
