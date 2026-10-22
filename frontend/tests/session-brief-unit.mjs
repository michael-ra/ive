import {test} from 'node:test'
import assert from 'node:assert/strict'
import {presentText,messageText,briefEvidence,relativeActivity} from '../src/lib/sessionBrief.js'
test('unwraps known serialized envelopes but preserves ordinary JSON',()=>{
 assert.equal(messageText(JSON.stringify({role:'assistant',content:JSON.stringify([{type:'text',text:'A readable reply.'}])})),'A readable reply.')
 assert.equal(messageText('{"status":"ok"}'),'{"status":"ok"}')
 assert.equal(messageText([{type:'thinking',thinking:'internal'},{type:'text',text:'Visible'}]),'Visible')
})
test('sources collapse, fenced examples remain literal, quoted context preserved',()=>{
 const marker='<oai-mem-citation>\n<citation_entries>\nMEMORY.md:10-12|note=[context]\n</citation_entries>\n</oai-mem-citation>'
 const p=presentText('Ready.\n'+marker+'\n```xml\n'+marker+'\n```\nReferenced chat annotations:\nQuote: old task')
 assert.deepEqual(p.sources,['MEMORY.md:10-12']);assert.match(p.text,/```xml\n<oai-mem/);assert.equal(p.context,'Quote: old task');assert.match(p.text,/^Ready\./)
 assert.equal(presentText('Hi <oai-mem-citation>unfinished').text,'Hi')
})
test('results use current turn and matched tool results, not claims',()=>{
 const messages=[{role:'assistant',content:'Old tests passed.'},{role:'user',content:'New task'},
 {role:'assistant',content:[{type:'tool_use',id:'t',name:'Bash',input:{command:'npm test'}},{type:'tool_use',id:'m',name:'mcp__worker-board__post_message',input:{}}]},
 {id:'r',role:'tool',content:[{type:'tool_result',tool_use_id:'t',is_error:true,content:'failed'},{type:'tool_result',tool_use_id:'m',is_error:true,content:'error'}]}]
 const result=briefEvidence(messages);assert.equal(result.latest,undefined);assert.equal(result.checks.length,1);assert.equal(result.checks[0].failed,true);assert.deepEqual(result.collaboration,[])
 messages.push({id:'success',role:'tool',content:[{type:'tool_result',tool_use_id:'m',content:'sent'}]})
 assert.equal(briefEvidence(messages).collaboration[0].label,'Project message sent')
})
test('activity handles server timestamps and absent dates',()=>{
 assert.equal(relativeActivity({last_active_at:'2026-10-15 10:00:00'},Date.parse('2026-10-15T10:05:00Z')),'5m ago');assert.equal(relativeActivity({}),'')
})
