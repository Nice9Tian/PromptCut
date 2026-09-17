import type { Plugin } from "vite";
import fs from "node:fs/promises";
import path from "node:path";
import { CardService } from "./card-service.mjs";
import { renderProject } from "./vite-plugin-frames";
import { openBakery, bakeFrames } from "../scripts/export-frames.mjs";

const services = new Map<string, CardService>();
export function cardService(root: string, origin: string): CardService {
  if (services.has(root)) return services.get(root)!;
  let gpuChain = Promise.resolve<any>(null);
  let gpuBakery: any;
  const service = new CardService({ root, dir: path.join(process.env.PROMPTCUT_EXPORT_DIR || path.join(root, "out"), "card-library"),
    renderValue: (context: any, value: any, time: number, signal: AbortSignal) => {
      const run = gpuChain.catch(() => {}).then(async () => {
        if (signal?.aborted) throw new Error("Card materialization cancelled");
        if (!gpuBakery) {
          const empty = { width: 16, height: 16, fps: 30, duration: 1, tracks: [], media: [] };
          gpuBakery = await openBakery({ url: origin + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty))) });
        }
        const base64 = await gpuBakery.page.evaluate(async ({ value, time, scope, width, height }: any) => {
          const { CardGpuExecutor } = await import(/* @vite-ignore */ '/src/render/cards/gpuExecutor.ts');
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
          const bitmaps: ImageBitmap[] = [];
          const gpu = new CardGpuExecutor(canvas, async (source: any, requestedTime: number) => {
            const url = source.type === 'pixels' ? source.url : '/api/card-runtime/source?scope=' + scope + '&nodeId=' + encodeURIComponent(source.nodeId) + '&time=' + requestedTime;
            const response = await fetch(url);
            if (!response.ok) throw new Error(await response.text());
            const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none' }); bitmaps.push(bitmap); return bitmap;
          });
          try { await gpu.execute(value, time); return canvas.toDataURL('image/png').split(',')[1]; }
          finally { gpu.dispose(); bitmaps.forEach(bitmap => bitmap.close()); }
        }, { value, time, scope: context.revision, width: context.project.width, height: context.project.height });
        if (signal?.aborted) throw new Error("Card materialization cancelled");
        return Buffer.from(base64, 'base64');
      });
      gpuChain = run; return run;
    },
    renderChrome: async (context: any, node: any, time: number, signal: AbortSignal) => {
      const project = structuredClone(context.project);
      let clipId = node.clipId;
      if (!clipId && node.inputs?.source) {
        let source = context.nodes.get(node.inputs.source.nodeId);
        while (source && !source.clipId && source.inputs?.source) source = context.nodes.get(source.inputs.source.nodeId);
        clipId = source?.clipId;
      }
      const trackIndex = project.tracks.findIndex((track: any) => track.clips.some((clip: any) => clip.id === clipId));
      if (trackIndex < 0) throw new Error('Chrome input clip is missing');
      const clip = project.tracks[trackIndex].clips.find((clip: any) => clip.id === clipId);
      // Keep the source card's lower composition context. The consuming effect
      // is removed from its source clip to avoid evaluating itself recursively.
      project.tracks = project.tracks.slice(trackIndex).map((track: any, index: number) => index ? track : ({ ...track, hidden: false, clips: [{ ...clip, nodeId: undefined }] }));
      // Retain input-only clips as hidden tracks so graph references remain
      // valid while the lower composition keeps its custom effects.
      project.tracks.push(...context.project.tracks.slice(0, trackIndex).map((track: any) => ({ ...track, hidden: true })));
      const siblings = context.project.tracks[trackIndex].clips.filter((other: any) => other.id !== clipId);
      if (siblings.length) {
        let sourceTrackId = '__pc_chrome_sources_' + context.project.tracks[trackIndex].id;
        while (project.tracks.some((track: any) => track.id === sourceTrackId)) sourceTrackId += '_';
        project.tracks.push({ ...context.project.tracks[trackIndex], id: sourceTrackId, hidden: true, sourceOnly: true, clips: structuredClone(siblings) });
      }
      delete project._cardRender;
      const empty = { width: project.width, height: project.height, fps: project.fps, duration: project.duration, tracks: [], media: [] };
      const url = origin + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
      // A source request may originate inside an occupied frame-pipeline lane.
      // A separate page prevents that lane from waiting on itself.
      const bakery = await openBakery({ url });
      try {
        await bakery.loadProject(project, { deferCards: true });
        let result: Buffer | undefined;
        await bakeFrames(bakery, { out: context.temp, targetFrames: [Math.max(0, Math.round((clip.start + time) * project.fps))],
          fullFrame: true, writeFrames: false, signal, onFrame: (_frame: number, buf: Buffer) => { result = buf; } });
        if (!result) throw new Error('Chrome source returned no frame');
        return result;
      } finally { await bakery.close(); }
    },
  });
  (service as any).closeGpu = async () => { await gpuChain.catch(() => {}); await gpuBakery?.close(); };
  services.set(root, service); return service;
}

