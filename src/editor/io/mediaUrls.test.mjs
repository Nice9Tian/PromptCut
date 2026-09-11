// node --test src/editor/io/mediaUrls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { restoreMediaUrls, mediaUrlFromPath } = await import("./mediaUrls.ts");

const name = "雄伟的寺庙！浅草寺 [BV1Zn4y1d71C].mp4";

test("mediaUrlFromPath:取路径最后一段、编码;没有 path 给 null", () => {
  assert.equal(mediaUrlFromPath(`C:\\Users\\admin\\Videos\\PromptCut\\media\\${name}`), `/@media/${encodeURIComponent(name)}`);
  assert.equal(mediaUrlFromPath("/srv/media/a b.mp4"), "/@media/a%20b.mp4");
  assert.equal(mediaUrlFromPath(undefined), null);
  assert.equal(mediaUrlFromPath(""), null);
});

test("存盘留下的裸文件名 + path(这次的 3.proc)→ /@media/<文件名>", () => {
  const { media, missing } = restoreMediaUrls([
    { id: "m1", kind: "video", name, url: name, path: `C:\\x\\media\\${name}` },
  ]);
  assert.equal(media[0].url, `/@media/${encodeURIComponent(name)}`);
  assert.equal(media[0].name, name);
  assert.deepEqual(missing, []);
});

test("死掉的 blob: 有 path 就找回;没 path 标缺失、清空地址", () => {
  const { media, missing } = restoreMediaUrls([
    { id: "a", kind: "video", name: "a.mp4", url: "blob:http://127.0.0.1:5210/x", path: "C:/m/a.mp4" },
    { id: "b", kind: "video", name: "b.mp4", url: "blob:http://127.0.0.1:5210/y" },
  ]);
  assert.equal(media[0].url, "/@media/a.mp4");
  assert.equal(media[1].url, "");
  assert.equal(media[1].name, "(缺失) b.mp4");
  assert.deepEqual(missing.map((m) => m.id), ["b"]);
});

test("没 path 的裸文件名标缺失;反复打开不会叠「(缺失)」", () => {
  const once = restoreMediaUrls([{ id: "c", kind: "image", name: "c.jpg", url: "c.jpg" }]).media;
  const twice = restoreMediaUrls([{ ...once[0], url: "c.jpg" }]).media;
  assert.equal(once[0].name, "(缺失) c.jpg");
  assert.equal(twice[0].name, "(缺失) c.jpg");
});

test("本来就能用的地址原样保留;空 url 不算缺失;不改入参", () => {
  const input = [
    { id: "1", kind: "video", name: "1", url: "/@media/x.mp4" },
    { id: "2", kind: "video", name: "2", url: "https://example.com/v.mp4" },
    { id: "3", kind: "image", name: "3", url: "data:image/png;base64,AA==" },
    { id: "4", kind: "video", name: "4", url: "" },
  ];
  const snapshot = JSON.stringify(input);
  const { media, missing } = restoreMediaUrls(input);
  assert.deepEqual(media.map((m) => m.url), input.map((m) => m.url));
  assert.deepEqual(missing, []);
  assert.equal(JSON.stringify(input), snapshot);
});

test("「· 声音」派生素材带着源文件的 path,一样按 path 找回", () => {
  const src = "山田豊 [BV1r64y1q7uB].m4a";
  const { media } = restoreMediaUrls([
    { id: "s", kind: "audio", name: "山田豊 · 声音", url: src, path: `C:\\m\\${src}`, soundOf: "v" },
  ]);
  assert.equal(media[0].url, `/@media/${encodeURIComponent(src)}`);
});
