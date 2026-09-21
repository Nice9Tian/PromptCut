import { type Project } from "../../kernel/project";

import { state, set, setProject } from "../core";

export const projectMeta = {
  setProjectMeta(patch: Partial<Pick<Project, "name" | "width" | "height" | "fps" | "duration" | "themeId" | "camera3dFov">>) {
    setProject({ ...state.project, ...patch });
  },
  editCardProject(edit: (project: Project) => Project) {
    setProject(edit(state.project));
  },
  /** 记住关三维之前用的视角(不落盘,换项目自动清)。见 EditorState.lastCamera3dFov */
  rememberCamera3dFov(fov: number | null) {
    set({ lastCamera3dFov: fov });
  },
  setDurationManual(sec: number) {
    const val = Math.max(1, sec);
    setProject({ ...state.project, duration: val });
    set({ durationManual: val });
  },
  syncDuration(sec: number) {
    const val = Math.max(1, sec);
    if (Math.abs(val - state.project.duration) < 1e-6) return;
    setProject({ ...state.project, duration: val }, { undoable: false });
  },
};
