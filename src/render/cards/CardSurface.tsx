import { useEffect, useRef } from "react";
import { CardGpuError, CardGpuExecutor, type CardGpuValue, type ValueResolver } from "./gpuExecutor";

/** A host-owned canvas surface. `onReady` fires only for the most recent value/time,
 * so a capture caller can await it without accepting an obsolete scrub frame. */
export function CardSurface({ value, width, height, time, resolveSource, onReady, onError, className }: {
  value: CardGpuValue; width: number; height: number; time: number; resolveSource: ValueResolver;
  onReady?: (canvas: HTMLCanvasElement) => void; onError?: (error: CardGpuError) => void; className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), executor = useRef<CardGpuExecutor | null>(null);
  useEffect(() => { const c=canvas.current; if (!c) return; executor.current?.dispose(); try { executor.current=new CardGpuExecutor(c,resolveSource); } catch (e) { onError?.(e as CardGpuError); } return () => executor.current?.dispose(); }, [resolveSource, onError]);
  useEffect(() => { const c=canvas.current, e=executor.current; if(!c||!e)return; c.width=width;c.height=height; const abort=new AbortController(); void e.execute(value,time,abort.signal).then(()=>{if(!abort.signal.aborted)onReady?.(c);}).catch(x=>{if(!abort.signal.aborted)onError?.(x as CardGpuError);}); return()=>abort.abort(); },[value,width,height,time,onReady,onError]);
  return <canvas ref={canvas} className={className} width={width} height={height} style={{ display: "block", width: "100%", height: "100%" }} />;
}
