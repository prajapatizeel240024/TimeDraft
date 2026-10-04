package rounding

import (
	"encoding/json"
	"os"
	"testing"
)

type fixture struct {
	Cases []struct {
		Seconds int `json:"seconds"`
		Tenths  int `json:"tenths"`
	} `json:"cases"`
	Invalid []int `json:"invalid"`
}

func TestTenthsMatchesSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../../contracts/fixtures/rounding.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.Cases {
		got, err := Tenths(c.Seconds)
		if err != nil || got != c.Tenths {
			t.Errorf("Tenths(%d) = %d, %v; want %d", c.Seconds, got, err, c.Tenths)
		}
	}
	for _, bad := range fx.Invalid {
		if _, err := Tenths(bad); err == nil {
			t.Errorf("Tenths(%d) should fail", bad)
		}
	}
}

func TestHours(t *testing.T) {
	for in, want := range map[int]string{1: "0.1", 5: "0.5", 10: "1.0", 12: "1.2", 240: "24.0"} {
		if got := Hours(in); got != want {
			t.Errorf("Hours(%d) = %q; want %q", in, got, want)
		}
	}
}
