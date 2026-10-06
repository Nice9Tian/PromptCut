import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
test('mu-typing uses shared grapheme times for direct seek, crop and optional pauses while remaining silent',async()=>{
  const vite=await createServer({root,configFile:false,logLevel:'error',server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  try {
    const {typingAnimationCard:card}=await vite.ssrLoadModule('/src/cards/magicui/typing-animation.card.tsx');
    assert.equal(card.audio,undefined);
    assert.deepEqual(card.defaults,{text:'这是一段打字机测试文字',duration:120});
    const view=(params,t,sourceOffset=0)=>renderToStaticMarkup(createElement(card.Component,{params:{...card.defaults,...params},playToken:0,t,sourceOffset}));
    const text=markup=>markup.match(/<h1[^>]*>(.*?)<\/h1>/su)?.[1];
    assert.equal(text(view({text:'ABC'},0)),'');
    assert.equal(text(view({text:'ABC'},.12)),'A');
    assert.equal(text(view({text:'ABC'},.24)),'AB');
    assert.equal(text(view({text:'ABC'},0,.24)),'AB');
    assert.equal(text(view({text:'ABC'},.12,.24)),'ABC');
    const params={text:'中👩🏽‍💻，末',duration:100,punctuationPauseMs:200};
    assert.equal(text(view(params,.2)),'中👩🏽‍💻');
    assert.equal(text(view(params,.5)),'中👩🏽‍💻，');
    assert.equal(text(view(params,.6)),'中👩🏽‍💻，末');
    assert.equal(card.timing(params).settleMs,600);
    assert.equal(card.timing({text:'👩🏽‍💻',duration:120}).settleMs,120);
  } finally {await vite.close();}
});
