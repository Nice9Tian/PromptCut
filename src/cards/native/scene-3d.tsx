import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { cameraFor, DEFAULT_FOV_DEG } from "../../kernel/space3d";

/**
 * 三维场景(B 层):three.js 画在自己的 canvas 上的一个立体物件,透明底,能和别的卡叠。
 *
 * # 确定性是这张卡唯一的难点
 *
 * 这个项目逐帧导出,同一个时间轴导两遍必须逐字节相同(见 scripts/export-frames.mjs)。
 * three.js 的常规用法是 `renderer.setAnimationLoop(...)` —— 自己跑 rAF、按 delta 累积。
 * **那条路在这里是错的**,而且错得不报警:
 *   - delta 累积意味着"第 30 帧长什么样"取决于前面每一帧各推了多久,机器一忙就漂;
 *   - 往回拖播放头没有"倒带",累积出来的状态回不去。
 *
 * 所以这张卡一次 rAF 都不注册。**画面是 t 的纯函数**:
 *
 *     rotation.y = t · spinY · 2π
 *
 * 给同一个 t 就得到同一帧,顺着播、往回拖、跳着截,结果都一样。
 * 这比"把 three 的 rAF 接进虚拟时钟"更省事也更硬 —— 根本没有第二个时钟要对齐。
 * (粒子卡 particles.tsx 走的是另一条路:它有物理累积,只能一步步推。三维没有物理,不用受那个罪。)
 *
 * # 相机和 A 层是同一台
 *
 * 相机参数从 kernel/space3d.ts 取,和舞台 CSS 的 `perspective` 同一个公式、同一个单位。
 * 所以卡片(A 层,DOM)和这张卡(B 层,canvas)里的"一个像素"一样大、透视一样强,
 * 叠起来不用做任何标定 —— 这正是那份设计文档里"A 和 B 白拿同一个相机"的意思。
 *
 * fov **默认跟着项目走**(`params.fov = 0`,从 CardProps.stage.camera3dFov 取)。
 * 一开始的写法是让这张卡自带一个 fov、靠人记得填成和 `set_camera3d` 一样的数 ——
 * 那是必然会对不上的设计:项目一改 fov,这张卡就悄悄不在同一个空间里了,
 * 而画面只是"看着有点怪",不报错也没处查。想让它单独用一个视角才填正数。
 *
 * # WebGL 在导出里要一个开关
 *
 * 导出那套 Chrome 参数为了确定性关掉了 GPU,连带把 WebGL 关死(getContext 返回 null、不报错)。
 * scripts/export-frames.mjs 里加了 `--enable-unsafe-swiftshader` 把软件 WebGL 打开。
 * 那个标志要是被谁删了,这张卡在导出里会变成一张空画布,而且**预览里还是好的** —— 只会在成片里发现。
 */

type ThreeMod = typeof import("three");

/**
 * three 只在真的用到这张卡时才下载(核心 ~150KB gzip)。
 * 主包已经 2MB,不能为了一张不常用的卡让所有人都付这笔钱。
 *
 * 导出时这个动态 import 不会造成时序问题:导出用的虚拟时间策略是
 * `pauseIfNetworkFetchesPending`,有请求挂着虚拟时间就不走,chunk 一定先加载完。
 */
let threeMod: Promise<ThreeMod> | null = null;
const loadThree = (): Promise<ThreeMod> => (threeMod ??= import("three"));

const SHAPES = ["cube", "sphere", "torus", "knot", "cone", "cylinder", "crystal"] as const;
type Shape = (typeof SHAPES)[number];

interface Params {
  shape: string;
  color: string;
  metal: number;
  rough: number;
  size: number;
  spinY: number;
  spinX: number;
  tilt: number;
  light: string;
  fov: number;
  wire: string;
}

/** 每种形状的几何体。`r` 是"半径",按画布高度算出来的世界单位(1 世界单位 = 1 像素) */
function geometryOf(THREE: ThreeMod, shape: Shape, r: number) {
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(r, 64, 48);
    case "torus":
      return new THREE.TorusGeometry(r * 0.72, r * 0.28, 32, 96);
    case "knot":
      return new THREE.TorusKnotGeometry(r * 0.68, r * 0.22, 160, 32);
    case "cone":
      return new THREE.ConeGeometry(r, r * 1.8, 64);
    case "cylinder":
      return new THREE.CylinderGeometry(r * 0.72, r * 0.72, r * 1.6, 64);
    case "crystal":
      return new THREE.IcosahedronGeometry(r, 0);
    case "cube":
    default:
      return new THREE.BoxGeometry(r * 1.5, r * 1.5, r * 1.5);
  }
}

