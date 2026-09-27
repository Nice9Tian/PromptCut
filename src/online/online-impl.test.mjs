/**
 * 在线浏览器模式的几块纯逻辑（C10a 契约 `docs/plan/c10a-contract.md` 第 2、4 节；`c10a-web` 自测，编号 `ONL-…`）：
 * `/api` 守卫的判定、纯浏览器设备身份、邀请链接的读取与解析。
 * 契约测试（`C10A-…`）由 `c10a-tests` 分支独立写。
 *
 * 跑：node --test src/online/online-impl.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const G = await import("./apiGuard.ts");
const D = await import("./device.ts");
const I = await import("./invite.ts");

const CODE = "A".repeat(20) + "b_-" + "9".repeat(20); // 43 个 base64url 字符

test("ONL-1 /api 守卫的判定：同源 /api/ 与 base 下的 api/ 算，别的源、别的路径不算", () => {
  const href = "https://h.example/editor/";
  const base = "/editor/";
  assert.equal(G.apiPathOf("/api/stt/status", { href, base }), "/api/stt/status");
  assert.equal(G.apiPathOf("/api/media/local?hashes=a,b", { href, base }), "/api/media/local", "去掉查询串");
  assert.equal(G.apiPathOf("api/x", { href, base }), "/editor/api/x", "相对地址落在 base 下");
  assert.equal(G.apiPathOf("https://h.example/api/export", { href, base }), "/api/export");
  assert.equal(G.apiPathOf(new URL("https://h.example/api/a"), { href, base }), "/api/a");
  assert.equal(G.apiPathOf({ url: "https://h.example/api/b" }, { href, base }), "/api/b", "Request 形状");
  assert.equal(G.apiPathOf("https://h.example/media/api/asset/media/x", { href, base }), null, "素材服务在 /media/ 下，不拦");
  assert.equal(G.apiPathOf("https://other.example/api/x", { href, base }), null, "别的源不拦");
  assert.equal(G.apiPathOf("/hosted/shared/challenge", { href, base }), null);
  assert.equal(G.apiPathOf("/apix/y", { href, base }), null);
  assert.equal(G.apiPathOf(42, { href, base }), null);
});

test("ONL-2 设备身份：128 位随机 id、浏览器名 + 系统名 + 随机 4 位，存在页面本地、下次还是同一台", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let n = 0;
  const random = (b) => { for (let i = 0; i < b.length; i++) b[i] = (n += 37) & 255; return b; };
  const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
  const a = D.loadBrowserDevice({ storage, random, ua });
  assert.match(a.deviceId, /^[A-Za-z0-9_-]{22}$/, "16 字节 base64url");
  assert.match(a.deviceName, /^Chrome · Android · \d{4}$/);
  const b = D.loadBrowserDevice({ storage, random: () => { throw new Error("不该再生成"); }, ua });
  assert.deepEqual(b, a, "存在本地，下次不变");
  store.set(D.DEVICE_KEY, "{坏的");
  const c = D.loadBrowserDevice({ storage, random, ua });
  assert.notEqual(c.deviceId, a.deviceId, "坏了就重新生成");
  const noStore = D.loadBrowserDevice({ storage: null, random, ua });
  assert.match(noStore.deviceId, /^[A-Za-z0-9_-]{22}$/, "存不了也能用（只这一次）");
});

test("ONL-3 浏览器名与系统名：常见 UA 与 iPad 报桌面 UA", () => {
  const L = D.browserLabel;
  assert.deepEqual(L("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), { browser: "Safari", os: "iOS" });
  assert.deepEqual(L("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", null, 5), { browser: "Safari", os: "iPadOS" });
  assert.deepEqual(L("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", null, 0), { browser: "Safari", os: "macOS" });
  assert.deepEqual(L("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"), { browser: "Edge", os: "Windows" });
  assert.deepEqual(L("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0 Mobile Safari/537.36 MicroMessenger/8.0.49"), { browser: "微信", os: "Android" });
  assert.deepEqual(L("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), { browser: "Firefox", os: "Linux" });
  assert.deepEqual(L(""), { browser: "浏览器", os: "未知系统" });
});

test("ONL-4 读 #invite=：合格的放进内存并清掉片段；不合格的也清掉并记为坏链接；没有就不动", () => {
  const calls = [];
  const hist = { state: { k: 1 }, replaceState: (s, _t, url) => calls.push([s, url]) };
  I.captureInviteFromLocation({ hash: `#invite=${CODE}`, pathname: "/editor/", search: "" }, hist);
  assert.deepEqual(calls, [[{ k: 1 }, "/editor/"]], "片段清掉，路径与查询串保留");
  assert.deepEqual(I.peekCapturedInvite(), { code: CODE });
  assert.deepEqual(I.takeCapturedInvite(), { code: CODE });
  assert.equal(I.takeCapturedInvite(), null, "只给一次");

  I.captureInviteFromLocation({ hash: "#invite=short", pathname: "/editor/", search: "?x=1" }, hist);
  assert.deepEqual(calls.at(-1), [{ k: 1 }, "/editor/?x=1"]);
  assert.deepEqual(I.takeCapturedInvite(), { bad: true });

  const before = calls.length;
  I.captureInviteFromLocation({ hash: "#other=1", pathname: "/editor/", search: "" }, hist);
  assert.equal(calls.length, before, "没有 invite= 的片段不动");
  assert.equal(I.takeCapturedInvite(), null);
  assert.deepEqual(I.inviteFromHash(`#a=1&invite=${CODE}`), { code: CODE }, "与别的参数并列");
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}=`), { bad: true }, "带 = 填充的不认");
});

test("ONL-5 粘贴的邀请链接：取源与邀请码；格式不对回 null", () => {
  assert.deepEqual(I.parseInviteLink(`https://8-219-80-16.sslip.io/editor#invite=${CODE}`), { origin: "https://8-219-80-16.sslip.io", code: CODE });
  assert.deepEqual(I.parseInviteLink(`  来加入吧 http://127.0.0.1:5633/editor/#invite=${CODE} 点开就行`), { origin: "http://127.0.0.1:5633", code: CODE }, "夹在文字里");
  assert.equal(I.parseInviteLink("https://h.example/editor"), null, "没有邀请码");
  assert.equal(I.parseInviteLink(`https://h.example/editor?invite=${CODE}`), null, "查询串里的不认（邀请码只放片段）");
  assert.equal(I.parseInviteLink(`ftp://h.example/editor#invite=${CODE}`), null);
  assert.equal(I.parseInviteLink("随便一段字"), null);
  assert.equal(I.inviteLinkOf("https://h.example/", CODE), `https://h.example/editor#invite=${CODE}`);
});

test("ONL-6 托管端地址：文档服务在源下的 /hosted/，WebSocket 地址保留末尾斜杠", () => {
  assert.equal(I.hostedDocBaseOf("https://8-219-80-16.sslip.io"), "https://8-219-80-16.sslip.io/hosted/");
  assert.equal(I.hostedWsUrlOf("https://8-219-80-16.sslip.io/hosted/"), "wss://8-219-80-16.sslip.io/hosted/");
  assert.equal(I.hostedWsUrlOf("http://127.0.0.1:5633/hosted/"), "ws://127.0.0.1:5633/hosted/");
  assert.equal(I.hostedWsUrlOf("http://8.219.80.16:8787/"), "ws://8.219.80.16:8787/");
});
