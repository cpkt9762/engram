import type { Result, SyncStatus } from "./rpc.ts";
export type Level = "red" | "yellow" | "gray" | "green";
function timestamp(value: string | null): number {
  if (!value) return NaN;
  const normalized = value.replace(" ", "T");
  return Date.parse(normalized + (/Z$|[+-]\d\d:\d\d$/.test(normalized) ? "" : "Z"));
}
export function statusLevel(result: Result<SyncStatus> | undefined, now = Date.now()): Level {
  if (!result) return "gray";
  if (!result.ok) return result.error.kind === "unsupported" ? "gray" : "red";
  const s = result.data;
  if ((s.blocked_projects ?? []).some(entry=>entry.code==="project_not_allowed") || s.consecutive_failures >= 3 || s.phase === "degraded" || ["auth_required", "policy_forbidden", "status_unavailable"].includes(s.reason_code) || (!s.cloud_configured && s.enrolled_count > 0)) return "red";
  const stamp = timestamp(s.status_at);
  const lastSuccess = timestamp(s.last_success_at);
  if (s.dead_count > 0 || s.paused || s.deferred_count > 0 || (s.backoff_until && timestamp(s.backoff_until) > now) || !Number.isFinite(stamp) || stamp < now - 120000 || (s.pending_count > 0 && (!Number.isFinite(lastSuccess) || lastSuccess < now - 600000))) return "yellow";
  if (!s.enrolled_count) return "gray";
  // A configured transport that is explicitly disabled is not healthy.
  if (!s.enabled || !s.autosync_enabled) return "yellow";
  return "green";
}

export function deadRecordNotice(count: number): string {
  return count > 0 ? `有 ${count} 条被放弃的远端变更，需要人工查看；这是保留的证据，不一定表示当前有故障` : "";
}

export function projectBlocked(status:Pick<SyncStatus,"blocked_projects">,project:string):boolean{
  return status.blocked_projects.some(entry=>entry.project===project&&entry.code==="project_not_allowed");
}
export function blockedProjectsNotice(projects:SyncStatus["blocked_projects"]):string{
  const names=projects.filter(entry=>entry.code==="project_not_allowed").map(entry=>entry.project);
  return names.length?`云端未放行：${names.join("、")}。需要在云端服务器的白名单里加入此项目。此处记录最近一次拒绝，放行后仍按现有退避等待下一次成功推送确认。`:"";
}
