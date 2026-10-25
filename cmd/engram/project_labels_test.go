package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

func TestCLISaveCurrentDirectoryAlias(t *testing.T) {
	stubExitWithPanic(t)
	cfg := testConfig(t)
	dir := filepath.Join(t.TempDir(), "Checkout.Folder")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q", dir}, {"-C", dir, "remote", "add", "origin", "https://example.test/Canonical.git"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git: %v %s", err, out)
		}
	}
	withCwd(t, dir)
	t.Setenv("ENGRAM_PROJECT", "unrelated-process-override")
	raw := "CHECKOUT__FOLDER"
	withArgs(t, "engram", "save", "Alias evidence", "Content", "--project", raw)
	stdout, stderr := captureOutput(t, func() { cmdSave(cfg) })
	if !strings.Contains(stdout, "Memory saved") || !strings.Contains(stderr, "alias") {
		t.Fatalf("stdout=%q stderr=%q", stdout, stderr)
	}
	s, err := store.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	rows, err := s.RecentObservations("canonical", "project", 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows=%+v %v", rows, err)
	}
	p, err := s.CaptureProjectProvenance("observation", strconv.FormatInt(rows[0].ID, 10))
	if err != nil || p == nil || p.Source != "explicit_override" || p.RawProject != raw || p.Directory != dir {
		t.Fatalf("provenance=%+v %v", p, err)
	}
}
