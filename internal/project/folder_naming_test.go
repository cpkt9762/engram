package project

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNonGitParentUsesOwnFolder(t *testing.T) {
	for _, children := range []int{1, 2} {
		t.Run(string(rune('0'+children)), func(t *testing.T) {
			parent := filepath.Join(t.TempDir(), "my-workspace")
			if err := os.Mkdir(parent, 0o755); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < children; i++ {
				child := filepath.Join(parent, string(rune('a'+i)))
				if err := os.Mkdir(child, 0o755); err != nil {
					t.Fatal(err)
				}
				initGit(t, child)
			}
			result := DetectProjectFull(parent)
			if result.Error != nil || result.Project != "my-workspace" || result.Source != SourceDirBasename || result.Warning != "" || len(result.AvailableProjects) != 0 {
				t.Fatalf("non-git parent must retain its own identity: %+v", result)
			}
		})
	}
}
