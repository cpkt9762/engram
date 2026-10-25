package setup

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func dshFixture(t *testing.T) (string, string) {
	t.Helper()
	resetSetupSeams(t)
	home := useIsolatedProfile(t)
	t.Setenv("ENGRAM_DSH_PROFILE", "")
	root := t.TempDir()
	t.Setenv("DSH_HOME", root)
	profile := filepath.Join(root, "profiles", "acp")
	dshWrite(t, filepath.Join(profile, "package.json"), `{ "dependencies": {} }`)
	dshWrite(t, filepath.Join(profile, "cordis.patch.yml"), "[]\n")
	lookPathFn = func(name string) (string, error) {
		if name != "dsh" {
			t.Fatalf("lookup %s", name)
		}
		return "fake-dsh", nil
	}
	runCommand = func(string, ...string) ([]byte, error) { t.Fatal("unexpected host command"); return nil, nil }
	return filepath.Join(home, ".engram", "integrations", "dsh"), profile
}

func dshWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestEmbeddedDSHMatchesSource(t *testing.T) {
	source := filepath.Join("..", "..", "plugin", "dsh")
	want := map[string][]byte{}
	err := filepath.WalkDir(source, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			if rel == "test" || rel == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		switch rel {
		case "package.json", "cordis.patch.yml", "index.ts", "runtime-contract.json", "README.md":
		default:
			if !strings.HasPrefix(filepath.ToSlash(rel), "lib/") || !strings.HasSuffix(rel, ".ts") {
				return nil
			}
		}

		data, err := os.ReadFile(path)
		want[filepath.ToSlash(rel)] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]byte{}
	err = fs.WalkDir(dshFS, "plugins/dsh", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		data, err := dshFS.ReadFile(path)
		got[strings.TrimPrefix(path, "plugins/dsh/")] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("embedded DSH file set/content differs from source; run go generate ./internal/setup/")
	}
}

func TestInstallDSH(t *testing.T) {
	dir, profile := dshFixture(t)
	calls := 0
	runCommand = func(name string, args ...string) ([]byte, error) {
		calls++
		if name != "dsh" || !reflect.DeepEqual(args, []string{"plugin", "--profile", "acp", "add", dir}) {
			t.Fatalf("command %s %q", name, args)
		}
		return []byte("installed"), nil
	}
	result, err := Install("dsh")
	if err != nil {
		t.Fatal(err)
	}
	if result.Destination != dir || result.Files < 6 || calls != 1 {
		t.Fatalf("result %+v calls %d", result, calls)
	}
	data, err := os.ReadFile(filepath.Join(dir, "lib", "config.ts"))
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("../../plugin/dsh/lib/config.ts")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, patchEngramBINLine(source, exe)) {
		t.Fatal("ENGRAM_BIN not patched")
	}
	for _, relative := range []bool{false, true} {
		link := dir
		if relative {
			link, err = filepath.Rel(profile, dir)
			if err != nil {
				t.Fatal(err)
			}
		}
		dshWrite(t, filepath.Join(profile, "package.json"), `{"dependencies":{"@cpkt9762/engram-dsh":"link:`+filepath.ToSlash(link)+`"}}`)
		dshWrite(t, filepath.Join(dir, "user-note.txt"), "preserve")
		dshWrite(t, filepath.Join(dir, "index.ts"), "stale")
		_, err = Install("dsh")
		if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
			if err == nil || !strings.Contains(err.Error(), "unsupported") {
				t.Fatalf("expected explicit unsupported refresh, got %v", err)
			}
			unchanged, readErr := os.ReadFile(filepath.Join(dir, "index.ts"))
			if readErr != nil || string(unchanged) != "stale" {
				t.Fatal("unsupported refresh changed old files", readErr)
			}
			if calls != 1 {
				t.Fatal("unsupported refresh invoked CLI")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if calls != 1 {
			t.Fatal("idempotent install ran CLI")
		}
		note, err := os.ReadFile(filepath.Join(dir, "user-note.txt"))
		if err != nil || string(note) != "preserve" {
			t.Fatal("unmanaged file lost", err)
		}
		index, err := os.ReadFile(filepath.Join(dir, "index.ts"))
		if err != nil || string(index) == "stale" {
			t.Fatal("files not refreshed", err)
		}
	}
	if steps := PostInstallSteps("dsh"); len(steps) < 4 {
		t.Fatalf("missing next steps: %v", steps)
	}
}

