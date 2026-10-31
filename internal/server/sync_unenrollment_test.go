package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Gentleman-Programming/engram/v3/internal/cloud/autosync"
	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

type enrollmentCloudTransport struct {
	url    string
	client *http.Client
}

func (c enrollmentCloudTransport) PushMutations(entries []autosync.MutationEntry) (*autosync.PushMutationsResult, error) {
	body, err := json.Marshal(entries)
	if err != nil {
		return nil, err
	}
	response, err := c.client.Post(c.url+"/push", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	var result autosync.PushMutationsResult
	err = json.NewDecoder(response.Body).Decode(&result)
	return &result, err
}
func (c enrollmentCloudTransport) PullMutations(seq int64, limit int) (*autosync.PullMutationsResponse, error) {
	response, err := c.client.Get(c.url + "/pull?since=" + strconv.FormatInt(seq, 10))
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	var result autosync.PullMutationsResponse
	err = json.NewDecoder(response.Body).Decode(&result)
	return &result, err
}

func TestUnenrollmentHTTPReplicationSemantics(t *testing.T) {
	local, peer := newServerTestStore(t), newServerTestStore(t)
	for _, st := range []*store.Store{local, peer} {
		if err := st.EnrollProject("demo"); err != nil {
			t.Fatal(err)
		}
	}
	if err := local.CreateSession("local", "demo", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if _, err := local.AddObservation(store.AddObservationParams{SessionID: "local", Project: "demo", Title: "pending-before-stop", Content: "before", Type: "discovery"}); err != nil {
		t.Fatal(err)
	}
	ackedID, err := local.AddObservation(store.AddObservationParams{SessionID: "local", Project: "demo", Title: "previously-uploaded", Content: "acked-before-stop", Type: "discovery"})
	if err != nil {
		t.Fatal(err)
	}
	acked, err := local.GetObservation(ackedID)
	if err != nil {
		t.Fatal(err)
	}
	queued, err := local.ListPendingSyncMutations("cloud", 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range queued {
		if row.EntityKey == acked.SyncID {
			if err := local.AckSyncMutationSeqs("cloud", []int64{row.Seq}); err != nil {
				t.Fatal(err)
			}
		}
	}
	before, err := local.CloudAdminState()
	if err != nil {
		t.Fatal(err)
	}
	if before.PendingCount == 0 {
		t.Fatal("no queued mutations")
	}
	srv := New(local, 0)
	srv.SetSyncAdminConfig(func() (bool, bool, error) { return true, true, nil })
	service := httptest.NewServer(srv.Handler())
	defer service.Close()
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("non-loopback dial blocked")
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}}}
	t.Cleanup(client.CloseIdleConnections)
	stop := func() {
		r, err := http.NewRequest("DELETE", service.URL+"/sync/enrollment?project=demo&instance_id="+local.InstanceID(), nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != 200 {
			t.Fatalf("stop: %d", response.StatusCode)
		}
	}
	stop()
	pending, err := local.ListPendingSyncMutations("cloud", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatal("stopped project's queue still eligible")
	}
	retained, err := local.CloudAdminState()
	if err != nil {
		t.Fatal(err)
	}
	if retained.PendingCount != before.PendingCount {
		t.Fatalf("queue discarded: %+v -> %+v", before, retained)
	}
	if _, err := local.AddObservation(store.AddObservationParams{SessionID: "local", Project: "demo", Title: "written-while-stopped", Content: "during", Type: "discovery"}); err != nil {
		t.Fatal(err)
	}
	edited := "edited-acked-during-stop"
	if _, err := local.UpdateObservationForProject(ackedID, "demo", store.UpdateObservationParams{Content: &edited}); err != nil {
		t.Fatal(err)
	}
	afterWrite, err := local.CloudAdminState()
	if err != nil {
		t.Fatal(err)
	}
	if afterWrite.PendingCount != retained.PendingCount {
		t.Fatal("unenrolled local write entered queue")
	}
	if err := peer.CreateSession("peer", "demo", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	_, err = peer.AddObservation(store.AddObservationParams{SessionID: "peer", Project: "demo", Title: "remote-while-stopped", Content: "incoming", Type: "discovery"})
	if err != nil {
		t.Fatal(err)
	}
	peerRows, err := peer.ListPendingSyncMutations("cloud", 100)
	if err != nil {
		t.Fatal(err)
	}
	pulled := []autosync.PulledMutation{}
	for i, row := range peerRows {
		pulled = append(pulled, autosync.PulledMutation{Seq: int64(i + 1), Project: row.Project, Entity: row.Entity, EntityKey: row.EntityKey, Op: row.Op, Payload: json.RawMessage(row.Payload)})
	}
	var mu sync.Mutex
	pushed := []autosync.MutationEntry{}
	pullCalls := 0
	cloud := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/push" {
			var entries []autosync.MutationEntry
			if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			pushed = append(pushed, entries...)
			seqs := []int64{}
			for i := range entries {
				seqs = append(seqs, int64(i+1))
			}
			jsonResponse(w, 200, autosync.PushMutationsResult{AcceptedSeqs: seqs})
			return
		}
		pullCalls++
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		items := []autosync.PulledMutation{}
		for _, row := range pulled {
			if row.Seq > since {
				items = append(items, row)
			}
		}
		jsonResponse(w, 200, autosync.PullMutationsResponse{Mutations: items, LatestSeq: int64(len(pulled))})
	}))
	defer cloud.Close()
	cfg := autosync.DefaultConfig()
	cfg.PollInterval = 10 * time.Millisecond
	cfg.DebounceDuration = time.Millisecond
	manager := autosync.New(local, enrollmentCloudTransport{cloud.URL, client}, cfg)
	manager.Start(context.Background())
	defer manager.Stop()
	await := func(label string, ready func() bool) {
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			if ready() {
				return
			}
			select {
			case <-deadline.C:
				t.Fatal("timeout: " + label)
			case <-ticker.C:
			}
		}
	}
	await("inbound despite unenrollment", func() bool {
		rows, err := local.RecentObservations("demo", "", 20)
		if err != nil {
			return false
		}
		for _, row := range rows {
			if row.Title == "remote-while-stopped" {
				return true
			}
		}
		return false
	})
	mu.Lock()
	if len(pushed) != 0 || pullCalls == 0 {
		t.Errorf("stopped transfer: pushed=%d pulls=%d", len(pushed), pullCalls)
	}
	mu.Unlock()
	scan, err := local.ScanPromptSecrets("demo", "")
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"project":"demo","instance_id":%q,"scan_token":%q}`, local.InstanceID(), scan.ScanToken)
	response, err := client.Post(service.URL+"/sync/enrollment", "application/json", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("rejoin: %d", response.StatusCode)
	}
	await("old backlog and stopped local write upload", func() bool {
		mu.Lock()
		defer mu.Unlock()
		old, newWrite := false, false
		for _, row := range pushed {
			if bytes.Contains(row.Payload, []byte("pending-before-stop")) {
				old = true
			}
			if bytes.Contains(row.Payload, []byte("written-while-stopped")) {
				newWrite = true
			}
		}
		return old && newWrite
	})
	mu.Lock()
	for _, row := range pushed {
		if bytes.Contains(row.Payload, []byte(edited)) {
			t.Error("acked same-project history unexpectedly backfilled")
		}
	}
	mu.Unlock()
	t.Log("verified limitation: editing an already-acked same-project observation while stopped is not backfilled by re-enrollment")

	t.Log("verified: pending queue retained but ineligible; inbound applied while stopped; rejoin uploads old backlog and local writes made while stopped")
}
