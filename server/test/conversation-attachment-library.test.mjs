/** 云端对话消息里的附件引用:页面发送时放进素材库的那一条(`library`)或放不进去的原因(`libraryError`),只核形状(2026-10-18 用户定) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentKeysOK } from '../account/conversation-authority.mjs';

const base = { name: 'a.jpg', size: 10, url: 'work:attachments/a.jpg' };

test('原来的三项照旧收', () => {
  assert.equal(attachmentKeysOK(base), true);
  assert.equal(attachmentKeysOK({ name: 'a.jpg', size: 10 }), false, '缺一项不收');
});

test('library:mediaId + /@media/ 地址才收;多字段、乱写的地址不收', () => {
  assert.equal(attachmentKeysOK({ ...base, library: { mediaId: 'm-abc_1', url: '/@media/abc.jpg' } }), true);
  for (const library of [null, [], 'x', { mediaId: 'm' }, { mediaId: 'm', url: '/@media/x', extra: 1 },
    { mediaId: 'bad id', url: '/@media/x' }, { mediaId: 'm', url: 'https://evil/x' }, { mediaId: 'm', url: '/@media/a b' }])
    assert.equal(attachmentKeysOK({ ...base, library }), false, JSON.stringify(library));
});

test('libraryError:一行、不超过 200 字才收;library 和 libraryError 不能同时有;别的字段不收', () => {
  assert.equal(attachmentKeysOK({ ...base, libraryError: '上传超时' }), true);
  assert.equal(attachmentKeysOK({ ...base, libraryError: '' }), false);
  assert.equal(attachmentKeysOK({ ...base, libraryError: 'a\nb' }), false);
  assert.equal(attachmentKeysOK({ ...base, libraryError: 'x'.repeat(201) }), false);
  assert.equal(attachmentKeysOK({ ...base, library: { mediaId: 'm', url: '/@media/x' }, libraryError: 'y' }), false);
  assert.equal(attachmentKeysOK({ ...base, path: '/etc/passwd' }), false);
});
