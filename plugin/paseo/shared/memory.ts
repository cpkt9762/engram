import type { Enrollment, Observation, Prompt, Result, Scan } from "./rpc.ts";
export type MemoryRow = { id: number; kind: "memory" | "prompt"; title: string; text: string };
export type ProjectSelection = { project: string; choices: string[] };
export function selectProject(value: { project: string | null; available_projects: string[] | null }): ProjectSelection {
  const choices = value.available_projects ?? [];
  return { project: choices.length ? "" : value.project ?? "", choices };
}
export function memoryRows(rows: Observation[]): MemoryRow[] { return rows.map(row => ({ id: row.id, kind: "memory", title: row.title, text: row.content ?? "" })); }
export function promptRows(rows: Prompt[]): MemoryRow[] { return rows.map(row => ({ id: row.id, kind: "prompt", title: `${row.created_at} · ${row.session_id}`, text: row.content })); }
export const deletionWarning = (enrolled: boolean) => enrolled
  ? "本项目已加入同步，删除会同步到其他机器。确定删除这条记录？"
  : "本项目尚未加入同步，删除标记会在以后加入同步时带到其他机器。确定删除这条记录？";
const stale = (): Result<never> => ({ ok: false, error: { kind: "http_error", code: "view_changed", message: "项目或实例已变化，请重新载入" } });
export function sameBinding(a: Pick<Enrollment, "project" | "instance_id">, b: Pick<Enrollment, "project" | "instance_id">): boolean {
  return a.project === b.project && a.instance_id === b.instance_id;
}
// The controller owns the current view, not a persistence ledger. Mutation inputs
// remain bound to the confirmation's original project and database instance.
export function memoryController(api: {
  deleteMemory(input: { project: string; instance_id: string; id: number }): Promise<Result<{ status: "deleted" }>>;
  deletePrompt(input: { project: string; instance_id: string; id: number }): Promise<Result<{ status: "deleted" }>>;
}) {
  let current: Enrollment | undefined;
  return {
    bind(value: Enrollment | undefined) { current = value; },
    async remove(row: MemoryRow, confirmed: Enrollment): Promise<Result<{ status: "deleted" }>> {
      if (!current || !sameBinding(current, confirmed)) return stale();
      const args = { project: confirmed.project, instance_id: confirmed.instance_id, id: row.id };
      return row.kind === "memory" ? api.deleteMemory(args) : api.deletePrompt(args);
    },
  };
}
export async function scanAll(project: string, scan: (args: {project: string; cursor?: string}) => Promise<Result<Scan>>): Promise<Result<Scan>> {
  let cursor: string | undefined;
  let token: string | undefined;
  const seen = new Set<string>();
  const items: Scan["items"] = [];
  for (;;) {
    const page = await scan({ project, ...(cursor ? { cursor } : {}) });
    if (!page.ok) return page;
    if (token && token !== page.data.scan_token) return { ok: false, error: { kind: "http_error", code: "scan_stale", message: "扫描之后又有新的 prompt，请重新扫描" } };
    token = page.data.scan_token;
    items.push(...page.data.items);
    if (page.data.complete) return { ok: true, data: { ...page.data, items } };
    if (!page.data.next_cursor || seen.has(page.data.next_cursor)) return { ok: false, error: { kind: "http_error", code: "invalid_cursor", message: "扫描分页无效" } };
    seen.add(page.data.next_cursor); cursor = page.data.next_cursor;
  }
}
