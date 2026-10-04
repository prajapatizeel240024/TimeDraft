package guidelines

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
)

type fixtureFile struct {
	Profiles       map[string]Profile `json:"profiles"`
	Words          Words              `json:"words"`
	DailyMaxTenths int                `json:"daily_max_tenths"`
	Cases          []struct {
		Name    string       `json:"name"`
		Entries []CheckEntry `json:"entries"`
		Expect  []struct {
			EntryID  *string `json:"entry_id"`
			Code     string  `json:"code"`
			Severity string  `json:"severity"`
		} `json:"expect"`
	} `json:"cases"`
}

func id(p *string) string {
	if p == nil {
		return "day"
	}
	return *p
}

func TestCheckMatchesSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../../contracts/fixtures/guidelines.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx fixtureFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 40 {
		t.Fatalf("expected at least 40 cases, got %d", len(fx.Cases))
	}
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			flags, err := Check(CheckInput{Profiles: fx.Profiles, Words: fx.Words, DailyMaxTenths: fx.DailyMaxTenths, Entries: c.Entries})
			if err != nil {
				t.Fatal(err)
			}
			got, want := []string{}, []string{}
			for _, f := range flags {
				got = append(got, id(f.EntryID)+":"+f.Code)
			}
			for _, x := range c.Expect {
				want = append(want, id(x.EntryID)+":"+x.Code)
			}
			sort.Strings(got)
			sort.Strings(want)
			if len(got) != len(want) {
				t.Fatalf("got %v, want %v", got, want)
			}
			for i := range got {
				if got[i] != want[i] {
					t.Fatalf("got %v, want %v", got, want)
				}
			}
			for _, x := range c.Expect {
				if x.Severity == "" {
					continue
				}
				for _, f := range flags {
					if id(f.EntryID) == id(x.EntryID) && f.Code == x.Code && f.Severity != x.Severity {
						t.Errorf("%s severity %s, want %s", f.Code, f.Severity, x.Severity)
					}
				}
			}
		})
	}
}

func TestVerbForms(t *testing.T) {
	verbs := map[string]bool{"review": true, "draft": true, "revise": true, "confer": true, "prepare": true, "call": true, "telephone": true}
	for in, want := range map[string]string{"reviewed": "review", "drafted": "draft", "revised": "revise", "conferred": "confer", "preparing": "prepare", "calls": "call", "telephoned": "telephone", "objections": ""} {
		if got := verbOf(in, verbs); got != want {
			t.Errorf("verbOf(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestUnknownProfileIsAnError(t *testing.T) {
	if _, err := Check(CheckInput{Profiles: map[string]Profile{}, Entries: []CheckEntry{{ID: "e1", Profile: "nope", Narrative: "x"}}}); err == nil {
		t.Fatal("expected an error")
	}
}
