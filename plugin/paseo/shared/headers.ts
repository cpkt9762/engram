import {headerPresentation,type SyncSnapshot,type WorkspaceSync} from "./sync-model.ts";
export function workspaceHeaders<T extends {behavior:unknown}>(model:WorkspaceSync,port:{
  add(id:string,button:T):{update(patch:Partial<T>):void;remove():void};
  describe(id:string,state:SyncSnapshot):T;
}){
  const registrations=new Map<string,{registration:ReturnType<typeof port.add>;signature:string}>();
  let active=true;
  const render=()=>{if(!active)return;for(const id of model.ids()){
    const state=model.snapshot(id),button=port.describe(id,state),presentation=headerPresentation(state);
    const signature=JSON.stringify([presentation.mode,state.kind==="ready"?state.enrollment.project:null,state.kind==="ready"?state.enrollment.instance_id:null,state.kind==="ready"?state.v2:null]);
    const existing=registrations.get(id);
    if(!existing){registrations.set(id,{registration:port.add(id,button),signature});continue;}
    const patch:Partial<T>={...button};
    if(existing.signature===signature)delete patch.behavior;
    existing.registration.update(patch);existing.signature=signature;
  }};
  const unsubscribe=model.subscribe(render);
  return {
    upsert(id:string,directory:string){if(!active)return;model.set(id,directory);render();void model.refresh(id);},
    remove(id:string){registrations.get(id)?.registration.remove();registrations.delete(id);model.remove(id);},
    snapshot(entries:{id:string;directory:string}[]){const alive=new Set(entries.map(entry=>entry.id));for(const id of registrations.keys())if(!alive.has(id)){registrations.get(id)?.registration.remove();registrations.delete(id);model.remove(id);}for(const entry of entries)this.upsert(entry.id,entry.directory);},
    async poll(){if(active)await Promise.all(model.ids().map(id=>model.refresh(id)));},
    dispose(){active=false;unsubscribe();for(const value of registrations.values())value.registration.remove();registrations.clear();},
  };
}
export type Completion=Promise<void>;
export type WorkspaceListSnapshot={entries:{id:string;workspaceDirectory:string;archivingAt?:string|null}[];pageInfo:{hasMore:boolean;nextCursor:string|null}};
