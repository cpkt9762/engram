package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

func renameCommandSnapshot(t *testing.T, cfg store.Config) string {
	t.Helper()
	s, err := store.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := s.Close(); err != nil {
			t.Errorf("close snapshot store: %v", err)
		}
	}()
	exported, err := s.Export()
	if err != nil {
		t.Fatal(err)
	}
	exported.ExportedAt = ""
	counts := map[string]int{}
	for _, table := range []string{"sessions", "observations", "user_prompts", "sync_mutations", "sync_enrolled_projects", "prompt_tombstones", "sync_delete_tombstones", "project_aliases"} {
		var n int
		if err := s.DB().QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		counts[table] = n
	}
	b, err := json.Marshal([]any{exported, counts})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProjectsRenameCommand(t *testing.T) {
	cfg := testConfig(t)
	mustSeedObservation(t, cfg, "s", "source", "note", "searchable", "套利", "project")
	mustSeedObservation(t, cfg, "t", "target", "note", "existing", "other", "project")
	before := renameCommandSnapshot(t, cfg)
	withArgs(t, "engram", "projects", "rename", "--from", " SOURCE ", "--to", "TARGET", "--dry-run")
	out, stderr := captureOutput(t, func() { cmdProjects(cfg) })
	if stderr != "" || !strings.Contains(out, "merge") || !strings.Contains(out, "observations: 1") || !strings.Contains(out, "source enrolled: false") {
		t.Fatalf("out=%q stderr=%q", out, stderr)
	}
	if before != renameCommandSnapshot(t, cfg) {
		t.Fatal("dry-run mutated DB")
	}
	backups, err := filepath.Glob(filepath.Join(cfg.DataDir, "*.db*"))
	if err != nil {
		t.Fatal(err)
	}
	beforeFiles := map[string]bool{}
	for _, p := range backups {
		beforeFiles[p] = true
	}
	withArgs(t, "engram", "projects", "rename", "--from", "source", "--to", "target", "--apply")
	out, stderr = captureOutput(t, func() { cmdProjects(cfg) })
	if stderr != "" || !strings.Contains(out, "Backup:") || !strings.Contains(out, "observations: 1") || !strings.Contains(out, "re-pushed") || !strings.Contains(out, "append-only") {
		t.Fatalf("out=%q stderr=%q", out, stderr)
	}
	var backup string
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "Backup: ") {
			backup = strings.TrimPrefix(line, "Backup: ")
		}
	}
	info, err := os.Stat(backup)
	if err != nil || info.Size() == 0 || beforeFiles[backup] {
		t.Fatalf("backup=%q stat=%v err=%v", backup, info, err)
	}
	// Read the backup independently; it must contain the pre-rename owner.
	data, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	backupDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(backupDir, "engram.db"), data, 0600); err != nil {
		t.Fatal(err)
	}
	backupCfg := cfg
	backupCfg.DataDir = backupDir
	if before != renameCommandSnapshot(t, backupCfg) {
		t.Fatal("backup does not preserve pre-apply data")
	}
	oldExit := exitFunc
	exitFunc = func(code int) { panic(exitCode(code)) }
	t.Cleanup(func() { exitFunc = oldExit })
	after := renameCommandSnapshot(t, cfg)
	_, stderr, recovered := captureOutputAndRecover(t, func() { cmdProjects(cfg) })
	if recovered != exitCode(1) || !strings.HasPrefix(stderr, "projects rename:") || !strings.Contains(stderr, "does not exist") {
		t.Fatalf("stderr=%q exit=%v", stderr, recovered)
	}
	if after != renameCommandSnapshot(t, cfg) {
		t.Fatal("repeat mutated DB")
	}
}

func TestProjectsRenameBackupFailure(t *testing.T) {
	cfg := testConfig(t)
	mustSeedObservation(t, cfg, "s", "source", "note", "test", "content", "project")
	before := renameCommandSnapshot(t, cfg)
	original := projectsRenameBackup
	projectsRenameBackup = func(*store.Store) (string, error) { return "", errors.New("backup unavailable") }
	t.Cleanup(func() { projectsRenameBackup = original })
	oldExit := exitFunc
	exitFunc = func(code int) { panic(exitCode(code)) }
	t.Cleanup(func() { exitFunc = oldExit })
	withArgs(t, "engram", "projects", "rename", "--from", "source", "--to", "target", "--apply")
	_, stderr, recovered := captureOutputAndRecover(t, func() { cmdProjects(cfg) })
	if recovered != exitCode(1) || !strings.Contains(stderr, "projects rename: backup unavailable") {
		t.Fatalf("stderr=%q exit=%v", stderr, recovered)
	}
	if before != renameCommandSnapshot(t, cfg) {
		t.Fatal("backup failure mutated DB")
	}
}