func TestInstallDSHPreflight(t *testing.T) {
	for _, tc := range []struct{ name, profile, pkg, yaml, want string }{
		{name: "invalid profile", profile: "../bad", want: "profile"},
		{name: "dot profile", profile: "..", want: "profile"},
		{name: "missing profile", profile: "missing", want: "initialize"},
		{name: "legacy conflict", pkg: `{"dependencies":{"@ian_p/dsh-gentle-engram":"*"}}`, want: "remove"},
		{name: "dev conflict", pkg: `{"devDependencies":{"@ian_p/dsh-gentle-engram":"*"}}`, want: "remove"},
		{name: "MCP conflict", yaml: "- insert:\n  - name: mcp\n    config: { serverName: 'engram' }\n", want: "remove"},
		{name: "YAML alias conflict", yaml: "defaults: &mcp {serverName: engram}\nconfig: *mcp\n", want: "remove"},
		{name: "multi-document MCP conflict", yaml: "[]\n---\nconfig: {serverName: engram}\n", want: "remove"},
		{name: "bad JSON", pkg: "{", want: "package.json"},
		{name: "bad YAML", yaml: "[", want: "cordis.patch.yml"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, p := dshFixture(t)
			t.Setenv("ENGRAM_DSH_PROFILE", tc.profile)
			if tc.pkg != "" {
				dshWrite(t, filepath.Join(p, "package.json"), tc.pkg)
			}
			if tc.yaml != "" {
				dshWrite(t, filepath.Join(p, "cordis.patch.yml"), tc.yaml)
			}
			_, err := Install("dsh")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v, want %s", err, tc.want)
			}
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Fatalf("preflight wrote files: %v", err)
			}
		})
	}
}

