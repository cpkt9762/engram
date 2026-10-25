package project

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLabelKeySharedVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/label-keys.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Name, Key string }
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if got := LabelKey(v.Name); got != v.Key {
			t.Errorf("LabelKey(%q)=%q want %q", v.Name, got, v.Key)
		}
	}
}

func TestDirectoryLabelsGitIdentity(t *testing.T) {
	repo := newIdentityGitRepo(t, "Checkout.Folder")
	gitIdentity(t, repo, "remote", "add", "origin", "https://example.test/Café_Remote.git")
	gitIdentity(t, repo, "remote", "add", "upstream", "https://example.test/foreign.git")
	check := func(dir, canonical string, names ...string) {
		t.Helper()
		labels, ok := DirectoryLabels(context.Background(), dir)
		if !ok || labels.Canonical != canonical {
			t.Fatalf("labels=%+v ok=%v", labels, ok)
		}
		for _, name := range names {
			if !labels.Matches(name) {
				t.Errorf("%q missing from %+v", name, labels)
			}
		}
		if labels.Matches("foreign") {
			t.Fatal("non-origin remote became alias")
		}
	}
	check(repo, "café_remote", "CAFE\u0301.REMOTE", "Checkout__Folder")
	if _, err := os.Stat(repositoryBindingPath(detectGitCommonDir(repo))); !os.IsNotExist(err) {
		t.Fatalf("inspection created binding: %v", err)
	}
	if res := DetectProjectFull(repo); res.Error != nil {
		t.Fatal(res.Error)
	}
	gitIdentity(t, repo, "remote", "set-url", "origin", "https://example.test/New-Origin.git")
	check(repo, "café_remote", "new_origin", "checkout-folder")
	commitEmptyGit(t, repo)
	linked := filepath.Join(t.TempDir(), "Linked.Worktree")
	addGitWorktree(t, repo, linked, "labels-feature")
	check(linked, "café_remote", "linked_worktree", "checkout-folder", "new.origin")
	if err := os.Mkdir(filepath.Join(linked, ".engram"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(linked, ".engram", "config.json"), []byte(`{"project_name":"Configured Name"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	check(linked, "configured name", "configured_name", "linked-worktree", "café_remote", "checkout.folder", "new.origin")
}

func TestDirectoryLabelsNonGitAndErrors(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Own.Folder")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(dir, "child")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	initGit(t, child)
	labels, ok := DirectoryLabels(context.Background(), dir)
	if !ok || !labels.Matches("OWN_FOLDER") || labels.Matches("child") || len(labels.Labels) != 1 {
		t.Fatalf("labels=%+v ok=%v", labels, ok)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := DirectoryLabels(ctx, dir); ok {
		t.Fatal("canceled inspection succeeded")
	}
	if err := os.Mkdir(filepath.Join(dir, ".engram"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".engram", "config.json"), []byte(`{"project_name":"bad/name"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := DirectoryLabels(context.Background(), dir); ok {
		t.Fatal("invalid config accepted")
	}
}

func TestDirectoryLabelsHomeRequiresExplicit(t *testing.T) {
	home := newIdentityGitRepo(t, "home")
	t.Setenv("HOME", home)
	dir := filepath.Join(home, "untracked-project")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, ok := DirectoryLabels(context.Background(), dir); ok {
		t.Fatal("untracked HOME descendant supplied aliases")
	}
}

func TestDirectoryLabelsSubmoduleUsesOwnCheckout(t *testing.T) {
	parent := newIdentityGitRepo(t, "parent-repo")
	commitEmptyGit(t, parent)
	source := newIdentityGitRepo(t, "module-source")
	commitEmptyGit(t, source)
	gitIdentity(t, parent, "-c", "protocol.file.allow=always", "submodule", "add", source, "Own.Module")
	module := filepath.Join(parent, "Own.Module")
	labels, ok := DirectoryLabels(context.Background(), module)
	if !ok || !labels.Matches("own_module") || labels.Matches("parent-repo") {
		t.Fatalf("submodule labels=%+v ok=%v", labels, ok)
	}
}
