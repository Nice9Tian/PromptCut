/**
 * 换档判据(`mediaTier.ts` 的 playbackUrl)与本机可播性缓存(`playability.ts`)的单测。
 * 跑:node --test src/render/mediaTier.test.mjs
 *
 * 钉的是 T1a 审查的三条:
 *   #3 小版还没传完、原片传完了 → 给原片;判据只看「素材服务报 complete 的哈希集合」;
 *   #4 可播性是**这台设备**的结论,存在本机缓存里,不看项目文档(MediaAsset 上写了什么都不算);
 *   集合为空(还没问过素材服务)→ 有小版给小版(C6.6 起;以前是一律 `media.url`)。
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { playbackUrl, hashFromUrl } = await import("./mediaTier.ts");
const { forgetPlayable, playableOnThisHost, rememberPlayable, mimeForExt, probePlayable } = await import("./playability.ts");

const ORIG = "a".repeat(64);
const SMALL = "b".repeat(64);
const media = { url: `/@media/${ORIG}`, hash: ORIG, tiers: { original: ORIG, small: SMALL }, ext: "mov", kind: "video" };
const never = () => { throw new Error("不该问可播性"); };

test("集合为空(还没问过素材服务):有小版给小版、没有给原片,不问可播性(C6.6:第一帧不直接拉原片)", () => {
  assert.equal(playbackUrl(media, [], { playable: never }), `/@media/${SMALL}`);
  assert.equal(playbackUrl(media, new Set(), { playable: never }), `/@media/${SMALL}`);
  assert.equal(playbackUrl({ ...media, tiers: { original: ORIG } }, [], { playable: never }), `/@media/${ORIG}`);
  // 迁移期没有哈希的老素材:原样
  assert.equal(playbackUrl({ url: "/api/media/file?path=C%3A%2Fa.mp4" }, [ORIG]), "/api/media/file?path=C%3A%2Fa.mp4");
  // 只有哈希、没有 url 的:拼哈希地址
  assert.equal(playbackUrl({ url: "", hash: ORIG }, []), `/@media/${ORIG}`);
});

test("#3:小版还没传完、原片传完了 → 原片", () => {
  assert.equal(playbackUrl(media, [ORIG], { playable: () => true }), `/@media/${ORIG}`);
  // 没有小版这一档的素材(浏览器里导入的只有原片)
  const onlyOriginal = { ...media, tiers: { original: ORIG } };
  assert.equal(playbackUrl(onlyOriginal, [ORIG], { playable: never }), `/@media/${ORIG}`);
});

test("先小后大:只有小版传完 → 小版;两档都传完、这台设备放得了 → 原片", () => {
  assert.equal(playbackUrl(media, [SMALL], { playable: never }), `/@media/${SMALL}`);
  assert.equal(playbackUrl(media, [SMALL, ORIG], { playable: () => true }), `/@media/${ORIG}`);
});

test("两档都没传完 → 原片(还没有小版时直接拉原片)", () => {
  assert.equal(playbackUrl(media, ["c".repeat(64)], { playable: never }), `/@media/${ORIG}`);
});

test("#4:这台设备放不了原片 → 有小版就一直停在小版;小版没传完才回退到原片", () => {
  const no = () => false;
  assert.equal(playbackUrl(media, [SMALL, ORIG], { playable: no }), `/@media/${SMALL}`);
  assert.equal(playbackUrl(media, [ORIG], { playable: no }), `/@media/${ORIG}`, "没有小版可给:强制回退到原片");
});

test("#4:可播性还不知道 → 先给小版;不探的选项下不触发探测", () => {
  assert.equal(playbackUrl(media, [SMALL, ORIG], { playable: () => undefined, probe: false }), `/@media/${SMALL}`);
});

test("#4:可播性存在本机缓存里,按内容哈希;项目文档里写什么都不算", () => {
  forgetPlayable();
  assert.equal(playableOnThisHost(ORIG), undefined);
  // 项目文档里就算有人写了 playable: true,也不看它
  const claimed = { ...media, playable: true };
  assert.equal(playbackUrl(claimed, [SMALL, ORIG], { probe: false }), `/@media/${SMALL}`);
  rememberPlayable(ORIG.toUpperCase(), true);
  assert.equal(playableOnThisHost(ORIG), true, "哈希大小写不敏感");
  assert.equal(playbackUrl(media, [SMALL, ORIG]), `/@media/${ORIG}`);
  rememberPlayable(ORIG, false);
  assert.equal(playbackUrl(media, [SMALL, ORIG]), `/@media/${SMALL}`);
  forgetPlayable();
});

test("没有 DOM 时探测不下结论(回 undefined、不记)", async () => {
  forgetPlayable();
  assert.equal(await probePlayable(ORIG, `/@media/${ORIG}`, "mov"), undefined);
  assert.equal(playableOnThisHost(ORIG), undefined);
});

test("cloudBase:哈希地址换成远程素材服务的绝对地址,别的地址不动", () => {
  assert.equal(playbackUrl(media, [SMALL], { cloudBase: "https://assets.example/", playable: never }), `https://assets.example/@media/${SMALL}`);
  assert.equal(playbackUrl({ url: "/api/media/file?path=x" }, [], { cloudBase: "https://assets.example" }), "/api/media/file?path=x");
});

test("mimeForExt / hashFromUrl", () => {
  // C6.6:MOV 按 Chrome 实际用的 ISO BMFF 解复用器问(canPlayType("video/quicktime") 在 Chrome 恒回空串)
  assert.equal(mimeForExt("MOV"), "video/mp4");
  assert.equal(mimeForExt("xyz"), null);
  assert.equal(hashFromUrl(`/@media/${ORIG}.mp4?x=1`), ORIG);
  assert.equal(hashFromUrl("/@media/name.mp4"), null);
});
