import assert from 'node:assert/strict'
import {test} from 'node:test'
import {groupNotifications,affectedSessions,notificationDuration} from '../src/lib/notificationPresentation.js'
test('group identical hook recovery across sessions, keep every action separate',()=>{
 const notices=[{id:'1',reason:'codex_hooks_untrusted',sessionId:'a',timestamp:1},{id:'2',reason:'codex_hooks_untrusted',session_id:'b',timestamp:2},{id:'3',reason:'codex_hooks_untrusted',sessionId:'a',timestamp:3},{id:'u',action:{onClick:()=>{}},timestamp:4},{id:'v',action:{onClick:()=>{}},timestamp:5}]
 const groups=groupNotifications(notices)
 assert.equal(groups.length,3);assert.equal(groups[0].key,'v')
 assert.equal(groups[2].notices.length,3)
 assert.deepEqual(affectedSessions(groups[2].notices,{a:{id:'a'},b:{id:'b'}}),[{id:'a'},{id:'b'}])
})
test('recovery and action notices persist; ordinary feedback expires',()=>{
 for(const type of ['warning','error','auth_failed','permission','input_needed'])assert.equal(notificationDuration({type}),null)
 assert.equal(notificationDuration({type:'success',action:{}}),null)
 assert.equal(notificationDuration({type:'success'}),6000)
 assert.equal(notificationDuration({type:'info'}),10000)
 assert.equal(notificationDuration({type:'session_done'}),30000)
})
