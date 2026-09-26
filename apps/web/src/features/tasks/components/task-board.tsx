import { useEffect, useState, type FormEvent } from "react";
import { createTask, listTasks, moveTask } from "../api.ts";
import { LABELS, nextStatuses, type Status, type Task } from "../model.ts";

export function TaskBoard() {
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<void>): void {
    setError(null);
    action().catch((err: unknown) => setError(message(err)));
  }

  async function refresh(): Promise<void> {
    setTasks(await listTasks());
  }

  // The first load depends on nothing that changes between renders, so it runs once. An answer that
  // arrives after the board is gone is dropped rather than set on an unmounted component.
  useEffect(() => {
    let current = true;
    listTasks()
      .then((loaded) => current && setTasks(loaded))
      .catch((err: unknown) => current && setError(message(err)));
    return () => {
      current = false;
    };
  }, []);

  function create(event: FormEvent): void {
    event.preventDefault();
    run(async () => {
      await createTask(title);
      setTitle("");
      await refresh();
    });
  }

  function move(task: Task, status: Status): void {
    run(async () => {
      await moveTask(task.id, status);
      await refresh();
    });
  }

  return (
    <section>
      <form onSubmit={create}>
        <input
          aria-label="Task title"
          // No maxLength: the browser counts UTF-16 units, so it would refuse a title of astral characters
          // the API takes. The API checks the length and the board shows its reason.
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs doing?"
          value={title}
        />
        <button type="submit">Add</button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <span>{task.title}</span>
            <em>{LABELS[task.status]}</em>
            {nextStatuses(task.status).map((status) => (
              <button key={status} onClick={() => move(task, status)} type="button">
                {LABELS[status]}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
