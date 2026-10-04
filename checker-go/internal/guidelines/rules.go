// Package guidelines mirrors src/server/guidelines/rules.ts rule for rule. Words are data (they arrive in
// each request); rules are code. contracts/fixtures/guidelines.json holds both implementations to the
// same answers.
package guidelines

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Profile struct {
	MaxEntryTenths int    `json:"max_entry_tenths"`
	MinWords       int    `json:"min_words"`
	BlockBilling   string `json:"block_billing"`
	CommMaxTenths  int    `json:"comm_max_tenths"`
	DailyMaxTenths int    `json:"daily_max_tenths"`
}

type Words struct {
	TaskVerbs      []string   `json:"task_verbs"`
	SameTaskPairs  [][]string `json:"same_task_pairs"`
	VaguePhrases   []string   `json:"vague_phrases"`
	GenericObjects []string   `json:"generic_objects"`
	RoleWords      []string   `json:"role_words"`
	Admin          []string   `json:"admin"`
	Personal       []string   `json:"personal"`
	GenericCaps    []string   `json:"generic_caps"`
}

type Interval struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type CheckEntry struct {
	ID               string     `json:"id"`
	Profile          string     `json:"profile"`
	UnitsTenths      int        `json:"units_tenths"`
	TaskCode         string     `json:"task_code"`
	ActivityCode     string     `json:"activity_code"`
	Narrative        string     `json:"narrative"`
	ThinContext      bool       `json:"thin_context"`
	Billable         bool       `json:"billable"`
	SourceCategories []string   `json:"source_categories"`
	Intervals        []Interval `json:"intervals"`
}

type CheckInput struct {
	Profiles       map[string]Profile `json:"profiles"`
	Words          Words              `json:"words"`
	DailyMaxTenths int                `json:"daily_max_tenths"`
	Entries        []CheckEntry       `json:"entries"`
}

type Flag struct {
	EntryID  *string  `json:"entry_id"`
	Code     string   `json:"code"`
	Severity string   `json:"severity"`
	Message  string   `json:"message"`
	Evidence []string `json:"evidence"`
}

var commCodes = map[string]bool{"A105": true, "A106": true, "A107": true, "A108": true}

const overlapLimitSeconds = 15 * 60

var (
	spaceRe       = regexp.MustCompile(`\s+`)
	clauseRe      = regexp.MustCompile(`(?i);|,|\band\b`)
	firstWordRe   = regexp.MustCompile(`^[A-Za-z]+`)
	trailingRe    = regexp.MustCompile(`[^A-Za-z0-9]+$`)
	edgeRe        = regexp.MustCompile(`^[^A-Za-z0-9]+|[^A-Za-z0-9]+$`)
	extensionRe   = regexp.MustCompile(`\.(docx?|pdf|xlsx?|pptx?|txt|msg|eml|zip|csv)$`)
	initialRe     = regexp.MustCompile(`\b[A-Z]\.\s?[A-Z][A-Za-z'-]+`)
	leadingRe     = regexp.MustCompile(`^[^A-Za-z]+`)
	capitalizedRe = regexp.MustCompile(`^[A-Z][a-z]+`)
	alnumRe       = regexp.MustCompile(`[A-Za-z0-9]`)
	phraseCache   sync.Map
)

func fmtTenths(t int) string { return fmt.Sprintf("%d.%d", t/10, t%10) }

func normalizeSpace(s string) string { return strings.TrimSpace(spaceRe.ReplaceAllString(s, " ")) }

// containsPhrase is a case-insensitive whole-phrase match.
func containsPhrase(text, phrase string) bool {
	if re, ok := phraseCache.Load(phrase); ok {
		return re.(*regexp.Regexp).MatchString(text)
	}
	re := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(phrase) + `\b`)
	phraseCache.Store(phrase, re)
	return re.MatchString(text)
}

func wordCount(text string) int {
	n := 0
	for _, t := range strings.Fields(text) {
		if alnumRe.MatchString(t) {
			n++
		}
	}
	return n
}

