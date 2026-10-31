import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrollmentFlow } from '../shared/enrollment.ts';
import { fakeSecret } from './helpers.mjs';
const binding={project:'p',instance_id:'a'};
const enrollment=(overrides={})=>({ok:true,data:{...binding,enrolled:false,cloud_configured:true,autosync_enabled:true,...overrides}});
const page=(items=[],token='t')=>({ok:true,data:{items,complete:true,next_cursor:'',scan_token:token}});
const bad=(kind,code)=>({ok:false,error:{kind,code,message:code}});
const suspect={id:1,created_at:'now',session_id:'s',reason:'credential assignment',masked_context:'密码是 [已遮蔽]'};
function fixture(overrides={}){const calls=[];const states=[];const api={scan:async()=>page(),join:async a=>{calls.push(a);return enrollment({enrolled:true});},status:async()=>enrollment(),deletePrompt:async()=>({ok:true,data:{status:'deleted'}}),...overrides};const flow=enrollmentFlow(binding,api,s=>states.push(s));return {flow,calls,states};}

test('enrollment: empty scan joins with token; review supports force, delete/rescan, cancel and explicit rescanned join',async()=>{
 const empty=fixture();await empty.flow.begin();assert.equal(empty.flow.state.phase,'joined');assert.deepEqual(empty.calls,[{...binding,scan_token:'t'}]);assert.match(empty.flow.state.message,/本机已加入，等待同步/);
 const force=fixture({scan:async()=>page([suspect])});await force.flow.begin();assert.equal(force.flow.state.phase,'review');assert.equal(force.calls.length,0);await force.flow.force();assert.equal(force.calls[0].force,true);
 let deleted=false;const review=fixture({scan:async()=>page(deleted?[]:[suspect]),deletePrompt:async a=>{assert.deepEqual(a,{...binding,id:1});deleted=true;return {ok:true,data:{status:'deleted'}};}});
 await review.flow.begin();await review.flow.remove(1);assert.equal(review.flow.state.phase,'review');assert.equal(review.calls.length,0);await review.flow.begin(true);assert.equal(review.flow.state.phase,'joined');
 const cancel=fixture({scan:async()=>page([suspect])});await cancel.flow.begin();cancel.flow.cancel();assert.equal(cancel.flow.state.phase,'prompt');assert.equal(cancel.calls.length,0);
});
test('enrollment: stale scan reloads review without replay; unknown committed result confirms once',async()=>{
 let scans=0;const stale=fixture({scan:async()=>{scans++;return page([suspect],String(scans));},join:async()=>bad('http_error','scan_stale')});
 await stale.flow.begin(true);assert.equal(stale.flow.state.phase,'review');assert.equal(scans,2);assert.match(stale.flow.state.message,/scan_stale/);
 let writes=0,checks=0;const unknown=fixture({join:async()=>{writes++;return bad('outcome_unknown','response_lost');},status:async()=>{checks++;return enrollment({enrolled:true});}});
 await unknown.flow.begin();assert.equal(unknown.flow.state.phase,'joined');assert.equal(writes,1);assert.equal(checks,1);assert.ok(unknown.states.some(s=>s.phase==='pending_confirm'));
 const pending=fixture({join:async()=>bad('outcome_unknown','timeout'),status:async()=>enrollment()});await pending.flow.begin();assert.equal(pending.flow.state.phase,'pending_confirm');
 const swapped=fixture({join:async()=>bad('outcome_unknown','timeout'),status:async()=>enrollment({instance_id:'b',enrolled:true})});await swapped.flow.begin();assert.equal(swapped.flow.state.phase,'error');assert.match(swapped.flow.state.message,/instance_mismatch/);
});
test('enrollment: duplicate actions coalesce and disposal discards late callbacks',async()=>{
 let finish;const late=fixture({scan:()=>new Promise(r=>{finish=r;})});const first=late.flow.begin();await late.flow.begin();late.flow.dispose();finish(page());await first;assert.equal(late.calls.length,0);assert.ok(!JSON.stringify(late.states).includes(fakeSecret));
});

test('unknown write remains pending if confirmation RPC itself rejects',async()=>{
 const pending=fixture({join:async()=>bad('outcome_unknown','timeout'),status:async()=>{throw new Error('connection lost');}});
 await pending.flow.begin();assert.equal(pending.flow.state.phase,'pending_confirm');
});


test('lost HTTP acknowledgement confirms committed enrollment through RPC without replay',async t=>{
 const {fakeServer,json,guardNetwork}=await import('./helpers.mjs');
 const {EngramClient}=await import('../server/engram.ts');const {handle}=await import('../server/handlers.ts');
 guardNetwork(t);let joined=false,writes=0;
 const {url}=await fakeServer(t,(req,res)=>{
   if(req.url==='/health')return json(res,{instance_id:'a',capabilities:{'sync-admin-v1':true,'sync-admin-v2':true}});
   if(req.url.startsWith('/prompts/secret-scan'))return json(res,page().data);
   if(req.url==='/sync/enrollment' && req.method==='POST'){req.resume();req.on('end',()=>{joined=true;writes++;res.destroy();});return;}
   if(req.url.startsWith('/sync/enrollment'))return json(res,enrollment({enrolled:joined}).data);
 });
 const client=new EngramClient(url,'',1000);
 const flow=enrollmentFlow(binding,{scan:args=>handle('scan',args,client),join:args=>handle('join',args,client),status:args=>handle('enrollment',args,client),deletePrompt:args=>handle('deletePrompt',args,client)},()=>{});
 await flow.begin();assert.equal(flow.state.phase,'joined');assert.equal(writes,1);
});
