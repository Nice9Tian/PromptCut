/**
 * agy 的内建工具被拒之后,这一轮该怎么收。
 *
 * 跑法 —— **必须带这个 flag**:
 *   node --experimental-test-module-mocks --test server/test/agy-denied.test.mjs
 *
 * 钉的是用户报的那个现象:一串工具调用之后毫无征兆地结束,没有回复也没有报错。
 * 起因是 agy 在无人值守模式下把自己的 run_command 自动拒掉(它没法弹窗征求同意),
 * 然后放弃整轮 —— result 里 denied_actions 有值、response 是空的,但 status 不是 ERROR。
 * 原来这里只发一条 status 就照常 finish('done'),于是界面上看起来像正常结束了。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import * as realChildProcess from 'node:child_process';

/** 这一轮要让假的 agy 回什么 result */
let nextResult = null;
/** stdout 上先喂哪些事件行(模拟工具调用等) */
let preEvents = [];

mock.module('node:child_process', { exports: { ...realChildProcess, spawn: () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.stdin = new Writable({ write(_c, _e, done) { done(); } });
  child.stdin.on('finish', () => {
    for (const ev of preEvents) child.stdout.write(JSON.stringify(ev) + '\n');
    child.stdout.write(JSON.stringify({ event: 'result', result: nextResult }) + '\n');
    queueMicrotask(() => child.emit('close', 0));
  });
  return child;
} } });

const { startRun } = await import('../runners/agy.mjs');

async function run(result, pre = []) {
  nextResult = result;
  preEvents = pre;
  const events = [];
  const r = startRun({
    provider: 'agy', cwd: 'C:\\tmp', onEvent: (e) => events.push(e),
    systemPrompt: 's', prompt: 'p',
  });
  await r.done;
  return events;
}

test('被拒 + 什么都没产出:报错误,不许报成功', async () => {
  const events = await run({
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: '',
    denied_actions: [{ display_name: 'RunCommand', action: 'run_command' }],
  });
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, '该有 error 事件 —— 这一轮实际上什么都没做成');
  assert.equal(events.find((e) => e.type === 'done'), undefined, '不该同时报 done');
  assert.match(err.message, /RunCommand/, '要说清是哪个动作被拒的');
  assert.match(err.message, /wait/, '要告诉用户现在有 wait 工具可用,不然他不知道下一步做什么');
});

test('被拒但**有**产出:照常收尾,只提一句 —— 那一轮的成果不能因为一次被拒就作废', async () => {
  const events = await run({
    conversation_id: 'c1',
    status: 'SUCCESS',
    response: '我已经把素材放进时间轴了。',
    denied_actions: [{ display_name: 'RunCommand', action: 'run_command' }],
  });
  assert.ok(events.some((e) => e.type === 'done'), '有产出就该正常结束');
  assert.equal(events.find((e) => e.type === 'error'), undefined);
  assert.ok(
    events.some((e) => e.type === 'status' && /部分动作被拒绝/.test(e.text)),
    '仍然要提醒有动作被拒',
  );
});

test('没有被拒的动作时,一切照旧', async () => {
  const events = await run({ conversation_id: 'c1', status: 'SUCCESS', response: '好的' });
  assert.ok(events.some((e) => e.type === 'done'));
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});

test('response 空但流里已经说过话:算有产出,不报错', async () => {
  const events = await run(
    {
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: '',
      denied_actions: [{ display_name: 'RunCommand' }],
    },
    [{ event: 'step_update', step_update: { step_type: 'text', text_delta: '我先看看素材。' } }],
  );
  assert.ok(events.some((e) => e.type === 'done'), '流里已经有正文了,不该判成空轮');
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});
