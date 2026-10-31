import type {PluginButtonContentProps,PluginClientContext,PluginButtonIconProps,PluginButton} from "@getpaseo/plugin/client";
import {useEffect,useSyncExternalStore} from "react";
import {Text,View} from "react-native";
import {workspaceHeaders} from "../shared/headers.ts";
import {headerPresentation,type WorkspaceSync} from "../shared/sync-model.ts";
import {watchWorkspaces} from "../shared/watch-workspaces.ts";
import {SyncActions} from "./sync-actions.tsx";
function DeniedIcon({theme}:PluginButtonIconProps){return <Text style={{color:theme.colors.statusDanger,fontWeight:"bold"}}>!</Text>;}
function WorkspacePopover(props:PluginButtonContentProps & {model:WorkspaceSync;id:string;intent:"join"|"stop";openMemory:()=>void;openStatus:()=>void}){
  const state=useSyncExternalStore(props.model.subscribe,()=>props.model.snapshot(props.id));
  useEffect(()=>{void props.model.refresh(props.id);},[props.model,props.id]);
  if(state.kind!=="ready")return <View style={{padding:12}}><Text style={{color:props.theme.colors.foreground}}>{headerPresentation(state).label}</Text></View>;
  return <SyncActions key={`${state.enrollment.instance_id}:${state.enrollment.project}`} {...props} enrollment={state.enrollment} v2={state.v2} blocked={state.blocked} intent={props.intent} />;
}
export function contributeHeaders(client:PluginClientContext,model:WorkspaceSync){
  const registry=workspaceHeaders<PluginButton>(model,{
    add:(workspaceId,button)=>client.addHeaderButton({id:"engram-sync",workspaceId,button}),
    describe:(id,state)=>{
      const {mode,label}=headerPresentation(state);
      const openMemory=()=>client.openPanel("memory",{workspaceId:id}),openStatus=()=>client.openScreen({screenId:"sync"});
      const popover=(intent:"join"|"stop")=>({kind:"popover" as const,Content:(props:PluginButtonContentProps)=><WorkspacePopover {...props} model={model} id={id} intent={intent} openMemory={openMemory} openStatus={openStatus}/>});
      if(mode==="blocked" && state.kind==="ready")return {title:label,label,icon:DeniedIcon,behavior:{kind:"menu" as const,items:[
        {kind:"item" as const,id:"stop",title:state.v2?"停止同步":"停止同步（engram 版本太旧）",disabled:!state.v2,behavior:popover("stop")},
        {kind:"item" as const,id:"status",title:"查看同步状态",behavior:{kind:"action" as const,onPress:async()=>{await model.refresh(id);openStatus();}}},
      ]}};
      if(mode==="menu" && state.kind==="ready")return {title:label,label,icon:"RefreshCw" as const,behavior:{kind:"menu" as const,items:[
        {kind:"item" as const,id:"stop",title:state.v2?"停止同步":"停止同步（engram 版本太旧）",disabled:!state.v2,behavior:popover("stop")},
        {kind:"item" as const,id:"memory",title:"打开 engram 记忆",behavior:{kind:"action" as const,onPress:async()=>{await model.refresh(id);openMemory();}}},
        {kind:"item" as const,id:"status",title:"查看同步状态",behavior:{kind:"action" as const,onPress:async()=>{await model.refresh(id);openStatus();}}},
      ]}};
      return {title:label,label,icon:"RefreshCw" as const,behavior:mode==="join"?popover("join"):{kind:"action" as const,onPress:async()=>{await model.refresh(id);if(mode==="choose"||mode==="loading")openMemory();else openStatus();}}};
    },
  });
  const unwatch=watchWorkspaces({list:options=>client.paseo.workspaces.list(options)},registry,message=>console.error(message));
  return async()=>{registry.dispose();model.dispose();await unwatch();};
}
