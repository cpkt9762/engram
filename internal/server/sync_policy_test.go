package server

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/Gentleman-Programming/engram/v3/internal/cloud/autosync"
	"github.com/Gentleman-Programming/engram/v3/internal/cloud/remote"
	"github.com/Gentleman-Programming/engram/v3/internal/store"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type policyTransport struct{ remote *remote.MutationTransport }

func (p policyTransport) PushMutations(entries []autosync.MutationEntry) (*autosync.PushMutationsResult, error) {
	out := make([]remote.MutationEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, remote.MutationEntry{Project: entry.Project, Entity: entry.Entity, EntityKey: entry.EntityKey, Op: entry.Op, Payload: entry.Payload})
	}
	seqs, err := p.remote.PushMutations(out)
	if err != nil {
		return nil, err
	}
	return &autosync.PushMutationsResult{AcceptedSeqs: seqs}, nil
}
func (p policyTransport) PullMutations(since int64, limit int) (*autosync.PullMutationsResponse, error) {
	response, err := p.remote.PullMutations(since, limit)
	if err != nil {
		return nil, err
	}
	return &autosync.PullMutationsResponse{HasMore: response.HasMore, LatestSeq: response.LatestSeq}, nil
}

type policyStatus struct{ manager *autosync.Manager }

func (p policyStatus) Status(string) SyncStatus {
	status := p.manager.Status()
	out := SyncStatus{Enabled: true, Phase: status.Phase, LastError: status.LastError, ConsecutiveFailures: status.ConsecutiveFailures, BackoffUntil: status.BackoffUntil}
	for _, entry := range status.BlockedProjects {
		out.BlockedProjects = append(out.BlockedProjects, BlockedProject{Project: entry.Project, Code: entry.Code, LastSeenAt: entry.LastSeenAt})
	}
	return out
}
func (p policyStatus) ClearBlockedProject(project string) { p.manager.ClearBlockedProject(project) }
func TestSyncStatusProjectPolicyHTTPRoundtrip(t *testing.T) {
	original := http.DefaultTransport
	guarded := http.DefaultTransport.(*http.Transport).Clone()
	guarded.Proxy = nil
	guarded.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			t.Errorf("non-loopback dial rejected: %s", address)
			return nil, fmt.Errorf("non-loopback dial rejected")
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	http.DefaultTransport = guarded
	defer func() { http.DefaultTransport = original; guarded.CloseIdleConnections() }()

	var allow atomic.Bool
	cloud := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sync/mutations/push" {
			var body struct {
				Entries []remote.MutationEntry `json:"entries"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			if !allow.Load() {
				jsonResponse(w, 403, map[string]string{"error_code": "policy_forbidden", "error": `forbidden: project "p" is not allowed`})
				return
			}
			seqs := []int64{}
			for i := range body.Entries {
				seqs = append(seqs, int64(i+1))
			}
			jsonResponse(w, 200, map[string]any{"accepted_seqs": seqs})
			return
		}
		jsonResponse(w, 200, map[string]any{"mutations": []any{}, "has_more": false, "latest_seq": 0})
	}))
	defer cloud.Close()
	transport, err := remote.NewMutationTransport(cloud.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	st := newServerTestStore(t)
	if err := st.EnrollProject("p"); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSession("policy", "p", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	add := func(title string) {
		if _, err := st.AddObservation(store.AddObservationParams{SessionID: "policy", Project: "p", Title: title, Content: title, Type: "discovery"}); err != nil {
			t.Fatal(err)
		}
	}
	add("blocked-one")
	cfg := autosync.DefaultConfig()
	cfg.PollInterval = 5 * time.Millisecond
	cfg.BaseBackoff = 10 * time.Millisecond
	cfg.MaxBackoff = 10 * time.Millisecond
	manager := autosync.New(st, policyTransport{transport}, cfg)
	manager.Start(context.Background())
	defer manager.Stop()
	s := New(st, 0)
	s.SetSyncStatus(policyStatus{manager})
	s.SetSyncAdminConfig(func() (bool, bool, error) { return true, true, nil })
	service := httptest.NewServer(s.Handler())
	defer service.Close()
	client := &http.Client{Timeout: time.Second}
	status := func() SyncStatus {
		response, err := client.Get(service.URL + "/sync/status?project=p")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		var out SyncStatus
		if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 {
			t.Fatalf("status %d", response.StatusCode)
		}
		return out
	}
	wait := func(label string, condition func() bool) {
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			if condition() {
				return
			}
			select {
			case <-deadline.C:
				t.Fatal("timeout: " + label)
			case <-ticker.C:
			}
		}
	}
	wait("typed 403 displayed", func() bool { return len(status().BlockedProjects) == 1 })
	first := status()
	if first.BlockedProjects[0].Code != "project_not_allowed" || first.BlockedProjects[0].LastSeenAt.IsZero() {
		t.Fatal(first)
	}
	allow.Store(true)
	wait("allowlisted successful push clears", func() bool {
		return len(status().BlockedProjects) == 0 && manager.Status().Phase == autosync.PhaseHealthy
	})
	allow.Store(false)
	add("blocked-two")
	wait("second denial", func() bool { return len(status().BlockedProjects) == 1 })
	request, err := http.NewRequest("DELETE", fmt.Sprintf("%s/sync/enrollment?project=p&instance_id=%s", service.URL, st.InstanceID()), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("stop %d", response.StatusCode)
	}
	if len(status().BlockedProjects) != 0 {
		t.Fatal("stop left active project evidence")
	}
	t.Log("loopback fake cloud 403 -> blocked_projects; allowlist/success clears; unenrollment clears; production backoff unchanged")
}
