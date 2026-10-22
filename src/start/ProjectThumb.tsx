/**
 * 缩略图那一排里的一格:一个项目,或者第一格的「Create A New」。
 *
 * 缩略图外框固定 16:9,项目自己的画幅按比例套在框里居中 —— 这样一排的高度齐平,又一眼看得出
 * 哪个是竖屏、哪个是方屏。真的首帧快照要等预渲染给(`product/rendering.md`),现在是按 id 哈希
 * 出来的色块(`hue.ts`)。
 */
import type { JSX } from "react";
import { hueOf } from "./hue";
import { humanDuration, humanWhen, type MockProject } from "./mockProjects";

const RATIO: Record<MockProject["ratio"], string> = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" };

export function ProjectThumb({ project, onOpen }: { project: MockProject; onOpen: (id: string) => void }): JSX.Element {
  const hue = hueOf(project.id);
  return (
    <button
      type="button"
      className="ps-tile"
      data-pc="start-project-tile"
      data-project={project.id}
      title={`${project.name}（${humanWhen(project.updatedAt)}）`}
      onClick={() => onOpen(project.id)}
    >
      <span className="ps-frame">
        <span
          className="ps-shot"
          style={{
            aspectRatio: RATIO[project.ratio],
            background: `linear-gradient(145deg, hsl(${hue} 52% 44%), hsl(${(hue + 38) % 360} 48% 26%))`,
          }}
        >
          {project.ratio}
        </span>
        <span className="ps-badge">{humanDuration(project.duration)}</span>
      </span>
      <span className="ps-tile-name">{project.name}</span>
      <span className="ps-tile-meta">{humanWhen(project.updatedAt)}</span>
    </button>
  );
}

/** 第一格恒定是它(翻到第几页都在),点了走和侧栏「新建项目」同一条路 */
export function CreateTile({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <button type="button" className="ps-tile ps-tile-new" data-pc="start-create-tile" onClick={onCreate}>
      <span className="ps-frame">
        <span className="ps-tile-new-plus" aria-hidden="true">+</span>
        <span className="ps-tile-new-text">Create A New</span>
      </span>
      <span className="ps-tile-name">新建项目</span>
      <span className="ps-tile-meta">空白画布</span>
    </button>
  );
}
