package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrScanStale = errors.New("prompt scan is stale")
var ErrInvalidScanCursor = errors.New("invalid scan cursor")
var ErrEnrollmentProjectReserved = errors.New("reserved project cannot be enrolled")
var ErrPromptProjectMismatch = errors.New("prompt project mismatch")

// These patterns are a display projection; persistence redaction remains unchanged.
var promptSecretRules = []struct {
	name string
	re   *regexp.Regexp
}{
	{"credential assignment", regexp.MustCompile(`(?i)(密码|口令|\bpassword\b|\bpasswd\b|\bpwd\b|\btoken\b|\bsecret\b|\bapi[ ]?key\b)\s*(是|为|:|=|：|\bis\b)\s*([^\s]{4,})`)},
	// Capture the entire first ASCII token before applying the length check, so
	// an optional delimiter cannot backtrack into a too-short value (密码:abc).
	{"Chinese credential value", regexp.MustCompile(`(密码|口令)\s*(是|为|:|=|：)?\s*([!-~]+)`)},
}

var promptAdjacentCredential = regexp.MustCompile(`(?i:\b(?:password|passwd|pwd|token|secret|api[ ]?key))([^\s]{6,})`)

var promptCredentialKeyword = regexp.MustCompile(`(?i)(密码|口令|\bpassword\b|\bpasswd\b|\bpwd\b|\btoken\b|\bsecret\b|\bapi[ ]?key\b)`)

var promptStandaloneReply = regexp.MustCompile(`(?mi)^[ \t]*(?:(?:\[(?:user|用户)\]|(?:user|用户)[ \t]*[:：])[ \t]*)?([!-~]{6,64})[ \t]*\r?$`)

type displaySecretSpan struct{ start, end int }

