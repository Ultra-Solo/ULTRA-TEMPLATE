// Package repotest is the conformance suite for usecase.TaskRepository: the behaviour the service
// relies on from any store. The in-memory store passes it, and a store that replaces it, such as a
// database adapter, runs the same suite against a fresh database of its own: passing is what makes it
// a replacement rather than a rewrite.
package repotest

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/hynix666/ultra-template/services/api-go/internal/entity"
	"github.com/hynix666/ultra-template/services/api-go/internal/usecase"
)

// Run reports every way the stores newRepo returns differ from the port's contract as a test failure.
// Each call to newRepo must return an empty store that shares nothing with the others.
func Run(t *testing.T, newRepo func() usecase.TaskRepository) {
	t.Helper()

	for _, problem := range Check(t.Context(), newRepo) {
		t.Error(problem)
	}
}

// Check runs every case against stores newRepo returns and says how they differ from the contract.
func Check(ctx context.Context, newRepo func() usecase.TaskRepository) []string {
	var problems []string

	for _, c := range cases {
		if err := c.run(ctx, newRepo); err != nil {
			problems = append(problems, c.name+": "+err.Error())
		}
	}

	return problems
}

var errFound = errors.New("want entity.ErrNotFound")

// notFound is nil when err is entity.ErrNotFound, and otherwise says what happened instead.
func notFound(err error, found string) error {
	switch {
	case errors.Is(err, entity.ErrNotFound):
		return nil
	case err == nil:
		return fmt.Errorf("%s: %w", found, errFound)
	default:
		return fmt.Errorf("%w, got %w", errFound, err)
	}
}

var at = time.Date(2026, 1, 2, 3, 4, 5, 6, time.UTC)

func task(id, title string) entity.Task {
	return entity.Task{ID: id, Title: title, Status: entity.StatusTodo, CreatedAt: at, UpdatedAt: at.Add(time.Second)}
}

var cases = []struct {
	name string
	run  func(context.Context, func() usecase.TaskRepository) error
}{
	{"a saved task is got back as it was saved", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		repo := newRepo()
		want := task("a", "first")

		if err := repo.Save(ctx, want); err != nil {
			return err
		}

		got, err := repo.Get(ctx, want.ID)
		if err != nil {
			return err
		}

		if got.ID != want.ID || got.Title != want.Title || got.Status != want.Status || !got.CreatedAt.Equal(want.CreatedAt) || !got.UpdatedAt.Equal(want.UpdatedAt) {
			return fmt.Errorf("got %+v, saved %+v", got, want)
		}

		return nil
	}},
	{"a task never saved is not found", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		_, err := newRepo().Get(ctx, "missing")

		return notFound(err, "found a task that was never saved")
	}},
	{"an empty store lists nothing", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		tasks, err := newRepo().List(ctx)
		if err != nil {
			return err
		}

		if len(tasks) != 0 {
			return fmt.Errorf("listed %d tasks", len(tasks))
		}

		return nil
	}},
	{"tasks are listed oldest first, and a task saved again keeps its place", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		repo := newRepo()
		for _, saved := range []entity.Task{task("a", "first"), task("b", "second"), task("c", "third"), task("a", "first, renamed")} {
			if err := repo.Save(ctx, saved); err != nil {
				return err
			}
		}

		tasks, err := repo.List(ctx)
		if err != nil {
			return err
		}

		var listed []string
		for _, listedTask := range tasks {
			listed = append(listed, listedTask.ID+"="+listedTask.Title)
		}

		if fmt.Sprint(listed) != "[a=first, renamed b=second c=third]" {
			return fmt.Errorf("listed %v, want a (renamed), b, c", listed)
		}

		return nil
	}},
	{"a replace from the stored task stores the new one", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		repo := newRepo()
		first := task("a", "first")
		moved := first
		moved.Status, moved.UpdatedAt = entity.StatusInProgress, at.Add(time.Minute)

		if err := repo.Save(ctx, first); err != nil {
			return err
		}

		if err := repo.Replace(ctx, moved, first); err != nil {
			return err
		}

		got, err := repo.Get(ctx, "a")
		if err != nil {
			return err
		}

		if got.Status != moved.Status || !got.UpdatedAt.Equal(moved.UpdatedAt) {
			return fmt.Errorf("got %+v after replacing it with %+v", got, moved)
		}

		return nil
	}},
	{"a replace from a task that is out of date is refused", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		repo := newRepo()
		first := task("a", "first")
		moved, other := first, first
		moved.Status, moved.UpdatedAt = entity.StatusInProgress, at.Add(time.Minute)
		other.Title = "changed meanwhile"

		if err := repo.Save(ctx, first); err != nil {
			return err
		}

		if err := repo.Replace(ctx, moved, first); err != nil {
			return err
		}

		if err := repo.Replace(ctx, other, first); !errors.Is(err, usecase.ErrStale) {
			return fmt.Errorf("replacing from a task that has changed since: %w, want usecase.ErrStale", err)
		}

		got, err := repo.Get(ctx, "a")
		if err != nil {
			return err
		}

		if got.Title != first.Title || got.Status != moved.Status {
			return fmt.Errorf("a refused replace changed the task: %+v", got)
		}

		return nil
	}},
	{"a replace of a task never saved is not found", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		missing := task("missing", "never saved")

		return notFound(newRepo().Replace(ctx, missing, missing), "replaced a task that was never saved")
	}},
	{"of replaces from one version at once, exactly one is made", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		repo := newRepo()
		first := task("a", "first")

		if err := repo.Save(ctx, first); err != nil {
			return err
		}

		const racers = 16

		results := make(chan error, racers)
		for n := range racers {
			go func() {
				moved := first
				moved.Title = fmt.Sprintf("replace %d", n)
				results <- repo.Replace(ctx, moved, first)
			}()
		}

		made := 0
		for range racers {
			switch err := <-results; {
			case err == nil:
				made++
			case !errors.Is(err, usecase.ErrStale):
				return err
			}
		}

		if made != 1 {
			return fmt.Errorf("%d of %d replaces from the same version were made, want 1", made, racers)
		}

		return nil
	}},
	{"two stores share nothing", func(ctx context.Context, newRepo func() usecase.TaskRepository) error {
		first, second := newRepo(), newRepo()
		if err := first.Save(ctx, task("a", "only in the first")); err != nil {
			return err
		}

		_, err := second.Get(ctx, "a")

		return notFound(err, "the second store finds a task saved in the first")
	}},
}
