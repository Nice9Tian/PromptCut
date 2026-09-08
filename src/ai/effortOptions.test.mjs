/**
 * node --test src/ai/effortOptions.test.mjs
 *
 * 思考档位清单必须和上游认的值一致。
 *
 * 来自一份用户诊断报告:他从 codex 的下拉框里选了 `minimal`,请求直接 400 ——
 *   Unsupported value: 'minimal' is not supported with the 'gpt-5.6-terra' model.
 *   Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.
 * 两头都错了:`minimal` 我们给了、上游不认;`none` 和 `max` 上游认、我们没给。
 * 摆一个必然 400 的选项在菜单里,用户不可能猜到是我们的错 —— 所以这条要有守门人。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CAPABILITIES, EFFORT_LABEL } = await import('./modelOptions.ts');

/** codex 上游在 400 里逐字列出来的那一串 */
const CODEX_UPSTREAM = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

test('codex 的档位是上游那一串的子集,一个多余的都不能有', () => {
  const offered = CAPABILITIES.codex.efforts.filter(Boolean);
  const extra = offered.filter((e) => !CODEX_UPSTREAM.includes(e));
  assert.deepEqual(extra, [], `这些档位上游不认,选中就是 400:${extra.join(', ')}`);
});

test('codex:minimal 一定不在清单里(它就是那次 400 的元凶)', () => {
  assert.ok(!CAPABILITIES.codex.efforts.includes('minimal'));
});

test('codex:上游认的 none 和 max 要给出来 —— 少给等于白丢档位', () => {
  for (const e of ['none', 'max']) {
    assert.ok(CAPABILITIES.codex.efforts.includes(e), `${e} 上游支持,清单里却没有`);
  }
});

test('每一档都要有中文标签,否则下拉框里是空白项', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    for (const e of cap.efforts) {
      assert.ok(EFFORT_LABEL[e] !== undefined, `${provider} 的档位 ${JSON.stringify(e)} 没有标签`);
    }
  }
});

test('每家的清单都带空串 —— 用户要能选回「默认」', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    if (cap.efforts.length === 0) continue; // 一档都不支持的驱动(界面上整个灰掉)
    assert.ok(cap.efforts.includes(''), `${provider} 的清单里没有「默认」`);
  }
});

test('minimal 没有任何驱动再提供它', () => {
  for (const [provider, cap] of Object.entries(CAPABILITIES)) {
    assert.ok(!cap.efforts.includes('minimal'), `${provider} 又把 minimal 加回来了`);
  }
});

/*
 * api 那一档单独说一句:它走 OpenAI 兼容口径的 `reasoning_effort`,
 * 上游只认 low / medium / high(见 openlux 文档),CLI 的扩展档位一个都不能给。
 */
test('api:只给 OpenAI 兼容口径认的三档', () => {
  assert.deepEqual(CAPABILITIES.api.efforts.filter(Boolean).sort(), ['high', 'low', 'medium']);
});
