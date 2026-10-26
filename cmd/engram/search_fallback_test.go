package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestCmdSearchDefaultFallback(t *testing.T) {
	cfg := testConfig(t)
	id := mustSeedObservation(t, cfg, "fallback-cli", "fixture", "decision", "grok2api", "soak test stability concurrency", "project")
	for _, tc := range []struct {
		name, query string
		flags       []string
		want        bool
	}{
		{"default", "soak test stability grok2api concurrency requests endurance", nil, true},
		{"all", "soak missing", []string{"--match", "all"}, false},
		{"any", "soak missing", []string{"--match", "any"}, false},
		{"blank mode is default", "soak test stability grok2api concurrency requests endurance", []string{"--match", ""}, true},
		{"single", "soak", nil, false},
		{"termless", `"""`, nil, false},
		{"all hit", "soak test", nil, false},
		{"no hit", "absent missing", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := append([]string{"engram", "search", tc.query, "--project", "fixture"}, tc.flags...)
			withArgs(t, args...)
			out, stderr := captureOutput(t, func() { cmdSearch(cfg) })
			if stderr != "" {
				t.Fatalf("stderr: %s", stderr)
			}
			if got := strings.HasPrefix(out, "No memory matched all 7 terms;"); got != tc.want {
				t.Fatalf("fallback=%v want=%v: %s", got, tc.want, out)
			}
			if tc.want && !strings.Contains(out, fmt.Sprintf("#%d [5/7]", id)) {
				t.Fatalf("count missing: %s", out)
			}
			if !tc.want && strings.Contains(out, "ranked by matched terms") {
				t.Fatalf("unexpected fallback: %s", out)
			}
		})
	}
}

func TestCmdSearchDefaultAllHitUnchanged(t *testing.T) {
	cfg := testConfig(t)
	mustSeedObservation(t, cfg, "all-hit-cli", "fixture", "decision", "soak test", "complete match", "project")
	withArgs(t, "engram", "search", "soak test", "--project", "fixture")
	implicit, stderr := captureOutput(t, func() { cmdSearch(cfg) })
	if stderr != "" {
		t.Fatal(stderr)
	}
	withArgs(t, "engram", "search", "soak test", "--project", "fixture", "--match", "all")
	explicit, stderr := captureOutput(t, func() { cmdSearch(cfg) })
	if stderr != "" {
		t.Fatal(stderr)
	}
	if implicit != explicit {
		t.Fatalf("all-hit output changed: %q / %q", implicit, explicit)
	}
}
