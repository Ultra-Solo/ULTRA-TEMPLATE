package httpapi_test

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/controller/httpapi"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/repo/memory"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/usecase"
)

// FuzzRequestBodiesNeverFailTheServer holds the contract's promise for every body a client can send:
// the answer is a success or a client error, and every answer is JSON. A 5xx would mean a request
// reached code that trusted it. `go test` runs the seeds; `go test -fuzz=FuzzRequestBodies` explores.
func FuzzRequestBodiesNeverFailTheServer(f *testing.F) {
	for _, seed := range []string{
		`{"title":"Write it"}`, `{"title":""}`, `{"title":null}`, `{"title":7}`, `{}`, `[]`, `null`, ``,
		`{"title":"a"} junk`, `{"title":"a"}{"title":"b"}`, `{"status":"done"}`, `{"title":"` + string(rune(0)) + `"}`,
		`{"title":"` + strings.Repeat("é", 201) + `"}`, `{"title":{"nested":true}}`, "\xff\xfe",
	} {
		f.Add(seed)
	}

	tasks := usecase.NewTasks(memory.NewTaskRepository(), time.Now, func() string { return "id-1" })
	router := httpapi.NewRouter(tasks, slog.New(slog.DiscardHandler))

	f.Fuzz(func(t *testing.T, body string) {
		for _, target := range []struct{ method, path string }{
			{http.MethodPost, "/api/tasks"},
			{http.MethodPatch, "/api/tasks/id-1/status"},
		} {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), target.method, target.path, strings.NewReader(body)))

			if recorder.Code >= http.StatusInternalServerError {
				t.Fatalf("%s %s with %q answered %d: %s", target.method, target.path, body, recorder.Code, recorder.Body)
			}
			if !json.Valid(recorder.Body.Bytes()) {
				t.Fatalf("%s %s with %q answered %d with a body that is not JSON: %q", target.method, target.path, body, recorder.Code, recorder.Body)
			}
		}
	})
}
