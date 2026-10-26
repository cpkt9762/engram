package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func fallbackRows(t *testing.T, s *Store, query string, opts SearchOptions, explicit bool) ([]int64, []int, *SearchFallback) {
	t.Helper()
	full, meta, err := s.SearchWithFallbackContext(context.Background(), query, opts, explicit)
	if err != nil {
		t.Fatal(err)
	}
	previews, previewMeta, err := s.SearchPreviewsWithFallbackContext(context.Background(), query, opts, explicit)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(meta, previewMeta) || len(full) != len(previews) {
		t.Fatalf("full/preview mismatch: %+v %+v", meta, previewMeta)
	}
	ids := make([]int64, 0, len(full))
	counts := make([]int, 0, len(full))
	for i, r := range full {
		if r.ID != previews[i].ID || !reflect.DeepEqual(r.MatchedTerms, previews[i].MatchedTerms) {
			t.Fatalf("full/preview row mismatch: %+v %+v", r, previews[i])
		}
		ids = append(ids, r.ID)
		if meta == nil {
			if r.MatchedTerms != nil {
				t.Fatal("ordinary result annotated")
			}
		} else {
			if r.MatchedTerms == nil {
				t.Fatal("fallback count absent")
			}
			counts = append(counts, *r.MatchedTerms)
		}
	}
	return ids, counts, meta
}

func TestSearchDefaultFallbackRanking(t *testing.T) {
	for _, terms := range [][]string{
		{"soak", "test", "stability", "grok2api", "concurrency", "requests", "endurance"},
		{"长测", "soak", "test", "稳定性", "grok2api", "并发", "请求"},
	} {
		t.Run(terms[0], func(t *testing.T) {
			s, ids := seedAnyRankRows(t, [][4]string{
				{"newest", terms[0], "fixture", ""},
				{"older", strings.Join(terms[:4], " "), "fixture", terms[4]},
				{terms[0], strings.Join(terms[1:4], " "), "fixture", terms[4]},
			})
			query := strings.Join(terms, " ")
			got, counts, meta := fallbackRows(t, s, query, SearchOptions{Project: "FIXTURE", Limit: 2}, false)
			if !reflect.DeepEqual(got, []int64{ids[2], ids[1]}) || !reflect.DeepEqual(counts, []int{5, 5}) || meta == nil || meta.Terms != 7 {
				t.Fatalf("order/count/meta: %v %v %+v", got, counts, meta)
			}
			got, counts, _ = fallbackRows(t, s, query, SearchOptions{}, false)
			if !reflect.DeepEqual(got, []int64{ids[2], ids[1], ids[0]}) || !reflect.DeepEqual(counts, []int{5, 5, 1}) {
				t.Fatalf("order/count: %v %v", got, counts)
			}
			// Existing store entry points retain AND and never silently broaden callers.
			full, err := s.SearchContext(context.Background(), query, SearchOptions{})
			if err != nil || len(full) != 0 {
				t.Fatalf("legacy full changed: %v %v", full, err)
			}
			previews, err := s.SearchPreviewsContext(context.Background(), query, SearchOptions{})
			if err != nil || len(previews) != 0 {
				t.Fatalf("legacy preview changed: %v %v", previews, err)
			}
		})
	}
}

