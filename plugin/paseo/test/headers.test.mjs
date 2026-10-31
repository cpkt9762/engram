import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceSync,headerPresentation,stopWarning} from '../shared/sync-model.ts';
import {workspaceHeaders} from '../shared/headers.ts';
const ok=data=>({ok:true,data}),binding={project:'p',instance_id:'a'};
const enrolled=(patch={})=>({...binding,enrolled:false,cloud_configured:true,autosync_enabled:true,...patch});
const page={items:[],complete:true,next_cursor:'',scan_token:'scan'};
function setup(extra={}){
 let joined=false;const calls={status:0,health:0,join:0,stop:0};
 const api={syncStatus:async()=>ok({blocked_projects:[]}),resolve:async()=>ok({project:'p',available_projects:null}),health:async()=>{calls.health++;return ok({instance_id:'a',capabilities:{'sync-admin-v2':true}});},status:async()=>{calls.status++;return ok(enrolled({enrolled:joined}));},scan:async()=>ok(page),join:async()=>{calls.join++;joined=true;return ok(enrolled({enrolled:true}));},stop:async()=>{calls.stop++;joined=false;return ok(enrolled());},deletePrompt:async()=>ok({status:'deleted'}),...extra};
 return {api,calls,model:workspaceSync(api)};
}
test('button states include ambiguity, unavailable, old version, unconfigured and joined',()=>{
 const ready=(patch={},v2=true)=>({kind:'ready',enrollment:enrolled(patch),v2});
 for(const [state,label] of [[{kind:'choose',choices:['p','q']},'engram：选择项目'],[{kind:'error',error:{kind:'unavailable'}},'engram：服务不可用'],[{kind:'error',error:{kind:'unsupported'}},'engram：版本太旧'],[ready({cloud_configured:false}),'engram：未配置云同步'],[ready(),'加入同步'],[ready({enrolled:true}),'已同步'],[ready({},false),'engram：版本太旧'],[ready({enrolled:true},false),'已同步']])assert.equal(headerPresentation(state).label,label);
 assert.match(stopWarning('project-name','host-name'),/project-name.*host-name/);assert.match(stopWarning('p','h'),/已上传并确认.*不会自动补推/);
});
test('same-project reads and join/stop requests coalesce across workspaces and panel',async()=>{
 const {model,calls}=setup();model.set('one','/a');model.set('two','/b');
 await Promise.all([model.refresh('one'),model.refresh('two')]);assert.equal(calls.status,1);assert.equal(calls.health,1);
 await Promise.all([model.begin(binding),model.begin(binding)]);assert.equal(calls.join,1);
 await Promise.all([model.stop(binding),model.stop(binding)]);assert.equal(calls.stop,1);
 assert.equal(model.snapshot('one').enrollment.enrolled,false);assert.equal(model.snapshot('two').enrollment.enrolled,false);model.dispose();
});
test('stop timeout checks status without replay, and instance/version changes reject writes',async()=>{
 let stopped=false,writes=0;
 const {model}=setup({stop:async()=>{writes++;stopped=true;return {ok:false,error:{kind:'outcome_unknown',code:'response_lost',message:'unknown'}};},status:async()=>ok(enrolled({enrolled:!stopped}))});
 await model.stop(binding);assert.equal(writes,1);assert.equal(model.action(binding).stopUnknown,false);assert.match(model.action(binding).message,/已停止上传/);model.dispose();
 const pending=setup({stop:async()=>{writes++;return {ok:false,error:{kind:'outcome_unknown',code:'timeout',message:'unknown'}};},status:async()=>ok(enrolled({enrolled:true}))});await pending.model.stop(binding);assert.equal(pending.model.action(binding).stopUnknown,true);await pending.model.stop(binding);assert.equal(writes,2);pending.model.dispose();
 const swapped=setup({status:async()=>ok(enrolled({instance_id:'b',enrolled:true}))});assert.equal((await swapped.model.stop(binding)).error.code,'instance_mismatch');assert.equal(swapped.calls.stop,0);swapped.model.dispose();
 const old=setup({health:async()=>ok({instance_id:'a',capabilities:{'sync-admin-v1':true}})});assert.equal((await old.model.stop(binding)).error.kind,'unsupported');assert.equal(old.calls.stop,0);old.model.dispose();
});
test('workspace registry updates without closing the same popover; removal prevents polling',async()=>{
 const {model}=setup();const handles=new Map(),patches=[];
 const registry=workspaceHeaders(model,{describe:(_id,state)=>({label:headerPresentation(state).label,behavior:{kind:'popover'}}),add:(id,button)=>{const handle={removed:false,update:patch=>patches.push(patch),remove:()=>{handle.removed=true;}};handles.set(id,handle);return handle;}});
 registry.snapshot([{id:'one',directory:'/a'},{id:'two',directory:'/b'}]);await registry.poll();assert.equal(handles.size,2);
 patches.length=0;await registry.poll();assert.ok(patches.length>0);assert.ok(patches.every(patch=>!('behavior' in patch)));
 registry.remove('one');assert.equal(handles.get('one').removed,true);assert.deepEqual(model.ids(),['two']);registry.dispose();assert.equal(handles.get('two').removed,true);model.dispose();
});
test('ambiguous choices persist and cleanup prevents late mutations or late workspace reads',async()=>{
 const choice=setup({resolve:async()=>ok({project:'',available_projects:['p','q']})});choice.model.set('one','/x');await choice.model.refresh('one');assert.equal(choice.model.snapshot('one').kind,'choose');choice.model.select('one','p');await choice.model.refresh('one');assert.equal(choice.model.snapshot('one').kind,'ready');choice.model.dispose();
 let finish;const late=setup({resolve:()=>new Promise(resolve=>{finish=resolve;})});late.model.set('one','/a');const refresh=late.model.refresh('one');late.model.remove('one');finish(ok({project:'p',available_projects:null}));await refresh;assert.equal(late.calls.status,0);late.model.dispose();await late.model.begin(binding);assert.equal(late.calls.join,0);
});

