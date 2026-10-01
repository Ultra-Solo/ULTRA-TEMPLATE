package httpapi_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/controller/httpapi"
)

// logged runs one request through the middleware with a clock that advances 1.5 ms per reading, and
// returns the response and the one log line it wrote.
func logged(t *testing.T, sentID string, status int) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()

	var out bytes.Buffer

	log := slog.New(slog.NewJSONHandler(&out, nil))
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	readings := 0
	now := func() time.Time {
		readings++

		return start.Add(time.Duration(readings) * 1500 * time.Microsecond)
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })

	req := httptest.NewRequestWithContext(t.Context(), http.MethodPatch, "/api/tasks/t1/status?x=secret", nil)
	if sentID != "" {
		req.Header.Set(httpapi.RequestIDHeader, sentID)
	}

	res := httptest.NewRecorder()
	httpapi.WithRequestLog(inner, log, now, func() string { return "generated-1" }).ServeHTTP(res, req)

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("want one log line, got %d: %q", len(lines), out.String())
	}

	var line map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &line); err != nil {
		t.Fatal(err)
	}

	return res, line
}

func TestRequestLogEchoesAUsableIDAndLogsOneLine(t *testing.T) {
	t.Parallel()

	res, line := logged(t, "abc-123.X_y", http.StatusConflict)
	if got := res.Header().Get(httpapi.RequestIDHeader); got != "abc-123.X_y" {
		t.Fatalf("header = %q, want the id that was sent", got)
	}

	want := map[string]any{"msg": "request", "method": "PATCH", "path": "/api/tasks/t1/status", "status": 409.0, "durationMs": 1.5, "requestId": "abc-123.X_y"}
	for key, value := range want {
		if line[key] != value {
			t.Errorf("%s = %v, want %v", key, line[key], value)
		}
	}
}

func TestRequestLogReplacesAMissingOrUnsafeID(t *testing.T) {
	t.Parallel()

	for _, sent := range []string{"", "has space", "new\nline", strings.Repeat("a", 129)} {
		res, line := logged(t, sent, http.StatusOK)
		if got := res.Header().Get(httpapi.RequestIDHeader); got != "generated-1" {
			t.Errorf("sent %q: header = %q, want a generated id", sent, got)
		}

		if line["requestId"] != "generated-1" {
			t.Errorf("sent %q: logged id = %v", sent, line["requestId"])
		}
	}
}

func TestRequestLogRecordsTheStatusOfAnImplicitWrite(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer

	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	handler := httpapi.WithRequestLog(inner, slog.New(slog.NewJSONHandler(&out, nil)), time.Now, func() string { return "id" })
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/healthz", nil))

	if !strings.Contains(out.String(), `"status":200`) {
		t.Fatalf("log = %s, want status 200", out.String())
	}
}
