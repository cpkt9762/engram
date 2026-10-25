package setup

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

//go:embed plugins/dsh
var dshFS embed.FS

const dshPackage = "@cpkt9762/engram-dsh"
const dshManifest = ".engram-managed-files.json"

var dshProfileName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func dshInstallDir() string {
	home, _ := userHomeDir()
	return filepath.Join(home, ".engram", "integrations", "dsh")
}

func installDSH() (*Result, error) {
	home, err := userHome()
	if err != nil {
		return nil, err
	}
	dir, err := filepath.Abs(filepath.Join(home, ".engram", "integrations", "dsh"))
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(dir, " \t\r\n") {
		return nil, fmt.Errorf("DSH plugin path must not contain spaces: %s", dir)
	}
	profile := os.Getenv("ENGRAM_DSH_PROFILE")
	if profile == "" {
		profile = "acp"
	}
	// Dot-only names pass the character allowlist but escape the profiles directory.
	if !dshProfileName.MatchString(profile) || profile == "." || profile == ".." {
		return nil, fmt.Errorf("invalid DSH profile %q: use letters, digits, dots, underscores or hyphens", profile)
	}
	root := os.Getenv("DSH_HOME")
	if root == "" {
		root = filepath.Join(home, ".dsh")
	}
	profileDir, err := filepath.Abs(filepath.Join(root, "profiles", profile))
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(profileDir)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("DSH profile %q is unavailable; initialize it first with: dsh --profile %s", profile, profile)
	}
	linked, err := checkDSHProfile(profileDir, dir)
	if err != nil {
		return nil, err
	}
	exe, err := osExecutable()
	if err != nil {
		return nil, fmt.Errorf("resolve engram executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return nil, fmt.Errorf("resolve engram executable symlinks: %w", err)
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return nil, err
	}
	files, err := writeDSHFiles(dir, exe)
	if err != nil {
		return nil, err
	}
	if !linked {
		if _, err := lookPathFn("dsh"); err != nil {
			return nil, fmt.Errorf("dsh CLI not found in PATH: %w; files were written; install manually: dsh plugin --profile %s add %s", err, profile, dir)
		}
		out, err := runCommand("dsh", "plugin", "--profile", profile, "add", dir)
		if err != nil && !strings.Contains(strings.ToLower(string(out)), "already") {
			return nil, fmt.Errorf("dsh plugin add failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
		}
	}
	return &Result{Agent: "dsh", Destination: dir, Files: files}, nil
}

// checkDSHProfile is deliberately read-only: conflicting memory integrations
// must be removed by the user before any installed files are changed.
func checkDSHProfile(profile, dir string) (bool, error) {
	data, err := os.ReadFile(filepath.Join(profile, "package.json"))
	if err != nil {
		return false, fmt.Errorf("read DSH package.json: %w", err)
	}
	var pkg struct {
		Dependencies         map[string]string `json:"dependencies"`
		DevDependencies      map[string]string `json:"devDependencies"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
		PeerDependencies     map[string]string `json:"peerDependencies"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return false, fmt.Errorf("parse DSH package.json: %w", err)
	}
	for _, deps := range []map[string]string{pkg.Dependencies, pkg.DevDependencies, pkg.OptionalDependencies, pkg.PeerDependencies} {
		if _, ok := deps["@ian_p/dsh-gentle-engram"]; ok {
			return false, fmt.Errorf("remove @ian_p/dsh-gentle-engram from DSH profile %s before installing %s", profile, dshPackage)
		}
	}
	data, err = os.ReadFile(filepath.Join(profile, "cordis.patch.yml"))
	if err != nil {
		return false, fmt.Errorf("read DSH cordis.patch.yml: %w", err)
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var patch any
		if err := decoder.Decode(&patch); err == io.EOF {
			break
		} else if err != nil {
			return false, fmt.Errorf("parse DSH cordis.patch.yml: %w", err)
		}
		if dshHasEngramMCP(patch) {
			return false, fmt.Errorf("remove the serverName: engram MCP entry from %s before installing %s", filepath.Join(profile, "cordis.patch.yml"), dshPackage)
		}
	}
	link := pkg.Dependencies[dshPackage]
	if !strings.HasPrefix(link, "link:") {
		return false, nil
	}
	target := strings.TrimPrefix(link, "link:")
	if !filepath.IsAbs(target) {
		target = filepath.Join(profile, filepath.FromSlash(target))
	}
	return filepath.Clean(target) == dir, nil
}

func dshHasEngramMCP(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		if v["serverName"] == "engram" {
			return true
		}
		for _, child := range v {
			if dshHasEngramMCP(child) {
				return true
			}
		}
	case map[any]any:
		if v["serverName"] == "engram" {
			return true
		}
		for _, child := range v {
			if dshHasEngramMCP(child) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if dshHasEngramMCP(child) {
				return true
			}
		}
	}
	return false
}

