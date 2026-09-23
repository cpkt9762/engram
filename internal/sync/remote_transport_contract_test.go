package sync_test

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Gentleman-Programming/engram/v2/internal/cloud/remote"
	engramsync "github.com/Gentleman-Programming/engram/v2/internal/sync"
)

func TestRemoteTransportImplementsTransportContract(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sync/pull":
			if got := r.URL.Query().Get("project"); got != "proj-a" {
				http.Error(w, "project required", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":1,"chunks":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// The remote transport builds its own TLS config with an explicit root pool,
	// so swapping http.DefaultTransport no longer reaches it. Point it at the
	// test server's self-signed certificate the way a real deployment would.
	t.Setenv("ENGRAM_CLOUD_CA_FILE", writeTestCertPEM(t, srv))

	rt, err := remote.NewRemoteTransport(srv.URL, "token", "proj-a")
	if err != nil {
		t.Fatalf("NewRemoteTransport: %v", err)
	}

	var tr engramsync.Transport = rt
	if err := tr.WriteManifest(&engramsync.Manifest{Version: 1}); err != nil {
		t.Fatalf("WriteManifest should be accepted for remote transport: %v", err)
	}

	m, err := tr.ReadManifest()
	if err != nil {
		t.Fatalf("ReadManifest: %v", err)
	}
	if m.Version != 1 {
		t.Fatalf("expected version 1, got %d", m.Version)
	}
}

// writeTestCertPEM writes the httptest server's self-signed certificate to disk
// so ENGRAM_CLOUD_CA_FILE can point the remote transport at it.
func writeTestCertPEM(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ca.pem")
	block := &pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	return path
}
