package cloudserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	cloudauth "github.com/Gentleman-Programming/engram/v3/internal/cloud/auth"
	"github.com/Gentleman-Programming/engram/v3/internal/cloud/cloudstore"
)

func captureAutoGrantLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	writer, flags, prefix := log.Writer(), log.Flags(), log.Prefix()
	log.SetOutput(&buf)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
		log.SetPrefix(prefix)
	})
	return &buf
}

func TestAutoGrantDisabledPreservesBaselineDenial(t *testing.T) {
	for _, readErr := range []error{nil, errors.New("private-storage-error"), fmt.Errorf("wrapped: %w", ErrProjectNotGranted)} {
		for _, withAudit := range []bool{false, true} {
			t.Run(fmt.Sprintf("readErr=%v/audit=%v", readErr, withAudit), func(t *testing.T) {
				logs := captureAutoGrantLogs(t)
				f := newAutoGrantFake()
				f.readErr = readErr
				srv := autoGrantServer(&fakeStore{}, f, false, 200)
				audit := newAdminTestStore()
				if withAudit {
					WithAdminIdentityStore(audit)(srv)
				}
				// Exact contract from 7f357c9: one denial log, then the optional
				// missing-audit-sink log, with an unchanged response and audit.
				wantLog := "[engram-cloud] project authorization denied: project=\"alpha\" actor=\"managed\" actor_source=\"managed_token\" reason=project_forbidden\n"
				if !withAudit {
					wantLog += "cloudserver: admin identity store is not configured; project authorization audit skipped\n"
				}
				wantEvent := cloudstore.AuthAuditEvent{
					ActorPrincipalID: "managed", ActorSource: "managed_token", Project: "alpha",
					Action: "sync.authorize", Outcome: "denied", ReasonCode: "project_forbidden",
					Metadata: map[string]any{"source": "managed_token"},
				}
				for i := 0; i < 3; i++ {
					w := autoGrantRequest(srv, http.MethodGet, "/sync/pull?project=alpha", "")
					if w.Code != http.StatusForbidden || w.Body.String() != "{\"error\":\"forbidden: project \\\"alpha\\\" is not allowed\",\"error_class\":\"policy\",\"error_code\":\"policy_forbidden\"}\n" {
						t.Fatalf("baseline response changed: status=%d body=%q", w.Code, w.Body.String())
					}
				}
				if logs.String() != strings.Repeat(wantLog, 3) {
					t.Fatalf("baseline log sequence changed: %q", logs.String())
				}
				wantEvents := []cloudstore.AuthAuditEvent(nil)
				if withAudit {
					wantEvents = []cloudstore.AuthAuditEvent{wantEvent, wantEvent, wantEvent}
				}
				if !reflect.DeepEqual(audit.auditEvents, wantEvents) || f.calls != 0 || len(f.events) != 0 {
					t.Fatalf("baseline audit changed: events=%+v grantCalls=%d grantEvents=%+v", audit.auditEvents, f.calls, f.events)
				}
			})
		}
	}
}

func TestAutoGrantEnabledThrottlesDecisionLogsOnly(t *testing.T) {
	logs := captureAutoGrantLogs(t)
	f := newAutoGrantFake()
	f.readErr = errors.New("private-storage-error")
	srv := autoGrantServer(&fakeStore{}, f, true, 200)
	audit := newAdminTestStore()
	WithAdminIdentityStore(audit)(srv)
	for i := 0; i < 3; i++ {
		w := autoGrantRequest(srv, http.MethodGet, "/sync/pull?project=alpha", "")
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected denial, got %d", w.Code)
		}
	}
	if strings.Count(logs.String(), "automatic grant decision reason=authorizer_error\n") != 1 ||
		strings.Count(logs.String(), "project authorization denied:") != 3 || len(audit.auditEvents) != 3 {
		t.Fatalf("decision throttle changed denial logs/audits: logs=%q audit=%+v", logs.String(), audit.auditEvents)
	}
	if strings.Contains(logs.String(), "private-storage-error") || strings.Contains(logs.String(), "Bearer token") {
		t.Fatalf("decision log exposed credentials or storage details: %q", logs.String())
	}
}

func TestAutoGrantDecisionLogsWindowAndIdentity(t *testing.T) {
	var limiter autoGrantDecisionLogs
	now := time.Unix(100, 0)
	key := autoGrantDecisionKey{reason: "storage_error", principal: "managed", project: "alpha"}
	for _, tc := range []struct {
		key  autoGrantDecisionKey
		at   time.Time
		want bool
	}{
		{key, now, true},
		{key, now, false},
		{key, now.Add(59 * time.Second), false},
		{autoGrantDecisionKey{"audit_failed", "managed", "alpha"}, now, true},
		{autoGrantDecisionKey{"storage_error", "other", "alpha"}, now, true},
		{autoGrantDecisionKey{"storage_error", "managed", "beta"}, now, true},
		{key, now.Add(60 * time.Second), true},
		{key, now.Add(61 * time.Second), false},
	} {
		if got := limiter.allow(tc.key, tc.at); got != tc.want {
			t.Fatalf("allow(%+v, %v)=%v want=%v", tc.key, tc.at, got, tc.want)
		}
	}
}

