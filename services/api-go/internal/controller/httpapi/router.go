// Package httpapi is the HTTP transport. It decodes requests, calls a use case, and maps the
// outcome — domain errors included — to a response. It holds no business rules.
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/hynix666/ultra-template/services/api-go/internal/entity"
)

// maxBodyBytes bounds a request body; a larger one is refused before it is decoded.
const maxBodyBytes = 1 << 20

// TaskService is what this transport needs from the use case layer, declared where it is consumed.
type TaskService interface {
	Create(ctx context.Context, title string) (entity.Task, error)
	Get(ctx context.Context, id string) (entity.Task, error)
	List(ctx context.Context) ([]entity.Task, error)
	Transition(ctx context.Context, id string, next entity.Status) (entity.Task, error)
}

// NewRouter returns the service's HTTP handler.
func NewRouter(tasks TaskService, log *slog.Logger) http.Handler {
	h := handler{tasks: tasks, log: log}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /api/tasks", h.list)
	mux.HandleFunc("POST /api/tasks", h.create)
	mux.HandleFunc("GET /api/tasks/{id}", h.get)
	mux.HandleFunc("PATCH /api/tasks/{id}/status", h.transition)

	// Left to itself the mux answers a wrong method or an unknown path in plain text, while every
	// other error this API returns is JSON. A pattern with a method wins over the same pattern
	// without one, so these catch only what the routes above do not.
	for _, path := range []string{"/healthz", "/api/tasks", "/api/tasks/{id}", "/api/tasks/{id}/status"} {
		mux.HandleFunc(path, methodNotAllowed)
	}
	mux.HandleFunc("/", notFound)

	return mux
}

type handler struct {
	tasks TaskService
	log   *slog.Logger
}

type taskResponse struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func toResponse(task entity.Task) taskResponse {
	return taskResponse{
		ID:        task.ID,
		Title:     task.Title,
		Status:    string(task.Status),
		CreatedAt: task.CreatedAt,
		UpdatedAt: task.UpdatedAt,
	}
}

func (h handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h handler) list(w http.ResponseWriter, r *http.Request) {
	tasks, err := h.tasks.List(r.Context())
	if err != nil {
		h.fail(w, r, err)

		return
	}

	body := make([]taskResponse, 0, len(tasks))
	for _, task := range tasks {
		body = append(body, toResponse(task))
	}

	writeJSON(w, http.StatusOK, body)
}

func (h handler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}

	if !decode(w, r, &body) {
		return
	}

	task, err := h.tasks.Create(r.Context(), body.Title)
	if err != nil {
		h.fail(w, r, err)

		return
	}

	writeJSON(w, http.StatusCreated, toResponse(task))
}

func (h handler) get(w http.ResponseWriter, r *http.Request) {
	task, err := h.tasks.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)

		return
	}

	writeJSON(w, http.StatusOK, toResponse(task))
}

func (h handler) transition(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"`
	}

	if !decode(w, r, &body) {
		return
	}

	status, err := entity.ParseStatus(body.Status)
	if err != nil {
		h.fail(w, r, err)

		return
	}

	task, err := h.tasks.Transition(r.Context(), r.PathValue("id"), status)
	if err != nil {
		h.fail(w, r, err)

		return
	}

	writeJSON(w, http.StatusOK, toResponse(task))
}

// errNotOneObject rejects bodies that are valid JSON but not exactly one object: `null`, which decodes
// into a struct without error, and anything after the object, which a Decoder never reads. api-ts
// and api-py refuse both, and every task service must answer alike.
var errNotOneObject = errors.New("request body must be exactly one JSON object")

// decode reads a size-bounded JSON object, rejecting unknown fields, and writes the error response
// itself when it cannot.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err == nil {
		err = decodeObject(raw, dst)
	}

	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "request body must be a JSON object with only the documented fields"})

		return false
	}

	return true
}

func decodeObject(raw []byte, dst any) error {
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || trimmed[0] != '{' {
		return errNotOneObject
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		return fmt.Errorf("decode request body: %w", err)
	}

	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errNotOneObject
	}

	return nil
}

// fail maps domain errors to status codes. An unrecognised error is a 500: its detail is logged and
// never returned to the client.
func (h handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, entity.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errorResponse{Error: entity.ErrNotFound.Error()})
	case errors.Is(err, entity.ErrEmptyTitle), errors.Is(err, entity.ErrTitleTooLong), errors.Is(err, entity.ErrUnknownStatus):
		writeJSON(w, http.StatusUnprocessableEntity, errorResponse{Error: err.Error()})
	case errors.Is(err, entity.ErrInvalidTransition):
		writeJSON(w, http.StatusConflict, errorResponse{Error: err.Error()})
	default:
		h.log.ErrorContext(r.Context(), "request failed", "method", r.Method, "path", r.URL.Path, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal error"})
	}
}

func methodNotAllowed(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusMethodNotAllowed, errorResponse{Error: "method not allowed"})
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, errorResponse{Error: "not found"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// The status line is already sent, so a failed write has no one left to report to.
	_ = json.NewEncoder(w).Encode(body)
}
