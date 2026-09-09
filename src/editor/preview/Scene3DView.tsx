import { useEffect, useRef, useState } from "react";
import { flattenOverlay, type Project } from "../../kernel/project";
import { placeClip3D } from "./place3d";
import { getCard } from "../../kernel/registry";
import { actions, useStore } from "../../store/project";
import {
  addLights, applyTexture, geometryOf, materialOf, poseMesh, radiusFor, shapeOf,
  type Scene3DParams,
} from "../../cards/native/scene3dObject";
import { cameraFor, DEFAULT_FOV_DEG, stageToWorld } from "../../kernel/space3d";

/**
 * 3D 视图:把这一刻画面上的每张卡当成一块**立在空间里的板子**,可以像 Blender 那样绕着看。
 *
 * # 它和 2D 视图分工不同
 *
 * 2D 视图的契约是「预览所见 = 导出所得」——那是**成片长什么样**。
 * 这个视图回答的是另一个问题:**这些东西在空间里是怎么摆的**。所以它不追求逐像素等同,
 * 它追求的是"层和层之间的前后、倾斜、间距一眼看得出来"。相机可以随便转,这本来就不是成片的机位。
 *
 * # 板子上贴的是烘出来的真图,不是重画一遍
 *
 * 每块板子的贴图来自 `/api/vision/bake-batch`,而那条路画图的就是导出成片的那个渲染器。
 * 所以板子上的内容和成片里的**是同一批像素**,不是这里另外实现一遍卡片。
 * 另实现一遍就等于又开一条会分叉的路 —— 这个项目里那类分叉的代价写在 vite-plugin-vision.ts 开头。
 *
 * # 三维的卡在这里是**真的三维**
 *
 * `scene-3d` 那种本身就是立体物件的卡,不走"贴图平板"那条路 —— 一开始是那么做的,
 * 结果绕着转它还是一张画,而这个视图存在的理由正是"看清东西在空间里怎么摆"。
 * 现在直接用卡片同一份几何构造(`cards/native/scene3dObject.ts`)在这儿造一个真的物件,
 * 连灯光预设都是同一份。两边共用一份构造,才不会出现"检视里看到的和成片里不是一个东西"。
 *
 * # 代理色块只是过渡
 *
 * 贴图没到位之前先画一块半透明色块占位,**烘好了立刻换上**。
 * 烘焙按输入做了缓存(见 bakeOne),同一张卡同样的参数只真渲一次,之后开这个视图是零成本 ——
 * 所以正常情况下你看到的一直是真贴图,色块只在第一次、或者刚改完卡的那几秒出现。
 */

type ThreeMod = typeof import("three");
type OrbitMod = typeof import("three/examples/jsm/controls/OrbitControls.js");

let modsPromise: Promise<[ThreeMod, OrbitMod]> | null = null;
/** three 和 OrbitControls 都只在真的打开 3D 页时才下载 */
const loadMods = (): Promise<[ThreeMod, OrbitMod]> =>
  (modsPromise ??= Promise.all([
    import("three"),
    import("three/examples/jsm/controls/OrbitControls.js"),
  ]));

/** 没贴图时的占位色。半透明,一眼看得出"这块还在烘" */
const PROXY_COLOR = 0x64748b;

interface Props {
  project: Project;
  /** 时间轴当前时刻(秒) */
  t: number;
}

