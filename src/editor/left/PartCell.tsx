import { useState } from "react";
import { actions, getState } from "../../store/project";
import { findClip } from "../../kernel/project";
import { addPart } from "../../kernel/parts";
import { getPart } from "../../parts/registry";
import type { PartDef } from "../../parts/types";
import { COMPOSITE_CARD_ID } from "../../cards/native/composite";
import { isComposite } from "../../kernel/envelope";

/**
 * 左栏「部件库」里的一格。点一下:当前选中的是组合卡就把部件加进去;
 * 否则在播放头新建一张组合卡,里面就这一个部件。部件不能单独上时间轴,它一定住在组合卡里。
 */
export function PartCell({ def }: { def: PartDef<any> }) {
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (text: string) => { setMsg(text); setTimeout(() => setMsg(null), 1800); };

  const onClick = () => {
    try {
      const st = getState();
      const sel = st.selection[0] ? findClip(st.project, st.selection[0]) : null;
      if (sel && isComposite(sel.clip)) {
        const { tree } = addPart(sel.clip.parts ?? [], { partId: def.id }, getPart);
        actions.setClipParts(sel.clip.id, tree);
        flash("已加进选中的组合卡");
        return;
      }
      const t = Math.round(st.t * 10) / 10;
      const { tree } = addPart([], { partId: def.id }, getPart);
      const clip = actions.addCardClip(COMPOSITE_CARD_ID, t, { parts: tree });
      if (!clip) { flash("没有动效轨,先在时间轴新建一条"); return; }
      actions.select([clip.id]);
      flash("新建了一张组合卡");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      data-pc-part-cell={def.id}
      className="relative rounded border border-neutral-800 bg-neutral-900 hover:border-neutral-600 cursor-pointer overflow-hidden h-24"
      onClick={onClick}
      title={`${def.description}\n点击 = 加进选中的组合卡;没选中组合卡就在播放头新建一张`}
    >
      <div className="p-1.5 pointer-events-none">
        <div className="flex items-baseline justify-between gap-1">
          <div className="text-xs text-neutral-200 font-medium truncate">{def.name}</div>
          <div className="text-[9px] text-neutral-500 shrink-0">{def.role}</div>
        </div>
        <div className="text-[10px] text-neutral-500 line-clamp-3 mt-1">{def.description}</div>
      </div>
      {msg && (
        <div className="absolute bottom-1 inset-x-0 text-center text-[10px] text-neutral-200 z-10 pointer-events-none bg-black/60 px-1 truncate">{msg}</div>
      )}
    </div>
  );
}
