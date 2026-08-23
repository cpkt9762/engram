package cloudcrypto

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestSealer(t *testing.T) *Sealer {
	t.Helper()
	key := make([]byte, KeySize)
	for i := range key {
		key[i] = byte(i)
	}
	s, err := NewSealer(key)
	if err != nil {
		t.Fatalf("new sealer: %v", err)
	}
	return s
}

func TestSealStringRoundTrip(t *testing.T) {
	s := newTestSealer(t)
	for _, plain := range []string{
		"hello",
		"反向代理配置在 nginx.conf 里",
		strings.Repeat("x", 5000),
		"line1\nline2\t\"quoted\"",
	} {
		sealed, err := s.SealString(plain)
		if err != nil {
			t.Fatalf("seal %q: %v", plain[:min(len(plain), 20)], err)
		}
		if !IsSealed(sealed) {
			t.Fatalf("sealed value missing marker: %q", sealed[:min(len(sealed), 20)])
		}
		if strings.Contains(sealed, plain) {
			t.Fatalf("plaintext visible in envelope")
		}
		back, err := s.OpenString(sealed)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		if back != plain {
			t.Fatalf("round trip mismatch")
		}
	}
}

func TestSealStringIsNonDeterministic(t *testing.T) {
	s := newTestSealer(t)
	a, _ := s.SealString("same input")
	b, _ := s.SealString("same input")
	// A fresh nonce per seal keeps the server from spotting that two rows hold
	// identical content.
	if a == b {
		t.Fatal("two seals of the same plaintext produced identical envelopes")
	}
}

func TestEmptyAndAlreadySealedPassThrough(t *testing.T) {
	s := newTestSealer(t)
	if out, _ := s.SealString(""); out != "" {
		t.Fatalf("empty string was sealed: %q", out)
	}
	once, _ := s.SealString("payload")
	twice, _ := s.SealString(once)
	// A retry after a partial push must not nest envelopes -- that would need
	// two Opens to recover and silently corrupt anything expecting one.
	if twice != once {
		t.Fatal("re-sealing an envelope produced a nested one")
	}
}

func TestOpenPassesThroughPlaintext(t *testing.T) {
	s := newTestSealer(t)
	// Rows written before encryption was enabled, or pulled from a server that
	// still holds plaintext, must survive Open untouched.
	out, err := s.OpenString("not encrypted at all")
	if err != nil {
		t.Fatalf("open plaintext: %v", err)
	}
	if out != "not encrypted at all" {
		t.Fatalf("plaintext was altered: %q", out)
	}
}

func TestOpenRejectsWrongKeyAndTampering(t *testing.T) {
	s := newTestSealer(t)
	sealed, _ := s.SealString("secret content")

	other := make([]byte, KeySize)
	for i := range other {
		other[i] = byte(255 - i)
	}
	wrong, err := NewSealer(other)
	if err != nil {
		t.Fatalf("new sealer: %v", err)
	}
	if _, err := wrong.OpenString(sealed); err == nil {
		t.Fatal("opening with the wrong key succeeded")
	}

	// Flip a byte in the ciphertext. GCM authenticates, so this must fail
	// loudly rather than yield garbage that would be written into the store.
	body := []byte(strings.TrimPrefix(sealed, "enc:v1:"))
	body[len(body)-1] ^= 0x01
	if _, err := s.OpenString("enc:v1:" + string(body)); err == nil {
		t.Fatal("opening tampered ciphertext succeeded")
	}
}

func TestSealMutationPayloadOnlyTouchesContentFields(t *testing.T) {
	s := newTestSealer(t)
	orig := []byte(`{"sync_id":"obs-1","session_id":"s1","project":"engram","type":"discovery","scope":"project","topic_key":"architecture/auth","revision_count":3,"title":"标题","content":"正文","last_seen_at":null}`)

	sealed, err := s.SealMutationPayload("observation", orig)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(sealed, &got); err != nil {
		t.Fatalf("sealed payload is not valid JSON: %v", err)
	}
	// The server validates and indexes on these; they must stay readable or
	// push is rejected.
	for field, want := range map[string]any{
		"sync_id":    "obs-1",
		"session_id": "s1",
		"project":    "engram",
		"type":       "discovery",
		"scope":      "project",
		"topic_key":  "architecture/auth",
	} {
		if got[field] != want {
			t.Fatalf("%s = %v, want %v", field, got[field], want)
		}
	}
	if got["revision_count"] != float64(3) {
		t.Fatalf("revision_count = %v, want 3", got["revision_count"])
	}
	if got["last_seen_at"] != nil {
		t.Fatalf("null field was altered: %v", got["last_seen_at"])
	}
	for _, f := range []string{"title", "content"} {
		v, _ := got[f].(string)
		if !IsSealed(v) {
			t.Fatalf("%s was not sealed: %q", f, v)
		}
	}
	if strings.Contains(string(sealed), "正文") {
		t.Fatal("plaintext content still present in payload")
	}

	opened, err := s.OpenMutationPayload("observation", sealed)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(opened, &back); err != nil {
		t.Fatalf("opened payload invalid: %v", err)
	}
	if back["title"] != "标题" || back["content"] != "正文" {
		t.Fatalf("round trip lost content: %v / %v", back["title"], back["content"])
	}
}

