#!/usr/bin/env bash
# Builds and describes one release of the fork-rebuild branch. The fork-release
# workflow calls it after CI passes; every subcommand also runs locally.
#
#   scripts/fork-release.sh version               print skip, tag and version for HEAD
#   scripts/fork-release.sh build <version> <dir>  cross-compile engram and pack the Pi plugin
#   scripts/fork-release.sh notes <tag>            print the release notes for HEAD
#
# Tags carry the fork- prefix so upstream's v* release, image and Pi publishing
# workflows never fire for a fork build. The upstream base is the merge base
# with FORK_RELEASE_UPSTREAM (default refs/remotes/upstream/main), which the
# caller must fetch first.
set -euo pipefail

export LC_ALL=C

upstream_ref="${FORK_RELEASE_UPSTREAM:-refs/remotes/upstream/main}"
targets="darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64"

die() {
	echo "fork-release: $*" >&2
	exit 1
}

usage() {
	sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

cd "$(git rev-parse --show-toplevel)"

# Patch subjects between a base and a head, using the same exclusion as
# docs/fork-patches/regenerate.sh so the list matches the .patch series.
patch_subjects() {
	git log --reverse --format='%s' "$1..$2" -- . ':(exclude)docs/fork-patches'
}

# Number<TAB>title rows from the patch table in docs/fork-patches/README.md, so
# release notes can show the Chinese title next to each English subject.
patch_titles() {
	if [ -f docs/fork-patches/README.md ]; then
		awk -F'|' '/^\| [0-9][0-9][0-9][0-9] \|/ {
			num = $2; title = $3
			gsub(/^ +| +$/, "", num); gsub(/^ +| +$/, "", title)
			print num "\t" title
		}' docs/fork-patches/README.md
	fi
}

# Reads "subject" or "subject<TAB>hash" lines and prints list items. Lines whose
# subject is in the series get the patch number and title from the table.
describe_lines() {
	local series="$1" titles="$2"
	awk -F'\t' -v series="$series" -v titles="$titles" '
		BEGIN {
			while ((getline line < titles) > 0) { split(line, f, "\t"); title[f[1]] = f[2] }
			n = 0
			while ((getline line < series) > 0) { n++; num[line] = sprintf("%04d", n) }
		}
		{
			subject = $1
			suffix = (NF > 1) ? " (`" $2 "`)" : ""
			if (subject in num) {
				id = num[subject]
				if (id in title) print "- **" id "** " title[id] " —— " subject suffix
				else print "- **" id "** " subject suffix
			} else {
				print "- " subject suffix
			}
		}'
}

upstream_base() {
	git rev-parse --verify --quiet "${upstream_ref}^{commit}" >/dev/null ||
		die "upstream ref ${upstream_ref} not found; fetch upstream main first"
	git merge-base "$1" "$upstream_ref"
}

# The nearest earlier fork tag. After a route-B rebuild onto a newer upstream
# no tag is reachable any more, so fall back to the highest tag by version.
previous_tag() {
	local current="$1" tag
	tag="$(git describe --tags --abbrev=0 --match 'fork-*' HEAD 2>/dev/null || true)"
	if [ "$tag" = "$current" ]; then
		tag="$(git describe --tags --abbrev=0 --match 'fork-*' HEAD^ 2>/dev/null || true)"
	fi
	if [ -n "$tag" ]; then
		echo "$tag"
		return
	fi
	git tag --list 'fork-*' --sort=-v:refname | grep -vxF "$current" | head -n 1 || true
}

cmd_version() {
	local existing day highest tag n
	existing="$(git tag --points-at HEAD --list 'fork-*' | head -n 1)"
	if [ -n "$existing" ]; then
		echo "skip=true"
		echo "tag=${existing}"
		return
	fi
	day="${FORK_RELEASE_DATE:-$(TZ=Asia/Shanghai date +%Y.%m.%d)}"
	highest=0
	for tag in $(git tag --list "fork-${day}.*"); do
		n="${tag#fork-"${day}".}"
		case "$n" in
		'' | *[!0-9]*) continue ;;
		esac
		if [ "$n" -gt "$highest" ]; then
			highest="$n"
		fi
	done
	tag="fork-${day}.$((highest + 1))"
	echo "skip=false"
	echo "tag=${tag}"
	echo "version=${tag}-$(git rev-parse --short=7 HEAD)"
}

sha256_files() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$@"
	else
		shasum -a 256 "$@"
	fi
}

