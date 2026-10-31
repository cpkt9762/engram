import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngramClient, loopbackUrl, failure } from '../server/engram.ts';
import { handle } from '../server/handlers.ts';
import { statusLevel, deadRecordNotice, blockedProjectsNotice } from '../shared/status.ts';
import { fakeServer, json, guardNetwork, fakeSecret, healthy } from './helpers.mjs';

test('client: loopback, capability TTL, structured errors, no secret disclosure or redirect', async t => {
 guardNetwork(t); let now = 0, probes = 0, capable = false, authSeen = false;
 const {url} = await fakeServer(t, (req, res) => {
   authSeen ||= req.headers.authorization === 'Bearer fake-bearer';
   if (req.url === '/health') {probes++; return json(res, {instance_id:'a',capabilities:{'sync-admin-v1':capable}});}
   if (req.url === '/redirect') {res.writeHead(302, {Location:'http://203.0.113.1/'});return res.end();}
   if (req.url === '/error') return json(res, {error:`密码是 ${fakeSecret}`,code:'project_not_found'},404);
   json(res,healthy());
 });
 const c = new EngramClient(url,'fake-bearer',5000,()=>now);
 await assert.rejects(c.requireAdmin(), e=>e.kind==='unsupported'); capable=true;
 await assert.rejects(c.requireAdmin(), e=>e.kind==='unsupported');assert.equal(probes,1);
 now=60001;await c.requireAdmin();assert.equal(probes,2);assert.ok(authSeen);
 await assert.rejects(c.request('/redirect'), e=>e.kind==='http_error' && e.status===302);
 await assert.rejects(c.request('/error'), e=>{assert.equal(e.code,'project_not_found');assert.ok(!JSON.stringify(failure(e)).includes(fakeSecret));return true;});
 for (const value of ['https://127.0.0.1','http://example.com','http://127.0.0.1@evil.example','http://127.0.0.1/path','http://[::ffff:192.0.2.1]','http://127.0.0.1/?token=x']) assert.throws(()=>loopbackUrl(value));
 assert.equal(loopbackUrl('http://localhost:1234').hostname,'127.0.0.1');
});

test('client: lost write acknowledgement is unknown and never replayed; transient health failure recovers', async t => {
 guardNetwork(t);let writes=0, fail=true;
 const {url}=await fakeServer(t,(req,res)=>{
   if(req.url==='/health'){if(fail){res.destroy();return;}return json(res,{instance_id:'a',capabilities:{'sync-admin-v1':true}});}
   if(req.method==='POST'){writes++;req.resume();req.on('end',()=>res.destroy());return;}
 });
 const c=new EngramClient(url,'',50);
 await assert.rejects(c.probe(),e=>e.kind==='unavailable');fail=false;await c.probe();
 await assert.rejects(c.request('/sync/enrollment','POST',{force:true}),e=>e.kind==='outcome_unknown');assert.equal(writes,1);
});

test('RPC handlers validate and project only schema fields; prompt always masked',async t=>{
 guardNetwork(t);const paths=[];
 const {url}=await fakeServer(t,(req,res)=>{
  paths.push(req.url);
  if(req.url==='/health')return json(res,{instance_id:'a',capabilities:{'sync-admin-v1':true}});
  if(req.url.startsWith('/prompts/recent')){assert.ok(req.url.includes('masked=1'));return json(res,[{id:1,content:'密码是 [已遮蔽]',session_id:'s',created_at:'now',project:'p',extra:fakeSecret}]);}
  if(req.url.startsWith('/search')){assert.ok(req.url.includes('q=hello'));return json(res,[]);}
  if(req.url==='/observations/1')return json(res,{id:1,title:'wrong project',project:'other'});
  return json(res,{code:'instance_mismatch',error:fakeSecret},409);
 });
 const c=new EngramClient(url);
 const result=await handle('prompts',{project:'p'},c);assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes(fakeSecret));
 assert.equal((await handle('search',{project:'p',query:'hello'},c)).ok,true);
 assert.equal((await handle('get',{project:'p',id:1},c)).error.code,'project_mismatch');
 const deletion=await handle('deletePrompt',{project:'p',instance_id:'old',id:1},c);assert.equal(deletion.error.code,'instance_mismatch');assert.ok(!JSON.stringify(deletion).includes(fakeSecret));
 assert.match(paths.at(-1),/expected_project=p&instance_id=old/);
});