func TestSearchDefaultFallbackGuards(t *testing.T) {
	s, _ := seedAnyRankRows(t, [][4]string{{"soak", "test", "fixture", ""}})
	for _, tc := range []struct {
		query, mode string
		explicit    bool
		want        int
	}{
		{"soak missing", "all", true, 0}, {"soak missing", "any", true, 1},
		{"soak missing", "", true, 0}, {"soak missing", "all", false, 0}, {"soak missing", "any", false, 1},
		{"soak", "", false, 1}, {`"""`, "", false, 0}, {"soak test", "", false, 1},
		{"missing absent", "", false, 0}, {"missing MISSING", "", false, 0},
	} {
		t.Run(tc.query+tc.mode, func(t *testing.T) {
			got, _, meta := fallbackRows(t, s, tc.query, SearchOptions{MatchMode: tc.mode}, tc.explicit)
			if len(got) != tc.want || meta != nil {
				t.Fatalf("unexpected result: %v %+v", got, meta)
			}
		})
	}
	// Successful default all-mode rows and ranks are identical to the old API.
	opts := SearchOptions{}
	old, err := s.SearchContext(context.Background(), "soak test", opts)
	if err != nil {
		t.Fatal(err)
	}
	current, meta, err := s.SearchWithFallbackContext(context.Background(), "soak test", opts, false)
	if err != nil || meta != nil || !reflect.DeepEqual(old, current) {
		t.Fatalf("all-mode changed: %v %+v %v", current, meta, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, meta, err := s.SearchWithFallbackContext(ctx, "soak missing", opts, false); !errors.Is(err, context.Canceled) || meta != nil {
		t.Fatalf("cancellation: %+v %v", meta, err)
	}
	if _, meta, err := s.SearchPreviewsWithFallbackContext(ctx, "soak missing", opts, false); !errors.Is(err, context.Canceled) || meta != nil {
		t.Fatalf("preview cancellation: %+v %v", meta, err)
	}
	for _, mode := range []string{"bad", "any"} {
		query := "soak missing"
		if mode == "any" {
			query = `"""`
		}
		if _, meta, err := s.SearchWithFallbackContext(context.Background(), query, SearchOptions{MatchMode: mode}, true); err == nil || meta != nil {
			t.Fatalf("error lost: %+v %v", meta, err)
		}
	}
}

func TestSearchDefaultFallbackFilters(t *testing.T) {
	s, ids := seedAnyRankRows(t, [][4]string{
		{"soak", "one", "fixture", ""}, {"soak", "two", "other", ""},
		{"soak", "three", "fixture", ""}, {"soak", "four", "fixture", ""},
		{"soak", "five", "fixture", ""},
	})
	for _, stmt := range []string{
		"UPDATE observations SET scope='personal' WHERE id=?",
		"UPDATE observations SET type='note' WHERE id=?",
		"UPDATE observations SET deleted_at='2026-01-20' WHERE id=?",
	} {
		i := 2
		if strings.Contains(stmt, "type=") {
			i = 3
		}
		if strings.Contains(stmt, "deleted_at=") {
			i = 4
		}
		if _, err := s.db.Exec(stmt, ids[i]); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		opts SearchOptions
		want []int64
	}{
		{SearchOptions{Project: "fixture", Scope: "project", Type: "decision", Limit: 1}, []int64{ids[0]}},
		{SearchOptions{Project: "other"}, []int64{ids[1]}},
		{SearchOptions{Scope: "personal"}, []int64{ids[2]}},
		{SearchOptions{Type: "note"}, []int64{ids[3]}},
	} {
		got, _, meta := fallbackRows(t, s, "soak absent", tc.opts, false)
		if !reflect.DeepEqual(got, tc.want) || meta == nil {
			t.Fatalf("filters: %v want %v, %+v", got, tc.want, meta)
		}
	}
	s.cfg.MaxSearchResults = 1
	got, _, _ := fallbackRows(t, s, "soak absent", SearchOptions{Limit: 100}, false)
	if len(got) != 1 {
		t.Fatalf("max limit: %v", got)
	}
}

func TestSearchDefaultFallbackDistinctEscapedTerms(t *testing.T) {
	for _, term := range []string{"%", "_", "内%存", "内_存", "x'", "[", `a\b`, "Agave", "Äbc"} {
		t.Run(term, func(t *testing.T) {
			s, ids := seedAnyRankRows(t, [][4]string{{"newest", "unrelated", "fixture", ""}, {"older", term, "fixture", ""}, {term, "oldest", "fixture", ""}})
			got, counts, meta := fallbackRows(t, s, term+" absent", SearchOptions{}, false)
			if !reflect.DeepEqual(got, []int64{ids[2], ids[1]}) || !reflect.DeepEqual(counts, []int{1, 1}) || meta == nil {
				t.Fatalf("escaping: %v %v %+v", got, counts, meta)
			}
		})
	}
	s, ids := seedAnyRankRows(t, [][4]string{{"UI", "ui UI Agave agave", "fixture", ""}, {"older", "Äbc äbc", "fixture", ""}})
	got, counts, meta := fallbackRows(t, s, `"UI" ui UI Agave agave absent`, SearchOptions{}, false)
	if !reflect.DeepEqual(got, []int64{ids[0]}) || !reflect.DeepEqual(counts, []int{2}) || meta == nil || meta.Terms != 3 {
		t.Fatalf("ASCII distinct: %v %v %+v", got, counts, meta)
	}
	got, counts, meta = fallbackRows(t, s, "Äbc äbc absent", SearchOptions{}, false)
	if !reflect.DeepEqual(got, []int64{ids[1]}) || !reflect.DeepEqual(counts, []int{2}) || meta == nil || meta.Terms != 3 {
		t.Fatalf("Unicode distinct: %v %v %+v", got, counts, meta)
	}
}

func TestSearchDefaultFallbackTimeIDAndClassification(t *testing.T) {
	s, ids := seedAnyRankRows(t, [][4]string{{"first", "soak", "fixture", ""}, {"second", "soak", "fixture", ""}, {"third", "soak", "fixture", ""}, {"classification", "unrelated", "soak", ""}})
	if _, err := s.db.Exec("UPDATE observations SET updated_at='2026-01-19' WHERE id=?", ids[2]); err != nil {
		t.Fatal(err)
	}
	got, counts, meta := fallbackRows(t, s, "soak absent", SearchOptions{}, false)
	if !reflect.DeepEqual(got, []int64{ids[0], ids[2], ids[1], ids[3]}) || !reflect.DeepEqual(counts, []int{1, 1, 1, 0}) || meta == nil {
		t.Fatalf("ties: %v %v %+v", got, counts, meta)
	}
}

func TestSearchDefaultFallbackSQLAndErrors(t *testing.T) {
	s, _ := seedAnyRankRows(t, [][4]string{{"soak", "test", "fixture", ""}})
	original := s.hooks.queryItContext
	attempts := 0
	injected := errors.New("fallback query failed")
	fail := false
	s.hooks.queryItContext = func(ctx context.Context, db *sql.DB, query string, args ...any) (rowScanner, error) {
		if strings.Contains(query, "AS matched_terms") {
			attempts++
			if strings.Contains(query, "MATCH") || !strings.Contains(query, "LIKE") || !strings.Contains(query, "ORDER BY (CASE WHEN") {
				t.Fatalf("fallback did not force LIKE ranking: %s", query)
			}
			if fail {
				return nil, injected
			}
		}
		return original(ctx, db, query, args...)
	}
	fallbackRows(t, s, "soak test stability grok2api concurrency requests endurance", SearchOptions{}, false)
	if attempts != 2 {
		t.Fatalf("fallback full/preview SQL attempts = %d", attempts)
	}
	fail = true
	if _, meta, err := s.SearchWithFallbackContext(context.Background(), "soak missing", SearchOptions{}, false); !errors.Is(err, injected) || meta != nil {
		t.Fatalf("full error hidden: %+v %v", meta, err)
	}
	if _, meta, err := s.SearchPreviewsWithFallbackContext(context.Background(), "soak missing", SearchOptions{}, false); !errors.Is(err, injected) || meta != nil {
		t.Fatalf("preview error hidden: %+v %v", meta, err)
	}
	// A caller cancellation between passes must not become a partial success.
	ctx, cancel := context.WithCancel(context.Background())
	s.hooks.queryItContext = func(ctx context.Context, db *sql.DB, query string, args ...any) (rowScanner, error) {
		if strings.Contains(query, "AS matched_terms") {
			cancel()
			return nil, fmt.Errorf("query interrupted: %w", ctx.Err())
		}
		return original(ctx, db, query, args...)
	}
	if _, meta, err := s.SearchWithFallbackContext(ctx, "soak missing", SearchOptions{}, false); !errors.Is(err, context.Canceled) || meta != nil {
		t.Fatalf("cancellation hidden: %+v %v", meta, err)
	}
}
