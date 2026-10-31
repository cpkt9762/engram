import type { Enrollment, Health, Result, SyncStatus } from "./rpc.ts";
import { enrollmentFlow, type EnrollmentAPI, type EnrollmentFlow, type EnrollState } from "./enrollment.ts";
import {projectBlocked} from "./status.ts";
import { selectProject, sameBinding } from "./memory.ts";
export type Binding = Pick<Enrollment,"project"|"instance_id">;
export type SyncSnapshot = {kind:"loading"} | {kind:"choose";choices:string[]} | {kind:"error";error:{kind:string;code:string;message:string}} | {kind:"ready";enrollment:Enrollment;v2:boolean;blocked:boolean};
export type SyncAPI = EnrollmentAPI & {
  resolve(cwd:string):Promise<Result<{project:string|null;available_projects:string[]|null}>>;
  health():Promise<Result<Health>>;
  syncStatus():Promise<Result<SyncStatus>>;
  stop(binding:Binding):Promise<Result<Enrollment>>;
};
export type ActionView = {enroll:EnrollState;checking:boolean;stopping:boolean;stopUnknown:boolean;message:string};
const unavailable = ():Result<never>=>({ok:false,error:{kind:"unavailable",code:"rpc_unavailable",message:"engram 服务不可用"}});
const refused = (code:string,message:string):Result<never>=>({ok:false,error:{kind:"http_error",code,message}});
export function headerPresentation(snapshot:SyncSnapshot):{mode:string;label:string}{
  if(snapshot.kind==="loading")return {mode:"loading",label:"engram：读取中"};
  if(snapshot.kind==="choose")return {mode:"choose",label:"engram：选择项目"};
  if(snapshot.kind==="error")return {mode:"error",label:snapshot.error.kind==="unsupported"?"engram：版本太旧":snapshot.error.kind==="unavailable"?"engram：服务不可用":"engram：请求失败"};
  if(snapshot.enrollment.enrolled && snapshot.blocked)return {mode:"blocked",label:"云端未放行"};
  if(!snapshot.enrollment.cloud_configured)return {mode:"configure",label:"engram：未配置云同步"};
  if(snapshot.enrollment.enrolled)return {mode:"menu",label:"已同步"};
  if(!snapshot.v2)return {mode:"old",label:"engram：版本太旧"};
  return {mode:"join",label:"加入同步"};
}
export const stopWarning = (project:string,host:string) => `停止项目「${project}」在主机「${host}」上的同步？本机的新记录不再进入上传队列，已有积压保留、暂停上传，重新加入后可继续上传。已经上传的内容不会从云端删除，其他机器的变更仍会拉取并应用。停止期间新建的记忆会在重新加入时补推；对已上传并确认的同项目记忆所作的修改不会自动补推。已经发出的同步请求可能仍会完成。`;
export function workspaceSync(api:SyncAPI){
  const listeners=new Set<()=>void>(),flights=new Map<string,Promise<unknown>>();
  const entries=new Map<string,{cwd:string;chosen?:string;project?:string;epoch:number;snapshot:SyncSnapshot}>();
  const revisions=new Map<string,number>();
  const projectStates=new Map<string,SyncSnapshot>();
  const sessions=new Map<string,{flow:EnrollmentFlow;view:ActionView;checks:number}>();
  let active=true;
  const emit=()=>{if(active)for(const listener of listeners)listener();};
  const key=(binding:Binding)=>JSON.stringify([binding.project,binding.instance_id]);
  const invalidate=(project:string)=>{revisions.set(project,(revisions.get(project)??0)+1);flights.delete(`project:${project}`);flights.delete("cloud-status");};
  const once=<T>(name:string,action:()=>Promise<T>):Promise<T>=>{
    const found=flights.get(name);if(found)return found as Promise<T>;
    const promise=action().finally(()=>{if(flights.get(name)===promise)flights.delete(name);});flights.set(name,promise);return promise;
  };
  const read=async(project:string):Promise<SyncSnapshot>=>once(`project:${project}`,async()=>{
    if(!active)return {kind:"error",error:{kind:"http_error",code:"plugin_stopped",message:"插件已卸载"}};
    const revision=revisions.get(project)??0;
    const result:SyncSnapshot=await (async():Promise<SyncSnapshot>=>{try{
      const [health,status]=await Promise.all([once("health",()=>api.health()),api.status({project})]);
      if(!status.ok)return {kind:"error",error:status.error};
      if(!health.ok)return {kind:"error",error:health.error};
      if(status.data.project!==project)return {kind:"error",error:{kind:"http_error",code:"project_mismatch",message:"项目已变化"}};
      let blocked=false;
      if(status.data.enrolled){
        const cloud=await once("cloud-status",()=>api.syncStatus());
        if(!cloud.ok)return {kind:"error",error:cloud.error};
        blocked=projectBlocked(cloud.data,project);
      }
      return {kind:"ready",enrollment:status.data,v2:health.data.capabilities["sync-admin-v2"]===true,blocked};
    }catch{return {kind:"error",error:{kind:"unavailable",code:"rpc_unavailable",message:"engram 服务不可用"}};}})();
    if(active && revision!==(revisions.get(project)??0))return read(project);
    if(active){projectStates.set(project,result);emit();}return result;
  });
  const refresh=async(id:string)=>{
    const entry=entries.get(id);if(!entry || !active)return;
    const epoch=++entry.epoch;
    let snapshot:SyncSnapshot;
    try{
      const resolved=await once(`cwd:${entry.cwd}`,()=>api.resolve(entry.cwd));
      if(!active || entries.get(id)!==entry || entry.epoch!==epoch)return;
      if(!resolved.ok){snapshot=resolved.error.kind==="http_error"?{kind:"choose",choices:[]}:{kind:"error",error:resolved.error};}
      else{
        const selection=selectProject(resolved.data);
        if(entry.chosen && !selection.choices.includes(entry.chosen))entry.chosen=undefined;
        const project=entry.chosen ?? selection.project;entry.project=project;
        snapshot=project?await read(project):{kind:"choose",choices:selection.choices};
      }
    }catch{snapshot={kind:"error",error:{kind:"unavailable",code:"rpc_unavailable",message:"engram 服务不可用"}};}
    if(active && entries.get(id)===entry && entry.epoch===epoch){entry.snapshot=snapshot;emit();}
  };
  const refreshProject=async(project:string)=>{
    invalidate(project);
    const ids=[...entries].filter(([,entry])=>entry.project===project).map(([id])=>id);
    if(ids.length)await Promise.all(ids.map(id=>refresh(id)));else if(active)await read(project);
  };
  const session=(binding:Binding)=>{
    const id=key(binding),existing=sessions.get(id);if(existing)return existing;
    const initial:EnrollState={phase:"prompt",items:[],message:""};
    const value={flow:undefined as unknown as EnrollmentFlow,checks:0,view:{enroll:initial,checking:false,stopping:false,stopUnknown:false,message:""}};
    value.flow=enrollmentFlow(binding,{
      ...api,
      join:args=>once(`join:${id}`,async()=>{invalidate(binding.project);try{return await api.join(args);}finally{invalidate(binding.project);}}),
      status:async()=>{const state=await read(binding.project);return state.kind==="ready"?{ok:true,data:state.enrollment}:state.kind==="error"?{ok:false,error:{kind:"http_error",code:state.error.code,message:state.error.message}}:unavailable();},
    },enroll=>{value.view={...value.view,enroll};emit();if(enroll.phase==="joined")void refreshProject(binding.project);});
    sessions.set(id,value);return value;
  };
  const checking=async<T>(binding:Binding,action:()=>Promise<T>):Promise<T>=>{
    const value=session(binding);value.checks++;value.view={...value.view,checking:true};emit();
    try{return await action();}finally{value.checks--;value.view={...value.view,checking:value.checks>0};emit();}
  };
  const validate=async(binding:Binding):Promise<Result<Enrollment>>=>{
    if(!active)return refused("plugin_stopped","插件已卸载");
    const state=await read(binding.project);
    if(!active)return refused("plugin_stopped","插件已卸载");
    if(state.kind!=="ready")return state.kind==="error"?refused(state.error.code,state.error.message):unavailable();
    if(!sameBinding(state.enrollment,binding))return refused("instance_mismatch","项目或实例已变化，请重新载入");
    if(!state.v2)return {ok:false,error:{kind:"unsupported",code:"engram_too_old",message:"engram 版本太旧"}};
    return {ok:true,data:state.enrollment};
  };
  const confirmStop=async(binding:Binding):Promise<Result<Enrollment>>=>{
    const value=session(binding);invalidate(binding.project);
    const result=await validate(binding);
    if(result.ok && !result.data.enrolled){value.view={...value.view,stopUnknown:false,message:"本机已停止上传，仍接收远端变更"};value.flow.cancel();}
    else value.view={...value.view,stopUnknown:true,message:"停止结果仍待确认；请重新查询，不会自动重发"};
    emit();await refreshProject(binding.project);return result;
  };
  return {
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    snapshot(id:string):SyncSnapshot{return entries.get(id)?.snapshot ?? {kind:"loading"};},
    ids(){return [...entries.keys()];},
    set(id:string,cwd:string){const old=entries.get(id);if(old?.cwd===cwd)return;entries.set(id,{cwd,epoch:0,snapshot:{kind:"loading"}});emit();},
    remove(id:string){entries.delete(id);emit();},
    select(id:string,project:string){const entry=entries.get(id);if(entry){entry.chosen=project;void refresh(id);}},
    refresh,project:read,projectSnapshot(project:string){return projectStates.get(project);},refreshProject,
    action(binding:Binding){return session(binding).view;},
    async begin(binding:Binding,withFindings=false){return once(`begin:${key(binding)}`,async()=>{
      if(!active)return;
      return checking(binding,async()=>{
      const result=await validate(binding);if(!active)return;const value=session(binding);
      if(!result.ok){value.view={...value.view,message:result.error.message};emit();return;}
      if(result.data.enrolled)await value.flow.initialize();else await value.flow.begin(withFindings);
      await refreshProject(binding.project);
      });
    });},
    async force(binding:Binding){if(!active)return;return checking(binding,async()=>{await session(binding).flow.force();await refreshProject(binding.project);});},
    async removePrompt(binding:Binding,id:number){if(!active)return;return checking(binding,async()=>{await session(binding).flow.remove(id);await refreshProject(binding.project);});},
    async confirmJoin(binding:Binding){if(!active)return;return checking(binding,async()=>{await session(binding).flow.confirm();await refreshProject(binding.project);});},
    cancel(binding:Binding){session(binding).flow.cancel();},
    async stop(binding:Binding):Promise<Result<Enrollment>>{return once(`stop:${key(binding)}`,async()=>{
      if(!active)return refused("plugin_stopped","插件已卸载");
      return checking(binding,async()=>{
      const value=session(binding);if(value.view.stopUnknown)return confirmStop(binding);
      const valid=await validate(binding);if(!valid.ok){value.view={...value.view,message:valid.error.message};emit();return valid;}
      if(!active)return refused("plugin_stopped","插件已卸载");
      value.view={...value.view,stopping:true,message:""};emit();
      let result:Result<Enrollment>;
      try{result=await api.stop(binding);}catch{result={ok:false,error:{kind:"outcome_unknown",code:"rpc_unavailable",message:"停止结果待确认"}};}
      invalidate(binding.project);
      if(!result.ok && result.error.kind==="outcome_unknown"){value.view={...value.view,stopUnknown:true};await confirmStop(binding);}
      else if(result.ok && sameBinding(result.data,binding) && !result.data.enrolled){value.flow.cancel();value.view={...value.view,stopUnknown:false,message:"本机已停止上传，仍接收远端变更"};}
      else value.view={...value.view,message:result.ok?"停止状态未确认，请重新载入":`${result.error.code}: ${result.error.message}`};
      value.view={...value.view,stopping:false};emit();await refreshProject(binding.project);return result;
      });
    });},
    async confirmStop(binding:Binding){if(!active)return refused("plugin_stopped","插件已卸载");return once(`confirm-stop:${key(binding)}`,()=>checking(binding,()=>confirmStop(binding)));},
    dispose(){active=false;for(const value of sessions.values())value.flow.dispose();entries.clear();sessions.clear();projectStates.clear();revisions.clear();listeners.clear();},
  };
}
export type WorkspaceSync=ReturnType<typeof workspaceSync>;
