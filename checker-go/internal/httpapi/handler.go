// Package httpapi serves the checker over HTTP: POST /v1/round, POST /v1/check, GET /healthz.
package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"timedraft/checker/internal/guidelines"
	"timedraft/checker/internal/rounding"
)

const maxBody = 1 << 20 // 1 MB

type roundRequest struct {
	Items []struct {
		ID      string `json:"id"`
		Seconds int    `json:"seconds"`
	} `json:"items"`
}

type roundItem struct {
	ID     string `json:"id"`
	Tenths int    `json:"tenths"`
	Hours  string `json:"hours"`
}

// New returns the service's handler with request logging.
func New(log *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /v1/round", func(w http.ResponseWriter, r *http.Request) {
		var req roundRequest
		if err := decode(w, r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		out := make([]roundItem, 0, len(req.Items))
		for _, it := range req.Items {
			t, err := rounding.Tenths(it.Seconds)
			if err != nil {
				writeError(w, http.StatusBadRequest, "item "+it.ID+": "+err.Error())
				return
			}
			out = append(out, roundItem{ID: it.ID, Tenths: t, Hours: rounding.Hours(t)})
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": out})
	})
	mux.HandleFunc("POST /v1/check", func(w http.ResponseWriter, r *http.Request) {
		var in guidelines.CheckInput
		if err := decode(w, r, &in); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		flags, err := guidelines.Check(in)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"flags": flags, "checker": "go@1"})
	})
	return logging(log, mux)
}

func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errors.New("invalid JSON body: " + err.Error())
	}
	if dec.More() {
		return errors.New("invalid JSON body: unexpected data after the object")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func logging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 6)
		_, _ = rand.Read(buf)
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(rec, r)
		log.Info("request", "request_id", hex.EncodeToString(buf), "method", r.Method, "path", r.URL.Path, "status", rec.status, "latency_ms", time.Since(start).Milliseconds())
	})
}
