// Package cloudcrypto seals the content-bearing fields of a sync payload so a
// self-hosted cloud server stores ciphertext it cannot read.
//
// engram's cloud server is not a blob store: it unmarshals every payload to
// index sessions, count entities and materialize chunks, and it validates that
// sessions[i].id / observations[i].sync_id / entries[i].project are present.
// Encrypting a whole payload therefore breaks push. Only the fields the server
// never inspects are sealed -- title, content and summary -- which leaves the
// JSON shape and every structural field intact.
//
// What that deliberately does NOT hide: project names, sync ids, session ids,
// observation type, scope, topic keys, timestamps and per-project counts. An
// operator with database access still learns the shape of the work, just not
// its contents.
package cloudcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// envelopePrefix marks a sealed string. Values without it are passed
	// through untouched so rows written before encryption was enabled -- and
	// chunks pulled from a server that still holds plaintext -- keep working.
	envelopePrefix = "enc:v1:"

	KeyFileName = "cloud.key"
	KeySize     = 32 // AES-256

	keychainService = "engram-cloud-key"
)

// sealedFields lists, per sync entity, the fields the server never reads.
var sealedFields = map[string][]string{
	"observation": {"title", "content"},
	"prompt":      {"content"},
	"session":     {"summary"},
}

// chunkSections maps a chunk's arrays to the entity whose fields they hold.
var chunkSections = map[string]string{
	"observations": "observation",
	"prompts":      "prompt",
	"sessions":     "session",
}

// Sealer encrypts and decrypts payload fields with a locally held key.
type Sealer struct {
	aead     cipher.AEAD
	nonceKey []byte
}

// nonceKeyLabel domain-separates the nonce PRF from the encryption key so the
// two never coincide.
const nonceKeyLabel = "engram-cloud-nonce-v1"

// NewSealer builds a Sealer from a 32-byte key.
func NewSealer(key []byte) (*Sealer, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("cloudcrypto: key must be %d bytes, got %d", KeySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cloudcrypto: new cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("cloudcrypto: new gcm: %w", err)
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(nonceKeyLabel))
	return &Sealer{aead: aead, nonceKey: mac.Sum(nil)}, nil
}

// nonceFor derives a deterministic nonce from the plaintext (a synthetic IV).
//
// A random nonce would be the textbook choice, but chunk ids here are the hash
// of the sealed payload and the server rejects a chunk whose id does not match
// what it received. With random nonces the same observations re-seal to a new
// id on every attempt, so content-addressed dedup never hits and the server
// accumulates a duplicate chunk per retry.
//
// The cost is the usual deterministic-AEAD tradeoff: identical plaintext under
// the same key produces identical ciphertext, so an operator can tell that two
// fields hold the same value. They cannot tell what it is.
func (s *Sealer) nonceFor(plain []byte) []byte {
	mac := hmac.New(sha256.New, s.nonceKey)
	mac.Write(plain)
	return mac.Sum(nil)[:s.aead.NonceSize()]
}

// IsSealed reports whether a value carries the envelope marker.
func IsSealed(v string) bool { return strings.HasPrefix(v, envelopePrefix) }

// Disabled reports whether the operator has opted out of sealing cloud
// payloads. Encryption is on by default: the failure mode of forgetting to
// enable it is a silent plaintext upload, which is what it exists to prevent.
func Disabled() bool {
	return strings.TrimSpace(os.Getenv("ENGRAM_CLOUD_ENCRYPT")) == "0"
}

// SealString encrypts a plaintext into an envelope. Empty strings are left
// alone: sealing them would only add bulk and lose the "unset" distinction.
// A value that is already sealed is returned unchanged so a double pass -- for
// example a retry after a partial push -- cannot nest envelopes.
func (s *Sealer) SealString(plain string) (string, error) {
	if plain == "" || IsSealed(plain) {
		return plain, nil
	}
	nonce := s.nonceFor([]byte(plain))
	ct := s.aead.Seal(nonce, nonce, []byte(plain), nil)
	return envelopePrefix + base64.RawURLEncoding.EncodeToString(ct), nil
}

