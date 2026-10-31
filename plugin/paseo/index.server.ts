import type { RpcInput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { rpc } from "./shared/rpc.ts";
import { preferences } from "./shared/settings.ts";
import { EngramClient, EngramError, failure } from "./server/engram.ts";
import { handle } from "./server/handlers.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  let current: { base: string; client: EngramClient } | undefined;
  const client = async () => {
    const value = await settings.read();
    if (value.status !== "ready") throw new EngramError("http_error", "settings_unavailable");
    if (!current || current.base !== value.values.baseUrl) current = { base: value.values.baseUrl, client: new EngramClient(value.values.baseUrl, process.env.ENGRAM_HTTP_TOKEN) };
    return current.client;
  };
  const execute = async <K extends keyof typeof rpc>(key: K, input: RpcInput<(typeof rpc)[K]>) => {
    try { return await handle(key, input, await client()); } catch (error) { return failure(error); }
  };
  server.handle(rpc.health, input => execute("health", input));
  server.handle(rpc.status, input => execute("status", input));
  server.handle(rpc.resolve, input => execute("resolve", input));
  server.handle(rpc.enrollment, input => execute("enrollment", input));
  server.handle(rpc.scan, input => execute("scan", input));
  server.handle(rpc.join, input => execute("join", input));
  server.handle(rpc.search, input => execute("search", input));
  server.handle(rpc.recent, input => execute("recent", input));
  server.handle(rpc.get, input => execute("get", input));
  server.handle(rpc.deleteMemory, input => execute("deleteMemory", input));
  server.handle(rpc.prompts, input => execute("prompts", input));
  server.handle(rpc.deletePrompt, input => execute("deletePrompt", input));
  server.handle(rpc.stop, input => execute("stop", input));
  return () => { current = undefined; };
}
