import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { EngramClient } from '../server/engram.ts';
import { handle } from '../server/handlers.ts';
import { guardNetwork, fakeSecret } from './helpers.mjs';

const root = resolve(import.meta.dirname, '../../..');
async function run(command, args, options) {
 const child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 const [code]=await once(child,'exit');assert.equal(code,0,output);return output;
}
function raw(url,path,method='GET',body,headers={}) {
 return new Promise((resolve,reject)=>{
  const req=http.request(url+path,{method,headers:{Authorization:'Bearer fake-http-token',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},agent:false},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,data,text});});
  });req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('timeout')));req.end(body===undefined?undefined:JSON.stringify(body));
 });
}

test('isolated real engram serve: P0 HTTP administration and P1 RPC roundtrip', {timeout:580000}, async t=>{
 guardNetwork(t);
 const directory=await mkdtemp(join(tmpdir(),'engram-paseo-http-'));
 const home=join(directory,'home'),data=join(directory,'data'),bin=join(directory,'bin');
 await Promise.all([mkdir(home),mkdir(data),mkdir(bin),mkdir(join(directory,'.engram'))]);
 await writeFile(join(directory,'.engram','config.json'),JSON.stringify({project_name:'demo'}));
 const calls=join(directory,'security-calls');
 await writeFile(join(bin,'security'),'#!/bin/sh\necho called >> "$SECURITY_CALL_LOG"\nexit 1\n',{mode:0o700});
 const script=join(directory,'serve.sh');
 await writeFile(script,`#!/usr/bin/env bash
set -eu
for v in $(compgen -e | grep '^ENGRAM_'); do unset "$v"; done
export HOME="$TEST_HOME" ENGRAM_DATA_DIR="$TEST_DATA" PATH="$TEST_BIN:$PATH"
export GOCACHE="$PASEO_TEST_GOCACHE" GOPATH="$PASEO_TEST_GOPATH"
if compgen -e | grep -q '^ENGRAM_CLOUD_'; then exit 90; fi
uptime >&2
timeout 600s go build -o "$TEST_BIN/engram" ./cmd/engram
export ENGRAM_HTTP_TOKEN=fake-http-token
# Port 0 binds a fresh ephemeral loopback port; never use the normal 7437 service.
cd "$TEST_HOME"
exec timeout 540s "$TEST_BIN/engram" serve 0
`);
 let stderr='';const env={...process.env,TEST_HOME:home,TEST_DATA:data,TEST_BIN:bin,SECURITY_CALL_LOG:calls};
 const child=spawn('bash',[script],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
 child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',c=>stderr+=c);
 let stopped=false;
 t.after(async()=>{
   if(!stopped){try{process.kill(-child.pid,'SIGTERM');}catch{}if(child.exitCode===null && child.signalCode===null) await once(child,'exit');stopped=true;}
   let count=0;try{count=(await readFile(calls,'utf8')).trim().split('\n').filter(Boolean).length;}catch(e){if(e.code!=='ENOENT')throw e;}
   assert.equal(count,0,'security must never be invoked');
   let groupAlive=true;
   for(let attempt=0;attempt<50;attempt++){
     try{execFileSync('pgrep',['-g',String(child.pid)],{stdio:'ignore'});}
     catch(error){if(error.status===1){groupAlive=false;break;}throw error;}
     await new Promise(resolve=>setTimeout(resolve,20));
   }
   if(groupAlive){try{process.kill(-child.pid,'SIGKILL');}catch{}}
   await rm(directory,{recursive:true,force:true});
   assert.equal(groupAlive,false,'owned serve process group must exit cleanly');
   await assert.rejects(readFile(script),error=>error.code==='ENOENT');
   console.log('real serve security_calls=0; process group exited; temporary directory deleted; '+execFileSync('uptime',{encoding:'utf8'}).trim());
 });
 // Discover the actual ephemeral listener through the owned process tree, not a default port.
 let url;
 for(let i=0;i<300;i++) {
   if(child.exitCode!==null)assert.fail(`serve exited: ${stderr}`);
   const match=stderr.match(/HTTP server listening on 127\.0\.0\.1:(\d+)/);
   if(match && match[1]!=='0'){url=`http://127.0.0.1:${match[1]}`;break;}
   // The server log may print the requested port (0); inspect only our process group.
   try{
     const pids=execFileSync('pgrep',['-g',String(child.pid)],{encoding:'utf8'}).trim().split('\n');
     for(const pid of pids){try{
       const output=execFileSync('lsof',['-nP','-a','-p',pid,'-iTCP','-sTCP:LISTEN','-Fn'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
       const listener=output.match(/^n127\.0\.0\.1:(\d+)$/m);if(listener){assert.notEqual(listener[1],'7437');url=`http://127.0.0.1:${listener[1]}`;}
     }catch{}}
   }catch{}
   if(url)break;
   await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(url,`no isolated listener: ${stderr}`);
 const c=new EngramClient(url,'fake-http-token');
 const health=await c.probe();assert.equal(health.capabilities['sync-admin-v1'],true);assert.equal(health.capabilities['sync-admin-v2'],true);
 const sync=await handle('status',{},c);assert.equal(sync.ok,true);assert.equal(sync.data.cloud_configured,false);
 const resolved=await handle('resolve',{cwd:directory},c);assert.equal(resolved.ok,true);assert.equal(resolved.data.project,'demo');assert.equal(resolved.data.available_projects,null);
 const request=async(path,method,body,headers)=>raw(url,path,method,body,headers);
 const initial=await request('/sync/enrollment?project=demo');assert.equal(initial.data.enrolled,false);assert.equal(initial.data.cloud_configured,false);
 assert.equal((await request('/sessions','POST',{id:'s',project:'demo',directory})).status,201);
 let promptId;
 for(let i=0;i<101;i++){const r=await request('/prompts','POST',{session_id:'s',project:'demo',content:`密码是 ${fakeSecret}-${i}`});assert.equal(r.status,201);promptId??=r.data.id;}
 const scan=await request('/prompts/secret-scan?project=demo');assert.equal(scan.status,200);assert.equal(scan.data.items.length,100);assert.equal(scan.data.complete,false);assert.ok(!scan.text.includes(fakeSecret));
 const next=await request('/prompts/secret-scan?project=demo&cursor='+encodeURIComponent(scan.data.next_cursor));assert.equal(next.data.complete,true);assert.equal(next.data.items.length,1);
 assert.equal((await request('/prompts','POST',{session_id:'s',project:'demo',content:'late prompt'})).status,201);
 const stale=await request('/sync/enrollment','POST',{project:'demo',instance_id:health.instance_id,scan_token:scan.data.scan_token});assert.equal(stale.status,409);assert.equal(stale.data.code,'scan_stale');
 const joined=await request('/sync/enrollment','POST',{project:'demo',instance_id:health.instance_id,force:true});assert.equal(joined.status,200);assert.equal(joined.data.enrolled,true);
 const stoppedEnrollment=await handle('stop',{project:'demo',instance_id:health.instance_id},c);assert.equal(stoppedEnrollment.ok,true);assert.equal(stoppedEnrollment.data.enrolled,false);
 const {scanAll}=await import('../shared/memory.ts');const checked=await scanAll('demo',args=>handle('scan',args,c));assert.equal(checked.ok,true);
 const rejoined=await handle('join',{project:'demo',instance_id:health.instance_id,scan_token:checked.data.scan_token},c);assert.equal(rejoined.ok,true);assert.equal(rejoined.data.enrolled,true);
 const emptyScan=await request('/prompts/secret-scan?project=empty');assert.equal(emptyScan.data.complete,true);
 assert.equal((await request('/sync/enrollment','POST',{project:'empty',instance_id:health.instance_id,scan_token:emptyScan.data.scan_token})).status,200);
 for(const path of ['/prompts/recent?project=demo&masked=1','/prompts/search?project=demo&q=密码&masked=1']){const r=await request(path);assert.equal(r.status,200);assert.ok(!r.text.includes(fakeSecret));}
 const promptRpc=await handle('prompts',{project:'demo'},c);assert.equal(promptRpc.ok,true);assert.ok(!JSON.stringify(promptRpc).includes(fakeSecret));
 const deleted=()=>`/prompts/${promptId}?expected_project=demo&instance_id=${health.instance_id}`;
 assert.equal((await request(`/prompts/${promptId}?expected_project=other&instance_id=${health.instance_id}`,'DELETE')).status,409);
 assert.equal((await request(`/prompts/${promptId}?expected_project=demo&instance_id=wrong`,'DELETE')).status,409);
 assert.equal((await request(deleted(),'DELETE')).status,200);
 const obs=await request('/observations','POST',{session_id:'s',project:'demo',title:'roundtrip',type:'discovery',content:'roundtrip memory'});assert.equal(obs.status,201);
 assert.equal((await handle('search',{project:'demo',query:'roundtrip'},c)).ok,true);
 assert.equal((await handle('get',{project:'demo',id:obs.data.id},c)).ok,true);
 assert.equal((await request(`/observations/${obs.data.id}?expected_project=demo&instance_id=wrong`,'DELETE')).status,409);
 assert.equal((await handle('deleteMemory',{project:'demo',instance_id:health.instance_id,id:obs.data.id},c)).ok,true);
 for(const [path,method,body] of [[`/sync/enrollment?project=demo&instance_id=${health.instance_id}`,'DELETE',undefined],['/prompts/secret-scan?project=demo','GET',undefined],['/sync/enrollment','POST',{project:'demo',instance_id:health.instance_id,force:true}]]){
   assert.equal((await request(path,method,body,{Origin:'http://evil.invalid'})).status,403);
   assert.equal((await request(path,method,body,{Origin:''})).status,403);
   assert.equal((await request(path,method,body,{Host:'evil.invalid'})).status,403);
   if(method==='POST')assert.equal((await request(path,method,body,{'Content-Type':'text/plain'})).status,415);
 }
 const variants=[['OpenWrt ssh 10.0.0.1 密码 Abcd1234','Abcd1234'],['请输入后台管理密码并登录，…… Zq9Fake12','Zq9Fake12'],['root密码Abc12345','Abc12345'],['the password is English9Fake','English9Fake'],['password: Colon9Fake','Colon9Fake'],['pwd Pwd9Fake12','Pwd9Fake12']];
 variants.push(['OpenWrt 可以用 ssh 10.0.0.1 密码 abcdefgh','abcdefgh'],['[Assistant] 请提供路由器后台管理密码。'+'等待说明'.repeat(80)+'\n[User] Zq9Fake1A','Zq9Fake1A']);
 // Keep these samples below the RPC's fixed 50-row limit, independently of
 // the pagination fixtures above (created_at ties do not promise ID ordering).
 const maskingProject='masking-examples';
 assert.equal((await request('/sessions','POST',{id:'masking',project:maskingProject,directory})).status,201);
 const variantIds=[];
 for(const [content] of variants){const saved=await request('/prompts','POST',{session_id:'masking',project:maskingProject,content});assert.equal(saved.status,201);variantIds.push(saved.data.id);}
 const safeInputs=['abc1234def','open-u60-pro','x86_64','密码输入处','我先找下密码\n后面是普通中文句子','password policy','token budget','secret key'];
 const safeIds=[];
 for(const content of safeInputs){const saved=await request('/prompts','POST',{session_id:'masking',project:maskingProject,content});assert.equal(saved.status,201);safeIds.push(saved.data.id);}
 const displayed=await request(`/prompts/recent?project=${maskingProject}&masked=1&limit=200`);assert.equal(displayed.status,200);
 const scanned=await scanAll(maskingProject,args=>handle('scan',args,c));assert.equal(scanned.ok,true);
 for(const id of variantIds){assert.ok(displayed.data.some(row=>row.id===id));assert.ok(scanned.data.items.some(row=>row.id===id));}
 for(const [,value] of variants){assert.ok(!displayed.text.includes(value));assert.ok(!JSON.stringify(scanned).includes(value));}
 for(let i=0;i<safeIds.length;i++){assert.equal(displayed.data.find(row=>row.id===safeIds[i])?.content,safeInputs[i]);assert.ok(!scanned.data.items.some(row=>row.id===safeIds[i]));}
 const variantRpc=await handle('prompts',{project:maskingProject},c);assert.equal(variantRpc.ok,true);
 for(const id of variantIds){assert.ok(variantRpc.data.some(row=>row.id===id));}
 for(const [,value] of variants){assert.ok(!JSON.stringify(variantRpc).includes(value));}
 console.log('nearby, Chinese ASCII and distant standalone replies hidden in actual serve masked list, complete scan and RPC; negative examples unchanged');
 // Node connections are guarded on every connect. Inspect every owned Go process
 // endpoint too; ENGRAM_CLOUD_* was removed and no cloud configuration exists.
 const pids=execFileSync('pgrep',['-g',String(child.pid)],{encoding:'utf8'}).trim().split('\n');let listeners=0;
 for(const pid of pids){try{const sockets=execFileSync('lsof',['-nP','-a','-p',pid,'-iTCP','-Fn'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});for(const line of sockets.split('\n').filter(v=>v.startsWith('n'))){listeners++;for(const endpoint of line.slice(1).replace(/ \(.*$/,'').split('->'))assert.match(endpoint,/^(127\.[\d.]+|\[::1\]):\d+$/);}}catch(e){if(e.code==='ERR_ASSERTION')throw e;}}
 assert.ok(listeners>0);console.log('real serve loopback-only endpoints verified; HTTP/RPC fake-secret checks passed');
});
