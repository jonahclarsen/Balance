import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedBy, effectiveStatus } from './policy.js'
const target={id:'yt',kind:'domain',value:'youtube.com',category:'entertainment'}
const fixture=()=>({version:1,enabled:true,refreshAt:Date.now()+100000,modes:[{id:'dolo',name:'Dolo',active:true,targets:[target],allTargets:[target]}]})
test('domain matching prevents suffix bypasses without blocking unrelated domains',()=>{
 const d=fixture();assert.deepEqual(blockedBy(d,'https://www.youtube.com/watch?v=private'),[{mode:'dolo',name:'Dolo',target:'yt'}])
 for(const url of ['https://notyoutube.com/','https://youtube.com.evil.test/','https://example.com/?url=youtube.com','file:///youtube.com']) assert.deepEqual(blockedBy(d,url),[])
})
test('a stale unlocked snapshot restores targets instead of extending a pass',()=>{
 const d=fixture();d.modes[0].targets=[];d.modes[0].active=false;d.refreshAt=1
 assert.equal(effectiveStatus(d).aiBlocked,true);assert.equal(blockedBy(d,'https://youtube.com').length,1)
})
test('a chosen Discord channel blocks only its threads',()=>{
 const d=fixture();d.modes[0].targets=d.modes[0].allTargets=[{id:'frank',kind:'discord',value:'456',category:'ai'}]
 assert.deepEqual(blockedBy(d,'https://discord.com/channels/123/456/threads/789'),[{mode:'dolo',name:'Dolo',target:''}])
 for(const url of ['https://discord.com/channels/123/456','https://discord.com/channels/123/456/789','https://discord.com/channels/123/999/threads/789','https://discord.com.evil.test/channels/123/456/threads/789']) assert.deepEqual(blockedBy(d,url),[])
 d.refreshAt=1;assert.equal(blockedBy(d,'https://discord.com/channels/123/456/threads/789').length,1)
})

test('Frank IDs gate only touch-grass conversations, including stale passes', () => {
  const now=Date.now();
  const status={version:1,enabled:true,refreshAt:now+60000,frankThreads:['123456789012345678'],modes:[{id:'touch-grass',name:'Touch grass',active:true,targets:[],allTargets:[]}]};
  const url='https://discord.com/channels/999999999999999999/123456789012345678';
  assert.equal(blockedBy(status,url).length,1);
  assert.equal(blockedBy(status,'https://discord.com/channels/999999999999999999/222222222222222222').length,0);
  status.modes[0].active=false;assert.equal(blockedBy(status,url).length,0);
  status.refreshAt=now-1;assert.equal(blockedBy(status,url).length,1);
});
