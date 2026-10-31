import http from "node:http";
import { isIP } from "node:net";
import { health, type Failure } from "../shared/rpc.ts";

export class EngramError extends Error {
  readonly kind: Failure["error"]["kind"];
  readonly code: string;
  readonly status?: number;
  constructor(kind: Failure["error"]["kind"], code: string, status?: number) {
    super(code); this.kind = kind; this.code = code; this.status = status;
  }
}
export function loopbackUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new EngramError("http_error", "invalid_base_url"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ipv4 = isIP(host) === 4 && host.split(".")[0] === "127";
  if (url.protocol !== "http:" || (!ipv4 && host !== "::1" && host !== "localhost") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new EngramError("http_error", "loopback_required");
  }
  // Never resolve localhost through DNS, proxies or a user-supplied resolver.
  if (host === "localhost") url.hostname = "127.0.0.1";
  return url;
}
export class EngramClient {
  private cache?: { value: ReturnType<typeof health.parse>; until: number };
  readonly url: URL;
  private token: string;
  private timeoutMs: number;
  private now: () => number;
  constructor(baseUrl: string, token = "", timeoutMs = 5000, now = Date.now) {
    this.url = loopbackUrl(baseUrl); this.token = token; this.timeoutMs = timeoutMs; this.now = now;
  }
  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new EngramError("http_error", "invalid_path");
    const url = new URL(path, this.url);
    if (url.origin !== this.url.origin) throw new EngramError("http_error", "invalid_path");
    const write = method !== "GET";
    return new Promise((resolve, reject) => {
      let dispatched = false;
      let responded = false;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const req = http.request(url, { method, headers, agent: false }, res => {
        responded = true;
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { req.destroy(); reject(new EngramError(write ? "outcome_unknown" : "http_error", "response_too_large")); }
          else chunks.push(chunk);
        });
        res.on("error", () => { clearTimeout(timer); reject(new EngramError(write ? "outcome_unknown" : "unavailable", "response_lost")); });
        res.on("aborted", () => reject(new EngramError(write ? "outcome_unknown" : "unavailable", "response_lost")));
        res.on("end", () => {
          clearTimeout(timer);
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            let code = "http_error";
            try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (typeof value.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value.code)) code = value.code; } catch { /* Error bodies are never exposed. */ }
            reject(new EngramError("http_error", code, res.statusCode)); return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { reject(new EngramError(write ? "outcome_unknown" : "http_error", "invalid_response")); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error("deadline")), this.timeoutMs);
      req.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const uncertain = write && dispatched && error.code !== "ECONNREFUSED";
        reject(new EngramError(uncertain ? "outcome_unknown" : "unavailable", responded ? "response_lost" : "connection_failed"));
      });
      req.once("close", () => clearTimeout(timer));
      dispatched = true;
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async probe() {
    if (this.cache && this.cache.until > this.now()) return this.cache.value;
    this.cache = undefined;
    const parsed = health.safeParse(await this.request("/health"));
    if (!parsed.success) throw new EngramError("http_error", "invalid_health");
    this.cache = { value: parsed.data, until: this.now() + 60000 };
    return parsed.data;
  }
  async requireAdmin(capability = "sync-admin-v1") {
    const info = await this.probe();
    if (!info.capabilities[capability]) throw new EngramError("unsupported", "engram_too_old");
    return info;
  }
}
export function failure(error: unknown): Failure {
  const e = error instanceof EngramError ? error : new EngramError("http_error", "invalid_response");
  const messages = { unavailable: "engram 服务不可用", unsupported: "engram 版本太旧", outcome_unknown: "写入结果待确认，请检查实际状态", http_error: "engram 请求被拒绝或响应无效" };
  return { ok: false, error: { kind: e.kind, code: e.code, message: messages[e.kind], ...(e.status ? { status: e.status } : {}) } };
}
