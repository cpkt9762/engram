package cloudserver

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStartUsesTLSWhenCertConfigured(t *testing.T) {
	var plainCalls, tlsCalls int
	var gotCert, gotKey string

	s := &CloudServer{
		host: "127.0.0.1",
		port: 18090,
		listenAndServe: func(string, http.Handler) error {
			plainCalls++
			return nil
		},
		listenAndServeTLS: func(_, cert, key string, _ http.Handler) error {
			tlsCalls++
			gotCert, gotKey = cert, key
			return nil
		},
	}

	// Without a cert pair the server has to stay on the plaintext listener,
	// otherwise every existing tunnel-fronted deployment breaks.
	if err := s.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	if plainCalls != 1 || tlsCalls != 0 {
		t.Fatalf("plain=%d tls=%d, want 1/0", plainCalls, tlsCalls)
	}

	WithTLS("/etc/engram/tls.crt", "/etc/engram/tls.key")(s)
	if err := s.Start(); err != nil {
		t.Fatalf("start with tls: %v", err)
	}
	if tlsCalls != 1 {
		t.Fatalf("tls listener was not used: plain=%d tls=%d", plainCalls, tlsCalls)
	}
	if gotCert != "/etc/engram/tls.crt" || gotKey != "/etc/engram/tls.key" {
		t.Fatalf("cert/key not passed through: %q %q", gotCert, gotKey)
	}
}

func TestWithTLSIgnoresHalfConfiguredPair(t *testing.T) {
	for _, tc := range []struct{ cert, key string }{
		{"only.crt", ""},
		{"", "only.key"},
		{"  ", "  "},
	} {
		var tlsCalls int
		s := &CloudServer{
			host:              "127.0.0.1",
			listenAndServe:    func(string, http.Handler) error { return nil },
			listenAndServeTLS: func(string, string, string, http.Handler) error { tlsCalls++; return nil },
		}
		WithTLS(tc.cert, tc.key)(s)
		if err := s.Start(); err != nil {
			t.Fatalf("start: %v", err)
		}
		// Half a pair must not silently downgrade to a listener that looks
		// encrypted but is not, nor crash on a missing file.
		if tlsCalls != 0 {
			t.Fatalf("cert=%q key=%q started a TLS listener", tc.cert, tc.key)
		}
	}
}

func TestWithoutDashboardDropsPreAuthRoutes(t *testing.T) {
	for _, tc := range []struct {
		name     string
		opts     []Option
		wantCode int
	}{
		{"dashboard on", nil, http.StatusSeeOther},
		{"dashboard off", []Option{WithoutDashboard()}, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := New(&fakeStore{}, fakeAuth{}, 0, tc.opts...)
			rec := httptest.NewRecorder()
			s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/dashboard/bootstrap", nil))
			if rec.Code != tc.wantCode {
				t.Fatalf("/dashboard/bootstrap = %d, want %d", rec.Code, tc.wantCode)
			}

			// Disabling the dashboard must not take the sync API with it.
			rec = httptest.NewRecorder()
			s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sync/pull", nil))
			if rec.Code == http.StatusNotFound {
				t.Fatal("/sync/pull disappeared along with the dashboard")
			}
		})
	}
}

func TestDashboardFromEnvOptOut(t *testing.T) {
	t.Setenv("ENGRAM_CLOUD_DASHBOARD", "0")
	s := New(&fakeStore{}, fakeAuth{}, 0, WithDashboardFromEnv())
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/dashboard/bootstrap", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/dashboard/bootstrap = %d, want 404", rec.Code)
	}
}