test('status grading: every failure and stale/paused/queued condition prevents green',()=>{
 const now=Date.now();const good=healthy();assert.equal(statusLevel({ok:true,data:good},now),'green');
 for(const patch of [{consecutive_failures:3},{phase:'degraded'},{cloud_configured:false},{reason_code:'auth_required'},{reason_code:'policy_forbidden'}]) assert.equal(statusLevel({ok:true,data:{...good,...patch}},now),'red');
 for(const patch of [{dead_count:1},{paused:true},{deferred_count:1},{backoff_until:new Date(now+10000).toISOString()},{pending_count:1,last_success_at:new Date(now-600001).toISOString()},{pending_count:1,last_success_at:null},{status_at:new Date(now-120001).toISOString()},{status_at:'bad'},{enabled:false},{autosync_enabled:false}]) assert.equal(statusLevel({ok:true,data:{...good,...patch}},now),'yellow');
 assert.equal(statusLevel({ok:true,data:{...good,enrolled_count:0}},now),'gray');
 for(const kind of ['unavailable','http_error','outcome_unknown'])assert.equal(statusLevel({ok:false,error:{kind,code:'x',message:'x'}},now),'red');
 assert.equal(statusLevel({ok:false,error:{kind:'unsupported',code:'x',message:'x'}},now),'gray');
});

test('status: an invalid last_success_at with backlog must be yellow',()=>{
 assert.equal(statusLevel({ok:true,data:healthy({pending_count:2,last_success_at:'invalid'})}),'yellow');
});

test('client deadlines and partial-response aborts stay bounded without replay',async t=>{
 guardNetwork(t);let posts=0;
 const {url}=await fakeServer(t,(req,res)=>{
  if(req.method==='POST')posts++;
  if(req.url==='/partial'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');setImmediate(()=>res.destroy());}
 });
 const c=new EngramClient(url,'',30);
 await assert.rejects(c.request('/timeout'),e=>e.kind==='unavailable');
 await assert.rejects(c.request('/timeout','POST',{}),e=>e.kind==='outcome_unknown');
 await assert.rejects(c.request('/partial','POST',{}),e=>e.kind==='outcome_unknown');
 assert.equal(posts,2);
});

test('missing health capability inventory is unsupported rather than a permanent failure',async t=>{
 guardNetwork(t);const {url}=await fakeServer(t,(_req,res)=>json(res,{instance_id:'legacy'}));
 await assert.rejects(new EngramClient(url).requireAdmin(),e=>e.kind==='unsupported');
});


test('dead rows are retained evidence: yellow alone, persistent failures remain red',()=>{
 assert.equal(statusLevel({ok:true,data:healthy({dead_count:2})}),'yellow');
 assert.equal(statusLevel({ok:true,data:healthy({dead_count:2,consecutive_failures:3})}),'red');
 assert.equal(statusLevel({ok:true,data:healthy({cloud_configured:false,enrolled_count:0,reason_code:'cloud_config_error'})}),'gray');
 assert.equal(deadRecordNotice(2),'有 2 条被放弃的远端变更，需要人工查看；这是保留的证据，不一定表示当前有故障');
 assert.equal(deadRecordNotice(0),'');
});

test('a refused write connection is unavailable because no request reached a server',async t=>{
 const {createServer}=await import('node:net');guardNetwork(t);
 const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=listener.address().port;assert.notEqual(port,7437);
 await new Promise(resolve=>listener.close(resolve));
 await assert.rejects(new EngramClient(`http://127.0.0.1:${port}`,'',1000).request('/sync/enrollment','POST',{project:'p',force:true}),error=>error.kind==='unavailable' && error.code==='connection_failed');
});


test('project allowlist denial is red independently of generic status phase',()=>{
 const blocked=[{project:'p',code:'project_not_allowed',last_seen_at:'2026-10-27T00:00:00Z'}];
 assert.equal(statusLevel({ok:true,data:healthy({blocked_projects:blocked})}),'red');assert.match(blockedProjectsNotice(blocked),/p.*白名单/);
});