// MaskPromptSecrets is only a display/scan projection. Explicit assignments keep
// their four-character compatibility; Chinese immediate ASCII values also need
// four characters. Heuristic values need six runes. Windows limit value starts
// (60 runes nearby, 600 for standalone replies), never truncate detected values.
func MaskPromptSecrets(text string) (string, []string) {
	spans := []displaySecretSpan{}
	reasons := []string{}
	seen := map[string]bool{}
	add := func(start, end int, reason string) {
		spans = append(spans, displaySecretSpan{start, end})
		if !seen[reason] {
			seen[reason] = true
			reasons = append(reasons, reason)
		}
	}
	for _, rule := range promptSecretRules {
		for _, match := range rule.re.FindAllStringSubmatchIndex(text, -1) {
			start, end := match[6], match[7]
			if end-start >= 4 && !obviousDisplayLocation(text[start:end]) {
				add(start, end, rule.name)
			}
		}
	}
	for _, match := range promptAdjacentCredential.FindAllStringSubmatchIndex(text, -1) {
		start, end := match[2], match[3]
		value := text[start:end]
		// A grammatical trailing colon does not turn "tokenization:" into a value.
		if looksLikeDisplayPassword(strings.TrimRight(value, ":,.;")) && !obviousDisplayLocation(value) {
			add(start, end, "credential adjacent value")
		}
	}
	// Reuse whole-token boundaries/classification across overlapping keyword
	// windows, including a long unbroken token containing many keywords.
	cachedStart, cachedEnd, classifiedStart, classifiedEnd := -1, -1, -1, -1
	skipClassified := false
	keywords := promptCredentialKeyword.FindAllStringIndex(text, -1)
	for _, keyword := range keywords {
		start := keyword[1]
		limit := start
		for count := 0; limit < len(text) && count < 60; count++ {
			_, size := utf8.DecodeRuneInString(text[limit:])
			limit += size
		}
		end := limit
		if limit >= cachedStart && limit < cachedEnd {
			end = cachedEnd
		}
		for end < len(text) {
			r, size := utf8.DecodeRuneInString(text[end:])
			if displayValueBoundary(r) {
				break
			}
			end += size
		}
		for pos := start; pos < end; {
			r, size := utf8.DecodeRuneInString(text[pos:])
			if displayValueBoundary(r) {
				pos += size
				continue
			}
			tokenStart := pos
			if tokenStart >= cachedStart && tokenStart < cachedEnd {
				pos = cachedEnd
			} else {
				for pos < end {
					r, size = utf8.DecodeRuneInString(text[pos:])
					if displayValueBoundary(r) {
						break
					}
					pos += size
				}
				cachedStart, cachedEnd = tokenStart, pos
			}
			if tokenStart >= limit {
				break
			}
			if classifiedEnd == pos && tokenStart >= classifiedStart && skipClassified {
				continue
			}
			value := text[tokenStart:pos]
			looks := looksLikeDisplayPassword(value)
			masked := looks && !obviousDisplayLocation(value)
			if masked {
				add(tokenStart, pos, "credential nearby value")
			}
			classifiedStart, classifiedEnd, skipClassified = tokenStart, pos, !looks || masked
		}
	}
	for _, span := range standaloneReplySecretSpans(text, keywords) {
		add(span.start, span.end, "credential standalone reply")
	}
	for _, rule := range secretPatterns {
		for _, match := range rule.re.FindAllStringIndex(text, -1) {
			add(match[0], match[1], rule.label)
		}
	}
	if len(spans) == 0 {
		return text, reasons
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	merged := []displaySecretSpan{spans[0]}
	for _, span := range spans[1:] {
		last := &merged[len(merged)-1]
		if span.start <= last.end {
			if span.end > last.end {
				last.end = span.end
			}
		} else {
			merged = append(merged, span)
		}
	}
	var output strings.Builder
	pos := 0
	for _, span := range merged {
		output.WriteString(text[pos:span.start])
		output.WriteString("[已遮蔽]")
		pos = span.end
	}
	output.WriteString(text[pos:])
	return output.String(), reasons
}

// Match whole reply lines once, then associate each with the nearest preceding
// keyword. Counting at most 600 runes keeps distant history out of this rule.
func standaloneReplySecretSpans(text string, keywords [][]int) []displaySecretSpan {
	var spans []displaySecretSpan
	nextKeyword, keywordEnd := 0, -1
	for _, match := range promptStandaloneReply.FindAllStringSubmatchIndex(text, -1) {
		start, end := match[2], match[3]
		for nextKeyword < len(keywords) && keywords[nextKeyword][1] <= start {
			keywordEnd = keywords[nextKeyword][1]
			nextKeyword++
		}
		if keywordEnd < 0 || start-keywordEnd > 600*utf8.UTFMax || utf8.RuneCountInString(text[keywordEnd:start]) >= 600 {
			continue
		}
		value := text[start:end]
		letter, digit := false, false
		for _, r := range value {
			letter = letter || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
			digit = digit || r >= '0' && r <= '9'
		}
		if letter && digit && !obviousDisplayLocation(value) {
			spans = append(spans, displaySecretSpan{start, end})
		}
	}
	return spans
}

func displayValueBoundary(r rune) bool {
	return unicode.IsSpace(r) || strings.ContainsRune("，。；：、！？…“”‘’", r)
}
func looksLikeDisplayPassword(value string) bool {
	if utf8.RuneCountInString(value) < 6 {
		return false
	}
	letter, digit, special := false, false, false
	for _, r := range value {
		if unicode.IsSpace(r) {
			return false
		}
		switch {
		case unicode.IsLetter(r):
			letter = true
		case unicode.IsDigit(r):
			digit = true
		default:
			special = true
		}
	}
	return letter && digit || special
}
func obviousDisplayLocation(value string) bool {
	value = strings.Trim(value, `"'()[]{}<>`)
	value = strings.TrimLeft(value, "=:：")
	value = strings.TrimPrefix(value, "是")
	value = strings.TrimPrefix(value, "为")
	lower := strings.ToLower(value)
	if strings.Contains(lower, "://") || strings.HasPrefix(lower, "www.") {
		return true
	}
	for _, prefix := range []string{"/", `\`, "./", "../", "~/", `~\`, "etc/", "config/", "src/", "docs/", "home/", "users/", "bin/"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if len(value) > 2 && value[1] == ':' && (value[2] == '/' || value[2] == '\\') {
		return true
	}
	// Relative paths with a filename extension are also unambiguous display locations.
	return strings.ContainsAny(value, `/\`) && strings.Contains(value, ".")
}

type PromptSecretItem struct {
	ID            int64  `json:"id"`
	CreatedAt     string `json:"created_at"`
	SessionID     string `json:"session_id"`
	Reason        string `json:"reason"`
	MaskedContext string `json:"masked_context"`
}

type PromptSecretScan struct {
	Items      []PromptSecretItem `json:"items"`
	NextCursor string             `json:"next_cursor"`
	Complete   bool               `json:"complete"`
	ScanToken  string             `json:"scan_token"`
}

// promptScanTokenTx hashes rows including content because user_prompts has no
// updated_at column. This also detects same-second edits and project reassignment.
func promptScanTokenTx(tx *sql.Tx, project string) (string, error) {
	rows, err := tx.Query(`SELECT id, session_id, content, created_at FROM user_prompts WHERE project=? ORDER BY id`, project)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	h := sha256.New()
	enc := json.NewEncoder(h)
	if err := enc.Encode(project); err != nil {
		return "", err
	}
	for rows.Next() {
		var id int64
		var session, content, created string
		if err := rows.Scan(&id, &session, &content, &created); err != nil {
			return "", err
		}
		if err := enc.Encode([]any{id, session, content, created}); err != nil {
			return "", err
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func parsePromptScanCursor(cursor string) (string, int64, error) {
	if cursor == "" {
		return "", 0, nil
	}
	parts := strings.Split(cursor, ":")
	if len(parts) != 2 || len(parts[0]) != sha256.Size*2 {
		return "", 0, ErrInvalidScanCursor
	}
	if _, err := hex.DecodeString(parts[0]); err != nil {
		return "", 0, ErrInvalidScanCursor
	}
	after, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || after < 0 {
		return "", 0, ErrInvalidScanCursor
	}
	return parts[0], after, nil
}

// ScanPromptSecrets pages source rows (not only matches) in one snapshot. A cursor
// binds subsequent pages to the first snapshot so additions cannot escape review.
func (s *Store) ScanPromptSecrets(project, cursor string) (PromptSecretScan, error) {
	project, err := ValidateExpectedProject(project)
	if err != nil {
		return PromptSecretScan{}, err
	}
	cursorToken, after, err := parsePromptScanCursor(cursor)
	if err != nil {
		return PromptSecretScan{}, err
	}
	result := PromptSecretScan{Items: []PromptSecretItem{}}
	err = s.withTx(func(tx *sql.Tx) error {
		token, err := promptScanTokenTx(tx, project)
		if err != nil {
			return err
		}
		if cursor != "" && cursorToken != token {
			return ErrScanStale
		}
		rows, err := tx.Query(`SELECT id,session_id,content,created_at FROM user_prompts WHERE project=? AND id>? ORDER BY id LIMIT 101`, project, after)
		if err != nil {
			return err
		}
		defer rows.Close()
		count := 0
		last := after
		result.Complete = true
		result.ScanToken = token
		for rows.Next() {
			var item PromptSecretItem
			var content string
			if err := rows.Scan(&item.ID, &item.SessionID, &content, &item.CreatedAt); err != nil {
				return err
			}
			count++
			if count > 100 {
				result.Complete = false
				break
			}
			last = item.ID
			masked, reasons := MaskPromptSecrets(content)
			if len(reasons) > 0 {
				item.Reason = strings.Join(reasons, ", ")
				runes := []rune(masked)
				if len(runes) > 400 {
					masked = string(runes[:400]) + "…"
				}
				item.MaskedContext = masked
				result.Items = append(result.Items, item)
			}
		}
		if !result.Complete {
			result.NextCursor = token + ":" + strconv.FormatInt(last, 10)
		}
		return rows.Err()
	})
	return result, err
}

// EnrollProjectAfterScan atomically validates the reviewed snapshot and performs
// the same enrollment/backfill as the CLI. Force is an explicit user decision.
func (s *Store) EnrollProjectAfterScan(project, token string, force bool) error {
	project, err := ValidateExpectedProject(project)
	if err != nil {
		return err
	}
	if project == ReservedInboxProjectName {
		return ErrEnrollmentProjectReserved
	}
	return s.withTx(func(tx *sql.Tx) error {
		enrolled, err := isProjectEnrolledTx(tx, project)
		if err != nil {
			return err
		}
		if enrolled {
			return nil
		}
		if !force {
			current, err := promptScanTokenTx(tx, project)
			if err != nil {
				return err
			}
			if token == "" || current != token {
				return ErrScanStale
			}
		}
		return s.enrollProjectTx(tx, project)
	})
}

// CloudAdminState refers only to target cloud, never cloud:<project>.
type CloudAdminState struct {
	PendingCount  int64
	LastSuccessAt *string
}

func (s *Store) CloudAdminState() (CloudAdminState, error) {
	var result CloudAdminState
	err := s.db.QueryRow(`SELECT COUNT(*) FROM sync_mutations WHERE target_key='cloud' AND acked_at IS NULL AND disposition='pending'`).Scan(&result.PendingCount)
	if err != nil {
		return result, err
	}
	err = s.db.QueryRow(`SELECT last_success_at FROM sync_state WHERE target_key='cloud'`).Scan(&result.LastSuccessAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return result, err
}
