import type {PluginHostProps} from "@getpaseo/plugin/client";
import {useEffect,useRef,useState,useSyncExternalStore} from "react";
import {Pressable,ScrollView,Text,View} from "react-native";
import {stopWarning,type WorkspaceSync} from "../shared/sync-model.ts";
import type {Enrollment} from "../shared/rpc.ts";
export function SyncActions({model,enrollment,v2,theme,layout,host,openMemory,openStatus,close,blocked=false,intent="panel"}:{model:WorkspaceSync;enrollment:Enrollment;v2:boolean;theme:PluginHostProps["theme"];layout:PluginHostProps["layout"];host:PluginHostProps["host"];openMemory:()=>void;openStatus:()=>void;close?:()=>void;blocked?:boolean;intent?:"join"|"stop"|"panel"}){
  const binding={project:enrollment.project,instance_id:enrollment.instance_id};
  const state=useSyncExternalStore(model.subscribe,()=>model.action(binding));
  const [confirming,setConfirming]=useState(intent==="stop"),[deleteId,setDeleteId]=useState(undefined as number|undefined);
  const started=useRef(false),closeRef=useRef(close);closeRef.current=close;
  useEffect(()=>{
    if(intent==="join"&&!started.current){started.current=true;if(["prompt","error"].includes(model.action(binding).enroll.phase))void model.begin(binding);}
  },[model,enrollment.project,enrollment.instance_id,intent]);
  useEffect(()=>{if(intent==="join"&&state.enroll.phase==="joined")closeRef.current?.();},[state.enroll.phase,intent]);
  const busy=state.checking || state.stopping || ["scanning","joining"].includes(state.enroll.phase),c=theme.colors;
  const button=(label:string,action:()=>void,disabled=busy)=><Pressable key={label} accessibilityRole="button" disabled={disabled} onPress={action} style={{padding:8,opacity:disabled?0.5:1}}><Text style={{color:c.accent}}>{label}</Text></Pressable>;
  const stop=()=>{void model.stop(binding).then(()=>{const value=model.action(binding);if(!value.stopUnknown && value.message==="本机已停止上传，仍接收远端变更"){setConfirming(false);closeRef.current?.();}});};
  return <ScrollView contentContainerStyle={{padding:layout.compact?12:20,gap:8}} style={{backgroundColor:c.surface0}}>
    <Text style={{color:c.foreground}}>{enrollment.project} @ {host.label} · {enrollment.enrolled?"本机已加入同步":"本机尚未加入同步"}</Text>
    {blocked?<Text style={{color:c.statusDanger}}>云端未放行：{enrollment.project}。需要在云端服务器的白名单里加入此项目。</Text>:null}
    {state.message?<Text style={{color:c.foreground}}>{state.message}</Text>:null}
    {state.enroll.message?<Text style={{color:state.enroll.phase==="error"?c.statusDanger:c.foreground}}>{state.enroll.message}</Text>:null}
    {!enrollment.cloud_configured?<View><Text style={{color:c.foregroundMuted}}>未配置云同步</Text>{button("查看同步状态",openStatus)}</View>:null}
    {!v2?<Text style={{color:c.statusWarning}}>engram 版本太旧，加入和停止同步需要 sync-admin-v2</Text>:null}
    {state.stopUnknown?button("重新确认停止结果",()=>void model.confirmStop(binding)):null}
    {confirming && !state.stopUnknown?<View>
      <Text style={{color:c.foreground}}>{stopWarning(enrollment.project,host.label)}</Text>
      {button("停止同步",stop,busy||!v2)}
      {button("取消",()=>{setConfirming(false);closeRef.current?.();})}
    </View>:null}
    {!confirming && enrollment.cloud_configured?<View>
      {enrollment.enrolled?button("停止同步",()=>setConfirming(true),busy||!v2):null}
      {!enrollment.enrolled && ["prompt","error","joined"].includes(state.enroll.phase)?button("加入同步",()=>void model.begin(binding),busy||!v2):null}
      {button("打开 engram 记忆",openMemory)}{button("查看同步状态",openStatus)}
    </View>:null}
    {busy?<Text style={{color:c.foregroundMuted}}>正在处理…</Text>:null}
    {state.enroll.phase==="pending_confirm"?button("重新确认加入结果",()=>void model.confirmJoin(binding)):null}
    {state.enroll.phase==="review"?<View style={{gap:8}}>
      <Text style={{color:c.foregroundMuted}}>只扫描 prompt，可能漏检，也不检查记忆正文。是否删除由你决定。</Text>
      {state.enroll.items.map(item=><View key={item.id} style={{borderWidth:1,borderColor:c.border,padding:8}}>
        <Text style={{color:c.foreground}}>{item.created_at} · {item.session_id} · {item.reason}</Text>
        <Text style={{color:c.foregroundMuted}}>{item.masked_context}</Text>
        {button(`删除疑似项 #${item.id}`,()=>setDeleteId(item.id))}
      </View>)}
      {deleteId!==undefined?<View><Text style={{color:c.foreground}}>确认删除 prompt #{deleteId}？删除标记会在加入同步时带到其他机器。</Text>{button("确认删除疑似项",()=>{const id=deleteId;setDeleteId(undefined);void model.removePrompt(binding,id);})}{button("取消删除疑似项",()=>setDeleteId(undefined))}</View>:null}
      {button("重新扫描后加入",()=>void model.begin(binding,true))}{button("仍然加入",()=>void model.force(binding))}{button("先不加入",()=>{model.cancel(binding);closeRef.current?.();})}
    </View>:null}
  </ScrollView>;
}
