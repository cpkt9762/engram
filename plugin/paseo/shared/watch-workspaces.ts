import type {Completion,WorkspaceListSnapshot} from "./headers.ts";
// Paseo's FetchWorkspacesRequestMessageSchema caps page.limit at 200.
const WORKSPACE_PAGE_LIMIT=200;
type Subscription={release():Completion;subscribe(observer:{snapshot(value:WorkspaceListSnapshot):void;update(message:unknown):void;error(error:unknown):void}):()=>void};
type PageOptions={page:{limit:number;cursor?:string};subscribe?:{}};
function workspaceDiagnostic(code:string,error:unknown){
  // SDK diagnostics only: never serialize payloads, stacks, causes or objects.
  const message=(error instanceof Error?error.message:typeof error==="string"?error:"unknown_error")
    .replace(/(https?:\/\/)[^/\s@]+@/gi,"$1[redacted]@")
    .replace(/\bBearer\s+[^\s,;]+/gi,"Bearer [redacted]")
    .replace(/\b(?:authorization|token|password|passwd|pwd|secret|api[_ -]?key|prompt(?:[_ -]?content)?)\s*[:=][\s\S]*/gi,"[redacted]")
    .replace(/[\x00-\x1f\x7f]+/g," ");
  return `${code}: ${message}`.slice(0,200);
}
export function watchWorkspaces(api:{list(options:PageOptions):Promise<WorkspaceListSnapshot & {subscription?:Subscription}>},registry:{snapshot(entries:{id:string;directory:string}[]):void;upsert(id:string,directory:string):void;remove(id:string):void;poll():Completion},report:(message:string)=>void,schedule=(tick:()=>void)=>{const timer=setInterval(tick,60000);return()=>clearInterval(timer);}){
  let active=true,subscription:Subscription|undefined,unsubscribe:(()=>void)|undefined,connecting:Completion|undefined;
  let version=0,hydrating=false,retry:WorkspaceListSnapshot|undefined;
  const updates:(()=>void)[]=[];
  const reportError=(code:string,error:unknown)=>report(workspaceDiagnostic(code,error));
  const flush=()=>{hydrating=false;for(const update of updates.splice(0))update();};
  const snapshot=async(first:WorkspaceListSnapshot)=>{
    const current=++version;hydrating=true;
    let page=first;const entries=[...page.entries],seen=new Set<string>();
    try{
      while(page.pageInfo.hasMore){const cursor=page.pageInfo.nextCursor;if(!cursor||seen.has(cursor))throw new Error("invalid_page");seen.add(cursor);page=await api.list({page:{limit:WORKSPACE_PAGE_LIMIT,cursor}});entries.push(...page.entries);}
      if(!active||current!==version)return;
      registry.snapshot(entries.filter(entry=>!entry.archivingAt).map(entry=>({id:entry.id,directory:entry.workspaceDirectory})));
      retry=undefined;flush();
    }catch(error){if(active&&current===version){retry=first;flush();reportError("engram_workspace_snapshot_failed",error);}}
  };
  const update=(message:unknown)=>{
    if(typeof message!=="object"||message===null||!("type" in message)||message.type!=="workspace_update"||!("payload" in message))return;
    if(typeof message.payload!=="object"||message.payload===null)return;
    const value=message.payload as {kind?:unknown;id?:unknown;workspace?:{id?:unknown;workspaceDirectory?:unknown;archivingAt?:unknown}};
    const apply=()=>{
      if(!active)return;
      if(value.kind==="remove"&&typeof value.id==="string")registry.remove(value.id);
      else if(value.kind==="upsert"&&typeof value.workspace?.id==="string"&&typeof value.workspace.workspaceDirectory==="string"){
        if(value.workspace.archivingAt)registry.remove(value.workspace.id);else registry.upsert(value.workspace.id,value.workspace.workspaceDirectory);
      }
    };
    if(hydrating)updates.push(apply);else apply();
  };
  const connect=()=>{
    if(!active||subscription||connecting)return;
    connecting=(async()=>{
      const result=await api.list({subscribe:{},page:{limit:WORKSPACE_PAGE_LIMIT}});
      if(!result.subscription)throw new Error("subscription_missing");
      if(!active){await result.subscription.release();return;}
      subscription=result.subscription;
      unsubscribe=subscription.subscribe({snapshot:value=>{void snapshot(value);},update,error:error=>{if(active)reportError("engram_workspace_subscription_failed",error);}});
    })().catch(error=>{if(active)reportError("engram_workspace_subscription_unavailable",error);}).finally(()=>{connecting=undefined;});
  };
  connect();
  const stopTimer=schedule(()=>{connect();if(retry&&!hydrating)void snapshot(retry);void registry.poll().catch(error=>{if(active)reportError("engram_workspace_refresh_failed",error);});});
  return async()=>{active=false;version++;stopTimer();unsubscribe?.();updates.length=0;await subscription?.release();await connecting;};
}