func TestProjectsRenameInvalidInputs(t *testing.T) {
	cfg := testConfig(t)
	mustSeedObservation(t, cfg, "s", "source", "note", "test", "content", "project")
	before := renameCommandSnapshot(t, cfg)
	oldExit := exitFunc
	exitFunc = func(code int) { panic(exitCode(code)) }
	t.Cleanup(func() { exitFunc = oldExit })
	for _, args := range [][]string{
		{}, {"--from", "source", "--to", "target"}, {"--from", "source", "--to", "target", "--apply", "--dry-run"},
		{"--from", "source", "--apply"}, {"--to", "target", "--apply"}, {"--from", "source", "--to", "target", "--apply", "--apply"},
		{"--from", "source", "--to", "target", "--apply", "--unknown"}, {"--from", "missing", "--to", "target", "--apply"},
		{"--from", "source", "--to", " SOURCE ", "--apply"}, {"--from", "source", "--to", "inbox", "--apply"},
		{"--from", "source", "--to", "", "--apply"}, {"--from", "source", "--to", "a/b", "--apply"},
		{"--from", "source", "--to", "a\\b", "--apply"}, {"--from", "source", "--to", "a\nb", "--apply"},
		{"--from", "source", "--to", "target", "--to", "other", "--apply"}, {"--from"},
	} {
		withArgs(t, append([]string{"engram", "projects", "rename"}, args...)...)
		out, stderr, recovered := captureOutputAndRecover(t, func() { cmdProjects(cfg) })
		if recovered != exitCode(1) || out != "" || !strings.HasPrefix(stderr, "projects rename:") {
			t.Fatalf("args=%q out=%q stderr=%q exit=%v", args, out, stderr, recovered)
		}
		if before != renameCommandSnapshot(t, cfg) {
			t.Fatalf("invalid input mutated DB: %q", args)
		}
	}
}

func TestProjectsRenameGuardBeforeBackup(t *testing.T) {
	cfg := testConfig(t)
	mustSeedObservation(t, cfg, "s", "source", "note", "test", "content", "project")
	s, err := store.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnrollProject("source"); err != nil {
		t.Fatal(err)
	}
	acquired, err := s.AcquireSyncLease("cloud", "cli-autosync", time.Minute, time.Now())
	if err != nil || !acquired {
		t.Fatalf("lease=%t err=%v", acquired, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	before := renameCommandSnapshot(t, cfg)
	original := projectsRenameBackup
	calls := 0
	projectsRenameBackup = func(*store.Store) (string, error) { calls++; return "", errors.New("backup must not run") }
	t.Cleanup(func() { projectsRenameBackup = original })
	oldExit := exitFunc
	exitFunc = func(code int) { panic(exitCode(code)) }
	t.Cleanup(func() { exitFunc = oldExit })
	for _, mode := range []string{"--dry-run", "--apply"} {
		withArgs(t, "engram", "projects", "rename", "--from", "source", "--to", "target", mode)
		out, stderr, recovered := captureOutputAndRecover(t, func() { cmdProjects(cfg) })
		for _, text := range []string{"pending: 2", "quarantined: 0", "owner=\"cli-autosync\"", "active=true", "until="} {
			if !strings.Contains(out, text) {
				t.Fatalf("missing %q in %q", text, out)
			}
		}
		if mode == "--apply" {
			if recovered != exitCode(1) || !strings.Contains(stderr, "engram cloud status") || !strings.Contains(stderr, "cli-autosync") {
				t.Fatalf("stderr=%q exit=%v", stderr, recovered)
			}
		} else if recovered != nil || stderr != "" {
			t.Fatalf("dry run stderr=%q exit=%v", stderr, recovered)
		}
	}
	if calls != 0 {
		t.Fatalf("backups=%d", calls)
	}
	if before != renameCommandSnapshot(t, cfg) {
		t.Fatal("guard changed DB")
	}
}

func TestProjectsRenameWarnings(t *testing.T) {
	for _, mode := range []string{"--dry-run", "--apply"} {
		t.Run(mode, func(t *testing.T) {
			cfg := testConfig(t)
			mustSeedObservation(t, cfg, "s", "source", "note", "test", "content", "project")
			s, err := store.New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.AddPrompt(store.AddPromptParams{SessionID: "s", Project: "source", Content: "keyed", SourceInboxID: "key"}); err != nil {
				t.Fatal(err)
			}
			if err := s.EnrollProject("source"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.DB().Exec(`UPDATE sync_mutations SET disposition='quarantined'`); err != nil {
				t.Fatal(err)
			}
			acquired, err := s.AcquireSyncLease("cloud", "warning-autosync", time.Minute, time.Now())
			if err != nil || !acquired {
				t.Fatalf("lease=%t err=%v", acquired, err)
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			withArgs(t, "engram", "projects", "rename", "--from", "source", "--to", "target", mode)
			out, stderr := captureOutput(t, func() { cmdProjects(cfg) })
			if stderr != "" {
				t.Fatalf("stderr=%q", stderr)
			}
			for _, text := range []string{"pending: 0", "quarantined: 3", "keyed prompts: 1", "prompt_provenance_blocked", "source", "covered", "never sent", "active=true"} {
				if !strings.Contains(out, text) {
					t.Fatalf("missing %q in %q", text, out)
				}
			}
			if mode == "--apply" && !strings.Contains(out, "Backup:") {
				t.Fatal("warnings prevented apply")
			}
		})
	}
}
