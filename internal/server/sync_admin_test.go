package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

func adminRequest(s *Server, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func TestSyncAdminScanAndEnrollment(t *testing.T) {
	st := newServerTestStore(t)
	if err := st.CreateSession("admin-session", "demo", "/tmp/demo"); err != nil {
		t.Fatal(err)
	}
	id, err := st.AddPrompt(store.AddPromptParams{SessionID: "admin-session", Project: "demo", Content: "密码是 Zq9-FAKE-SECRET"})
	if err != nil {
		t.Fatal(err)
	}
	s := New(st, 0)
	scan := adminRequest(s, "GET", "/prompts/secret-scan?project=demo", "")
	if scan.Code != 200 {
		t.Fatalf("scan: %d %s", scan.Code, scan.Body.String())
	}
	if strings.Contains(scan.Body.String(), "Zq9-FAKE-SECRET") {
		t.Fatal("secret leaked")
	}
	var result struct {
		ScanToken string `json:"scan_token"`
		Items     []any  `json:"items"`
		Complete  bool   `json:"complete"`
	}
	if err := json.Unmarshal(scan.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || !result.Complete || result.ScanToken == "" {
		t.Fatalf("scan result: %+v", result)
	}
	join := func(token, instance string) *httptest.ResponseRecorder {
		return adminRequest(s, "POST", "/sync/enrollment", fmt.Sprintf(`{"project":"demo","scan_token":%q,"instance_id":%q}`, token, instance))
	}
	if w := join(result.ScanToken, "other"); w.Code != 409 {
		t.Fatalf("instance: %d", w.Code)
	}
	if _, err := st.AddPrompt(store.AddPromptParams{SessionID: "admin-session", Project: "demo", Content: "new prompt"}); err != nil {
		t.Fatal(err)
	}
	if w := join(result.ScanToken, st.InstanceID()); w.Code != 409 || !strings.Contains(w.Body.String(), "scan_stale") {
		t.Fatalf("stale: %d %s", w.Code, w.Body.String())
	}
	scan = adminRequest(s, "GET", "/prompts/secret-scan?project=demo", "")
	if err := json.Unmarshal(scan.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if w := join(result.ScanToken, st.InstanceID()); w.Code != 200 {
			t.Fatalf("join: %d %s", w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/prompts/recent?project=demo&masked=1", "/prompts/search?project=demo&q=密码&masked=1"} {
		w := adminRequest(s, "GET", path, "")
		if w.Code != 200 || strings.Contains(w.Body.String(), "Zq9-FAKE-SECRET") {
			t.Fatalf("masked: %d %s", w.Code, w.Body.String())
		}
	}
	w := adminRequest(s, "DELETE", fmt.Sprintf("/prompts/%d?expected_project=wrong&instance_id=%s", id, st.InstanceID()), "")
	if w.Code != 409 {
		t.Fatalf("project guard: %d", w.Code)
	}
	w = adminRequest(s, "DELETE", fmt.Sprintf("/prompts/%d?expected_project=demo&instance_id=%s", id, st.InstanceID()), "")
	if w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
}

func TestSyncAdminBrowserGuards(t *testing.T) {
	s := New(newServerTestStore(t), 0)
	for _, path := range []string{"/prompts/secret-scan?project=demo", "/sync/enrollment"} {
		method := "GET"
		if path == "/sync/enrollment" {
			method = "POST"
		}
		for _, tc := range []struct {
			host, origin, content string
			want                  int
		}{
			{"evil.example", "", "application/json", 403},
			{"127.0.0.1", "http://evil.example", "application/json", 403},
			{"localhost", "", "text/plain", 415},
		} {
			if method == "GET" && tc.want == 415 {
				continue
			}
			r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(`{}`))
			r.Host = tc.host
			r.Header.Set("Content-Type", tc.content)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Errorf("%s %+v: %d", path, tc, w.Code)
			}
		}
	}
	t.Setenv("ENGRAM_HTTP_TOKEN", "fake-admin-token")
	if w := adminRequest(s, "GET", "/prompts/secret-scan?project=demo", ""); w.Code != 401 {
		t.Fatalf("auth: %d", w.Code)
	}
}

func TestSyncAdminStatusAndValidation(t *testing.T) {
	st := newServerTestStore(t)
	s := New(st, 0)
	for _, tc := range []struct {
		method, path, body string
		code               int
	}{
		{"GET", "/sync/enrollment", "", 400}, {"GET", "/prompts/secret-scan", "", 400},
		{"GET", "/prompts/secret-scan?project=demo&cursor=invalid", "", 400},
		{"POST", "/sync/enrollment", "{", 400},
		{"POST", "/sync/enrollment", fmt.Sprintf(`{"project":"","instance_id":%q,"force":true}`, st.InstanceID()), 400},
		{"POST", "/sync/enrollment", fmt.Sprintf(`{"project":"empty","instance_id":%q,"force":true}`, st.InstanceID()), 200},
		{"GET", "/sync/enrollment?project=missing", "", 200},
		{"DELETE", "/prompts/999999?expected_project=demo", "", 404},
		{"DELETE", "/observations/999999?expected_project=demo&instance_id=wrong", "", 409},
	} {
		w := adminRequest(s, tc.method, tc.path, tc.body)
		if w.Code != tc.code {
			t.Errorf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
	w := adminRequest(s, "GET", "/sync/status?project=empty", "")
	if w.Code != 200 {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"target", "pending_count", "last_success_at", "status_at", "paused", "enrolled_count", "cloud_configured", "autosync_enabled"} {
		if _, ok := status[key]; !ok {
			t.Errorf("missing %s", key)
		}
	}
	if status["target"] != "cloud" {
		t.Fatal(status)
	}
	health := adminRequest(s, "GET", "/health", "")
	if !strings.Contains(health.Body.String(), `"sync-admin-v1":true`) {
		t.Fatal(health.Body.String())
	}
}

func TestSyncAdminStatusCompatibility(t *testing.T) {
	for _, configuredError := range []bool{false, true} {
		t.Run(fmt.Sprintf("configuration_error=%t", configuredError), func(t *testing.T) {
			s := New(newServerTestStore(t), 0)
			if configuredError {
				s.SetSyncAdminConfig(func() (bool, bool, error) { return true, true, fmt.Errorf("cloud config: 密码是 Zq9-FAKE-SECRET") })
			}
			w := adminRequest(s, "GET", "/sync/status", "")
			if w.Code != 200 {
				t.Fatalf("status: %d %s", w.Code, w.Body.String())
			}
			var response map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response["message"] != "background sync is not configured" || response["enabled"] != false {
				t.Fatalf("legacy fallback missing: %v", response)
			}
			for _, key := range []string{"target", "pending_count", "last_success_at", "status_at", "paused", "cloud_configured", "enrolled_count"} {
				if _, ok := response[key]; !ok {
					t.Errorf("missing %s", key)
				}
			}
			if configuredError {
				if response["cloud_configured"] != false || response["reason_code"] != "cloud_config_error" {
					t.Fatal(response)
				}
				if strings.Contains(w.Body.String(), "Zq9-FAKE-SECRET") || !strings.Contains(w.Body.String(), "[已遮蔽]") {
					t.Fatalf("unmasked config error: %s", w.Body.String())
				}
			}
		})
	}
}

func TestSyncAdminStatusConfigurationErrorWithProvider(t *testing.T) {
	s := New(newServerTestStore(t), 0)
	s.SetSyncStatus(&stubSyncStatusProvider{status: SyncStatus{Enabled: true, Phase: "healthy", ReasonCode: "upgrade_paused"}})
	s.SetSyncAdminConfig(func() (bool, bool, error) { return true, true, fmt.Errorf("token: Zq9-FAKE-SECRET") })
	w := adminRequest(s, "GET", "/sync/status", "")
	if w.Code != 200 {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["paused"] != true || response["enabled"] != true || response["cloud_configured"] != false || response["reason_code"] != "cloud_config_error" {
		t.Fatal(response)
	}
	if _, exists := response["message"]; exists {
		t.Fatalf("unexpected legacy fallback with provider: %v", response)
	}
	if strings.Contains(w.Body.String(), "Zq9-FAKE-SECRET") {
		t.Fatal("configuration secret leaked")
	}
}

func TestSyncAdminStorageErrorClassification(t *testing.T) {
	st := newServerTestStore(t)
	s := New(st, 0)
	instance := st.InstanceID()
	scan := adminRequest(s, "GET", "/prompts/secret-scan?project=demo", "")
	var snapshot struct {
		ScanToken string `json:"scan_token"`
	}
	if err := json.Unmarshal(scan.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if scan.Code != 200 || snapshot.ScanToken == "" {
		t.Fatalf("scan setup: %d %s", scan.Code, scan.Body.String())
	}
	for _, cursor := range []string{"bad", "bad:1", snapshot.ScanToken + ":bad", snapshot.ScanToken + ":-1", snapshot.ScanToken + ":9223372036854775808"} {
		w := adminRequest(s, "GET", "/prompts/secret-scan?project=demo&cursor="+cursor, "")
		if w.Code != 400 {
			t.Errorf("malformed cursor %q: %d %s", cursor, w.Code, w.Body.String())
		}
	}
	for _, project := range []string{"bad/project", store.ReservedInboxProjectName} {
		w := adminRequest(s, "POST", "/sync/enrollment", fmt.Sprintf(`{"project":%q,"instance_id":%q,"force":true}`, project, instance))
		if w.Code != 400 {
			t.Errorf("invalid enrollment project: %d %s", w.Code, w.Body.String())
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body, code string }{
		{"GET", "/prompts/secret-scan?project=demo", "", "scan_unavailable"},
		{"POST", "/sync/enrollment", fmt.Sprintf(`{"project":"demo","instance_id":%q,"force":true}`, instance), "enrollment_unavailable"},
	} {
		r := httptest.NewRequest(tc.method, "http://127.0.0.1"+tc.path, strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		// Invoke the route handler directly to isolate storage errors from generation shutdown.
		if tc.method == "GET" {
			s.handleSecretScan(w, r)
		} else {
			s.handleEnrollment(w, r)
		}
		if w.Code != 500 || !strings.Contains(w.Body.String(), tc.code) {
			t.Errorf("storage error: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestSyncAdminUnenrollment(t *testing.T) {
	st := newServerTestStore(t)
	s := New(st, 0)
	if err := st.EnrollProject("demo"); err != nil {
		t.Fatal(err)
	}
	path := "/sync/enrollment?project=demo&instance_id=" + st.InstanceID()
	t.Setenv("ENGRAM_HTTP_TOKEN", "fake-stop-token")
	if w := adminRequest(s, "DELETE", path, ""); w.Code != 401 {
		t.Fatalf("auth: %d", w.Code)
	}
	request := func(path, host, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("DELETE", "http://127.0.0.1"+path, nil)
		r.Host = host
		r.Header.Set("Authorization", "Bearer fake-stop-token")
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		path, host, origin string
		code               int
	}{
		{path, "evil.invalid", "", 403}, {path, "127.0.0.1", "http://evil.invalid", 403},
		{"/sync/enrollment?project=demo&instance_id=wrong", "127.0.0.1", "", 409},
		{"/sync/enrollment?project=demo", "127.0.0.1", "", 409},
		{"/sync/enrollment?instance_id=" + st.InstanceID(), "127.0.0.1", "", 400},
	} {
		w := request(tc.path, tc.host, tc.origin)
		if w.Code != tc.code {
			t.Errorf("delete: %d %s", w.Code, w.Body.String())
		}
	}
	for i := 0; i < 2; i++ {
		w := request(path, "127.0.0.1", "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"enrolled":false`) {
			t.Fatalf("idempotent stop: %d %s", w.Code, w.Body.String())
		}
	}
	w := adminRequest(s, "GET", "/health", "")
	if !strings.Contains(w.Body.String(), `"sync-admin-v2":true`) || !strings.Contains(w.Body.String(), `"sync-admin-v1":true`) {
		t.Fatal(w.Body.String())
	}
}

type blockStatusProvider struct {
	status  SyncStatus
	cleared string
}

func (p *blockStatusProvider) Status(string) SyncStatus { return p.status }
func (p *blockStatusProvider) ClearBlockedProject(project string) {
	p.cleared = project
	p.status.BlockedProjects = nil
}
func TestSyncStatusBlockedProjectsClearedOnUnenrollment(t *testing.T) {
	st := newServerTestStore(t)
	if err := st.CreateSession("blocked", "p", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := st.EnrollProject("p"); err != nil {
		t.Fatal(err)
	}
	provider := &blockStatusProvider{status: SyncStatus{BlockedProjects: []BlockedProject{{Project: "p", Code: "project_not_allowed", LastSeenAt: time.Now().UTC()}, {Project: "q", Code: "project_not_allowed", LastSeenAt: time.Now().UTC()}}}}
	s := New(st, 0)
	s.SetSyncStatus(provider)
	w := adminRequest(s, "GET", "/sync/status?project=p", "")
	var body struct {
		Blocked []BlockedProject `json:"blocked_projects"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(body.Blocked) != 1 || body.Blocked[0].Project != "p" {
		t.Fatalf("response: %d %s", w.Code, w.Body.String())
	}
	if w := adminRequest(s, "DELETE", "/sync/enrollment?project=p&instance_id="+st.InstanceID(), ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if provider.cleared != "p" {
		t.Fatal("provider evidence not cleared")
	}
	w = adminRequest(s, "GET", "/sync/status?project=p", "")
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Blocked) != 0 {
		t.Fatal(body.Blocked)
	}
}

func TestSyncAdminMaskingCoversNearbyCredentialExamples(t *testing.T) {
	examples := []string{"OpenWrt 可以用 ssh 10.0.0.1 密码 Abcd1234", "请输入后台管理密码并登录，…… Zq9Fake12", "root密码Abc12345", "the password is English9Fake", "password: Colon9Fake", "pwd Pwd9Fake12"}
	values := []string{"Abcd1234", "Zq9Fake12", "Abc12345", "English9Fake", "Colon9Fake", "Pwd9Fake12"}
	examples = append(examples, "OpenWrt 可以用 ssh 10.0.0.1 密码 abcdefgh", "[Assistant] 请提供路由器后台管理密码。"+strings.Repeat("等待说明", 80)+"\n[User] Zq9Fake1A")
	values = append(values, "abcdefgh", "Zq9Fake1A")
	st := newServerTestStore(t)
	if err := st.CreateSession("nearby", "demo", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	for _, content := range examples {
		if _, err := st.AddPrompt(store.AddPromptParams{SessionID: "nearby", Project: "demo", Content: content}); err != nil {
			t.Fatal(err)
		}
	}
	// Display projection must not change generic credential storage semantics.
	raw, err := st.RecentPrompts("demo", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != len(examples) {
		t.Fatal(len(raw))
	}
	for _, value := range values {
		if !strings.Contains(fmt.Sprint(raw), value) {
			t.Fatalf("display heuristic changed stored value: %s", value)
		}
	}
	s := New(st, 0)
	message := strings.Join(examples, "\n")
	s.SetSyncStatus(&stubSyncStatusProvider{status: SyncStatus{LastError: message, ReasonMessage: message, UpgradeReasonMessage: message}})
	for _, path := range []string{"/prompts/recent?project=demo&masked=1", "/prompts/search?project=demo&q=密码&masked=1", "/prompts/secret-scan?project=demo", "/sync/status?project=demo"} {
		w := adminRequest(s, "GET", path, "")
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		for _, value := range values {
			if strings.Contains(w.Body.String(), value) {
				t.Errorf("%s leaked %s", path, value)
			}
		}
	}
}
