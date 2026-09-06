import { useEffect, useState } from "react";
import type { JSX } from "react";
import Editor from "./Editor";
import { StartPage } from "./StartPage";

/**
 * 开始页和编辑器之间的门。
 *
 * 编辑器本身不知道有开始页这回事 —— 它照旧渲染 store 里的当前项目。开始页在
 * 切过来之前就已经把项目 load 进 store 了,所以这里只管换视图。
 *
 * `?editor` 直接进编辑器:导出、自动化脚本和老书签都还指着那条路。
 */
export function Shell(): JSX.Element {
  const [inEditor, setInEditor] = useState(() => {
    try {
      return new URLSearchParams(location.search).has("editor");
    } catch {
      return false;
    }
  });

  // 顶栏的「回到首页」在 window 上派发这个事件,免得给 Editor 加一层 props
  useEffect(() => {
    const back = () => setInEditor(false);
    window.addEventListener("pc-go-home", back);
    return () => window.removeEventListener("pc-go-home", back);
  }, []);

  return inEditor ? <Editor /> : <StartPage onEnterEditor={() => setInEditor(true)} />;
}

export default Shell;
