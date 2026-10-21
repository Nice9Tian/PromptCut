import test from 'node:test';
import assert from 'node:assert/strict';
import { lastRunState } from '../account/conversation-authority.mjs';

// 出错留痕:历史列表上要能标「出错」「已中断」。最近一轮文档服务签的终态是失败或中断,列表行才带 state。
const msg = (arrivalSeq, status, extra = {}) => ({ messageId: `m${arrivalSeq}`, arrivalSeq, ...(status ? { terminalOutcome: { v: 1, status, ...extra } } : {}) });

test('最近一轮失败 → failed;中断 → interrupted;完成、取消、没有终态 → 不带', () => {
  assert.equal(lastRunState({ currentRunId: null, messages: [msg(1, 'done'), msg(2, 'failed')] }), 'failed');
  assert.equal(lastRunState({ currentRunId: null, messages: [msg(1, 'interrupted', { reason: 'agent-disabled' })] }), 'interrupted');
  assert.equal(lastRunState({ currentRunId: null, messages: [msg(1, 'done')] }), null);
  assert.equal(lastRunState({ currentRunId: null, messages: [msg(1, 'cancelled')] }), null);
  assert.equal(lastRunState({ currentRunId: null, messages: [msg(1, null)] }), null);
  assert.equal(lastRunState({ currentRunId: null, messages: [] }), null);
});

test('以 arrivalSeq 最大的有终态的那一轮为准,不看数组顺序;后面又成功了就不再标出错', () => {
  assert.equal(lastRunState({ currentRunId: null, messages: [msg(3, 'done'), msg(1, 'failed')] }), null);
  assert.equal(lastRunState({ currentRunId: null, messages: [msg(3, 'failed'), msg(1, 'done')] }), 'failed');
});

test('有一轮在跑时不标(列表显示进行中)', () => {
  assert.equal(lastRunState({ currentRunId: 'run_x', messages: [msg(1, 'failed')] }), null);
});
