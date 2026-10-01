package memory_test

import (
	"context"
	"strconv"
	"sync"
	"testing"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/entity"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/repo/memory"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/repo/repotest"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/usecase"
)

// The compiler checks the port is satisfied; a failing build is the test.
var _ usecase.TaskRepository = (*memory.TaskRepository)(nil)

func TestConformance(t *testing.T) {
	t.Parallel()

	repotest.Run(t, func() usecase.TaskRepository { return memory.NewTaskRepository() })
}

// Run with -race, as CI does, to make this test meaningful.
func TestConcurrentSaves(t *testing.T) {
	t.Parallel()

	repo := memory.NewTaskRepository()
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := range 50 {
		wg.Go(func() {
			_ = repo.Save(ctx, entity.Task{ID: strconv.Itoa(i)})
			_, _ = repo.List(ctx)
		})
	}

	wg.Wait()

	if tasks, _ := repo.List(ctx); len(tasks) != 50 {
		t.Fatalf("len = %d, want 50", len(tasks))
	}
}
