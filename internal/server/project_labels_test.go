package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestCurrentProjectOptionalAliases(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Checkout.Folder")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q", dir}, {"-C", dir, "remote", "add", "origin", "https://example.test/Canonical.git"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git: %v %s", err, out)
		}
	}
	h := New(newServerTestStore(t), 0).Handler()
	call := func(query string) map[string]any {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/project/current?cwd="+url.QueryEscape(dir)+query, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d %s", rec.Code, rec.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	plain := call("")
	if _, ok := plain["aliases"]; ok {
		t.Fatalf("legacy response changed: %v", plain)
	}
	aliased := call("&aliases=true")
	if !reflect.DeepEqual(aliased["aliases"], []any{"checkout.folder"}) {
		t.Fatalf("aliases=%v", aliased)
	}
	delete(aliased, "aliases")
	if !reflect.DeepEqual(plain, aliased) {
		t.Fatalf("optional field changed envelope: %v / %v", plain, aliased)
	}
	if !reflect.DeepEqual(plain, call("&aliases=false")) {
		t.Fatal("aliases=false changed legacy response")
	}
}
