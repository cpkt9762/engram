package autosync

import (
	"errors"
	"github.com/Gentleman-Programming/engram/v3/internal/cloud/remote"
	"testing"
	"time"
)

func TestBlockedProjectsSnapshotAndRecovery(t *testing.T) {
	m := New(newFakeLocalStore(), nil, DefaultConfig())
	until := time.Now().Add(time.Minute)
	m.status.ConsecutiveFailures = 5
	m.status.BackoffUntil = &until
	denied := func(project string) error {
		return &projectTransportFailure{project: project, err: &remote.HTTPStatusError{StatusCode: 403, ErrorCode: "policy_forbidden", Body: `forbidden: project "` + project + `" is not allowed`}}
	}
	m.recordPushBlocks(errors.Join(denied("a"), denied("b"), denied("a")))
	status := m.Status()
	if len(status.BlockedProjects) != 2 || status.BlockedProjects[0].Project != "a" || status.BlockedProjects[0].LastSeenAt.IsZero() {
		t.Fatalf("blocked snapshot: %+v", status)
	}
	if status.ConsecutiveFailures != 5 || !status.BackoffUntil.Equal(until) {
		t.Fatal("metadata altered backoff")
	}
	status.BlockedProjects[0].Project = "mutated"
	if m.Status().BlockedProjects[0].Project != "a" {
		t.Fatal("status leaked mutable slice")
	}
	m.ClearBlockedProject("a")
	if got := m.Status().BlockedProjects; len(got) != 1 || got[0].Project != "b" {
		t.Fatal(got)
	}
	m.recordPushBlocks(nil)
	if len(m.Status().BlockedProjects) != 0 {
		t.Fatal("successful next push did not clear")
	}
	m.recordPushBlocks(&projectTransportFailure{project: "p", err: &remote.HTTPStatusError{StatusCode: 403, ErrorCode: "policy_forbidden", Body: "other policy denial"}})
	if len(m.Status().BlockedProjects) != 0 {
		t.Fatal("generic 403 classified as project allowlist")
	}
}
