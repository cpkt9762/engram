package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

var ErrAutoGrantLimit = errors.New("cloudstore: automatic project grant limit reached")

// NormalizeAutoGrantProject shares grant key normalization and the reserved
// inbox name used by local enrollment. Wildcards never become automatic grants.
func NormalizeAutoGrantProject(project string) (string, error) {
	normalized := NormalizeProjectGrant(project)
	if normalized == "" || normalized == store.ReservedInboxProjectName || strings.TrimSpace(project) == "*" {
		return "", fmt.Errorf("cloudstore: invalid automatic project grant")
	}
	return normalized, nil
}

// AutoCreateProjectGrants serializes automatic grants for an identity across
// processes. Audit and grant writes commit together; any error rolls both back.
// Existing grants consume capacity but never generate duplicate audit events.
func (cs *CloudStore) AutoCreateProjectGrants(ctx context.Context, principalID, actorSource string, projects []string, max int) error {
	if cs == nil || cs.db == nil {
		return fmt.Errorf("cloudstore: not initialized")
	}
	id, err := parseCloudPrincipalID(principalID)
	if err != nil {
		return err
	}
	if max <= 0 {
		return ErrAutoGrantLimit
	}
	normalized := make([]string, 0, len(projects))
	for _, project := range projects {
		name, err := NormalizeAutoGrantProject(project)
		if err != nil {
			return err
		}
		normalized = append(normalized, name)
	}
	tx, err := cs.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("cloudstore: begin auto grant: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var enabled bool
	if err := tx.QueryRowContext(ctx, `SELECT enabled FROM cloud_principals WHERE id = $1 FOR UPDATE`, id).Scan(&enabled); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrPrincipalNotFound
		}
		return fmt.Errorf("cloudstore: lock auto grant principal: %w", err)
	}
	if !enabled {
		return ErrPrincipalDisabled
	}
	existing, err := autoGrantProjects(ctx, tx, id)
	if err != nil {
		return err
	}
	missing := []string{}
	for _, project := range normalized {
		if !existing[project] {
			missing = append(missing, project)
			existing[project] = true
		}
	}
	// At the limit, replaying a grant still succeeds. A two-project request
	// must fit in its entirety before any audit or grant is inserted.
	if len(missing) > 0 && len(existing) > max {
		return ErrAutoGrantLimit
	}
	for _, project := range missing {
		if err := insertAuthAuditEvent(ctx, tx, AuthAuditEvent{
			ActorPrincipalID: principalID, ActorSource: actorSource, TargetPrincipalID: principalID,
			Project: project, Action: "grant.auto_create", Outcome: "success", Metadata: map[string]any{"auto": true},
		}); err != nil {
			return fmt.Errorf("%w: %w", ErrAuthAuditInsertFailed, err)
		}
		if _, err := createProjectGrant(ctx, tx, CreateProjectGrantParams{PrincipalID: principalID, Project: project, GrantedByPrincipalID: principalID}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("cloudstore: commit auto grant: %w", err)
	}
	return nil
}

func autoGrantProjects(ctx context.Context, tx *sql.Tx, principalID int64) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT project FROM cloud_project_grants WHERE principal_id = $1`, principalID)
	if err != nil {
		return nil, fmt.Errorf("cloudstore: read auto grant projects: %w", err)
	}
	defer func() { _ = rows.Close() }()
	projects := map[string]bool{}
	for rows.Next() {
		var project string
		if err := rows.Scan(&project); err != nil {
			return nil, err
		}
		projects[project] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return projects, nil
}
