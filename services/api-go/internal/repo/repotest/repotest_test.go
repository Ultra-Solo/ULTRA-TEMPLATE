package repotest_test

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/entity"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/repo/repotest"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/usecase"
)

// broken is a store with the mistakes a new adapter makes: it lists newest first, answers a missing
// task with an empty one, keeps every task in one variable that all its instances share, and replaces
// a task without checking that it is still the one the caller read.
type broken struct{}

// A mutex, so its mistakes are the ones above and not a data race the race detector reports first.
var (
	sharedMu sync.Mutex
	shared   []entity.Task
)

func (broken) Save(_ context.Context, task entity.Task) error {
	sharedMu.Lock()
	defer sharedMu.Unlock()
	shared = slices.Insert(shared, 0, task)

	return nil
}

func (broken) Get(_ context.Context, id string) (entity.Task, error) {
	sharedMu.Lock()
	defer sharedMu.Unlock()

	for _, task := range shared {
		if task.ID == id {
			return task, nil
		}
	}

	return entity.Task{}, nil
}

func (broken) List(context.Context) ([]entity.Task, error) {
	sharedMu.Lock()
	defer sharedMu.Unlock()

	return slices.Clone(shared), nil
}

func (b broken) Replace(ctx context.Context, task, _ entity.Task) error { return b.Save(ctx, task) }

// The suite must be able to fail, or a store passes it by passing nothing.
func TestTheSuiteFailsABrokenStore(t *testing.T) {
	problems := strings.Join(repotest.Check(t.Context(), func() usecase.TaskRepository { return broken{} }), "\n")
	for _, want := range []string{"a task never saved is not found", "listed oldest first", "two stores share nothing", "an empty store lists nothing", "a replace from a task that is out of date is refused", "of replaces from one version at once, exactly one is made"} {
		if !strings.Contains(problems, want) {
			t.Errorf("the suite did not report %q for a broken store; it reported:\n%s", want, problems)
		}
	}
}
