package httpapi_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hynix666/ultra-template/services/api-go/internal/controller/httpapi"
	"github.com/hynix666/ultra-template/services/api-go/internal/repo/memory"
	"github.com/hynix666/ultra-template/services/api-go/internal/usecase"
)

type task struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// newServer wires the real use cases and store: a test file may cross the layer rules that
// production code may not.
func newServer(t *testing.T) *httptest.Server {
	t.Helper()

	tasks := usecase.NewTasks(memory.NewTaskRepository(), time.Now, func() string { return "id-1" })
	server := httptest.NewServer(httpapi.NewRouter(tasks, slog.New(slog.DiscardHandler)))
	t.Cleanup(server.Close)

	return server
}

func do(t *testing.T, server *httptest.Server, method, path, body string) (int, string) {
	t.Helper()

	req, err := http.NewRequestWithContext(t.Context(), method, server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}

	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}

	raw, err := io.ReadAll(res.Body)
	_ = res.Body.Close()

	if err != nil {
		t.Fatal(err)
	}

	return res.StatusCode, string(raw)
}

func TestTaskLifecycle(t *testing.T) {
	t.Parallel()

	server := newServer(t)

	if status, body := do(t, server, http.MethodPost, "/api/tasks", `{"title":"ship it"}`); status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}

	status, body := do(t, server, http.MethodGet, "/api/tasks", "")

	var tasks []task
	if err := json.Unmarshal([]byte(body), &tasks); err != nil || status != http.StatusOK || len(tasks) != 1 || tasks[0].Status != "todo" {
		t.Fatalf("list = %d %s (%v)", status, body, err)
	}

	if status, body := do(t, server, http.MethodPatch, "/api/tasks/id-1/status", `{"status":"done"}`); status != http.StatusConflict {
		t.Fatalf("todo to done = %d %s, want 409", status, body)
	}

	if status, body := do(t, server, http.MethodPatch, "/api/tasks/id-1/status", `{"status":"in_progress"}`); status != http.StatusOK {
		t.Fatalf("todo to in_progress = %d %s", status, body)
	}
}

func TestEveryErrorIsJSONIncludingTheRoutersOwn(t *testing.T) {
	t.Parallel()

	server := newServer(t)

	// The mux answers these itself; left alone it would answer in plain text.
	for _, tt := range []struct{ method, path string }{
		{http.MethodPost, "/healthz"},
		{http.MethodDelete, "/api/tasks"},
		{http.MethodPut, "/api/tasks/id-1"},
		{http.MethodGet, "/api/tasks/id-1/status"},
		{http.MethodGet, "/api"},
		{http.MethodGet, "/api/tasks/"},
	} {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			t.Parallel()

			status, body := do(t, server, tt.method, tt.path, "")
			var decoded struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal([]byte(body), &decoded); err != nil || decoded.Error == "" {
				t.Fatalf("%d body %q is not a JSON error", status, body)
			}
		})
	}

	// HEAD is answered wherever GET is, as HTTP requires.
	if status, _ := do(t, server, http.MethodHead, "/healthz", ""); status != http.StatusOK {
		t.Fatalf("HEAD /healthz = %d, want 200", status)
	}
}

func TestRequestsAreValidatedAtTheBoundary(t *testing.T) {
	t.Parallel()

	server := newServer(t)

	tests := []struct {
		name, method, path, body string
		want                     int
	}{
		{"health", http.MethodGet, "/healthz", "", http.StatusOK},
		{"blank title", http.MethodPost, "/api/tasks", `{"title":" "}`, http.StatusUnprocessableEntity},
		{"unknown field", http.MethodPost, "/api/tasks", `{"title":"x","admin":true}`, http.StatusBadRequest},
		{"not JSON", http.MethodPost, "/api/tasks", `title=x`, http.StatusBadRequest},
		{"null body", http.MethodPost, "/api/tasks", `null`, http.StatusBadRequest},
		{"data after the object", http.MethodPost, "/api/tasks", `{"title":"x"} junk`, http.StatusBadRequest},
		{"two objects", http.MethodPost, "/api/tasks", `{"title":"x"}{"title":"y"}`, http.StatusBadRequest},
		{"oversized body", http.MethodPost, "/api/tasks", `{"title":"` + strings.Repeat("x", 2<<20) + `"}`, http.StatusBadRequest},
		{"unknown status", http.MethodPatch, "/api/tasks/id-1/status", `{"status":"DONE"}`, http.StatusUnprocessableEntity},
		{"missing task", http.MethodGet, "/api/tasks/nope", "", http.StatusNotFound},
		{"wrong method", http.MethodDelete, "/api/tasks", "", http.StatusMethodNotAllowed},
		// Field names match exactly, where encoding/json alone would take "Title" for "title".
		{"title with capitals", http.MethodPost, "/api/tasks", `{"Title":"x"}`, http.StatusBadRequest},
		{"status with capitals", http.MethodPatch, "/api/tasks/id-1/status", `{"Status":"done"}`, http.StatusBadRequest},
		// JSON is UTF-8 (RFC 8259, section 8.1); encoding/json alone would read the byte as U+FFFD.
		{"not UTF-8", http.MethodPost, "/api/tasks", "{\"title\":\"\xff\"}", http.StatusBadRequest},
		{"status not a string", http.MethodPatch, "/api/tasks/id-1/status", `{"status":7}`, http.StatusBadRequest},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if status, body := do(t, server, tt.method, tt.path, tt.body); status != tt.want {
				t.Fatalf("status = %d %s, want %d", status, body, tt.want)
			}
		})
	}
}

// A 405 must say what the path does allow (RFC 9110, section 15.5.6), HEAD wherever GET is.
func TestAWrongMethodNamesTheMethodsThePathAllows(t *testing.T) {
	t.Parallel()

	server := newServer(t)

	tests := []struct{ method, path, allow string }{
		{http.MethodPost, "/healthz", "GET, HEAD"},
		{http.MethodDelete, "/api/tasks", "GET, HEAD, POST"},
		{http.MethodPut, "/api/tasks/id-1", "GET, HEAD"},
		{http.MethodGet, "/api/tasks/id-1/status", "PATCH"},
	}

	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			t.Parallel()

			req, err := http.NewRequestWithContext(t.Context(), tt.method, server.URL+tt.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			res, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			_ = res.Body.Close()
			if res.StatusCode != http.StatusMethodNotAllowed || res.Header.Get("Allow") != tt.allow {
				t.Fatalf("%d with Allow %q, want 405 with %q", res.StatusCode, res.Header.Get("Allow"), tt.allow)
			}
		})
	}
}