// OpenString decrypts an envelope. Anything without the marker is returned as
// is, which is what lets a store holding pre-encryption rows still be read.
func (s *Sealer) OpenString(v string) (string, error) {
	if !IsSealed(v) {
		return v, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(v, envelopePrefix))
	if err != nil {
		return "", fmt.Errorf("cloudcrypto: decode envelope: %w", err)
	}
	ns := s.aead.NonceSize()
	if len(raw) < ns {
		return "", fmt.Errorf("cloudcrypto: envelope too short")
	}
	plain, err := s.aead.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		// GCM authenticates, so this is either the wrong key or a tampered
		// payload. Both must be loud: silently returning ciphertext would
		// write garbage into the local store.
		return "", fmt.Errorf("cloudcrypto: open envelope: %w", err)
	}
	return string(plain), nil
}

// transform walks a single JSON object and applies fn to the named fields.
// It decodes into json.RawMessage rather than any so untouched values -- ints,
// nulls, nested objects -- survive the round trip byte for byte.
func transform(raw []byte, fields []string, fn func(string) (string, error)) ([]byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("cloudcrypto: parse object: %w", err)
	}
	changed := false
	for _, f := range fields {
		v, ok := obj[f]
		if !ok {
			continue
		}
		var str string
		if err := json.Unmarshal(v, &str); err != nil {
			// null or a non-string: nothing to seal.
			continue
		}
		out, err := fn(str)
		if err != nil {
			return nil, err
		}
		if out == str {
			continue
		}
		enc, err := json.Marshal(out)
		if err != nil {
			return nil, fmt.Errorf("cloudcrypto: encode field %s: %w", f, err)
		}
		obj[f] = enc
		changed = true
	}
	if !changed {
		return raw, nil
	}
	return json.Marshal(obj)
}

// SealMutationPayload seals one mutation journal entry.
func (s *Sealer) SealMutationPayload(entity string, payload []byte) ([]byte, error) {
	return s.mutation(entity, payload, s.SealString)
}

// OpenMutationPayload reverses SealMutationPayload.
func (s *Sealer) OpenMutationPayload(entity string, payload []byte) ([]byte, error) {
	return s.mutation(entity, payload, s.OpenString)
}

func (s *Sealer) mutation(entity string, payload []byte, fn func(string) (string, error)) ([]byte, error) {
	fields, ok := sealedFields[strings.TrimSpace(entity)]
	if !ok {
		// Relations and any future entity carry no free text; leave them be
		// rather than guessing at field names.
		return payload, nil
	}
	return transform(payload, fields, fn)
}

// SealChunk seals every entity inside a chunk payload
// ({sessions, observations, prompts}).
func (s *Sealer) SealChunk(payload []byte) ([]byte, error) {
	return s.chunk(payload, s.SealString)
}

// OpenChunk reverses SealChunk.
func (s *Sealer) OpenChunk(payload []byte) ([]byte, error) {
	return s.chunk(payload, s.OpenString)
}

func (s *Sealer) chunk(payload []byte, fn func(string) (string, error)) ([]byte, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(payload, &root); err != nil {
		return nil, fmt.Errorf("cloudcrypto: parse chunk: %w", err)
	}
	changed := false
	for section, entity := range chunkSections {
		rawList, ok := root[section]
		if !ok {
			continue
		}
		var items []json.RawMessage
		if err := json.Unmarshal(rawList, &items); err != nil {
			continue
		}
		sectionChanged := false
		for i, item := range items {
			out, err := transform(item, sealedFields[entity], fn)
			if err != nil {
				return nil, fmt.Errorf("cloudcrypto: chunk %s[%d]: %w", section, i, err)
			}
			if len(out) != len(item) || string(out) != string(item) {
				items[i] = out
				sectionChanged = true
			}
		}
		if sectionChanged {
			enc, err := json.Marshal(items)
			if err != nil {
				return nil, fmt.Errorf("cloudcrypto: encode chunk %s: %w", section, err)
			}
			root[section] = enc
			changed = true
		}
	}

	// A chunk also carries the mutation journal that produced it, and the
	// importer prefers that section over the entity arrays. Sealing only the
	// arrays would leave a full plaintext copy of every title and body sitting
	// in "mutations".
	mutationsChanged, err := s.chunkMutations(root, fn)
	if err != nil {
		return nil, err
	}
	changed = changed || mutationsChanged

	if !changed {
		return payload, nil
	}
	return json.Marshal(root)
}

