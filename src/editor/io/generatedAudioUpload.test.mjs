import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
let base = "https://assets.example.test/api/asset", ticketCalls = 0;
mock.module(srcUrl("editor/media/assetTiers.ts"), { namedExports: {
  remoteAssetBase: () => base,
  hasDocLink: () => true,
  docRequest: async request => { assert.deepEqual(request, { type: "auth.ticket", kind: "asset", access: "rw" }); return { type: "auth.ticket.ok", ticket: `ticket-${++ticketCalls}` }; },
} });
mock.module(srcUrl("online/pageFlag.ts"), { namedExports: { onlinePage: () => true } });
const { uploadGeneratedAudio } = await import("./generatedAudioUpload.ts");
const { createNotificationRecipe } = await import("../../kernel/soundEffects.ts");
const { renderSoundEffectWav } = await import("../../audio/soundGeneration.ts");

test("online generated WAV uses only remote media chunks with rw tickets and 401 refresh", async () => {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    assert.ok(String(url).startsWith(base + "/media/"));
    assert.match(init.headers.Authorization, /^Bearer ticket-/);
    if (calls.length === 1) return new Response("unauthorized", { status: 401 });
    if (String(url).endsWith("/chunks")) return Response.json({ complete: false, received: [] });
    return Response.json({ ok: true });
  };
  try {
    const wav = await renderSoundEffectWav(createNotificationRecipe(), { yield: () => Promise.resolve() });
    const result = await uploadGeneratedAudio(wav, new AbortController().signal);
    assert.match(result.hash, /^[a-f0-9]{64}$/); assert.equal(result.bytes, wav.length);
    assert.equal(calls.filter(c => c.method === "PUT").length, 1);
    assert.notEqual(calls[0].headers.Authorization, calls[1].headers.Authorization);
    assert.ok(calls.every(c => !c.url.includes("ticket-") && !c.url.startsWith("/api/")));
  } finally { globalThis.fetch = old; }
});

test("online mode without the connected asset service fails before trying any local route", async () => {
  const oldBase = base, oldFetch = globalThis.fetch; base = null;
  globalThis.fetch = async () => { throw new Error("must not fetch"); };
  try { await assert.rejects(uploadGeneratedAudio(new Uint8Array([1]), new AbortController().signal), /尚未连接素材服务/); }
  finally { base = oldBase; globalThis.fetch = oldFetch; }
});
