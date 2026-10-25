package mcp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	projectpkg "github.com/Gentleman-Programming/engram/v3/internal/project"
	"github.com/Gentleman-Programming/engram/v3/internal/store"
	mcppkg "github.com/mark3labs/mcp-go/mcp"
)

func aliasRepository(t *testing.T, bind bool) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "Checkout.Folder")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	initTestGitRepo(t, dir)
	cmd := exec.Command("git", "-C", dir, "remote", "add", "origin", "https://example.test/Canonical-Project.git")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("remote: %v %s", err, out)
	}
	if bind {
		if res := projectpkg.DetectProjectFull(dir); res.Error != nil {
			t.Fatal(res.Error)
		}
	}
	t.Chdir(dir)
	return dir
}

func TestExplicitDirectoryAliasWrite(t *testing.T) {
	for _, tool := range []string{"save", "summary", "finalize"} {
		t.Run(tool, func(t *testing.T) {
			dir := aliasRepository(t, true)
			s := newMCPTestStore(t)
			if err := s.CreateSession("alias-session", "canonical-project", dir); err != nil {
				t.Fatal(err)
			}
			// Even an already existing alias bucket must not capture current-directory writes.
			if err := s.EnrollProject("checkout.folder"); err != nil {
				t.Fatal(err)
			}
			knownAlias, err := resolveSaveWriteProject(s, "checkout.folder", true, "", "", nil)
			if err != nil || knownAlias.Project != "canonical-project" || knownAlias.Warning == "" {
				t.Fatalf("existing alias bucket captured write: %+v %v", knownAlias, err)
			}
			h := handleSave(s, MCPConfig{}, NewSessionActivity(time.Minute))
			if tool == "summary" {
				h = handleSessionSummary(s, MCPConfig{}, NewSessionActivity(time.Minute))
			}
			if tool == "finalize" {
				h = handleSessionFinalize(s, MCPConfig{}, NewSessionActivity(time.Minute))
			}
			raw := "CHECKOUT__FOLDER"
			args := map[string]any{"project": raw, "session_id": "alias-session", "title": "alias write", "content": "alias evidence"}
			if tool == "finalize" {
				args["summary"] = "alias evidence"
			}
			result, err := h(context.Background(), mcppkg.CallToolRequest{Params: mcppkg.CallToolParams{Arguments: args}})
			if err != nil || result.IsError {
				t.Fatalf("%s: %v %s", tool, err, callResultText(t, result))
			}
			observations, err := s.RecentObservations("canonical-project", "project", 10)
			if err != nil || len(observations) != 1 {
				t.Fatalf("observations=%+v %v", observations, err)
			}
			p, err := s.CaptureProjectProvenance("observation", strconv.FormatInt(observations[0].ID, 10))
			if err != nil || p == nil || p.Source != "explicit_override" || p.RawProject != raw || p.Directory != dir {
				t.Fatalf("provenance=%+v %v", p, err)
			}
			// Finalization has its own response; resolver warning is tested independently.
			res, err := resolveSaveWriteProject(s, raw, true, "", "alias-session", nil)
			if err != nil || res.Project != "canonical-project" || !strings.Contains(res.Warning, "alias") {
				t.Fatalf("resolution=%+v %v", res, err)
			}
		})
	}
}

func TestExplicitDirectoryAliasSessionAndForeignProjects(t *testing.T) {
	dir := aliasRepository(t, true)
	s := newMCPTestStore(t)
	for _, p := range []string{"canonical-project", "checkout.folder", "foreign"} {
		if err := s.StartSessionWithOwnershipMode(p, p, dir, store.SessionOwnershipProjectOwned); err != nil {
			t.Fatal(err)
		}
	}
	res, err := resolveSaveWriteProject(s, "checkout.folder", true, "", "checkout.folder", nil)
	if err != nil || res.Project != "checkout.folder" || res.Warning != "" {
		t.Fatalf("session must win: %+v %v", res, err)
	}
	res, err = resolveSaveWriteProject(s, "foreign", true, "", "", nil)
	if err != nil || res.Project != "foreign" || res.Source != projectpkg.SourceExplicitOverride {
		t.Fatalf("foreign target: %+v %v", res, err)
	}
	_, err = resolveSaveWriteProject(s, "checkout.folder", true, "", "foreign", nil)
	if err == nil {
		t.Fatal("normalized canonical bypassed session ownership")
	}
}

func TestExplicitDirectoryAliasTransitionFallback(t *testing.T) {
	dir := aliasRepository(t, false)
	s := newMCPTestStore(t)
	if err := s.CreateSession("historical", "old-project", dir); err != nil {
		t.Fatal(err)
	}
	if err := s.EnrollProject("checkout.folder"); err != nil {
		t.Fatal(err)
	}
	res, err := resolveSaveWriteProject(s, "checkout.folder", true, "", "", nil)
	if err != nil || res.Project != "checkout.folder" || !strings.Contains(res.Warning, "history under old-project") {
		t.Fatalf("fallback must expose strict failure: %+v %v", res, err)
	}
}

func TestExplicitDirectoryAliasReadExistingAndUnknown(t *testing.T) {
	aliasRepository(t, true)
	s := newMCPTestStore(t)
	res, err := resolveReadProject(s, "CHECKOUT_FOLDER")
	if err != nil || res.Project != "canonical-project" || res.Warning == "" {
		t.Fatalf("unknown alias: %+v %v", res, err)
	}
	if err := s.EnrollProject("checkout_folder"); err != nil {
		t.Fatal(err)
	}
	res, err = resolveReadProject(s, "CHECKOUT_FOLDER")
	if err != nil || res.Project != "checkout_folder" || res.Warning != "" {
		t.Fatalf("existing project changed: %+v %v", res, err)
	}
	_, err = resolveReadProject(s, "unrelated-unknown")
	if err == nil {
		t.Fatal("unknown foreign project accepted")
	}
}

func TestExplicitDirectoryAliasHomeNotNormalized(t *testing.T) {
	home := aliasRepository(t, true)
	t.Setenv("HOME", home)
	child := filepath.Join(home, "untracked")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(child)
	s := newMCPTestStore(t)
	if err := s.EnrollProject("checkout.folder"); err != nil {
		t.Fatal(err)
	}
	res, err := resolveSaveWriteProject(s, "checkout.folder", true, "", "", nil)
	if err != nil || res.Project != "checkout.folder" || res.Warning != "" {
		t.Fatalf("HOME guard changed: %+v %v", res, err)
	}
}
