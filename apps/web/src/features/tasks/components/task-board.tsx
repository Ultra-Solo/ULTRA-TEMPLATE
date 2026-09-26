import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createTask, listTasks, moveTask } from "../api.ts";
import { LABELS, nextStatuses, type Status, type Task } from "../model.ts";

export function TaskBoard() {
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Read and set in the same event, where state would still hold the previous render's value: a second
  // submit before the first re-renders must see the first.
  const busy = useRef(false);
  // Each load is numbered, and only the newest may set the list: an older answer that arrives late
  // would show the board as it was before a move.
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const load = ++latest.current;
    try {
      const loaded = await listTasks();
      if (load === latest.current) setTasks(loaded);
    } catch (err: unknown) {
      if (load === latest.current) setError(message(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    // A load still out when the board goes is no longer the newest, so its answer is dropped.
    return () => {
      latest.current++;
    };
  }, [reload]);

  /** One change at a time; the list is reloaded after it whether it worked or not, since either way it may be out of date. */
  function change(action: () => Promise<void>): void {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    action()
      .catch((err: unknown) => setError(message(err)))
      .finally(() => {
        busy.current = false;
        setPending(false);
        void reload();
      });
  }

  function create(event: FormEvent): void {
    event.preventDefault();
    change(async () => {
      await createTask(title);
      setTitle("");
    });
  }

  function move(task: Task, status: Status): void {
    change(() => moveTask(task.id, status));
  }

  return (
    <section>
      <form onSubmit={create}>
        <input
          aria-label="Task title"
          disabled={pending}
          // No maxLength: the browser counts UTF-16 units, so it would refuse a title of astral characters
          // the API takes. The API checks the length and the board shows its reason.
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs doing?"
          value={title}
        />
        <button disabled={pending} type="submit">
          Add
        </button>
      </form>
      {error !== null && <p role="alert">{error}</p>}
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <span>{task.title}</span>
            <em>{LABELS[task.status]}</em>
            {nextStatuses(task.status).map((status) => (
              <button disabled={pending} key={status} onClick={() => move(task, status)} type="button">
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
