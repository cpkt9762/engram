package store

import (
	"strings"
	"testing"
)

// Consolidation writes a survivor through its own INSERT, so it does not pass
// through prepareStoredContent. Caller-supplied overrides are agent-authored
// text and must be filtered like every other persisted write: credentials
// redacted and <private> blocks removed. Kept in its own file because upstream
// is still reshaping consolidate_test.go.
func TestConsolidateOverridesAreSanitizedBeforePersisting(t *testing.T) {
	s, ids, _ := consolidateTestStore(t)
	const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
	overrides := ConsolidateOverrides{
		Title:   "merged deploy notes " + token,
		Content: "keep this line <private>internal hostname</private> and rotate " + token,
	}

	plan, err := s.ConsolidateObservations(ConsolidateParams{IDs: ids, Overrides: overrides})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if strings.Contains(plan.Plan.Survivor.Title+plan.Plan.Survivor.Content, token) {
		t.Fatal("the plan shown to the caller already carries the raw credential")
	}
	res, err := s.ConsolidateObservations(ConsolidateParams{
		IDs:         ids,
		Overrides:   overrides,
		Confirm:     true,
		Fingerprint: plan.Plan.Fingerprint,
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	stored, err := s.GetObservation(res.Survivor.ID)
	if err != nil {
		t.Fatalf("get survivor: %v", err)
	}
	for field, value := range map[string]string{"title": stored.Title, "content": stored.Content} {
		if strings.Contains(value, token) {
			t.Fatalf("survivor %s persisted the credential: %q", field, value)
		}
	}
	if strings.Contains(stored.Content, "internal hostname") {
		t.Fatalf("survivor content kept a <private> block: %q", stored.Content)
	}
	if !strings.Contains(stored.Content, "keep this line") || !strings.Contains(stored.Title, "merged deploy notes") {
		t.Fatalf("ordinary override text must survive: title=%q content=%q", stored.Title, stored.Content)
	}
}
