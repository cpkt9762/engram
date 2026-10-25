package store

import (
	"context"
	"fmt"
	"reflect"
	"testing"
)

func seedAnyRankRows(t *testing.T, rows [][4]string) (*Store, []int64) {
	t.Helper()
	s := newTestStore(t)
	if err := s.CreateSession("rank-session", "fixture", "/tmp"); err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for i, row := range rows {
		obs, err := s.AddObservation(AddObservationParams{SessionID: "rank-session", Type: "decision", Title: row[0], Content: row[1], Project: row[2]})
		if err != nil {
			t.Fatal(err)
		}
		// Explicit timestamps keep relevance and time tie-breakers independent.
		if _, err := s.db.Exec("UPDATE observations SET topic_key = ?, updated_at = ? WHERE id = ?", row[3], fmt.Sprintf("2026-01-%02d 00:00:00", 20-i), obs); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, obs)
	}
	return s, ids
}

func assertAnyRankOrder(t *testing.T, s *Store, query, mode string, limit int, want []int64) {
	t.Helper()
	opts := SearchOptions{MatchMode: mode, Limit: limit}
	full, err := s.SearchContext(context.Background(), query, opts)
	if err != nil {
		t.Fatal(err)
	}
	previews, err := s.SearchPreviewsContext(context.Background(), query, opts)
	if err != nil {
		t.Fatal(err)
	}
	ids, compactIDs := make([]int64, 0, len(full)), make([]int64, 0, len(previews))
	for _, row := range full {
		ids = append(ids, row.ID)
	}
	for _, row := range previews {
		compactIDs = append(compactIDs, row.ID)
	}
	if !reflect.DeepEqual(ids, want) {
		t.Errorf("%q mode=%s full order = %v, want %v", query, mode, ids, want)
	}
	if !reflect.DeepEqual(compactIDs, want) {
		t.Errorf("%q mode=%s compact order = %v, want %v", query, mode, compactIDs, want)
	}
}

func TestSearchAnyShortTermRanking(t *testing.T) {
	for _, terms := range [][2]string{{"内存", "资源"}, {"UI", "UX"}, {"Agave", "内存"}} {
		t.Run(terms[0], func(t *testing.T) {
			first, second := terms[0], terms[1]
			s, ids := seedAnyRankRows(t, [][4]string{
				{"newest", first, "fixture", ""},
				{"older", first + " " + second, "fixture", ""},
				{first, second + " oldest", "fixture", ""},
			})
			query := first + " " + second
			assertAnyRankOrder(t, s, query, "any", 10, []int64{ids[2], ids[1], ids[0]})
			assertAnyRankOrder(t, s, query, "any", 2, []int64{ids[2], ids[1]})
			// All-short all-mode remains chronological; mixed all-mode retains FTS ranking.
			allWant := []int64{ids[1], ids[2]}
			if first == "Agave" {
				allWant = []int64{ids[2], ids[1]}
			}
			assertAnyRankOrder(t, s, query, "all", 10, allWant)
			assertAnyRankOrder(t, s, query, "", 10, allWant)
		})
	}
}

func TestSearchAnyShortTermMetadataRanking(t *testing.T) {
	s, ids := seedAnyRankRows(t, [][4]string{
		{"project only", "unrelated", "ui", ""},
		{"type only", "unrelated", "fixture", ""},
		{"topic only", "unrelated", "fixture", "UI"},
		{"ui", "positive", "fixture", ""},
	})
	assertAnyRankOrder(t, s, "UI decision", "any", 10, []int64{ids[3], ids[2], ids[0], ids[1]})
}

func TestSearchAnyShortTermDistinctTerms(t *testing.T) {
	s, ids := seedAnyRankRows(t, [][4]string{
		{"newest", "UI ui UI", "fixture", ""},
		{"older", "UX DB", "fixture", ""},
	})
	assertAnyRankOrder(t, s, `"UI" ui UI UX DB`, "any", 10, []int64{ids[1], ids[0]})
}

func TestSearchAnyShortTermEscaping(t *testing.T) {
	for _, term := range []string{"%", "_", "内%存", "内_存", "x'", "[", "a\\b"} {
		t.Run(term, func(t *testing.T) {
			s, ids := seedAnyRankRows(t, [][4]string{
				{"unrelated", "unrelated", "fixture", ""},
				{"content match", term, "fixture", ""},
				{term, "title match", "fixture", ""},
			})
			query := term + " 无"
			assertAnyRankOrder(t, s, query, "any", 10, []int64{ids[2], ids[1]})
		})
	}
}

func TestSearchAnyShortTermTimeAndIDTies(t *testing.T) {
	s, ids := seedAnyRankRows(t, [][4]string{
		{"first", "UI", "fixture", ""},
		{"second", "UI", "fixture", ""},
		{"third", "UI", "fixture", ""},
	})
	if _, err := s.db.Exec("UPDATE observations SET updated_at = '2026-01-19 00:00:00' WHERE id = ?", ids[2]); err != nil {
		t.Fatal(err)
	}
	assertAnyRankOrder(t, s, "UI", "any", 10, []int64{ids[0], ids[2], ids[1]})
	assertAnyRankOrder(t, s, "UI", "all", 10, []int64{ids[0], ids[2], ids[1]})
}

func TestSearchAnyShortTermDistinctLIKECase(t *testing.T) {
	t.Run("ASCII folds", func(t *testing.T) {
		s, ids := seedAnyRankRows(t, [][4]string{
			{"newest", "Agave Agave", "fixture", ""},
			{"older", "内存 资源", "fixture", ""},
		})
		assertAnyRankOrder(t, s, "Agave agave AGAVE 内存 资源", "any", 10, []int64{ids[1], ids[0]})
	})
	t.Run("non-ASCII LIKE stays distinct", func(t *testing.T) {
		s, ids := seedAnyRankRows(t, [][4]string{
			{"newest", "Äbc Äbc", "fixture", ""},
			{"older", "Äbc äbc", "fixture", ""},
		})
		assertAnyRankOrder(t, s, "Äbc äbc 无", "any", 10, []int64{ids[1], ids[0]})
	})
}
