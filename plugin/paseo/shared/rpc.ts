import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const failure = z.object({ ok: z.literal(false), error: z.object({
  kind: z.enum(["unavailable", "unsupported", "outcome_unknown", "http_error"]),
  code: z.string(), message: z.string(), status: z.number().optional(),
}) });
export type Failure = z.infer<typeof failure>;
export type Result<T> = { ok: true; data: T } | Failure;
const result = <T extends z.ZodType>(data: T) => z.union([z.object({ ok: z.literal(true), data }), failure]);
const project = z.string().trim().min(1).max(512);
const instance = z.string().min(1).max(128);
export const binding = z.object({ project, instance_id: instance });
export const enrollment = binding.extend({ enrolled: z.boolean(), cloud_configured: z.boolean(), autosync_enabled: z.boolean() });
export type Enrollment = z.infer<typeof enrollment>;
export type Health = { instance_id: string; capabilities: Record<string, boolean> };
export const health = z.object({ instance_id: instance, capabilities: z.record(z.string(), z.boolean()).default({}) });
export const blockedProject = z.object({project:z.string(),code:z.string(),last_seen_at:z.string()});
export const status = z.object({
  blocked_projects:z.array(blockedProject).default([]),
  enabled: z.boolean(), phase: z.string(), last_error: z.string(), reason_code: z.string(), reason_message: z.string(),
  consecutive_failures: z.number().nonnegative(), dead_count: z.number().nonnegative(), deferred_count: z.number().nonnegative(),
  backoff_until: z.string().nullable(), last_sync_at: z.string().nullable(), last_success_at: z.string().nullable(),
  target: z.literal("cloud"), pending_count: z.number().nonnegative(), status_at: z.string(), paused: z.boolean(),
  cloud_configured: z.boolean(), autosync_enabled: z.boolean(), enrolled_count: z.number().nonnegative(), instance_id: instance,
  upgrade: z.object({ stage: z.string(), reason_code: z.string(), reason_message: z.string() }),
});
export type SyncStatus = z.infer<typeof status>;
export const resolvedProject = z.object({ project: z.string().nullable(), available_projects: z.array(z.string()).nullable(), project_source: z.string().optional() });
export const secretItem = z.object({ id: z.number().int().positive(), created_at: z.string(), session_id: z.string(), reason: z.string(), masked_context: z.string() });
export const scan = z.object({ items: z.array(secretItem), next_cursor: z.string(), complete: z.boolean(), scan_token: z.string() });
export type Scan = z.infer<typeof scan>;
export const observation = z.object({ id: z.number().int().positive(), title: z.string(), content: z.string().optional(), type: z.string().optional(), project: z.string().nullable().optional(), created_at: z.string().optional() });
export type Observation = z.infer<typeof observation>;
export const prompt = z.object({ id: z.number().int().positive(), content: z.string(), session_id: z.string(), created_at: z.string(), project: z.string().optional() });
export type Prompt = z.infer<typeof prompt>;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const empty = z.object({});
export const rpc = {
  health: defineRpc({ name: "health.probe", input: empty, output: result(health) }),
  status: defineRpc({ name: "status.get", input: z.object({ project: project.optional() }), output: result(status) }),
  resolve: defineRpc({ name: "project.resolve", input: z.object({ cwd: z.string().min(1) }), output: result(resolvedProject) }),
  enrollment: defineRpc({ name: "enroll.status", input: z.object({ project }), output: result(enrollment) }),
  scan: defineRpc({ name: "enroll.scan", input: z.object({ project, cursor: z.string().optional() }), output: result(scan) }),
  join: defineRpc({ name: "enroll.join", input: binding.extend({ scan_token: z.string().optional(), force: z.boolean().optional() }), output: result(enrollment) }),
  stop: defineRpc({ name: "enroll.stop", input: binding, output: result(enrollment) }),
  search: defineRpc({ name: "memory.search", input: z.object({ project, query: z.string().min(1) }), output: result(z.array(observation)) }),
  recent: defineRpc({ name: "memory.recent", input: z.object({ project }), output: result(z.array(observation)) }),
  get: defineRpc({ name: "memory.get", input: z.object({ project, id }), output: result(observation) }),
  deleteMemory: defineRpc({ name: "memory.delete", input: binding.extend({ id }), output: result(z.object({ status: z.literal("deleted") })) }),
  prompts: defineRpc({ name: "prompts.recent", input: z.object({ project }), output: result(z.array(prompt)) }),
  deletePrompt: defineRpc({ name: "prompts.delete", input: binding.extend({ id }), output: result(z.object({ status: z.literal("deleted") })) }),
};
