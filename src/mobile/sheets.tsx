/**
 * 手机版的底部面板:素材库、卡片库(含转场)、选剪辑、调整、冲突合并、成员、导出(演示稿第三～九轮)。
 * 每个按钮都调真实的 store 动作与服务,不写假数据;业务层里没有的项不显示(任务书「设计决定」3)。
 */
import { useEffect, useRef, useState } from "react";
import { actions, getState, useStore, withMerge } from "../store/project";
import { findClip, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import { MAX_TRANSITION_DUR, MIN_TRANSITION_DUR, transitionsOf, type Transition, type TransitionKind } from "../kernel/transitions";
import { getCard } from "../kernel/registry";
import type { CardDef, Control } from "../kernel/types";
import { importMediaFiles, MEDIA_ACCEPT } from "../editor/left/importAssets";
import { useCardLibrary } from "../editor/left/library/cardGroups";
import { currentAccountProjectLink, currentSharedUrl, discardOffline, pausedSummary, replayOffline, setOfflineOpen, useSync } from "../editor/sync/syncManager";
import { exportVideo, cancelExport, streamExportFile } from "../editor/io";
import { pickSaveTarget } from "../editor/io/proc";
import { exportGateNow } from "../editor/media/assetTiers";
import { awaitingUploaderMessage } from "../render/mediaTier";
import { exportSkippedMessage } from "../editor/io/exportSkipped";
import { ONLINE_EXPORT_TEXT } from "../export/text";
import type { ExportMode } from "../export/cardLayers";
import { clipKind, clipName, mainClipsOf, mainTrackOf } from "./mainContent";
import { Icon } from "./icons";
import { Sheet, fmtDur, fmtTc, tint, useToast } from "./ui";
import type { MembersInfo } from "./useMembers";

/* ======================== 素材库 ======================== */

export type AssetTab = "video" | "image" | "audio" | "cut";
const ASSET_TABS: { id: AssetTab; label: string }[] = [
  { id: "video", label: "视频" }, { id: "image", label: "图片" }, { id: "audio", label: "音频" }, { id: "cut", label: "剪辑" },
];

/** 视频 / 图片接到主要内容末尾;声音加到播放头位置 */
export function placeMedia(m: MediaAsset): TrackClip | null {
  const p = getState().project;
  if (m.kind === "audio") return actions.addMediaClip(m.id, getState().t);
  const main = mainClipsOf(p);
  const track = mainTrackOf(p);
  const end = main.length ? Math.max(...main.map((c) => c.end)) : 0;
  return actions.addMediaClip(m.id, end, track ? { trackId: track.id } : {});
}

export function AssetsSheet(props: { tab: AssetTab; onTab: (t: AssetTab) => void; onClose: () => void; onSwitchCut: (name: string) => void; onPlaced: (clip: TrackClip, m: MediaAsset) => void }) {
  const media = useStore((s) => s.project.media);
  const cuts = useStore((s) => s.project.cuts ?? []);
  const activeCut = useStore((s) => s.project.activeCutId);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const list = media.filter((m) => (props.tab === "audio" ? m.kind === "audio" : props.tab === "image" ? m.kind === "image" : m.kind === "video"));
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const r = await importMediaFiles(files);
      const n = r.counts.video + r.counts.audio + r.counts.image;
      toast(n ? `已导入 ${n} 个素材${r.skipped.length ? `，跳过 ${r.skipped.length} 个认不出的文件` : ""}` : r.rejected[0] ?? "没有能导入的文件");
      if (r.firstKind) props.onTab(r.firstKind);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <Sheet
      id="assets"
      title="素材库"
      tall
      onClose={props.onClose}
      head={props.tab !== "cut" ? <button type="button" className="chip accent" data-pcm="import" disabled={busy} onClick={() => input.current?.click()}>{busy ? "导入中…" : "＋ 导入"}</button> : null}
      tabs={<div className="seg">{ASSET_TABS.map((t) => <button key={t.id} type="button" className={t.id === props.tab ? "on" : undefined} onClick={() => props.onTab(t.id)}>{t.label}</button>)}</div>}
    >
      <input ref={input} type="file" multiple accept={MEDIA_ACCEPT} hidden data-pcm="import-input" onChange={(e) => void onFiles(e.target.files)} />
      {props.tab === "cut" ? (
        <>
          <div className="hint">点剪辑：缩略时间轴和完整时间轴换成它的内容。</div>
          <div className="grid">
            {cuts.map((c) => (
              <button key={c.id} type="button" className={c.id === activeCut ? "tile picked" : "tile"} data-pcm="asset-cut" onClick={() => { props.onSwitchCut(c.id); props.onClose(); }}>
                <div className="pic"><Icon name="clip" /></div>
                <div className="cap">{c.name}<small>剪辑</small></div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button type="button" className="dropzone" disabled={busy} onClick={() => input.current?.click()}>＋ 从相册 / 文件导入</button>
          <div className="hint">{props.tab === "audio" ? "点一下加到播放头位置。" : "点一下接到主要内容末尾。"}</div>
          {list.length === 0 ? <div className="hint" data-pcm="asset-empty">这个项目里还没有{ASSET_TABS.find((t) => t.id === props.tab)!.label}素材。</div> : (
            <div className="grid">
              {list.map((m) => (
                <button key={m.id} type="button" className="tile" data-pcm="asset" data-media={m.id} onClick={() => {
                  const clip = placeMedia(m);
                  if (!clip) { toast("放不下：没有空着的序列"); return; }
                  props.onPlaced(clip, m);
                }}>
                  <div className="pic" style={{ background: `linear-gradient(135deg, ${tint(m.id)}, var(--shade-art))` }}><Icon name={m.kind === "audio" ? "audio" : m.kind === "image" ? "image" : "video"} />
                    {m.duration ? <span className="dur">{fmtDur(m.duration)}</span> : null}
                    {m.pending ? <span className="st">上传中</span> : m.transcript ? <span className="st">已转写</span> : null}
                  </div>
                  <div className="cap">{m.name}<small>{m.kind === "audio" ? "音频" : m.kind === "image" ? "图片" : "视频"}</small></div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

/* ======================== 卡片库 ======================== */

export type CardTab = "anim" | "text" | "transition";
const TRANSITION_KINDS: { kind: TransitionKind; name: string; desc: string }[] = [
  { kind: "crossfade", name: "交叉溶解", desc: "前一段叠着化到后一段" },
  { kind: "fadeOut", name: "淡出", desc: "前一段结尾淡到黑" },
  { kind: "fadeIn", name: "淡入", desc: "后一段开头从黑里出来" },
];

/** 一段是不是文字卡:有一个叫 text 的文字参数 */
const isTextCard = (c: CardDef<any>) => c.controls.some((k) => k.key === "text" && k.type === "text");

/** 转场要落在哪:两段主要内容之间(加),或者换掉某一处已有的 */
export interface TransitionTarget { a: TrackClip; b: TrackClip; replace?: Transition }

/** 在 a、b 之间放一种转场;有 replace 时先删掉它(一步撤销) */
export function applyTransition(target: TransitionTarget, kind: TransitionKind, dur?: number): { ok: true } | { ok: false; error: string } {
  const run = () => {
    if (target.replace) {
      const r = actions.removeTransition(target.replace.id);
      if (!r.ok) return r;
    }
    const args = kind === "crossfade" ? { kind, clipId: target.a.id, otherClipId: target.b.id } : { kind, clipId: kind === "fadeOut" ? target.a.id : target.b.id };
    const r = actions.addTransition({ ...args, ...(dur ? { dur } : {}) });
    return r.ok ? { ok: true as const } : r;
  };
  return withMerge({ key: `pcm-transition-${Date.now()}`, windowMs: Infinity }, run);
}

export function CardsSheet(props: { tab: CardTab; onTab: (t: CardTab) => void; transition: TransitionTarget | null; onClose: () => void; onAdded: (clip: TrackClip) => void }) {
  const lib = useCardLibrary("");
  const toast = useToast();
  const all = [...lib.user, ...lib.magic, ...lib.native, ...lib.lottie, ...lib.particles].filter((c) => !c.kind || c.kind === "animation");
  const cards = props.tab === "text" ? all.filter(isTextCard) : all.filter((c) => !isTextCard(c));
  const tr = props.transition;
  const hint = props.tab === "transition"
    ? tr?.replace ? "换一个转场：点一种，替换当前这一处。" : tr ? "点一种转场，加到这两段之间。" : "先在缩略时间轴上点两段之间的 ＋，再选转场。"
    : "点一张卡片，加到播放头所在位置。";
  return (
    <Sheet
      id="cards"
      title="卡片（特效 / 动效）"
      tall
      onClose={props.onClose}
      tabs={<div className="seg">{([["anim", "动效"], ["text", "文字"], ["transition", "转场"]] as const).map(([id, label]) => <button key={id} type="button" className={id === props.tab ? "on" : undefined} onClick={() => props.onTab(id)}>{label}</button>)}</div>}
    >
      <div className="hint" data-pcm="cards-hint">{hint}</div>
      {props.tab === "transition" ? (
        <div className="grid">
          {TRANSITION_KINDS.map((k) => (
            <button key={k.kind} type="button" className={tr?.replace?.kind === k.kind ? "tile picked" : "tile"} data-pcm="transition-kind" data-kind={k.kind} disabled={!tr} onClick={() => {
              if (!tr) return;
              if (tr.replace?.kind === k.kind) { props.onClose(); return; }
              const r = applyTransition(tr, k.kind, tr.replace?.dur);
              if (!r.ok) { toast(r.error); return; }
              toast(tr.replace ? `已换成「${k.name}」` : `已加上「${k.name}」`);
              props.onClose();
            }}>
              <div className="pic"><Icon name="card" /></div>
              <div className="cap">{k.name}<small>{k.desc}</small></div>
            </button>
          ))}
        </div>
      ) : cards.length === 0 ? <div className="hint">没有可用的卡片。</div> : (
        <div className="grid">
          {cards.map((c) => (
            <button key={c.id} type="button" className="tile" data-pcm="card" data-card={c.id} onClick={() => {
              const clip = actions.addCardClip(c.id, getState().t);
              if (!clip) { toast("放不下：没有空着的序列"); return; }
              toast(`已加到 ${fmtTc(clip.start)}`);
              props.onAdded(clip);
            }}>
              <div className="pic" style={{ background: `linear-gradient(135deg, ${tint(c.id)}, var(--shade-art))` }}><Icon name={isTextCard(c) ? "text" : "card"} /></div>
              <div className="cap">{c.name}<small>{c.description}</small></div>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/* ======================== 选剪辑 ======================== */

export function ClipsSheet(props: { onClose: () => void; onSwitched: (name: string) => void }) {
  const cuts = useStore((s) => s.project.cuts ?? []);
  const active = useStore((s) => s.project.activeCutId);
  const project = useStore((s) => s.project);
  const toast = useToast();
  const summary = (id: string) => {
    if (id === active) { const m = mainClipsOf(project); return `${m.length} 段 · 共 ${fmtDur(m.reduce((s, c) => s + c.end - c.start, 0))}`; }
    const cut = cuts.find((c) => c.id === id);
    return cut?.duration ? `共 ${fmtDur(cut.duration)}` : "";
  };
  return (
    <Sheet id="clips" title="选择剪辑" onClose={props.onClose}>
      <div className="hint">选一个剪辑，缩略时间轴就换成它的内容。</div>
      {cuts.map((c) => (
        <button key={c.id} type="button" className={c.id === active ? "crow cur" : "crow"} data-pcm="cut-row" data-cut={c.id} onClick={() => {
          if (c.id !== active) actions.switchCut(c.id);
          props.onSwitched(c.name);
          props.onClose();
        }}>
          <div className="i"><Icon name="clip" /></div>
          <div style={{ flex: 1, minWidth: 0 }}><b>{c.name}</b><div className="hint" style={{ margin: 0 }}>{summary(c.id)}</div></div>
          {c.id === active && <span className="chip accent">当前</span>}
        </button>
      ))}
      <button type="button" className="btn" style={{ width: "100%", marginTop: 6 }} data-pcm="cut-new" onClick={() => {
        actions.addCut(undefined, { switchTo: true });
        const now = getState().project;
        const name = now.cuts?.find((c) => c.id === now.activeCutId)?.name ?? "新剪辑";
        toast(`已新建“${name}”`);
        props.onSwitched(name);
        props.onClose();
      }}>＋ 新建剪辑</button>
    </Sheet>
  );
}

/* ======================== 调整 ======================== */

/** 滑块 + 数字框:拖动中只改显示,松手(或数字框回车 / 失焦)才提交一次,一次拖动 = 一步撤销 */
function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit: string; onCommit: (v: number) => void; pcm?: string }) {
  const [v, setV] = useState(props.value);
  const range = useRef<HTMLInputElement>(null);
  useEffect(() => setV(props.value), [props.value]);
  const commit = (x: number) => { const c = Math.max(props.min, Math.min(props.max, x)); if (Math.abs(c - props.value) > 1e-9) props.onCommit(c); };
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    const on = () => commit(Number(el.value));
    el.addEventListener("change", on);
    return () => el.removeEventListener("change", on);
  });
  return (
    <div className="field" data-pcm={props.pcm}>
      <label>{props.label}<span><input className="num" type="number" value={Math.round(v * 100) / 100} min={props.min} max={props.max} step={props.step ?? 1}
        onChange={(e) => setV(Number(e.target.value))} onBlur={() => commit(v)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /> {props.unit}</span></label>
      <input ref={range} type="range" min={props.min} max={props.max} step={props.step ?? 1} value={v} onChange={(e) => setV(Number(e.target.value))} />
    </div>
  );
}

function ControlField({ ctl, value, onCommit }: { ctl: Control; value: unknown; onCommit: (v: unknown) => void }) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => setText(String(value ?? "")), [value]);
  if (ctl.type === "number" && ctl.min !== undefined && ctl.max !== undefined) {
    return <Slider label={ctl.label} value={Number(value ?? ctl.min)} min={ctl.min} max={ctl.max} step={ctl.step} unit="" onCommit={onCommit} />;
  }
  if (ctl.type === "select") {
    return (
      <div className="field"><label>{ctl.label}</label>
        <select className="text-in" value={String(value ?? "")} onChange={(e) => onCommit(e.target.value)}>
          {ctl.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    );
  }
  if (ctl.type === "color") {
    return <div className="field"><label>{ctl.label}<input type="color" value={String(value ?? "#ffffff")} onChange={(e) => onCommit(e.target.value)} /></label></div>;
  }
  const num = ctl.type === "number";
  return (
    <div className="field"><label>{ctl.label}</label>
      <input className="text-in" data-pcm={`param-${ctl.key}`} inputMode={num ? "decimal" : undefined} value={text} onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== String(value ?? "")) onCommit(num ? Number(text) : text); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    </div>
  );
}

export type ParamsTarget = { clipId: string } | { transitionId: string };

export function ParamsSheet(props: { target: ParamsTarget; onClose: () => void; onAskAgent: (clipId: string) => void }) {
  const project = useStore((s) => s.project);
  const toast = useToast();
  const undoRow = (clipId?: string) => (
    <div className="undo-row">
      <button type="button" className="btn" data-pcm="params-undo" onClick={() => actions.undo()}><Icon name="undo" />撤销</button>
      {clipId && <button type="button" className="btn" onClick={() => props.onAskAgent(clipId)}>让 Agent 接着改</button>}
    </div>
  );
  if ("transitionId" in props.target) {
    const tr = transitionsOf(project).find((x) => x.id === (props.target as { transitionId: string }).transitionId);
    if (!tr) return <Sheet id="params" title="调整" light onClose={props.onClose}><div className="hint">这处转场已经不在了。</div></Sheet>;
    const name = TRANSITION_KINDS.find((k) => k.kind === tr.kind)!.name;
    return (
      <Sheet id="params" title={name} light onClose={props.onClose} head={<span className="chip plum">转场</span>}>
        <div className="wrapnote"><b>转场：</b>把相邻的段绑成一组，想单独挪动先删掉转场。</div>
        <Slider label="时长" pcm="param-transition-dur" value={tr.dur} min={MIN_TRANSITION_DUR} max={Math.min(4, MAX_TRANSITION_DUR)} step={0.1} unit="s" onCommit={(v) => {
          const a = findClip(project, tr.aId)?.clip, b = tr.bId ? findClip(project, tr.bId)?.clip : undefined;
          const target: TransitionTarget | null = tr.kind === "crossfade" ? (a && b ? { a, b, replace: tr } : null)
            : tr.kind === "fadeOut" ? (a ? { a, b: a, replace: tr } : null) : (a ? { a, b: a, replace: tr } : null);
          if (!target) return;
          const r = applyTransition(target, tr.kind, v);
          if (!r.ok) toast(r.error);
        }} />
        {undoRow()}
      </Sheet>
    );
  }
  const hit = findClip(project, props.target.clipId);
  if (!hit) return <Sheet id="params" title="调整" light onClose={props.onClose}><div className="hint">这个片段已经不在了。</div></Sheet>;
  const c = hit.clip;
  const kind = clipKind(project, c);
  const def = c.cardId ? getCard(c.cardId) : undefined;
  const len = c.end - c.start;
  const kindLabel = kind === "card" ? "卡片" : kind === "audio" ? "音频" : kind === "image" ? "图片段" : kind === "cut" ? "剪辑段" : "视频段";
  return (
    <Sheet id="params" title={clipName(project, c, (id) => getCard(id)?.name)} light onClose={props.onClose} head={<span className={kind === "card" ? "chip plum" : "chip"}>{kindLabel}</span>}>
      {def && def.controls.filter((k) => k.type !== "asset").map((k) => (
        <ControlField key={k.key} ctl={k} value={c.params[k.key] ?? (def.defaults as Record<string, unknown>)[k.key]} onCommit={(v) => actions.setClipParams(c.id, { [k.key]: v })} />
      ))}
      <Slider label="时长" pcm="param-dur" value={Math.round(len * 10) / 10} min={0.5} max={Math.max(30, Math.ceil(len))} step={0.1} unit="s" onCommit={(v) => {
        const before = getState().project;
        actions.moveClip(c.id, { end: c.start + v });
        if (getState().project === before) toast("改不了时长：后面放不下，或这一段挂着转场");
      }} />
      {kind !== "audio" && <Slider label="不透明度" pcm="param-opacity" value={Math.round((c.opacity ?? 1) * 100)} min={0} max={100} unit="%" onCommit={(v) => actions.updateClip(c.id, { opacity: v / 100 })} />}
      {(kind === "video" || kind === "audio") && <>
        <Slider label="音量" pcm="param-volume" value={Math.round((c.audioVolume ?? 1) * 100)} min={0} max={100} unit="%" onCommit={(v) => actions.setClipVolume(c.id, v / 100)} />
        <div className="row"><div className="t">静音此片段<small>画面不受影响；时间轴会醒目标出“已静音”</small></div>
          <button type="button" className={c.audioMuted ? "toggle on" : "toggle"} aria-label="静音" data-pcm="param-mute" onClick={() => actions.setClipMuted(c.id, !c.audioMuted)} /></div>
      </>}
      {undoRow(c.id)}
    </Sheet>
  );
}

/* ======================== 冲突合并 ======================== */

/**
 * 待合并的离线修改。业务层现在只有「暂停」这一种(断网期间项目被别人改过:`syncManager` 的 `paused`),
 * 处理也只能整份「合并」或整份「丢弃」—— 逐项勾选与「按用户存待合并表」还没实现(`product/document-service.md`
 * 第 75～85 行),这里只列出改动、不画勾选框(任务书「设计决定」3,记待用户项)。
 */
export function useConflicts(): { pending: boolean; queued: number; conflicts: number } {
  const paused = useSync((v) => (v.status === "paused" ? v.paused : null));
  if (!paused) return { pending: false, queued: 0, conflicts: 0 };
  const conflicts = pausedSummary().reduce((n, s) => n + s.what.length, 0);
  return { pending: true, queued: paused.queued, conflicts };
}

export function conflictBarText(c: { queued: number; conflicts: number }): string {
  return `${c.queued} 处改动待合并${c.conflicts ? `，其中 ${c.conflicts} 处有冲突` : ""}`;
}

export function ConflictSheet(props: { onClose: () => void }) {
  const c = useConflicts();
  const summary = c.pending ? pausedSummary() : [];
  const close = () => { setOfflineOpen(false); props.onClose(); };
  return (
    <Sheet id="conflict" title="冲突合并" onClose={close} foot={
      <div className="cf-foot">
        <button type="button" className="btn primary" data-pcm="cf-merge" disabled={!c.pending} onClick={() => { replayOffline(); props.onClose(); }}>合并</button>
        <button type="button" className="btn" data-pcm="cf-drop" disabled={!c.pending} onClick={() => { discardOffline(); props.onClose(); }}>删除全部</button>
        <button type="button" className="btn" data-pcm="cf-close" onClick={close}>{c.pending ? "下次再说" : "完成"}</button>
      </div>
    }>
      {!c.pending ? <div className="hint" style={{ textAlign: "center", padding: "30px 0" }}>全部处理完了 ✓</div> : <>
        <div className="hint">你有 {c.queued} 步断网期间的修改。这段时间项目有以下改动，可能会和你的修改重叠：</div>
        {summary.length ? summary.map((s, i) => (
          <div key={i} className="cf-group">
            <div className="cf-head"><span className="nm">{s.who}</span>{s.what.length ? <span className="chip warn">有冲突</span> : <span className="chip">无冲突</span>}</div>
            <div className="cf-sub">{s.what.length ? s.what.map((w, j) => <span key={j}>{w}</span>) : <span>（没有列出具体位置）</span>}</div>
          </div>
        )) : <div className="hint">（文档服务没有列出具体改动）</div>}
        <div className="hint">「合并」把你的修改加进去（可能会盖掉他们刚改的地方）；「删除全部」丢掉你的离线修改，用现在的最新版本。</div>
      </>}
    </Sheet>
  );
}

/* ======================== 成员 ======================== */

export function MembersSheet(props: { info: MembersInfo; onClose: () => void }) {
  const toast = useToast();
  const { info } = props;
  const link = currentAccountProjectLink() ?? currentSharedUrl();
  return (
    <Sheet id="members" title={info.unavailable ? "成员" : `成员：${info.people} 人 · Agent：${info.agents} 个`} onClose={props.onClose}>
      {info.unavailable && <div className="hint">暂时无法获取项目成员。</div>}
      {info.lines.map((l) => (
        <div key={l.key} className="list-row" data-pcm="member-row">
          <div className={l.agent ? "i plum" : "i"}><Icon name={l.agent ? "card" : "person"} /></div>
          <div className="grow"><b>{l.name}{l.creator ? "（创建者）" : ""}</b><div className="hint" style={{ margin: 0 }}>{l.sub}</div></div>
          {l.agent ? <span className="chip plum">{l.sub === "云端" ? "云端" : "Agent"}</span> : <i className={l.online ? "dot" : "dot off"} />}
        </div>
      ))}
      {link && <button type="button" className="btn" style={{ width: "100%", marginTop: 6 }} data-pcm="copy-link" onClick={() => {
        void navigator.clipboard?.writeText(link).then(() => toast("项目链接已复制"), () => toast(link));
      }}>复制项目链接</button>}
    </Sheet>
  );
}

/* ======================== 导出 ======================== */

interface ExportRun { phase: "running" | "done" | "error" | "cancelled"; done: number; total: number; stage?: string; waiting?: string; message?: string; id?: string }

/** 和桌面顶栏的「导出视频」同一条路(`TopBar.tsx` 的 `exportProject`,在线页面那一支):先选方式,再选保存位置,浏览器里逐帧导出 */
export function ExportSheet(props: { onClose: () => void }) {
  const [run, setRun] = useState<ExportRun | null>(null);
  const idRef = useRef<string | null>(null);
  const start = async (mode: ExportMode) => {
    const project = getState().project;
    const pending = exportGateNow(project);
    if (pending && pending.length) { setRun({ phase: "error", done: 0, total: 1, message: awaitingUploaderMessage(pending) }); return; }
    let target: FileSystemFileHandle | null = null;
    try {
      target = await pickSaveTarget(`${project.name}.mp4`, "MP4 视频", { "video/mp4": [".mp4"] });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setRun({ phase: "error", done: 0, total: 1, message: (e as Error).message });
      return;
    }
    setRun({ phase: "running", done: 0, total: Math.max(1, Math.floor(project.duration * (project.fps || 30))) });
    try {
      const { id, written, skippedMedia } = await exportVideo({
        target, mode,
        onWaiting: (message) => setRun((s) => (s ? { ...s, waiting: message ?? undefined } : s)),
        onStart: (jobId) => { idRef.current = jobId; setRun((s) => (s ? { ...s, id: jobId } : s)); },
        onProgress: (done, total, stage) => setRun((s) => (s && s.phase === "running" ? { ...s, done, total, stage } : s)),
      });
      if (target && !written) {
        const w = await target.createWritable();
        try { await streamExportFile(id, "preview.mp4", w); await w.close(); } catch (error) { await w.abort?.(); throw error; }
      }
      const note = skippedMedia?.length ? exportSkippedMessage(skippedMedia) : "";
      setRun((s) => (s ? { ...s, phase: "done", done: s.total, message: note || (target ? `已保存为 ${target.name}` : "已存到浏览器的下载位置") } : s));
    } catch (e) {
      const err = e as Error & { cancelled?: boolean };
      setRun((s) => (s ? { ...s, phase: err.cancelled ? "cancelled" : "error", message: err.message } : s));
    } finally {
      idRef.current = null;
    }
  };
  const pct = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
  return (
    <Sheet id="export" title="导出" onClose={() => { if (run?.phase !== "running") props.onClose(); }}>
      {(!run || run.phase !== "running") && ([["fast", ONLINE_EXPORT_TEXT.fast, ONLINE_EXPORT_TEXT.fastHint], ["full", ONLINE_EXPORT_TEXT.full, ONLINE_EXPORT_TEXT.fullHint]] as const).map(([mode, name, hint]) => (
        <div key={mode} className="row">
          <div className="t">{name}<small>{hint}</small></div>
          <button type="button" className="btn primary" data-pcm="export-start" data-mode={mode} onClick={() => void start(mode)}>开始</button>
        </div>
      ))}
      {run && (
        <div data-pcm="export-progress" data-phase={run.phase}>
          {run.phase === "running" && <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
          <div className="hint">
            {run.phase === "running" ? (run.waiting ?? `${run.stage === "sound" ? "生成声音" : "渲染中"} ${pct}%…`)
              : run.phase === "done" ? `完成 · ${run.message ?? ""}` : run.phase === "cancelled" ? "已取消导出" : `导出失败：${run.message ?? ""}`}
          </div>
          {run.phase === "running" && <button type="button" className="btn" style={{ width: "100%" }} onClick={() => { if (idRef.current) void cancelExport(idRef.current); }}>取消导出</button>}
        </div>
      )}
    </Sheet>
  );
}


