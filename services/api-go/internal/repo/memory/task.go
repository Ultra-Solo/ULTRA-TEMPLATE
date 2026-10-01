// Package memory is an in-process implementation of usecase.TaskRepository. It is the store the
// service starts with and the reference behaviour any other store must match; it forgets
// everything on restart.
package memory

import (
	"context"
	"sync"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/entity"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/usecase"
)

// TaskRepository keeps tasks in insertion order behind a read-write mutex.
type TaskRepository struct {
	mu    sync.RWMutex
	tasks map[string]entity.Task
	order []string
}

// NewTaskRepository returns an empty repository.
func NewTaskRepository() *TaskRepository {
	return &TaskRepository{tasks: make(map[string]entity.Task)}
}

// Save inserts a task, or replaces the task with the same ID.
func (r *TaskRepository) Save(_ context.Context, task entity.Task) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.tasks[task.ID]; !exists {
		r.order = append(r.order, task.ID)
	}

	r.tasks[task.ID] = task

	return nil
}

// Replace stores task in place of prev, only while the stored task is still prev.
func (r *TaskRepository) Replace(_ context.Context, task, prev entity.Task) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	stored, ok := r.tasks[prev.ID]
	if !ok {
		return entity.ErrNotFound
	}

	if !same(stored, prev) {
		return usecase.ErrStale
	}

	r.tasks[prev.ID] = task

	return nil
}

// same compares tasks field for field, times as instants, as a database compares stored values.
func same(a, b entity.Task) bool {
	return a.ID == b.ID && a.Title == b.Title && a.Status == b.Status && a.CreatedAt.Equal(b.CreatedAt) && a.UpdatedAt.Equal(b.UpdatedAt)
}

// Get returns entity.ErrNotFound when no task has the ID.
func (r *TaskRepository) Get(_ context.Context, id string) (entity.Task, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	task, ok := r.tasks[id]
	if !ok {
		return entity.Task{}, entity.ErrNotFound
	}

	return task, nil
}

// List returns every task, oldest first.
func (r *TaskRepository) List(_ context.Context) ([]entity.Task, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	tasks := make([]entity.Task, 0, len(r.order))
	for _, id := range r.order {
		tasks = append(tasks, r.tasks[id])
	}

	return tasks, nil
}
