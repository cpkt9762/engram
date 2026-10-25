package project

import (
	"context"
	"errors"
	"os"
	"testing"
)

func TestInspectLocalProjectCanceled(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := InspectLocalProject(ctx, root)
	if !errors.Is(err, context.Canceled) || result.Project != "" {
		t.Fatalf("result=%+v error=%v, want no identity and cancellation", result, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("canceled inspection changed fixture: entries=%v error=%v", entries, err)
	}
}