func TestInstallDSHCustomProfile(t *testing.T) {
	dir, p := dshFixture(t)
	custom := "dev_1.2-test"
	t.Setenv("ENGRAM_DSH_PROFILE", custom)
	if err := os.Rename(p, filepath.Join(filepath.Dir(p), custom)); err != nil {
		t.Fatal(err)
	}
	calls := 0
	runCommand = func(name string, args ...string) ([]byte, error) {
		calls++
		if !reflect.DeepEqual(args, []string{"plugin", "--profile", custom, "add", dir}) {
			t.Fatal(args)
		}
		return nil, nil
	}
	if _, err := Install("dsh"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}

func TestInstallDSHCommandErrors(t *testing.T) {
	t.Run("missing CLI", func(t *testing.T) {
		dir, _ := dshFixture(t)
		lookPathFn = func(string) (string, error) { return "", errors.New("missing") }
		_, err := Install("dsh")
		if err == nil || !strings.Contains(err.Error(), "dsh plugin --profile acp add "+dir) {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(dir, "index.ts")); err != nil {
			t.Fatal(err)
		}
	})
	for _, already := range []bool{false, true} {
		t.Run(map[bool]string{true: "already", false: "failure"}[already], func(t *testing.T) {
			dshFixture(t)
			failure := errors.New("host failed")
			runCommand = func(string, ...string) ([]byte, error) {
				if already {
					return []byte("Already installed"), failure
				}
				return []byte("original diagnostic"), failure
			}
			_, err := Install("dsh")
			if already {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.Is(err, failure) || !strings.Contains(err.Error(), "original diagnostic") {
				t.Fatal(err)
			}
		})
	}
}

func TestInstallDSHSpacePath(t *testing.T) {
	dshFixture(t)
	home := filepath.Join(t.TempDir(), "space home")
	userHomeDir = func() (string, error) { return home, nil }
	_, err := Install("dsh")
	if err == nil || !strings.Contains(err.Error(), "space") {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".engram")); !os.IsNotExist(err) {
		t.Fatal("space preflight wrote files")
	}
}

func TestInstallDSHDefaultRoot(t *testing.T) {
	dir, profile := dshFixture(t)
	home := filepath.Dir(filepath.Dir(filepath.Dir(dir)))
	target := filepath.Join(home, ".dsh", "profiles", "acp")
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(profile, target); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DSH_HOME", "")
	runCommand = func(string, ...string) ([]byte, error) { return nil, nil }
	if _, err := Install("dsh"); err != nil {
		t.Fatal(err)
	}
	if err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		want := os.FileMode(0644)
		if entry.IsDir() {
			want = 0755
		}
		if info.Mode().Perm() != want {
			t.Errorf("%s mode %o, want %o", path, info.Mode().Perm(), want)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestInstallDSHRemovesOnlyManagedOldFiles(t *testing.T) {
	dir, profile := dshFixture(t)
	dshWrite(t, filepath.Join(profile, "package.json"), `{"dependencies":{"@cpkt9762/engram-dsh":"link:`+filepath.ToSlash(dir)+`"}}`)
	dshWrite(t, filepath.Join(dir, dshManifest), `["lib/obsolete.ts"]`)
	dshWrite(t, filepath.Join(dir, "lib", "obsolete.ts"), "old")
	dshWrite(t, filepath.Join(dir, "lib", "custom.ts"), "user")
	_, err := Install("dsh")
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		if err == nil || !strings.Contains(err.Error(), "unsupported") {
			t.Fatalf("expected unsupported refresh, got %v", err)
		}
		for _, name := range []string{"obsolete.ts", "custom.ts"} {
			if _, err := os.Stat(filepath.Join(dir, "lib", name)); err != nil {
				t.Fatal("unsupported refresh removed file", err)
			}
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "lib", "obsolete.ts")); !os.IsNotExist(err) {
		t.Fatal("obsolete managed file retained", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "lib", "custom.ts"))
	if err != nil || string(data) != "user" {
		t.Fatal("custom file lost", err)
	}
}

func TestInstallDSHRejectsUnsafeExistingFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "manifest symlink", "manifest traversal"} {
		t.Run(kind, func(t *testing.T) {
			dir, _ := dshFixture(t)
			outside := filepath.Join(t.TempDir(), "outside.txt")
			dshWrite(t, outside, "preserve")
			switch kind {
			case "symlink":
				dshWrite(t, filepath.Join(dir, "index.ts"), "old")
				if err := os.Symlink(outside, filepath.Join(dir, "user-link")); err != nil {
					t.Fatal(err)
				}
			case "manifest symlink":
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(dir, dshManifest)); err != nil {
					t.Fatal(err)
				}
			default:
				dshWrite(t, filepath.Join(dir, dshManifest), `["../outside.txt"]`)
			}
			if _, err := Install("dsh"); err == nil {
				t.Fatal("unsafe file accepted")
			}
			data, err := os.ReadFile(outside)
			if err != nil || string(data) != "preserve" {
				t.Fatal("outside file changed", err)
			}
		})
	}
}

func TestDSHFailedExchangePreservesExistingFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "dsh")
	dshWrite(t, filepath.Join(dir, "old.txt"), "old")
	if err := replaceDSHDirectory(filepath.Join(t.TempDir(), "missing-stage"), dir); err == nil {
		t.Fatal("missing stage accepted")
	}
	data, err := os.ReadFile(filepath.Join(dir, "old.txt"))
	if err != nil || string(data) != "old" {
		t.Fatal("old directory damaged", err)
	}
}
