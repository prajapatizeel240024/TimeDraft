package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func server() *httptest.Server {
	return httptest.NewServer(New(slog.New(slog.NewTextHandler(io.Discard, nil))))
}

func post(t *testing.T, url, body string) (int, string) {
	t.Helper()
	res, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestHealthz(t *testing.T) {
	s := server()
	defer s.Close()
	res, err := http.Get(s.URL + "/healthz")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", res, err)
	}
}

func TestRound(t *testing.T) {
	s := server()
	defer s.Close()
	code, body := post(t, s.URL+"/v1/round", `{"items":[{"id":"a","seconds":361},{"id":"b","seconds":3600}]}`)
	if code != 200 || !strings.Contains(body, `"tenths":2`) || !strings.Contains(body, `"hours":"1.0"`) {
		t.Fatalf("round: %d %s", code, body)
	}
	if code, _ := post(t, s.URL+"/v1/round", `{"items":[{"id":"a","seconds":0}]}`); code != 400 {
		t.Fatalf("zero seconds should be a 400, got %d", code)
	}
}

func TestCheck(t *testing.T) {
	s := server()
	defer s.Close()
	body := `{"profiles":{"p":{"max_entry_tenths":30,"min_words":6,"block_billing":"warn","comm_max_tenths":10,"daily_max_tenths":100}},
	  "words":{"task_verbs":["review"],"same_task_pairs":[],"vague_phrases":["reviewed file"],"generic_objects":["file"],"role_words":[],"admin":[],"personal":[],"generic_caps":[]},
	  "daily_max_tenths":100,
	  "entries":[{"id":"e1","profile":"p","units_tenths":5,"task_code":"L120","activity_code":"A104","narrative":"Reviewed file.","thin_context":false,"billable":true,"source_categories":["billable"],"intervals":[]}]}`
	code, out := post(t, s.URL+"/v1/check", body)
	if code != 200 || !strings.Contains(out, `"VAGUE_NARRATIVE"`) || !strings.Contains(out, `"checker":"go@1"`) {
		t.Fatalf("check: %d %s", code, out)
	}
	if code, _ := post(t, s.URL+"/v1/check", `{"surprise":true}`); code != 400 {
		t.Fatalf("unknown fields should be a 400, got %d", code)
	}
	if code, _ := http.Get(s.URL + "/v1/check"); code.StatusCode != 405 {
		t.Fatalf("GET /v1/check should be 405, got %d", code.StatusCode)
	}
}
