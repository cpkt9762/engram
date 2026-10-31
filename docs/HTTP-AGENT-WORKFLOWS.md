# Compound agent workflows over HTTP

These local Go HTTP bridges use the existing store operations. They do not invoke MCP or implement memory algorithms in clients. All three routes use the existing optional Bearer-token mutation policy: when `ENGRAM_HTTP_TOKEN` is configured, supply `Authorization: Bearer <token>`. Session-owned servers also retain their whole-handler authentication.

Send exactly one JSON object. Each workflow request is limited to **1 MiB (1,048,576 bytes)**, including trailing JSON or whitespace. The decoder enforces this limit before workflow writes, after the existing authentication checks. Overflow detected while reading either the object or its trailing data returns HTTP 413 `{ "error": "body exceeds 1048576-byte limit", "code": "request_too_large" }`; malformed, empty, null, array or additional JSON values within the limit return HTTP 400 `invalid_arguments`. This is a transport resource limit, not a change to Store content rules.

Never automatically replay any of these POSTs after an uncertain network result or HTTP 500. The store's finalization retry journal is not a network retry policy.

## Consolidate observations

`POST /observations/consolidate`

```json
{"ids_to_delete":[1,2],"new_title":"Combined finding","new_content":"Caller-authored summary","expected_project":"my-project"}
```

Required: at least two positive exact JSON integer IDs (maximum 9007199254740991), nonempty `new_title`, `new_content`, and `expected_project`. Optional: string `type`, `topic_key`, `fingerprint`, boolean `confirm` (default false). Other fields are refused; project/session/scope overrides are not supported.

Preview returns HTTP 200 `{ "status": "preview", "plan": ... }`, without writes or write notifications. The plan contains `source_ids`, `sources`, `project`, `fingerprint`, and the resolved `survivor` projection. Repeat the exact reviewed arguments with `confirm:true` and its opaque `fingerprint` only after explicit confirmation. HTTP 201 returns `status:"consolidated"`, `plan`, persisted `survivor`, and `soft_deleted_ids`.

Refusals are `{ "error": "message", "code": "code", "plan": ... }` (plan optional). A stale fingerprint returns HTTP 409 `fingerprint_mismatch` with a replacement preview. Wrong expected owner returns HTTP 403 `project_mismatch`; invalid arguments return HTTP 400 `invalid_arguments`. Other known store refusals (duplicate/missing sources, cross-project inputs, provenance cycles or unresolved project ownership) return HTTP 400 `consolidation_refused`. Unexpected database or internal failures return HTTP 500 `{ "error": "consolidation failed", "code": "consolidation_failed" }`, without exposing internal error details. Never auto-confirm a replacement plan. Ownership, source drift, provenance, survivor construction, soft deletion, and local atomicity remain store-owned; local success does not promise remote visibility.

## Judge a batch

`POST /conflicts/judge-many`

```json
{"judgments":[{"judgment_id":"rel-existing","relation":"not_conflict","reason":"Different contexts","confidence":0.9}],"session_id":"existing-session"}
```

`judgments` must contain 1..32 raw items; optional shared `session_id` must be a string. Invalid batch envelope/size/shared-session type returns HTTP 400 `{ "error": "message" }`, without a `code` field, before any writes. Individual nonobjects, invalid field types, missing required fields, invalid verbs, or store failures are per-item errors. This distinction preserves MCP batch behavior: the batch is not atomic, and valid later items still run.

Each object uses `judgment_id`, `relation`, optional `reason`, `evidence`, and numeric `confidence` in [0,1]. Shared session provenance replaces per-item session provenance, including when omitted (empty provenance). Existing store verb validation applies.

HTTP 200 returns `{ "outcomes": [...] }` in input order. Every outcome has `index`, `judgment_id` (null when unavailable), and `status:"success"|"error"`. Success includes `relation` and `judgment_status`; errors include `error`. Known Store refusals (missing relation, invalid verb and cross-project relation) retain their existing messages; unexpected database or internal failures use `error:"judgment failed"`, without exposing internal details. These remain ordered per-item errors under HTTP 200, and later items still run. Successful items retain their individual transactions; no rollback or exactly-once guarantee is added.

## Finalize an existing session

`POST /sessions/{id}/finalize`

```json
{"project":"my-project","summary":"Goal: ...\nAccomplished: ...\nNext Steps: ..."}
```

