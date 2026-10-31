import { type RpcInput, type RpcOutput } from "@getpaseo/plugin";
import { rpc } from "../shared/rpc.ts";
import { EngramClient, EngramError, failure } from "./engram.ts";

type Key = keyof typeof rpc;
export async function handle<K extends Key>(key: K, input: RpcInput<(typeof rpc)[K]>, client: EngramClient): Promise<RpcOutput<(typeof rpc)[K]>> {
  try {
    // Host validation runs too; this makes the module independently testable.
    const args = rpc[key].input.parse(input) as Record<string, unknown>;
    if (key !== "health" && key !== "resolve") await client.requireAdmin(key === "stop" || key === "join" ? "sync-admin-v2" : "sync-admin-v1");
    const q = (values: Record<string, unknown>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    const { project, instance_id, id } = args;
    let data: unknown;
    switch (key) {
      case "health": data = await client.probe(); break;
      case "status": data = await client.request(`/sync/status?${q({ project })}`); break;
      case "resolve": data = await client.request(`/project/current?${q({ cwd: args.cwd })}`); break;
      case "enrollment": data = await client.request(`/sync/enrollment?${q({ project })}`); break;
      case "scan": data = await client.request(`/prompts/secret-scan?${q({ project, cursor: args.cursor })}`); break;
      case "join": data = await client.request("/sync/enrollment", "POST", args); break;
      case "stop": data = await client.request(`/sync/enrollment?${q({ project, instance_id })}`, "DELETE"); break;
      case "search": data = await client.request(`/search?${q({ project, q: args.query, limit: 50 })}`); break;
      case "recent": data = await client.request(`/observations/recent?${q({ project, limit: 50 })}`); break;
      case "get": {
        data = await client.request(`/observations/${id}`);
        if ((data as {project?: unknown})?.project !== project) throw new EngramError("http_error", "project_mismatch", 409);
        break;
      }
      case "deleteMemory": data = await client.request(`/observations/${id}?${q({ expected_project: project, instance_id })}`, "DELETE"); break;
      case "prompts": data = await client.request(`/prompts/recent?${q({ project, limit: 50, masked: 1 })}`); break;
      case "deletePrompt": data = await client.request(`/prompts/${id}?${q({ expected_project: project, instance_id })}`, "DELETE"); break;
    }
    return rpc[key].output.parse({ ok: true, data }) as RpcOutput<(typeof rpc)[K]>;
  } catch (error) { return failure(error) as RpcOutput<(typeof rpc)[K]>; }
}
