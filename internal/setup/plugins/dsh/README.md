# Engram for DeepSeek Harness

Native DSH adapter for all 23 operations in the generated runtime contract:
project/context/search, observation save/get/update/pin, prompt save/search,
session start/end/summary/finalize, passive extraction, review, relation judgments,
comparison, consolidation, topic-key suggestion, project listing and doctor.
Uses the shared local Engram HTTP server and Pi runtime contract. No runtime
dependencies. Requires Node >=22.18 and DSH 0.2.0-rc.2.

Install only through a `link:` to an absolute checkout path:

```sh
dsh plugin --profile acp add <absolute-path>/plugin/dsh
```

Do not copy the TypeScript files into `node_modules`: Node cannot strip types
there. Do not install alongside dsh-gentle-engram or an Engram MCP entry;
conflicting tool names fail plugin startup.

Configuration fields: `url`, `port` (number), `engramBin`. Environment fallbacks:
`ENGRAM_URL`, `ENGRAM_PORT` (default 7437), `ENGRAM_BIN` (default `engram`).
`ENGRAM_HTTP_TOKEN` supplies HTTP authentication, exclusively from the environment.
Persistent contract, ownership, resume-capability and project-configuration
failures are logged at error level once per distinct reason, so default DSH
logging shows them. Transient capture failures and drain timeouts remain warnings.
Logs redact the HTTP token and private blocks.
An explicit URL skips local ownership checks and process startup. Otherwise only
a refused loopback connection permits spawning `engram serve`, with ENGRAM_PORT
forwarded. The shared process inherits the DSH environment and survives plugin
unload; this adapter never kills it. If implicit serve stops, definite refusal
invalidates initialization: the current request fails, a later call rechecks
ownership and may restart serve. Explicit URLs never trigger process startup.

The implicit project cwd comes only from `agent.session.header.cwd`. Explicit
write cwd targets are resolved through Engram; session-start directory remains a
host-directory assertion. Reads default to the detected project; search,
prompt search, context and review list accept `all_projects: true` for all projects.
Only explicit `project`/`cwd` on mem_save, mem_save_prompt, mem_session_summary
and mem_session_finalize may target another project. These use isolated
`<agent-id>@<project>` satellite sessions; implicit writes always use the root.
A supplied project must agree with the cwd-detected project. Satellite registration
requires isolated_session_registration on every attempt, omits directory, adopts
the acknowledged id and renews after 60 seconds. Native session end confirms root
first, then ends all registered satellites and invalidates their identities.
Partial cleanup errors report that root already ended; an explicit retry finishes
failed cleanup without pretending to roll back root. Explicit foreign finalization
closes only that satellite. By-id tools still qualify the runtime and project; Go enforces ownership
and verdict rules. Project resolution failures block tools. Blank optional strings are treated as
omitted (including nested fields); required strings still reject blank text.
Boolean and numeric options retain their original meaning. For `mem_update`, a
nonblank `find` preserves the literal `replace` value, including an empty string
for deletion. An empty or omitted `find` also omits `replace`.

Sessions register lazily, require `root_session_resume`, and renew after 60 seconds.
Engram accepts writes to ended sessions: when another client ends the root, writes
during the renewal window still use the cached root. Renewal selects the
server-issued `<agent-id>:resume:N`. `mem_session_end` invalidates the cached
identity after confirmed success, so the next write registers a continuation
immediately. Session start/end accept only optional assertions of the calling
agent id, never arbitrary model identities. Agent disposal only clears local
state; it never ends a session.

Finalization pins the acknowledged effective id and atomically records a summary
and ends that session. Unknown end/finalize outcomes block new writes; only an
explicit retry of the same close tool may resolve that identity. Confirmed finalization invalidates the cached identity like end; the next write
registers a server-issued continuation, so the same DSH agent can keep working.
A timed out or unreadable write acknowledgement is unknown: verify the result
before retrying, rather than blindly issuing another write.

Doctor calls both diagnostic endpoints without registering a session, reporting
appendEntry/branch availability as false. Diagnostic failures are exposed.
Review lists default to the current project, unlike Pi's implicit global list.
Consolidation previews first; confirmation requires the exact Go-issued
fingerprint and explicit `confirm: true`. The adapter never auto-confirms or
replays an uncertain consolidation write. Batch judgments preserve Go's per-item results.

The plugin injects one fixed Memory Protocol section. New sessions do not
automatically inject historical memory; the protocol requires calling
`mem_context` first. Protocol and recovery context registrations belong to the
plugin scope, so unloading removes them together with the tools.

Eligible user inbox text is private-tag redacted before trimming/truncation to
2000 characters and saved as a prompt; short inputs, synthetic sources and
subagent sessions are skipped. `mem_save` includes the current prompt only for
the same turn, project and effective session, unless `capture_prompt: false`.
Go owns prompt deduplication. Eligible successful top-level non-Engram tool
results are private-tag redacted before the 50-character threshold and sent to
Go for passive extraction with the original tool name as source; nested PTC calls and subagents
are skipped. Final assistant replies are not automatically captured.

A compaction summary is archived as `session_summary`, with topic key
`session/compaction-recovery`. A bounded event cache suppresses duplicate
compaction notifications. Agent-local recovery notices distinguish Confirmed,
Unknown, Failed and Unavailable; notices contain no summary or user content.
A notice remains pending until delivered and the agent stops its turn.

Background captures and explicit memory mutations share a serial queue per
agent. Turn stopping drains for at most 5 seconds; a failure does not poison
later work. Disposal discards unstarted work and clears local state without
ending the shared server session. Already dispatched writes may still finish;
unload does not terminate the shared serve process.

Unsupported: `ENGRAM_SERVER_MODE=session-owned`, `ENGRAM_STARTUP_POLICY` (neither
is read). `engram setup dsh` is handled by a separate integration task.
Real Cordis mounting is tested below; live DSH/profile smoke verification
remains separate.

Development: `npm install --ignore-scripts`, `npm run typecheck`, `npm test`.
Tests isolate HOME and ENGRAM state and build the existing Pi real-server fixture
with Go; no DSH profile or installed Engram is changed.

Real host integration tests load Cordis, tools, system-prompt and scope from a
single installed DSH runtime selected by `DSH_RUNTIME_ROOT` (default: the local
global DSH installation). If unavailable, the group visibly skips with the
missing path in its test name. They mount the module through the real registry,
execute model-free tools against the isolated Go fixture, render scoped prompts
and verify unload. They do not start DSH or read/write a DSH profile.

Native `mem_save` freezes a generated operation id, redacted request bytes and
destinations. A lost acknowledgement is checked against Go's save-result ledger;
only a typed miss permits one exact replay. Recovery is bounded to 7.5 seconds
and observes caller cancellation. UUIDs never appear in logs or thrown errors.
Other writes retain their existing single-attempt policy.
