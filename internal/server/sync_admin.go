package server

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"

	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

// SetSyncAdminConfig injects configuration ownership from cmd without giving
// HTTP handlers access to credentials or cloud transport.
func (s *Server) SetSyncAdminConfig(fn func() (configured, autosync bool, err error)) {
	s.syncAdminConfig = fn
}

func requireLocalAdmin(h http.HandlerFunc) http.HandlerFunc {
	return requireAuth(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if parsed, _, err := net.SplitHostPort(host); err == nil {
			host = parsed
		}
		host = strings.Trim(host, "[]")
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			adminError(w, 403, "loopback_required")
			return
		}
		if _, present := r.Header["Origin"]; present {
			adminError(w, 403, "origin_forbidden")
			return
		}
		if r.Method == http.MethodPost {
			kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || kind != "application/json" {
				adminError(w, 415, "json_required")
				return
			}
		}
		h(w, r)
	})
}
func adminError(w http.ResponseWriter, status int, code string) {
	jsonErrorWithFields(w, status, code, map[string]any{"code": code})
}
func (s *Server) checkAdminInstance(w http.ResponseWriter, instance string, required bool) bool {
	if (required || instance != "") && instance != s.instanceID {
		adminError(w, 409, "instance_mismatch")
		return false
	}
	return true
}
func (s *Server) adminConfiguration() (bool, bool, error) {
	if s.syncAdminConfig == nil {
		return false, false, nil
	}
	return s.syncAdminConfig()
}

func (s *Server) handleEnrollmentStatus(w http.ResponseWriter, r *http.Request) {
	project, err := store.ValidateExpectedProject(r.URL.Query().Get("project"))
	if err != nil {
		adminError(w, 400, "project_required")
		return
	}
	enrolled, err := s.store.IsProjectEnrolled(project)
	if err != nil {
		adminError(w, 500, "enrollment_unavailable")
		return
	}
	configured, autosync, err := s.adminConfiguration()
	if err != nil {
		adminError(w, 503, "cloud_config_error")
		return
	}
	jsonResponse(w, 200, map[string]any{"project": project, "enrolled": enrolled, "cloud_configured": configured, "autosync_enabled": autosync, "instance_id": s.instanceID})
}
func (s *Server) handleSecretScan(w http.ResponseWriter, r *http.Request) {
	project, err := store.ValidateExpectedProject(r.URL.Query().Get("project"))
	if err != nil {
		adminError(w, 400, "project_required")
		return
	}
	scan, err := s.store.ScanPromptSecrets(project, r.URL.Query().Get("cursor"))
	if err != nil {
		if errors.Is(err, store.ErrScanStale) {
			adminError(w, 409, "scan_stale")
		} else if errors.Is(err, store.ErrInvalidScanCursor) {
			adminError(w, 400, "scan_failed")
		} else {
			adminError(w, 500, "scan_unavailable")
		}
		return
	}
	jsonResponse(w, 200, scan)
}
func (s *Server) handleEnrollment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Project    string `json:"project"`
		InstanceID string `json:"instance_id"`
		ScanToken  string `json:"scan_token"`
		Force      bool   `json:"force"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		adminError(w, 400, "invalid_json")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		adminError(w, 400, "invalid_json")
		return
	}
	if !s.checkAdminInstance(w, body.InstanceID, true) {
		return
	}
	if _, err := store.ValidateExpectedProject(body.Project); err != nil {
		adminError(w, 400, "project_required")
		return
	}
	if err := s.store.EnrollProjectAfterScan(body.Project, body.ScanToken, body.Force); err != nil {
		if errors.Is(err, store.ErrScanStale) {
			adminError(w, 409, "scan_stale")
		} else if errors.Is(err, store.ErrEnrollmentProjectReserved) {
			adminError(w, 400, "enrollment_failed")
		} else {
			adminError(w, 500, "enrollment_unavailable")
		}
		return
	}
	// Enrollment queues historical data; autosync owns when transmission happens.
	s.handleEnrollmentStatus(w, rWithProject(r, body.Project))
}

// Unenrollment controls future outbound eligibility; it does not cancel an
// in-flight transfer, delete cloud content, or disable the inbound rail.
func (s *Server) handleUnenrollment(w http.ResponseWriter, r *http.Request) {
	project, err := store.ValidateExpectedProject(r.URL.Query().Get("project"))
	if err != nil {
		adminError(w, 400, "project_required")
		return
	}
	if !s.checkAdminInstance(w, r.URL.Query().Get("instance_id"), true) {
		return
	}
	if err := s.store.UnenrollProject(project); err != nil {
		adminError(w, 500, "enrollment_unavailable")
		return
	}
	if clearer, ok := s.syncStatus.(interface{ ClearBlockedProject(string) }); ok {
		clearer.ClearBlockedProject(project)
	}
	s.handleEnrollmentStatus(w, rWithProject(r, project))
}

func rWithProject(r *http.Request, project string) *http.Request {
	copy := r.Clone(r.Context())
	urlCopy := *r.URL
	q := urlCopy.Query()
	q.Set("project", project)
	urlCopy.RawQuery = q.Encode()
	copy.URL = &urlCopy
	return copy
}
func maskPrompts(prompts []store.Prompt) {
	for i := range prompts {
		prompts[i].Content, _ = store.MaskPromptSecrets(prompts[i].Content)
	}
}

func enrolledBlockedProjects(blocked []BlockedProject, enrolled []store.EnrolledProject) []BlockedProject {
	active := make(map[string]bool, len(enrolled))
	for _, project := range enrolled {
		active[project.Project] = true
	}
	result := []BlockedProject{}
	for _, entry := range blocked {
		if active[entry.Project] {
			result = append(result, entry)
		}
	}
	return result
}
