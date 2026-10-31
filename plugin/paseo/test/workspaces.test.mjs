import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FetchWorkspacesRequestMessageSchema} from '@getpaseo/protocol/messages';
import {watchWorkspaces} from '../shared/watch-workspaces.ts';
const workspace=(id)=>({id,workspaceDirectory:`/tmp/${id}`,archivingAt:null});
const page=(entries,hasMore=false,nextCursor=null)=>({entries,pageInfo:{hasMore,nextCursor}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function validateWorkspaceOptions(options){
 if(options.includeBackground || options.filter?.includeBackground)throw new Error('Update the host to use background workspaces.');
 // Reuse the installed wire validator, including its structured Zod errors.
 FetchWorkspacesRequestMessageSchema.parse({type:'fetch_workspaces_request',requestId:'workspace-test',...options});
}
function registry(){const entries=new Map(),calls={poll:0};return {entries,calls,snapshot:rows=>{entries.clear();for(const row of rows)entries.set(row.id,row.directory);},upsert:(id,dir)=>entries.set(id,dir),remove:id=>entries.delete(id),poll:async()=>{calls.poll++;}};}
test('owned workspace snapshot, upserts/removes, poll and release are scoped to plugin lifetime',async()=>{
 let observer,tick,released=0,unsubscribed=0,timerStopped=0;const rows=registry();
 const subscription={release:async()=>{released++;},subscribe:value=>{observer=value;value.snapshot(page([workspace('a')]));return()=>{unsubscribed++;};}};
 const stop=watchWorkspaces({list:async options=>{validateWorkspaceOptions(options);assert.deepEqual(options.subscribe,{});return {...page([]),subscription};}},rows,assert.fail,fn=>{tick=fn;return()=>{timerStopped++;};});
 await settle();assert.equal(rows.entries.get('a'),'/tmp/a');observer.update({type:'workspace_update',payload:{kind:'upsert',workspace:workspace('b')}});observer.update({type:'workspace_update',payload:{kind:'remove',id:'a'}});assert.deepEqual([...rows.entries.keys()],['b']);tick();await settle();assert.equal(rows.calls.poll,1);
 await stop();observer.update({type:'workspace_update',payload:{kind:'upsert',workspace:workspace('late')}});assert.deepEqual([...rows.entries.keys()],['b']);assert.equal(released,1);assert.equal(unsubscribed,1);assert.equal(timerStopped,1);
});
test('paginated workspace inventory buffers live updates and retries page failure',async()=>{
 let observer,tick,fail=true;const rows=registry(),errors=[];
 const subscription={release:async()=>{},subscribe:value=>{observer=value;value.snapshot(page([workspace('a')],true,'next'));return()=>{};}};
 const stop=watchWorkspaces({list:async options=>{validateWorkspaceOptions(options);if(options.subscribe)return {...page([]),subscription};if(fail)throw new Error('fake page failure');return page([workspace('b')]);}},rows,code=>errors.push(code),fn=>{tick=fn;return()=>{};});
 await settle();assert.deepEqual(errors,['engram_workspace_snapshot_failed: fake page failure']);fail=false;tick();observer.update({type:'workspace_update',payload:{kind:'remove',id:'a'}});await settle();assert.deepEqual([...rows.entries.keys()],['b']);await stop();
});
test('workspace subscription and pagination work without the background workspaces feature',async()=>{
 const calls=[],errors=[],rows=registry();let observer,released=0;
 const subscription={release:async()=>{released++;},subscribe:value=>{observer=value;value.snapshot(page([workspace('a')],true,'second'));return()=>{};}};
 const stop=watchWorkspaces({list:async options=>{
  validateWorkspaceOptions(options);
  calls.push(options);return options.subscribe?{...page([]),subscription}:page([workspace('b')]);
 }},rows,message=>errors.push(message),()=>()=>{});
 await settle();await stop();
 assert.deepEqual(errors,[]);assert.ok(observer);assert.equal(released,1);
 assert.deepEqual([...rows.entries.keys()],['a','b']);
 assert.deepEqual(calls,[{subscribe:{},page:{limit:200}},{page:{limit:200,cursor:'second'}}]);
 for(const options of calls){assert.equal(Object.hasOwn(options,'includeBackground'),false);assert.equal(Object.hasOwn(options.filter??{},'includeBackground'),false);}
});
test('workspace protocol limit is enforced and more than 200 workspaces are fully paginated',async t=>{
 assert.throws(()=>validateWorkspaceOptions({page:{limit:1000}}),error=>{
  assert.equal(error.issues[0].origin,'number');assert.equal(error.issues[0].code,'too_big');
  assert.equal(error.issues[0].maximum,200);assert.equal(error.issues[0].inclusive,true);
  assert.deepEqual(error.issues[0].path,['page','limit']);return true;
 });
 const all=Array.from({length:451},(_,i)=>workspace(`workspace-${i}`)),requests=[],errors=[],rows=registry();
 const slice=offset=>page(all.slice(offset,offset+200),offset+200<all.length,offset+200<all.length?String(offset+200):null);
 const subscription={release:async()=>{},subscribe:observer=>{observer.snapshot(slice(0));return()=>{};}};
 const stop=watchWorkspaces({list:async options=>{
  validateWorkspaceOptions(options);requests.push(options);
  return options.subscribe?{...slice(0),subscription}:slice(Number(options.page.cursor));
 }},rows,message=>errors.push(message),()=>()=>{});
 t.after(stop);await settle();
 assert.deepEqual(errors,[]);
 assert.deepEqual(requests,[{subscribe:{},page:{limit:200}},{page:{limit:200,cursor:'200'}},{page:{limit:200,cursor:'400'}}]);
 assert.equal(rows.entries.size,451);
 assert.deepEqual([...rows.entries],all.map(entry=>[entry.id,entry.workspaceDirectory]));
});
test('workspace connection and subscription failures log the original message within 200 characters',async()=>{
 const errors=[],rows=registry();let tick,observer,fail=true;
 const subscription={release:async()=>{},subscribe:value=>{observer=value;return()=>{};}};
 const stop=watchWorkspaces({list:async options=>{
  validateWorkspaceOptions(options);
  if(fail)throw new Error('Update the host to use background workspaces.');
  return {...page([]),subscription};
 }},rows,message=>errors.push(message),fn=>{tick=fn;return()=>{};});
 await settle();assert.deepEqual(errors,['engram_workspace_subscription_unavailable: Update the host to use background workspaces.']);
 fail=false;tick();await settle();
 observer.error(new Error('subscription disconnected'));
 assert.equal(errors.at(-1),'engram_workspace_subscription_failed: subscription disconnected');
 observer.error(new Error('long failure: '+'x'.repeat(300)));
 assert.equal(errors.at(-1).length,200);assert.ok(errors.at(-1).startsWith('engram_workspace_subscription_failed: long failure: '));
 await stop();
});
test('workspace diagnostics omit credentials, prompt payloads and error object metadata',async()=>{
 for(const error of [new Error('Authorization: Bearer FAKE-LOG-TOKEN'),new Error('failed prompt: FAKE-PROMPT-CONTENT'),{message:'opaque',token:'FAKE-OBJECT-TOKEN',prompt:'FAKE-OBJECT-PROMPT'}]){
  const errors=[];error.cause='FAKE-CAUSE';error.stack='FAKE-STACK';
  const stop=watchWorkspaces({list:async options=>{validateWorkspaceOptions(options);throw error;}},registry(),message=>errors.push(message),()=>()=>{});
  await settle();await stop();assert.equal(errors.length,1);
  assert.ok(errors[0].startsWith('engram_workspace_subscription_unavailable: '));
  assert.ok(!errors[0].includes('FAKE-'));assert.ok(errors[0].length<=200);
 }
});
test('a workspace subscription that arrives after unload is released without registering buttons',async()=>{
 let resolve,released=0;const rows=registry();const stop=watchWorkspaces({list:options=>{validateWorkspaceOptions(options);return new Promise(done=>{resolve=done;});}},rows,assert.fail,()=>()=>{});const stopping=stop();resolve({...page([workspace('a')]),subscription:{release:async()=>{released++;},subscribe:()=>assert.fail('late subscribe')}});await stopping;assert.equal(released,1);assert.equal(rows.entries.size,0);
});
