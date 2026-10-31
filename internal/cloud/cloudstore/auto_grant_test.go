package cloudstore

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// A transaction-capable SQL driver exercises production transaction control,
// parameter bindings and rollback without connecting to a database.
type autoGrantDriver struct {
	mu                 sync.Mutex
	projects           map[string]bool
	audits             []AuthAuditEvent
	fail               string
	enabled            bool
	commits, rollbacks int
}
type autoGrantConn struct {
	d        *autoGrantDriver
	projects map[string]bool
	audits   []AuthAuditEvent
	active   bool
}
type autoGrantTx struct{ c *autoGrantConn }
type autoGrantRows struct {
	columns []string
	values  [][]driver.Value
}

func (d *autoGrantDriver) Open(string) (driver.Conn, error)             { return &autoGrantConn{d: d}, nil }
func (d *autoGrantDriver) Connect(context.Context) (driver.Conn, error) { return d.Open("") }
func (d *autoGrantDriver) Driver() driver.Driver                        { return d }
func (c *autoGrantConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (c *autoGrantConn) Close() error { return nil }
func (c *autoGrantConn) BeginTx(_ context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if opts.Isolation != driver.IsolationLevel(sql.LevelReadCommitted) {
		return nil, errors.New("expected read committed isolation")
	}
	return c.Begin()
}
func (c *autoGrantConn) Begin() (driver.Tx, error) {
	c.d.mu.Lock()
	if c.d.fail == "begin" {
		c.d.mu.Unlock()
		return nil, errors.New("begin failed")
	}
	c.active = true
	c.projects = map[string]bool{}
	for p := range c.d.projects {
		c.projects[p] = true
	}
	c.audits = append([]AuthAuditEvent(nil), c.d.audits...)
	return &autoGrantTx{c: c}, nil
}
func (tx *autoGrantTx) Commit() error {
	c := tx.c
	defer c.d.mu.Unlock()
	c.active = false
	if c.d.fail == "commit" {
		return errors.New("commit failed")
	}
	c.d.projects, c.d.audits = c.projects, c.audits
	c.d.commits++
	return nil
}
func (tx *autoGrantTx) Rollback() error {
	c := tx.c
	if c.active {
		c.active = false
		c.d.rollbacks++
		c.d.mu.Unlock()
	}
	return nil
}
func (c *autoGrantConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	if !c.active {
		return nil, errors.New("query outside transaction")
	}
	switch {
	case strings.Contains(q, "SELECT enabled FROM cloud_principals"):
		if !strings.Contains(q, "FOR UPDATE") || args[0].Value != int64(7) {
			return nil, fmt.Errorf("missing identity lock/numeric binding: %s %v", q, args)
		}
		if c.d.fail == "lock" {
			return nil, errors.New("lock failed")
		}
		rows := &autoGrantRows{columns: []string{"enabled"}, values: [][]driver.Value{{c.d.enabled}}}
		if c.d.fail == "missing principal" {
			rows.values = nil
		}
		return rows, nil
	case strings.Contains(q, "SELECT project FROM cloud_project_grants"):
		if args[0].Value != int64(7) {
			return nil, errors.New("wrong grant identity")
		}
		if c.d.fail == "read" {
			return nil, errors.New("read failed")
		}
		rows := &autoGrantRows{columns: []string{"project"}}
		for p := range c.projects {
			rows.values = append(rows.values, []driver.Value{p})
		}
		return rows, nil
	case strings.Contains(q, "INSERT INTO cloud_project_grants"):
		if args[0].Value != "7" || args[2].Value != "7" {
			return nil, errors.New("grant not self owned")
		}
		if c.d.fail == "grant" {
			return nil, errors.New("grant failed")
		}
		project := args[1].Value.(string)
		c.projects[project] = true
		return &autoGrantRows{columns: []string{"principal_id", "project", "granted_by_principal_id", "created_at"}, values: [][]driver.Value{{"7", project, "7", time.Unix(0, 0)}}}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", q)
	}
}
func (c *autoGrantConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	if !c.active || !strings.Contains(q, "INSERT INTO cloud_auth_audit_log") {
		return nil, fmt.Errorf("unexpected exec: %s", q)
	}
	if c.d.fail == "audit" || (c.d.fail == "second audit" && len(c.audits) == 1) {
		return nil, errors.New("audit failed")
	}
	e := AuthAuditEvent{ActorPrincipalID: args[0].Value.(string), ActorSource: args[1].Value.(string), TargetPrincipalID: args[2].Value.(string), Project: args[3].Value.(string), Action: args[4].Value.(string), Outcome: args[5].Value.(string)}
	if err := json.Unmarshal(args[7].Value.([]byte), &e.Metadata); err != nil {
		return nil, err
	}
	c.audits = append(c.audits, e)
	return driver.RowsAffected(1), nil
}
func (r *autoGrantRows) Columns() []string { return r.columns }
func (*autoGrantRows) Close() error        { return nil }
func (r *autoGrantRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}
func autoGrantTestStore(t *testing.T, d *autoGrantDriver) *CloudStore {
	t.Helper()
	db := sql.OpenDB(d)
	t.Cleanup(func() { _ = db.Close() })
	return &CloudStore{db: db}
}
func TestAutoGrantTransaction(t *testing.T) {
	for _, tc := range []struct {
		name, fail string
		projects   []string
		max        int
		wantErr    bool
	}{
		{name: "first", projects: []string{"Alpha/Foo"}, max: 2},
		{name: "dual", projects: []string{"alpha", "beta"}, max: 2},
		{name: "normalized duplicate", projects: []string{"Alpha/Foo", "alpha-foo"}, max: 1},
		{name: "limit", projects: []string{"alpha", "beta"}, max: 1, wantErr: true},
		{name: "reserved", projects: []string{"alpha", "INBOX"}, max: 2, wantErr: true},
		{name: "wildcard", projects: []string{"*"}, max: 2, wantErr: true},
		{name: "empty", projects: []string{" "}, max: 2, wantErr: true},
		{name: "begin", fail: "begin", projects: []string{"alpha"}, max: 2, wantErr: true},
		{name: "lock", fail: "lock", projects: []string{"alpha"}, max: 2, wantErr: true},
		{name: "missing principal", fail: "missing principal", projects: []string{"alpha"}, max: 2, wantErr: true},
		{name: "read", fail: "read", projects: []string{"alpha"}, max: 2, wantErr: true},
		{name: "audit", fail: "audit", projects: []string{"alpha"}, max: 2, wantErr: true},
		{name: "second audit", fail: "second audit", projects: []string{"alpha", "beta"}, max: 2, wantErr: true},
		{name: "grant", fail: "grant", projects: []string{"alpha"}, max: 2, wantErr: true},
		{name: "commit", fail: "commit", projects: []string{"alpha"}, max: 2, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &autoGrantDriver{projects: map[string]bool{}, enabled: true, fail: tc.fail}
			cs := autoGrantTestStore(t, d)
			err := cs.AutoCreateProjectGrants(context.Background(), "7", "managed_token", tc.projects, tc.max)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
			if tc.wantErr {
				if len(d.projects) != 0 || len(d.audits) != 0 || d.commits != 0 {
					t.Fatalf("partial transaction: %+v", d)
				}
				if (tc.fail == "audit" || tc.fail == "second audit") && !errors.Is(err, ErrAuthAuditInsertFailed) {
					t.Fatalf("audit error not classified: %v", err)
				}
				return
			}
			if len(d.projects) == 0 || len(d.audits) != len(d.projects) || d.commits != 1 {
				t.Fatalf("grant/audit mismatch: %+v", d)
			}
			for _, e := range d.audits {
				if e.ActorPrincipalID != "7" || e.TargetPrincipalID != "7" || e.Action != "grant.auto_create" || e.Metadata["auto"] != true || e.Outcome != "success" {
					t.Fatalf("bad audit: %+v", e)
				}
			}
			// Replaying at capacity emits no extra event and succeeds.
			count := len(d.audits)
			if err := cs.AutoCreateProjectGrants(context.Background(), "7", "managed_token", tc.projects, len(d.projects)); err != nil {
				t.Fatal(err)
			}
			if len(d.audits) != count {
				t.Fatal("replay duplicated audit")
			}
		})
	}
}
func TestAutoGrantStorageConcurrency(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(fmt.Sprint(same), func(t *testing.T) {
			d := &autoGrantDriver{projects: map[string]bool{}, enabled: true}
			cs := autoGrantTestStore(t, d)
			results := make(chan error, 2)
			var wg sync.WaitGroup
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					project := "alpha"
					if !same {
						project = fmt.Sprintf("alpha-%d", i)
					}
					results <- cs.AutoCreateProjectGrants(context.Background(), "7", "managed_token", []string{project}, 1)
				}(i)
			}
			wg.Wait()
			close(results)
			success := 0
			for err := range results {
				if err == nil {
					success++
				} else if !errors.Is(err, ErrAutoGrantLimit) {
					t.Fatal(err)
				}
			}
			want := 1
			if same {
				want = 2
			}
			if success != want || len(d.projects) != 1 || len(d.audits) != 1 {
				t.Fatalf("success=%d state=%+v", success, d)
			}
		})
	}
}
func TestAutoGrantDisabledPrincipalAndExistingCapacity(t *testing.T) {
	d := &autoGrantDriver{projects: map[string]bool{"manual": true}, enabled: false}
	cs := autoGrantTestStore(t, d)
	if err := cs.AutoCreateProjectGrants(context.Background(), "7", "managed_token", []string{"alpha"}, 1); !errors.Is(err, ErrPrincipalDisabled) {
		t.Fatalf("disabled principal accepted: %v", err)
	}
	d.enabled = true
	if err := cs.AutoCreateProjectGrants(context.Background(), "7", "managed_token", []string{"alpha"}, 1); !errors.Is(err, ErrAutoGrantLimit) {
		t.Fatalf("manual grant did not consume capacity: %v", err)
	}
	if len(d.projects) != 1 || len(d.audits) != 0 {
		t.Fatal("rejection left writes")
	}
}
