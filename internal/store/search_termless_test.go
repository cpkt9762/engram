package store

import (
	"context"
	"strings"
	"testing"
)

// A query with no searchable term (only quotes or whitespace) must not reach
// the LIKE builder, which would emit an empty predicate group. Upstream keeps
// such queries on the FTS path: the default mode's empty phrase matches
// nothing, while "any" mode keeps upstream's pinned empty-expression error
// (see TestSearchMatchMode_EmptyQueryAnyReturnsError).
func TestSearchTermlessQueriesKeepUpstreamFTSPath(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateSession("termless-session", "fixture", "/tmp"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddObservation(AddObservationParams{SessionID: "termless-session", Type: "decision", Title: "quoted title", Content: "quoted content", Project: "fixture"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPrompt(AddPromptParams{SessionID: "termless-session", Content: "quoted prompt", Project: "fixture"}); err != nil {
		t.Fatal(err)
	}

	for _, query := range []string{`"""`, `""`, `" "`, `"" ""`} {
		results, err := s.SearchContext(context.Background(), query, SearchOptions{})
		if err != nil {
			t.Fatalf("SearchContext(%q): %v", query, err)
		}
		if len(results) != 0 {
			t.Fatalf("SearchContext(%q) = %d results, want 0", query, len(results))
		}
		previews, err := s.SearchPreviewsContext(context.Background(), query, SearchOptions{})
		if err != nil {
			t.Fatalf("SearchPreviewsContext(%q): %v", query, err)
		}
		if len(previews) != 0 {
			t.Fatalf("SearchPreviewsContext(%q) = %d results, want 0", query, len(previews))
		}
		anyOpts := SearchOptions{MatchMode: "any"}
		if _, err := s.SearchContext(context.Background(), query, anyOpts); err == nil || strings.Contains(err.Error(), "near \")\"") {
			t.Fatalf("SearchContext(%q, any) error = %v, want upstream's FTS empty-expression error", query, err)
		}
		if _, err := s.SearchPreviewsContext(context.Background(), query, anyOpts); err == nil || strings.Contains(err.Error(), "near \")\"") {
			t.Fatalf("SearchPreviewsContext(%q, any) error = %v, want upstream's FTS empty-expression error", query, err)
		}
		prompts, err := s.SearchPrompts(query, "", 10)
		if err != nil {
			t.Fatalf("SearchPrompts(%q): %v", query, err)
		}
		if len(prompts) != 0 {
			t.Fatalf("SearchPrompts(%q) = %d results, want 0", query, len(prompts))
		}
	}
}
