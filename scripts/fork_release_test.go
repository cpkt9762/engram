package scripts

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type forkReleaseRepo struct {
	t      *testing.T
	dir    string
	shell  string
	script string
}

func newForkReleaseRepo(t *testing.T) *forkReleaseRepo {
	t.Helper()
	shell := perfRatchetShell()
	if shell == "" {
		t.Skip("a usable bash installation is required to test the fork release script")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required to test the fork release script")
	}
	script, err := filepath.Abs("fork-release.sh")
	if err != nil {
		t.Fatal(err)
	}
	r := &forkReleaseRepo{t: t, dir: t.TempDir(), shell: shell, script: script}
	r.git("init", "-q", "-b", "fork-rebuild")
	r.git("config", "user.name", "fixture")
	r.git("config", "user.email", "fixture@example.invalid")
	r.git("config", "commit.gpgsign", "false")
	r.git("config", "tag.gpgsign", "false")
	return r
}

func (r *forkReleaseRepo) git(args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func (r *forkReleaseRepo) commit(path, subject string) string {
	r.t.Helper()
	return r.commitContent(path, subject+"\n", subject)
}

func (r *forkReleaseRepo) commitContent(path, content, subject string) string {
	r.t.Helper()
	full := filepath.Join(r.dir, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
		r.t.Fatal(err)
	}
	r.git("add", path)
	r.git("commit", "-q", "-m", subject)
	return r.git("rev-parse", "HEAD")
}

func (r *forkReleaseRepo) run(extraEnv []string, args ...string) (string, error) {
	r.t.Helper()
	cmd := exec.Command(r.shell, append([]string{r.script}, args...)...)
	cmd.Dir = r.dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "FORK_RELEASE_DATE=2026.10.26", "GITHUB_REPOSITORY=owner/engram")
	cmd.Env = append(cmd.Env, extraEnv...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (r *forkReleaseRepo) mustRun(args ...string) string {
	r.t.Helper()
	out, err := r.run(nil, args...)
	if err != nil {
		r.t.Fatalf("fork-release.sh %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

func assertContains(t *testing.T, out string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(out, want) {
			t.Fatalf("output is missing %q:\n%s", want, out)
		}
	}
}

func assertNotContains(t *testing.T, out string, unwanted ...string) {
	t.Helper()
	for _, s := range unwanted {
		if strings.Contains(out, s) {
			t.Fatalf("output unexpectedly contains %q:\n%s", s, out)
		}
	}
}

func TestForkReleaseVersionNotesAndRebuild(t *testing.T) {
	r := newForkReleaseRepo(t)
	base := r.commit("upstream.txt", "upstream base")
	r.git("update-ref", "refs/remotes/upstream/main", base)
	r.commit("feature.txt", "feat(store): first fork change")
	r.commitContent("docs/fork-patches/README.md",
		"| # | 补丁 | 主要文件 | 冲突风险 | 可提上游 |\n|---|---|---|---|---|\n| 0001 | 第一处改动 | `feature.txt` | 低 | 是 |\n",
		"docs(fork): record the first patch")

	first := r.mustRun("version")
	head := r.git("rev-parse", "--short=7", "HEAD")
	assertContains(t, first, "skip=false\n", "tag=fork-2026.10.26.1\n", "version=fork-2026.10.26.1-"+head+"\n")

	notes := r.mustRun("notes", "fork-2026.10.26.1")
	assertContains(t, notes,
		"基于上游 Gentleman-Programming/engram 的 `"+base[:7]+"`",
		"共 1 个补丁",
		"首次发布",
		"- **0001** 第一处改动 —— feat(store): first fork change\n",
		"https://github.com/owner/engram/blob/",
	)
	assertNotContains(t, notes, "**0002**", "record the first patch")

	r.git("tag", "fork-2026.10.26.1")
	assertContains(t, r.mustRun("version"), "skip=true\n", "tag=fork-2026.10.26.1\n")

	r.commit("fix.txt", "fix(cloud): second fork change")
	assertContains(t, r.mustRun("version"), "tag=fork-2026.10.26.2\n")
	notes = r.mustRun("notes", "fork-2026.10.26.2")
	assertContains(t, notes,
		"相对上一版 `fork-2026.10.26.1`",
		"- **0002** fix(cloud): second fork change (`",
		"共 2 个补丁",
		"- **0001** 第一处改动 —— feat(store): first fork change\n",
		"- **0002** fix(cloud): second fork change\n",
	)
	assertNotContains(t, notes, "first fork change (`")
	r.git("tag", "fork-2026.10.26.2")

	// Simulate a route-B rebuild: replay onto a newer upstream, dropping one
	// patch and adding another. No earlier fork tag is reachable afterwards.
	r.git("checkout", "-q", "--detach", base)
	newBase := r.commit("upstream2.txt", "upstream moves on")
	r.git("update-ref", "refs/remotes/upstream/main", newBase)
	r.commit("feature.txt", "feat(store): first fork change")
	r.commit("third.txt", "feat(project): third fork change")
	r.git("checkout", "-q", "-B", "fork-rebuild")

	assertContains(t, r.mustRun("version"), "tag=fork-2026.10.26.3\n")
	notes = r.mustRun("notes", "fork-2026.10.26.3")
	assertContains(t, notes,
		"本版重放到新的上游基线 `"+newBase[:7]+"`",
		"上一版 `fork-2026.10.26.2` 的基线是 `"+base[:7]+"`",
		"新增或改名的补丁：\n\n- **0002** feat(project): third fork change\n",
		"去掉或改名前的补丁：\n\n- fix(cloud): second fork change\n",
		"共 2 个补丁",
	)
}

func TestForkReleaseRejectsMissingUpstream(t *testing.T) {
	r := newForkReleaseRepo(t)
	r.commit("feature.txt", "feat: change")
	out, err := r.run(nil, "notes", "fork-2026.10.26.1")
	if err == nil {
		t.Fatalf("notes succeeded without an upstream ref:\n%s", out)
	}
	assertContains(t, out, "fetch upstream main first")
	if out, err := r.run(nil, "bogus"); err == nil {
		t.Fatalf("unknown subcommand succeeded:\n%s", out)
	}
}

func TestForkReleaseBuildAssets(t *testing.T) {
	r := newForkReleaseRepo(t)
	r.commit("plugin/pi/package.json", "pi plugin")
	bin := t.TempDir()
	log := filepath.Join(t.TempDir(), "go.log")
	fakeGo := "#!/usr/bin/env bash\n" +
		"set -euo pipefail\n" +
		"echo \"$CGO_ENABLED $GOOS/$GOARCH $*\" >> " + log + "\n" +
		"while [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then echo binary > \"$2\"; fi; shift; done\n"
	fakeNpm := "#!/usr/bin/env bash\n" +
		"set -euo pipefail\n" +
		"while [ $# -gt 0 ]; do if [ \"$1\" = --pack-destination ]; then echo tgz > \"$2/gentle-engram-0.5.1.tgz\"; fi; shift; done\n" +
		"echo gentle-engram-0.5.1.tgz\n"
	for name, body := range map[string]string{"go": fakeGo, "npm": fakeNpm} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	path := "PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH")
	if out, err := r.run([]string{path}, "build", "fork-2026.10.26.1-abc1234", "dist"); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	want := []string{
		"checksums.txt",
		"engram-darwin-amd64",
		"engram-darwin-arm64",
		"engram-linux-amd64",
		"engram-linux-arm64",
		"engram-windows-amd64.exe",
		"gentle-engram-pi-plugin.tgz",
	}
	entries, err := os.ReadDir(filepath.Join(r.dir, "dist"))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, entry := range entries {
		got = append(got, entry.Name())
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("assets = %v, want %v", got, want)
	}
	sums, err := os.ReadFile(filepath.Join(r.dir, "dist", "checksums.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Count(string(sums), "\n"); lines != len(want)-1 {
		t.Fatalf("checksums.txt has %d lines, want %d:\n%s", lines, len(want)-1, sums)
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	assertContains(t, string(calls), "0 windows/amd64 build -trimpath -ldflags -s -w -X main.version=fork-2026.10.26.1-abc1234 -o ")
	if n := strings.Count(string(calls), "\n"); n != 5 {
		t.Fatalf("go build ran %d times, want 5:\n%s", n, calls)
	}
}