export function cardRuntimePlugin(): Plugin {
  return { name: 'promptcut-card-runtime', configureServer(server) {
    const root = path.resolve(server.config.root);
    server.httpServer?.once('close', () => {
      const service = services.get(root); services.delete(root);
      void service?.close(); void (service as any)?.closeGpu?.();
    });
    server.middlewares.use('/api/card-runtime', (req, res, next) => {
      const origin = `http://127.0.0.1:${(server.httpServer?.address() as any)?.port}`;
      const service = cardService(root, origin), url = new URL(req.url || '/', origin);
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
      const abort = new AbortController(); req.once('aborted', () => abort.abort()); res.once('close', () => { if (!res.writableEnded) abort.abort(); });
      if (req.method === 'GET') {
        void (async () => {
          const asset = /^\/asset\/([a-f0-9]{64}\.(png|wav))$/.exec(url.pathname);
          if (asset) {
            const bytes = await fs.readFile(path.join(service.dir, 'assets', asset[1]));
            res.setHeader('Content-Type', asset[2] === 'png' ? 'image/png' : 'audio/wav');
            res.setHeader('Cache-Control', 'private,max-age=31536000,immutable'); res.end(bytes); return;
          }
          if (url.pathname === '/source') {
            const context = service.scopes.get(url.searchParams.get('scope'));
            if (!context) return json(404, { error: 'Card source scope expired' });
            const png = await service.sourcePng(context, url.searchParams.get('nodeId'), Number(url.searchParams.get('time')), abort.signal);
            res.setHeader('Content-Type', 'image/png'); res.end(png); return;
          }
          next();
        })().catch(error => json(400, { error: error.message, code: error.code })); return;
      }
      if (req.method !== 'POST') return next();
      let body = '', over = false;
      req.on('data', chunk => { if (!over) { body += chunk; if (Buffer.byteLength(body) > 32 * 1024 * 1024) { over = true; json(413, { error: 'Card request too large' }); } } });
      req.on('end', async () => {
        if (over) return;
        try {
          const input = JSON.parse(body), project = renderProject(input.project);
          if (!project || !Array.isArray(project.tracks) || !Number.isFinite(project.width) || !Number.isFinite(project.height)
            || project.width < 1 || project.height < 1 || project.width > 8192 || project.height > 8192) throw new Error('Invalid card project');
          if (url.pathname === '/visual') return json(200, await service.visual(project, input.nodeId, input.time, { signal: abort.signal }));
          if (url.pathname === '/audio') return json(200, await service.evaluate(project, input.nodeId, 0, { domain: 'audio', start: input.start,
            count: input.count, sampleRate: input.sampleRate || 48000, signal: abort.signal }));
          json(404, { error: 'Unknown card operation' });
        } catch (error: any) { json(400, { error: error.message, code: error.code || 'CARD_RUNTIME' }); }
      });
    });
  } };
}
