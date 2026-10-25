package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// ProjectRenamePreview describes current ownership only. Historical identities
// (including acknowledged mutations) are not evidence of a live source project.
// Counts describe rows moved, before any new sync backfill rows are appended.
type ProjectRenamePreview struct {
	Source               string               `json:"source"`
	Target               string               `json:"target"`
	TargetExists         bool                 `json:"target_exists"`
	SourceEnrolled       bool                 `json:"source_enrolled"`
	TargetEnrolled       bool                 `json:"target_enrolled"`
	Tables               map[string]int64     `json:"tables"`
	PendingMutations     int64                `json:"pending_mutations"`
	QuarantinedMutations int64                `json:"quarantined_mutations"`
	KeyedPrompts         int64                `json:"keyed_prompts"`
	SyncLeases           []ProjectRenameLease `json:"sync_leases"`
}

// A push can outlive the usual 60-second lease TTL. A crashed owner's
// expired lease therefore blocks rename for at most five additional minutes.
const projectRenameLeaseGrace = 5 * time.Minute

const projectRenameMutationPredicate = `acked_at IS NULL AND (project = @source OR (json_valid(payload) AND json_extract(payload, '$.project') = @source))`

// ProjectRenameLease reports each target, including inactive or ownerless leases.
type ProjectRenameLease struct {
	TargetKey string `json:"target_key"`
	Owner     string `json:"owner"`
	Until     string `json:"until"`
	Active    bool   `json:"active"`
}

// CheckSyncLease is shared by the CLI's pre-backup check and the authoritative
// write-transaction check. Quarantined rows cannot be in flight.
func (p *ProjectRenamePreview) CheckSyncLease() error {
	if p.PendingMutations == 0 {
		return nil
	}
	for _, lease := range p.SyncLeases {
		if lease.Active {
			return fmt.Errorf("cannot rename project %q: %d unacknowledged pending sync mutations with active lease owner=%q lease_until=%q (target=%q); wait until engram cloud status shows pending cleared, or stop autosync before retrying", p.Source, p.PendingMutations, lease.Owner, lease.Until, lease.TargetKey)
		}
	}
	return nil
}

// projectRenamePreflight observes the same source scope as migration. Call it
// inside the apply transaction as well as the read-only preview transaction.
func projectRenamePreflight(q projectRenameQuerier, source string) (*ProjectRenamePreview, error) {
	p := &ProjectRenamePreview{Source: source, SyncLeases: []ProjectRenameLease{}}
	if err := q.QueryRow(`SELECT count(*) FILTER (WHERE disposition='pending'), count(*) FILTER (WHERE disposition='quarantined') FROM sync_mutations WHERE `+projectRenameMutationPredicate, sql.Named("source", source)).Scan(&p.PendingMutations, &p.QuarantinedMutations); err != nil {
		return nil, fmt.Errorf("preflight rename mutations: %w", err)
	}
	if err := q.QueryRow(`SELECT count(*) FROM user_prompts WHERE project=? AND source_inbox_id IS NOT NULL AND source_inbox_id != ''`, source).Scan(&p.KeyedPrompts); err != nil {
		return nil, fmt.Errorf("preflight rename keyed prompts: %w", err)
	}
	rows, err := q.Query(`SELECT target_key,coalesce(lease_owner,''),coalesce(lease_until,''),coalesce(lease_owner != '' AND julianday(lease_until) > julianday(?),0) FROM sync_state ORDER BY target_key`, time.Now().UTC().Add(-projectRenameLeaseGrace).Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("preflight rename leases: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var lease ProjectRenameLease
		if err := rows.Scan(&lease.TargetKey, &lease.Owner, &lease.Until, &lease.Active); err != nil {
			return nil, fmt.Errorf("scan rename lease: %w", err)
		}
		p.SyncLeases = append(p.SyncLeases, lease)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read rename leases: %w", err)
	}
	return p, nil
}

// RenameProject is the guarded projects-rename entry point. MigrateProject keeps
// its existing semantics for interactive consolidation.
func (s *Store) RenameProject(from, to string) (*MigrateResult, error) {
	from, to, err := normalizeProjectRename(from, to)
	if err != nil {
		return nil, err
	}
	return s.migrateProject(from, to, true)
}

// The predicates below define both preview counts and apply eligibility. SQL
// identifiers are constants, never project names supplied by a caller.
type projectRenameScope struct {
	table       string
	predicate   string
	assignments string
}

func projectRenameScopes() []projectRenameScope {
	scopes := make([]projectRenameScope, 0, 8)
	for _, table := range []string{"observations", "sessions", "user_prompts", "prompt_tombstones", "sync_delete_tombstones", "project_aliases"} {
		predicate := "project = @source"
		if table == "sync_delete_tombstones" {
			// A whole-project delete is evidence about the old identity, not a
			// transportable entity delete. Moving it would invalidate its key/project
			// pair and could resurrect stale history (or delete the merge target).
			predicate += " AND entity != 'project'"
		}
		scopes = append(scopes, projectRenameScope{table, predicate, "project = @target"})
	}
	scopes = append(scopes,
		projectRenameScope{"sync_mutations", projectRenameMutationPredicate,
			`project = @target, payload = CASE WHEN json_valid(payload) AND json_extract(payload, '$.project') = @source THEN json_set(payload, '$.project', @target) ELSE payload END`},
		projectRenameScope{"sync_enrolled_projects", "project = @source", ""},
	)
	return scopes
}

func normalizeProjectRename(from, to string) (string, string, error) {
	// Inspect raw inputs as well: normalization trims edge controls, but they are
	// invalid CLI names rather than an alternative spelling of a valid name.
	for _, name := range []string{from, to} {
		if strings.ContainsAny(name, "/\\") || strings.ContainsFunc(name, unicode.IsControl) {
			return "", "", fmt.Errorf("project names must not contain path separators or control characters")
		}
	}
	from, _ = NormalizeProject(from)
	to, _ = NormalizeProject(to)
	switch {
	case from == "" || to == "":
		return "", "", fmt.Errorf("source and target project names are required")
	case from == to:
		return "", "", fmt.Errorf("source and target normalize to the same project")
	case to == ReservedInboxProjectName:
		return "", "", fmt.Errorf("target cannot be reserved project %q", to)
	}
	return from, to, nil
}

type projectRenameQuerier interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}

