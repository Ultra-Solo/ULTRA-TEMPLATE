import type { Task } from "../domain/task.ts";

/** Storage port. `get` resolves to undefined for a missing task; the service decides what that means. */
export interface TaskRepository {
  save(task: Task): Promise<void>;
  get(id: string): Promise<Task | undefined>;
  list(): Promise<readonly Task[]>;
  /**
   * Stores `task` in place of `prev` only while the stored task is still `prev`, field for field, and
   * resolves to whether it did: false when another change came first or there is no such task. In a
   * database it is one conditional UPDATE. It is what makes a move safe when two arrive at once (ADR-0019).
   */
  replace(task: Task, prev: Task): Promise<boolean>;
}

/** The clock is a port: a service that read the wall clock itself could not be tested exactly. */
export interface Clock {
  now(): string;
}

/** So is the id source, for the same reason. */
export interface IdGenerator {
  next(): string;
}
