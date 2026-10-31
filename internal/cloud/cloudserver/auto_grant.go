package cloudserver

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/Gentleman-Programming/engram/v3/internal/cloud"
	"github.com/Gentleman-Programming/engram/v3/internal/cloud/cloudstore"
	"github.com/Gentleman-Programming/engram/v3/internal/cloud/constants"
)

// ErrProjectNotGranted distinguishes missing permission from unavailable storage.
var ErrProjectNotGranted = errors.New("project is not granted")

// AutoGrantStore atomically checks the limit, creates grants and records audits.
// The principal is always taken from the authenticated request, never its body.
type AutoGrantStore interface {
	AutoCreateProjectGrants(ctx context.Context, principalID, actorSource string, projects []string, max int) error
}

func WithAutoGrant(enabled bool, max int) Option {
	return func(s *CloudServer) {
		s.autoGrant = enabled
		s.autoGrantMax = max
		if max == 0 {
			s.autoGrantMax = cloud.DefaultAutoGrantMax
		}
	}
}

func WithAutoGrantStore(store AutoGrantStore) Option {
	return func(s *CloudServer) { s.autoGrantStore = store }
}

// authorizeProjectScopes preflights every project before committing any grants.
// This keeps prompt-pair owner and destination authorization all-or-nothing.
func (s *CloudServer) authorizeProjectScopes(ctx context.Context, w http.ResponseWriter, projects ...string) bool {
	if s.principalProject != nil {
		principal, ok := PrincipalFromContext(ctx)
		if !ok {
			// Preserve the established missing-principal response of the single scope path.
			project := ""
			if len(projects) > 0 {
				project = projects[0]
			}
			s.recordProjectPolicyDeniedAudit(ctx, project)
			writeActionableError(w, http.StatusForbidden, constants.UpgradeErrorClassPolicy, constants.ReasonPolicyForbidden, "forbidden: principal is required")
			return false
		}
		if usesManagedProjectGrants(principal) {
			missing := make([]string, 0, len(projects))
			for _, project := range projects {
				err := s.principalProject.AuthorizeProjectForPrincipal(ctx, principal, project)
				if err == nil {
					continue
				}
				if !errors.Is(err, ErrProjectNotGranted) {
					return s.denyAutoGrant(ctx, w, project, "authorizer_error")
				}
				if !s.autoGrant {
					return s.denyAutoGrant(ctx, w, project, "disabled")
				}
				if _, err := cloudstore.NormalizeAutoGrantProject(project); err != nil {
					return s.denyAutoGrant(ctx, w, project, "invalid_project")
				}
				missing = append(missing, project)
			}
			if len(missing) == 0 {
				return true
			}
			if s.autoGrantStore == nil || s.autoGrantMax <= 0 {
				return s.denyAutoGrant(ctx, w, missing[0], "unavailable")
			}
			if err := s.autoGrantStore.AutoCreateProjectGrants(ctx, principal.ID, string(principal.Source), missing, s.autoGrantMax); err != nil {
				reason := "storage_error"
				if errors.Is(err, cloudstore.ErrAutoGrantLimit) {
					reason = "limit_reached"
				}
				if errors.Is(err, cloudstore.ErrAuthAuditInsertFailed) {
					reason = "audit_failed"
				}
				if errors.Is(err, cloudstore.ErrPrincipalDisabled) {
					reason = "principal_disabled"
				}
				return s.denyAutoGrant(ctx, w, missing[0], reason)
			}
			return true
		}
	}
	for _, project := range projects {
		if s.projectAuth != nil {
			if err := s.projectAuth.AuthorizeProject(project); err != nil {
				s.writeProjectPolicyDenied(ctx, w, project)
				return false
			}
		}
	}
	return true
}

func (s *CloudServer) denyAutoGrant(ctx context.Context, w http.ResponseWriter, project, reason string) bool {
	if s.autoGrant {
		principal, _ := PrincipalFromContext(ctx)
		key := autoGrantDecisionKey{reason: reason, principal: principal.ID, project: project}
		if s.autoGrantLogs.allow(key, time.Now()) {
			// Never log underlying storage errors, bearer credentials or request payloads.
			log.Printf("cloudserver: automatic grant decision reason=%s", reason)
		}
	}
	s.writeProjectPolicyDenied(ctx, w, project)
	return false
}

const (
	autoGrantLogInterval   = 60 * time.Second
	autoGrantLogMaxEntries = 1024
)

type autoGrantDecisionKey struct {
	reason, principal, project string
}

// autoGrantDecisionLogs bounds only diagnostic logs, never denial audits.
type autoGrantDecisionLogs struct {
	mu   sync.Mutex
	last map[autoGrantDecisionKey]time.Time
}

func (l *autoGrantDecisionLogs) allow(key autoGrantDecisionKey, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	last, exists := l.last[key]
	if exists && now.Sub(last) < autoGrantLogInterval {
		return false
	}
	if l.last == nil || (!exists && len(l.last) >= autoGrantLogMaxEntries) {
		l.last = make(map[autoGrantDecisionKey]time.Time)
	}
	l.last[key] = now
	return true
}