func projectRenameCounts(q projectRenameQuerier, source string) (map[string]int64, error) {
	counts := make(map[string]int64)
	for _, scope := range projectRenameScopes() {
		var count int64
		if err := q.QueryRow("SELECT count(*) FROM "+scope.table+" WHERE "+scope.predicate, sql.Named("source", source)).Scan(&count); err != nil {
			return nil, fmt.Errorf("count rename %s: %w", scope.table, err)
		}
		counts[scope.table] = count
	}
	return counts, nil
}

func projectRenameExists(counts map[string]int64) bool {
	for _, count := range counts {
		if count > 0 {
			return true
		}
	}
	return false
}

// PreviewProjectRename uses a read-only transaction to observe a consistent
// point-in-time scope. It neither migrates nor queues any records.
func (s *Store) PreviewProjectRename(from, to string) (*ProjectRenamePreview, error) {
	from, to, err := normalizeProjectRename(from, to)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	source, err := projectRenameCounts(tx, from)
	if err != nil {
		return nil, err
	}
	if !projectRenameExists(source) {
		return nil, fmt.Errorf("source project %q does not exist", from)
	}
	target, err := projectRenameCounts(tx, to)
	if err != nil {
		return nil, err
	}
	preview, err := projectRenamePreflight(tx, from)
	if err != nil {
		return nil, err
	}
	preview.Target = to
	preview.TargetExists = projectRenameExists(target)
	preview.SourceEnrolled = source["sync_enrolled_projects"] > 0
	preview.TargetEnrolled = target["sync_enrolled_projects"] > 0
	preview.Tables = source
	return preview, nil
}

func (s *Store) applyProjectRenameTx(tx *sql.Tx, from, to string) (map[string]int64, error) {
	scopes := projectRenameScopes()
	counts, err := s.applyProjectRenameScopesTx(tx, from, to, scopes[:len(scopes)-2])
	if err != nil {
		return nil, err
	}
	// The existing sync-identity entry point shares the same scopes for one
	// exact source; multi-source consolidation retains its existing behavior.
	syncCounts, err := projectRenameCounts(tx, from)
	if err != nil {
		return nil, err
	}
	if err := s.migrateProjectSyncIdentityTx(tx, []string{from}, to); err != nil {
		return nil, err
	}
	for _, scope := range scopes[len(scopes)-2:] {
		counts[scope.table] = syncCounts[scope.table]
	}
	return counts, nil
}

func (s *Store) applyProjectRenameScopesTx(tx *sql.Tx, from, to string, scopes []projectRenameScope) (map[string]int64, error) {
	counts := make(map[string]int64)
	for _, scope := range scopes {
		if scope.table == "sync_enrolled_projects" {
			if _, err := s.execHook(tx, `INSERT OR IGNORE INTO sync_enrolled_projects(project) SELECT @target WHERE EXISTS (SELECT 1 FROM sync_enrolled_projects WHERE `+scope.predicate+`)`, sql.Named("target", to), sql.Named("source", from)); err != nil {
				return nil, fmt.Errorf("carry rename enrollment: %w", err)
			}
		}
		query := "UPDATE " + scope.table + " SET " + scope.assignments + " WHERE " + scope.predicate
		args := []any{sql.Named("target", to), sql.Named("source", from)}
		if scope.table == "sync_enrolled_projects" {
			query = "DELETE FROM " + scope.table + " WHERE " + scope.predicate
			args = []any{sql.Named("source", from)}
		}
		res, err := s.execHook(tx, query, args...)
		if err != nil {
			return nil, fmt.Errorf("rename %s: %w", scope.table, err)
		}
		count, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		counts[scope.table] = count
	}
	return counts, nil
}