test('panel operations update shared enrollment even if no workspace subscription is available',async()=>{
 const {model}=setup();await model.project('p');await model.begin(binding);assert.equal(model.projectSnapshot('p').enrollment.enrolled,true);await model.stop(binding);assert.equal(model.projectSnapshot('p').enrollment.enrolled,false);model.dispose();
});

test('a read started during a join cannot overwrite the state after the write',async()=>{
 let reads=0,finishOld,stale,model;
 const ports=setup({status:async()=>{reads++;if(reads===2)return new Promise(resolve=>{finishOld=resolve;});return ok(enrolled({enrolled:reads>2}));},join:async()=>{stale=model.project('p');return ok(enrolled({enrolled:true}));}});
 model=ports.model;await model.begin(binding);finishOld(ok(enrolled()));await stale;assert.equal(model.projectSnapshot('p').enrollment.enrolled,true);model.dispose();
});

test('preflight checks keep all mutation controls busy until they finish',async()=>{
 for(const operation of ['begin','stop']){
  let finish;const value=setup({status:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=value.model[operation](binding);assert.equal(value.model.action(binding).checking,true);
  finish({ok:false,error:{kind:'unavailable',code:'down',message:'down'}});await pending;
  assert.equal(value.model.action(binding).checking,false);assert.equal(value.calls.join,0);assert.equal(value.calls.stop,0);value.model.dispose();
 }
});


test('an enrolled denied project is blocked in header and panel, then clears on recovery',async()=>{
 let blocked=true;
 const value=setup({status:async()=>ok(enrolled({enrolled:true})),syncStatus:async()=>ok({blocked_projects:blocked?[{project:'p',code:'project_not_allowed',last_seen_at:'2026-10-27T00:00:00Z'}]:[]})});
 value.model.set('one','/p');await value.model.refresh('one');assert.equal(headerPresentation(value.model.snapshot('one')).label,'云端未放行');assert.equal(value.model.projectSnapshot('p').blocked,true);
 blocked=false;await value.model.refresh('one');assert.equal(headerPresentation(value.model.snapshot('one')).label,'已同步');value.model.dispose();
});
