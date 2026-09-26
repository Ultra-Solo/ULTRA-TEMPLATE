/**
 * The domain model: pure functions over plain data. No I/O, no clock, no randomness, and no imports
 * from outside this directory; scripts/check-boundaries.mjs fails the build otherwise. Callers
 * supply ids and timestamps, which is what makes every rule here deterministic.
 */

export const STATUSES = ["todo", "in_progress", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const MAX_TITLE_LENGTH = 200;

export type DomainErrorCode = "EMPTY_TITLE" | "TITLE_TOO_LONG" | "UNKNOWN_STATUS" | "INVALID_TRANSITION" | "NOT_FOUND";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** Every legal move. Anything absent is refused, including staying put. */
const NEXT: Readonly<Record<Status, readonly Status[]>> = {
  todo: ["in_progress"],
  in_progress: ["todo", "done"],
  done: [],
};

/**
 * The Unicode property a title is trimmed of at both ends (scripts/rules/task-rules.json), as every task
 * service trims it. Not String.prototype.trim, which keeps U+0085 and takes U+FEFF.
 */
export const TITLE_WHITESPACE = "White_Space";
const TITLE_EDGES = new RegExp(`^\\p{${TITLE_WHITESPACE}}+|\\p{${TITLE_WHITESPACE}}+$`, "gu");

export function createTask(id: string, title: string, now: string): Task {
  const trimmed = title.replace(TITLE_EDGES, "");
  if (trimmed === "") throw new DomainError("EMPTY_TITLE", "title must not be empty");
  // Counted in code points, not UTF-16 units, so the limit means the same as in api-go.
  if ([...trimmed].length > MAX_TITLE_LENGTH) {
    throw new DomainError("TITLE_TOO_LONG", `title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return { id, title: trimmed, status: "todo", createdAt: now, updatedAt: now };
}

const isStatus = (value: unknown): value is Status => STATUSES.some((status) => status === value);

export function parseStatus(value: unknown): Status {
  if (isStatus(value)) return value;
  throw new DomainError("UNKNOWN_STATUS", `status must be one of ${STATUSES.join(", ")}`);
}

export function transition(task: Task, next: Status, now: string): Task {
  if (!NEXT[task.status].includes(next)) {
    throw new DomainError("INVALID_TRANSITION", `cannot move a task from ${task.status} to ${next}`);
  }
  return { ...task, status: next, updatedAt: now };
}