// chunkMutations seals the nested payload of each entry in a chunk's mutation
// journal. The payload is a JSON document held as a string, so it has to be
// unquoted, transformed by the entry's own entity, and re-quoted.
func (s *Sealer) chunkMutations(root map[string]json.RawMessage, fn func(string) (string, error)) (bool, error) {
	rawList, ok := root["mutations"]
	if !ok {
		return false, nil
	}
	var items []map[string]json.RawMessage
	if err := json.Unmarshal(rawList, &items); err != nil {
		return false, nil
	}

	changed := false
	for i, item := range items {
		var entity string
		if raw, ok := item["entity"]; ok {
			_ = json.Unmarshal(raw, &entity)
		}
		fields, ok := sealedFields[strings.TrimSpace(entity)]
		if !ok {
			continue
		}
		rawPayload, ok := item["payload"]
		if !ok {
			continue
		}
		var inner string
		if err := json.Unmarshal(rawPayload, &inner); err != nil || strings.TrimSpace(inner) == "" {
			continue
		}
		out, err := transform([]byte(inner), fields, fn)
		if err != nil {
			return false, fmt.Errorf("cloudcrypto: chunk mutations[%d]: %w", i, err)
		}
		if string(out) == inner {
			continue
		}
		enc, err := json.Marshal(string(out))
		if err != nil {
			return false, fmt.Errorf("cloudcrypto: encode chunk mutations[%d]: %w", i, err)
		}
		items[i]["payload"] = enc
		changed = true
	}
	if !changed {
		return false, nil
	}
	enc, err := json.Marshal(items)
	if err != nil {
		return false, fmt.Errorf("cloudcrypto: encode chunk mutations: %w", err)
	}
	root["mutations"] = enc
	return true, nil
}

// ─── Key management ──────────────────────────────────────────────────────────

// KeyPath returns the location of the cloud key inside a data directory.
func KeyPath(dataDir string) string { return filepath.Join(dataDir, KeyFileName) }

// LoadOrCreateKey reads the key from dataDir, generating one on first use.
//
// Losing this key makes every sealed row on the server permanently unreadable.
// The local SQLite store keeps plaintext, so the blast radius is the cloud
// replica -- but on a second machine that only ever pulled, it is everything.
// On macOS the key is mirrored into the login keychain as a second copy.
func LoadOrCreateKey(dataDir string) ([]byte, error) {
	path := KeyPath(dataDir)
	data, err := os.ReadFile(path)
	if err == nil {
		key, decErr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if decErr != nil {
			return nil, fmt.Errorf("cloudcrypto: decode %s: %w", path, decErr)
		}
		if len(key) != KeySize {
			return nil, fmt.Errorf("cloudcrypto: %s holds %d bytes, want %d", path, len(key), KeySize)
		}
		return key, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("cloudcrypto: read %s: %w", path, err)
	}

	key := make([]byte, KeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("cloudcrypto: generate key: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	if err := os.WriteFile(path, []byte(encoded+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("cloudcrypto: write %s: %w", path, err)
	}
	mirrorToKeychain(encoded)
	return key, nil
}

// mirrorToKeychain stores a second copy in the macOS login keychain. Best
// effort: the file is authoritative, and a headless or non-darwin host simply
// skips it.
func mirrorToKeychain(encodedKey string) {
	if runtime.GOOS != "darwin" {
		return
	}
	bin, err := exec.LookPath("security")
	if err != nil {
		return
	}
	account := os.Getenv("USER")
	if account == "" {
		account = "engram"
	}
	// -U updates in place if the item already exists.
	_ = exec.Command(bin, "add-generic-password",
		"-U", "-s", keychainService, "-a", account, "-w", encodedKey,
	).Run()
}

// KeyFromKeychain reads the mirrored copy, for recovering a lost key file.
func KeyFromKeychain() ([]byte, error) {
	if runtime.GOOS != "darwin" {
		return nil, fmt.Errorf("cloudcrypto: keychain mirror is macOS only")
	}
	bin, err := exec.LookPath("security")
	if err != nil {
		return nil, fmt.Errorf("cloudcrypto: security binary not found: %w", err)
	}
	account := os.Getenv("USER")
	if account == "" {
		account = "engram"
	}
	out, err := exec.Command(bin, "find-generic-password",
		"-s", keychainService, "-a", account, "-w",
	).Output()
	if err != nil {
		return nil, fmt.Errorf("cloudcrypto: keychain lookup: %w", err)
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(out)))
	if err != nil {
		return nil, fmt.Errorf("cloudcrypto: decode keychain copy: %w", err)
	}
	if len(key) != KeySize {
		return nil, fmt.Errorf("cloudcrypto: keychain copy holds %d bytes, want %d", len(key), KeySize)
	}
	return key, nil
}
