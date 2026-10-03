import '../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('shared tabs update immediately, stale HTTP cannot revive invalidity, bounded poll recovers other editor state', async () => {
  const saved = { fetch:globalThis.fetch, window:globalThis.window };
  const timers=[];let timerId=0;let revision='initial';let state='normal';let staleResolve;let delayNext=false;
  const auth=()=>({loggedIn:state==='normal',authGeneration:revision,...(state==='invalid'?{status:'invalid',reason:'token_revoked'}:{})});
  globalThis.window={setTimeout:fn=>{timers.push(fn);return ++timerId;},clearTimeout(){}};
  globalThis.fetch=async url=>{
    if(url.includes('auth-state')) return Response.json({codex:{revision,state}});
    const snapshot={providers:[{id:'codex',available:true,label:'Codex',auth:auth()}]};
    if(delayNext) {delayNext=false;await new Promise(r=>staleResolve=r);}
    return Response.json(snapshot);
  };
  const tick=()=>new Promise(r=>setImmediate(r));
  try {
    const mod=await import('./providerState.ts');const left=[],right=[];
    const unsubscribeA=mod.subscribeProviders(p=>left.push(p));const unsubscribeB=mod.subscribeProviders(p=>right.push(p));
    try {
      await mod.refreshProviders();await tick();assert.equal(left.at(-1)[0].auth.loggedIn,true);
      delayNext=true;const stale=mod.refreshProviders();await tick();state='invalid';revision='revoked';
      mod.reportAuthFailure({type:'error',message:'请重新登录',authProvider:'codex',authReason:'token_revoked',authGeneration:revision});
      assert.equal(left.at(-1)[0].auth.status,'invalid');assert.equal(right.at(-1)[0].auth.status,'invalid');
      await tick();staleResolve();await stale;assert.equal(left.at(-1)[0].auth.status,'invalid');
      state='normal';revision='new-login';await timers.shift()();await tick();
      assert.equal(left.at(-1)[0].auth.loggedIn,true);assert.equal(right.at(-1)[0].auth.authGeneration,'new-login');
    } finally{unsubscribeA();unsubscribeB();}
  } finally {globalThis.fetch=saved.fetch;globalThis.window=saved.window;}
});