// verbOf maps simple past, -ing and -s forms back to a task verb: "reviewed" -> "review".
func verbOf(word string, verbs map[string]bool) string {
	w := strings.ToLower(word)
	if verbs[w] {
		return w
	}
	var candidates []string
	cut := func(n int) string {
		if len(w) > n {
			return w[:len(w)-n]
		}
		return ""
	}
	if strings.HasSuffix(w, "ed") {
		candidates = append(candidates, cut(2), cut(1), cut(3))
	}
	if strings.HasSuffix(w, "ing") {
		candidates = append(candidates, cut(3), cut(3)+"e", cut(4))
	}
	if strings.HasSuffix(w, "s") {
		candidates = append(candidates, cut(1))
	}
	for _, c := range candidates {
		if c != "" && c != "e" && verbs[c] {
			return c
		}
	}
	return ""
}

func clauses(narrative string) []string {
	var out []string
	for _, c := range clauseRe.Split(normalizeSpace(narrative), -1) {
		if c = strings.TrimSpace(c); c != "" {
			out = append(out, c)
		}
	}
	return out
}

func lastWord(narrative string) string {
	trimmed := trailingRe.ReplaceAllString(normalizeSpace(narrative), "")
	tokens := strings.Split(trimmed, " ")
	last := strings.ToLower(edgeRe.ReplaceAllString(tokens[len(tokens)-1], ""))
	return extensionRe.ReplaceAllString(last, "")
}

func hasCounterparty(narrative string, words Words) bool {
	n := normalizeSpace(narrative)
	for _, r := range words.RoleWords {
		if containsPhrase(n, r) {
			return true
		}
	}
	if initialRe.MatchString(n) {
		return true
	}
	generic := map[string]bool{}
	for _, g := range words.GenericCaps {
		generic[g] = true
	}
	tokens := strings.Split(n, " ")
	for _, tok := range tokens[1:] {
		if m := capitalizedRe.FindString(leadingRe.ReplaceAllString(tok, "")); m != "" && !generic[m] {
			return true
		}
	}
	return false
}

func blockBilling(e CheckEntry, words Words, severity string) *Flag {
	verbs := map[string]bool{}
	for _, v := range words.TaskVerbs {
		verbs[strings.ToLower(v)] = true
	}
	var found []string
	var distinct []string
	seen := map[string]bool{}
	for _, c := range clauses(e.Narrative) {
		if v := verbOf(firstWordRe.FindString(c), verbs); v != "" {
			found = append(found, c)
			if !seen[v] {
				seen[v] = true
				distinct = append(distinct, v)
			}
		}
	}
	if len(distinct) < 2 {
		return nil
	}
	pairs := map[string]bool{}
	for _, p := range words.SameTaskPairs {
		if len(p) == 2 {
			pairs[p[0]+"|"+p[1]] = true
			pairs[p[1]+"|"+p[0]] = true
		}
	}
	for i := range distinct {
		for j := i + 1; j < len(distinct); j++ {
			if !pairs[distinct[i]+"|"+distinct[j]] {
				return &Flag{EntryID: ptr(e.ID), Code: "BLOCK_BILLING", Severity: severity, Message: "Several tasks in one entry: " + strings.Join(distinct, ", ") + ".", Evidence: found}
			}
		}
	}
	return nil
}

func vague(e CheckEntry, words Words, minWords int) *Flag {
	n := normalizeSpace(e.Narrative)
	var reasons []string
	if e.ThinContext {
		reasons = append(reasons, "The sources don't say what this work was for.")
	}
	for _, p := range words.VaguePhrases {
		if containsPhrase(n, p) {
			reasons = append(reasons, fmt.Sprintf("Vague phrase %q.", p))
		}
	}
	if count := wordCount(n); count < minWords {
		reasons = append(reasons, fmt.Sprintf("Only %d words; this client expects at least %d.", count, minWords))
	}
	if last := lastWord(n); last != "" {
		for _, g := range words.GenericObjects {
			if g == last {
				reasons = append(reasons, fmt.Sprintf("Ends on a generic object (%q).", last))
				break
			}
		}
	}
	if commCodes[e.ActivityCode] && !hasCounterparty(n, words) {
		reasons = append(reasons, "Doesn't say who the communication was with.")
	}
	if len(reasons) == 0 {
		return nil
	}
	return &Flag{EntryID: ptr(e.ID), Code: "VAGUE_NARRATIVE", Severity: "block", Message: strings.Join(reasons, " "), Evidence: reasons}
}

