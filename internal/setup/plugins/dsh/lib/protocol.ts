// Memory prose adapted from plugin/pi/index.ts for the DSH host.
const MEMORY_INSTRUCTIONS = `## Engram Persistent Memory — Protocol

You have access to Engram, a persistent memory system that survives across sessions and compactions.
The agent MUST follow this protocol without waiting for activation.
These instructions are injected by engram-dsh, the native DSH memory provider. Use the memory tools named in this section as the authoritative DSH memory contract. Do not infer alternative Engram tool names from other integrations unless the user explicitly asks you to use them.

### CANONICAL TOPIC WORKFLOW (mandatory — not optional)

A memory is an evolving topic, not a log entry. Follow this workflow for every learning worth persisting.

1. **SEARCH first.** Use \`mem_search\` on the bounded subject in the intended project and scope before writing.
2. **READ in full.** Use \`mem_get_observation\` on plausible candidates; search snippets are not enough to decide identity.
3. **SAME bounded topic?** Use \`mem_update\` by ID. Keep the existing \`topic_key\`, preserve every still-valid fact, and rewrite only what changed. Record superseded facts as history inside the content instead of leaving competing current truths.
4. **Genuinely new topic?** Use \`mem_save\` with a deliberate, distinct \`topic_key\`. If the learning is already covered, write nothing.
5. **Ambiguous identity or failed lookup?** Do not blindly overwrite and do not fall back to a duplicate save. A failed read is not evidence of absence.
6. **Never merge across projects or scopes.** A matching suggested \`topic_key\` or a similar title is a hint, not proof of identity.

Persist verified knowledge that is durable and costly to reconstruct: decisions with rationale,
non-obvious root causes, real constraints, and resumption-relevant pending work.
Group related conclusions deliberately, not every task, response, or event.
Exclude secrets, private data, speculation, raw dumps, and routine progress.
Never save credentials, private content, or personal data.

Format for \`mem_save\`:
- **title**: Verb + what — short, searchable
- **type**: bugfix | decision | architecture | discovery | pattern | config | preference
- **scope**: \`project\` (default) | \`personal\` | \`global\`
- **topic_key**: stable, deliberate key for the topic; reuse via \`mem_update\` rather than duplicating
- **content**:
  **What**: One sentence — what was done
  **Why**: What motivated it
  **Where**: Files or paths affected
  **Learned**: Gotchas, edge cases, things that surprised you

Format for \`mem_update\`:
- **id**: observation ID from \`mem_search\` / \`mem_get_observation\`
- **expected_project**: project that owns the observation
- **topic_key**: keep the existing key unless the topic itself changed
- **content**: full rewritten content including every still-valid fact, with changed or superseded facts recorded as history

### NATIVE SESSION ATTRIBUTION

Native \`mem_save\`, \`mem_save_prompt\`, \`mem_session_summary\`, and \`mem_capture_passive\`
derive attribution from the current DSH host session and confirmed Engram registration.
Do not invent or override \`session_id\`; engram-dsh owns the effective persisted
identity, including resumed continuations. Explicit cross-project writes use isolated satellite sessions; implicit writes stay in the host project.
\`mem_session_end\` accepts only an optional assertion of the current DSH host session ID; the plugin
resolves the effective persisted ID. Ordinary task completion does not end it.

### PASSIVE CAPTURE

DSH queues eligible top-level non-Engram tool outputs after redaction; only
recognized structured learnings are persisted, not arbitrary output.
Final assistant responses are not automatically captured. For significant learnings
in a response, follow the canonical topic workflow before replying;
a final \`## Key Learnings:\` section alone is not a persistence guarantee.

### DELIVERY GUARANTEE

Honestly report unavailable memory evidence; never claim unconfirmed persistence.
Do not blindly repeat writes. Complete unrelated work even if bookkeeping fails.
Do not add per-event learning sections or ceremonial delivery blocks.

Memory operations are internal bookkeeping, never the user-facing answer. Complete required memory work before composing the completed-task reply; send the complete answer as the final message of the turn with no later tool calls. If memory work fails or needs follow-up, still send the answer.

New sessions do not automatically inject historical memory. Start a new session
with \`mem_context\` to recover relevant recent context.

### WHEN TO SEARCH MEMORY

Search when materially useful for recall or related work; mere project mentions do not require a search.
When the user asks to recall past work:
1. Start with \`mem_context\`, then search with 1–2 distinctive keywords.
2. Ordinary \`mem_search\` is scoped to the detected active project; its default
   \`match_mode:"all"\` means AND. For broad recall, use \`match_mode:"any"\` with
   \`all_projects:true\`. If a scoped search is empty, retry once this way before
   concluding no memory exists.
3. After hits, narrow follow-up searches by project, type, or \`match_mode:"all"\`,
   then use \`mem_get_observation\` for full content.

### SESSION CLOSE PROTOCOL

At significant explicit closure or handoff, call \`mem_session_summary\`
with Goal, Instructions, Discoveries, Accomplished, Next Steps, and Relevant Files.
Ordinary task completion or merely saying "done" does not require a session summary.
If \`mem_session_summary\` fails because Engram cannot detect a project, ask the user
which project is intended. Fix the project configuration or restart in its directory,
verify with \`mem_current_project\`, then retry after project resolution succeeds.

### AFTER COMPACTION

When outcome-specific compaction recovery guidance is present, follow it. If a
compacted summary appears without that guidance, save it immediately with
\`mem_session_summary\`, then call \`mem_context\` before continuing.
`;

export { MEMORY_INSTRUCTIONS }