func TestAutoGrantDecisionLogsBounded(t *testing.T) {
	var limiter autoGrantDecisionLogs
	now := time.Unix(100, 0)
	key := autoGrantDecisionKey{reason: "storage_error", principal: "managed"}
	for i := 0; i < 1024; i++ {
		key.project = fmt.Sprint(i)
		if !limiter.allow(key, now) {
			t.Fatalf("first decision for project %s was suppressed", key.project)
		}
	}
	if limiter.allow(key, now) {
		t.Fatal("full cache stopped throttling existing keys")
	}
	key.project = "overflow"
	if !limiter.allow(key, now) || len(limiter.last) != 1 {
		t.Fatalf("overflow did not reset bounded cache: entries=%d", len(limiter.last))
	}
	if limiter.allow(key, now) {
		t.Fatal("overflow key was not throttled after reset")
	}
}

func TestAutoGrantDecisionLogsConcurrent(t *testing.T) {
	var limiter autoGrantDecisionLogs
	key := autoGrantDecisionKey{"storage_error", "managed", "alpha"}
	now := time.Unix(100, 0)
	results := make(chan bool, 64)
	for i := 0; i < cap(results); i++ {
		go func() { results <- limiter.allow(key, now) }()
	}
	allowed := 0
	for i := 0; i < cap(results); i++ {
		if <-results {
			allowed++
		}
	}
	if allowed != 1 {
		t.Fatalf("concurrent decisions logged %d times, want 1", allowed)
	}
}

// This fake provides the transaction seam without accessing Postgres.
type autoGrantFake struct {
	mu                sync.Mutex
	grants            map[string]map[string]bool
	events            []cloudstore.AuthAuditEvent
	readErr, writeErr error
	calls             int
}