func longEntry(e CheckEntry, maxTenths, commMax int) *Flag {
	var reasons []string
	if e.UnitsTenths > maxTenths {
		reasons = append(reasons, fmt.Sprintf("%s h is over this client's %s h limit per entry.", fmtTenths(e.UnitsTenths), fmtTenths(maxTenths)))
	}
	if commCodes[e.ActivityCode] && e.UnitsTenths > commMax {
		reasons = append(reasons, fmt.Sprintf("%s h of communication is over the %s h limit.", fmtTenths(e.UnitsTenths), fmtTenths(commMax)))
	}
	if len(reasons) == 0 {
		return nil
	}
	return &Flag{EntryID: ptr(e.ID), Code: "LONG_ENTRY", Severity: "warn", Message: strings.Join(reasons, " "), Evidence: reasons}
}

func adminTime(e CheckEntry, words Words) *Flag {
	if !e.Billable {
		return nil
	}
	hits := []string{}
	for _, w := range words.Admin {
		if containsPhrase(e.Narrative, w) {
			hits = append(hits, w)
		}
	}
	for _, c := range e.SourceCategories {
		if c == "admin" {
			hits = append(hits, "built from administrative activity")
			break
		}
	}
	if len(hits) == 0 {
		return nil
	}
	return &Flag{EntryID: ptr(e.ID), Code: "NON_BILLABLE_ADMIN", Severity: "block", Message: "Administrative work is not billable. Mark it non-billable or rewrite it.", Evidence: hits}
}

func overlapSeconds(a, b CheckEntry) (int, error) {
	total := 0.0
	for _, x := range a.Intervals {
		for _, y := range b.Intervals {
			xs, err1 := time.Parse(time.RFC3339, x.Start)
			xe, err2 := time.Parse(time.RFC3339, x.End)
			ys, err3 := time.Parse(time.RFC3339, y.Start)
			ye, err4 := time.Parse(time.RFC3339, y.End)
			for _, err := range []error{err1, err2, err3, err4} {
				if err != nil {
					return 0, fmt.Errorf("bad interval time: %w", err)
				}
			}
			start, end := xs, xe
			if ys.After(start) {
				start = ys
			}
			if ye.Before(end) {
				end = ye
			}
			if end.After(start) {
				total += end.Sub(start).Seconds()
			}
		}
	}
	return int(math.Round(total)), nil
}

// Check runs every rule. Flags come back in a fixed order: per entry, then overlaps, then the day total.
func Check(in CheckInput) ([]Flag, error) {
	flags := []Flag{}
	for _, e := range in.Entries {
		p, ok := in.Profiles[e.Profile]
		if !ok {
			return nil, fmt.Errorf("unknown profile %q on entry %s", e.Profile, e.ID)
		}
		for _, f := range []*Flag{blockBilling(e, in.Words, p.BlockBilling), vague(e, in.Words, p.MinWords), longEntry(e, p.MaxEntryTenths, p.CommMaxTenths), adminTime(e, in.Words)} {
			if f != nil {
				flags = append(flags, *f)
			}
		}
	}
	var billable []CheckEntry
	for _, e := range in.Entries {
		if e.Billable {
			billable = append(billable, e)
		}
	}
	for i := range billable {
		for j := i + 1; j < len(billable); j++ {
			secs, err := overlapSeconds(billable[i], billable[j])
			if err != nil {
				return nil, err
			}
			if secs > overlapLimitSeconds {
				minutes := int(math.Round(float64(secs) / 60))
				msg := fmt.Sprintf("Overlaps another entry by %d min.", minutes)
				flags = append(flags,
					Flag{EntryID: ptr(billable[i].ID), Code: "OVERLAP", Severity: "warn", Message: msg, Evidence: []string{billable[j].ID, fmt.Sprint(minutes)}},
					Flag{EntryID: ptr(billable[j].ID), Code: "OVERLAP", Severity: "warn", Message: msg, Evidence: []string{billable[i].ID, fmt.Sprint(minutes)}})
			}
		}
	}
	total := 0
	for _, e := range billable {
		total += e.UnitsTenths
	}
	if total > in.DailyMaxTenths {
		flags = append(flags, Flag{EntryID: nil, Code: "DAILY_TOTAL", Severity: "warn", Message: fmt.Sprintf("Billable total of %s h is above %s h for one day.", fmtTenths(total), fmtTenths(in.DailyMaxTenths)), Evidence: []string{fmtTenths(total)}})
	}
	return flags, nil
}

func ptr(s string) *string { return &s }
