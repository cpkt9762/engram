package main

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/Gentleman-Programming/engram/v3/internal/store"
)

// A narrow seam lets tests prove backup failure prevents any migration.
var projectsRenameBackup = (*store.Store).BackupSQLite

func cmdProjectsRename(cfg store.Config) {
	fail := func(err error) { fmt.Fprintf(os.Stderr, "projects rename: %v\n", err); exitFunc(1) }
	var from, to string
	var dryRun, apply bool
	seen := map[string]bool{}
	for i := 3; i < len(os.Args); i++ {
		flag := os.Args[i]
		if seen[flag] {
			fail(fmt.Errorf("duplicate argument %s", flag))
			return
		}
		seen[flag] = true
		switch flag {
		case "--from", "--to":
			if i+1 >= len(os.Args) || strings.HasPrefix(os.Args[i+1], "--") {
				fail(fmt.Errorf("%s requires a value", flag))
				return
			}
			i++
			if flag == "--from" {
				from = os.Args[i]
			} else {
				to = os.Args[i]
			}
		case "--dry-run":
			dryRun = true
		case "--apply":
			apply = true
		default:
			fail(fmt.Errorf("unknown argument %q", flag))
			return
		}
	}
	if !seen["--from"] || !seen["--to"] || dryRun == apply {
		fail(fmt.Errorf("usage: engram projects rename --from <source> --to <target> (--dry-run|--apply)"))
		return
	}
	s, err := storeNew(cfg)
	if err != nil {
		fail(err)
		return
	}
	defer func() { _ = s.Close() }()
	preview, err := s.PreviewProjectRename(from, to)
	if err != nil {
		fail(err)
		return
	}
	printProjectRenamePreflight(preview)
	action := "rename"
	if preview.TargetExists {
		action = "merge"
	}
	if dryRun {
		fmt.Printf("[dry-run] %s %q -> %q (source enrolled: %t, target enrolled: %t)\n", action, preview.Source, preview.Target, preview.SourceEnrolled, preview.TargetEnrolled)
		printProjectRenameCounts(preview.Tables)
		fmt.Println("No changes made. Point-in-time preview; apply revalidates and counts may differ.")
		return
	}
	if err := preview.CheckSyncLease(); err != nil {
		fail(err)
		return
	}
	backup, err := projectsRenameBackup(s)
	if err != nil {
		fail(err)
		return
	}
	fmt.Printf("Backup: %s\n", backup)
	result, err := s.RenameProject(preview.Source, preview.Target)
	if err != nil {
		fail(err)
		return
	}
	if !result.Migrated {
		fail(fmt.Errorf("source project %q does not exist", preview.Source))
		return
	}
	fmt.Printf("%s %q -> %q\n", action, preview.Source, preview.Target)
	printProjectRenameCounts(result.Tables)
	fmt.Println("Previously synced records will be re-pushed under the new name when enrolled.")
	fmt.Println("Cloud history under the old project name is append-only and will remain unchanged.")
}

func printProjectRenameCounts(counts map[string]int64) {
	tables := make([]string, 0, len(counts))
	for table := range counts {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	for _, table := range tables {
		fmt.Printf("  %s: %d\n", table, counts[table])
	}
}

func printProjectRenamePreflight(p *store.ProjectRenamePreview) {
	fmt.Printf("Unacknowledged sync mutations — pending: %d, quarantined: %d\n", p.PendingMutations, p.QuarantinedMutations)
	if len(p.SyncLeases) == 0 {
		fmt.Println("Sync lease: owner=\"\" until=\"\" active=false (no targets)")
	}
	for _, lease := range p.SyncLeases {
		fmt.Printf("Sync lease %q: owner=%q until=%q active=%t\n", lease.TargetKey, lease.Owner, lease.Until, lease.Active)
	}
	fmt.Printf("Source keyed prompts: %d\n", p.KeyedPrompts)
	if p.KeyedPrompts > 0 {
		fmt.Printf("Warning: %d keyed prompts retain local creation source %q; after rename their cloud sync will stop at prompt_provenance_blocked.\n", p.KeyedPrompts, p.Source)
	}
	if p.QuarantinedMutations > 0 {
		fmt.Printf("Warning: %d quarantined mutations count as covered by sync backfill but are never sent; these entities will not be pushed under %q.\n", p.QuarantinedMutations, p.Target)
	}
}
