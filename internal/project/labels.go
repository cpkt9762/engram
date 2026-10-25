package project

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// LabelKey compares directory designations without changing storage names.
func LabelKey(name string) string {
	var key strings.Builder
	separator := false
	for _, r := range CanonicalizeProjectName(name) {
		if r == '-' || r == '_' || r == '.' || unicode.IsSpace(r) {
			if !separator {
				key.WriteByte('-')
			}
			separator = true
		} else {
			key.WriteRune(r)
			separator = false
		}
	}
	return key.String()
}

// ProjectLabels describes read-only evidence for a directory's project identity.
type ProjectLabels struct {
	Canonical string
	Source    string
	Labels    []string
}

// Matches accepts only designations present in the directory's label set.
func (labels ProjectLabels) Matches(designation string) bool {
	key := LabelKey(designation)
	if key == "" {
		return false
	}
	for _, label := range labels.Labels {
		if LabelKey(label) == key {
			return true
		}
	}
	return false
}

// DirectoryLabels inspects local identity without publishing a binding or consulting history.
// Invalid config, HOME safeguards and inaccessible directories provide no alias authority.
func DirectoryLabels(ctx context.Context, dir string) (ProjectLabels, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return ProjectLabels{}, false
	}
	res := DetectProjectFullWithOptions(dir, DetectionOptions{Context: ctx, InspectOnly: true, RequireExplicitHomeProject: true})
	if res.Error != nil || res.Project == "" {
		return ProjectLabels{}, false
	}
	if res.Source == SourceDirBasename && validateBasenameInspection(ctx, dir) != nil {
		return ProjectLabels{}, false
	}
	labels := ProjectLabels{Canonical: res.Project, Source: res.Source}
	seen := make(map[string]bool)
	add := func(name string) {
		name = CanonicalizeProjectName(name)
		key := LabelKey(name)
		if key != "" && !seen[key] {
			labels.Labels = append(labels.Labels, name)
			seen[key] = true
		}
	}
	add(res.Project)
	if common := detectGitCommonDirContext(ctx, dir); common != "" {
		if binding, err := readRepositoryBinding(common); err == nil {
			add(binding.Project)
		}
		if origin := detectFromGitRemoteContext(ctx, dir); origin != "" {
			add(normalize(origin))
		}
		if root := detectGitRootDirContext(ctx, dir); root != "" {
			add(filepath.Base(root))
		}
		if checkout := detectGitWorktreeDirContext(ctx, dir); checkout != "" {
			add(filepath.Base(checkout))
		}
	} else {
		add(fallbackProjectName(dir))
	}
	if ctx.Err() != nil {
		return ProjectLabels{}, false
	}
	return labels, true
}
