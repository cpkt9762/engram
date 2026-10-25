package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func renameSnapshot(t *testing.T, s *Store) string {
	t.Helper()
	// Include every table and FTS shadow table, plus sqlite_sequence: a refused
	// rename must preserve the entire logical database, not only moved rows.
	tableRows, err := s.db.Query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for tableRows.Next() {
		var name string
		if err := tableRows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	if err := tableRows.Err(); err != nil {
		t.Fatal(err)
	}
	if err := tableRows.Close(); err != nil {
		t.Fatal(err)
	}
	snapshot := map[string][]string{}
	for _, table := range tables {
		rows, err := s.db.Query(`SELECT * FROM "` + strings.ReplaceAll(table, `"`, `""`) + `"`)
		if err != nil {
			t.Fatal(err)
		}
		cols, err := rows.Columns()
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			row := map[string]any{}
			for i, col := range cols {
				row[col] = vals[i]
			}
			encoded, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			snapshot[table] = append(snapshot[table], string(encoded))
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
		sort.Strings(snapshot[table])
	}
	b, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProjectRenamePreviewAndApply(t *testing.T) {
	for _, enrolled := range []bool{false, true} {
		t.Run(map[bool]string{false: "local", true: "enrolled"}[enrolled], func(t *testing.T) {
			s := newTestStore(t)
			for _, project := range []string{"source", "target"} {
				if err := s.CreateSession(project+"-session", project, "/tmp/repo"); err != nil {
					t.Fatal(err)
				}
				if _, err := s.AddObservation(AddObservationParams{SessionID: project + "-session", Project: project, Type: "note", Title: "rename searchable", Content: "套利 observation " + project}); err != nil {
					t.Fatal(err)
				}
				if _, err := s.AddPrompt(AddPromptParams{SessionID: project + "-session", Project: project, Content: "套利 searchable prompt " + project}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.db.Exec(`INSERT INTO project_aliases VALUES ('key','repo','source');
    INSERT INTO prompt_tombstones(sync_id, session_id, project, local_creation_project) VALUES ('dead-prompt','source-session','source','source');
    INSERT INTO sync_delete_tombstones(entity,entity_key,session_id,project) VALUES ('observation','dead-observation','source-session','source');
    INSERT INTO capture_project_provenance VALUES ('session','source-session','explicit','/tmp/repo','source');`); err != nil {
				t.Fatal(err)
			}
			if enrolled {
				if err := s.EnrollProject("source"); err != nil {
					t.Fatal(err)
				}
				rows, err := s.db.Query(`SELECT target_key,seq FROM sync_mutations ORDER BY seq`)
				if err != nil {
					t.Fatal(err)
				}
				seqs := map[string][]int64{}
				for rows.Next() {
					var target string
					var seq int64
					if err := rows.Scan(&target, &seq); err != nil {
						t.Fatal(err)
					}
					seqs[target] = append(seqs[target], seq)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				if err := rows.Close(); err != nil {
					t.Fatal(err)
				}
				for target, batch := range seqs {
					if err := s.AckSyncMutationSeqs(target, batch); err != nil {
						t.Fatal(err)
					}
				}
			}
			// Simulate current materialized content newer than the acknowledged
			// snapshot without enqueueing it: rename's backfill must read it afresh.
			if _, err := s.db.Exec(`UPDATE observations SET content='套利 current observation source' WHERE project='source'; UPDATE user_prompts SET content='套利 current searchable prompt source' WHERE project='source'; UPDATE sessions SET directory='/tmp/current-repo' WHERE project='source'`); err != nil {
				t.Fatal(err)
			}
			var ackedBefore string
			if err := s.db.QueryRow(`SELECT coalesce(json_group_array(json_object('seq',seq,'target_key',target_key,'entity',entity,'entity_key',entity_key,'op',op,'payload',payload,'source',source,'occurred_at',occurred_at,'acked_at',acked_at,'project',project,'disposition',disposition,'disposition_reason',disposition_reason,'disposition_evidence',disposition_evidence,'disposition_at',disposition_at)), '[]') FROM sync_mutations WHERE acked_at IS NOT NULL`).Scan(&ackedBefore); err != nil {
				t.Fatal(err)
			}
			before := renameSnapshot(t, s)
			exported, err := s.Export()
			if err != nil {
				t.Fatal(err)
			}
			preview, err := s.PreviewProjectRename(" SOURCE ", "TARGET")
			if err != nil {
				t.Fatal(err)
			}
			if !preview.TargetExists || preview.SourceEnrolled != enrolled || preview.TargetEnrolled {
				t.Fatalf("preview flags: %+v", preview)
			}
			for _, table := range []string{"sessions", "observations", "user_prompts", "project_aliases", "prompt_tombstones", "sync_delete_tombstones"} {
				if preview.Tables[table] != 1 {
					t.Fatalf("%s count=%d", table, preview.Tables[table])
				}
			}
			if before != renameSnapshot(t, s) {
				t.Fatal("preview changed DB")
			}
			afterExport, err := s.Export()
			if err != nil {
				t.Fatal(err)
			}
			exported.ExportedAt, afterExport.ExportedAt = "", ""
			if !reflect.DeepEqual(exported, afterExport) {
				t.Fatal("preview changed Export")
			}
			result, err := s.RenameProject(preview.Source, preview.Target)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(preview.Tables, result.Tables) {
				t.Fatalf("preview/apply scope mismatch: %v vs %v", preview.Tables, result.Tables)
			}
			for _, table := range []string{"sessions", "observations", "user_prompts", "project_aliases", "prompt_tombstones", "sync_delete_tombstones", "sync_enrolled_projects"} {
				var count int
				if err := s.db.QueryRow("SELECT count(*) FROM " + table + " WHERE project='source'").Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 0 {
					t.Fatalf("%s retained source", table)
				}
			}
			for _, query := range []string{"searchable", "套利"} {
				hits, err := s.Search(query, SearchOptions{Project: "target"})
				if err != nil || len(hits) != 2 {
					t.Fatalf("search %q: %d, %v", query, len(hits), err)
				}
				prompts, err := s.SearchPrompts(query, "target", 20)
				if err != nil || len(prompts) != 2 {
					t.Fatalf("prompt search %q: %d, %v", query, len(prompts), err)
				}
			}
			var ackedAfter string
			if err := s.db.QueryRow(`SELECT coalesce(json_group_array(json_object('seq',seq,'target_key',target_key,'entity',entity,'entity_key',entity_key,'op',op,'payload',payload,'source',source,'occurred_at',occurred_at,'acked_at',acked_at,'project',project,'disposition',disposition,'disposition_reason',disposition_reason,'disposition_evidence',disposition_evidence,'disposition_at',disposition_at)), '[]') FROM sync_mutations WHERE acked_at IS NOT NULL`).Scan(&ackedAfter); err != nil {
				t.Fatal(err)
			}
			if ackedBefore != ackedAfter {
				t.Fatal("acked row changed")
			}
			var pending int
			if err := s.db.QueryRow(`SELECT count(*) FROM sync_mutations WHERE acked_at IS NULL`).Scan(&pending); err != nil {
				t.Fatal(err)
			}
			if enrolled && pending == 0 || !enrolled && pending != 0 {
				t.Fatalf("pending=%d enrolled=%t", pending, enrolled)
			}
			if enrolled {
				// Assert one new upsert per acknowledged current entity, with its
				// current content rather than merely checking entity categories.
				rows, err := s.db.Query(`SELECT entity,entity_key FROM sync_mutations WHERE project='source' AND acked_at IS NOT NULL AND op='upsert' GROUP BY entity,entity_key`)
				if err != nil {
					t.Fatal(err)
				}
				type key struct{ entity, id string }
				var keys []key
				for rows.Next() {
					var k key
					if err := rows.Scan(&k.entity, &k.id); err != nil {
						t.Fatal(err)
					}
					keys = append(keys, k)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				if err := rows.Close(); err != nil {
					t.Fatal(err)
				}
				if len(keys) != 3 {
					t.Fatalf("acked current entities=%v", keys)
				}
				for _, k := range keys {
					var count int
					var payload string
					if err := s.db.QueryRow(`SELECT count(*),coalesce(min(payload),'') FROM sync_mutations WHERE entity=? AND entity_key=? AND project='target' AND acked_at IS NULL AND disposition='pending' AND op='upsert'`, k.entity, k.id).Scan(&count, &payload); err != nil {
						t.Fatal(err)
					}
					if count != 1 {
						t.Fatalf("%s/%s pending upserts=%d", k.entity, k.id, count)
					}
					var body map[string]any
					if err := json.Unmarshal([]byte(payload), &body); err != nil {
						t.Fatal(err)
					}
					if body["project"] != "target" {
						t.Fatalf("payload=%s", payload)
					}
					switch k.entity {
					case "observation":
						if body["content"] != "套利 current observation source" || body["title"] != "rename searchable" {
							t.Fatalf("observation payload=%s", payload)
						}
					case "prompt":
						if body["content"] != "套利 current searchable prompt source" {
							t.Fatalf("prompt payload=%s", payload)
						}
					case "session":
						if body["id"] != "source-session" || body["directory"] != "/tmp/current-repo" {
							t.Fatalf("session payload=%s", payload)
						}
					}
				}
			}
			beforeBackfill := renameSnapshot(t, s)
			if err := s.EnsureEnrolledProjectSyncMutations(context.Background()); err != nil {
				t.Fatal(err)
			}
			if beforeBackfill != renameSnapshot(t, s) {
				t.Fatal("second backfill added mutations")
			}
			if _, err := s.PreviewProjectRename("source", "target"); err == nil {
				t.Fatal("repeat accepted")
			}
			var raw string
			if err := s.db.QueryRow(`SELECT raw_project FROM capture_project_provenance`).Scan(&raw); err != nil || raw != "source" {
				t.Fatalf("provenance=%q err=%v", raw, err)
			}
		})
	}
}

func TestProjectRenameValidation(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateSession("s", "source", "/tmp"); err != nil {
		t.Fatal(err)
	}
	before := renameSnapshot(t, s)
	for _, names := range [][2]string{{"source", " SOURCE "}, {"source", "inbox"}, {"missing", "target"}, {"", "target"}, {"source", ""}, {"source", "a/b"}, {"source", "a\\b"}, {"source", "a\nb"}, {"\tsource", "target"}, {"source", "a\x00b"}} {
		if _, err := s.PreviewProjectRename(names[0], names[1]); err == nil {
			t.Fatalf("accepted %q", names)
		}
		if before != renameSnapshot(t, s) {
			t.Fatal("invalid preview changed DB")
		}
	}
}

func TestProjectRenameAuxiliaryOnlyAndPendingPayload(t *testing.T) {
	for _, fixture := range []string{
		`INSERT INTO project_aliases VALUES ('key','repo','source')`,
		`INSERT INTO prompt_tombstones(sync_id,session_id,project) VALUES ('dead','missing-session','source')`,
		`INSERT INTO sync_delete_tombstones(entity,entity_key,project) VALUES ('session','dead','source')`,
		`INSERT INTO sync_enrolled_projects(project) VALUES ('source')`,
		`INSERT INTO sync_mutations(target_key,entity,entity_key,op,payload,project) VALUES ('cloud','session','dead','delete','{"project":"source"}','other')`,
	} {
		t.Run(fixture, func(t *testing.T) {
			s := newTestStore(t)
			if _, err := s.db.Exec(fixture); err != nil {
				t.Fatal(err)
			}
			p, err := s.PreviewProjectRename("source", "target")
			if err != nil {
				t.Fatal(err)
			}
			if p.TargetExists {
				t.Fatal("unexpected target")
			}
			r, err := s.MigrateProject(p.Source, p.Target)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(p.Tables, r.Tables) {
				t.Fatalf("counts: %v vs %v", p.Tables, r.Tables)
			}
			if _, err := s.PreviewProjectRename("source", "target"); err == nil {
				t.Fatal("source remains")
			}
			var remaining int
			if err := s.db.QueryRow(`SELECT count(*) FROM sync_mutations WHERE acked_at IS NULL AND (project='source' OR json_extract(payload,'$.project')='source')`).Scan(&remaining); err != nil {
				t.Fatal(err)
			}
			if remaining != 0 {
				t.Fatal("pending mutation project or payload retained source")
			}
		})
	}
}

func TestProjectRenameEnrollmentAndHistory(t *testing.T) {
	for _, sourceEnrolled := range []bool{false, true} {
		for _, targetEnrolled := range []bool{false, true} {
			t.Run(fmt.Sprintf("source-%t-target-%t", sourceEnrolled, targetEnrolled), func(t *testing.T) {
				s := newTestStore(t)
				if err := s.CreateSession("s", "source", "/tmp"); err != nil {
					t.Fatal(err)
				}
				if sourceEnrolled {
					if err := s.EnrollProject("source"); err != nil {
						t.Fatal(err)
					}
				}
				if targetEnrolled {
					if err := s.EnrollProject("target"); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := s.db.Exec(`INSERT INTO prompt_source_confirmations(remote_target,sync_id,session_id,source_inbox_id,prompt_project,kind,asserted_owner_project,remote_attestation_id) VALUES ('remote','p','s','inbox','source','live','source',1);
     INSERT INTO sync_apply_deferred(sync_id,entity,payload,project) VALUES ('remote-p','prompt','{"project":"source"}','source');
     INSERT INTO cloud_upgrade_state(project,snapshot_json) VALUES ('source','{"project":"source"}');`); err != nil {
					t.Fatal(err)
				}
				readEvidence := func() string {
					t.Helper()
					var a, b, c, d, e string
					if err := s.db.QueryRow(`SELECT prompt_project,asserted_owner_project FROM prompt_source_confirmations`).Scan(&a, &b); err != nil {
						t.Fatal(err)
					}
					if err := s.db.QueryRow(`SELECT project,payload FROM sync_apply_deferred`).Scan(&c, &d); err != nil {
						t.Fatal(err)
					}
					if err := s.db.QueryRow(`SELECT project || snapshot_json FROM cloud_upgrade_state`).Scan(&e); err != nil {
						t.Fatal(err)
					}
					return a + b + c + d + e
				}
				evidence := readEvidence()
				preview, err := s.PreviewProjectRename("source", "target")
				if err != nil {
					t.Fatal(err)
				}
				if preview.SourceEnrolled != sourceEnrolled || preview.TargetEnrolled != targetEnrolled {
					t.Fatalf("flags: %+v", preview)
				}
				if _, err := s.MigrateProject("source", "target"); err != nil {
					t.Fatal(err)
				}
				if evidence != readEvidence() {
					t.Fatal("historical or remote evidence changed")
				}
				enrolled, err := s.IsProjectEnrolled("target")
				if err != nil {
					t.Fatal(err)
				}
				if enrolled != (sourceEnrolled || targetEnrolled) {
					t.Fatalf("enrolled=%t", enrolled)
				}
				var count int
				if err := s.db.QueryRow(`SELECT count(*) FROM sync_mutations WHERE acked_at IS NULL AND project='target' AND json_extract(payload,'$.project')='target'`).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if enrolled && count == 0 || !enrolled && count != 0 {
					t.Fatalf("mutations=%d enrolled=%t", count, enrolled)
				}
			})
		}
	}
}

func TestProjectRenameRollback(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateSession("s", "source", "/tmp"); err != nil {
		t.Fatal(err)
	}
	if err := s.EnrollProject("source"); err != nil {
		t.Fatal(err)
	}
	before := renameSnapshot(t, s)
	injected := errors.New("rename commit failed")
	s.hooks.commit = func(*sql.Tx) error { return injected }
	if _, err := s.MigrateProject("source", "target"); !errors.Is(err, injected) {
		t.Fatalf("err=%v", err)
	}
	s.hooks.commit = nil
	if before != renameSnapshot(t, s) {
		t.Fatal("rollback changed records, enrollment or journal")
	}
}

func TestProjectRenamePreservesProjectDeleteEvidence(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateSession("s", "source", "/tmp"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO sync_delete_tombstones(entity,entity_key,project,deleted_at) VALUES ('project','source','source','2026-01-02 00:00:00')`); err != nil {
		t.Fatal(err)
	}
	preview, err := s.PreviewProjectRename("source", "target")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Tables["sync_delete_tombstones"] != 0 {
		t.Fatal("project delete evidence must not move")
	}
	if _, err := s.MigrateProject("source", "target"); err != nil {
		t.Fatal(err)
	}
	if err := s.withTx(func(tx *sql.Tx) error {
		blocked, err := s.projectTombstoneSupersedesMutationTx(tx, SyncMutation{Entity: SyncEntityObservation, Project: "source", OccurredAt: "2026-01-01 00:00:00"})
		if err != nil {
			return err
		}
		if !blocked {
			t.Fatal("rename destroyed old-project delete evidence")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewProjectRename("source", "target"); err == nil {
		t.Fatal("historical evidence alone is not current ownership")
	}
}

func TestProjectRenameSyncGuard(t *testing.T) {
	for _, tc := range []struct {
		name        string
		until       time.Duration
		owner       string
		disposition string
		pending     bool
		blocked     bool
	}{
		{"active-pending", time.Minute, "autosync", "pending", true, true},
		{"expired-pending", -6 * time.Minute, "autosync", "pending", true, false},
		{"grace-pending", -2 * time.Minute, "autosync", "pending", true, true},
		{"active-no-pending", time.Minute, "autosync", "pending", false, false},
		{"active-quarantined", time.Minute, "autosync", "quarantined", true, false},
		{"ownerless-pending", time.Minute, "", "pending", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestStore(t)
			if err := s.CreateSession("s", "source", "/tmp"); err != nil {
				t.Fatal(err)
			}
			until := time.Now().Add(tc.until).UTC().Format(time.RFC3339)
			if _, err := s.db.Exec(`INSERT INTO sync_state(target_key,lease_owner,lease_until) VALUES ('guard',?,?)`, tc.owner, until); err != nil {
				t.Fatal(err)
			}
			if tc.pending {
				// Payload-only matching must have the same guard scope as migration.
				if _, err := s.db.Exec(`INSERT INTO sync_mutations(target_key,entity,entity_key,op,project,payload,disposition) VALUES ('guard','session','s','upsert','other','{"project":"source"}',?)`, tc.disposition); err != nil {
					t.Fatal(err)
				}
			}
			before := renameSnapshot(t, s)
			preview, err := s.PreviewProjectRename("source", "target")
			if err != nil {
				t.Fatal(err)
			}
			wantPending, wantQuarantined := int64(0), int64(0)
			if tc.pending {
				if tc.disposition == "pending" {
					wantPending = 1
				} else {
					wantQuarantined = 1
				}
			}
			if preview.PendingMutations != wantPending || preview.QuarantinedMutations != wantQuarantined {
				t.Fatalf("preview=%+v", preview)
			}
			var found bool
			for _, lease := range preview.SyncLeases {
				if lease.TargetKey == "guard" {
					found = true
					if lease.Owner != tc.owner || lease.Until != until || lease.Active != (tc.owner != "" && tc.until > -5*time.Minute) {
						t.Fatalf("lease=%+v", lease)
					}
				}
			}
			if !found {
				t.Fatal("missing lease")
			}
			if (preview.CheckSyncLease() != nil) != tc.blocked {
				t.Fatalf("precheck=%v", preview.CheckSyncLease())
			}
			if before != renameSnapshot(t, s) {
				t.Fatal("preview changed database")
			}
			_, err = s.RenameProject("source", "target")
			if tc.blocked {
				if err == nil {
					t.Fatal("rename accepted in-flight pending mutations")
				}
				for _, text := range []string{"1", "autosync", until, "engram cloud status", "autosync"} {
					if !strings.Contains(err.Error(), text) {
						t.Fatalf("error=%v missing %q", err, text)
					}
				}
				if before != renameSnapshot(t, s) {
					t.Fatal("refused rename changed tables or journal")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				var owner string
				if err := s.db.QueryRow(`SELECT project FROM sessions WHERE id='s'`).Scan(&owner); err != nil || owner != "target" {
					t.Fatalf("owner=%s err=%v", owner, err)
				}
			}
		})
	}
}

func TestProjectRenameRechecksLeaseAndConsolidateUnchanged(t *testing.T) {
	for _, consolidate := range []bool{false, true} {
		t.Run(fmt.Sprint(consolidate), func(t *testing.T) {
			s := newTestStore(t)
			if err := s.CreateSession("s", "source", "/tmp"); err != nil {
				t.Fatal(err)
			}
			if err := s.EnrollProject("source"); err != nil {
				t.Fatal(err)
			}
			preview, err := s.PreviewProjectRename("source", "target")
			if err != nil || preview.CheckSyncLease() != nil {
				t.Fatalf("preview=%+v err=%v", preview, err)
			}
			acquired, err := s.AcquireSyncLease("cloud", "late-autosync", time.Minute, time.Now())
			if err != nil || !acquired {
				t.Fatalf("lease=%t err=%v", acquired, err)
			}
			before := renameSnapshot(t, s)
			if consolidate {
				result, err := s.MigrateProject("source", "target")
				if err != nil || !result.Migrated {
					t.Fatalf("consolidate=%+v err=%v", result, err)
				}
			} else {
				if _, err := s.RenameProject("source", "target"); err == nil {
					t.Fatal("transaction trusted stale preview")
				}
				if before != renameSnapshot(t, s) {
					t.Fatal("transaction changed database")
				}
			}
		})
	}
}

func TestProjectRenameKeyedPromptPreview(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateSession("s", "source", "/tmp"); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"", "key"} {
		if _, err := s.AddPrompt(AddPromptParams{SessionID: "s", Project: "source", Content: "prompt", SourceInboxID: key}); err != nil {
			t.Fatal(err)
		}
	}
	p, err := s.PreviewProjectRename("source", "target")
	if err != nil || p.KeyedPrompts != 1 {
		t.Fatalf("preview=%+v err=%v", p, err)
	}
	if _, err := s.RenameProject("source", "target"); err != nil {
		t.Fatal(err)
	}
	var creation, owner string
	if err := s.db.QueryRow(`SELECT local_creation_project,project FROM user_prompts WHERE source_inbox_id='key'`).Scan(&creation, &owner); err != nil || creation != "source" || owner != "target" {
		t.Fatalf("creation=%s owner=%s err=%v", creation, owner, err)
	}
}