/**
 * 灯光预设。三档都是"环境光 + 主光 + 补光"的老套路,区别只在强弱和方向 ——
 * 让 Agent 挑一个词,比让它填三个光源的位置靠谱得多。
 */
function addLights(THREE: ThreeMod, scene: any, preset: string, d: number) {
  const key = new THREE.DirectionalLight(0xffffff, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  let ambient = 0.5;
  if (preset === "rim") {
    // 逆光:主光从后上方压过来,只留一条亮边,适合剪影感
    ambient = 0.18;
    key.position.set(-0.4, 0.9, -1).multiplyScalar(d);
    key.intensity = 3.2;
    fill.position.set(0.6, -0.2, 0.8).multiplyScalar(d);
    fill.intensity = 0.35;
  } else if (preset === "soft") {
    // 柔光:大环境光 + 弱方向光,几乎没有硬阴影
    ambient = 1.1;
    key.position.set(0.5, 0.8, 1).multiplyScalar(d);
    key.intensity = 0.9;
    fill.position.set(-0.7, 0.1, 0.5).multiplyScalar(d);
    fill.intensity = 0.5;
  } else {
    // studio:标准三点光的前两点,金属质感最出彩
    ambient = 0.45;
    key.position.set(0.7, 1, 0.8).multiplyScalar(d);
    key.intensity = 2.4;
    fill.position.set(-0.9, -0.2, 0.6).multiplyScalar(d);
    fill.intensity = 0.8;
  }
  scene.add(new THREE.AmbientLight(0xffffff, ambient), key, fill);
}

const TAU = Math.PI * 2;

function Scene3DCard({ params, t = 0, stage }: CardProps<Params>) {
  const host = useRef<HTMLDivElement>(null);
  /*
   * fov:0(默认)= 跟着项目的相机走,填了正数 = 这张卡自己单独用一个视角。
   *
   * 默认跟随是有意的。让这张卡自带一个 fov、再靠人记得填成和 set_camera3d 一样的数,
   * 是**必然会对不上**的设计 —— 项目一改 fov,这张卡就悄悄不在同一个空间里了,
   * 而画面只是"看着有点怪",不会报错。
   * 项目没开三维时退回默认 40°,这时卡片自成一个空间,反正也没有 A 层的透视要对齐。
   */
  const fov = params.fov > 0 ? params.fov : (stage?.camera3dFov ?? DEFAULT_FOV_DEG);
  // 依赖只用基本类型:stage 是每帧新建的对象,拿它当依赖会让场景每帧重建
  const stageW = stage?.width;
  const stageH = stage?.height;
  const [THREE, setTHREE] = useState<ThreeMod | null>(null);
  // 建场景时要知道当前的 t 才能把首帧画对(layout effect 不该把 t 放进依赖,
  // 否则每一帧都重建整个场景)。用 ref 读最新值。
  const tRef = useRef(t);
  tRef.current = t;
  /** 场景那一套。重建时整个换掉,旧的显式 dispose —— WebGL 资源不归 GC 管 */
  const gl = useRef<{ renderer: any; scene: any; camera: any; mesh: any; dispose: () => void } | null>(null);

  useEffect(() => {
    let dead = false;
    loadThree().then((m) => { if (!dead) setTHREE(m); }).catch((e) => console.warn("[scene-3d] three 加载失败:", e));
    return () => { dead = true; };
  }, []);

  /*
   * 建场景用 useLayoutEffect 而不是 useEffect:要在浏览器绘制之前读到容器尺寸并画完第一帧,
   * 否则导出时有概率截到"还没画"的那一格 —— 而那一帧不会报错,只是黑的。
   * 读尺寸用 clientWidth/clientHeight 而不是 getBoundingClientRect():
   * 这张卡可能正被 A 层的三维变换斜着摆,后者返回的是**投影后**的外接框,不是画布该有的大小。
   */
  useLayoutEffect(() => {
    const el = host.current;
    if (!THREE || !el) return;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);

    const cam = cameraFor({ width: w, height: h }, fov);
    const camera = new THREE.PerspectiveCamera(cam.fovDeg, cam.aspect, cam.near, cam.far);
    camera.position.set(...cam.position);
    camera.lookAt(0, 0, 0);

    const scene = new THREE.Scene();
    addLights(THREE, scene, params.light, cam.distance);

    const shape = (SHAPES as readonly string[]).includes(params.shape) ? (params.shape as Shape) : "cube";
    const r = (Math.min(Math.max(params.size, 0.05), 1) * h) / 2;
    const geometry = geometryOf(THREE, shape, r);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(params.color),
      metalness: Math.min(Math.max(params.metal, 0), 1),
      roughness: Math.min(Math.max(params.rough, 0), 1),
      wireframe: params.wire === "yes",
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    /*
     * `preserveDrawingBuffer: true` 不是可有可无的:没有它,画完之后画布的像素随时可能被清掉,
     * `drawImage(canvas)` 读回来是空的。而编辑器有两处要读这张画布的像素 ——
     * `contentBox.ts` 量「这张卡真正画了东西的那一块」(不读就退回整块画布,
     * Agent 会以为它盖住全屏),以及实体模式取墨色。代价是每帧多留一份缓冲。
     */
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    // 透明底:这张卡要能叠在别的卡上面,不能自带黑背景
    renderer.setClearColor(0x000000, 0);
    // 固定 1:导出用 --force-device-scale-factor=1,预览也按舞台像素算,跟着 devicePixelRatio 走
    // 会让同一个项目在不同屏幕上导出成不同分辨率
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.domElement.style.display = "block";
    el.replaceChildren(renderer.domElement);

    gl.current = {
      renderer, scene, camera, mesh,
      dispose: () => {
        geometry.dispose();
        material.dispose();
        renderer.dispose();
        /*
         * `dispose()` **不释放 WebGL 上下文**,只清 three 自己的缓存。而浏览器对同时存在的
         * 上下文有硬上限(约 16),超了就静默丢弃最老的那个 —— 画面变空白,不报错。
         * 这张卡每次重播都重新挂载(key 带 playToken),一条时间轴上跑几十次是常事。
         *
         * 实测:连续建 40 个渲染器,只调 dispose() 有 24 个被浏览器**强行**收走;
         * 加上 forceContextLoss() 则是 40 个都由我们主动释放,一个都不靠浏览器回收。
         */
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };

    /*
     * 第一帧就在这里画掉,不留给下面那个被动 effect。
     * useEffect 是**绘制之后**才跑的,只靠它的话挂载后的第一次绘制是一张空 canvas ——
     * 预览里会闪一格白。既然已经在 layout effect 里(绘制之前),顺手画完再走。
     */
    pose(mesh, params, tRef.current);
    renderer.render(scene, camera);

    /*
     * 卡片的框改了(set_rect / nudge / set_position)不会重挂载 —— playToken 只在
     * loadProject / switchCut / seek / play 时递增。而 `setSize(w,h,false)` 不写 canvas 的
     * CSS 宽高,所以画布会一直是旧的像素尺寸、相机 aspect 也是旧的,要等下一次拖播放头才自愈。
     * 导出和 see_preview 都是重新起页面渲染,不受影响;错的只有人眼看的实时预览。
     */
    const ro = new ResizeObserver(() => {
      const nw = Math.max(1, el.clientWidth);
      const nh = Math.max(1, el.clientHeight);
      if (nw === renderer.domElement.width && nh === renderer.domElement.height) return;
      const c = cameraFor({ width: nw, height: nh }, fov);
      camera.fov = c.fovDeg;
      camera.aspect = c.aspect;
      camera.near = c.near;
      camera.far = c.far;
      camera.position.set(...c.position);
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh, false);
      renderer.render(scene, camera);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      gl.current?.dispose();
      gl.current = null;
    };
  }, [THREE, params.shape, params.color, params.metal, params.rough, params.size, params.light, params.wire, fov, stageW, stageH]);

  /*
   * 每次 t 变了就摆好姿势、画一帧。**没有 rAF、没有 delta** —— 姿势只由 t 决定。
   * (首帧不靠它,见上面 layout effect 的结尾。)
   */
  useEffect(() => {
    const g = gl.current;
    if (!g) return;
    pose(g.mesh, params, t);
    g.renderer.render(g.scene, g.camera);
  });

  return <div ref={host} className="absolute inset-0" />;
}

/** 姿势只由 t 和几个参数决定 —— 这是「画面是 t 的纯函数」的全部实现 */
function pose(mesh: any, params: Params, t: number) {
  mesh.rotation.set((params.tilt * Math.PI) / 180 + t * params.spinX * TAU, t * params.spinY * TAU, 0);
}

export const scene3dCard: CardDef<Params> = {
  id: "scene-3d",
  name: "三维物件",
  description: "一个会转的立体物件(方块 / 球 / 圆环 / 纽结 / 锥 / 柱 / 晶体),透明底,可以叠在别的卡上",
  useWhen:
    "需要一个真正立体的东西当视觉锚点时用:片头的旋转标志物、讲抽象概念时的一个几何体、产品段落的陪衬。" +
    "它是**装饰**不是信息 —— 数字用 odometer、要点用清单卡,别指望这张卡说清楚什么。" +
    "透明底,通常叠在背景之上、文字之下(放到靠下的序列里)。" +
    "转速用圈/秒,0 就是不转、停在 tilt 那个角度;负数反着转。" +
    "**它和用 set_camera3d 打开的三维默认就是同一台相机**(fov 留 0 即可),所以它和摆进空间的卡片透视强度一致、叠起来不用调。只有想让它单独用一个视角时才填 fov。",
  tags: ["三维", "3D", "立体", "模型", "旋转", "几何", "canvas", "webgl"],
  source: "native",
  defaults: {
    shape: "knot", color: "#8ab4ff", metal: 0.6, rough: 0.25, size: 0.55,
    spinY: 0.15, spinX: 0, tilt: -18, light: "studio", fov: 0, wire: "no",
  },
  controls: [
    { key: "shape", label: "形状", type: "select", options: [
      { value: "knot", label: "纽结" }, { value: "cube", label: "方块" }, { value: "sphere", label: "球" },
      { value: "torus", label: "圆环" }, { value: "cone", label: "锥" }, { value: "cylinder", label: "柱" },
      { value: "crystal", label: "晶体" },
    ] },
    { key: "color", label: "颜色", type: "color" },
    { key: "metal", label: "金属感", type: "number", min: 0, max: 1, step: 0.05, hint: "0 = 塑料/陶瓷,1 = 金属。金属感高时颜色主要来自反光,配 studio 打光最好看" },
    { key: "rough", label: "粗糙度", type: "number", min: 0, max: 1, step: 0.05, hint: "0 = 镜面,1 = 全哑光" },
    { key: "size", label: "大小", type: "number", min: 0.05, max: 1, step: 0.05, hint: "占画布高度的比例。0.55 大约是半屏高" },
    { key: "spinY", label: "水平转速", type: "number", min: -3, max: 3, step: 0.05, hint: "圈/秒,绕竖轴。0.15 是从容的慢转;负数反向" },
    { key: "spinX", label: "翻滚转速", type: "number", min: -3, max: 3, step: 0.05, hint: "圈/秒,绕横轴。两个都给就是斜着滚" },
    { key: "tilt", label: "初始倾斜", type: "number", min: -90, max: 90, step: 1, hint: "度,绕横轴。转速为 0 时就靠它决定停在什么角度" },
    { key: "light", label: "打光", type: "select", options: [
      { value: "studio", label: "棚拍(立体感强)" }, { value: "soft", label: "柔光(平)" }, { value: "rim", label: "逆光(剪影)" },
    ] },
    { key: "fov", label: "视角(度)", type: "number", min: 0, max: 120, step: 1, hint: "0 = 跟着项目的相机走(默认,推荐);填正数 = 这张卡单独用一个视角,和别的卡就不在同一个空间里了" },
    { key: "wire", label: "线框", type: "select", options: [{ value: "no", label: "实体" }, { value: "yes", label: "线框" }] },
  ],
  parts: [{ id: "object", label: "物件", role: "media", params: ["shape", "color", "metal", "rough", "size", "spinY", "spinX", "tilt", "light", "fov", "wire"] }],
  // 没有进场动画:它一挂载就是最终形态,之后一直转
  lifecycle: { after: "evolve", exit: ["fade"] },
  Component: Scene3DCard,
};
