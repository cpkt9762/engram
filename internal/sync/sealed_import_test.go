package sync

import (
	"bytes"
	"testing"

	"github.com/Gentleman-Programming/engram/v3/internal/cloud/cloudcrypto"
	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

// Production currently uses session classification only in local mode. Exercise
// its shared decoded-cache contract with cloud sealing enabled so future callers
// cannot hand encrypted cached fields directly to the apply loop.
func TestSealedSessionClassificationCacheImportsPlaintext(t *testing.T) {
	s := newTestStore(t)
	if err := s.EnrollProject("proj-a"); err != nil {
		t.Fatal(err)
	}
	transport := newFakeCloudTransport()
	importer := NewCloudWithTransport(s, transport, "proj-a")
	chunk := reuseSessionChunk("sess-sealed-cache", "proj-a")
	chunk.Observations = reuseObservationChunk("obs-sealed-cache", "sess-sealed-cache", "proj-a").Observations
	raw := mustJSONChunk(t, "chunk-sealed-cache", chunk)
	sealed, err := importer.sealChunkForCloud(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(sealed, []byte("enc:v1:")) {
		t.Fatal("fixture must contain sealed content")
	}
	transport.chunks["chunk-sealed-cache"] = sealed
	entries := []ChunkEntry{{ID: "chunk-sealed-cache", CreatedAt: "2026-10-25T00:00:00Z"}}
	result, err := importer.importEntriesDependencySafeWithProgress(entries, map[string]bool{}, importModeLocal, ownershipModeManifestVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ObservationsImported != 1 || result.ChunksImported != 1 {
		t.Fatalf("unexpected import result: %+v", result)
	}
	obs, err := s.GetObservationBySyncID("obs-sealed-cache")
	if err != nil {
		t.Fatal(err)
	}
	if obs.Title != "obs-sealed-cache" || obs.Content != "content obs-sealed-cache" {
		t.Fatalf("decoded cache stored ciphertext or wrong content: title=%q content=%q", obs.Title, obs.Content)
	}
}

// The dependency oracle reads pending chunks to classify relation endpoints
// and caches what it parsed, and the apply loop reuses that cache instead of
// reading the chunk again. On the cloud rail those chunks arrive sealed, so a
// cache filled without opening them hands ciphertext to the apply loop, and
// enc:v1: titles and content land in the local store.
//
// The manifest is version 2 on purpose: below that, legacy preflight opens
// every chunk and pre-fills the cache, which hides the gap. Every manifest the
// fork itself writes is version 2.
func TestCloudImportOpensChunksCachedByTheDependencyOracle(t *testing.T) {
	s := newTestStore(t)
	if err := s.EnrollProject("proj-a"); err != nil {
		t.Fatalf("enroll project: %v", err)
	}
	transport := newFakeCloudTransport()
	importer := NewCloudWithTransport(s, transport, "proj-a")

	// The relation in the first chunk forces the oracle to classify the second
	// chunk before the apply loop reaches it.
	relChunk := relationMissingEndpointChunk("sess-oracle-rel", "obs-oracle-a", "obs-oracle-b", "rel-oracle")
	endpointChunk := ChunkData{Mutations: []store.SyncMutation{
		{
			Entity:    store.SyncEntitySession,
			EntityKey: "sess-oracle-endpoint",
			Op:        store.SyncOpUpsert,
			Payload:   `{"id":"sess-oracle-endpoint","project":"proj-a","directory":"/tmp/proj-a"}`,
		},
		{
			Entity:    store.SyncEntityObservation,
			EntityKey: "obs-oracle-b",
			Op:        store.SyncOpUpsert,
			Payload:   `{"sync_id":"obs-oracle-b","session_id":"sess-oracle-endpoint","type":"decision","title":"endpoint b title","content":"endpoint b content","project":"proj-a","scope":"project"}`,
		},
	}}
	seal := func(id string, chunk ChunkData) []byte {
		t.Helper()
		raw := mustJSONChunk(t, id, chunk)
		sealed, err := importer.sealChunkForCloud(raw)
		if err != nil {
			t.Fatalf("seal %s: %v", id, err)
		}
		if bytes.Equal(sealed, raw) {
			t.Fatalf("fixture chunk %s was not sealed, so it cannot exercise the open path", id)
		}
		return sealed
	}
	transport.chunks["chunk-oracle-rel"] = seal("chunk-oracle-rel", relChunk)
	transport.chunks["chunk-oracle-endpoint"] = seal("chunk-oracle-endpoint", endpointChunk)
	transport.manifest = &Manifest{Version: ownershipModeManifestVersion, Chunks: []ChunkEntry{
		{ID: "chunk-oracle-rel", CreatedAt: "2026-10-13T00:00:00Z"},
		{ID: "chunk-oracle-endpoint", CreatedAt: "2026-10-13T00:01:00Z"},
	}}

	if _, err := importer.Import(); err != nil {
		t.Fatalf("import: %v", err)
	}
	for syncID, want := range map[string][2]string{
		"obs-oracle-a": {"endpoint a", "source endpoint"},
		"obs-oracle-b": {"endpoint b title", "endpoint b content"},
	} {
		obs, err := s.GetObservationBySyncID(syncID)
		if err != nil {
			t.Fatalf("%s not imported: %v", syncID, err)
		}
		if cloudcrypto.IsSealed(obs.Title) || cloudcrypto.IsSealed(obs.Content) {
			t.Fatalf("%s was stored sealed: title=%.40q content=%.40q", syncID, obs.Title, obs.Content)
		}
		if obs.Title != want[0] || obs.Content != want[1] {
			t.Fatalf("%s decrypted to the wrong text: title=%q content=%q", syncID, obs.Title, obs.Content)
		}
	}
	if _, err := s.GetRelation("rel-oracle"); err != nil {
		t.Fatalf("expected the cross-chunk relation to resolve: %v", err)
	}
}