cmd_build() {
	local version="${1:-}" out="${2:-}" target goos goarch ext pack
	if [ -z "$version" ] || [ -z "$out" ]; then
		die "usage: build <version> <dir>"
	fi
	mkdir -p "$out"
	out="$(cd "$out" && pwd)"
	for target in $targets; do
		goos="${target%/*}"
		goarch="${target#*/}"
		ext=""
		if [ "$goos" = "windows" ]; then
			ext=".exe"
		fi
		CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
			-ldflags "-s -w -X main.version=${version}" \
			-o "${out}/engram-${goos}-${goarch}${ext}" ./cmd/engram
	done
	pack="$(cd plugin/pi && npm pack --silent --pack-destination "$out")"
	mv "${out}/${pack}" "${out}/gentle-engram-pi-plugin.tgz"
	(cd "$out" && sha256_files engram-* gentle-engram-pi-plugin.tgz >checksums.txt)
}

print_patch_changes() {
	local prev="$1" base="$2" series="$3" titles="$4" prev_base added removed
	prev_base="$(upstream_base "$prev")"
	echo "本版重放到新的上游基线 \`${base:0:7}\`，上一版 \`${prev}\` 的基线是 \`${prev_base:0:7}\`。"
	echo
	added="$(comm -13 <(patch_subjects "$prev_base" "$prev" | sort -u) <(patch_subjects "$base" HEAD | sort -u))"
	removed="$(comm -23 <(patch_subjects "$prev_base" "$prev" | sort -u) <(patch_subjects "$base" HEAD | sort -u))"
	if [ -z "$added" ] && [ -z "$removed" ]; then
		echo "补丁标题与上一版相同，内容随新基线重放。"
		return
	fi
	if [ -n "$added" ]; then
		echo "新增或改名的补丁："
		echo
		echo "$added" | describe_lines "$series" "$titles"
		echo
	fi
	if [ -n "$removed" ]; then
		echo "去掉或改名前的补丁："
		echo
		echo "$removed" | sed 's/^/- /'
	fi
}

cmd_notes() {
	local tag="${1:-}" head base prev count repo work series titles
	if [ -z "$tag" ]; then
		die "usage: notes <tag>"
	fi
	head="$(git rev-parse HEAD)"
	base="$(upstream_base HEAD)"
	prev="$(previous_tag "$tag")"
	repo="${GITHUB_REPOSITORY:-cpkt9762/engram}"
	work="$(mktemp -d)"
	# shellcheck disable=SC2064 # expand now: work is local to this function
	trap "rm -rf '$work'" EXIT
	series="${work}/series"
	titles="${work}/titles"
	patch_subjects "$base" HEAD >"$series"
	patch_titles >"$titles"
	count="$(wc -l <"$series" | tr -d ' ')"

	echo "\`fork-rebuild\` 的 \`${head:0:7}\`，基于上游 Gentleman-Programming/engram 的 \`${base:0:7}\`（$(git log -1 --format=%cs "$base")），共 ${count} 个补丁。"
	echo
	echo "## 本次改动"
	echo
	if [ -z "$prev" ]; then
		echo "首次发布，内容即下方的完整补丁序列。"
	elif git merge-base --is-ancestor "$prev" HEAD; then
		echo "相对上一版 \`${prev}\`："
		echo
		git log --reverse --format='%s%x09%h' "${prev}..HEAD" | describe_lines "$series" "$titles"
	else
		print_patch_changes "$prev" "$base" "$series" "$titles"
	fi
	echo
	echo "## 补丁序列"
	echo
	describe_lines "$series" "$titles" <"$series"
	echo
	echo "## 下载"
	echo
	echo "| 文件 | 平台 |"
	echo "|---|---|"
	echo "| \`engram-darwin-arm64\` | macOS Apple Silicon |"
	echo "| \`engram-darwin-amd64\` | macOS Intel |"
	echo "| \`engram-linux-amd64\` | Linux x86_64 |"
	echo "| \`engram-linux-arm64\` | Linux ARM64 |"
	echo "| \`engram-windows-amd64.exe\` | Windows x86_64 |"
	echo "| \`gentle-engram-pi-plugin.tgz\` | Pi 插件（fork 版，解压后在 Pi 的 packages 里配置本地路径） |"
	echo "| \`checksums.txt\` | 以上文件的 SHA-256 |"
	echo
	echo "替换二进制后重启 \`engram serve\`；DSH 插件随二进制内嵌，升级后运行 \`engram setup dsh\`。"
	echo "每个补丁的说明、冲突解法和验证见 [docs/fork-patches/README.md](https://github.com/${repo}/blob/${head}/docs/fork-patches/README.md)。"
}

case "${1:-}" in
version)
	cmd_version
	;;
build)
	shift
	cmd_build "$@"
	;;
notes)
	shift
	cmd_notes "$@"
	;;
-h | --help)
	usage
	;;
*)
	usage >&2
	exit 2
	;;
esac