Both fields must be nonempty strings. `project` asserts the existing session's canonical owner; it is not a reassignment. The path ID is exact, never trimmed or implicitly registered. Other fields, including MCP recovery tokens, are refused.

HTTP 200 returns `session_id`, `state:"finalized"|"already_finalized"`, `summary_id`, `summary_sync_id`, `already_finalized`, and `judgment_required:false`. A valid local retry retains the original summary identity even if the new summary text differs, without writes or notification. The store atomically saves the session-summary observation, ends the session, queues normal sync mutations, and journals the local identity; legacy session free-text summary is preserved.

Unknown session: HTTP 404 `unknown_session`. Foreign owner: HTTP 403 `session_project_mismatch`. A session ended separately: HTTP 409 `session_already_ended`. Empty/invalid content: HTTP 400 `invalid_arguments`. Blank session identity returns HTTP 400 `session_finalize_failed`. Unexpected database or internal failures return HTTP 500 with generic `error:"session finalization failed"`, `code:"session_finalize_failed"`, and `session_id`, without exposing internal error details; they must not be treated as a confirmed client refusal or a reason to replay automatically. Refusals contain string `error` and `code`, and store refusals and internal failures also carry `session_id`. The journal is local-only, not replicated/exported.

## Transport differences

Consolidation arguments and plan projections are shared pure Go helpers; batch argument validation and single-judge parameter projection are also shared with MCP. Store behavior is authoritative. HTTP uses status codes and a flat string `error`; decoding, consolidation and finalization errors also include `code`, while batch-envelope validation errors omit it and per-item errors remain within `outcomes`. MCP retains its existing tool-result/error envelopes and queue. HTTP finalization requires an explicit project owner instead of copying MCP project-resolution/recovery-token semantics. No claim of identical transport envelopes or automatic network replay is made.

## Local sync administration

`GET /health` advertises both `capabilities["sync-admin-v1"]` and `capabilities["sync-admin-v2"]`. These management routes
are outside the memory runtime projection; Pi and DSH contract artifacts are unchanged.

`GET /sync/enrollment?project=P` returns the normalized project, `enrolled`,
`cloud_configured` (valid cloud URL plus token), `autosync_enabled` (explicit
`ENGRAM_CLOUD_AUTOSYNC=1`), and local database `instance_id`. A project with no
stored records is valid and initially unenrolled. Configuration failures return 503
`cloud_config_error` without credential details.

`GET /prompts/secret-scan?project=P&cursor=C` returns masked `items` with `id`,
`created_at`, `session_id`, `reason`, `masked_context`, plus `next_cursor`,
`complete`, and `scan_token`. Each page scans at most 100 source rows. Continue
until complete, even if an intermediate page contains no matches. The cursor and
token bind the project and ordered prompt contents to one snapshot; a changed
snapshot returns 409 `scan_stale`. Malformed cursor structure, token encoding, or
row offset returns 400 `scan_failed`; storage failures return 500 `scan_unavailable`.
Prompt rows have no modification timestamp,
so content participates in the snapshot hash. Context is capped at 400 characters.
Detection covers fixed credential formats, explicit assignments (including English
`is`, retaining the four-character assignment rule), and Chinese `密码`/`口令`
immediately followed by an ASCII visible token of at least four characters,
with only whitespace or `是`/`为`/`:`/`=`/`：` between them. Chinese immediate
values can be purely alphabetic. English keywords still require an explicit
connector or a password-like value: `password policy`, `token budget` and
`secret key` remain unchanged. Detection also covers nearby values whose
start is within 60 Unicode characters after a credential keyword. Nearby values
need at least six characters and either letters plus digits or special symbols;
connectors/whitespace may be absent, including Chinese and English adjacency.
For conversation replies, a whole line containing one ASCII token of 6–64
characters with both letters and digits is also checked if its value starts
within the next 600 Unicode characters after a keyword. Optional `[User]`,
`[用户]`, `User:` or `用户：` prefixes, surrounding spaces/tabs and CRLF are supported.
Standalone words without a preceding keyword are not matched by this rule.
Obvious URLs and absolute/relative paths are excluded from the heuristic. The
window never truncates a detected token: its complete value is masked, even when
it ends beyond the window. This deliberately favors display privacy over avoiding
false positives. Project/architecture names without keywords are unaffected.
Detection masks whole values,
and does not guarantee detection of every secret or scan observation contents.
This projection is shared by masked prompt lists, secret scan and status/error
text; it never changes stored prompt content or storage redactSecrets.

