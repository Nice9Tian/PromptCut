import { useRef } from "react";
import { actions, useStore } from "../store/project";
import { themes } from "../themes";
import { exportProjectJson, exportVideo, importProjectFile, importVideoFiles } from "./io";
import { useSkin } from "../skins/useSkin";
import { skinGroups } from "../skins/skins";
import { Logo } from "../ui/Logo";
import {
  IconClock,
  IconExport,
  IconImport,
  IconOpen,
  IconPause,
  IconPlay,
  IconRedo,
  IconReplay,
  IconSave,
  IconUndo,
} from "../ui/icons";
import "../ui/toolbar.css";

/**
 * 顶栏:按设计稿「工具栏组件表」分成三组——
 * A 播放控制条(播放/重播/时长/撤销/重做)、B 主题与皮肤、C 文件操作条(导入/打开/保存/导出)。
 * 导出是这条里唯一的主按钮,放最右。
 */
function Btn({
  onClick,
  children,
  title,
  icon,
  primary,
}: {
  onClick: () => void;
  children?: React.ReactNode;
  title?: string;
  icon?: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`pc-btn${primary ? " pc-btn--primary" : ""}${children ? "" : " pc-btn--icon"}`}
    >
      {icon}
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

  const saveProject = () => {
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
  };

  return (
    <div className="pc-bar">
      <Logo size={22} />
      <span className="pc-projname">
        {name}
        {dirty && <span className="pc-dirty"> *</span>}
      </span>
      <span className="pc-bar-sep" />

      {/* A · 播放控制条 */}
      <div className="pc-bar-group">
        <Btn
          onClick={() => actions.togglePlay()}
          title={playing ? "暂停" : "播放"}
          icon={playing ? <IconPause /> : <IconPlay />}
        >
          {playing ? "暂停" : "播放"}
        </Btn>
        <Btn onClick={() => actions.replay()} title="重播当前卡片" icon={<IconReplay />}>
          重播
        </Btn>
        <span className="pc-num">
          <IconClock size={14} />
          {t.toFixed(2)} s
        </span>
        <Btn onClick={() => actions.undo()} title="撤销" icon={<IconUndo />} />
        <Btn onClick={() => actions.redo()} title="重做" icon={<IconRedo />} />
      </div>
      <span className="pc-bar-sep" />

      {/* 主题与皮肤 */}
      <div className="pc-bar-group">
        <label className="pc-bar-label">主题</label>
        <select
          value={themeId}
          onChange={(e) => actions.setProjectMeta({ themeId: e.target.value })}
          className="pc-select"
        >
          {themes.map((th) => (
            <option key={th.id} value={th.id}>
              {th.name}
            </option>
          ))}
        </select>
        <label className="pc-bar-label">皮肤</label>
        <select value={skinId} onChange={(e) => setSkin(e.target.value)} className="pc-select">
          {skinGroups().map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((sk) => (
                <option key={sk.id} value={sk.id}>
                  {sk.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <span className="ml-auto" />

      {/* C · 文件操作条,导出是唯一的主按钮 */}
      <div className="pc-bar-group">
        <Btn onClick={() => videoInput.current?.click()} title="导入视频" icon={<IconImport />}>
          导入视频
        </Btn>
        <Btn onClick={() => projectInput.current?.click()} title="打开项目" icon={<IconOpen />}>
          打开项目
        </Btn>
        <Btn onClick={saveProject} title="保存项目" icon={<IconSave />}>
          保存项目
        </Btn>
        <Btn
          onClick={run(() =>
            exportVideo({ onProgress: (d, n) => console.log(`export ${d}/${n}`) }).then((r) =>
              alert(`导出完成:${r.outDir}`),
            ),
          )}
          title="导出视频"
          icon={<IconExport />}
          primary
        >
          导出视频
        </Btn>
      </div>

      <input
        ref={videoInput}
        type="file"
        accept="video/*"
        multiple
        hidden
        onChange={(e) => e.target.files && run(() => importVideoFiles(e.target.files!))()}
      />
      <input
        ref={projectInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => e.target.files?.[0] && run(() => importProjectFile(e.target.files![0]))()}
      />
    </div>
  );
}
