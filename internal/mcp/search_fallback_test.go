package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	httpserver "github.com/Gentleman-Programming/engram/v3/internal/server"
	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

func TestSearchDefaultFallbackTransports(t *testing.T) {
	st := newMCPTestStore(t)
	if err := st.CreateSession("fallback", "fixture", ""); err != nil {
		t.Fatal(err)
	}
	id, err := st.AddObservation(store.AddObservationParams{SessionID: "fallback", Project: "fixture", Scope: "project", Type: "decision", Title: "grok2api", Content: "soak test stability concurrency"})
	if err != nil {
		t.Fatal(err)
	}
	h := httpserver.New(st, 0).Handler()
	srv := NewServer(st)
	for _, format := range []string{"", "compact"} {
		for _, tc := range []struct {
			name, query, mode string
			explicit          bool
			want, hits, terms int
		}{
			{"default seven", "soak test stability grok2api concurrency requests endurance", "", false, 1, 5, 7},
			{"mixed seven", "长测 soak test 稳定性 grok2api 并发 请求", "", false, 1, 3, 7},
			{"explicit all", "soak missing", "all", true, 0, 0, 0},
			{"explicit any", "soak missing", "any", true, 1, 0, 0},
			{"blank mode is default", "soak test stability grok2api concurrency requests endurance", "", true, 1, 5, 7},
			{"single", "soak", "", false, 1, 0, 0},
			{"termless", `"""`, "", false, 0, 0, 0},
			{"all hits", "soak test", "", false, 1, 0, 0},
			{"still empty", "absent missing", "", false, 0, 0, 0},
		} {
			t.Run(format+"/"+tc.name, func(t *testing.T) {
				args := map[string]any{"query": tc.query, "project": "fixture"}
				params := url.Values{"q": {tc.query}, "project": {"fixture"}}
				if tc.explicit {
					args["match_mode"] = tc.mode
					params.Set("match_mode", tc.mode)
				}
				if format != "" {
					args["response_format"] = format
					params.Set("response_format", format)
				}
				wire, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "mem_search", "arguments": args}})
				if err != nil {
					t.Fatal(err)
				}
				raw, err := json.Marshal(srv.HandleMessage(context.Background(), wire))
				if err != nil {
					t.Fatal(err)
				}
				var rpc struct {
					Result struct {
						IsError bool `json:"isError"`
						Content []struct {
							Text string `json:"text"`
						} `json:"content"`
					} `json:"result"`
				}
				if err := json.Unmarshal(raw, &rpc); err != nil {
					t.Fatal(err)
				}
				if rpc.Result.IsError || len(rpc.Result.Content) != 1 {
					t.Fatalf("MCP: %s", raw)
				}
				var body map[string]any
				if err := json.Unmarshal([]byte(rpc.Result.Content[0].Text), &body); err != nil {
					t.Fatal(err)
				}
				summary, _ := body["result"].(string)
				entries, _ := body["results"].([]any)
				if len(entries) != tc.want {
					t.Fatalf("MCP results: %s", raw)
				}
				checkFallbackEnvelope(t, body, tc.terms)
				if tc.want > 0 {
					checkFallbackEntry(t, entries[0].(map[string]any), id, tc.hits)
				}
				if tc.want == 0 && !strings.Contains(summary, "No memories found") {
					t.Fatalf("empty summary: %s", summary)
				}
				if tc.terms > 0 && format == "" {
					if !strings.HasPrefix(summary, fmt.Sprintf("No memory matched all %d terms;", tc.terms)) || !strings.Contains(summary, fmt.Sprintf("#%d [%d/%d]", id, tc.hits, tc.terms)) {
						t.Fatalf("missing text annotation: %s", summary)
					}
					t.Log(summary)
				} else if tc.terms == 0 && strings.Contains(summary, "ranked by matched terms") {
					t.Fatalf("unexpected annotation: %s", summary)
				}
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest("GET", "/search?"+params.Encode(), nil))
				if rec.Code != 200 {
					t.Fatalf("HTTP: %d %s", rec.Code, rec.Body.String())
				}
				wantHeader := ""
				if tc.terms > 0 {
					wantHeader = "any"
				}
				if got := rec.Header().Get("X-Engram-Search-Fallback"); got != wantHeader {
					t.Fatalf("fallback header %q, want %q: %s", got, wantHeader, rec.Body.String())
				}
				if format == "compact" {
					var httpBody map[string]any
					if err := json.Unmarshal(rec.Body.Bytes(), &httpBody); err != nil {
						t.Fatal(err)
					}
					checkFallbackEnvelope(t, httpBody, tc.terms)
					entries, _ = httpBody["results"].([]any)
				} else {
					if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
						t.Fatal(err)
					}
					// Existing full-result clients must still decode the same array.
					var legacy []store.SearchResult
					if err := json.Unmarshal(rec.Body.Bytes(), &legacy); err != nil {
						t.Fatal(err)
					}
				}
				if len(entries) != tc.want {
					t.Fatalf("HTTP count: %s", rec.Body.String())
				}
				if tc.want > 0 {
					checkFallbackEntry(t, entries[0].(map[string]any), id, tc.hits)
				}
			})
		}
	}
}

func checkFallbackEnvelope(t *testing.T, body map[string]any, terms int) {
	t.Helper()
	meta, ok := body["match_fallback"].(map[string]any)
	if terms == 0 {
		if ok {
			t.Fatalf("unexpected fallback: %#v", body)
		}
		return
	}
	if !ok || meta["mode"] != "any" || meta["reason"] != "no_all_terms_match" || meta["terms"] != float64(terms) {
		t.Fatalf("fallback metadata: %#v", body)
	}
}
func checkFallbackEntry(t *testing.T, entry map[string]any, id int64, hits int) {
	t.Helper()
	if entry["id"] != float64(id) {
		t.Fatalf("id: %#v", entry)
	}
	if hits == 0 {
		if _, ok := entry["matched_terms"]; ok {
			t.Fatalf("unexpected count: %#v", entry)
		}
		return
	}
	if entry["matched_terms"] != float64(hits) {
		t.Fatalf("matched_terms: %#v", entry)
	}
}

func TestSearchDefaultAllHitWireUnchanged(t *testing.T) {
	st := newMCPTestStore(t)
	if err := st.CreateSession("unchanged", "fixture", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddObservation(store.AddObservationParams{SessionID: "unchanged", Project: "fixture", Type: "decision", Title: "soak test", Content: "complete match"}); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"", "compact"} {
		var lastMCP, lastHTTP string
		for _, explicit := range []bool{false, true} {
			args := map[string]any{"query": "soak test", "project": "fixture"}
			params := url.Values{"q": {"soak test"}, "project": {"fixture"}}
			if format != "" {
				args["response_format"] = format
				params.Set("response_format", format)
			}
			if explicit {
				args["match_mode"] = "all"
				params.Set("match_mode", "all")
			}
			wire, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "mem_search", "arguments": args}})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(NewServer(st).HandleMessage(context.Background(), wire))
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			httpserver.New(st, 0).Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/search?"+params.Encode(), nil))
			if explicit && (lastMCP != string(raw) || lastHTTP != rec.Body.String()) {
				t.Fatalf("all-hit wire changed: MCP %s / %s; HTTP %s / %s", lastMCP, raw, lastHTTP, rec.Body.String())
			}
			lastMCP = string(raw)
			lastHTTP = rec.Body.String()
		}
	}
}
