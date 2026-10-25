package setup

// Sync embedded plugin copies from the source of truth (plugin/ directory).
// OpenCode and DSH embed runtime files; marketplace integrations use their host CLI.
// Run: go generate ./internal/setup/
//go:generate sh -c "rm -rf plugins/opencode && mkdir -p plugins/opencode && cp ../../plugin/opencode/engram.ts plugins/opencode/"
//go:generate bash -o pipefail -c "rm -rf plugins/dsh && mkdir -p plugins/dsh && cp ../../plugin/dsh/package.json ../../plugin/dsh/cordis.patch.yml ../../plugin/dsh/index.ts ../../plugin/dsh/runtime-contract.json ../../plugin/dsh/README.md plugins/dsh/ && cd ../../plugin/dsh && find lib -type f -name '*.ts' | tar -cf - -T - | tar -xf - -C ../../internal/setup/plugins/dsh/"
