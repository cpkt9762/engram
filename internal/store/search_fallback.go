package store

import (
	"context"
	"fmt"
)

// SearchFallback marks partial matches returned only after an implicit all search
// found nothing. Explicit match modes and existing store callers never opt in.
type SearchFallback struct {
	Mode   string `json:"mode"`
	Reason string `json:"reason"`
	Terms  int    `json:"terms"`
}

func (f *SearchFallback) Explanation() string {
	return fmt.Sprintf("No memory matched all %d terms; showing memories that match at least one term, ranked by matched terms.", f.Terms)
}

func fallbackSearchOptions(query string, opts SearchOptions, matchModeProvided bool) (SearchOptions, *SearchFallback) {
	_, _, _, _, terms := searchLIKEScores(query)
	if matchModeProvided || opts.MatchMode != "" || terms < 2 {
		return opts, nil
	}
	opts.MatchMode = "any"
	opts.fallbackLIKE = true
	return opts, &SearchFallback{Mode: "any", Reason: "no_all_terms_match", Terms: terms}
}

// SearchFallbackContext attempts only the partial-match pass. Callers must first
// run their ordinary search and establish that it returned no results.
func (s *Store) SearchFallbackContext(ctx context.Context, query string, opts SearchOptions, matchModeProvided bool) ([]SearchResult, *SearchFallback, error) {
	opts, fallback := fallbackSearchOptions(query, opts, matchModeProvided)
	if fallback == nil {
		return nil, nil, nil
	}
	results, err := s.SearchContext(ctx, query, opts)
	if err != nil || len(results) == 0 {
		return results, nil, err
	}
	return results, fallback, nil
}

// SearchWithFallbackContext is the opt-in full-result search for user transports.
func (s *Store) SearchWithFallbackContext(ctx context.Context, query string, opts SearchOptions, matchModeProvided bool) ([]SearchResult, *SearchFallback, error) {
	results, err := s.SearchContext(ctx, query, opts)
	if err != nil || len(results) > 0 {
		return results, nil, err
	}
	return s.SearchFallbackContext(ctx, query, opts, matchModeProvided)
}

// SearchPreviewsWithFallbackContext keeps fallback searches bounded, without
// hydrating observation bodies or changing SearchPreviewsContext semantics.
func (s *Store) SearchPreviewsWithFallbackContext(ctx context.Context, query string, opts SearchOptions, matchModeProvided bool) ([]SearchPreviewResult, *SearchFallback, error) {
	results, err := s.SearchPreviewsContext(ctx, query, opts)
	if err != nil || len(results) > 0 {
		return results, nil, err
	}
	opts, fallback := fallbackSearchOptions(query, opts, matchModeProvided)
	if fallback == nil {
		return results, nil, nil
	}
	results, err = s.SearchPreviewsContext(ctx, query, opts)
	if err != nil || len(results) == 0 {
		return results, nil, err
	}
	return results, fallback, nil
}