func TestSealMutationPayloadUnknownEntityUntouched(t *testing.T) {
	s := newTestSealer(t)
	orig := []byte(`{"sync_id":"rel-1","source_id":"a","target_id":"b"}`)
	out, err := s.SealMutationPayload("relation", orig)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if string(out) != string(orig) {
		t.Fatalf("relation payload was modified: %s", out)
	}
}

func TestSealChunkRoundTrip(t *testing.T) {
	s := newTestSealer(t)
	orig := []byte(`{"sessions":[{"id":"s1","project":"engram","directory":"/tmp","summary":"会话摘要"}],"observations":[{"sync_id":"o1","title":"标题","content":"正文","project":"engram"}],"prompts":[{"sync_id":"p1","content":"用户提问","session_id":"s1"}]}`)

	sealed, err := s.SealChunk(orig)
	if err != nil {
		t.Fatalf("seal chunk: %v", err)
	}
	for _, secret := range []string{"会话摘要", "标题", "正文", "用户提问"} {
		if strings.Contains(string(sealed), secret) {
			t.Fatalf("plaintext %q survived in sealed chunk", secret)
		}
	}
	// Structural fields the server indexes on must stay in the clear.
	for _, keep := range []string{`"s1"`, `"o1"`, `"p1"`, `"engram"`} {
		if !strings.Contains(string(sealed), keep) {
			t.Fatalf("structural value %s was lost", keep)
		}
	}

	opened, err := s.OpenChunk(sealed)
	if err != nil {
		t.Fatalf("open chunk: %v", err)
	}
	var back struct {
		Sessions     []map[string]any `json:"sessions"`
		Observations []map[string]any `json:"observations"`
		Prompts      []map[string]any `json:"prompts"`
	}
	if err := json.Unmarshal(opened, &back); err != nil {
		t.Fatalf("opened chunk invalid: %v", err)
	}
	if back.Sessions[0]["summary"] != "会话摘要" {
		t.Fatalf("session summary lost: %v", back.Sessions[0]["summary"])
	}
	if back.Observations[0]["title"] != "标题" || back.Observations[0]["content"] != "正文" {
		t.Fatalf("observation content lost")
	}
	if back.Prompts[0]["content"] != "用户提问" {
		t.Fatalf("prompt content lost")
	}
}

func TestSealChunkHandlesMissingSections(t *testing.T) {
	s := newTestSealer(t)
	orig := []byte(`{"observations":[{"sync_id":"o1","title":"t","content":"c"}]}`)
	sealed, err := s.SealChunk(orig)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	opened, err := s.OpenChunk(sealed)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var back map[string][]map[string]any
	if err := json.Unmarshal(opened, &back); err != nil {
		t.Fatalf("invalid: %v", err)
	}
	if back["observations"][0]["content"] != "c" {
		t.Fatalf("round trip failed: %v", back["observations"][0])
	}
}

func TestLoadOrCreateKeyIsStableAndOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreateKey(dir)
	if err != nil {
		t.Fatalf("create key: %v", err)
	}
	if len(first) != KeySize {
		t.Fatalf("key length = %d, want %d", len(first), KeySize)
	}

	fi, err := os.Stat(filepath.Join(dir, KeyFileName))
	if err != nil {
		t.Fatalf("stat key: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("key file mode = %04o, want 0600", got)
	}

	// A second call must return the same key, not roll a new one -- rolling
	// would make everything already on the server unreadable.
	second, err := LoadOrCreateKey(dir)
	if err != nil {
		t.Fatalf("reload key: %v", err)
	}
	if string(first) != string(second) {
		t.Fatal("key changed between calls")
	}
}

func TestNewSealerRejectsWrongKeySize(t *testing.T) {
	if _, err := NewSealer(make([]byte, 16)); err == nil {
		t.Fatal("accepted a 16-byte key")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
