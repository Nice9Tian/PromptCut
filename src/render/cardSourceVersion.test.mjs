import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSourceVersion } from './cardSourceVersion.mjs';

test('card source version follows only its static relative dependency closure', () => {
  const files = {
    '/src/cards/a.tsx': "export const a={id:'a'}; import { helper } from './helper'; import './a.css';",
    '/src/cards/helper.ts': 'export const helper=1;', '/src/cards/a.css': '.a{color:red}',
    '/src/cards/b.tsx': "export const b={id:'b'};", '/src/cards/unrelated.ts': 'export const x=1;',
  };
  const card = { id: 'a', defaults: {}, controls: [] };
  const before = cardSourceVersion(card, files);
  files['/src/cards/unrelated.ts'] = 'export const x=2;';
  assert.equal(cardSourceVersion(card, files), before);
  files['/src/cards/helper.ts'] = 'export const helper=2;';
  assert.notEqual(cardSourceVersion(card, files), before);
});
