/**
 * 低内存档的「素材只拉小尺寸」与在线浏览器模式的远程取回地址(`docs/plan/c10a-contract.md` 第 8 节)。
 * 跑:node --test src/render/mediaTierLowMemory.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { playbackUrl, chooseTier, setMediaTierPolicy, mediaTierPolicy, remoteMediaUrl, TIERS_KNOWN_REMOTE } = await import("./mediaTier.ts");

const ORIG = "a".repeat(64);
const SMALL = "b".repeat(64);
const video = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG, small: SMALL }, ext: "mp4", kind: "video" };
const videoNoSmall = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG }, ext: "mp4", kind: "video" };
const image = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG }, ext: "png", kind: "image" };
const audio = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG }, ext: "m4a", kind: "audio" };
const never = () => { throw new Error("低内存档不该问可播性(那要拉原尺寸的首帧)"); };

test("LMT1 低内存档:有小尺寸恒给小尺寸,两档都齐也不换原尺寸,不问可播性", () => {
  const low = { lowMemory: true, playable: never };
  assert.equal(playbackUrl(video, [], low), `/@media/${SMALL}`, "还没问过");
  assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL, ORIG], low), `/@media/${SMALL}`, "两档都齐");
  assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL], low), `/@media/${SMALL}`);
});

test("LMT2 低内存档:小尺寸问过了还没到齐 → 不给地址、等待上传方,不回退到原尺寸", () => {
  const c = chooseTier(video, [TIERS_KNOWN_REMOTE, ORIG], { lowMemory: true, playable: never });
  assert.deepEqual(c, { url: "", tier: "none", awaiting: true });
});

test("LMT3 低内存档:没有小尺寸这一档的视频 → 等待上传方,不拉原尺寸(不论问没问过)", () => {
  assert.deepEqual(chooseTier(videoNoSmall, [], { lowMemory: true, playable: never }), { url: "", tier: "none", awaiting: true });
  assert.deepEqual(chooseTier(videoNoSmall, [TIERS_KNOWN_REMOTE, ORIG], { lowMemory: true, playable: never }), { url: "", tier: "none", awaiting: true });
});

test("LMT4 低内存档:图片、音频按 C6.6 设计没有小尺寸,照常给原尺寸(偏离见报告);迁移期老素材原样", () => {
  assert.equal(playbackUrl(image, [TIERS_KNOWN_REMOTE, ORIG], { lowMemory: true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl(audio, [TIERS_KNOWN_REMOTE, ORIG], { lowMemory: true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl({ ...image, kind: "video" }, [], { lowMemory: true }), `/@media/${ORIG}`, "老项目把图片登记成 video,按扩展名认");
  assert.equal(playbackUrl({ url: "/api/media/file?path=x.mp4" }, [], { lowMemory: true }), "/api/media/file?path=x.mp4");
});

test("LMT5 普通档不受影响(缺省策略)", () => {
  assert.equal(mediaTierPolicy().lowMemory, false);
  assert.equal(playbackUrl(video, [SMALL, ORIG], { playable: () => true }), `/@media/${ORIG}`);
  assert.equal(playbackUrl(videoNoSmall, [TIERS_KNOWN_REMOTE], { playable: never }), `/@media/${ORIG}`);
});

test("LMT6 策略:模块级的 lowMemory 生效;opts 可覆盖", () => {
  try {
    setMediaTierPolicy({ lowMemory: true });
    assert.equal(playbackUrl(video, [TIERS_KNOWN_REMOTE, SMALL, ORIG], { playable: never }), `/@media/${SMALL}`);
    assert.equal(playbackUrl(video, [SMALL, ORIG], { lowMemory: false, playable: () => true }), `/@media/${ORIG}`);
  } finally {
    setMediaTierPolicy({ lowMemory: false });
  }
});

test("LMT7 在线浏览器模式:哈希地址换成远程素材服务的 media/<hash>?t=<票据>;非哈希地址原样", () => {
  const remote = { base: "https://h.example/media/api/asset/", ticket: "tk+/=" };
  assert.equal(remoteMediaUrl(`/@media/${SMALL}`, { base: "https://h.example/media/api/asset", ticket: "tk+/=" }),
    `https://h.example/media/api/asset/media/${SMALL}?t=${encodeURIComponent("tk+/=")}`);
  assert.equal(remoteMediaUrl("/api/media/file?path=x", remote), "/api/media/file?path=x");
  try {
    setMediaTierPolicy({ lowMemory: true, remote });
    assert.equal(playbackUrl(video, []), `https://h.example/media/api/asset/media/${SMALL}?t=${encodeURIComponent("tk+/=")}`);
    setMediaTierPolicy({ remote: { base: "https://h.example/api/asset", ticket: null } });
    assert.equal(playbackUrl(video, []), `https://h.example/api/asset/media/${SMALL}`, "没有票据就不带查询串");
  } finally {
    setMediaTierPolicy({ lowMemory: false, remote: null });
  }
  assert.equal(playbackUrl(video, []), `/@media/${SMALL}`, "桌面运行环境照旧走本机代理");
});
