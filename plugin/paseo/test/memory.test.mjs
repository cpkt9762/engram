import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProject, deletionWarning, memoryController, scanAll } from '../shared/memory.ts';

test('project selection uses nonempty available_projects; null field is unambiguous',()=>{
 assert.deepEqual(selectProject({project:'p',available_projects:null}),{project:'p',choices:[]});
 assert.deepEqual(selectProject({project:'p',available_projects:['a','b']}),{project:'',choices:['a','b']});
 assert.match(deletionWarning(true),/删除会同步到其他机器/);assert.match(deletionWarning(false),/以后加入同步/);
});
test('confirmation stays bound to original instance and project across switches and renames',async()=>{
 const calls=[];const api={deleteMemory:async v=>{calls.push(v);return {ok:true,data:{status:'deleted'}};},deletePrompt:async v=>{calls.push(v);return {ok:true,data:{status:'deleted'}};}};
 const model=memoryController(api);const original={project:'p',instance_id:'old',enrolled:true,cloud_configured:true,autosync_enabled:true};
 for(const current of [undefined,{...original,project:'renamed'},{...original,instance_id:'new'}]){model.bind(current);assert.equal((await model.remove({id:1,kind:'prompt'},original)).error.code,'view_changed');}
 assert.equal(calls.length,0);model.bind(original);
 assert.equal((await model.remove({id:1,kind:'prompt'},original)).ok,true);assert.deepEqual(calls,[{project:'p',instance_id:'old',id:1}]);
});
test('scan traverses empty matching pages and refuses changed tokens and repeated cursors',async()=>{
 const pages=[{items:[],next_cursor:'c1',complete:false,scan_token:'one'},{items:[{id:2,masked_context:'密码是 [已遮蔽]'}],next_cursor:'',complete:true,scan_token:'one'}];let i=0;
 const result=await scanAll('p',async()=>({ok:true,data:pages[i++]}));assert.equal(result.ok,true);assert.equal(result.data.items.length,1);assert.equal(i,2);
 i=0;const stale=await scanAll('p',async()=>({ok:true,data:{...pages[i],scan_token:String(i++)}}));assert.equal(stale.error.code,'scan_stale');
 assert.equal((await scanAll('p',async()=>({ok:true,data:pages[0]}))).error.code,'invalid_cursor');
});
