import type { PluginClientContext } from "@getpaseo/plugin/client";
import { StatusItem, StatusDetails } from "./client/status.tsx";
import { Settings } from "./client/settings.tsx";
import { MemoryPanel } from "./client/memory-panel.tsx";
import {workspaceSync} from "./shared/sync-model.ts";
import {rpc} from "./shared/rpc.ts";
import {contributeHeaders} from "./client/headers.tsx";
export default function contribute(client: PluginClientContext) {
  const model=workspaceSync({
    syncStatus:()=>client.rpc(rpc.status,{}),
    resolve:cwd=>client.rpc(rpc.resolve,{cwd}),health:()=>client.rpc(rpc.health,{}),status:args=>client.rpc(rpc.enrollment,args),
    scan:args=>client.rpc(rpc.scan,args),join:args=>client.rpc(rpc.join,args),stop:args=>client.rpc(rpc.stop,args),deletePrompt:args=>client.rpc(rpc.deletePrompt,args),
  });
  const removeHeaders=contributeHeaders(client,model);
  const cleanups = [
    client.addWorkspacePanel({ id: "memory", title: "engram 记忆", icon: "Database", context: "workspace", Component: props => <MemoryPanel {...props} model={model} openMemory={()=>client.openPanel("memory",{workspaceId:props.workspaceId})} openStatus={()=>client.openScreen({screenId:"sync"})} /> }),
    client.addCommandCenterItem({ id: "open-memory", title: "打开 engram 记忆", icon: "Database", context: "workspace", onSelect({ openPanel }) { openPanel("memory"); } }),
    client.addSettingsScreen({ id: "engram", title: "engram", icon: "Database", Component: Settings }),
    client.addSidebarFooterItem({ id: "sync", title: "engram 同步", Component: StatusItem }),
    client.addScreen({ id: "sync", title: "engram 同步状态", Component: StatusDetails }),
  ];
  return async () => {cleanups.forEach(cleanup => cleanup());await removeHeaders();};
}
