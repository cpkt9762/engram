import {test} from 'node:test';
import assert from 'node:assert/strict';
import contribute from '../index.server.ts';
import {fakeServer,guardNetwork,json,healthy} from './helpers.mjs';
test('server exposes 13 RPCs and no lifecycle or timeline registration',async t=>{
 guardNetwork(t);const handlers=new Map();let deletes=0;
 const {url}=await fakeServer(t,(req,res)=>{
  if(req.url==='/health')return json(res,{instance_id:'a',capabilities:{'sync-admin-v1':true,'sync-admin-v2':true}});
  if(req.url.startsWith('/sync/enrollment')){if(req.method==='DELETE'){deletes++;assert.match(req.url,/project=p&instance_id=a/);assert.equal(req.headers['content-type'],undefined);}return json(res,{project:'p',instance_id:'a',enrolled:false,cloud_configured:true,autosync_enabled:true});}
  json(res,healthy());
 });
 const cleanup=contribute({registerSettings:()=>({read:async()=>({status:'ready',revision:'r',values:{baseUrl:url}}),subscribe:()=>()=>{}}),handle:(contract,handler)=>handlers.set(contract.name,handler)});
 assert.equal(handlers.size,13);assert.equal((await handlers.get('status.get')({})).ok,true);
 assert.equal((await handlers.get('enroll.stop')({project:'p',instance_id:'a'})).ok,true);assert.equal(deletes,1);cleanup();
});
test('v1 service keeps readable enrollment but refuses v2 stop before DELETE',async t=>{
 guardNetwork(t);let deletes=0;
 const {url}=await fakeServer(t,(req,res)=>{if(req.method==='DELETE')deletes++;if(req.url==='/health')return json(res,{instance_id:'a',capabilities:{'sync-admin-v1':true}});json(res,{project:'p',instance_id:'a',enrolled:true,cloud_configured:true,autosync_enabled:true});});
 const handlers=new Map();const cleanup=contribute({registerSettings:()=>({read:async()=>({status:'ready',revision:'r',values:{baseUrl:url}})}),handle:(contract,handler)=>handlers.set(contract.name,handler)});
 assert.equal((await handlers.get('enroll.status')({project:'p'})).ok,true);
 const result=await handlers.get('enroll.stop')({project:'p',instance_id:'a'});assert.equal(result.error.kind,'unsupported');assert.equal(deletes,0);cleanup();
});
