import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypingSchedule, typingTextAt, typingScheduleOptionsFromParams } from './typingEvents.ts';

test('typing default ASCII boundaries preserve the original interval baseline', () => {
  const text = 'Hello, world!';
  for (const duration of [0, 0.1, 70, 120, 333.3]) {
    const s = createTypingSchedule({ text, duration });
    for (const elapsed of [0, 0.01, 50, 120, 240, 500, 2000, 5000]) {
      const expected = duration === 0 ? text : text.substring(0, Math.floor(elapsed / duration));
      assert.equal(typingTextAt(s, elapsed), expected, `${duration}ms @ ${elapsed}`);
    }
    assert.equal(s.settleMs, text.length * duration);
  }
});

test('typing extended graphemes keep CJK, combining marks, emoji and CRLF intact', () => {
  const parts = ['中', '文', '，', '👩🏽‍💻', 'e\u0301', '🇨🇳', ' ', '\r\n', '尾'];
  const s = createTypingSchedule({ text: parts.join(''), duration: 10 });
  assert.deepEqual(s.events.map(e => e.grapheme), parts);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(typingTextAt(s, (i + 1) * 10), parts.slice(0, i + 1).join(''));
    assert.equal(typingTextAt(s, (i + 1) * 10 - 0.001), parts.slice(0, i).join(''));
  }
  assert.deepEqual(s.events.map(e => e.sound), [true,true,true,true,true,true,false,false,true]);
});

test('typing pauses, seed and sound policies share a deterministic source', () => {
  const options = { text: 'a, \nb', duration: 100, delayMs: 50, punctuationPauseMs: 200, newlinePauseMs: 300, pauses: [{ afterIndex: 0, durationMs: 70 }] };
  const s = createTypingSchedule(options);
  assert.deepEqual(s.events.map(e => e.atMs), [150,320,620,720,1120]);
  const jittered = createTypingSchedule({...options,jitterMs:30,seed:77});
  assert.deepEqual(createTypingSchedule({...options,jitterMs:30,seed:77}),jittered);
  assert.notDeepEqual(createTypingSchedule({...options,jitterMs:30,seed:78}).events,jittered.events);
  assert.equal(typingTextAt(jittered,-1),'');
  assert.equal(typingTextAt(jittered,Infinity),options.text);
  assert.deepEqual(createTypingSchedule({text:', \n', punctuationSound:false,whitespaceSound:true}).events.map(e=>e.sound),[false,true,true]);
  assert.deepEqual(typingScheduleOptionsFromParams({text:'hi',duration:50,punctuationSound:'off',whitespaceSound:'on'}), {
    text:'hi',duration:50,delayMs:undefined,punctuationPauseMs:undefined,newlinePauseMs:undefined,jitterMs:undefined,seed:undefined,punctuationSound:false,whitespaceSound:true,
  });
});

test('typing rejects resource excess and malformed timing instead of truncating', () => {
  for (const options of [{text:'a'.repeat(10001)}, {text:'a',duration:NaN}, {text:'a',duration:-1}, {text:'a',duration:1,jitterMs:2}, {text:'a',seed:1.5}, {text:'a',pauses:[{afterIndex:1,durationMs:2}]}]) assert.throws(()=>createTypingSchedule(options));
  assert.throws(()=>typingScheduleOptionsFromParams({text:'a',duration:'120'}),/number/);
});
