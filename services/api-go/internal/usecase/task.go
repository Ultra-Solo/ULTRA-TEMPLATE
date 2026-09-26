// Package usecase holds the application logic. It depends on the entity package and on the ports
// it declares here, never on a concrete store or transport: internal/app chooses the
// implementations that satisfy the ports.
package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/hynix666/ultra-template/services/api-go/internal/entity"
)

// ErrStale is what TaskRepository.Replace returns when the stored task is no longer the one the
// caller read: another change came first.
var ErrStale = errors.New("task changed since it was read")

// TaskRepository is the storage port. Get returns entity.ErrNotFound for a missing task.
type TaskRepository interface {
	Save(ctx context.Context, task entity.Task) error
	Get(ctx context.Context, id string) (entity.Task, error)
	List(ctx context.Context) ([]entity.Task, error)
	// Replace stores task in place of prev only while the stored task is still prev, field for field:
	// ErrStale when it is not, entity.ErrNotFound when there is no such task. In a database it is one
	// conditional UPDATE. It is what makes a move safe when two arrive at once (ADR-0019).
	Replace(ctx context.Context, task, prev entity.Task) error
}

// Tasks implements the task use cases. The clock and the ID source are injected: a use case that
// read the wall clock or a random source itself could not be tested exactly.
type Tasks struct {
	repo  TaskRepository
	now   func() time.Time
	newID func() string
}

// NewTasks wires the use cases to their ports.
func NewTasks(repo TaskRepository, now func() time.Time, newID func() string) *Tasks {
	return &Tasks{repo: repo, now: now, newID: newID}
}

// Create validates and stores a new task.
func (s *Tasks) Create(ctx context.Context, title string) (entity.Task, error) {
	task, err := entity.NewTask(s.newID(), title, s.now())
	if err != nil {
		return entity.Task{}, err
	}

	if err := s.repo.Save(ctx, task); err != nil {
		return entity.Task{}, fmt.Errorf("save task: %w", err)
	}

	return task, nil
}

// Get returns one task.
func (s *Tasks) Get(ctx context.Context, id string) (entity.Task, error) {
	task, err := s.repo.Get(ctx, id)
	if err != nil {
		return entity.Task{}, fmt.Errorf("get task %q: %w", id, err)
	}

	return task, nil
}

// List returns every task, oldest first.
func (s *Tasks) List(ctx context.Context) ([]entity.Task, error) {
	tasks, err := s.repo.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}

	return tasks, nil
}

// Transition moves a task to a new status when the domain allows it, and stores nothing when it
// does not. The move replaces the task it was judged against, or nothing: when another change came
// first it is judged again against the task as that change left it.
func (s *Tasks) Transition(ctx context.Context, id string, next entity.Status) (entity.Task, error) {
	for {
		task, err := s.Get(ctx, id)
		if err != nil {
			return entity.Task{}, err
		}

		moved, err := task.Transition(next, s.now())
		if err != nil {
			return entity.Task{}, err
		}

		err = s.repo.Replace(ctx, moved, task)
		if errors.Is(err, ErrStale) {
			continue
		}

		if err != nil {
			return entity.Task{}, fmt.Errorf("replace task: %w", err)
		}

		return moved, nil
	}
}
