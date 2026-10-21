package entity_test

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/entity"
)

var now = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

func TestNewTask(t *testing.T) {
	t.Parallel()

	longest := strings.Repeat("é", entity.MaxTitleLength)

	tests := []struct {
		name    string
		title   string
		want    string
		wantErr error
	}{
		{name: "trims surrounding whitespace", title: "  write docs  ", want: "write docs"},
		{name: "rejects a blank title", title: "   ", wantErr: entity.ErrEmptyTitle},
		{name: "counts characters, not bytes", title: longest, want: longest},
		{name: "rejects one character too many", title: longest + "é", wantErr: entity.ErrTitleTooLong},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			task, err := entity.NewTask("id-1", tt.title, now)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error = %v, want %v", err, tt.wantErr)
			}

			if err == nil && (task.Title != tt.want || task.Status != entity.StatusTodo || !task.CreatedAt.Equal(now)) {
				t.Fatalf("task = %+v, want title %q in todo created at %v", task, tt.want, now)
			}
		})
	}
}

func TestNewTaskTrimsTheWhiteSpacePropertyAndNothingElse(t *testing.T) {
	t.Parallel()

	// The escapes stand for the characters themselves, so no invisible one is
	// ever written into this file. U+0085, U+3000, U+2029 and U+00A0 are
	// White_Space; U+001C to U+001F and U+FEFF are not, but Python's strip and
	// JavaScript's trim take them, which is how the services once differed.
	tests := []struct {
		name    string
		title   string
		want    string
		wantErr error
	}{
		{name: "trims the White_Space property from both sides", title: "\u0085\u3000a\u2029", want: "a"},
		{name: "keeps what a wider trim would also take, which is not White_Space", title: "\u001fa\ufeff", want: "\u001fa\ufeff"},
		{name: "refuses a title of only White_Space", title: "\u0085\u00a0", wantErr: entity.ErrEmptyTitle},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			task, err := entity.NewTask("id-1", tt.title, now)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error = %v, want %v", err, tt.wantErr)
			}

			if err == nil && task.Title != tt.want {
				t.Fatalf("title = %q, want %q", task.Title, tt.want)
			}
		})
	}
}

func TestTransition(t *testing.T) {
	t.Parallel()

	tests := []struct {
		from, to entity.Status
		allowed  bool
	}{
		{entity.StatusTodo, entity.StatusInProgress, true},
		{entity.StatusTodo, entity.StatusDone, false},
		{entity.StatusTodo, entity.StatusTodo, false},
		{entity.StatusInProgress, entity.StatusDone, true},
		{entity.StatusInProgress, entity.StatusTodo, true},
		{entity.StatusDone, entity.StatusTodo, false},
		{entity.StatusDone, entity.StatusInProgress, false},
	}

	for _, tt := range tests {
		t.Run(string(tt.from)+" to "+string(tt.to), func(t *testing.T) {
			t.Parallel()

			task := entity.Task{ID: "id-1", Title: "x", Status: tt.from, CreatedAt: now, UpdatedAt: now}
			later := now.Add(time.Minute)

			got, err := task.Transition(tt.to, later)
			if !tt.allowed {
				if !errors.Is(err, entity.ErrInvalidTransition) {
					t.Fatalf("error = %v, want ErrInvalidTransition", err)
				}

				return
			}

			if err != nil || got.Status != tt.to || !got.UpdatedAt.Equal(later) || !got.CreatedAt.Equal(now) {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
}

func TestParseStatus(t *testing.T) {
	t.Parallel()

	if got, err := entity.ParseStatus("in_progress"); err != nil || got != entity.StatusInProgress {
		t.Fatalf("ParseStatus(in_progress) = %q, %v", got, err)
	}

	if _, err := entity.ParseStatus("DONE"); !errors.Is(err, entity.ErrUnknownStatus) {
		t.Fatalf("ParseStatus(DONE) error = %v, want ErrUnknownStatus", err)
	}
}

func TestTitleTooLongStatesTheLimit(t *testing.T) {
	t.Parallel()

	if limit := strconv.Itoa(entity.MaxTitleLength); !strings.Contains(entity.ErrTitleTooLong.Error(), limit) {
		t.Fatalf("ErrTitleTooLong = %q, want it to state the limit %s", entity.ErrTitleTooLong, limit)
	}
}