`POST /sync/enrollment` accepts `project`, required `instance_id`, and either
`scan_token` or explicit `force:true`. It validates the snapshot and performs the
existing enrollment/backfill in one transaction. Existing enrollment is idempotent.
An instance mismatch returns 409 `instance_mismatch`; a stale/missing token returns
409 `scan_stale`. Success means enrolled locally and waiting for autosync, not
confirmed cloud transmission. Invalid project names and the reserved inbox project
return 400; storage failures return 500 `enrollment_unavailable`. After a lost response, read enrollment status before
making another decision. Enrollment does not trigger immediate network transmission.

`DELETE /sync/enrollment?project=P&instance_id=I` requires a matching instance,
uses the same local admin policy as enrollment POST (no Content-Type requirement
because DELETE has no body), calls the existing idempotent `UnenrollProject`, and
returns the GET enrollment shape. v2 is required for this operation; v1 remains
advertised for existing clients. Unenrollment does not delete uploaded cloud data.

Verified using a temporary HTTP Go server, real store/auto-sync manager and a
loopback fake cloud: queued mutations remain unacknowledged but lose upload
eligibility; inbound mutations still arrive and apply; new records created while
stopped are backfilled on re-enrollment. A retained non-enrolled backlog can make
auto-sync report an outbound block. An already acknowledged same-project
observation edited while stopped is **not** automatically re-uploaded on
re-enrollment, because the existing backfill predicate treats its acknowledged
history as coverage. This switch does not cancel already dispatched requests.

The POST and secret scan use optional Bearer authentication, loopback `Host`
(`localhost` or a loopback IP), and reject any `Origin` header, including an empty
header. POST requires `Content-Type: application/json` and one object of at most
8 KiB. Policy errors return `loopback_required`, `origin_forbidden`, or `json_required`.
This policy permits local processes and is not a protection against local code.

`GET /prompts/recent` and `/prompts/search` accept optional `masked=1`; other
clients retain their existing projection. `DELETE /prompts/{id}` accepts optional
`expected_project`, checked in the deletion transaction, with 409 `project_mismatch`
on mismatch. Both prompt and observation deletion accept optional `instance_id`
and reject 409 `instance_mismatch` before mutation; observation deletion still
requires its existing `expected_project`. Legacy calls retain their behavior.

`GET /sync/status` adds `target:"cloud"`, nonnegative `pending_count` (only
unacknowledged mutations with disposition `pending` on exactly target `cloud`),
`last_success_at` (nullable persisted timestamp from exactly `sync_state.cloud`),
`status_at` (UTC RFC3339 response timestamp), boolean `paused`, `cloud_configured`,
`autosync_enabled`, nonnegative `enrolled_count`, and `instance_id`. Project-scoped
`cloud:P` rows are not counted. Existing provider phase and counters remain intact;
no provider means disabled and retains `message:"background sync is not configured"`.
Cloud configuration errors keep HTTP 200, set `cloud_configured:false` and
`reason_code:"cloud_config_error"`, and expose a masked `reason_message`; database
read failures still return HTTP 500. Error and reason text use the display masking rules.
A healthy transport status does not prove that an old client has not overwritten data.


`GET /sync/status` also returns `blocked_projects: [{project, code:
"project_not_allowed", last_seen_at}]` (an empty array when absent). These are
in-memory observations of project allowlist denials from the most recent push
attempt; only currently enrolled projects are exposed. Typed HTTP 403 errors are
checked first. The explicit `project_not_allowed` error code is recognized; legacy
`policy_forbidden`/uncoded responses additionally must have the exact decoded body
`forbidden: project %q is not allowed`, matching the attempted project. Generic
403s are not treated as project allowlist failures. The timestamp is UTC.

The next successful push clears this evidence; after a server allowlist change it
therefore clears when the existing retry schedule next confirms success, not
immediately. Local unenrollment clears the project's display evidence immediately.
Restarted managers start with no historical evidence. Failure counters and backoff
are unchanged. The plugin shows “云端未放行”, names the affected projects, and asks
for a cloud allowlist change; it never changes the cloud server or retry behavior.
