import { useRef } from "react";
import { actions, useStore } from "../store/project";
import { themes } from "../themes";
import { exportProjectJson, exportVideo, importProjectFile, importVideoFiles } from "./io";
import { useSkin, skins } from "../skins/useSkin";
import { skinGroups } from "../skins/skins";

function Btn({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button title={title} onClick={onClick} className="px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs">
      {children}
    </button>
  );
}

export function TopBar() {
  const name = useStore((s) => s.project.name);
  const themeId = useStore((s) => s.project.themeId);
  const playing = useStore((s) => s.playing);
  const t = useStore((s) => s.t);
  const dirty = useStore((s) => s.dirty);
  const videoInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);

  const { skinId, setSkin } = useSkin();

  const run = (fn: () => Promise<unknown>) => () => fn().catch((e) => alert(String(e?.message ?? e)));

  return (
    <div className="flex items-center gap-2 px-3 h-11 bg-neutral-950 text-sm pc-topbar">
      <span 
        className="font-bold tracking-wide" 
        style={{
          backgroundImage: "linear-gradient(100deg, var(--ui-accent) 0%, var(--ui-fg) 100%)",
          backgroundClip: "text",
          WebkitBackgroundClip: "text",
          color: "transparent"
        }}
      >
        PromptCut
      </span>
      <span className="text-neutral-400">{name}{dirty ? " *" : ""}</span>
      <span className="mx-2 text-neutral-700">|</span>
      <Btn onClick={() => actions.togglePlay()}>{playing ? "暂停" : "播放"}</Btn>
      <Btn onClick={() => actions.replay()} title="重播当前卡片">重播</Btn>
      <span className="tabular-nums text-neutral-300 w-20">{t.toFixed(2)} s</span>
      <Btn onClick={() => actions.undo()}>撤销</Btn>
      <Btn onClick={() => actions.redo()}>重做</Btn>
      <span className="mx-2 text-neutral-700">|</span>
      <label className="text-neutral-400 text-xs">主题</label>
      <select value={themeId} onChange={(e) => actions.setProjectMeta({ themeId: e.target.value })} className="bg-neutral-800 rounded px-2 py-1 text-xs outline-none">
        {themes.map((th) => (
          <option key={th.id} value={th.id}>{th.name}</option>
        ))}
      </select>
      <label className="text-neutral-400 text-xs ml-2">皮肤</label>
      <select value={skinId} onChange={(e) => setSkin(e.target.value)} className="bg-neutral-800 rounded px-2 py-1 text-xs outline-none">
        {skinGroups().map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((sk) => (
              <option key={sk.id} value={sk.id}>{sk.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="ml-auto" />
      <Btn onClick={() => videoInput.current?.click()}>导入视频</Btn>
      <Btn onClick={() => projectInput.current?.click()}>打开项目</Btn>
      <Btn
        onClick={() => {
          try {
            const json = exportProjectJson();
            const blob = new Blob([json], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${name}.promptcut.json`;
            a.click();
          } catch (e) {
            alert(String((e as Error).message));
          }
        }}
      >
        保存项目
      </Btn>
      <Btn onClick={run(() => exportVideo({ onProgress: (d, n) => console.log(`export ${d}/${n}`) }).then((r) => alert(`导出完成:${r.outDir}`)))}>导出视频</Btn>
      <input ref={videoInput} type="file" accept="video/*" multiple hidden onChange={(e) => e.target.files && run(() => importVideoFiles(e.target.files!))()} />
      <input ref={projectInput} type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && run(() => importProjectFile(e.target.files![0]))()} />
    </div>
  );
}
