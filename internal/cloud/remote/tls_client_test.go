package remote

import (
	"crypto/tls"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// writeCertPEM saves the test server's certificate so the client can be told to
// trust exactly it.
func writeCertPEM(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ca.pem")
	block := &pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	return path
}

func TestClientRejectsUntrustedCertByDefault(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client, err := newHTTPClient()
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	// Without being told what to trust, a self-signed server must be refused --
	// silently accepting it would make the TLS pointless.
	if _, err := client.Get(srv.URL); err == nil {
		t.Fatal("connected to an untrusted self-signed server")
	}
}

func TestClientTrustsConfiguredCAFile(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Setenv("ENGRAM_CLOUD_CA_FILE", writeCertPEM(t, srv))
	client, err := newHTTPClient()
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("get with configured CA: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	tr, ok := client.Transport.(*http.Transport)
	if !ok || tr.TLSClientConfig == nil {
		t.Fatal("client did not get a TLS config")
	}
	// The pool must replace the system roots, not extend them: the point is to
	// trust this one certificate, not to widen what the machine already trusts.
	if tr.TLSClientConfig.RootCAs == nil {
		t.Fatal("RootCAs was not set")
	}
	if tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("verification was disabled instead of pinned")
	}
	if tr.TLSClientConfig.MinVersion < tls.VersionTLS12 {
		t.Fatalf("MinVersion = %x, want >= TLS1.2", tr.TLSClientConfig.MinVersion)
	}
}

func TestClientFailsLoudlyOnBadCAFile(t *testing.T) {
	dir := t.TempDir()

	t.Setenv("ENGRAM_CLOUD_CA_FILE", filepath.Join(dir, "missing.pem"))
	if _, err := newHTTPClient(); err == nil {
		t.Fatal("a missing CA file was accepted")
	}

	junk := filepath.Join(dir, "junk.pem")
	if err := os.WriteFile(junk, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write junk: %v", err)
	}
	t.Setenv("ENGRAM_CLOUD_CA_FILE", junk)
	// Falling back to the system pool here would quietly drop the pinning.
	if _, err := newHTTPClient(); err == nil {
		t.Fatal("an unparseable CA file was accepted")
	}
}

func TestNewTransportsPropagateCAFailure(t *testing.T) {
	t.Setenv("ENGRAM_CLOUD_CA_FILE", filepath.Join(t.TempDir(), "nope.pem"))
	if _, err := NewRemoteTransport("https://example.invalid", "tok", "proj"); err == nil {
		t.Fatal("NewRemoteTransport ignored the CA failure")
	}
	if _, err := NewMutationTransport("https://example.invalid", "tok"); err == nil {
		t.Fatal("NewMutationTransport ignored the CA failure")
	}
}