func newAutoGrantFake() *autoGrantFake { return &autoGrantFake{grants: map[string]map[string]bool{}} }
func (f *autoGrantFake) AuthorizeProjectForPrincipal(_ context.Context, p cloudauth.Principal, project string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readErr != nil {
		return f.readErr
	}
	if f.grants[p.ID][cloudstore.NormalizeProjectGrant(project)] {
		return nil
	}
	return ErrProjectNotGranted
}
func (f *autoGrantFake) EnrolledProjectsForPrincipal(_ context.Context, p cloudauth.Principal) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readErr != nil {
		return nil, f.readErr
	}
	out := []string{}
	for project := range f.grants[p.ID] {
		out = append(out, project)
	}
	return out, nil
}
func (f *autoGrantFake) AutoCreateProjectGrants(_ context.Context, p, source string, projects []string, max int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.writeErr != nil {
		return f.writeErr
	}
	missing := map[string]bool{}
	for _, project := range projects {
		normalized := cloudstore.NormalizeProjectGrant(project)
		if normalized == "" || normalized == "inbox" || project == "*" {
			return errors.New("invalid project")
		}
		if !f.grants[p][normalized] {
			missing[normalized] = true
		}
	}
	if len(f.grants[p])+len(missing) > max {
		return errors.New("grant limit")
	}
	if f.grants[p] == nil {
		f.grants[p] = map[string]bool{}
	}
	for project := range missing {
		f.grants[p][project] = true
		f.events = append(f.events, cloudstore.AuthAuditEvent{ActorPrincipalID: p, TargetPrincipalID: p, ActorSource: source, Action: "grant.auto_create", Project: project, Metadata: map[string]any{"auto": true}})
	}
	return nil
}
func autoGrantPrincipal() cloudauth.Principal {
	return cloudauth.Principal{ID: "managed", Kind: cloudauth.PrincipalKindHuman, Source: cloudauth.PrincipalSourceManagedToken, Enabled: true}
}
func autoGrantServer(st ChunkStore, f *autoGrantFake, enabled bool, max int) *CloudServer {
	return New(st, resolvingAuth{principals: map[string]cloudauth.Principal{"token": autoGrantPrincipal()}}, 0,
		WithPrincipalProjectAuthorizer(f), WithAutoGrant(enabled, max), WithAutoGrantStore(f))
}
func autoGrantRequest(s *CloudServer, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer token")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w
}
func TestAutoGrantAdmission(t *testing.T) {
	for _, tc := range []struct {
		name, project     string
		enabled           bool
		max               int
		readErr, writeErr error
		want              bool
	}{
		{name: "disabled", project: "alpha", max: 200},
		{name: "first access", project: "alpha", enabled: true, max: 200, want: true},
		{name: "read failure", project: "alpha", enabled: true, max: 200, readErr: errors.New("read failure")},
		{name: "audit failure", project: "alpha", enabled: true, max: 200, writeErr: cloudstore.ErrAuthAuditInsertFailed},
		{name: "grant failure", project: "alpha", enabled: true, max: 200, writeErr: errors.New("grant failure")},
		{name: "empty", project: "", enabled: true, max: 200},
		{name: "wildcard", project: "*", enabled: true, max: 200},
		{name: "reserved", project: "Inbox", enabled: true, max: 200},
		{name: "reserved alias", project: " inbox/ ", enabled: true, max: 200},
		{name: "limit", project: "alpha", enabled: true, max: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAutoGrantFake()
			f.readErr, f.writeErr = tc.readErr, tc.writeErr
			f.grants["managed"] = map[string]bool{"existing": true}
			srv := autoGrantServer(&fakeStore{}, f, tc.enabled, tc.max)
			w := httptest.NewRecorder()
			got := srv.authorizeProjectScope(WithPrincipal(context.Background(), autoGrantPrincipal()), w, tc.project)
			if got != tc.want {
				t.Fatalf("allowed=%v want=%v body=%s", got, tc.want, w.Body.String())
			}
			if tc.want {
				if len(f.events) != 1 || !f.grants["managed"]["alpha"] {
					t.Fatalf("missing grant/audit: %+v", f)
				}
				e := f.events[0]
				if e.Action != "grant.auto_create" || e.ActorPrincipalID != "managed" || e.TargetPrincipalID != "managed" || e.Metadata["auto"] != true {
					t.Fatalf("bad audit: %+v", e)
				}
			} else {
				baseline := httptest.NewRecorder()
				New(&fakeStore{}, nil, 0).writeProjectPolicyDenied(context.Background(), baseline, tc.project)
				if w.Code != 403 || w.Body.String() != baseline.Body.String() {
					t.Fatalf("response changed: %q want %q", w.Body.String(), baseline.Body.String())
				}
				if len(f.events) != 0 || len(f.grants["managed"]) != 1 {
					t.Fatal("denied request changed grants/audit")
				}
				if tc.readErr != nil && f.calls != 0 {
					t.Fatal("read failure triggered auto grant")
				}
			}
		})
	}
}
func TestAutoGrantExistingAndNormalized(t *testing.T) {
	f := newAutoGrantFake()
	srv := autoGrantServer(&fakeStore{}, f, true, 1)
	for _, name := range []string{"Alpha/Foo", "alpha-foo", " ALPHA/FOO "} {
		w := httptest.NewRecorder()
		if !srv.authorizeProjectScope(WithPrincipal(context.Background(), autoGrantPrincipal()), w, name) {
			t.Fatalf("alias %q rejected: %s", name, w.Body.String())
		}
	}
	if len(f.events) != 1 || f.calls != 1 || len(f.grants["managed"]) != 1 {
		t.Fatalf("duplicate authorization: %+v", f)
	}
	if len(f.grants["other"]) != 0 {
		t.Fatal("granted another principal")
	}
}
func TestAutoGrantConcurrent(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(fmt.Sprint(same), func(t *testing.T) {
			f := newAutoGrantFake()
			srv := autoGrantServer(&fakeStore{}, f, true, 1)
			var wg sync.WaitGroup
			results := make(chan bool, 2)
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					name := "alpha"
					if !same {
						name = fmt.Sprintf("alpha-%d", i)
					}
					results <- srv.authorizeProjectScope(WithPrincipal(context.Background(), autoGrantPrincipal()), httptest.NewRecorder(), name)
				}(i)
			}
			wg.Wait()
			close(results)
			success := 0
			for ok := range results {
				if ok {
					success++
				}
			}
			want := 1
			if same {
				want = 2
			}
			if success != want || len(f.grants["managed"]) != 1 || len(f.events) != 1 {
				t.Fatalf("success=%d grants=%v events=%v", success, f.grants, f.events)
			}
		})
	}
}
func TestAutoGrantLegacyWildcardUnaffected(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		for _, allow := range []string{"*", "alpha"} {
			legacy, err := cloudauth.NewService(nil, strings.Repeat("x", 32))
			if err != nil {
				t.Fatal(err)
			}
			legacy.SetBearerToken("token")
			legacy.SetAllowedProjects([]string{allow})
			f := newAutoGrantFake()
			srv := New(&fakeStore{}, legacy, 0, WithPrincipalProjectAuthorizer(f), WithAutoGrant(enabled, 1), WithAutoGrantStore(f))
			w := autoGrantRequest(srv, http.MethodGet, "/sync/pull?project=arbitrary", "")
			want := 403
			if allow == "*" {
				want = 200
			}
			if w.Code != want || f.calls != 0 || len(f.events) != 0 {
				t.Fatalf("enabled=%v allow=%s status=%d calls=%d", enabled, allow, w.Code, f.calls)
			}
		}
	}
}
func TestAutoGrantEveryCallSite(t *testing.T) {
	cases := []struct {
		name, method, path, body string
		want                     int
	}{
		{"manifest", "GET", "/sync/pull?project=alpha", "", 200},
		{"chunk pull", "GET", "/sync/pull/chunk?project=alpha", "", 200},
		{"chunk push", "POST", "/sync/push", `{"project":"alpha","data":{"sessions":[{"id":"s","directory":"/tmp/s"}]}}`, 200},
		{"mutation push", "POST", "/sync/mutations/push", `{"entries":[{"project":"alpha","entity":"session","entity_key":"s","op":"upsert","payload":{"id":"s","project":"alpha"}}]}`, 200},
		{"session authority", "POST", "/sync/session-authorities", `{"session_id":"s","project":"alpha"}`, 200},
		{"pair claim", "POST", "/sync/prompt-pair-claims", `{"session_id":"s","source_inbox_id":"i","sync_id":"y","owner_project":"alpha","project":"beta"}`, 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAutoGrantFake()
			var st ChunkStore = newFakeMutationStore()
			if tc.name == "session authority" {
				st = &authorityTestStore{}
			} else if tc.name == "pair claim" {
				st = &pairClaimStore{owner: "alpha"}
			}
			if tc.name == "chunk pull" {
				st = &fakeStore{chunks: map[string][]byte{"chunk": []byte(`{}`)}}
			}
			w := autoGrantRequest(autoGrantServer(st, f, true, 200), tc.method, tc.path, tc.body)
			count := 1
			if tc.name == "pair claim" {
				count = 2
			}
			if w.Code != tc.want || len(f.events) != count {
				t.Fatalf("status=%d events=%d body=%s", w.Code, len(f.events), w.Body.String())
			}
		})
	}
}
func TestAutoGrantPromptPairAtomic(t *testing.T) {
	for _, project := range []string{"beta", "inbox"} {
		f := newAutoGrantFake()
		st := &pairClaimStore{owner: "alpha"}
		body := fmt.Sprintf(`{"session_id":"s","source_inbox_id":"i","sync_id":"y","owner_project":"alpha","project":%q}`, project)
		w := autoGrantRequest(autoGrantServer(st, f, true, 1), "POST", "/sync/prompt-pair-claims", body)
		if w.Code != 403 || len(f.grants["managed"]) != 0 || len(f.events) != 0 || st.lookup != 0 {
			t.Fatalf("partial grants: status=%d grants=%v events=%v lookup=%d", w.Code, f.grants, f.events, st.lookup)
		}
	}
}
func TestAutoGrantAggregatePullUnchanged(t *testing.T) {
	f := newAutoGrantFake()
	st := newFakeMutationStore()
	w := autoGrantRequest(autoGrantServer(st, f, true, 200), "GET", "/sync/mutations/pull", "")
	if w.Code != 200 || f.calls != 0 || len(f.events) != 0 {
		t.Fatalf("aggregate auto granted: status=%d calls=%d", w.Code, f.calls)
	}
}

func TestAutoGrantDisabledResponseBytes(t *testing.T) {
	f := newAutoGrantFake()
	w := autoGrantRequest(autoGrantServer(&fakeStore{}, f, false, 200), "GET", "/sync/pull?project=alpha", "")
	const expected = "{\"error\":\"forbidden: project \\\"alpha\\\" is not allowed\",\"error_class\":\"policy\",\"error_code\":\"policy_forbidden\"}\n"
	if w.Code != 403 || w.Body.String() != expected {
		t.Fatalf("response bytes changed: %q want %q", w.Body.String(), expected)
	}
}

func TestAutoGrantUnicodeGrantKeyCollision(t *testing.T) {
	f := newAutoGrantFake()
	srv := autoGrantServer(&fakeStore{}, f, true, 1)
	for _, name := range []string{"café/x", "caf🦀x"} {
		if !srv.authorizeProjectScope(WithPrincipal(context.Background(), autoGrantPrincipal()), httptest.NewRecorder(), name) {
			t.Fatalf("normalized alias %q rejected", name)
		}
	}
	if len(f.events) != 1 || len(f.grants["managed"]) != 1 || !f.grants["managed"]["caf-x"] {
		t.Fatalf("grant normalization drift: %+v", f)
	}
}
