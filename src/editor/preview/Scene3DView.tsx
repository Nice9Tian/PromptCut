import { useEffect, useRef, useState } from "react";
import { flattenOverlay, type Project } from "../../kernel/project";
import { placeClip3D } from "./place3d";
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
  const [mods, setMods] = useState<[ThreeMod, OrbitMod] | null>(null);
  const [pending, setPending] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  /** clipId → 贴图 URL。烘好一张记一张,换视图 / 换时刻都不用重烘 */
  const textures = useRef(new Map<string, string>());
  /** 场景那一套,和 scene-3d 卡一样要显式 dispose —— WebGL 资源不归 GC 管 */
  const gl = useRef<{ dispose: () => void; render: () => void } | null>(null);
  /** 贴图到位后要能立刻换上去:clipId → 换图函数 */
  const swap = useRef(new Map<string, (url: string) => void>());

  useEffect(() => {
    let dead = false;
    loadMods().then((m) => { if (!dead) setMods(m); }).catch((e) => setErr(String(e?.message || e)));
    return () => { dead = true; };
  }, []);

  const timeline = flattenOverlay(project);
  const active = timeline.clips.filter((c) => t >= c.start && t < c.end);
  // 这一刻有哪些卡、各自长什么样 —— 变了才重建场景(和重烘)
  const sig = active.map((c) => `${c.id}:${c.cardId}:${JSON.stringify(c.frame ?? null)}`).join("|");

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
    camera.position.set(...cam.position);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
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

    for (const clip of active) {
      // 正负号全在 place3d.ts 里,那边有单测钉着(见它的说明)
      const pl = placeClip3D(clip.frame, stage);

      const geo = new THREE.PlaneGeometry(pl.size.width, pl.size.height);
      const mat = new THREE.MeshBasicMaterial({
        color: PROXY_COLOR,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      disposables.push(geo, mat);

      const pivot = new THREE.Group();
      pivot.position.set(...pl.pivot);
      mesh.position.set(...pl.meshOffset);

      // 从里到外:roll → scale → spin → tilt → 平移,和 frameCss 的顺序一致
      const inner = new THREE.Group();
      inner.add(mesh);
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
      // 已经烘好的直接贴上;没有的先留色块,等 bake 回来再换
      const known = textures.current.get(clip.id);
      const apply = (url: string) => {
        new THREE.TextureLoader().load(url, (tex: any) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          mat.map = tex;
          mat.color.set(0xffffff);
          mat.opacity = 1;
          mat.needsUpdate = true;
          disposables.push(tex);
          renderer.render(scene, camera);
        });
      };
      if (known) apply(known);
      else swap.current.set(clip.id, apply);
    }

    let raf = 0;
    const tick = () => {
      controls.update();
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
  }, [mods, sig, project.width, project.height, project.camera3dFov]);

  /* ── 缺哪张烘哪张,回来就换上 ─────────────────────────────────── */
  useEffect(() => {
    const need = active.filter((c) => !textures.current.has(c.id));
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
          textures.current.set(b.clipId, b.url);
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
