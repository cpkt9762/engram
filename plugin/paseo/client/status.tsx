import type { PluginSidebarItemProps, PluginPopoverProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { rpc, type Result, type SyncStatus } from "../shared/rpc.ts";
import { statusLevel, deadRecordNotice, blockedProjectsNotice } from "../shared/status.ts";

function useStatus(host: string) {
  const get = useRpc(rpc.status);
  const [result, setResult] = useState<Result<SyncStatus>>();
  useEffect(() => {
    let active = true; let busy = false;
    setResult(undefined);
    const refresh = async () => {
      if (busy) return; busy = true;
      try { const value = await get({}); if (active) setResult(value); }
      catch { if (active) setResult({ ok: false, error: { kind: "unavailable", code: "rpc_unavailable", message: "engram 服务不可用" } }); }
      finally { busy = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 30000);
    return () => { active = false; clearInterval(timer); };
  }, [get, host]);
  return result;
}
export function StatusDetails({ theme, layout, host }: PluginPopoverProps | PluginScreenProps) {
  const result = useStatus(host.id);
  const ranges = "target=cloud；pending/dead/deferred/enrolled_count 为非负数；时间为 UTC，last_success_at 可为空；paused/enabled/cloud_configured/autosync_enabled 为布尔值。";
  return <ScrollView style={{ backgroundColor: theme.colors.surface0, padding: layout.compact ? 12 : 20 }}>
    <Text style={{ color: theme.colors.foreground }}>engram @ {host.label}</Text>
    <Text style={{ color: theme.colors.foreground }}>{result ? JSON.stringify(result.ok ? result.data : result.error, null, 2) : "正在读取同步状态…"}</Text>
    {result?.ok && result.data.dead_count > 0 ? <Text style={{ color: theme.colors.statusWarning }}>{deadRecordNotice(result.data.dead_count)}</Text> : null}
    {result?.ok && result.data.blocked_projects.length>0?<Text style={{color:theme.colors.statusDanger}}>{blockedProjectsNotice(result.data.blocked_projects)}</Text>:null}
    <Text style={{ color: theme.colors.foregroundMuted }}>{ranges}</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>绿色只说明传输正常，不能说明内容没有被旧客户端覆盖</Text>
  </ScrollView>;
}
export function StatusItem(props: PluginSidebarItemProps) {
  const result = useStatus(props.host.id);
  const level = statusLevel(result);
  const c = props.theme.colors;
  const color = { red: c.statusDanger, yellow: c.statusWarning, gray: c.foregroundMuted, green: c.statusSuccess }[level];
  const label = { red: "异常", yellow: "等待", gray: "未启用", green: "正常" }[level];
  return <SidebarRow icon="Database" label={`engram @ ${props.host.label}${result?.ok && result.data.blocked_projects.length?` · 云端未放行：${result.data.blocked_projects.map(entry=>entry.project).join("、")}`:""}`} onPress={() => props.openPopover(StatusDetails)} trailing={<View><Text style={{ color }}>{label}</Text></View>} />;
}
