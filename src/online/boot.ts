/**
 * 在线浏览器模式的启动钩子（C10a 契约第 2、4 节）。`main.tsx` 第二个就引它（紧跟渲染时钟）：ES 模块按引入顺序求值，
 * 这样守卫在别的模块的顶层代码跑之前就装好（有的模块一载入就去取 `/api/*`）。
 *
 * - `ONLINE` 时装 `/api` 守卫（在线的开发构建与生产构建都装，不另设开关；桌面运行环境不装）；
 * - 读邀请链接的 `#invite=`，放进内存后马上把 `#` 片段清掉（`invite.ts`）。
 */
import { ONLINE } from "./mode";
import { bootApiGuard } from "./apiGuard";
import { captureInviteFromLocation } from "./invite";
import { markOnlinePage } from "./pageFlag";
import { loadStageConfig } from "./stageOrigins";
import { bootStageGuard } from "./isolation/stageGuard";
import { initTier } from "./onlineTier";
import { currentDeviceKind } from "./deviceKind";

// 跨源舞台(在线构建的 `stage.html`):加固与自检排在别的模块求值之前、任何卡片代码之前(契约 `online-card-exec-contract.md` 第 3 节)。
// 桌面运行环境、编辑器页、同源单舞台不做事
bootStageGuard({ online: ONLINE, base: import.meta.env.BASE_URL });
// 运行期标记先设:会被 Node 单测载入、不能静态引 mode.ts 的模块读它停掉 /api 调用(pageFlag.ts)
if (ONLINE) markOnlinePage();
bootApiGuard(ONLINE, { base: import.meta.env.BASE_URL });
captureInviteFromLocation();
const editorPage = ONLINE && typeof location !== "undefined" && !new URLSearchParams(location.search).has("stage");
if (editorPage) void loadStageConfig({ base: import.meta.env.BASE_URL });
// 在线浏览器这一次的档位(`onlineTier.ts`):舞台闸门接上之前按两个舞台各一套渲染器(原来的在线页面就是这样)
if (editorPage) initTier({ online: true, target: 3, reached: 3, gate: "done", lowest: null, identity: currentDeviceKind().kind });
