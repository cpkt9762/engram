package autosync

import (
	"errors"
	"sort"
	"time"
)

// BlockedProject is display evidence from the last completed outbound attempt,
// not an authoritative query of the cloud's current allowlist.
type BlockedProject struct {
	Project    string    `json:"project"`
	Code       string    `json:"code"`
	LastSeenAt time.Time `json:"last_seen_at"`
}
type projectAllowlistFailure interface{ IsProjectNotAllowed(project string) bool }

// recordPushBlocks observes existing typed errors without changing the outcome,
// failure counters, scheduling, retry or backoff decisions of the sync cycle.
func (m *Manager) recordPushBlocks(err error) {
	seen := map[string]bool{}
	var visit func(error)
	visit = func(err error) {
		if err == nil {
			return
		}
		if failure, ok := err.(*projectTransportFailure); ok {
			var policy projectAllowlistFailure
			if errors.As(failure.err, &policy) && policy.IsProjectNotAllowed(failure.project) {
				seen[failure.project] = true
			}
			return
		}
		if joined, ok := err.(interface{ Unwrap() []error }); ok {
			for _, child := range joined.Unwrap() {
				visit(child)
			}
			return
		}
		visit(errors.Unwrap(err))
	}
	visit(err)
	now := time.Now().UTC()
	projects := make([]BlockedProject, 0, len(seen))
	for project := range seen {
		projects = append(projects, BlockedProject{Project: project, Code: "project_not_allowed", LastSeenAt: now})
	}
	sort.Slice(projects, func(i, j int) bool { return projects[i].Project < projects[j].Project })
	m.mu.Lock()
	m.status.BlockedProjects = projects
	m.mu.Unlock()
}

// ClearBlockedProject removes display evidence after local unenrollment only.
// The existing failure state and backoff remain intact.
func (m *Manager) ClearBlockedProject(project string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	projects := make([]BlockedProject, 0, len(m.status.BlockedProjects))
	for _, entry := range m.status.BlockedProjects {
		if entry.Project != project {
			projects = append(projects, entry)
		}
	}
	m.status.BlockedProjects = projects
}
