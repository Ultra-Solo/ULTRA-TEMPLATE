package usecase_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hynix666/ultra-template/services/api-go/internal/entity"
	"github.com/hynix666/ultra-template/services/api-go/internal/usecase"
)

var (
	clock   = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	errDisk = errors.New("disk full")
)

type fakeRepo struct {
	tasks   map[string]entity.Task
	saveErr error
	saves   int
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{tasks: map[string]entity.Task{}}
}

func (r *fakeRepo) Save(_ context.Context, task entity.Task) error {
	if r.saveErr != nil {
		return r.saveErr
	}

	r.saves++
	r.tasks[task.ID] = task

	return nil
}

func (r *fakeRepo) Replace(_ context.Context, task, prev entity.Task) error {
	if r.saveErr != nil {
		return r.saveErr
	}

	if r.tasks[prev.ID] != prev {
		return usecase.ErrStale
	}

	r.saves++
	r.tasks[task.ID] = task

	return nil
}

func (r *fakeRepo) Get(_ context.Context, id string) (entity.Task, error) {
	task, ok := r.tasks[id]
	if !ok {
		return entity.Task{}, entity.ErrNotFound
	}

	return task, nil
}

func (r *fakeRepo) List(context.Context) ([]entity.Task, error) {
	tasks := make([]entity.Task, 0, len(r.tasks))
	for _, task := range r.tasks {
		tasks = append(tasks, task)
	}

	return tasks, nil
}

func newTasks(repo *fakeRepo) *usecase.Tasks {
	return usecase.NewTasks(repo, func() time.Time { return clock }, func() string { return "id-1" })
}

func TestCreateStoresAValidTask(t *testing.T) {
	t.Parallel()

	repo := newFakeRepo()

	task, err := newTasks(repo).Create(context.Background(), "ship it")
	if err != nil {
		t.Fatal(err)
	}

	if task.ID != "id-1" || !task.CreatedAt.Equal(clock) || repo.tasks["id-1"] != task {
		t.Fatalf("task = %+v, stored = %+v", task, repo.tasks)
	}
}

func TestCreateRefusesAnInvalidTitleWithoutSaving(t *testing.T) {
	t.Parallel()

	repo := newFakeRepo()

	if _, err := newTasks(repo).Create(context.Background(), " "); !errors.Is(err, entity.ErrEmptyTitle) {
		t.Fatalf("error = %v, want ErrEmptyTitle", err)
	}

	if repo.saves != 0 {
		t.Fatalf("saves = %d, want 0", repo.saves)
	}
}

func TestCreateWrapsAStorageFailure(t *testing.T) {
	t.Parallel()

	repo := newFakeRepo()
	repo.saveErr = errDisk

	if _, err := newTasks(repo).Create(context.Background(), "ship it"); !errors.Is(err, errDisk) {
		t.Fatalf("error = %v, want it to wrap %v", err, errDisk)
	}
}

func TestGetOfAMissingTaskIsNotFound(t *testing.T) {
	t.Parallel()

	if _, err := newTasks(newFakeRepo()).Get(context.Background(), "nope"); !errors.Is(err, entity.ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
}

func TestTransitionStoresOnlyAllowedMoves(t *testing.T) {
	t.Parallel()

	repo := newFakeRepo()
	tasks := newTasks(repo)
	ctx := context.Background()

	if _, err := tasks.Create(ctx, "ship it"); err != nil {
		t.Fatal(err)
	}

	if _, err := tasks.Transition(ctx, "id-1", entity.StatusDone); !errors.Is(err, entity.ErrInvalidTransition) {
		t.Fatalf("todo to done: error = %v, want ErrInvalidTransition", err)
	}

	if repo.saves != 1 || repo.tasks["id-1"].Status != entity.StatusTodo {
		t.Fatalf("a refused transition was stored: %+v", repo.tasks["id-1"])
	}

	moved, err := tasks.Transition(ctx, "id-1", entity.StatusInProgress)
	if err != nil || moved.Status != entity.StatusInProgress || repo.tasks["id-1"] != moved {
		t.Fatalf("todo to in_progress: %+v, %v", moved, err)
	}
}

// racingRepo lets the first `readers` reads of a task happen before any of them returns, which is how
// two moves at once interleave on a real server: both read the task, then both write.
type racingRepo struct {
	mu      sync.Mutex
	tasks   map[string]entity.Task
	arrived sync.WaitGroup
	gated   atomic.Int32
}

func newRacingRepo() *racingRepo {
	return &racingRepo{tasks: map[string]entity.Task{}}
}

func (r *racingRepo) Save(_ context.Context, task entity.Task) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tasks[task.ID] = task

	return nil
}

func (r *racingRepo) Replace(_ context.Context, task, prev entity.Task) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.tasks[prev.ID] != prev {
		return usecase.ErrStale
	}

	r.tasks[task.ID] = task

	return nil
}

func (r *racingRepo) Get(_ context.Context, id string) (entity.Task, error) {
	r.mu.Lock()
	task, ok := r.tasks[id]
	r.mu.Unlock()

	if r.gated.Add(-1) >= 0 {
		r.arrived.Done()
		r.arrived.Wait()
	}

	if !ok {
		return entity.Task{}, entity.ErrNotFound
	}

	return task, nil
}

func (r *racingRepo) List(context.Context) ([]entity.Task, error) { return nil, nil }

// Two moves that both read the task before either writes: only one may be made, and the other is
// judged against the task as the first left it.
func TestOfTwoMovesAtOnceExactlyOneIsMade(t *testing.T) {
	t.Parallel()

	repo := newRacingRepo()
	tasks := usecase.NewTasks(repo, func() time.Time { return clock }, func() string { return "id-1" })
	ctx := context.Background()

	if _, err := tasks.Create(ctx, "ship it"); err != nil {
		t.Fatal(err)
	}

	if _, err := tasks.Transition(ctx, "id-1", entity.StatusInProgress); err != nil {
		t.Fatal(err)
	}

	repo.arrived.Add(2)
	repo.gated.Store(2)

	errs := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := tasks.Transition(ctx, "id-1", entity.StatusDone)
			errs <- err
		}()
	}

	var made, refused int
	for range 2 {
		switch err := <-errs; {
		case err == nil:
			made++
		case errors.Is(err, entity.ErrInvalidTransition):
			refused++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}

	if made != 1 || refused != 1 {
		t.Fatalf("%d moves made and %d refused, want 1 and 1", made, refused)
	}
}
