package store

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestMaskPromptSecrets(t *testing.T) {
	for _, tc := range []struct {
		input  string
		secret bool
	}{
		{"密码是 Zq9-FAKE-SECRET", true}, {"口令为 1234", true}, {"PASSWORD: Abcd1234", true}, {"api key = test-value", true},
		{"token：abcd", true}, {"secret=abcd", true}, {"pwd:abcd", true}, {"passwd=abcd", true},
		{"sk-abcdefghijklmnopqrstuvwxyz", true}, {"密码是 abc", false}, {"password policy", false}, {"mytoken=abcd", false}, {"tokenization: test", false},
	} {
		t.Run(tc.input, func(t *testing.T) {
			masked, reasons := MaskPromptSecrets(tc.input)
			if (len(reasons) > 0) != tc.secret {
				t.Fatalf("reasons: %v", reasons)
			}
			if tc.secret && (masked == tc.input || !strings.Contains(masked, "[已遮蔽]")) {
				t.Fatalf("unmasked: %s", masked)
			}
		})
	}
}
func TestScanPromptSecretsPaginationAndBackfill(t *testing.T) {
	st := newTestStore(t)
	if err := st.CreateSession("admin", "demo", "/tmp/demo"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 101; i++ {
		if _, err := st.AddPrompt(AddPromptParams{SessionID: "admin", Project: "demo", Content: fmt.Sprintf("密码是 fake-%d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	scan, err := st.ScanPromptSecrets("demo", "")
	if err != nil {
		t.Fatal(err)
	}
	if scan.Complete || len(scan.Items) != 100 || scan.NextCursor == "" {
		t.Fatalf("page: %+v", scan)
	}
	page, err := st.ScanPromptSecrets("demo", scan.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if !page.Complete || len(page.Items) != 1 || page.ScanToken != scan.ScanToken {
		t.Fatalf("page2: %+v", page)
	}
	// A same-row content change must invalidate the token, without a timestamp dependency.
	if _, err := st.db.Exec(`UPDATE user_prompts SET content='password: fake-new' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ScanPromptSecrets("demo", scan.NextCursor); !errors.Is(err, ErrScanStale) {
		t.Fatalf("cursor stale: %v", err)
	}
	if err := st.EnrollProjectAfterScan("demo", scan.ScanToken, false); !errors.Is(err, ErrScanStale) {
		t.Fatalf("join stale: %v", err)
	}
	scan, err = st.ScanPromptSecrets("demo", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnrollProjectAfterScan("demo", scan.ScanToken, false); err != nil {
		t.Fatal(err)
	}
	pending, err := st.ListPendingSyncMutations(DefaultSyncTargetKey, 200)
	if err != nil {
		t.Fatal(err)
	}
	prompts := 0
	for _, mutation := range pending {
		if mutation.Entity == SyncEntityPrompt {
			prompts++
		}
	}
	if prompts != 101 {
		t.Fatalf("backfilled prompts: %d", prompts)
	}
	state, err := st.CloudAdminState()
	if err != nil {
		t.Fatal(err)
	}
	if state.PendingCount != int64(len(pending)) {
		t.Fatalf("cloud pending: %d != %d", state.PendingCount, len(pending))
	}
	if err := st.EnrollProjectAfterScan("empty-project", "", true); err != nil {
		t.Fatal(err)
	}
}

func TestMaskPromptSecretsNearbyValues(t *testing.T) {
	for _, tc := range []struct {
		input, value string
		want         bool
	}{
		{"OpenWrt 可以用 ssh 10.0.0.1 密码 Abcd1234", "Abcd1234", true},
		{"请输入后台管理密码并登录，……  Zq9Fake12", "Zq9Fake12", true},
		{"root密码Abc12345", "Abc12345", true},
		{"passwordAbc12345", "Abc12345", true},
		{"pwdabcDef!", "abcDef!", true},
		{"the password is Abc12345", "Abc12345", true},
		{"password: Colon9Fake", "Colon9Fake", true}, {"pwd Pwd9Fake12", "Pwd9Fake12", true},
		{"密码 A_bcdef", "A_bcdef", true}, {"密码 !!!@@@", "!!!@@@", true},
		{"password: https://example.test/key123", "", false}, {"密码 /etc/router123", "", false},
		{"pwd ./cfg123/options.toml", "", false}, {"token ../secret123", "", false},
		{"open-u60-pro x86_64", "", false}, {"password policy", "", false},
		{"token budget", "", false}, {"secret key", "", false},
		{"mytoken=abcd", "", false}, {"password " + strings.Repeat("x ", 31) + "Far9Fake12", "", false},
	} {
		t.Run(tc.input, func(t *testing.T) {
			masked, reasons := MaskPromptSecrets(tc.input)
			if (len(reasons) > 0) != tc.want {
				t.Fatalf("detection=%v masked=%q", reasons, masked)
			}
			if tc.want && strings.Contains(masked, tc.value) {
				t.Fatalf("value not fully masked: %q", masked)
			}
		})
	}
	repeated := "密码" + strings.Repeat("密码", 100) + "说明 Zq9Fake12"
	if masked, _ := MaskPromptSecrets(repeated); strings.Contains(masked, "Zq9Fake12") {
		t.Fatal("overlapping windows missed the final keyword's value")
	}

	value := strings.Repeat("A1", 20)
	input := "password " + strings.Repeat("x ", 25) + value
	masked, _ := MaskPromptSecrets(input)
	if want := "password " + strings.Repeat("x ", 25) + "[已遮蔽]"; masked != want {
		t.Fatalf("value crossing window boundary only partly masked: %q", masked)
	}
}

func TestMaskPromptSecretsChineseImmediateValues(t *testing.T) {
	for _, input := range []string{
		"OpenWrt 可以用 ssh 10.0.0.1 密码 abcdefgh", "密码abcdefgh", "口令 abcd",
		"密码是 abcdefgh", "密码为 abcdefgh", "密码: abcdefgh", "密码=abcdefgh", "密码：abcdefgh",
	} {
		t.Run(input, func(t *testing.T) {
			masked, reasons := MaskPromptSecrets(input)
			if len(reasons) == 0 || strings.Contains(masked, "abcd") {
				t.Fatalf("immediate ASCII value not masked: %q (%v)", masked, reasons)
			}
		})
	}
	for _, input := range []string{"密码输入处", "密码 输入处", "我先找下密码，稍后再告诉你", "我先找下密码\n后面是普通中文句子", "密码 abc", "密码:abc"} {
		if masked, reasons := MaskPromptSecrets(input); masked != input || len(reasons) != 0 {
			t.Errorf("non-value changed: %q -> %q (%v)", input, masked, reasons)
		}
	}
}

func TestMaskPromptSecretsConversationReplies(t *testing.T) {
	question := "[Assistant] 请提供路由器后台管理密码。" + strings.Repeat("等待说明", 80) + "\n"
	for _, prefix := range []string{"", "[User] ", "[用户] ", "User: ", "user:\t", "用户："} {
		t.Run(prefix, func(t *testing.T) {
			input := question + prefix + "Zq9Fake1A"
			masked, reasons := MaskPromptSecrets(input)
			if len(reasons) == 0 || strings.Contains(masked, "Zq9Fake1A") || !strings.Contains(masked, prefix+"[已遮蔽]") {
				t.Fatalf("standalone reply not fully masked: %q (%v)", masked, reasons)
			}
		})
	}
	for _, tc := range []struct {
		name, input, value string
		want               bool
	}{
		{"last position", "密码" + strings.Repeat("中", 598) + "\nAbc123", "Abc123", true},
		{"outside window", "密码" + strings.Repeat("中", 599) + "\nAbc123", "Abc123", false},
		{"maximum length", question + "[User] " + strings.Repeat("A1", 32), strings.Repeat("A1", 32), true},
		{"too long", question + strings.Repeat("A1", 32) + "B", strings.Repeat("A1", 32) + "B", false},
		{"too short", question + "Ab123", "Ab123", false},
		{"letters only", question + "abcdefgh", "abcdefgh", false},
		{"digits only", question + "12345678", "12345678", false},
		{"multiple words", question + "Zq9Fake1A other", "Zq9Fake1A", false},
		{"URL", question + "https://example.test/Abc123", "https://example.test/Abc123", false},
		{"path", question + "/tmp/Abc123", "/tmp/Abc123", false},
		{"no keyword", "abc1234def\nopen-u60-pro\nx86_64", "abc1234def", false},
		{"keyword later", "abc1234def\n我先找下密码", "abc1234def", false},
		{"latest keyword", "密码" + strings.Repeat("中", 650) + " password 提示\n[User] Abc123", "Abc123", true},
		{"CRLF", question + " \t[User] Abc123 \t\r\n", "Abc123", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			masked, reasons := MaskPromptSecrets(tc.input)
			if (len(reasons) > 0) != tc.want || strings.Contains(masked, tc.value) == tc.want {
				t.Fatalf("want masked=%v: %q (%v)", tc.want, masked, reasons)
			}
			if !tc.want && masked != tc.input {
				t.Fatalf("negative example changed: %q", masked)
			}
		})
	}
}
