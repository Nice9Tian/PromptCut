/** Real React/WebGL lifecycle fixture. Run manually; it owns Vite :5199 only. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { openBakery } from './export-frames.mjs';

const root = process.cwd();
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5199, strictPort: true } });
let bakery;
try {
  await server.listen(); bakery = await openBakery({ url: 'http://127.0.0.1:5199/?export=1' });
  const result = await bakery.page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const domModule = await import('/node_modules/.vite/deps/react-dom_client.js');
    const createRoot = domModule.createRoot || domModule.default?.createRoot;
    if (typeof createRoot !== 'function') throw new Error(`Vite react-dom client has no createRoot: ${Object.keys(domModule).join(',')}`);
    const { CardSurface } = await import('/src/render/cards/CardSurface.tsx');
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const proto = WebGL2RenderingContext.prototype, original = proto.createProgram; let programs = 0, ready = [], errors = [];
    proto.createProgram = function (...args) { programs++; return original.apply(this, args); };
    // Keep this exact GLSL value across every render. The delayed run differs
    // only in u_input0, so a new program means CardSurface recreated its
    // executor instead of retaining the canvas-owned cache.
    const shader = { type: 'glsl', fragment: 'uniform sampler2D u_input0; uniform float u_time; void main(){outColor=texture(u_input0,v_uv)+vec4(u_time,0.,0.,0.);}', inputs: [{ type: 'source', nodeId: 'input' }], uniforms: { u_time: { type: 'expr', op: 'time' } } };
    const render = (time, resolver, value = shader) => root.render(React.createElement(CardSurface, { value, width: 16, height: 16, time, resolveSource: resolver, onReady: () => ready.push(time), onError: error => errors.push(`${time}:${error.message}`) }));
    // HTMLCanvasElement is a TexImageSource and works in headless WebGL where
    // ImageBitmap allocation is deliberately disabled by some Chrome builds.
    const fast = async () => { const image = document.createElement('canvas'); image.width = image.height = 1; return image; };
    const slow = async (_s, _t, signal) => { await new Promise(r => setTimeout(r, 80)); if (signal.aborted) throw new Error('cancelled'); return fast(); };
    try {
      render(.1, fast); await new Promise(r => setTimeout(r, 40));
      render(.2, fast); await new Promise(r => setTimeout(r, 40));
      // The resolver must actually be in the graph: wait until it begins, then
      // replace the frame. Its completion may not call the new frame's ready.
      let slowStarted = false;
      const delayed = async (...args) => { slowStarted = true; return slow(...args); };
      render(.3, delayed);
      for (let i = 0; i < 20 && !slowStarted; i++) await new Promise(r => setTimeout(r, 5));
      if (!slowStarted) throw new Error('delayed source resolver never started');
      render(.4, fast);
      await new Promise(r => setTimeout(r, 120));
      const surface = { programs, ready: [...ready], errors: [...errors] };

      // Mount PythonCard too. Its first visual HTTP request deliberately takes
      // longer than the next frame; this verifies layout cleanup removes the
      // old frame-work ticket and only the descriptor evaluated for .4 reaches
      // the persistent CardSurface.
      const { PythonCard } = await import('/src/render/cards/PythonCard.tsx');
      const { frameWorkStatus } = await import('/src/kernel/frameReady.ts');
      const project = {
        version: 1, id: 'lifecycle-fixture', name: 'lifecycle', width: 16, height: 16, fps: 30, duration: 1,
        themeId: 'midnight', media: [], tracks: [],
        cardDefinitions: [{ id: 'python-definition', language: 'python', kind: 'filter', source: 'class Card: pass', entry: 'Card' }],
        cardNodes: [{ id: 'python-node', definitionId: 'python-definition', adapter: 'python', inputs: {} }],
      };
      const originalFetch = window.fetch, requests = [], aborted = [];
      window.fetch = (input, init = {}) => {
        if (!String(input).endsWith('/api/card-runtime/visual')) return originalFetch(input, init);
        const request = JSON.parse(init.body); requests.push(request.time);
        const delay = request.time === .3 ? 90 : 0;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(JSON.stringify({
            value: { type: 'draw', commands: [{ type: 'solid', color: [request.time, 0, 0, 1] }] },
            revision: `visual-${request.time}`,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })), delay);
          init.signal?.addEventListener('abort', () => { clearTimeout(timer); aborted.push(request.time); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
        });
      };
      try {
        root.render(React.createElement(PythonCard, { project, nodeId: 'python-node', time: .1 }));
        for (let i = 0; i < 40 && (!requests.includes(.1) || frameWorkStatus().length); i++) await new Promise(r => setTimeout(r, 5));
        if (!requests.includes(.1) || frameWorkStatus().length) throw new Error('Initial Python frame did not finish');
        const firstCanvas = host.querySelector('canvas');
        root.render(React.createElement(PythonCard, { project, nodeId: 'python-node', time: .3 }));
        for (let i = 0; i < 20 && !requests.includes(.3); i++) await new Promise(r => setTimeout(r, 5));
        if (!requests.includes(.3) || !frameWorkStatus().some(item => item.label.includes('@ 0.3'))) throw new Error('PythonCard did not register its delayed frame work');
        await new Promise(r => setTimeout(r, 25));
        if (!frameWorkStatus().some(item => item.label.includes('@ 0.3'))) throw new Error('Old descriptor prematurely completed the pending new frame');
        if (host.querySelector('canvas') !== firstCanvas) throw new Error('PythonCard discarded its canvas while waiting for a new value');
        root.render(React.createElement(PythonCard, { project, nodeId: 'python-node', time: .4 }));
        await new Promise(r => setTimeout(r, 120));
        const pending = frameWorkStatus();
        if (!aborted.includes(.3) || !requests.includes(.4) || pending.length) throw new Error(JSON.stringify({ requests, aborted, pending }));
        return { surface, python: { requests: [...requests], aborted: [...aborted], pending: [...pending] } };
      } finally { window.fetch = originalFetch; }
    } finally { proto.createProgram = original; root.unmount(); host.remove(); }
  });
  // source upload, the stable GLSL card, and the final canvas copy.
  assert.equal(result.surface.programs, 3, JSON.stringify(result));
  assert.deepEqual(result.surface.ready, [.1, .2, .4], JSON.stringify(result));
  assert.deepEqual(result.surface.errors, [], JSON.stringify(result));
  assert.deepEqual(result.python.requests, [.1, .3, .4], JSON.stringify(result));
  assert.deepEqual(result.python.aborted, [.1, .3], JSON.stringify(result));
  assert.deepEqual(result.python.pending, [], JSON.stringify(result));
  console.log('PASS React CardSurface/PythonCard lifecycle', JSON.stringify(result));
} finally { await bakery?.close(); await server.close(); }
