// Safe diagnostic projection ported from Pi callerBindingProjection. This is
// read-only evidence; no session registration or write-success guarantee.
const nextSteps = [
  'No action required; a later write is not guaranteed.',
  'Collect caller context without registering a session.',
  'Verify support and availability of the caller diagnostic.',
  'Use the normal runtime registration path; diagnosis does not register sessions.',
  'Inspect the runtime binding; diagnosis does not repair it.',
  'Resume through a host that can persist effective identity; do not reopen the ended session.',
]
const reasons = ['caller_context_missing', 'caller_binding_unavailable', 'session_not_registered', 'effective_session_missing', 'session_project_conflict', 'effective_mapping_invalid', 'host_context_missing', 'resume_required', 'ended_session_without_persistence', 'binding_observed']
export function callerProjection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Engram caller-binding assessment')
  const data = value as Record<string, unknown>
  if (!['ok', 'warning', 'blocked', 'unknown'].includes(String(data.status))
    || !['active', 'ended', 'missing', 'unknown'].includes(String(data.root_state))
    || !['active', 'ended', 'missing', 'unknown'].includes(String(data.effective_state))
    || !reasons.includes(String(data.reason_code)) || !nextSteps.includes(String(data.safe_next_step))
    || data.write_success_guaranteed !== false) throw new Error('Invalid Engram caller-binding assessment')
  return { status: data.status, root_state: data.root_state, effective_state: data.effective_state, reason_code: data.reason_code, safe_next_step: data.safe_next_step, write_success_guaranteed: false }
}
