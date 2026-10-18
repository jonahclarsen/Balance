import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedBy, effectiveStatus } from './policy.js'
const target={id:'yt',kind:'domain',value:'youtube.com',category:'entertainment'}
const fixture=()=>({version:1,enabled:true,refreshAt:Date.now()+100000,modes:[{id:'dolo',name:'Dolo',active:true,targets:[target],allTargets:[target]}]})
test('domain matching prevents suffix bypasses without blocking unrelated domains',()=>{
 const d=fixture();assert.equal(blockedBy(d,'https://www.youtube.com/watch?v=private')[0].target,'yt')
 for(const url of ['https://notyoutube.com/','https://youtube.com.evil.test/','https://example.com/?url=youtube.com','file:///youtube.com']) assert.deepEqual(blockedBy(d,url),[])
})
test('a stale unlocked snapshot restores targets instead of extending a pass',()=>{
 const d=fixture();d.modes[0].targets=[];d.modes[0].active=false;d.refreshAt=1
 assert.equal(effectiveStatus(d).aiBlocked,true);assert.equal(blockedBy(d,'https://youtube.com').length,1)
})
test('Discord rules block configured routes and preserve other conversations',()=>{
 const d=fixture();d.modes[0].targets=[{id:'frank',kind:'discord',value:'456',category:'ai'}]
 assert.equal(blockedBy(d,'https://discord.com/channels/123/456/789').length,1)
 assert.deepEqual(blockedBy(d,'https://discord.com/channels/123/999'),[])
 assert.deepEqual(blockedBy(d,'https://discord.com.evil.test/channels/123/456'),[])
})
