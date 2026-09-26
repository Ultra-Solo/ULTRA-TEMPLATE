import { createTask, DomainError, transition, type Status, type Task } from "../domain/task.ts";
import type { Clock, IdGenerator, TaskRepository } from "./ports.ts";

export interface TaskServiceDeps {
  readonly repository: TaskRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The use cases. Depends on the domain and on ports, never on an adapter: src/main.ts chooses those. */
export class TaskService {
  readonly #deps: TaskServiceDeps;

  constructor(deps: TaskServiceDeps) {
    this.#deps = deps;
  }

  async create(title: string): Promise<Task> {
    const task = createTask(this.#deps.ids.next(), title, this.#deps.clock.now());
    await this.#deps.repository.save(task);
    return task;
  }

  async get(id: string): Promise<Task> {
    const task = await this.#deps.repository.get(id);
    if (task === undefined) throw new DomainError("NOT_FOUND", "task not found");
    return task;
  }

  list(): Promise<readonly Task[]> {
    return this.#deps.repository.list();
  }

  /**
   * Stores nothing when the domain refuses the move. The move replaces the task it was judged against,
   * or nothing: when another change came first it is judged again against the task as that change left it.
   */
  async transition(id: string, next: Status): Promise<Task> {
    for (;;) {
      const current = await this.get(id);
      const moved = transition(current, next, this.#deps.clock.now());
      if (await this.#deps.repository.replace(moved, current)) return moved;
    }
  }
}