export function Scene3DView({ project, t }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const selected = useStore((s) => s.selection[0]);
  const [mods, setMods] = useState<[ThreeMod, OrbitMod] | null>(null);
  const [pending, setPending] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  /**
   * 贴图缓存:键是**这张卡长什么样**,不是 clipId。
   *
   * 只用 clipId 有两个错:换个项目 clipId 会重复(都是 c1 / n1 这种),新项目会看到上个项目的
   * 贴图;改了卡片参数之后 clipId 没变,贴图也不会更新,画面停在旧的样子还不报错。
   * 服务端那边本来就是按「输入」做的缓存(见 bakeOne),这边跟它对齐即可。
   */
  const textures = useRef(new Map<string, string>());
  /*
   * 贴图的键只带**决定像素**的东西:哪张卡、什么参数、画布多大。
   *
   * 位置和三维变换不在里面 —— 服务端烘的时候会把 frame 整个摘掉(见 bakeOne 的说明),
   * 所以转一下卡片、推一下深度,贴图一个像素都不会变。把整个 frame 塞进键里的后果是:
   * 在「三维」面板里拖滑杆,每一格都算缓存未命中,于是每一格发一次烘焙请求。
   */
  const texKey = (c: { id: string; cardId: string; params?: unknown; frame?: { w?: number; h?: number } }) =>
    [c.id, c.cardId, JSON.stringify(c.params ?? {}), `${c.frame?.w ?? "-"}x${c.frame?.h ?? "-"}`].join("|");
  /** 场景那一套,和 scene-3d 卡一样要显式 dispose —— WebGL 资源不归 GC 管 */
  const gl = useRef<{ dispose: () => void; render: () => void } | null>(null);
  /** 贴图到位后要能立刻换上去:clipId → 换图函数 */
  const swap = useRef(new Map<string, (url: string) => void>());
  /** 三维物件每帧要按 t 摆姿势(会转的那种)。渲染循环里调,所以要读最新的 t */
  const posers = useRef<((t: number) => void)[]>([]);
  /**
   * 用户转到哪儿了。**跨场景重建保留** —— 这是「拖时间轴相机会弹回去」的修复点。
   *
   * 建场景那个 effect 的依赖里有 `sig`,而 `sig` 是「**这一刻**有哪些卡」算出来的。
   * `t` 已经刻意排除在依赖外了,但 `sig` 会**随时间间接变化**:拖过任意一条 clip 边界,
   * 活跃的卡就换了一批,effect 整段重跑,`new PerspectiveCamera` + `new OrbitControls`
   * 把机位打回默认 —— 用户刚转好的视角,一拖进度条就没了。
   *
   * 存在 ref 里而不是 state:它每次拖动都在变,进 state 会引起重渲染,而这个值
   * 只有重建场景那一刻才被读一次。
   */
  const pose = useRef<{ pos: [number, number, number]; target: [number, number, number] } | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  // 选中变了不该重建场景(重建 = 重新加载所有贴图),所以也走 ref
  const selRef = useRef(selected);
  selRef.current = selected;
  /*
   * 摆位每帧从最新的 project 读,不进建场景那个 effect 的依赖。
   * 否则在「三维」面板里拖一下滑杆就重建一次整个场景(几何全部重建、贴图全部重新加载),
   * 而拖动是连续的 —— 一次拖动几十次重建。
   */
  const projRef = useRef(project);
  projRef.current = project;

  useEffect(() => {
    let dead = false;
    loadMods().then((m) => { if (!dead) setMods(m); }).catch((e) => setErr(String(e?.message || e)));
    return () => { dead = true; };
  }, []);

  const timeline = flattenOverlay(project);
  const active = timeline.clips.filter((c) => t >= c.start && t < c.end);
  // 这一刻有哪些卡、各自长什么样 —— 变了才重建场景(和重烘)
  const sig = active.map(texKey).join("|");

  /* ── 建场景 ───────────────────────────────────────────────────── */
  useEffect(() => {
    const el = host.current;
    if (!mods || !el) return;
    const [THREE, { OrbitControls }] = mods;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    const stage = { width: project.width, height: project.height };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    el.replaceChildren(renderer.domElement);

    const scene = new THREE.Scene();
    /*
     * 相机的**初始**位置就是成片的机位(space3d 那台),所以一打开看到的和 2D 视图一样;
     * 之后 OrbitControls 让你从这里转出去。有这个起点,"转偏了"随时能对回来。
     */
    const cam = cameraFor(stage, project.camera3dFov ?? DEFAULT_FOV_DEG);
    const camera = new THREE.PerspectiveCamera(cam.fovDeg, w / h, 1, cam.distance * 40);
    // 转过就接着用上次的机位,没转过才用成片那台的位置(见 pose 那个 ref 的说明)
    camera.position.set(...(pose.current?.pos ?? cam.position));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...(pose.current?.target ?? [0, 0, 0]));
    controls.enableDamping = true;
    // 用户一转就记下来。OrbitControls 的 change 在每次相机被它改动时触发,
    // 包括阻尼滑行的那几帧,所以松手后的最终位置一定记的是最后那一下。
    controls.addEventListener("change", () => {
      pose.current = {
        pos: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
      };
    });
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 2.2));

    /*
     * 屏幕平面(z=0)的轮廓。没有它就完全没有参照 —— 转两下就不知道哪边是"正面"了。
     * 画成线框而不是实面:实面会挡住 z 为负的卡。
     */
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(stage.width, stage.height)),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.5 }),
    );
    scene.add(edge);

    const disposables: { dispose: () => void }[] = [edge.geometry, edge.material as any];
    swap.current = new Map();

    posers.current = [];
    // 拾取用:每块 mesh 记住它属于哪个 clip(three 的 userData 就是干这个的)
    const pickables: any[] = [];
    // 摆位每帧重算,所以要留着这几个 group 的引用
    const placed: { clipId: string; pivot: any; inner: any; spin: any; tilt: any; mesh: any }[] = [];

    for (const clip of active) {
      // 正负号全在 place3d.ts 里,那边有单测钉着(见它的说明)
      const pl = placeClip3D(clip.frame, stage);

      // 摆位那一串 group 是共用的:平板和真三维物件都挂在它里面
      const pivot = new THREE.Group();
      pivot.position.set(...pl.pivot);
      // 从里到外:roll → scale → spin → tilt → 平移,和 frameCss 的顺序一致
      const inner = new THREE.Group();
      inner.rotation.z = pl.rollZ;
      inner.scale.setScalar(pl.scale);
      const spin = new THREE.Group();
      spin.add(inner);
      spin.rotation.y = pl.spinY;
      const tilt = new THREE.Group();
      tilt.add(spin);
      tilt.rotation.x = pl.tiltX;
      tilt.position.z = pl.translateZ;
      pivot.add(tilt);
      scene.add(pivot);
      placed.push({ clipId: clip.id, pivot, inner, spin, tilt, mesh: null });

      const def = getCard(clip.cardId);

      /*
       * 三维的卡在这里就是**真的三维**,不糊贴图。
       * 用的是卡片同一份构造(scene3dObject.ts):同样的几何、材质、灯光预设、姿势公式。
       * 灯挂在这个物件自己的 group 上,所以同屏几个三维卡各带各的灯,各自和成片对得上。
       */
      if (clip.cardId === "scene-3d" && def) {
        const params = { ...def.defaults, ...clip.params } as Scene3DParams;
        const geo = geometryOf(THREE, shapeOf(params.shape), radiusFor(params, pl.size.height));
        const mat = materialOf(THREE, params);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pl.meshOffset);
        inner.add(mesh);
        mesh.userData.clipId = clip.id;
        pickables.push(mesh);
        disposables.push(geo, mat);

        // 灯的距离尺度照抄卡片:它用的是自己画布那台相机的距离
        const camD = cameraFor({ width: pl.size.width, height: pl.size.height }, params.fov > 0 ? params.fov : (project.camera3dFov ?? DEFAULT_FOV_DEG)).distance;
        addLights(THREE, inner, params.light, camD);

        if (params.texture) {
          const tex = applyTexture(THREE, mat, params.texture, () => renderer.render(scene, camera));
          if (tex) disposables.push(tex);
        }

        // 会转的物件要跟着时间轴走 —— 姿势是「相对这张卡起点」的秒数的纯函数
        const start = clip.start;
        posers.current.push((now: number) => poseMesh(mesh, params, Math.max(0, now - start)));
        poseMesh(mesh, params, Math.max(0, t - start));
        continue;
      }

      /* 二维的卡:一块贴着「烘出来的真图」的板子 */
      const geo = new THREE.PlaneGeometry(pl.size.width, pl.size.height);
      const mat = new THREE.MeshBasicMaterial({
        color: PROXY_COLOR,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pl.meshOffset);
      inner.add(mesh);
      mesh.userData.clipId = clip.id;
      pickables.push(mesh);
      disposables.push(geo, mat);

      // 已经烘好的直接贴上;没有的先留色块,等 bake 回来再换
      const known = textures.current.get(texKey(clip));
      const apply = (url: string) => {
        const tex = applyTexture(THREE, mat, url, () => {
          mat.color.set(0xffffff);
          mat.opacity = 1;
          renderer.render(scene, camera);
        });
        if (tex) disposables.push(tex);
      };
      if (known) apply(known);
      else swap.current.set(clip.id, apply);
    }

    /*
     * 点选。用射线打中的第一块 mesh,把它的 clip 设成选中 —— 选中之后左边的编辑面板
     * 就是这张卡,可以直接拧「三维」那三个旋钮,所以这一页从"能看"变成"能摆"。
     *
     * 要和 OrbitControls 共存:转视角也是按下+拖动。所以按下时记位置,
     * 松开时只有几乎没动过(< 4px)才当成点击 —— 否则转个视角就把选中改掉了。
     */
    const raycaster = new THREE.Raycaster();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      // 点空白处不清选中:清了的话在 3D 页随手一点就丢了左边正在编辑的那张卡
      const id = hit?.object?.userData?.clipId;
      if (id) actions.select([id]);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    /* 选中的那块描一圈边:不改它自己的材质,另加一个线框子物体,取消选中直接删掉 */
    const marks = new Map<string, any>();
    for (const m of pickables) {
      const box = new THREE.BoxHelper(m, 0x22d3ee);
      box.visible = false;
      scene.add(box);
      marks.set(m.userData.clipId, box);
      disposables.push(box.geometry, box.material as any);
    }

    let raf = 0;
    const tick = () => {
      controls.update();
      // 会转的三维物件跟着时间轴走:姿势是 t 的纯函数,所以每帧照着当前 t 摆一次就行
      /*
       * 每帧按最新的 project 重摆一次。开销就是几个矩阵,但换来的是:
       * 在「三维」面板里拖滑杆时场景**不重建** —— 不重建就不会重新造几何、
       * 不会重新加载贴图,拖起来是连续的。
       */
      for (const q of placed) {
        const c = projRef.current.tracks.flatMap((tr: any) => tr.clips).find((x: any) => x.id === q.clipId);
        if (!c) continue;
        const pl2 = placeClip3D(c.frame, { width: projRef.current.width, height: projRef.current.height });
        q.pivot.position.set(...pl2.pivot);
        q.inner.rotation.z = pl2.rollZ;
        q.inner.scale.setScalar(pl2.scale);
        q.spin.rotation.y = pl2.spinY;
        q.tilt.rotation.x = pl2.tiltX;
        q.tilt.position.z = pl2.translateZ;
      }
      for (const pose of posers.current) pose(tRef.current);
      for (const [id, box] of marks) { box.visible = id === selRef.current; if (box.visible) box.update(); }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    // 这个视图是给人转着看的,不进导出,所以用真的 rAF 没有确定性问题
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      const nw = Math.max(1, el.clientWidth);
      const nh = Math.max(1, el.clientHeight);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh, false);
    });
    ro.observe(el);

    gl.current = {
      render: () => renderer.render(scene, camera),
      dispose: () => {
        cancelAnimationFrame(raf);
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        ro.disconnect();
        controls.dispose();
        for (const d of disposables) d.dispose?.();
        renderer.dispose();
        // dispose() 不释放 WebGL 上下文,浏览器上限约 16,超了静默丢最老的(和 scene-3d 同一个坑)
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
    return () => { gl.current?.dispose(); gl.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // t 故意不在依赖里:姿势由渲染循环按 tRef 每帧更新,进依赖会让整个场景每帧重建
  }, [mods, sig, project.width, project.height, project.camera3dFov]);

  /* ── 缺哪张烘哪张,回来就换上 ─────────────────────────────────── */
  useEffect(() => {
    /*
     * 只给**二维的卡**要贴图。scene-3d 那种在这个视图里是真几何,不需要贴图 ——
     * 一开始没排除它,结果每开一次都白烘一张(单张 4.7~6.5 秒),而且烘出来根本没人用。
     */
    const need = active.filter((c) => c.cardId !== "scene-3d" && !textures.current.has(texKey(c)));
    if (!need.length) return;
    let dead = false;
    setPending(need.length);
    (async () => {
      try {
        const res = await fetch("/api/vision/bake-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project,
            // 取每段的中点:起止两端常卡在进出场动画上,烘出来是个半透明中间态
            clips: need.map((c) => ({ clipId: c.id, t: (c.start + c.end) / 2 })),
            size: 1024,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (dead) return;
        if (!res.ok || !data.ok) throw new Error(data.error || `烘焙失败(HTTP ${res.status})`);
        for (const b of data.baked ?? []) {
          const c = need.find((x) => x.id === b.clipId);
          if (c) textures.current.set(texKey(c), b.url);
          swap.current.get(b.clipId)?.(b.url);
        }
        if (data.failed?.length) setErr(`${data.failed.length} 张没烘出来:${data.failed[0].error}`);
      } catch (e: any) {
        if (!dead) setErr(String(e?.message || e));
      } finally {
        if (!dead) setPending(0);
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 200 }}>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      {(pending > 0 || err) && (
        <div
          style={{
            position: "absolute", left: 10, bottom: 10, padding: "4px 10px", borderRadius: 6,
            font: "12px/1.6 system-ui, sans-serif", pointerEvents: "none",
            background: "color-mix(in srgb, var(--ui-panel) 88%, transparent)",
            color: err ? "var(--ui-danger, #f87171)" : "var(--ui-text-2, #94a3b8)",
          }}
        >
          {err ?? `正在烘 ${pending} 张卡的贴图…色块是占位,烘好会自动换上`}
        </div>
      )}
      {!mods && !err && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--ui-text-2, #94a3b8)", font: "13px system-ui" }}>
          正在加载三维视图…
        </div>
      )}
    </div>
  );
}