func writeDSHFiles(dir, exe string) (files int, resultErr error) {
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return 0, err
	}
	stage, err := os.MkdirTemp(parent, ".dsh-stage-")
	if err != nil {
		return 0, err
	}
	defer func() {
		if err := os.RemoveAll(stage); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("clean DSH staging directory %s: %w", stage, err))
		}
	}()
	if err := os.Chmod(stage, 0755); err != nil {
		return 0, err
	}
	if err := preserveDSHFiles(dir, stage); err != nil {
		return 0, err
	}
	var managed []string
	err = fs.WalkDir(dshFS, "plugins/dsh", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, "plugins/dsh/")
		if entry.IsDir() {
			return nil
		}
		data, err := dshFS.ReadFile(path)
		if err != nil {
			return err
		}
		if rel == "lib/config.ts" {
			const marker = `const ENGRAM_BIN = optionalEnvironmentValue(process.env.ENGRAM_BIN) ?? "engram"`
			if !bytes.Contains(data, []byte(marker)) {
				return fmt.Errorf("embedded DSH config is missing the ENGRAM_BIN declaration")
			}
			data = patchEngramBINLine(data, exe)
		}
		dest := filepath.Join(stage, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, data, 0644); err != nil {
			return err
		}
		managed = append(managed, rel)
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("stage DSH plugin: %w", err)
	}
	manifest, err := json.Marshal(managed)
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(stage, dshManifest), manifest, 0644); err != nil {
		return 0, err
	}
	// Apply exact runtime modes even when the caller has a restrictive umask.
	if err := filepath.WalkDir(stage, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		mode := os.FileMode(0644)
		if entry.IsDir() {
			mode = 0755
		}
		return os.Chmod(path, mode)
	}); err != nil {
		return 0, err
	}
	if err := replaceDSHDirectory(stage, dir); err != nil {
		return 0, err
	}
	return len(managed), nil
}

// Preserve user files; only paths recorded by a previous installation are removed.
// Symlinks are rejected rather than followed while staging an existing directory.
func preserveDSHFiles(dir, stage string) error {
	info, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("DSH destination is not a directory: %s", dir)
	}
	managed := map[string]bool{dshManifest: true}
	manifestPath := filepath.Join(dir, dshManifest)
	if info, err := os.Lstat(manifestPath); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("DSH managed manifest must be a regular file: %s", manifestPath)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		var paths []string
		if err := json.Unmarshal(data, &paths); err != nil {
			return fmt.Errorf("parse DSH managed files: %w", err)
		}
		for _, path := range paths {
			if !fs.ValidPath(path) || strings.Contains(path, `\`) {
				return fmt.Errorf("invalid DSH managed path %q", path)
			}
			managed[path] = true
		}
	}
	return filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlink in DSH destination: %s", path)
		}
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(stage, rel), 0755)
		}
		if managed[filepath.ToSlash(rel)] {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("unsupported DSH destination file: %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(stage, rel), data, 0644)
	})
}

// Swap existing directories in one filesystem operation: readers see either
// complete version, and a failed swap leaves the previous installation intact.
func replaceDSHDirectory(stage, dir string) error {
	if _, err := os.Lstat(dir); os.IsNotExist(err) {
		return os.Rename(stage, dir)
	} else if err != nil {
		return err
	}
	if err := exchangeDSHDirectories(stage, dir); err != nil {
		return fmt.Errorf("atomically replace DSH directory: %w", err)
	}
	// The old tree now occupies stage; the caller removes it on return.
	return nil
}
