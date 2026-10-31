import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
export const fakeSecret = 'Zq9-FAKE-SECRET';
export const healthy = (overrides = {}) => ({ blocked_projects: [], enabled: true, phase: 'healthy', last_error: '', reason_code: '', reason_message: '', consecutive_failures: 0, dead_count: 0, deferred_count: 0, backoff_until: null, last_sync_at: null, last_success_at: new Date().toISOString(), target: 'cloud', pending_count: 0, status_at: new Date().toISOString(), paused: false, cloud_configured: true, autosync_enabled: true, enrolled_count: 1, instance_id: 'instance-a', upgrade: { stage: '', reason_code: '', reason_message: '' }, ...overrides });
export async function fakeServer(t, handler) {
 const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
 return { server, url: `http://127.0.0.1:${server.address().port}` };
}
export function json(res, body, status = 200) { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); }
export function guardNetwork(t) {
 const original = net.Socket.prototype.connect; const destinations = [];
 net.Socket.prototype.connect = function(...args) {
   const first = Array.isArray(args[0]) ? args[0][0] : args[0];
   const opts = typeof first === 'object' ? first : {host: args[1] ?? 'localhost'};
   const host = opts.host ?? opts.hostname ?? 'localhost';
   assert.ok(host === 'localhost' || host === '::1' || /^127\./.test(host), `non-loopback destination: ${host}`);
   destinations.push(host);
   return Reflect.apply(original, this, args);
 };
 t.after(() => { net.Socket.prototype.connect = original; assert.ok(destinations.length > 0); });
 return destinations;
}
